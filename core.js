/* Shared logic for the web page (index.html) and the CLI (cli/explain.js).
 * Pure functions only: no DOM, no Node-only APIs. Loaded with <script src="core.js"> or require('./core.js'). */
(function (root) {
  'use strict';

  /* =====================================================================
   * Model contract. Edit HERE when the LoRA training template is final;
   * both the page and the CLI pick it up.
   * ===================================================================== */
  const defaults = {
    apiUrl: 'http://localhost:11434/v1/chat/completions',   // OpenAI-compatible (Ollama / vLLM / ...)
    model: 'error-explainer',                                // Ollama model name
    temperature: 0.2,
    maxTokens: 700,
    maxInputChars: 4000,
  };

  /* TODO: replace with the exact system/user template used in training. */
  const SYSTEM_PROMPT = 'You are a programming error explainer. Given an error message, answer with two sections: "## Why" (the cause) and "## Fix" (the solution with code). Reply in the same language as the error message.';

  function buildMessages(text) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ];
  }

  /* Long stack traces: keep the head (40%) and the tail, mark the cut. */
  function clip(text, n = defaults.maxInputChars) {
    if (text.length <= n) return text;
    const head = Math.floor(n * 0.4);
    return text.slice(0, head) + '\n...[truncated]...\n' + text.slice(text.length - (n - head));
  }

  /* ---------------- Error detection (gate in front of the model) ---------------- */
  const LANG_LABEL = { python: 'Python', java: 'Java', cpp: 'C++' };
  const RULES = {
    python: [
      /Traceback \(most recent call last\)/,
      /^\s*File ".+", line \d+/m,
      /^[A-Za-z_.]*(Error|Exception)(:|\s*$)/m,
    ],
    java: [
      /Exception in thread "/,
      /^\s+at [\w$.<>]+\([\w$]+\.java:\d+\)/m,
      /\b(java|javax|jakarta)\.[\w.]+(Exception|Error)\b/,
      /^Caused by:/m,
      /\.java:\d+: (error|错误)/,
      /线程 ".*" 中(出现)?的?异常/,
    ],
    cpp: [
      /\.(cpp|cc|cxx|hpp|h|c)(:\d+(:\d+)?:|\(\d+\)\s*:)\s*(fatal )?(error|错误)/i,
      /undefined reference to|对.*未定义的引用/,
      /ld returned \d+ exit status/,
      /Segmentation fault|段错误/,
      /terminate called after throwing/,
      /\b(error|错误)\s*C\d{4}\b/,
      /\bLNK\d{4}\b/,
      /AddressSanitizer/,
      /free\(\): (double free|invalid (pointer|size))|double free or corruption|malloc\(\): |corrupted (size|top size)|stack smashing detected/,
      /Aborted \(core dumped\)|已放弃 ?\(核心已转储\)|核心已转储/,
    ],
  };
  /* detect(text)         -> best match across all languages (Auto)
   * detect(text, 'java') -> only test that language's rules (manual selection) */
  function detect(text, only) {
    let best = { lang: null, score: 0 };
    for (const [lang, rules] of Object.entries(RULES)) {
      if (only && lang !== only) continue;
      const score = rules.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
      if (score > best.score) best = { lang, score };
    }
    return best;
  }

  /* ---------------- Model output -> { why, fix } ----------------
   * Splits "## Why / ## Fix" (or 原因 / 解决方案), ignoring '#' lines inside code fences. */
  const WHY_RE = /^(why|cause|原因|为什么|报错原因|错误原因)/i;
  const FIX_RE = /^(fix|solution|解决方案|解决办法|修复|如何修复|修改)/i;
  function parseSections(text) {
    const secs = { why: [], fix: [] };
    let cur = null, fence = false, found = false;
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) fence = !fence;
      const m = !fence && line.match(/^#{1,4}\s*(.+?)\s*$/);
      if (m && WHY_RE.test(m[1])) { cur = 'why'; found = true; continue; }
      if (m && FIX_RE.test(m[1])) { cur = 'fix'; found = true; continue; }
      if (cur) secs[cur].push(line);
    }
    if (!found) return null;
    return { why: secs.why.join('\n').trim(), fix: secs.fix.join('\n').trim() };
  }

  /* ---------------- Error anatomy (no model needed) ----------------
   * annotate(text) -> { segments: [{ text, kind: null|'loc'|'type'|'sym' }], facts: { where, type, symbol } }
   * segments always join back to the exact input text. */
  const isLibLine = line => /java\.base\/|jdk\.internal|\/usr\/|site-packages|<frozen |[\\/]lib[\\/]python/i.test(line);
  const base = p => p.split(/[\\/]/).pop();
  function normLoc(s) {
    let m;
    if ((m = /File "([^"]+)", line (\d+)/.exec(s))) return base(m[1]) + ':' + m[2];
    if ((m = /^(.*?)\((\d+)(?:,\d+)?\)$/.exec(s))) return base(m[1]) + ':' + m[2];
    if ((m = /^(.*?):(\d+)(?::\d+)?$/.exec(s))) return base(m[1]) + ':' + m[2];
    return s;
  }

  function annotate(text) {
    const cand = [];
    const add = (re, kind, group = 0, max = Infinity) => {
      re.lastIndex = 0;
      let m, n = 0;
      while ((m = re.exec(text)) && n < max) {
        if (!m[0]) { re.lastIndex++; continue; }
        const [start, end] = group ? m.indices[group] : [m.index, m.index + m[0].length];
        if (kind === 'loc') {                                  // frames inside the JDK / libc / site-packages are not "yours"
          const ls = text.lastIndexOf('\n', start) + 1, le = text.indexOf('\n', end);
          if (isLibLine(text.slice(ls, le < 0 ? text.length : le))) continue;
        }
        cand.push({ start, end, kind });
        n++;
      }
    };

    // where
    add(/[\w.\/\\:-]*[\w-]+\.(?:java|cpp|cc|cxx|hpp|h|c|py):\d+(?::\d+)?/dg, 'loc');
    add(/[\w.\/\\-]+\.(?:cpp|cc|cxx|hpp|h|c)\(\d+(?:,\d+)?\)/dg, 'loc');
    add(/File "[^"\n]+", line \d+/dg, 'loc');
    // what
    add(/\b(?:[a-z_]\w*\.)*[A-Z]\w*(?:Error|Exception)\b/dg, 'type');
    add(/\b(?:LNK|C)\d{4}\b/dg, 'type');
    add(/undefined reference to|multiple definition of|Segmentation fault|double free|ld returned \d+ exit status|not declared in this scope|is not a member of|cannot find symbol|incompatible types|段错误|未定义的引用|无法解析的外部符号|未声明的标识符|找不到符号|找不到标识符|找不到或无法加载主类|不兼容的类型|缺少返回语句|无法访问的语句/dg, 'type');
    // which name
    add(/[‘“]([^’”\n]{1,40})[’”]/dg, 'sym', 1, 4);
    add(/'([A-Za-z_][\w.:<>, *&()]{0,38})'/dg, 'sym', 1, 3);
    add(/`([^`'\n]{1,40})'/dg, 'sym', 1, 3);
    add(/(?:符号:|symbol:)\s+(?:变量|方法|类|variable|method|class)\s+([^\s(\n]+(?:\([^)\n]*\))?)/dg, 'sym', 1, 2);

    cand.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const spans = [];
    let last = 0, syms = 0;
    for (const c of cand) {                                    // earliest / longest wins, no overlaps
      if (c.start < last) continue;
      if (c.kind === 'sym' && ++syms > 5) continue;
      spans.push(c); last = c.end;
    }

    const segments = [];
    let pos = 0;
    for (const s of spans) {
      if (s.start > pos) segments.push({ text: text.slice(pos, s.start), kind: null });
      segments.push({ text: text.slice(s.start, s.end), kind: s.kind });
      pos = s.end;
    }
    if (pos < text.length) segments.push({ text: text.slice(pos), kind: null });

    const val = s => text.slice(s.start, s.end);
    const locs = spans.filter(s => s.kind === 'loc'), types = spans.filter(s => s.kind === 'type'), symbols = spans.filter(s => s.kind === 'sym');
    const py = /most recent call last/.test(text);             // Python prints the raising frame LAST
    let type = null;
    if (types.length) {
      const caused = [...text.matchAll(/Caused by:/g)];       // Java chains: report the root cause
      const t = py ? types[types.length - 1]
        : caused.length ? (types.find(s => s.start > caused[caused.length - 1].index) || types[0])
        : types[0];
      type = val(t).split('.').pop();
    }
    return {
      segments,
      facts: {
        where: locs.length ? normLoc(val(py ? locs[locs.length - 1] : locs[0])) : null,
        type,
        symbol: symbols.length ? val(symbols[0]) : null,
      },
    };
  }

  const api = { defaults, SYSTEM_PROMPT, buildMessages, clip, LANG_LABEL, RULES, detect, parseSections, annotate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EXPLAINER = api;
})(typeof self !== 'undefined' ? self : this);
