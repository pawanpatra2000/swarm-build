// plan -> parallel section builders -> assemble. Every step is emitted as an event
// so the preview (or any other listener) can visualise the run.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateJSON, streamText, MODEL } from './llm.mjs';

export const AGENTS = [
  { name: 'Ada', color: '#e4572e' },
  { name: 'Linus', color: '#2e86ab' },
  { name: 'Grace', color: '#7b2cbf' },
  { name: 'Alan', color: '#2a9d8f' },
  { name: 'Margaret', color: '#d4a017' },
  { name: 'Dennis', color: '#c2185b' },
];

// USD per 1M tokens (Gemini 3.5 Flash on Vertex AI). Thinking tokens bill as output.
const PRICE_IN = Number(process.env.SWARM_PRICE_IN || 1.5);
const PRICE_OUT = Number(process.env.SWARM_PRICE_OUT || 9);

const DEFAULT_THEME = {
  bg: '#ffffff', surface: '#f5f5f4', ink: '#1c1917', muted: '#57534e',
  accent: '#2563eb', accentInk: '#ffffff', accentSoft: '', dark: '#111827', darkInk: '#f9fafb',
  line: '#e7e5e4', radius: '14px',
  font: 'Inter', headingFont: 'Inter',
};

const PLANNER_SYSTEM = `You are the lead designer of a small UI build team. Split the requested page into sections that separate engineers can build at the same time without talking to each other.
Return JSON only:
{"title": string, "theme": {"bg","surface","ink","muted","accent","accentInk","accentSoft" (pale tint of accent),"dark" (one deep contrast colour),"darkInk" (text on dark),"line": hex colours, "radius": css length, "font": Google Font family, "headingFont": Google Font family},
 "voice": one sentence describing tone and copy style,
 "sections": [{"id": kebab-case, "name": short label, "brief": 2-4 sentences: purpose, exact content to include, layout, "height": "short"|"medium"|"tall"}]}
Rules: first section is the site header/nav, last is the footer. Each brief must be self-contained (the builder only sees its own brief plus the shared theme and voice). Name the real content each section shows. Never ask for testimonials, ratings, user counts or other invented proof. If the request gives brand colours or fonts, use them exactly.`;

const BUILDER_SYSTEM = `You are a senior front-end engineer on a parallel build team. You build exactly ONE section of a page with HTML and Tailwind CSS (Play CDN, so arbitrary values work).
Output rules:
- Output only HTML: a single <section data-section="ID" id="ID"> ... </section>. No markdown fences, no <html>, <head>, <script> or <style>.
- Colours come only from the shared theme variables: bg-[var(--bg)], bg-[var(--surface)], text-[var(--ink)], text-[var(--muted)], bg-[var(--accent)], text-[var(--accent)], text-[var(--accent-ink)], bg-[var(--accent-soft)] (pale accent tint), bg-[var(--dark)] with text-[var(--dark-ink)] for a dark band, border-[var(--line)], rounded-[var(--radius)]. Headings use font-[family-name:var(--heading-font)].
- Never use opacity modifiers on variable colours (bg-opacity-*, bg-[var(--x)]/10, text-opacity-*); they do not work. For tints use bg-[var(--accent-soft)]. For translucent white or black on dark bands use bg-white/10, text-white/70.
- Wrap content in max-w-6xl mx-auto px-6. Mobile-first and responsive (sm:/md:/lg:).
- No external images. Use inline SVG for icons and illustrations.
- Real, specific copy that fits the brief. No lorem ipsum. No testimonials, star ratings, user counts or other invented proof.
- Links to other sections use href="#section-id". Buttons are <a> or <button type="button">.
- Accessible: semantic tags, alt/aria-label where needed, sufficient contrast.`;

export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'page';
}

function cost(usage) {
  const inT = usage.promptTokenCount || 0;
  const outT = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  return { in: inT, out: outT, usd: (inT * PRICE_IN + outT * PRICE_OUT) / 1e6 };
}

export function sanitize(html, id) {
  let h = html.replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const start = h.search(/<section\b/i);
  const end = h.toLowerCase().lastIndexOf('</section>');
  h = start >= 0 && end > start ? h.slice(start, end + 10) : `<section>${h}</section>`;
  h = h
    .replace(/<(script|iframe|object|embed|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\s on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|formaction)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/<img\b(?![^>]*\bsrc\s*=\s*["']data:)[^>]*>/gi, '');
  // Force the root section to carry the right id / data-section.
  h = h.replace(/^<section\b([^>]*)>/i, (_, attrs) => {
    const clean = attrs.replace(/\s(id|data-section)\s*=\s*("[^"]*"|'[^']*')/gi, '');
    return `<section data-section="${id}" id="${id}"${clean}>`;
  });
  return h;
}

function fallbackSection(s) {
  return `<section data-section="${s.id}" id="${s.id}" class="py-16 bg-[var(--surface)]"><div class="max-w-6xl mx-auto px-6"><h2 class="text-2xl font-semibold text-[var(--ink)]">${s.name}</h2><p class="mt-2 text-[var(--muted)]">This section failed to build. Re-run to try again.</p></div></section>`;
}

export function documentHTML(plan, sectionsHTML) {
  const t = plan.theme;
  const fonts = [...new Set([t.font, t.headingFont])]
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700`)
    .join('&');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(plan.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fonts}&display=swap">
<script src="https://cdn.tailwindcss.com"></script>
<style>${themeCSS(t)}</style>
</head>
<body class="bg-[var(--bg)] text-[var(--ink)] antialiased">
${sectionsHTML.join('\n')}
</body>
</html>
`;
}

export function themeCSS(t) {
  return `:root{--bg:${t.bg};--surface:${t.surface};--ink:${t.ink};--muted:${t.muted};--accent:${t.accent};--accent-ink:${t.accentInk};--accent-soft:${t.accentSoft || 'color-mix(in srgb, var(--accent) 14%, transparent)'};--dark:${t.dark};--dark-ink:${t.darkInk};--line:${t.line};--radius:${t.radius};--font:'${t.font}',system-ui,sans-serif;--heading-font:'${t.headingFont}',var(--font)}
html{scroll-behavior:smooth}body{font-family:var(--font)}`;
}

const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export async function plan(brief, { maxSections = 6, theme } = {}) {
  const prompt = `Page request:\n${brief}\n\nUse between 4 and ${Math.min(Math.max(maxSections, 2), 6)} sections.`;
  const { value, usage } = await generateJSON({ system: PLANNER_SYSTEM, prompt, temperature: 0.5 });
  const sections = (value.sections || []).slice(0, Math.min(maxSections, AGENTS.length));
  if (sections.length < 2) throw new Error('Planner returned fewer than 2 sections.');
  const seen = new Set();
  for (const s of sections) {
    s.id = slugify(s.id || s.name);
    while (seen.has(s.id)) s.id += '-2';
    seen.add(s.id);
    s.height = ['short', 'medium', 'tall'].includes(s.height) ? s.height : 'medium';
  }
  return {
    plan: {
      title: value.title || 'Untitled page',
      theme: { ...DEFAULT_THEME, ...(value.theme || {}), ...(theme || {}) },
      voice: value.voice || 'Clear, direct and friendly.',
      sections,
    },
    usage,
  };
}

async function buildSection(s, p, emit) {
  const others = p.sections.map((x) => `${x.id} (${x.name})`).join(', ');
  const prompt = `Page: ${p.title}\nVoice: ${p.voice}\nAll sections on the page (for anchor links only): ${others}\n\nYour section ID: ${s.id}\nName: ${s.name}\nHeight: ${s.height}\nBrief: ${s.brief}`;
  let lastEmit = 0;
  const { text, usage } = await streamText(
    { system: BUILDER_SYSTEM, prompt, temperature: 0.8, maxTokens: 12000 },
    (_d, full) => {
      const now = Date.now();
      if (now - lastEmit > 200) {
        lastEmit = now;
        emit({ type: 'agent:progress', id: s.id, chars: full.length });
      }
    },
  );
  return { html: sanitize(text, s.id), usage };
}

// Runs the whole pipeline. emit(event) is called for every step; events get a `t` (ms since start).
export async function runSwarm(brief, { maxSections = 6, theme, outRoot = 'out', emit: sink = () => {} } = {}) {
  const t0 = Date.now();
  const events = [];
  const emit = (e) => {
    const ev = { t: Date.now() - t0, ...e };
    events.push(ev);
    sink(ev);
  };

  emit({ type: 'meta', brief, model: MODEL, agents: AGENTS });
  emit({ type: 'plan:start' });
  const { plan: p, usage: planUsage } = await plan(brief, { maxSections, theme });
  const planMs = Date.now() - t0;
  emit({ type: 'plan:done', plan: p, ms: planMs, cost: cost(planUsage) });

  const results = await Promise.all(
    p.sections.map(async (s, i) => {
      const agent = AGENTS[i % AGENTS.length];
      const start = Date.now();
      emit({ type: 'agent:start', id: s.id, agent });
      try {
        const { html, usage } = await buildSection(s, p, emit);
        const r = { id: s.id, html, ms: Date.now() - start, cost: cost(usage) };
        emit({ type: 'agent:done', ...r, agent });
        return r;
      } catch (err) {
        emit({ type: 'agent:error', id: s.id, agent, message: String(err.message || err) });
        return { id: s.id, html: fallbackSection(s), ms: Date.now() - start, cost: cost({}), failed: true };
      }
    }),
  );

  const outDir = path.join(outRoot, `${slugify(p.title)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`);
  await mkdir(path.join(outDir, 'sections'), { recursive: true });
  await Promise.all(results.map((r) => writeFile(path.join(outDir, 'sections', `${r.id}.html`), r.html)));
  await writeFile(path.join(outDir, 'index.html'), documentHTML(p, results.map((r) => r.html)));
  await writeFile(path.join(outDir, 'plan.json'), JSON.stringify(p, null, 2));

  const wallMs = Date.now() - t0;
  const buildWallMs = wallMs - planMs;
  const sumMs = results.reduce((a, r) => a + r.ms, 0);
  const total = [cost(planUsage), ...results.map((r) => r.cost)].reduce(
    (a, c) => ({ in: a.in + c.in, out: a.out + c.out, usd: a.usd + c.usd }),
    { in: 0, out: 0, usd: 0 },
  );
  const stats = {
    wallMs, planMs, buildWallMs, sumMs,
    speedup: +(sumMs / Math.max(buildWallMs, 1)).toFixed(2),
    sections: results.length, failed: results.filter((r) => r.failed).length,
    tokens: { in: total.in, out: total.out }, costUsd: +total.usd.toFixed(4),
    outDir, model: MODEL,
  };
  emit({ type: 'done', stats });
  await writeFile(path.join(outDir, 'run.json'), JSON.stringify({ brief, stats, events }, null, 2));
  return { plan: p, results, stats, outDir };
}
