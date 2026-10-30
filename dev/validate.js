// Static checks for generated JSONL batches, plus a run through the page's own detect()/parseSections().
//   node dev/validate.js data/java_B01.jsonl data/cpp_B01.jsonl
// Errors = breaks a hard rule of the generation prompt. Warnings = worth a human look.
const fs = require('fs');
const path = require('path');

/* ---- reuse the front-end logic (shared core.js: gate rules + section parser) ---- */
const { detect, parseSections } = require('../core.js');

const markedLib = require('../vendor/marked.min.js');
const marked = markedLib.marked || markedLib;
const CJK = /[\u4e00-\u9fff]/g;
const cjkCount = s => (s.match(CJK) || []).length;
const LANGS = { py: 'python', jv: 'java', cp: 'cpp' };
const BANNED = [/我运行了|已验证|经测试|同学/, /\b(I ran|I tested|verified)\b/i, /希望(对你|这)有帮助|加油|Hope this helps|Great question/i];
const KEYWORDS = new Set(('return for while if else do switch case break continue throw throws try catch finally new delete static final void int long double float char bool boolean ' +
  'class struct public private const nullptr null true false main this self import def in is not and or pass None').split(' '));
const estTokens = s => Math.round(cjkCount(s) * 1.1 + s.replace(CJK, '').length / 3.5);

let totalErr = 0, totalWarn = 0;

for (const file of process.argv.slice(2)) {
  const issues = [];
  const add = (sev, id, msg) => issues.push({ sev, id, msg });
  const recs = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { recs.push(JSON.parse(line)); } catch (e) { add('ERR', `line ${i + 1}`, 'invalid JSON: ' + e.message.slice(0, 60)); }
  });

  const seenIds = new Set(), seenInputs = new Set(), classCount = {};
  const stat = { err: {}, out: {}, diff: {}, prefix: 0, short: 0, gateFail: 0, gateWrongLang: 0, tokens: [] };
  const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };

  for (const r of recs) {
    const id = r.id || '(no id)';
    for (const f of ['id', 'language', 'err_lang', 'out_lang', 'category', 'difficulty', 'input', 'output', 'meta'])
      if (r[f] === undefined || r[f] === '') add('ERR', id, `missing field ${f}`);
    if (!r.input || !r.output || !r.meta) continue;

    if (seenIds.has(r.id)) add('ERR', id, 'duplicate id'); seenIds.add(r.id);
    if (seenInputs.has(r.input)) add('ERR', id, 'duplicate input'); seenInputs.add(r.input);
    const m = /^(py|jv|cp)-B\d+-\d{3}$/.exec(r.id);
    if (!m) add('ERR', id, 'id format'); else if (LANGS[m[1]] !== r.language) add('ERR', id, `id prefix vs language=${r.language}`);
    if (!['zh', 'en', 'mixed'].includes(r.err_lang)) add('ERR', id, 'err_lang enum');
    if (!['zh', 'en'].includes(r.out_lang)) add('ERR', id, 'out_lang enum');
    if (!['beginner', 'intermediate'].includes(r.difficulty)) add('ERR', id, 'difficulty enum');
    if (r.meta.verified !== false) add('ERR', id, 'meta.verified must be false');
    for (const f of ['buggy_code', 'fixed_code', 'run_cmd', 'error_class']) if (!r.meta[f]) add('ERR', id, `meta.${f} empty`);
    if (r.meta.buggy_code && r.meta.buggy_code === r.meta.fixed_code) add('ERR', id, 'fixed_code identical to buggy_code');
    inc(stat.err, r.err_lang); inc(stat.out, r.out_lang); inc(stat.diff, r.difficulty);
    inc(classCount, r.meta.error_class);

    /* ---- output format ---- */
    const om = /^## Why\n([\s\S]*?)\n## Fix\n([\s\S]*)$/.exec(r.output.trim());
    if (!om) { add('ERR', id, 'output is not "## Why ... ## Fix ..."'); continue; }
    const [, why, fix] = om;
    if (/```/.test(why)) add('ERR', id, 'code block inside Why');
    if (/^#{1,6} /m.test(why + '\n' + fix)) add('ERR', id, 'extra heading in output');
    const blocks = [...fix.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
    if (blocks.length !== 1) add('ERR', id, `Fix has ${blocks.length} code blocks (want 1)`);
    else {
      if (!['python', 'java', 'cpp'].includes(blocks[0][1])) add('WARN', id, `fence tag "${blocks[0][1]}"`);
      const lines = blocks[0][2].replace(/\n$/, '').split('\n').length;
      if (lines > 15) add('ERR', id, `Fix code ${lines} lines (>15)`);
    }
    if ((fix.match(/```/g) || []).length % 2) add('ERR', id, 'unclosed code fence');
    for (const re of BANNED) if (re.test(r.output)) add('ERR', id, `banned phrase ${re.source.slice(0, 20)}`);

    /* ---- length ---- */
    const whyText = why.trim();
    const zhWhy = cjkCount(whyText) > 5;
    const whyLen = zhWhy ? whyText.replace(/\s/g, '').length : whyText.split(/\s+/).length;
    if (zhWhy ? whyLen > 150 : whyLen > 90) add('WARN', id, `Why length ${whyLen}${zhWhy ? ' chars' : ' words'}`);
    const tok = estTokens(r.output); stat.tokens.push(tok);
    if (tok > 300) add('WARN', id, `output ~${tok} tokens (>300)`);

    /* ---- language consistency ---- */
    const prose = r.output.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    const outZh = cjkCount(prose) >= 8;
    if (r.out_lang === 'zh' && !outZh) add('ERR', id, 'out_lang=zh but output prose is not Chinese');
    if (r.out_lang === 'en' && cjkCount(prose) > 3) add('ERR', id, 'out_lang=en but output prose contains Chinese');
    const inZh = cjkCount(r.input) > 0;
    if (r.err_lang === 'en' && inZh) add('WARN', id, 'err_lang=en but input has Chinese');
    if (r.err_lang !== 'en' && !inZh) add('ERR', id, `err_lang=${r.err_lang} but input has no Chinese`);
    if (r.err_lang === 'zh' && r.out_lang === 'en') add('WARN', id, 'err_lang=zh answered in English');

    /* ---- numbers / symbols cited in the answer must exist in the input ---- */
    const cited = new Set();
    for (const re of [/第\s*(\d+)\s*行/g, /\bline\s+(\d+)\b/gi, /\w+\.(?:java|cpp|cc|py|c|h|hpp):(\d+)/g])
      for (const x of r.output.matchAll(re)) cited.add(x[1]);
    for (const n of cited) if (!new RegExp(`(?<![0-9])${n}(?![0-9])`).test(r.input)) add('ERR', id, `answer cites line ${n} not present in input`);
    for (const x of why.matchAll(/`([^`\n]{2,40})`/g)) {
      const sym = x[1].replace(/\(\)$/, '');
      if (KEYWORDS.has(sym) || /^\.\w+$/.test(sym) || /^<\w+>$/.test(sym)) continue;   // language keywords / file extensions / headers are fine
      if (!r.input.includes(sym) && !/\s/.test(sym) && /^[\w.:<>~]+$/.test(sym) && sym.length > 2 && !r.input.includes(sym.split(/[.:]/).pop()))
        add('WARN', id, `Why cites \`${x[1]}\` not found in input`);
    }

    /* ---- input vs buggy_code consistency ---- */
    const src = (r.meta.buggy_code || '').split('\n');
    const inLines = r.input.split('\n');
    inLines.forEach((ln, i) => {
      const mm = /(?:\.java|\.cpp|\.cc|\.c|\.py|\.h|\.hpp):(\d+)(?::\d+)?:|\((\d+)\)\s*:\s*(?:error|错误)|, line (\d+)/.exec(ln);
      if (!mm || /site-packages|[\\/]lib[\\/]|\/usr\//.test(ln)) return;
      const n = +(mm[1] || mm[2] || mm[3]);
      if (n > src.length) add('ERR', id, `input cites line ${n} but buggy_code has ${src.length} lines`);
      const next = (inLines[i + 1] || '').replace(/^\s*\d+\s*\|\s?/, '').trim();
      const isDiagnostic = /(error|warning|note|错误|警告|参见|\bC\d{4}\b)|\.(cpp|java|py|cc|h)[(:]\d+/i.test(next);   // MSVC prints no source line
      if (next && !isDiagnostic && !/^(\^|~|符号|位置|symbol|location|\d+ (个)?error)/i.test(next) && next.length > 3 && !src.some(s => s.includes(next)))
        add('WARN', id, `source snippet in input not found in buggy_code: "${next.slice(0, 40)}"`);
    });

    /* ---- realism stats ---- */
    if (/^(\$ |PS .*> |> |C:\\.*> )/.test(r.input)) stat.prefix++;
    if (r.input.trim().split('\n').length <= 3) stat.short++;

    /* ---- front-end gate + parser ---- */
    const d = detect(r.input);
    if (!d.lang) { stat.gateFail++; add('WARN', id, 'front-end gate REJECTS this input (no rule matched)'); }
    else if (d.lang !== r.language) { stat.gateWrongLang++; add('WARN', id, `front-end detected ${d.lang}, expected ${r.language}`); }
    const p = parseSections(r.output);
    if (!p || !p.why || !p.fix) add('ERR', id, 'front-end parseSections() fails on this output');
    else {                                                  // render exactly like the page does (marked), check the fence came out as one code block
      const h = marked.parse(p.fix);
      if ((h.match(/<pre><code/g) || []).length !== 1 || /```/.test(h.replace(/<pre>[\s\S]*?<\/pre>/g, '')))
        add('ERR', id, 'Fix does not render as exactly one clean code block');
      if (/```/.test(marked.parse(p.why))) add('ERR', id, 'code fence leaked into rendered Why');
    }
  }

  /* ---- batch-level ---- */
  const n = recs.length;
  for (const [k, c] of Object.entries(classCount)) if (c > 2) add('WARN', 'batch', `error_class "${k}" appears ${c}x (limit 2)`);
  const pct = c => `${c} (${Math.round(100 * c / Math.max(n, 1))}%)`;
  const sorted = [...stat.tokens].sort((a, b) => a - b);

  console.log(`\n=== ${path.basename(file)}  — ${n} records`);
  console.log(`  err_lang   zh ${stat.err.zh || 0} / en ${stat.err.en || 0} / mixed ${stat.err.mixed || 0}   (prompt default 12/6/2 of 20)`);
  console.log(`  out_lang   zh ${stat.out.zh || 0} / en ${stat.out.en || 0}`);
  console.log(`  difficulty beginner ${stat.diff.beginner || 0} / intermediate ${stat.diff.intermediate || 0}`);
  console.log(`  realism    cmd-prefix ${pct(stat.prefix)}, <=3 lines ${pct(stat.short)}   (targets ~25%, ~15%)`);
  console.log(`  tokens     median ~${sorted[Math.floor(n / 2)]}, max ~${sorted[n - 1]}`);
  console.log(`  front-end  gate rejects ${stat.gateFail}, wrong language ${stat.gateWrongLang}`);
  const errs = issues.filter(i => i.sev === 'ERR'), warns = issues.filter(i => i.sev === 'WARN');
  totalErr += errs.length; totalWarn += warns.length;
  console.log(`  ERRORS ${errs.length}, WARNINGS ${warns.length}`);
  for (const i of [...errs, ...warns]) console.log(`    ${i.sev === 'ERR' ? '✗' : '·'} ${i.id}: ${i.msg}`);
}
console.log(`\nTOTAL: ${totalErr} errors, ${totalWarn} warnings`);
process.exit(totalErr ? 1 : 0);
