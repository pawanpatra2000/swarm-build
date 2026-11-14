// swarm-build command line. A coding agent (Claude Code, Codex, Cursor, Kiro, ...) does all the planning and
// building with its own model through these commands. swarm-build itself never calls a model or needs an API key.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, exec } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Run, MAX_SECTIONS } from './run.mjs';
import { PLANNER_SYSTEM, BUILDER_SYSTEM, EDIT_SYSTEM, builderPrompt, editPrompt } from './prompts.mjs';
import { checkPage, impeccableDetect, formatFindings } from './review.mjs';
import { startPreview, previewRunning } from './server.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(await readFile(path.join(PKG, 'package.json'), 'utf8')).version;

// How agents should call this tool: the published package through npx, or this checkout directly.
export function sbCmd() {
  if (process.env.SWARM_BUILD_CMD) return process.env.SWARM_BUILD_CMD;
  if (/[\\/](_npx|node_modules)[\\/]/.test(PKG)) return 'npx -y swarm-build';
  const bin = path.join(PKG, 'bin', 'swarm-build.mjs');
  return `node ${bin.includes(' ') ? JSON.stringify(bin) : bin}`;
}
const rel = (p) => path.relative(process.cwd(), p) || '.';

const HELP = `swarm-build ${VERSION}: plan a UI into sections, build them in parallel, watch the swarm live.

Your coding agent plans and builds with its own model. No API key, no extra cost:
  swarm-build guide                 print the full workflow for the agent to follow (no install needed)
  swarm-build start "<brief>" | --brief-file f [--agent "Claude Code"] [--no-preview] [--open]
  swarm-build guide plan            print planning instructions and the plan JSON shape
  swarm-build plan <plan.json|->    save the plan, print one task per section
  swarm-build task <id> [--fix "..."] [--comments]   print a sub-agent's instructions (marks it started)
  swarm-build submit <id> <file|->  save a section
  swarm-build check [--impeccable]  design checks on the current page
  swarm-build comments              open comments from the preview, as JSON
  swarm-build watch [--timeout 240] wait for the user's next comments in the preview, then print them
  swarm-build restore <id> [n]      put an earlier version of a section back (no agent work)
  swarm-build status | done

Preview, replay, export, setup:
  swarm-build preview [--run dir] [--port 4777] [--open]
  swarm-build replay [run-dir] [--open]
  swarm-build export [auto|next|react|vue|nuxt|svelte|sveltekit|astro|html] [--into .] [--route path] [--force]
  swarm-build export share [--out file.html]
  swarm-build init [--agent claude|codex|cursor|kiro|agents-md|all] [--mcp] [--design] [--global]
  swarm-build mcp                   MCP server over stdio (tools: swarm_start, swarm_plan, swarm_task, ...)

Common: --run <dir> picks a run (default: .swarm/current). --root <dir> changes the .swarm folder.`;

export function parseArgs(argv) {
  const o = { _: [] };
  const flags = new Set(['open', 'impeccable', 'no-preview', 'comments', 'design', 'global', 'json', 'help', 'version', 'yes', 'all', 'mcp', 'force']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') o.help = true;
    else if (a === '-v') o.version = true;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      if (inline !== undefined) o[k] = inline;
      else if (flags.has(k)) o[k] = true;
      else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

async function readInput(file) {
  if (!file || file === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  // Agents often run submit in the same step as the file write. Wait (up to 5 s) until the file exists,
  // has markup and stops changing, so a half-written file is never submitted.
  const p = path.resolve(file);
  let last = null;
  for (let i = 0; i < 25; i++) {
    const text = existsSync(p) ? await readFile(p, 'utf8') : null;
    if (text && /<\/(section|footer|header|div|main)>\s*$/i.test(text.trim()) && text === last) return text;
    last = text;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (last == null) throw new Error(`File not found: ${file}`);
  return last;
}

const openURL = (u) => exec(process.platform === 'darwin' ? `open "${u}"` : process.platform === 'win32' ? `start "" "${u}"` : `xdg-open "${u}"`);

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => (p < start + 40 ? tryPort(p + 1) : resolve(0)));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

// Reuses a preview already serving this .swarm root, else starts a detached one.
export async function ensurePreview(root, { port = 4777 } = {}) {
  root = path.resolve(root);
  const infoFile = path.join(root, 'preview.json');
  if (existsSync(infoFile)) {
    const info = JSON.parse(await readFile(infoFile, 'utf8'));
    const h = await previewRunning(info.port);
    if (h && path.resolve(h.root) === root) return `http://127.0.0.1:${info.port}/`;
  }
  const h = await previewRunning(port);
  if (h && path.resolve(h.root) === root) return `http://127.0.0.1:${port}/`;
  const p = await freePort(port);
  if (!p) throw new Error('No free port for the preview.');
  const child = spawn(process.execPath, [path.join(PKG, 'bin', 'swarm-build.mjs'), 'preview', '--root', root, '--port', String(p)], { detached: true, stdio: 'ignore', cwd: process.cwd() });
  child.unref();
  await mkdir(root, { recursive: true });
  await writeFile(infoFile, JSON.stringify({ port: p, pid: child.pid }, null, 2));
  for (let i = 0; i < 40; i++) {
    if (await previewRunning(p)) return `http://127.0.0.1:${p}/`;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Preview did not start.');
}

// ---------- agent-mode helpers, shared with the MCP server ----------
export async function agentStart({ brief, root = '.swarm', agent, preview = true, port }) {
  if (!brief || !brief.trim()) throw new Error('A brief is required.');
  const run = await Run.create(brief.trim(), { root, mode: 'agent' });
  const { detectTarget } = await import('./frameworks.mjs');
  run.meta.target = (await detectTarget()).target;
  await writeFile(run.file('run.json'), JSON.stringify(run.meta, null, 2));
  await run.emit({ type: 'meta', brief: brief.trim(), model: agent || null, mode: 'agent' });
  await run.emit({ type: 'plan:start' });
  const url = preview ? await ensurePreview(root, { port: port ? Number(port) : 4777 }) : null;
  return { run, url };
}

// The whole agent workflow, printable by any agent with a shell: `npx -y swarm-build guide`.
export async function workflowGuide() {
  const text = await readFile(path.join(PKG, 'skill', 'SKILL.md'), 'utf8');
  return text.replace(/^---[\s\S]*?---\n/, '').replaceAll('{{SB}}', sbCmd());
}

export function planGuide(run) {
  return `${PLANNER_SYSTEM}

Brief for this run:
${run ? run.meta.brief : '(start a run first)'}

Write the JSON to .swarm/plan.json, then run: ${sbCmd()} plan .swarm/plan.json
Sections: 4 to ${MAX_SECTIONS}. If the project has DESIGN.md, follow its colours, fonts and rules.`;
}

export async function agentPlan(run, json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  const plan = await run.setPlan(raw, { maxSections: MAX_SECTIONS });
  await mkdir(path.join(path.dirname(run.dir), 'out'), { recursive: true });
  return plan;
}

export async function agentTask(run, id, { fix, comments } = {}) {
  const plan = await run.plan();
  const section = plan.sections.find((s) => s.id === id);
  if (!section) throw new Error(`Unknown section "${id}". Sections: ${plan.sections.map((s) => s.id).join(', ')}`);
  const outFile = path.join(path.dirname(run.dir), 'out', `${id}.html`);
  if (comments) {
    const open = (await run.comments()).filter((c) => c.section === id && c.status === 'open');
    if (!open.length) throw new Error(`No open comments on "${id}".`);
    const html = (await run.sectionHTML(id)) || '';
    await run.startAgent(id, { reason: 'comment', note: open.map((c) => c.text).join(' / ') });
    const comment = { text: open.map((c, i) => `${i + 1}. ${c.text}${c.target ? ` (on: ${c.target})` : ''}`).join('\n') };
    return `${EDIT_SYSTEM}\n\n---\n${editPrompt(plan, section, html, comment)}\n\n---\nWrite the full new section to ${rel(outFile)}, then run: ${sbCmd()} submit ${id} ${rel(outFile)}`;
  }
  const s = fix ? { ...section, fix } : section;
  await run.startAgent(id, { reason: fix ? 'fix' : 'build', note: fix });
  const designFile = ['DESIGN.md', 'design.md'].map((f) => path.resolve(f)).find((f) => existsSync(f));
  const designDoc = designFile ? await readFile(designFile, 'utf8') : '';
  const current = fix ? `\n\nCurrent version of the section (improve it, keep what works):\n${(await run.sectionHTML(id)) || ''}` : '';
  return `${BUILDER_SYSTEM}\n\n---\n${builderPrompt(plan, s, { designDoc })}${current}\n\n---\nWrite only the <section> HTML to ${rel(outFile)}, then run: ${sbCmd()} submit ${id} ${rel(outFile)}`;
}

export async function agentCheck(run, { impeccable = false } = {}) {
  const plan = await run.plan();
  const sections = Object.fromEntries(await Promise.all(plan.sections.map(async (s) => [s.id, (await run.sectionHTML(s.id)) || ''])));
  const findings = checkPage(plan, sections);
  if (impeccable) {
    // Prefer the rendered page from a running preview of this run.
    let target = run.file('index.html');
    const info = path.join(path.dirname(run.dir), 'preview.json');
    if (existsSync(info)) {
      const { port } = JSON.parse(await readFile(info, 'utf8'));
      const h = await previewRunning(port);
      if (h && h.run === run.dir) target = `http://127.0.0.1:${port}/page`;
    }
    findings.push(...(await impeccableDetect(target)));
  }
  await run.emit({ type: 'review:done', findings, fixes: [], summary: `${findings.filter((f) => f.severity !== 'info').length} automated findings.` });
  return findings;
}

export async function agentStatus(run) {
  const plan = run.hasPlan() ? await run.plan() : null;
  const missing = plan ? await run.missingSections() : [];
  const comments = await run.comments();
  return {
    run: run.dir, mode: run.meta.mode, page: run.file('index.html'),
    planned: Boolean(plan), sections: plan ? plan.sections.map((s) => s.id) : [], missing,
    openComments: comments.filter((c) => c.status === 'open').length,
  };
}

// Blocks until the user leaves new comments in the preview (or the timeout passes), then returns them.
// While it runs, the preview shows "your agent is listening".
export async function agentWatch(run, { timeoutMs = 240000 } = {}) {
  const until = Date.now() + timeoutMs;
  await run.emit({ type: 'watch', on: true });
  try {
    while (Date.now() < until) {
      await run.heartbeat();
      const fresh = await run.claimComments();
      if (fresh.length) return fresh;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return [];
  } finally {
    await run.emit({ type: 'watch', on: false });
  }
}

export function watchReport(list, how = 'cli') {
  if (!list.length) return 'No new comments. Run watch again to keep listening, or stop if the user is finished.';
  const ids = [...new Set(list.map((c) => c.section))];
  const step = how === 'mcp'
    ? 'calls swarm_task {id, comments: true}, follows it, then swarm_submit'
    : `runs \`${sbCmd()} task <id> --comments\`, follows it, then \`${sbCmd()} submit <id> <file>\``;
  return `${list.length} new comment(s) on: ${ids.join(', ')}\n${JSON.stringify(list.map(({ id, section, target, text }) => ({ id, section, target, text })), null, 2)}\n\nStart one sub-agent per section above, all in one message. Each ${step}. Then watch again.`;
}

export async function agentDone(run) {
  const stats = await run.stats({ model: null });
  await run.emit({ type: 'done', stats });
  return stats;
}

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;
function logEvent(e) {
  const s = `${fmt(e.t).padStart(6)} `;
  if (e.type === 'plan:done') console.log(`${s} plan: ${e.plan.sections.map((x) => x.id).join(', ')}`);
  else if (e.type === 'agent:start') console.log(`${s} ${e.agent.name.padEnd(8)} ${e.reason === 'build' ? '->' : e.reason} ${e.id}`);
  else if (e.type === 'agent:done') console.log(`${s} ${e.agent.name.padEnd(8)} done ${e.id} (${fmt(e.ms)}, ${e.html.length} chars)`);
  else if (e.type === 'agent:error') console.log(`${s} ${e.agent.name.padEnd(8)} FAILED ${e.id}: ${e.message}`);
  else if (e.type === 'review:done') console.log(`${s} review: ${e.findings.length} findings, ${e.fixes.length} fixes${e.summary ? ` (${e.summary})` : ''}`);
  else if (e.type === 'done') {
    const st = e.stats;
    console.log(`${s} done: ${st.sections} sections, build ${fmt(st.buildWallMs)} wall vs ${fmt(st.sumMs)} one-by-one (${st.speedup}x)${st.costUsd != null ? `, $${st.costUsd}` : ''}`);
    console.log(`        page: ${st.page}`);
  }
}

export async function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  if (o.version) return console.log(VERSION);
  if (!cmd || o.help || cmd === 'help') return console.log(HELP);
  const root = o.root || '.swarm';
  const current = () => Run.resolve(o.run);

  switch (cmd) {
    case 'run': throw new Error('There is no API-key mode. Ask your coding agent: run `npx -y swarm-build guide` and follow it.');
    case 'start': {
      const brief = o['brief-file'] ? await readFile(o['brief-file'], 'utf8') : o._.slice(1).join(' ');
      const { run, url } = await agentStart({ brief, root, agent: o.agent, preview: !o['no-preview'], port: o.port });
      if (url && o.open) openURL(url);
      console.log(`run:     ${run.dir}`);
      if (url) console.log(`preview: ${url}   <- show this to the user`);
      console.log(`target:  ${run.meta.target} (detected; the page is exported into this framework at the end)`);
      console.log(`\nNext: run \`${sbCmd()} guide plan\`, write .swarm/plan.json, then \`${sbCmd()} plan .swarm/plan.json\`.`);
      return;
    }
    case 'guide': {
      const kind = o._[1] || 'workflow';
      let run = null;
      try { run = await current(); } catch { /* guide works without a run */ }
      if (kind === 'workflow') return console.log(await workflowGuide());
      if (kind === 'plan') return console.log(planGuide(run));
      if (kind === 'build') return console.log(BUILDER_SYSTEM);
      throw new Error('Use: swarm-build guide [workflow|plan|build]');
    }
    case 'plan': {
      const run = await current();
      const plan = await agentPlan(run, await readInput(o._[1]));
      console.log(`Plan saved: ${plan.title}, ${plan.sections.length} sections.\n`);
      console.log('Start one sub-agent per section, all in the same message. Each one runs its line:');
      const out = rel(path.join(path.dirname(run.dir), 'out'));
      for (const s of plan.sections) console.log(`  ${s.agent.name.padEnd(8)} ${sbCmd()} task ${s.id}   then   ${sbCmd()} submit ${s.id} ${out}/${s.id}.html`);
      return;
    }
    case 'task': {
      const run = await current();
      const id = o._[1];
      if (!id) throw new Error('Use: swarm-build task <section-id>');
      return console.log(await agentTask(run, id, { fix: o.fix, comments: o.comments }));
    }
    case 'submit': {
      const run = await current();
      const [, id, file] = o._;
      if (!id) throw new Error('Use: swarm-build submit <section-id> <file|->');
      const r = await run.submitSection(id, await readInput(file));
      const missing = await run.missingSections();
      console.log(`Saved ${id} (${r.reason}${r.resolved.length ? `, resolved ${r.resolved.join(', ')}` : ''}). ${missing.length ? `Still missing: ${missing.join(', ')}` : 'All sections are in.'}`);
      return;
    }
    case 'check': {
      const run = await current();
      const findings = await agentCheck(run, { impeccable: o.impeccable });
      return console.log(o.json ? JSON.stringify(findings, null, 2) : formatFindings(findings));
    }
    case 'comments': {
      const run = await current();
      const list = (await run.comments()).filter((c) => o.all || c.status === 'open');
      return console.log(JSON.stringify(list, null, 2));
    }
    case 'watch': {
      const run = await current();
      const list = await agentWatch(run, { timeoutMs: Number(o.timeout || 240) * 1000 });
      return console.log(watchReport(list));
    }
    case 'restore': {
      const run = await current();
      const [, id, n] = o._;
      if (!id) throw new Error('Use: swarm-build restore <section-id> [version]');
      return console.log(`Restored ${id} to version ${await run.restoreSection(id, n)}.`);
    }
    case 'status': return console.log(JSON.stringify(await agentStatus(await current()), null, 2));
    case 'done': {
      const st = await agentDone(await current());
      return console.log(`Built ${st.built}/${st.sections} sections. Parallel ${fmt(st.buildWallMs)} vs one-by-one ${fmt(st.sumMs)} (${st.speedup ?? '-'}x).\npage: ${st.page}`);
    }
    case 'preview': {
      const pv = await startPreview({ root, runDir: o.run, port: Number(o.port || 4777) });
      console.log(`swarm-build preview: ${pv.url}`);
      if (o.open) openURL(pv.url);
      return new Promise(() => {}); // keep serving
    }
    case 'replay': {
      const dir = o._[1] || (await current()).dir;
      await Run.open(dir);
      const pv = await startPreview({ runDir: dir, port: Number(o.port || 4777) });
      const u = `${pv.url}?replay=1`;
      console.log(`swarm-build replay: ${u}`);
      if (o.open) openURL(u);
      return new Promise(() => {});
    }
    case 'export': {
      const run = await current();
      const kind = o._[1] || 'auto';
      if (kind === 'share') {
        const { exportShare } = await import('./export.mjs');
        const r = await exportShare(run, o.out);
        return console.log(`Share file: ${r.file} (${(r.bytes / 1024).toFixed(0)} KB). Open it in any browser; it replays the build.`);
      }
      const { exportFramework, TARGETS } = await import('./frameworks.mjs');
      if (kind !== 'auto' && !TARGETS.includes(kind)) throw new Error(`Use: swarm-build export auto|${TARGETS.join('|')}|share [--into <project>] [--route path] [--force]`);
      const into = o.into;
      const r = await exportFramework(run, { target: kind, into, route: o.route, force: o.force });
      console.log(`${r.target} export${into ? ` into ${r.dir}` : `: ${r.dir}`}`);
      r.files.forEach((f) => console.log(`  ${path.relative(process.cwd(), f) || f}`));
      if (r.route && into) console.log(`route: ${r.route}`);
      r.notes.forEach((n) => console.log(`note: ${n}`));
      return;
    }
    case 'init': return (await import('./init.mjs')).init(o);
    case 'mcp': return (await import('./mcp.mjs')).serve();
    default: throw new Error(`Unknown command "${cmd}". Run swarm-build --help.`);
  }
}
