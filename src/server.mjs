#!/usr/bin/env node
// swarm-build CLI + preview server.
//   node src/server.mjs "a landing page for ..." [--sections 6] [--port 4777] [--theme theme.json]
//   node src/server.mjs --replay out/<run>/run.json      replay a saved run (no LLM calls)
//   node src/server.mjs "..." --headless                 build without the preview, print stats
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { runSwarm } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { sections: 6, port: 4777, brief: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sections') o.sections = Number(argv[++i]);
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--replay') o.replay = argv[++i];
    else if (a === '--theme') o.theme = argv[++i];
    else if (a === '--brief-file') o.briefFile = argv[++i];
    else if (a === '--headless') o.headless = true;
    else if (a === '--open') o.open = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else rest.push(a);
  }
  o.brief = rest.join(' ').trim();
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args.briefFile) args.brief = (await readFile(args.briefFile, 'utf8')).trim();
if (args.help || (!args.brief && !args.replay)) {
  console.log(`swarm-build: plan a UI, build its sections in parallel, watch the swarm.

  node src/server.mjs "<page brief>" [--sections N] [--port 4777] [--theme theme.json] [--open]
  node src/server.mjs --brief-file brief.txt
  node src/server.mjs --replay out/<run>/run.json
  node src/server.mjs "<page brief>" --headless

env: GCP_PROJECT (required unless gcloud has a default), SWARM_MODEL (default gemini-3.5-flash)`);
  process.exit(args.help ? 0 : 1);
}
const theme = args.theme ? JSON.parse(await readFile(args.theme, 'utf8')) : undefined;

const log = (e) => {
  const s = (e.t / 1000).toFixed(1).padStart(5);
  if (e.type === 'plan:done') console.log(`${s}s  plan: ${e.plan.sections.map((x) => x.id).join(', ')}`);
  else if (e.type === 'agent:start') console.log(`${s}s  ${e.agent.name.padEnd(8)} -> ${e.id}`);
  else if (e.type === 'agent:done') console.log(`${s}s  ${e.agent.name.padEnd(8)} done ${e.id} (${(e.ms / 1000).toFixed(1)}s, ${e.html.length} chars)`);
  else if (e.type === 'agent:error') console.log(`${s}s  ${e.agent.name.padEnd(8)} FAILED ${e.id}: ${e.message}`);
  else if (e.type === 'done') {
    const st = e.stats;
    console.log(`${s}s  done: ${st.sections} sections, build ${(st.buildWallMs / 1000).toFixed(1)}s wall vs ${(st.sumMs / 1000).toFixed(1)}s sequential (${st.speedup}x), $${st.costUsd}`);
    console.log(`       output: ${path.join(st.outDir, 'index.html')}`);
  }
};

if (args.headless) {
  await runSwarm(args.brief, { maxSections: args.sections, theme, outRoot: path.join(ROOT, 'out'), emit: log });
  process.exit(0);
}

// ---- event bus: buffer everything so late or reloaded clients get the full story ----
const buffer = [];
const clients = new Set();
let started = false;
const publish = (e) => {
  e = { ...e, seq: buffer.length };
  buffer.push(e);
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(line);
};

async function start() {
  if (started) return;
  started = true;
  if (args.replay) {
    const run = JSON.parse(await readFile(args.replay, 'utf8'));
    const t0 = Date.now();
    for (const e of run.events) {
      const wait = e.t - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      publish({ ...e, replay: true });
      log(e);
    }
    return;
  }
  try {
    await runSwarm(args.brief, {
      maxSections: args.sections, theme, outRoot: path.join(ROOT, 'out'),
      emit: (e) => { publish(e); log(e); },
    });
  } catch (err) {
    console.error(err);
    publish({ type: 'error', message: String(err.message || err) });
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function serveFile(res, base, rel) {
  const file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(base)) return notFound(res);
  try {
    const s = await stat(file);
    const target = s.isDirectory() ? path.join(file, 'index.html') : file;
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    notFound(res);
  }
}
const notFound = (res) => { res.writeHead(404); res.end('not found'); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    for (const e of buffer) res.write(`data: ${JSON.stringify(e)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    start();
    return;
  }
  if (url.pathname.startsWith('/out/')) return serveFile(res, path.join(ROOT, 'out'), decodeURIComponent(url.pathname.slice(4)));
  return serveFile(res, path.join(ROOT, 'preview'), decodeURIComponent(url.pathname));
});

server.listen(args.port, '127.0.0.1', () => {
  const u = `http://127.0.0.1:${args.port}/`;
  console.log(`swarm-build preview: ${u}  (the build starts when the page opens)`);
  if (args.open) exec(`open "${u}"`);
});
