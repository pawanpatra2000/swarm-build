// `swarm-build init`: install the skill (and optionally MCP config and design skills) for coding agents.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sbCmd } from './cli.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = ['claude', 'codex', 'cursor', 'kiro', 'agents-md'];
const MARK_START = '<!-- swarm-build:start -->';
const MARK_END = '<!-- swarm-build:end -->';

function detect(cwd) {
  const has = (p) => existsSync(path.join(cwd, p));
  const found = [];
  if (has('.claude') || has('CLAUDE.md')) found.push('claude');
  if (has('.codex') || has('.agents') || has('AGENTS.md')) found.push('codex');
  if (has('.cursor') || has('.cursorrules')) found.push('cursor');
  if (has('.kiro')) found.push('kiro');
  return found.length ? found : ['claude', 'codex', 'agents-md'];
}

async function writeFileSafe(file, text, written) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  written.push(file);
}

// Adds our server to an mcpServers JSON file without touching other entries.
async function mergeMcp(file, entry, written) {
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; add swarm-build by hand.`); }
  }
  cfg.mcpServers = { ...(cfg.mcpServers || {}), 'swarm-build': entry };
  await writeFileSafe(file, JSON.stringify(cfg, null, 2) + '\n', written);
}

function mcpEntry() {
  const [command, ...args] = sbCmd() === 'npx -y swarm-build' ? ['npx', '-y', 'swarm-build'] : ['node', path.join(PKG, 'bin', 'swarm-build.mjs')];
  return { command, args: [...args, 'mcp'] };
}

const builderAgent = (sb) => `---
name: swarm-section-builder
description: Builds exactly one section of a swarm-build page. Use one per section, all started in the same message, during a swarm build.
tools: Bash, Read, Write
---
You build one section of a page that other agents are building in parallel.
1. Run \`${sb} task <section-id>\` (the id is in your instructions) and read everything it prints.
2. Write the single <section> element it asks for to the file it names. Follow the design rules exactly.
3. Run \`${sb} submit <section-id> <file>\`.
Reply with "done" or the exact error. Don't touch other sections.
`;

export async function init(o) {
  const cwd = process.cwd();
  const global = Boolean(o.global);
  const home = os.homedir();
  const list = o.agent === 'all' ? AGENTS : o.agent ? String(o.agent).split(',') : detect(cwd);
  const bad = list.filter((a) => !AGENTS.includes(a));
  if (bad.length) throw new Error(`Unknown agent(s): ${bad.join(', ')}. Use ${AGENTS.join(', ')} or all.`);
  const sb = sbCmd();
  const skill = (await readFile(path.join(PKG, 'skill', 'SKILL.md'), 'utf8')).replaceAll('{{SB}}', sb);
  const base = global ? home : cwd;
  const written = [];
  const notes = [];

  for (const a of list) {
    if (a === 'claude') {
      await writeFileSafe(path.join(base, '.claude', 'skills', 'swarm-build', 'SKILL.md'), skill, written);
      await writeFileSafe(path.join(base, '.claude', 'agents', 'swarm-section-builder.md'), builderAgent(sb), written);
      if (o.mcp) {
        if (global) notes.push(`Claude Code MCP (global): claude mcp add swarm-build -s user -- ${mcpEntry().command} ${mcpEntry().args.join(' ')}`);
        else await mergeMcp(path.join(cwd, '.mcp.json'), mcpEntry(), written);
      }
    }
    if (a === 'codex') {
      await writeFileSafe(path.join(base, '.agents', 'skills', 'swarm-build', 'SKILL.md'), skill, written);
      if (o.mcp) notes.push(`Codex MCP: codex mcp add swarm-build -- ${mcpEntry().command} ${mcpEntry().args.join(' ')}`);
    }
    if (a === 'cursor') {
      if (global) notes.push('Cursor has no file-based global rules; run init inside the project instead.');
      else {
        const body = skill.replace(/^---[\s\S]*?---\n/, '');
        await writeFileSafe(path.join(cwd, '.cursor', 'rules', 'swarm-build.mdc'), `---\ndescription: Build a page fast with parallel agents and a live swarm-cursor preview (swarm-build).\nalwaysApply: false\n---\n${body}`, written);
        if (o.mcp) await mergeMcp(path.join(cwd, '.cursor', 'mcp.json'), mcpEntry(), written);
      }
    }
    if (a === 'agents-md') {
      // AGENTS.md is read by many coding agents; a short pointer keeps it small and always current.
      if (global) { notes.push('agents-md is per project; run init inside the project.'); continue; }
      const file = path.join(cwd, 'AGENTS.md');
      const block = `${MARK_START}\n## swarm-build\n\nWhen the user asks to "swarm build" a page or to build a UI fast with parallel agents, run \`${sb} guide\` and follow it exactly. It uses your own model and sub-agents (no API key) and shows a live preview of the build.\n${MARK_END}\n`;
      let text = existsSync(file) ? await readFile(file, 'utf8') : '';
      const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}\\n?`);
      text = re.test(text) ? text.replace(re, block) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}`;
      await writeFileSafe(file, text, written);
    }
    if (a === 'kiro') {
      await writeFileSafe(path.join(base, '.kiro', 'skills', 'swarm-build', 'SKILL.md'), skill, written);
      if (o.mcp) {
        const file = global ? path.join(home, '.kiro', 'settings', 'mcp.json') : path.join(cwd, '.kiro', 'settings', 'mcp.json');
        await mergeMcp(file, mcpEntry(), written);
      }
    }
  }

  if (!global) {
    const gi = path.join(cwd, '.gitignore');
    const line = '.swarm/';
    if (existsSync(gi)) {
      const text = await readFile(gi, 'utf8');
      if (!text.split('\n').some((l) => l.trim() === line)) { await appendFile(gi, `${text.endsWith('\n') ? '' : '\n'}${line}\n`); written.push(`${gi} (added .swarm/)`); }
    }
  }

  if (o.design) {
    // Third-party design skills, installed with their own installers so credit and updates stay with their authors.
    const run = (cmd, args) => {
      console.log(`\n$ ${cmd} ${args.join(' ')}`);
      const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: global ? home : cwd, shell: process.platform === 'win32' });
      if (r.status !== 0) notes.push(`"${cmd} ${args.join(' ')}" did not finish; run it yourself if you want it.`);
    };
    run('npx', ['-y', 'impeccable@latest', 'install', global ? '--global' : '--project', '-y']);
    for (const a of list) run('npx', ['-y', 'uipro-cli@latest', 'init', '--ai', a]);
  }

  console.log(`swarm-build set up for: ${list.join(', ')}${global ? ' (global)' : ''}`);
  written.forEach((f) => console.log(`  wrote ${path.relative(cwd, f) || f}`));
  notes.forEach((n) => console.log(`  note: ${n}`));
  console.log(`\nNow ask your agent: "swarm build a landing page for <your idea>".${o.design ? '' : '\nFor stronger design guidance add --design (installs Impeccable and UI UX Pro Max).'}`);
}
