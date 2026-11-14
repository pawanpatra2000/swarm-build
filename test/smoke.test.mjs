// Offline end-to-end check of agent mode, sanitising, exports and the MCP server. No model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'swarm-build.mjs');
const dir = mkdtempSync(path.join(tmpdir(), 'swarm-smoke-'));
const sb = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' });

const plan = {
  title: 'Chai Corner', lang: 'en',
  design: { direction: 'Warm and simple.', scale: { h1: '64px', h2: '40px', h3: '22px', body: '17px', small: '14px' } },
  theme: { bg: '#fbf7f0', accent: '#9a3412', font: 'Inter', headingFont: 'Fraunces', radius: 'url(x)' },
  voice: 'Warm.',
  sections: [
    { id: 'header', name: 'Header', brief: 'Logo and nav', height: 'short' },
    { id: 'hero', name: 'Hero', brief: 'Headline', height: 'medium' },
    { id: 'footer', name: 'Footer', brief: 'Links', height: 'short' },
  ],
};
const html = {
  header: '<section><div class="sb-wrap"><a href="#hero" class="sb-btn sb-btn-primary">Order</a></div></section>',
  hero: '<section class="sb-section min-h-[70vh]"><div class="sb-wrap" tabindex="0"><h1 class="sb-h1">Chai {slowly} <script>alert(1)</script></h1><a href="javascript:alert(1)" onclick="x()">Go</a><img src="https://evil/x.png"></div></section>',
  footer: '```html\n<footer class="py-8"><p class="sb-small">Sample page.</p></footer>\n```',
};

test('agent-mode flow builds a sanitised page', () => {
  assert.match(sb('guide'), /swarm-build/);
  sb('start', 'Tiny tea shop page', '--no-preview');
  writeFileSync(path.join(dir, '.swarm', 'plan.json'), JSON.stringify(plan));
  assert.match(sb('plan', '.swarm/plan.json'), /3 sections/);
  for (const [id, h] of Object.entries(html)) {
    assert.match(sb('task', id), /<section/);
    writeFileSync(path.join(dir, '.swarm', 'out', `${id}.html`), h);
    sb('submit', id, `.swarm/out/${id}.html`);
  }
  const status = JSON.parse(sb('status'));
  assert.deepEqual(status.missing, []);
  const page = readFileSync(status.page, 'utf8');
  assert.doesNotMatch(page, /<script>alert|javascript:|onclick|evil\/x\.png/);
  assert.match(page, /min-h-\[560px\]/, 'vh units become pixels');
  assert.match(page, /--radius:14px/, 'unsafe theme values are dropped');
  assert.match(page, /data-section="footer"/, 'non-section roots are wrapped');
  assert.match(sb('done'), /Built 3\/3/);
});

test('framework exports write the right files', () => {
  for (const [t, file] of [['next', 'app/chai/page.tsx'], ['vue', 'components/swarm/chai-corner/Page.vue'], ['svelte', 'src/lib/swarm/chai-corner/Page.svelte'], ['astro', 'src/pages/chai.astro']]) {
    const out = mkdtempSync(path.join(tmpdir(), `swarm-${t}-`));
    writeFileSync(path.join(out, 'package.json'), JSON.stringify({ dependencies: { [t]: '*', tailwindcss: '^4' } }));
    if (t === 'next') writeFileSync(path.join(out, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@/*":["./*"]}}}');
    sb('export', 'auto', '--into', out, '--route', 'chai');
    assert.ok(existsSync(path.join(out, file)), `${t}: ${file}`);
    const again = spawnSync(process.execPath, [BIN, 'export', 'auto', '--into', out, '--route', 'chai'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(again.status, 0, `${t}: refuses to overwrite`);
  }
  const next = mkdtempSync(path.join(tmpdir(), 'swarm-jsx-'));
  writeFileSync(path.join(next, 'tsconfig.json'), '{}');
  sb('export', 'next', '--into', next, '--route', 'chai');
  const hero = readFileSync(path.join(next, 'components/swarm/chai-corner/Hero.tsx'), 'utf8');
  assert.match(hero, /tabIndex=\{0\}/);
  assert.match(hero, /className=/);
  assert.match(hero, /\{'\{'\}slowly\{'\}'\}/);
  const svelteDir = path.join(dir, '.swarm', readdirSync(path.join(dir, '.swarm')).find((d) => d.startsWith('tiny')), 'svelte');
  sb('export', 'svelte');
  assert.ok(existsSync(svelteDir));
});

test('watch returns new comments and restore brings back a version', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [BIN, 'watch', '--timeout', '20'], { cwd: dir });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 1500));
  const status = JSON.parse(sb('status'));
  const run = path.dirname(status.page);
  assert.ok(existsSync(path.join(run, 'watching.json')), 'heartbeat written while watching');
  const { Run } = await import('../src/run.mjs');
  const r = await Run.open(run);
  await r.addComment({ section: 'hero', text: 'Make the headline shorter' });
  const code = await new Promise((res) => child.on('exit', res));
  assert.equal(code, 0);
  assert.match(out, /1 new comment\(s\) on: hero/);
  assert.match(out, /Make the headline shorter/);
  // a second watch does not return the same comment again
  const again = execFileSync(process.execPath, [BIN, 'watch', '--timeout', '2'], { cwd: dir, encoding: 'utf8' });
  assert.match(again, /No new comments/);
  // versions + restore
  sb('task', 'hero', '--comments');
  writeFileSync(path.join(dir, '.swarm', 'out', 'hero2.html'), '<section><div class="sb-wrap"><h1 class="sb-h1">Chai.</h1></div></section>');
  assert.match(sb('submit', 'hero', '.swarm/out/hero2.html'), /resolved c1/);
  assert.equal((await r.versions('hero')).length, 2);
  assert.match(sb('restore', 'hero'), /version 1/);
  assert.match(readFileSync(path.join(run, 'sections', 'hero.html'), 'utf8'), /Chai /);
});

test('there is no API-key mode', () => {
  const r = spawnSync(process.execPath, [BIN, 'run', 'a page'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no API-key mode.*swarm-build guide/);
  assert.doesNotMatch(sb('--help'), /API_KEY|swarm-build run/);
});

test('MCP server lists tools and reports errors', () => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'swarm_submit', arguments: { id: 'nope', html: '<section></section>' } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const out = execFileSync(process.execPath, [BIN, 'mcp'], { cwd: dir, input, encoding: 'utf8' });
  const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(msgs.find((m) => m.id === 1).result.serverInfo.name, 'swarm-build');
  const tools = msgs.find((m) => m.id === 2).result.tools.map((t) => t.name);
  assert.ok(tools.includes('swarm_export') && tools.includes('swarm_start'));
  assert.equal(msgs.find((m) => m.id === 3).result.isError, true);
});

test('init writes skills and an AGENTS.md pointer', () => {
  const proj = mkdtempSync(path.join(tmpdir(), 'swarm-init-'));
  writeFileSync(path.join(proj, '.gitignore'), 'node_modules\n');
  execFileSync(process.execPath, [BIN, 'init', '--agent', 'all', '--mcp'], { cwd: proj, encoding: 'utf8' });
  for (const f of ['.claude/skills/swarm-build/SKILL.md', '.agents/skills/swarm-build/SKILL.md', '.cursor/rules/swarm-build.mdc', '.kiro/skills/swarm-build/SKILL.md', 'AGENTS.md', '.mcp.json']) {
    assert.ok(existsSync(path.join(proj, f)), f);
  }
  execFileSync(process.execPath, [BIN, 'init', '--agent', 'agents-md'], { cwd: proj });
  assert.equal(readFileSync(path.join(proj, 'AGENTS.md'), 'utf8').match(/swarm-build:start/g).length, 1, 'idempotent');
  assert.match(readFileSync(path.join(proj, '.gitignore'), 'utf8'), /\.swarm\//);
});
