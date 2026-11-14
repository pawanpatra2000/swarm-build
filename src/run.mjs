// A run is a folder. The CLI and the MCP server both read and write the same files:
//   run.json        meta: brief, createdAt, mode
//   events.jsonl    append-only event log; the preview streams it, replay reads it
//   plan.json       planner output after normalising
//   sections/*.html one file per section (latest version)
//   comments.json   comments left in the preview
//   index.html      assembled page
import { mkdir, readFile, writeFile, appendFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { slugify, sanitize, documentHTML, normalizeTheme, normalizeDesign, themeCSS, fontsHref, fallbackSection } from './assemble.mjs';

export const AGENTS = [
  { name: 'Ada', color: '#e4572e' },
  { name: 'Linus', color: '#2e86ab' },
  { name: 'Grace', color: '#7b2cbf' },
  { name: 'Alan', color: '#2a9d8f' },
  { name: 'Margaret', color: '#d4a017' },
  { name: 'Dennis', color: '#c2185b' },
  { name: 'Barbara', color: '#5c6bc0' },
  { name: 'Ken', color: '#6d9f3a' },
];
export const MAX_SECTIONS = AGENTS.length;

const POINTER = '.swarm/current';

export class Run {
  constructor(dir, meta) {
    this.dir = path.resolve(dir);
    this.meta = meta;
  }

  static async create(brief, { root = '.swarm', mode = 'agent', name } = {}) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const dir = path.resolve(root, `${slugify(name || brief.split('\n')[0]).slice(0, 40)}-${stamp}`);
    await mkdir(path.join(dir, 'sections'), { recursive: true });
    const meta = { brief, createdAt: Date.now(), mode, version: 2 };
    await writeFile(path.join(dir, 'run.json'), JSON.stringify(meta, null, 2));
    await writeFile(path.join(dir, 'events.jsonl'), '');
    await writeFile(path.join(dir, 'comments.json'), '[]');
    const run = new Run(dir, meta);
    await run.setCurrent();
    return run;
  }

  static async open(dir) {
    const d = path.resolve(dir);
    const meta = JSON.parse(await readFile(path.join(d, 'run.json'), 'utf8'));
    return new Run(d, meta);
  }

  // Finds the run: explicit --run, else .swarm/current in this folder or a parent.
  static async resolve(dir) {
    if (dir) return Run.open(dir);
    let cur = process.cwd();
    for (;;) {
      const p = path.join(cur, POINTER);
      if (existsSync(p)) return Run.open(readFileSync(p, 'utf8').trim());
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    throw new Error('No active run. Start one with `swarm-build start "<brief>"` or pass --run <dir>.');
  }

  async setCurrent() {
    const root = path.dirname(this.dir);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'current'), this.dir);
  }

  file(...p) { return path.join(this.dir, ...p); }

  async emit(e) {
    const ev = { t: Date.now() - this.meta.createdAt, ...e };
    await appendFile(this.file('events.jsonl'), JSON.stringify(ev) + '\n');
    return ev;
  }

  async events() {
    const raw = await readFile(this.file('events.jsonl'), 'utf8').catch(() => '');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  async plan() {
    return JSON.parse(await readFile(this.file('plan.json'), 'utf8'));
  }

  hasPlan() { return existsSync(this.file('plan.json')); }

  // Validates and normalises a planner result, writes plan.json and announces it.
  async setPlan(raw, { maxSections = MAX_SECTIONS, theme, ms, cost } = {}) {
    const sections = (raw.sections || []).slice(0, Math.min(maxSections, MAX_SECTIONS));
    if (sections.length < 2) throw new Error('A plan needs at least 2 sections.');
    const seen = new Set();
    sections.forEach((s, i) => {
      s.id = slugify(s.id || s.name || `section-${i + 1}`);
      while (seen.has(s.id)) s.id += '-2';
      seen.add(s.id);
      s.name = String(s.name || s.id);
      s.brief = String(s.brief || '');
      s.layout = s.layout ? String(s.layout) : '';
      s.height = ['short', 'medium', 'tall'].includes(s.height) ? s.height : 'medium';
      s.agent = AGENTS[i % AGENTS.length];
    });
    const plan = {
      title: String(raw.title || 'Untitled page'),
      description: raw.description ? String(raw.description) : '',
      lang: /^[a-z]{2}(-[A-Za-z]{2})?$/.test(raw.lang || '') ? raw.lang : 'en',
      design: normalizeDesign(raw.design),
      theme: normalizeTheme({ ...(raw.theme || {}), ...(theme || {}) }),
      voice: String(raw.voice || 'Clear, direct and friendly.'),
      sections,
    };
    await writeFile(this.file('plan.json'), JSON.stringify(plan, null, 2));
    await this.emit({ type: 'plan:done', plan, ms, cost, stageCSS: themeCSS(plan.theme, plan.design), fonts: fontsHref(plan.theme) });
    return plan;
  }

  async sectionHTML(id) {
    return readFile(this.file('sections', `${id}.html`), 'utf8').catch(() => null);
  }

  // Saves a section and announces it. Reason and start time default to the last agent:start for this section.
  async submitSection(id, html, { started, cost, reason, resolves, chars } = {}) {
    const plan = await this.plan();
    const section = plan.sections.find((s) => s.id === id);
    if (!section) throw new Error(`Unknown section "${id}". Sections: ${plan.sections.map((s) => s.id).join(', ')}`);
    if (!/<[a-z][\s\S]*>/i.test(html)) throw new Error('Section HTML is empty. Submit one <section> element.');
    const clean = sanitize(html, id);
    await writeFile(this.file('sections', `${id}.html`), clean);
    const lastStart = await this.lastStart(id);
    const why = reason || lastStart?.reason || 'build';
    const startT = started ?? (lastStart ? this.meta.createdAt + lastStart.t : Date.now());
    const ms = Date.now() - startT;
    let ids = resolves;
    if (!ids && why === 'comment') ids = (await this.comments()).filter((c) => c.section === id && c.status === 'open').map((c) => c.id);
    const resolved = await this.resolveComments(ids, id);
    await this.emit({ type: 'agent:done', id, agent: section.agent, html: clean, ms, cost, reason: why, resolves: resolved, chars: chars ?? html.length });
    await this.writePage();
    return { id, html: clean, ms, reason: why, resolved };
  }

  async startAgent(id, { reason = 'build', note } = {}) {
    const plan = await this.plan();
    const section = plan.sections.find((s) => s.id === id);
    if (!section) throw new Error(`Unknown section "${id}". Sections: ${plan.sections.map((s) => s.id).join(', ')}`);
    await this.emit({ type: 'agent:start', id, agent: section.agent, reason, note });
    return section;
  }

  async lastStart(id) {
    const evs = await this.events();
    return [...evs].reverse().find((e) => e.type === 'agent:start' && e.id === id) || null;
  }

  async writePage() {
    const plan = await this.plan();
    const parts = await Promise.all(plan.sections.map(async (s) => (await this.sectionHTML(s.id)) || fallbackSection(s, 'Not built yet.')));
    await writeFile(this.file('index.html'), documentHTML(plan, parts));
    return this.file('index.html');
  }

  async missingSections() {
    const plan = await this.plan();
    const have = new Set((await readdir(this.file('sections')).catch(() => [])).map((f) => f.replace(/\.html$/, '')));
    return plan.sections.filter((s) => !have.has(s.id)).map((s) => s.id);
  }

  // Timing for the whole run, from the event log.
  async stats(extra = {}) {
    const evs = await this.events();
    const plan = await this.plan();
    const planDone = evs.find((e) => e.type === 'plan:done');
    const builds = plan.sections.map((s) => {
      const start = evs.find((e) => e.type === 'agent:start' && e.id === s.id && (e.reason || 'build') === 'build');
      const done = evs.find((e) => e.type === 'agent:done' && e.id === s.id && (e.reason || 'build') === 'build');
      return start && done ? { start: start.t, end: done.t, ms: done.ms ?? done.t - start.t, cost: done.cost } : null;
    }).filter(Boolean);
    const planMs = planDone ? planDone.t : 0;
    const buildStart = builds.length ? Math.min(...builds.map((b) => b.start)) : planMs;
    const buildEnd = builds.length ? Math.max(...builds.map((b) => b.end)) : planMs;
    const costs = evs.filter((e) => e.cost).map((e) => e.cost);
    const known = costs.length > 0 && costs.every((c) => c.usd != null);
    const tokens = costs.reduce((a, c) => ({ in: a.in + (c.in || 0), out: a.out + (c.out || 0) }), { in: 0, out: 0 });
    const sumMs = builds.reduce((a, b) => a + b.ms, 0);
    const buildWallMs = Math.max(1, buildEnd - buildStart);
    return {
      wallMs: evs.length ? evs[evs.length - 1].t : 0,
      planMs, buildWallMs, sumMs,
      speedup: builds.length ? +(sumMs / buildWallMs).toFixed(2) : null,
      sections: plan.sections.length,
      built: builds.length,
      failed: evs.filter((e) => e.type === 'agent:error').length,
      tokens: costs.length ? tokens : null,
      costUsd: known ? +costs.reduce((a, c) => a + c.usd, 0).toFixed(4) : null,
      outDir: this.dir,
      page: this.file('index.html'),
      ...extra,
    };
  }

  // ---------- comments ----------
  async comments() {
    return JSON.parse(await readFile(this.file('comments.json'), 'utf8').catch(() => '[]'));
  }

  async addComment({ section, target, text, path: elPath }) {
    const plan = await this.plan();
    if (!plan.sections.some((s) => s.id === section)) throw new Error('Unknown section.');
    const list = await this.comments();
    const c = {
      id: `c${list.length + 1}`,
      section,
      target: String(target || '').slice(0, 300),
      path: String(elPath || '').slice(0, 300),
      text: String(text || '').slice(0, 2000),
      status: 'open',
      at: Date.now(),
    };
    if (!c.text.trim()) throw new Error('Empty comment.');
    list.push(c);
    await writeFile(this.file('comments.json'), JSON.stringify(list, null, 2));
    await this.emit({ type: 'comment:add', comment: c });
    return c;
  }

  async resolveComments(ids, section) {
    if (!ids?.length) return [];
    const list = await this.comments();
    const done = [];
    for (const c of list) {
      if (ids.includes(c.id) && c.status === 'open' && (!section || c.section === section)) {
        c.status = 'resolved';
        c.resolvedAt = Date.now();
        done.push(c.id);
      }
    }
    await writeFile(this.file('comments.json'), JSON.stringify(list, null, 2));
    return done;
  }

  async mtime() {
    return (await stat(this.file('events.jsonl'))).mtimeMs;
  }
}
