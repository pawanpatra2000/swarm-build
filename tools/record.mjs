#!/usr/bin/env node
// Records a swarm-build run to MP4 and screenshots the result.
//   node tools/record.mjs [--speed 1] [--out demo.mp4] [--port 4790] -- --brief-file brief.txt [run args...]
// Needs: npm i playwright, a Chromium build (npx playwright install chromium), ffmpeg on PATH.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split >= 0 ? argv.slice(0, split) : argv;
const serverArgs = split >= 0 ? argv.slice(split + 1) : [];
const opt = (name, def) => { const i = own.indexOf(name); return i >= 0 ? own[i + 1] : def; };
const speed = Number(opt('--speed', 1));
const port = Number(opt('--port', 4790));
const out = path.resolve(opt('--out', path.join(ROOT, 'out', 'demo.mp4')));
const W = 1600, H = 1000;

const server = spawn(process.execPath, [path.join(ROOT, 'bin/swarm-build.mjs'), 'run', ...serverArgs, '--port', String(port)], { cwd: path.join(ROOT, 'out'), env: process.env });
server.stderr.pipe(process.stderr);
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => {
    process.stdout.write(d);
    if (String(d).includes('preview:')) resolve();
  });
  server.on('exit', (c) => reject(new Error(`server exited (${c})`)));
});

const tmpDir = path.join(ROOT, 'out', '.video-tmp');
await rm(tmpDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: tmpDir, size: { width: W, height: H } } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/?autolive=1&speed=${speed}`);
await page.waitForFunction(() => window.__swarmDone === true, null, { timeout: 15 * 60 * 1000, polling: 500 });
const stats = await page.evaluate(() => window.__swarm.stats);
const video = page.video();
await context.close();
const webm = await video.path();

// Screenshots of the generated page: desktop + mobile, full length.
const shots = [];
for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: name === 'mobile' ? 2 : 1 });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/page`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const file = path.join(stats.outDir, `screenshot-${name}.png`);
  await p.screenshot({ path: file, fullPage: true });
  shots.push(file);
  await ctx.close();
}
await browser.close();
server.kill();

await mkdir(path.dirname(out), { recursive: true });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.4', '-i', webm, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', '30', out]);
await rm(tmpDir, { recursive: true, force: true });
console.log(`\nvideo: ${out} (${((Date.now() - t0) / 1000).toFixed(0)}s recorded)`);
shots.forEach((s) => console.log(`shot:  ${s}`));
console.log(`stats: ${JSON.stringify(stats)}`);
process.exit(0);
