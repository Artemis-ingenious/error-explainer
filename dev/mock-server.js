// Dev stand-in for the model server: OpenAI-compatible streaming /v1/chat/completions + static files.
//   node dev/mock-server.js            (PORT=8000, TOKEN_MS=25 by default)
//   open http://localhost:8000/?mode=ollama&api=http://localhost:8000/v1/chat/completions
// Answers come from EXAMPLES in examples.js; any other input gets a generic reply.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = +process.env.PORT || 8000;
const TOKEN_MS = +process.env.TOKEN_MS || 25;      // delay between streamed chunks
const FIRST_MS = +process.env.FIRST_MS || 400;     // delay before the first chunk
const CHUNK = 3;                                   // characters per streamed chunk
const shares = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function examples() {                              // re-read each request so edits to examples.js show up
  const src = fs.readFileSync(path.join(ROOT, 'examples.js'), 'utf8');
  return new Function(src + '; return EXAMPLES;')();
}

function answerFor(userText) {
  const hit = examples().find(e => e.text.trim() === userText.trim());
  return hit ? hit.answer
    : '## Why\n(mock server) No canned answer for this input.\n\n## Fix\nReplace this server with the real model.';
}

const sse = (delta, finish = null) => 'data: ' + JSON.stringify({
  id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
  model: 'error-explainer', choices: [{ index: 0, delta, finish_reason: finish }],
}) + '\n\n';

function chat(req, res) {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, CORS); return res.end('bad json'); }
    const user = [...(payload.messages || [])].reverse().find(m => m.role === 'user');
    const out = answerFor(user ? user.content : '');
    console.log(`${new Date().toLocaleTimeString()}  chat  ${out.length} chars  (input ${user ? user.content.length : 0} chars)`);

    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(sse({ role: 'assistant', content: '' }));   // real servers open with an empty role chunk
    let i = 0, timer;
    const tick = () => {
      if (i >= out.length) {
        res.write(sse({}, 'stop')); res.write('data: [DONE]\n\n'); return res.end();
      }
      res.write(sse({ content: out.slice(i, i + CHUNK) }));
      i += CHUNK; timer = setTimeout(tick, TOKEN_MS);
    };
    timer = setTimeout(tick, FIRST_MS);
    res.on('close', () => clearTimeout(timer));          // client pressed Stop / left
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/shares/')) {
    const id = url.pathname.slice('/api/shares/'.length);
    if (req.method === 'GET') {
      const value = shares.get(id);
      res.writeHead(value ? 200 : 404, {'Content-Type':'application/json'});
      return res.end(JSON.stringify(value || {error:'not found'}));
    }
    if (req.method === 'PUT') {
      let body=''; req.on('data', d => body += d); req.on('end', () => {
        try { const value=JSON.parse(body); if (!value.text || !value.answer) throw Error(); shares.set(id, {...value, updatedAt:Date.now()}); res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({id})); }
        catch { res.writeHead(400); res.end('bad share'); }
      }); return;
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/shares') {
    let body=''; req.on('data', d => body += d); req.on('end', () => {
      try { const value=JSON.parse(body); if (!value.text || !value.answer) throw Error(); const id=require('crypto').randomBytes(12).toString('hex'); shares.set(id, {...value, updatedAt:Date.now()}); res.writeHead(201, {'Content-Type':'application/json'}); res.end(JSON.stringify({id})); }
      catch { res.writeHead(400); res.end('bad share'); }
    }); return;
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return chat(req, res);

  if (req.method === 'GET') {                            // static files (path-traversal safe)
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(ROOT, '.' + rel);
    if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => {
  console.log(`mock model server on http://localhost:${PORT}`);
  console.log(`open  http://localhost:${PORT}/?mode=ollama&api=http://localhost:${PORT}/v1/chat/completions`);
});
