// Turning section HTML into a finished page: sanitising, shared design tokens, the page document.
export const DEFAULT_THEME = {
  bg: '#fbfaf7', surface: '#f1eee6', card: '#ffffff', ink: '#1d1b18', muted: '#5d574e',
  accent: '#c2410c', accentInk: '#ffffff', accentSoft: '', dark: '#1f2430', darkInk: '#f5f3ee',
  line: '#e4dfd4', radius: '14px', font: 'Instrument Sans', headingFont: 'Instrument Serif',
};

export const DEFAULT_DESIGN = {
  direction: 'Calm, editorial layout with generous whitespace, one strong accent and clear hierarchy.',
  scale: { h1: '64px', h2: '42px', h3: '22px', body: '17px', small: '14px' },
  sectionY: '104px',
  maxWidth: '72rem',
  motifs: [],
  avoid: [],
};

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'page';
}

export const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const SAFE_SIZE = /^\d+(\.\d+)?(px|rem|em)$/;
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;
const SAFE_FONT = /^[\w\s-]{1,40}$/;

// Model output goes into CSS, so only accept values that look like what they claim to be.
export function normalizeTheme(t = {}) {
  const out = { ...DEFAULT_THEME };
  for (const k of Object.keys(DEFAULT_THEME)) {
    const v = t[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    const val = v.trim();
    if (k === 'radius' ? SAFE_SIZE.test(val) : k === 'font' || k === 'headingFont' ? SAFE_FONT.test(val) : SAFE_COLOR.test(val)) out[k] = val;
  }
  return out;
}

export function normalizeDesign(d = {}) {
  const out = structuredClone(DEFAULT_DESIGN);
  if (typeof d.direction === 'string') out.direction = d.direction.slice(0, 800);
  for (const k of Object.keys(out.scale)) if (SAFE_SIZE.test(d.scale?.[k] || '')) out.scale[k] = d.scale[k];
  if (SAFE_SIZE.test(d.sectionY || '')) out.sectionY = d.sectionY;
  if (SAFE_SIZE.test(d.maxWidth || '')) out.maxWidth = d.maxWidth;
  if (Array.isArray(d.motifs)) out.motifs = d.motifs.filter((x) => typeof x === 'string').slice(0, 8);
  if (Array.isArray(d.avoid)) out.avoid = d.avoid.filter((x) => typeof x === 'string').slice(0, 8);
  return out;
}

// Shared tokens plus a handful of sb-* classes, so every agent produces the same type scale, buttons and cards.
export function themeCSS(t, d = DEFAULT_DESIGN) {
  const s = d.scale;
  return `:root{--bg:${t.bg};--surface:${t.surface};--card:${t.card};--ink:${t.ink};--muted:${t.muted};--accent:${t.accent};--accent-ink:${t.accentInk};--accent-soft:${t.accentSoft || 'color-mix(in srgb, var(--accent) 14%, var(--bg))'};--dark:${t.dark};--dark-ink:${t.darkInk};--line:${t.line};--radius:${t.radius};--font:'${t.font}',system-ui,sans-serif;--heading-font:'${t.headingFont}','${t.font}',serif;--h1:${s.h1};--h2:${s.h2};--h3:${s.h3};--body:${s.body};--small:${s.small};--section-y:${d.sectionY};--max-w:${d.maxWidth}}
html{scroll-behavior:smooth}
body{font-family:var(--font);font-size:var(--body);line-height:1.6;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
.sb-wrap{max-width:var(--max-w);margin-inline:auto;padding-inline:24px}
.sb-section{padding-block:clamp(56px,9vw,var(--section-y))}
.sb-h1{font-family:var(--heading-font);font-size:clamp(calc(var(--h1)*.62),6.2vw,var(--h1));line-height:1.04;letter-spacing:-.02em;font-weight:600;text-wrap:balance}
.sb-h2{font-family:var(--heading-font);font-size:clamp(calc(var(--h2)*.7),4.4vw,var(--h2));line-height:1.12;letter-spacing:-.015em;font-weight:600;text-wrap:balance}
.sb-h3{font-family:var(--heading-font);font-size:var(--h3);line-height:1.3;font-weight:600}
.sb-lead{font-size:calc(var(--body)*1.18);line-height:1.55;color:var(--muted);text-wrap:pretty}
.sb-body{font-size:var(--body);line-height:1.6;color:var(--muted)}
.sb-small{font-size:var(--small);line-height:1.5;color:var(--muted)}
.sb-eyebrow{font-size:var(--small);font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.sb-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:44px;padding:.7rem 1.25rem;border-radius:calc(var(--radius)*.75);font-weight:600;font-size:var(--small);line-height:1;transition:transform .15s,background-color .15s,border-color .15s;cursor:pointer;text-decoration:none}
.sb-btn:hover{transform:translateY(-1px)}
.sb-btn:focus-visible,.sb-card a:focus-visible,a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sb-btn-primary{background:var(--accent);color:var(--accent-ink)}
.sb-btn-primary:hover{background:color-mix(in srgb,var(--accent) 88%,#000)}
.sb-btn-ghost{border:1px solid var(--line);color:var(--ink);background:transparent}
.sb-btn-ghost:hover{border-color:var(--ink)}
.sb-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius)}
.sb-dark{background:var(--dark);color:var(--dark-ink)}
.sb-dark .sb-body,.sb-dark .sb-lead,.sb-dark .sb-small{color:color-mix(in srgb,var(--dark-ink) 78%,transparent)}
.sb-dark .sb-eyebrow{color:color-mix(in srgb,var(--dark-ink) 72%,var(--accent-soft))}
.sb-dark .sb-btn-ghost{border-color:color-mix(in srgb,var(--dark-ink) 35%,transparent);color:var(--dark-ink)}
.sb-dark .sb-card{background:color-mix(in srgb,var(--dark-ink) 6%,var(--dark));border-color:color-mix(in srgb,var(--dark-ink) 18%,transparent);color:var(--dark-ink)}
.sb-input{width:100%;min-height:44px;padding:.65rem .85rem;border:1px solid var(--line);border-radius:calc(var(--radius)*.6);background:var(--card);color:var(--ink);font-size:var(--small)}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}`;
}

export function fontsHref(t) {
  const fams = [...new Set([t.font, t.headingFont])].filter(Boolean);
  return `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:ital,wght@0,400;0,500;0,600;0,700;1,400`).join('&')}&display=swap`;
}

export function sanitize(html, id) {
  let h = String(html).replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const start = h.search(/<section\b/i);
  const end = h.toLowerCase().lastIndexOf('</section>');
  if (start >= 0 && end > start) h = h.slice(start, end + 10);
  else {
    // A <footer>/<header>/<div> root, or a section cut off mid-way: keep the markup and wrap it.
    const body = h.replace(/^[\s\S]*?(?=<[a-z])/i, '').replace(/<\/?(html|head|body)\b[^>]*>/gi, '');
    h = `<section>${start >= 0 ? body.replace(/^<section\b[^>]*>/i, '') : body}</section>`;
  }
  h = h
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|iframe|object|embed|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|link|meta|base|frame|frameset)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(srcdoc|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|xlink:href)\s*=\s*(["'])\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1="#"')
    .replace(/<img\b(?![^>]*\bsrc\s*=\s*["']data:image\/)[^>]*>/gi, '')
    // Viewport-height units feed back into the auto-sized preview frame (vh = frame height), so turn them
    // into pixels for an 800px-tall screen. h-screen and friends become a fixed minimum.
    .replace(/\b(min-)?h-(screen|svh|dvh|lvh)\b/g, 'min-h-[680px]')
    .replace(/(\d+(?:\.\d+)?)[sdl]?vh\b/g, (_, n) => `${Math.round(Number(n) * 8)}px`);
  h = h.replace(/^<section\b([^>]*)>/i, (_, attrs) => {
    const clean = attrs.replace(/\s(id|data-section)\s*=\s*("[^"]*"|'[^']*')/gi, '');
    return `<section data-section="${id}" id="${id}"${clean}>`;
  });
  return h;
}

export function fallbackSection(s, message = 'This section failed to build. Run it again to retry.') {
  return `<section data-section="${s.id}" id="${s.id}" class="sb-section"><div class="sb-wrap"><h2 class="sb-h2">${escapeHTML(s.name)}</h2><p class="sb-body mt-2">${escapeHTML(message)}</p></div></section>`;
}

export function documentHTML(plan, sectionsHTML, { tailwind = true } = {}) {
  const t = plan.theme;
  return `<!doctype html>
<html lang="${escapeHTML(plan.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(plan.title)}</title>
${plan.description ? `<meta name="description" content="${escapeHTML(plan.description)}">\n` : ''}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fontsHref(t)}">
${tailwind ? '<script src="https://cdn.tailwindcss.com"></script>\n' : ''}<style>${themeCSS(t, plan.design)}</style>
</head>
<body>
${sectionsHTML.join('\n')}
</body>
</html>
`;
}
