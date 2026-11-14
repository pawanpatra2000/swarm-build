// MCP server over stdio (newline-delimited JSON-RPC 2.0). No SDK dependency.
// Gives any MCP-capable coding agent the same agent-mode workflow as the CLI.
import { createInterface } from 'node:readline';
import { Run } from './run.mjs';
import { VERSION, agentStart, planGuide, agentPlan, agentTask, agentCheck, agentStatus, agentDone } from './cli.mjs';
import { formatFindings } from './review.mjs';

const ROOT = process.env.SWARM_ROOT || '.swarm';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'swarm_start',
    description: 'Start a swarm-build run for a page brief. Opens the live preview and returns its URL plus the planning instructions. Call this first, show the URL to the user, then plan.',
    inputSchema: { type: 'object', properties: { brief: { type: 'string', description: 'Full page brief: sections and their content, brand colours/fonts, tone, language.' }, agent: { type: 'string', description: 'Your product name, shown in the preview.' } }, required: ['brief'] },
  },
  {
    name: 'swarm_plan',
    description: 'Save the page plan (design direction, theme, sections) written by following the swarm_start instructions. Returns one task per section; build them in parallel with sub-agents.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object', description: 'Plan JSON: title, description, lang, design, theme, voice, sections[].' } }, required: ['plan'] },
  },
  {
    name: 'swarm_task',
    description: 'Get the full build instructions for one section and mark its agent as started in the preview. Use fix for a rebuild after review, comments=true to apply user comments.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, fix: { type: 'string', description: 'What to change (rebuild after review).' }, comments: { type: 'boolean' } }, required: ['id'] },
  },
  {
    name: 'swarm_submit',
    description: 'Submit the finished HTML of one section (a single <section> element). The preview animates it in.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, html: { type: 'string' } }, required: ['id', 'html'] },
  },
  {
    name: 'swarm_check',
    description: 'Run design checks on the assembled page (built-in rules, optionally the Impeccable detector). Returns findings to decide which sections to fix.',
    inputSchema: { type: 'object', properties: { impeccable: { type: 'boolean' } } },
  },
  { name: 'swarm_comments', description: 'List open comments the user left in the preview, grouped by section.', inputSchema: { type: 'object', properties: {} } },
  { name: 'swarm_status', description: 'Show the run: page path, sections, which are missing, open comments.', inputSchema: { type: 'object', properties: {} } },
  { name: 'swarm_done', description: 'Mark the build finished. Shows the result card in the preview and returns timing.', inputSchema: { type: 'object', properties: {} } },
];

async function call(name, a = {}) {
  const current = () => Run.resolve(process.env.SWARM_RUN);
  switch (name) {
    case 'swarm_start': {
      const { run, url } = await agentStart({ brief: a.brief, root: ROOT, agent: a.agent });
      return `Run: ${run.dir}\nPreview (show this to the user): ${url}\n\n${planGuide(run)}\n\nWhen the plan is ready, call swarm_plan with it.`;
    }
    case 'swarm_plan': {
      const run = await current();
      const plan = await agentPlan(run, a.plan);
      return `Plan saved: ${plan.title}, ${plan.sections.length} sections.\nStart one sub-agent per section in a single message. Each calls swarm_task {id}, follows it, then swarm_submit {id, html}:\n${plan.sections.map((s) => `- ${s.id} (${s.agent.name}): ${s.name}`).join('\n')}\nWithout sub-agents, do them one after another.`;
    }
    case 'swarm_task': {
      const text = await agentTask(await current(), a.id, { fix: a.fix, comments: a.comments });
      return text.replace(/\n---\nWrite (only )?the[^\n]*$/, '\n---\nReturn the section by calling swarm_submit with {id, html}.');
    }
    case 'swarm_submit': {
      const run = await current();
      const r = await run.submitSection(a.id, a.html);
      const missing = await run.missingSections();
      return `Saved ${a.id} (${r.reason}). ${missing.length ? `Still missing: ${missing.join(', ')}` : 'All sections are in. Next: swarm_check, then swarm_done.'}`;
    }
    case 'swarm_check': return formatFindings(await agentCheck(await current(), { impeccable: a.impeccable }));
    case 'swarm_comments': {
      const open = (await (await current()).comments()).filter((c) => c.status === 'open');
      if (!open.length) return 'No open comments.';
      return JSON.stringify(open, null, 2) + '\n\nFor each section listed, call swarm_task {id, comments: true} (in parallel sub-agents), then swarm_submit.';
    }
    case 'swarm_status': return JSON.stringify(await agentStatus(await current()), null, 2);
    case 'swarm_done': {
      const st = await agentDone(await current());
      return `Built ${st.built}/${st.sections} sections. Parallel ${(st.buildWallMs / 1000).toFixed(1)}s vs one-by-one ${(st.sumMs / 1000).toFixed(1)}s (${st.speedup ?? '-'}x). Page: ${st.page}`;
    }
    default: throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }
}

export function serve() {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const { id, method, params } = msg;
    const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize') {
        const v = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
        return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'swarm-build', version: VERSION }, instructions: 'Build web pages in parallel: swarm_start -> swarm_plan -> parallel swarm_task/swarm_submit per section -> swarm_check -> swarm_done. Show the preview URL to the user.' });
      }
      if (method === 'ping') return reply({});
      if (method === 'tools/list') return reply({ tools: TOOLS });
      if (method === 'tools/call') {
        try {
          const text = await call(params?.name, params?.arguments || {});
          return reply({ content: [{ type: 'text', text }] });
        } catch (err) {
          if (err.code === -32602) return fail(-32602, err.message);
          return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
      }
      if (method?.startsWith('notifications/')) return;
      fail(-32601, `Method not found: ${method}`);
    } catch (err) {
      fail(-32603, String(err.message || err));
    }
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
