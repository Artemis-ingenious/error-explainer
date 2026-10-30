#!/usr/bin/env node
/* explain: send an error message to the local model and stream Why / Fix into the terminal.
 *
 *   python main.py 2>&1 | explain          pipe any error in
 *   explain run python main.py             run a command; if it fails, explain its error
 *   explain error.log                      explain a saved log
 *
 * Same model contract (system prompt, gate rules, truncation) as the web page: see ../core.js. Node >= 18, no dependencies. */
const fs = require('fs');
const { spawn } = require('child_process');
const core = require('../core.js');

const HELP = `explain: explain a Python / Java / C++ error with the local model

usage
  <command> 2>&1 | explain [options]
  explain run <command...>      run a command, explain its error if it exits non-zero
  explain [options] <file>      explain a saved error log

options
  --api <url>     OpenAI-compatible endpoint   (env EXPLAIN_API,   default ${core.defaults.apiUrl})
  --model <name>  model name                   (env EXPLAIN_MODEL, default ${core.defaults.model})
  --force         send even if the text does not look like an error message
  --no-color      plain output (also when NO_COLOR is set or stdout is not a terminal)
  -h, --help      this help

exit codes: 0 ok, 2 bad input / not an error message, 3 model server unreachable`;

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const opt = { api: process.env.EXPLAIN_API || core.defaults.apiUrl, model: process.env.EXPLAIN_MODEL || core.defaults.model, force: false, color: true };
let file = null, runCmd = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  else if (a === '--api') opt.api = argv[++i];
  else if (a === '--model') opt.model = argv[++i];
  else if (a === '--force') opt.force = true;
  else if (a === '--no-color') opt.color = false;
  else if (a === 'run' && file === null && runCmd === null) { runCmd = argv.slice(i + 1); break; }
  else if (!a.startsWith('-') && file === null) file = a;
  else { console.error(`explain: unknown option ${a}\n`); console.error(HELP); process.exit(2); }
}
if ((!process.stdout.isTTY && !process.env.FORCE_COLOR) || process.env.NO_COLOR) opt.color = false;

/* ---------------- terminal styling (streamed, line-aware) ---------------- */
const dim = s => (opt.color ? `\x1b[2m${s}\x1b[0m` : s);
function makeWriter() {
  const OPEN = { h: '\x1b[1;36m', fence: '\x1b[2m', code: '\x1b[33m', text: '' };
  let line = '', style = null, inFence = false;
  const out = s => process.stdout.write(s);
  const open = () => (opt.color ? OPEN[style] : '');
  const reset = () => (opt.color && OPEN[style] ? '\x1b[0m' : '');
  const decide = () => { style = line.startsWith('## ') ? 'h' : line.startsWith('```') ? 'fence' : inFence ? 'code' : 'text'; };
  return {
    write(chunk) {
      for (const ch of chunk) {
        if (ch === '\n') {
          if (style === null) { decide(); out(open() + line); }
          out(reset() + '\n');
          if (style === 'fence') inFence = !inFence;
          line = ''; style = null;
          continue;
        }
        line += ch;
        if (style === null) {                                   // the first 3 chars tell "## " / "```" apart from prose
          if (line.length < 3 && ('## '.startsWith(line) || '```'.startsWith(line))) continue;
          decide(); out(open() + line);
        } else out(ch);
      }
    },
    end() { if (style === null && line) { decide(); out(open() + line); } out(reset() + '\n'); },
  };
}

/* ---------------- input ---------------- */
const readStdin = () => new Promise(res => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { s += d; }); process.stdin.on('end', () => res(s)); });

function runCommand(args) {
  return new Promise(res => {
    const cmd = args.length === 1 ? args[0] : args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
    const child = spawn(cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    let so = '', se = '';
    child.stdout.on('data', d => { so += d; process.stdout.write(d); });
    child.stderr.on('data', d => { se += d; process.stderr.write(d); });
    child.on('close', code => res({ code, stdout: so, stderr: se }));
    child.on('error', e => res({ code: 127, stdout: so, stderr: se + String(e) }));
  });
}

(async () => {
  let text;
  if (runCmd) {
    if (!runCmd.length) { console.error('explain run: missing command\n'); console.error(HELP); process.exit(2); }
    const r = await runCommand(runCmd);
    if (r.code === 0) { console.error(dim('\nexit 0, nothing to explain.')); process.exit(0); }
    text = (r.stderr.trim() || r.stdout.trim());
    console.error(dim(`\nexit ${r.code}`));
  } else if (file) {
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`explain: cannot read ${file}: ${e.message}`); process.exit(2); }
  } else if (!process.stdin.isTTY) text = await readStdin();
  else { console.error(HELP); process.exit(2); }

  text = (text || '').trim();
  if (!text) { console.error('explain: no error text received'); process.exit(2); }

  const det = core.detect(text);
  if (!det.lang && !opt.force) {
    console.error("explain: this doesn't look like a Python, Java or C++ error message (use --force to send it anyway)");
    process.exit(2);
  }
  const f = core.annotate(text).facts;
  console.error(dim(['explain', det.lang ? core.LANG_LABEL[det.lang] : 'unknown language', f.where, f.type].filter(Boolean).join(' · ')) + '\n');

  /* ---------------- ask the model ---------------- */
  const t0 = Date.now();
  let first = null, chunks = 0;
  const w = makeWriter();
  let res;
  try {
    res = await fetch(opt.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opt.model, messages: core.buildMessages(core.clip(text), det.lang), stream: true,
        temperature: core.defaults.temperature, max_tokens: core.defaults.maxTokens,
      }),
    });
  } catch (e) {
    console.error(`explain: cannot reach the model server at ${opt.api}\n  (${e.cause ? e.cause.code || e.cause.message : e.message}). Is it running? Use --api <url> or EXPLAIN_API to point elsewhere.`);
    process.exit(3);
  }
  if (!res.ok) { console.error(`explain: model server answered HTTP ${res.status}\n${(await res.text()).slice(0, 300)}`); process.exit(3); }

  const dec = new TextDecoder();
  let buf = '';
  for await (const part of res.body) {
    buf += dec.decode(part, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const ln of lines) {
      if (!ln.startsWith('data:')) continue;
      const data = ln.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let delta;
      try { delta = JSON.parse(data).choices?.[0]?.delta?.content; } catch { continue; }
      if (!delta) continue;
      if (first === null) first = Date.now();
      chunks++;
      w.write(delta);
    }
  }
  w.end();
  if (first !== null) {
    const gen = (Date.now() - first) / 1000;
    console.error('\n' + dim(`first token ${((first - t0) / 1000).toFixed(2)}s · ~${gen > 0 ? Math.round(chunks / gen) : '-'} tok/s · ${((Date.now() - t0) / 1000).toFixed(1)}s total`));
  }
})();
