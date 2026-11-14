# swarm-build

Describe a page. A planner sets the design direction and splits the page into sections. One agent per section builds its part **at the same time**, and a live preview shows each agent's cursor assembling the real UI. Then you click anything on the page to leave a comment, and only that section gets rebuilt.

It runs **inside the coding agent you already use**: Claude Code, Codex, Cursor, Kiro, T3 Code, or anything that can run a shell command or use MCP.
- **Your agent's own model** does the design thinking, and its own sub-agents build the sections.
- **swarm-build never calls a model.** It needs no API key, no account and adds no cost beyond your agent plan.
- **It provides** the live preview, the shared design system, the checks and the framework export.

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
5. Ask you to comment. Click anything in the preview and write the change. Then click **Copy request for your agent** and paste it into the chat. Only those sections are rebuilt, live.
6. Export the page into your project's framework.

What `init` writes:

| Agent | Files |
|---|---|
| Claude Code | `.claude/skills/swarm-build/SKILL.md`, `.claude/agents/swarm-section-builder.md`, `.mcp.json` with `--mcp` |
| Codex | `.agents/skills/swarm-build/SKILL.md`; with `--mcp` it prints the `codex mcp add` command |
| Cursor | `.cursor/rules/swarm-build.mdc`, `.cursor/mcp.json` with `--mcp` |
| Kiro | `.kiro/skills/swarm-build/SKILL.md`, `.kiro/settings/mcp.json` with `--mcp` |
| Any agent that reads AGENTS.md | a short `swarm-build` block in `AGENTS.md` (`--agent agents-md`) |

Add `--agent claude,codex` to choose agents and `--global` to install for your user instead of the project. `.swarm/` is added to `.gitignore`.

## The preview

- The **Planner** cursor picks a direction. Then each agent gets a dashed slot and a live character count.
- When a section lands, its agent drags out the boxes (with size badges), types the text and draws the SVGs.
- The **Reviewer** scans the page. Sections it flags are rebuilt by their own agent.
- **Desktop / Mobile** toggle: the stage is an iframe, so Tailwind breakpoints are real.
- **Comment** (or press `C`): click any element and write what should change. Pins stay on the element.
- **Replay** at 1×, 2× or 3×. Long idle gaps are squeezed to 3 s. **Go live** hides the cursors.

## Commands

These are the commands your agent runs. You can run them by hand too.

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

## Recording a video

```bash
npm i -D playwright && npx playwright install chromium
node tools/record.mjs .swarm/<run> --speed 2 --out demo.mp4   # needs ffmpeg
```

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
  - Your agent reads the findings and the page, then rebuilds at most 3 weak sections in parallel.
- **Your design system**: `DESIGN.md` in the project overrides the defaults.
- `init --design` installs Impeccable (Apache-2.0) and [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) (MIT) with their own installers, so your agent can use them while planning.

## Measured

Yoga studio page, 6 sections, one coding agent with 6 sub-agents:

| Parallel build | Same sections one after another | Speed-up | Extra cost |
|---|---|---|---|
| 54.2 s | 134.4 s | 2.5× | none (your agent plan) |

The speed-up depends on how many sub-agents your agent runs at once. If your agent has no sub-agents, it builds the sections one after another; the preview still works.

## Limits

- `index.html` uses the Tailwind Play CDN, so it's fine for previews. For production, use a framework export, which goes through your own Tailwind build.
- Agents don't see each other's code. Consistency comes from the shared plan, tokens and classes, so check the joins between sections.
- Sections are sanitised: no scripts, iframes, handlers, `javascript:` URLs or external images, and viewport-height units become pixels. Still review the code before you ship it.
- The preview binds to `127.0.0.1` only.

## Development and releases

- `npm test` runs offline smoke tests: agent flow, sanitising, every framework export, MCP and init.
- CI runs them on Node 20, 22 and 24 for every push and pull request.
- To release: run `npm version patch && git push --follow-tags`. The `Release` workflow checks that the tag matches `package.json`, runs the tests, publishes to npm through trusted publishing (OIDC, so no npm token is stored and provenance is automatic), and creates a GitHub release.

## Licence

MIT. The cursor engine is an original implementation. The idea of visible "swarm cursors" credits Joel Califa's Swarm concept; see RESEARCH.md.
