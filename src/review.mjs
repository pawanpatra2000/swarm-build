// Design checks. Built-in rules are deterministic and run on every section.
// The Impeccable detector (Apache-2.0, github.com/pbakaus/impeccable) is optional and runs through npx.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BUZZWORDS = /\b(seamless(ly)?|unlock|elevate|revolutioni[sz]e|supercharge|game[- ]chang(er|ing)|cutting[- ]edge|next[- ]level|synerg(y|ies)|empower(ing)?|leverage)\b/i;
const FAKE_PROOF = /(\b\d[\d,.]*\s*(\+|k\+|m\+)?\s*(happy|satisfied)?\s*(customers|users|clients|patients|families|reviews)\b|★{3,}|\b[45](\.\d)?\s*\/\s*5\b|\btestimonial)/i;

export function checkSection(id, html, { isFirst, isLast, hero } = {}) {
  const f = [];
  const add = (message, severity = 'warning') => f.push({ source: 'swarm', id, severity, message });
  if (/\b(bg|text|border)-opacity-\d+/.test(html) || /\[var\(--[\w-]+\)\]\/\d+/.test(html)) add('Uses opacity modifiers on theme variables; these render as solid colour. Use bg-[var(--accent-soft)] or white/black alpha.', 'error');
  if (/lorem ipsum/i.test(html)) add('Contains lorem ipsum placeholder text.', 'error');
  if (BUZZWORDS.test(html.replace(/<[^>]+>/g, ' '))) add(`Buzzword in copy: "${html.replace(/<[^>]+>/g, ' ').match(BUZZWORDS)[0]}".`);
  if (FAKE_PROOF.test(html.replace(/<[^>]+>/g, ' '))) add('Looks like invented social proof (user counts, star ratings or testimonials).', 'error');
  const h1 = (html.match(/<h1\b/gi) || []).length;
  if (h1 > 0 && !hero) add('Has an <h1>; only the hero section should.', 'warning');
  if (hero && h1 === 0) add('Hero section has no <h1>.', 'warning');
  if (!isFirst && !isLast && !/<h[1-3]\b/i.test(html)) add('Section has no heading.', 'warning');
  const hexes = html.match(/\b(bg|text|border|from|to|via|fill|stroke)-\[#[0-9a-f]{3,8}\]/gi) || [];
  if (hexes.length > 2) add(`Hard-coded colours instead of theme variables (${[...new Set(hexes)].slice(0, 3).join(', ')}).`);
  const inputs = (html.match(/<(input|select|textarea)\b(?![^>]*type=["']?(hidden|submit|button))[^>]*>/gi) || []);
  const labels = (html.match(/<label\b/gi) || []).length + (html.match(/aria-label=/gi) || []).length;
  if (inputs.length > labels) add(`${inputs.length - labels} form field(s) without a label.`);
  if (/<button\b(?![^>]*\btype=)/i.test(html)) add('A <button> has no type attribute.', 'info');
  if (/\bw-\[(1[3-9]\d{2}|[2-9]\d{3})px\]/.test(html)) add('Fixed width over 1300px; will overflow on small screens.');
  if (!/sb-(wrap|section|h[1-3]|btn|card|body|lead)/.test(html)) add('Does not use the shared sb-* classes, so it may not match the other sections.', 'info');
  if (/(from-(purple|violet|indigo)-\d{3}.*to-(blue|pink|fuchsia)-\d{3})/.test(html)) add('Purple-to-blue gradient, a common generic AI look.', 'warning');
  return f;
}

export function checkPage(plan, sections) {
  const findings = [];
  plan.sections.forEach((s, i) => {
    const html = sections[s.id];
    if (!html) return findings.push({ source: 'swarm', id: s.id, severity: 'error', message: 'Section missing.' });
    findings.push(...checkSection(s.id, html, { isFirst: i === 0, isLast: i === plan.sections.length - 1, hero: i === 1 }));
  });
  // Same layout twice in a row: compare the grid signature of neighbours.
  const sig = (h) => (h.match(/\b(grid-cols-\d|md:grid-cols-\d|lg:grid-cols-\d|flex-row|md:flex-row)\b/g) || []).sort().join(' ');
  for (let i = 2; i < plan.sections.length - 1; i++) {
    const a = sections[plan.sections[i - 1].id] || '', b = sections[plan.sections[i].id] || '';
    if (sig(a) && sig(a) === sig(b) && (a.match(/sb-card/g) || []).length > 2 && (b.match(/sb-card/g) || []).length > 2) {
      findings.push({ source: 'swarm', id: plan.sections[i].id, severity: 'warning', message: `Repeats the card-grid layout of "${plan.sections[i - 1].id}".` });
    }
  }
  return findings;
}

// Runs `impeccable detect --json` on the page. Pass a URL when one is served: a rendered scan sees
// Tailwind's generated CSS, a file scan does not (padding and font-size rules then misfire).
export async function impeccableDetect(target, { timeout = 180000, viewport } = {}) {
  const args = ['-y', 'impeccable@4', 'detect', '--json', '--no-advisory', ...(viewport ? ['--viewport', viewport] : []), target];
  try {
    const { stdout } = await run('npx', args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    const list = JSON.parse(stdout.slice(stdout.indexOf('[')));
    return list.map((x) => ({ source: 'impeccable', severity: x.severity || 'warning', message: `${x.name}: ${x.snippet || x.description}`, rule: x.antipattern }));
  } catch (err) {
    // detect exits non-zero when it finds problems; the JSON is still on stdout
    if (err.stdout && err.stdout.includes('[')) {
      try {
        return JSON.parse(err.stdout.slice(err.stdout.indexOf('['))).map((x) => ({ source: 'impeccable', severity: x.severity || 'warning', message: `${x.name}: ${x.snippet || x.description}`, rule: x.antipattern }));
      } catch { /* fall through */ }
    }
    return [{ source: 'impeccable', severity: 'info', message: `Detector not run (${String(err.message).split('\n')[0].slice(0, 120)}).` }];
  }
}

export function formatFindings(findings) {
  if (!findings.length) return 'No findings.';
  return findings.map((f) => `- [${f.severity}] ${f.source}${f.id ? ` ${f.id}` : ''}: ${f.message}`).join('\n');
}
