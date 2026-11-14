// HTML -> JSX conversion (used by the framework exporters) and the single-file shareable replay.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RENAME = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength',
  colspan: 'colSpan', rowspan: 'rowSpan', autocomplete: 'autoComplete', autofocus: 'autoFocus', crossorigin: 'crossOrigin',
  enctype: 'encType', srcset: 'srcSet', datetime: 'dateTime', novalidate: 'noValidate', inputmode: 'inputMode',
  spellcheck: 'spellCheck', contenteditable: 'contentEditable', 'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace',
  'xmlns:xlink': 'xmlnsXlink', viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', checked: 'defaultChecked',
};
const camel = (s) => s.replace(/[-:]([a-z])/g, (_, c) => c.toUpperCase());
// React types these as numbers; a string literal fails type-checking in TypeScript projects.
const NUMERIC = new Set(['tabIndex', 'colSpan', 'rowSpan', 'maxLength', 'minLength', 'rows', 'cols', 'size', 'span', 'start']);
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function styleObject(css) {
  const pairs = css.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':');
    if (i < 0) return null;
    const k = d.slice(0, i).trim();
    const v = d.slice(i + 1).trim().replace(/'/g, "\\'");
    const key = k.startsWith('--') ? `'${k}'` : camel(k.toLowerCase());
    return `${key}: '${v}'`;
  }).filter(Boolean);
  return `{{ ${pairs.join(', ')} }}`;
}

function attrsToJSX(tag, raw) {
  const out = [];
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1];
    const has = m[2] !== undefined;
    const val = m[3] ?? m[4] ?? m[5] ?? '';
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) continue; // never emit handlers
    let key = RENAME[lower] || (lower.startsWith('data-') || lower.startsWith('aria-') ? lower : name.includes('-') || name.includes(':') ? camel(name) : name);
    if (lower === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) key = 'defaultValue';
    if (lower === 'selected') continue; // React wants defaultValue on <select>; drop to avoid a warning
    if (lower === 'style') { out.push(`style=${styleObject(val)}`); continue; }
    if (!has) { out.push(key); continue; }
    if (NUMERIC.has(key) && /^-?\d+$/.test(val.trim())) { out.push(`${key}={${val.trim()}}`); continue; }
    out.push(`${key}=${JSON.stringify(val)}`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}

export function htmlToJSX(html) {
  let out = '';
  let last = 0;
  for (const m of html.matchAll(TAG)) {
    out += textToJSX(html.slice(last, m.index));
    last = m.index + m[0].length;
    const [, close, tag, attrs, selfClose] = m; // tag case is kept so SVG tags like linearGradient survive
    if (close) { if (!VOID.has(tag.toLowerCase())) out += `</${tag}>`; continue; }
    const jsxAttrs = attrsToJSX(tag.toLowerCase(), attrs);
    out += VOID.has(tag.toLowerCase()) || selfClose ? `<${tag}${jsxAttrs} />` : `<${tag}${jsxAttrs}>`;
  }
  out += textToJSX(html.slice(last));
  return out;
}

const textToJSX = (t) => t.replace(/[{}]/g, (c) => `{'${c}'}`);

const inlineJSON = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export async function exportShare(run, outFile) {
  const [html, cssText, js] = await Promise.all(['index.html', 'swarm.css', 'swarm.js'].map((f) => readFile(path.join(PKG, 'preview', f), 'utf8')));
  let n = 0;
  const events = (await run.events()).filter((e) => e.type !== 'agent:progress' || n++ % 3 === 0); // thin out progress ticks
  const page = await readFile(run.file('index.html'), 'utf8').catch(() => '');
  const file = path.resolve(outFile || run.file('share.html'));
  const out = html
    .replace('<link rel="stylesheet" href="swarm.css">', () => `<style>${cssText}</style>`)
    .replace('<script src="swarm.js"></script>', () => `<script>window.__SWARM_EMBED__=${inlineJSON({ events, page })};</script>\n<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
  await writeFile(file, out);
  return { file, bytes: Buffer.byteLength(out) };
}
