# swarm-build

Describe a page. A planner sets the design direction and splits the page into sections. One agent per section builds its part **at the same time**, and a live preview shows each agent's cursor assembling the real UI. Then you click anything on the page to leave a comment, and only that section gets rebuilt.

It works two ways:

- **Inside any coding agent** (Claude Code, Codex, Cursor, Kiro, T3 Code, or anything with a shell or MCP). Your agent does the thinking with its own model and its sub-agents build the sections. **No API key.**
- **Standalone.** swarm-build calls a model itself (Claude, OpenAI, Gemini or Vertex AI).

The finished page goes straight into your project's framework: Next.js, React, Vue, Nuxt, Svelte, SvelteKit, Astro or plain HTML.

## Zero install: tell any agent

Paste this into any coding agent that can run shell commands:

> Run `npx -y swarm-build guide` and follow it to swarm build a landing page for a yoga studio in Goa.

The guide is the full workflow. The agent starts the live preview, plans, starts sub-agents in parallel, reviews the result and exports the page into your framework.

## Quickstart: inside your coding agent

```bash
npx swarm-build init            # detects Claude Code / Codex / Cursor / Kiro and installs the skill
npx swarm-build init --mcp      # also registers the MCP server
npx swarm-build init --design   # also installs Impeccable and UI UX Pro Max design skills
```

Then tell your agent: **"swarm build a landing page for a yoga studio in Goa"**. It will:

1. Start a run and give you a preview URL. Open it and watch.
2. Plan the design direction, theme, type scale and sections.
3. Start one sub-agent per section, all in parallel.
4. Run design checks and fix weak sections.
5. Ask you to comment. Click anything in the preview, then say "apply the swarm comments".

What `init` writes:

| Agent | Files |
|---|---|
| Claude Code | `.claude/skills/swarm-build/SKILL.md`, `.claude/agents/swarm-section-builder.md`, `.mcp.json` with `--mcp` |
| Codex | `.agents/skills/swarm-build/SKILL.md`; with `--mcp` it prints the `codex mcp add` command |
| Cursor | `.cursor/rules/swarm-build.mdc`, `.cursor/mcp.json` with `--mcp` |
| Kiro | `.kiro/skills/swarm-build/SKILL.md`, `.kiro/settings/mcp.json` with `--mcp` |
| Any agent that reads AGENTS.md | a short `swarm-build` block in `AGENTS.md` (`--agent agents-md`) |

Add `--agent claude,codex` to choose agents and `--global` to install for your user instead of the project. `.swarm/` is added to `.gitignore`.

## Quickstart: standalone

```bash
export ANTHROPIC_API_KEY=...     # or OPENAI_API_KEY, GEMINI_API_KEY, or gcloud + GCP_PROJECT for Vertex AI
npx swarm-build run "Landing page for a Pune bakery: menu, hours, order form" --open
npx swarm-build run --brief-file brief.txt --impeccable --open
```

The build starts when the preview opens (`--now` to start right away, `--headless` for no preview). The server stays up afterwards so comments can be applied. Click **Apply comments** in the preview.

Options:

- `--sections N`: 2 to 8.
- `--theme theme.json`: forces brand tokens.
- `--design-file DESIGN.md`: your design system. A `DESIGN.md` in the folder is used automatically.
- `--no-review`: skips the review step.
- `--impeccable`: adds the Impeccable detector to the review.
- `SWARM_PROVIDER` and `SWARM_MODEL` pick the model. Use `SWARM_PRICE_IN` and `SWARM_PRICE_OUT` for cost display with other models.

## The preview

- The **Planner** cursor picks a direction. Then each agent gets a dashed slot and a live character count.
- When a section lands, its agent drags out the boxes (with size badges), types the text and draws the SVGs.
- The **Reviewer** scans the page. Sections it flags are rebuilt by their own agent.
- **Desktop / Mobile** toggle: the stage is an iframe, so Tailwind breakpoints are real.
- **Comment** (or press `C`): click any element and write what should change. Pins stay on the element.
- **Replay** at 1×, 2× or 3×. Long idle gaps are squeezed to 3 s. **Go live** hides the cursors.

## Agent-mode commands

These are the commands the skill uses; you can run them by hand too.

```
swarm-build start --brief-file brief.txt --agent "Claude Code"
swarm-build guide plan                 # design principles + plan JSON shape
swarm-build plan .swarm/plan.json      # prints one task per section
swarm-build task <id> [--fix "..."] [--comments]
swarm-build submit <id> .swarm/out/<id>.html
swarm-build check --impeccable
swarm-build comments | status | done
```

MCP tools (`swarm-build mcp`): `swarm_start`, `swarm_plan`, `swarm_task`, `swarm_submit`, `swarm_check`, `swarm_comments`, `swarm_status`, `swarm_done`, `swarm_export`.

## Framework output

The agents build sections as HTML + Tailwind, because that's what the live preview animates. At the end the page is converted into your framework:

```bash
swarm-build export auto --into .              # detect from package.json
swarm-build export next --into . --route yoga # or pick one
```

| Target | Page | Sections |
|---|---|---|
| Next.js (App Router) | `app/<route>/page.tsx` | `components/swarm/<slug>/*.tsx` |
| React (Vite etc.) | `src/swarm/<slug>/Page.tsx` | `src/swarm/<slug>/components/*.tsx` |
| Vue | `components/swarm/<slug>/Page.vue` | `*.vue` |
| Nuxt | `pages/<route>.vue` | `components/swarm/<slug>/*.vue` |
| Svelte / SvelteKit | `src/routes/<route>/+page.svelte` (Kit) | `src/lib/swarm/<slug>/*.svelte` |
| Astro | `src/pages/<route>.astro` | `src/components/swarm/<slug>/*.astro` |
| HTML | `public/<slug>.html` | |

How it handles the details:
- Uses TypeScript if the project does, and the `@/` alias if it's configured.
- Never overwrites a file without `--force`.
- The theme CSS is scoped to `.swarm-page`, so it doesn't restyle the rest of your app.
- Needs Tailwind v4, or v3.3 and later. On v3, add the generated folder to `content`.

Tested:
- A real Next.js 16 + Tailwind 4 app: `next build` passes and the route renders with the right fonts and theme.
- Vue, Svelte and Astro exports: every file compiles with the official compilers.

Forms and buttons come without handlers; wire them to your app.

## Output and exports

Each run is a folder `.swarm/<run>/`:

- `index.html`: the page.
- `sections/*.html`: one file per section.
- `plan.json`: the plan.
- `events.jsonl`: the timeline.
- `comments.json`: comments from the preview.

Other exports:

- `swarm-build export share`: one HTML file that replays the build in any browser, no server.
- `swarm-build replay [run-dir] --open`: replays a saved run with its original timing.

## Design quality

- **Built-in principles**: one committed direction, a real type scale, one accent, varied layouts, concrete copy, no invented proof, accessible forms. All agents get the same principles.
- **Shared tokens and `sb-*` classes**: every section uses the same type scale, buttons, cards and spacing, which keeps parallel work consistent.
- **Review**:
  - Deterministic checks: opacity-on-variables bug, hard-coded colours, buzzwords, fake proof, heading structure, unlabelled fields, repeated layouts.
  - Optional [Impeccable](https://github.com/pbakaus/impeccable) detector, run on the rendered page.
  - A model review that picks at most 3 sections to rebuild.
- **Your design system**: `DESIGN.md` in the project overrides the defaults.
- `init --design` installs Impeccable (Apache-2.0) and [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) (MIT) with their own installers, so your agent can use them while planning.

## Measured

| Run | Planning | Parallel build | One after another | Speed-up | Cost |
|---|---|---|---|---|---|
| Standalone, Gemini 3.5 Flash, 6 sections + review | 22.4 s | 17.4 s | 77.4 s | 4.5× | $0.32 |
| Agent mode, 6 sub-agents (yoga studio) | done by the agent | 54.2 s | 134.4 s | 2.5× | your agent's plan |

Sub-agents are slower per section than direct model calls, because each one is a full agent that reads its instructions and writes a file. They still finish together.

## Limits

- `index.html` uses the Tailwind Play CDN, so it's fine for previews. For production, use a framework export, which goes through your own Tailwind build.
- Agents don't see each other's code. Consistency comes from the shared plan, tokens and classes, so check the joins between sections.
- Sections are sanitised: no scripts, iframes, handlers, `javascript:` URLs or external images, and viewport-height units become pixels. Still review the code before you ship it.
- The preview binds to `127.0.0.1` only.

## Development and releases

- `npm test` runs offline smoke tests: agent flow, sanitising, every framework export, MCP and init.
- CI runs them on Node 20, 22 and 24 for every push and pull request.
- To release: run `npm version patch && git push --follow-tags`. The `Release` workflow checks that the tag matches `package.json`, runs the tests, publishes to npm with provenance, and creates a GitHub release. It needs the `NPM_TOKEN` repo secret.

## Licence

MIT. The cursor engine is an original implementation. The idea of visible "swarm cursors" credits Joel Califa's Swarm concept; see RESEARCH.md.
