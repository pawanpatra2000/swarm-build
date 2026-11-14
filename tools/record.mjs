#!/usr/bin/env node
// Records the replay of a finished run (built by your coding agent) to MP4, plus desktop and mobile screenshots.
//   node tools/record.mjs <run-dir> [--speed 2] [--out demo.mp4] [--port 4790]
// Needs: npm i -D playwright, a Chromium build (npx playwright install chromium), ffmpeg on PATH.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const runDir = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!runDir) { console.error('Usage: node tools/record.mjs <run-dir> [--speed 2] [--out demo.mp4]'); process.exit(1); }
const speed = Number(opt('--speed', 2));
const port = Number(opt('--port', 4790));
const out = path.resolve(opt('--out', path.join(path.resolve(runDir), 'replay.mp4')));
const W = 1600, H = 1000;

const server = spawn(process.execPath, [path.join(ROOT, 'bin/swarm-build.mjs'), 'replay', path.resolve(runDir), '--port', String(port)], { env: process.env });
server.stderr.pipe(process.stderr);
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { process.stdout.write(d); if (String(d).includes('replay:')) resolve(); });
  server.on('exit', (c) => reject(new Error(`replay server exited (${c})`)));
});

const tmpDir = path.join(path.dirname(out), '.video-tmp');
await rm(tmpDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: tmpDir, size: { width: W, height: H } } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(`http://127.0.0.1:${port}/?replay=1&autolive=1&speed=${speed}`);
await page.waitForFunction(() => window.__swarmDone === true, null, { timeout: 15 * 60 * 1000, polling: 500 });
const video = page.video();
await context.close();
const webm = await video.path();

const shots = [];
for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: name === 'mobile' ? 2 : 1 });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/page`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const file = path.join(path.resolve(runDir), `screenshot-${name}.png`);
  await p.screenshot({ path: file, fullPage: true });
  shots.push(file);
  await ctx.close();
}
await browser.close();
server.kill();

execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.4', '-i', webm, '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', '30', out]);
await rm(tmpDir, { recursive: true, force: true });
console.log(`\nvideo: ${out}`);
shots.forEach((s) => console.log(`shot:  ${s}`));
process.exit(0);
