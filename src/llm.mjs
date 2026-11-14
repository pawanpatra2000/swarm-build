// Model client for standalone mode. One JSON call and one streaming text call per provider.
// Provider is picked from env: SWARM_PROVIDER, or the first key found
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY), else Vertex AI through the local gcloud login.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const DEFAULTS = {
  anthropic: { model: 'claude-sonnet-4-5', price: [3, 15] },
  openai: { model: 'gpt-5', price: [1.25, 10] },
  gemini: { model: 'gemini-3.5-flash', price: [1.5, 9] },
  vertex: { model: 'gemini-3.5-flash', price: [1.5, 9] },
};

export function providerName() {
  const p = process.env.SWARM_PROVIDER;
  if (p) {
    if (!DEFAULTS[p]) throw new Error(`Unknown SWARM_PROVIDER "${p}". Use anthropic, openai, gemini or vertex.`);
    return p;
  }
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini';
  return 'vertex';
}

export const PROVIDER = providerName();
export const MODEL = process.env.SWARM_MODEL || DEFAULTS[PROVIDER].model;

// USD per 1M tokens. Only the defaults are known; a custom model needs SWARM_PRICE_IN / SWARM_PRICE_OUT.
export function priceOf() {
  if (process.env.SWARM_PRICE_IN && process.env.SWARM_PRICE_OUT) return [Number(process.env.SWARM_PRICE_IN), Number(process.env.SWARM_PRICE_OUT)];
  return MODEL === DEFAULTS[PROVIDER].model ? DEFAULTS[PROVIDER].price : null;
}

// ---------- shared helpers ----------
async function* sseLines(res) {
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return undefined;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return undefined;
    try { return JSON.parse(payload); } catch { return undefined; } // partial or non-JSON line
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const data = parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (data !== undefined) yield data;
    }
  }
  // The last event may arrive without a trailing newline; dropping it cuts the section off mid-sentence.
  buf += decoder.decode();
  const last = parse(buf);
  if (last !== undefined) yield last;
}

async function postWithRetry(makeRequest, attempt = 0) {
  const res = await makeRequest();
  if (res.ok) return res;
  const text = await res.text();
  if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    return postWithRetry(makeRequest, attempt + 1);
  }
  const err = new Error(`${PROVIDER} ${res.status}: ${text.slice(0, 400)}`);
  err.status = res.status;
  err.body = text;
  throw err;
}

export function parseJSON(text) {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error(`Model did not return JSON: ${t.slice(0, 200)}`);
  }
}

// ---------- Google (Vertex AI and Gemini API share the request shape) ----------
let cachedToken = { token: null, at: 0 };
let thinkingSupported = true;

async function gcpProject() {
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT;
  const { stdout } = await run('gcloud', ['config', 'get-value', 'project']).catch(() => ({ stdout: '' }));
  const p = stdout.trim();
  if (!p || p === '(unset)') throw new Error('Vertex AI needs GCP_PROJECT (or set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY).');
  return p;
}

async function gcpToken() {
  if (cachedToken.token && Date.now() - cachedToken.at < 40 * 60 * 1000) return cachedToken.token;
  const { stdout } = await run('gcloud', ['auth', 'print-access-token']);
  cachedToken = { token: stdout.trim(), at: Date.now() };
  return cachedToken.token;
}

async function googleRequest(method, { system, prompt, json, temperature = 0.7, maxTokens = 8192 }) {
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (json) generationConfig.responseMimeType = 'application/json';
  if (thinkingSupported) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  const body = JSON.stringify({
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });
  let url, headers;
  if (PROVIDER === 'vertex') {
    const loc = process.env.SWARM_LOCATION || 'global';
    const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
    url = `https://${host}/v1/projects/${await gcpProject()}/locations/${loc}/publishers/google/models/${MODEL}:${method}`;
    headers = { Authorization: `Bearer ${await gcpToken()}`, 'Content-Type': 'application/json' };
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:${method}`;
    headers = { 'x-goog-api-key': process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, 'Content-Type': 'application/json' };
  }
  try {
    return await postWithRetry(() => fetch(url, { method: 'POST', headers, body }));
  } catch (err) {
    if (err.status === 400 && thinkingSupported && /thinking/i.test(err.body || '')) {
      thinkingSupported = false; // older model: retry without thinkingConfig
      return googleRequest(method, { system, prompt, json, temperature, maxTokens });
    }
    throw err;
  }
}

const googleText = (data) =>
  (data?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
const googleUsage = (u = {}) => ({ in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) });

// ---------- providers: each returns an async iterator of { delta?, usage? } ----------
async function* streamGoogle(opts) {
  const res = await googleRequest('streamGenerateContent?alt=sse', opts);
  for await (const data of sseLines(res)) {
    yield { delta: googleText(data), usage: data.usageMetadata ? googleUsage(data.usageMetadata) : undefined };
  }
}

async function* streamOpenAI({ system, prompt, json, maxTokens = 8192 }) {
  const body = {
    model: MODEL,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: maxTokens * 2, // reasoning tokens count against this limit
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
  };
  if (json) body.response_format = { type: 'json_object' };
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const res = await postWithRetry(() => fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  for await (const data of sseLines(res)) {
    const delta = data.choices?.[0]?.delta?.content || '';
    const u = data.usage;
    yield { delta, usage: u ? { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 } : undefined };
  }
}

async function* streamAnthropic({ system, prompt, json, temperature = 0.7, maxTokens = 8192 }) {
  const res = await postWithRetry(() => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system: json ? `${system || ''}\nReturn only a JSON object, no prose and no code fences.` : system,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  }));
  const usage = { in: 0, out: 0 };
  for await (const data of sseLines(res)) {
    if (data.type === 'message_start') usage.in = data.message?.usage?.input_tokens || 0;
    if (data.type === 'message_delta') usage.out = data.usage?.output_tokens || usage.out;
    const delta = data.type === 'content_block_delta' && data.delta?.type === 'text_delta' ? data.delta.text : '';
    yield { delta, usage: { ...usage } };
  }
}

function stream(opts) {
  if (PROVIDER === 'openai') return streamOpenAI(opts);
  if (PROVIDER === 'anthropic') return streamAnthropic(opts);
  return streamGoogle(opts);
}

// Streams text deltas to onDelta(chunk, fullSoFar). Resolves with { text, usage: { in, out } }.
export async function streamText(opts, onDelta = () => {}) {
  let text = '';
  let usage = { in: 0, out: 0 };
  for await (const part of stream(opts)) {
    if (part.usage) usage = part.usage;
    if (part.delta) {
      text += part.delta;
      onDelta(part.delta, text);
    }
  }
  return { text, usage };
}

export async function generateJSON(opts) {
  const { text, usage } = await streamText({ ...opts, json: true });
  return { value: parseJSON(text), usage };
}
