// Standalone engine: this process calls the model itself.
// plan -> all sections in parallel -> design review -> rebuild flagged sections -> done.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { generateJSON, streamText, MODEL, PROVIDER, priceOf } from './llm.mjs';
import { PLANNER_SYSTEM, BUILDER_SYSTEM, REVIEW_SYSTEM, EDIT_SYSTEM, plannerPrompt, builderPrompt, reviewPrompt, editPrompt } from './prompts.mjs';
import { checkPage, impeccableDetect } from './review.mjs';
import { Run, MAX_SECTIONS } from './run.mjs';

function cost(usage = {}) {
  const price = priceOf();
  const c = { in: usage.in || 0, out: usage.out || 0 };
  c.usd = price ? (c.in * price[0] + c.out * price[1]) / 1e6 : null;
  return c;
}

// Loads a project design system: explicit file, else DESIGN.md / .impeccable/design.json in the working folder.
export async function loadDesignDoc(file) {
  const candidates = file ? [file] : ['DESIGN.md', 'design.md', '.impeccable/design.json'];
  for (const f of candidates) {
    const p = path.resolve(f);
    if (existsSync(p)) return { file: p, text: await readFile(p, 'utf8') };
  }
  return null;
}

async function buildOne(run, plan, section, { designDoc, reason = 'build' }) {
  const started = Date.now();
  await run.startAgent(section.id, { reason, note: section.fix });
  let last = 0;
  try {
    const { text, usage } = await streamText(
      { system: BUILDER_SYSTEM, prompt: builderPrompt(plan, section, { designDoc }), temperature: 0.8, maxTokens: 24000 },
      (_d, full) => {
        const now = Date.now();
        if (now - last > 250) { last = now; run.emit({ type: 'agent:progress', id: section.id, chars: full.length }); }
      },
    );
    return await run.submitSection(section.id, text, { started, cost: cost(usage), reason });
  } catch (err) {
    await run.emit({ type: 'agent:error', id: section.id, agent: section.agent, message: String(err.message || err) });
    return null;
  }
}

export async function runSwarm(brief, opts = {}) {
  const { maxSections = 6, theme, root = '.swarm', review = true, impeccable = false, designFile, name } = opts;
  const designDoc = (await loadDesignDoc(designFile))?.text;
  const run = opts.run || (await Run.create(brief, { root, mode: 'standalone', name }));
  if (opts.waitFor) await opts.waitFor;
  await run.emit({ type: 'meta', brief, model: MODEL, provider: PROVIDER, mode: 'standalone' });
  await run.emit({ type: 'plan:start' });

  const max = Math.min(Math.max(maxSections, 2), MAX_SECTIONS);
  const p0 = Date.now();
  const { value, usage } = await generateJSON({ system: PLANNER_SYSTEM, prompt: plannerPrompt(brief, { maxSections: max, designDoc }), temperature: 0.6, maxTokens: 6000 });
  const plan = await run.setPlan(value, { maxSections: max, theme, ms: Date.now() - p0, cost: cost(usage) });

  await Promise.all(plan.sections.map((s) => buildOne(run, plan, s, { designDoc })));

  if (review) await reviewAndFix(run, { designDoc, impeccable });
  const stats = await run.stats({ model: MODEL, provider: PROVIDER });
  await run.emit({ type: 'done', stats });
  return { run, plan, stats };
}

// Deterministic checks (+ optional Impeccable detector), then a model review, then parallel rebuilds of flagged sections.
export async function reviewAndFix(run, { designDoc, impeccable = false } = {}) {
  const plan = await run.plan();
  const sections = Object.fromEntries(await Promise.all(plan.sections.map(async (s) => [s.id, (await run.sectionHTML(s.id)) || ''])));
  await run.emit({ type: 'review:start' });
  const findings = checkPage(plan, sections);
  if (impeccable) findings.push(...(await impeccableDetect(run.file('index.html'))).filter((f) => f.severity !== 'info'));
  const r0 = Date.now();
  let fixes = [];
  let summary = '';
  try {
    const { value, usage } = await generateJSON({
      system: REVIEW_SYSTEM,
      prompt: reviewPrompt(plan, plan.sections.map((s) => ({ id: s.id, html: sections[s.id] })), findings),
      temperature: 0.3,
      maxTokens: 4000,
    });
    fixes = (value.fixes || []).filter((f) => plan.sections.some((s) => s.id === f.id)).slice(0, 3);
    summary = String(value.summary || '');
    await run.emit({ type: 'review:done', findings, fixes, summary, ms: Date.now() - r0, cost: cost(usage) });
  } catch (err) {
    await run.emit({ type: 'review:done', findings, fixes: [], summary: `Review failed: ${err.message}`, ms: Date.now() - r0 });
    return { findings, fixes: [] };
  }
  await Promise.all(fixes.map((f) => {
    const section = { ...plan.sections.find((s) => s.id === f.id), fix: `${f.problem} -> ${f.change}` };
    return buildOne(run, plan, section, { designDoc, reason: 'fix' });
  }));
  return { findings, fixes, summary };
}

// Applies open comments: one agent per commented section, all in parallel.
export async function applyComments(run, { designDoc } = {}) {
  const plan = await run.plan();
  const open = (await run.comments()).filter((c) => c.status === 'open');
  const bySection = new Map();
  for (const c of open) bySection.set(c.section, [...(bySection.get(c.section) || []), c]);
  await Promise.all([...bySection.entries()].map(async ([id, list]) => {
    const section = plan.sections.find((s) => s.id === id);
    const html = await run.sectionHTML(id);
    const started = Date.now();
    await run.startAgent(id, { reason: 'comment', note: list.map((c) => c.text).join(' / ') });
    try {
      const comment = { text: list.map((c, i) => `${i + 1}. ${c.text}${c.target ? ` (on: ${c.target})` : ''}`).join('\n') };
      const { text, usage } = await streamText({
        system: EDIT_SYSTEM + (designDoc ? `\n\nProject design system:\n${designDoc.slice(0, 6000)}` : ''),
        prompt: editPrompt(plan, section, html, comment), temperature: 0.6, maxTokens: 24000,
      }, () => {});
      await run.submitSection(id, text, { started, cost: cost(usage), reason: 'comment', resolves: list.map((c) => c.id) });
    } catch (err) {
      await run.emit({ type: 'agent:error', id, agent: section.agent, message: String(err.message || err) });
    }
  }));
  return bySection.size;
}
