// Preview server. It follows a run folder on disk, so it shows whatever the coding agent writes,
// through CLI calls or the MCP server.
import http from 'node:http';
import { readFile, stat, open } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Run } from './run.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW = path.join(PKG, 'preview');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// root: the .swarm folder (follows root/current). runDir: pin one run instead.
export function startPreview({ root = '.swarm', runDir, port = 4777, host = '127.0.0.1', label } = {}) {
  root = path.resolve(root);
  const clients = new Set();
  const feed = { dir: null, offset: 0, partial: '', seq: 0, lines: [] };

  const currentDir = () => {
    if (runDir) return path.resolve(runDir);
    const p = path.join(root, 'current');
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
  };

  const send = (res, e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const broadcast = (e) => { for (const c of clients) send(c, e); };

  async function poll() {
    const dir = currentDir();
    if (dir !== feed.dir) {
      const hadRun = feed.dir !== null;
      Object.assign(feed, { dir, offset: 0, partial: '', seq: 0, lines: [] });
      if (hadRun) broadcast({ type: 'reset', run: dir });
    }
    if (!dir) return;
    const file = path.join(dir, 'events.jsonl');
    let size;
    try { size = (await stat(file)).size; } catch { return; }
    if (size < feed.offset) Object.assign(feed, { offset: 0, partial: '', seq: 0, lines: [] });
    if (size === feed.offset) return;
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(size - feed.offset);
      await fh.read(buf, 0, buf.length, feed.offset);
      feed.offset = size;
      const text = feed.partial + buf.toString('utf8');
      const parts = text.split('\n');
      feed.partial = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        e.seq = feed.seq++;
        feed.lines.push(e);
        broadcast(e);
      }
    } finally { await fh.close(); }
  }
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try { await poll(); } catch (err) { console.error('[preview]', err.message); } finally { polling = false; }
  }, 120);

  async function readBody(req, limit = 64 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

  async function serveFile(res, base, rel) {
    const file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
    if (!file.startsWith(base)) return json(res, 404, { error: 'not found' });
    try {
      const s = await stat(file);
      const target = s.isDirectory() ? path.join(file, 'index.html') : file;
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(target));
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'POST') {
        // Only same-origin JSON posts: a cross-site form can't send application/json without a CORS preflight we never answer.
        const origin = req.headers.origin;
        if (!/application\/json/.test(req.headers['content-type'] || '') || (origin && new URL(origin).host !== req.headers.host)) return json(res, 403, { error: 'forbidden' });
      }
      if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        await poll();
        send(res, { type: 'hello', run: feed.dir, label, seq: -1 });
        for (const e of feed.lines) send(res, e);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clients.delete(res); clearInterval(ping); });
        return;
      }
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'swarm-build', root, run: currentDir() });
      if (url.pathname === '/api/run') {
        const dir = currentDir();
        if (!dir) return json(res, 200, { run: null });
        const run = await Run.open(dir);
        return json(res, 200, {
          run: dir, mode: run.meta.mode,
          plan: run.hasPlan() ? await run.plan() : null, comments: await run.comments(),
        });
      }
      if (url.pathname === '/api/comments' && req.method === 'POST') {
        const dir = currentDir();
        if (!dir) return json(res, 400, { error: 'no run' });
        const body = await readBody(req);
        const c = await (await Run.open(dir)).addComment(body);
        return json(res, 200, { comment: c });
      }
      if (url.pathname === '/page' || url.pathname === '/page/') {
        const dir = currentDir();
        if (!dir) return json(res, 404, { error: 'no run' });
        return serveFile(res, dir, 'index.html');
      }
      return serveFile(res, PREVIEW, decodeURIComponent(url.pathname));
    } catch (err) {
      json(res, err.status || 500, { error: String(err.message || err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        url: `http://${host}:${addr.port}/`,
        port: addr.port,
        close: () => { clearInterval(timer); for (const c of clients) c.end(); server.close(); },
      });
    });
  });
}

export async function previewRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const j = await r.json();
    return j.app === 'swarm-build' ? j : null;
  } catch { return null; }
}
