// Minimal Gemini-on-Vertex client: one JSON call and one streaming text call.
// Auth comes from the local gcloud login, so no API key lives in this repo.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const MODEL = process.env.SWARM_MODEL || 'gemini-3.5-flash';
const LOCATION = process.env.SWARM_LOCATION || 'global';

let cached = { token: null, at: 0 };
let thinkingSupported = true;

async function project() {
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT;
  const { stdout } = await run('gcloud', ['config', 'get-value', 'project']).catch(() => ({ stdout: '' }));
  const p = stdout.trim();
  if (!p || p === '(unset)') throw new Error('Set GCP_PROJECT (no gcloud default project found).');
  return p;
}

async function token() {
  if (cached.token && Date.now() - cached.at < 40 * 60 * 1000) return cached.token;
  const { stdout } = await run('gcloud', ['auth', 'print-access-token']);
  cached = { token: stdout.trim(), at: Date.now() };
  return cached.token;
}

async function endpoint(method) {
  const p = await project();
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${p}/locations/${LOCATION}/publishers/google/models/${MODEL}:${method}`;
}

function body({ system, prompt, json, temperature = 0.7, maxTokens = 8192 }) {
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (json) generationConfig.responseMimeType = 'application/json';
  if (thinkingSupported) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  return {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  };
}

// POST with retry on 429/5xx and a one-time fallback if the model rejects thinkingConfig.
async function post(method, opts, attempt = 0) {
  const res = await fetch(await endpoint(method), {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body(opts)),
  });
  if (res.ok) return res;
  const text = await res.text();
  if (res.status === 400 && thinkingSupported && /thinking/i.test(text)) {
    thinkingSupported = false;
    return post(method, opts, attempt);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    return post(method, opts, attempt + 1);
  }
  throw new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
}

const textOf = (data) =>
  (data?.candidates?.[0]?.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');

export async function generateJSON(opts) {
  const res = await post('generateContent', { ...opts, json: true });
  const data = await res.json();
  const raw = textOf(data).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return { value: JSON.parse(raw), usage: data.usageMetadata || {} };
}

// Streams text deltas to onDelta(chunk, fullSoFar). Resolves with the full text and token usage.
export async function streamText(opts, onDelta = () => {}) {
  const res = await post('streamGenerateContent?alt=sse', opts);
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let usage = {};
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      if (data.usageMetadata) usage = data.usageMetadata;
      const delta = textOf(data);
      if (delta) {
        full += delta;
        onDelta(delta, full);
      }
    }
  }
  return { text: full, usage };
}
