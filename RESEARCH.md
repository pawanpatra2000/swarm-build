# Research notes

## Inspiration

- **swarm-cursors**: a Chrome extension that shows several fake cursors drawing a UI, giving the feel of a team building it live. Credit for the visual idea goes to Joel Califa's "Swarm" concept.
- **License**: the swarm-cursors repo has no license, and its README asks people not to reuse the code. No code from it was read into or copied into this project. The cursor engine in `preview/swarm.js` is a clean-room implementation.
- **What we changed**: in swarm-cursors the cursors are theatre over an existing page. Here every cursor stands for a real model call building a real section, so the animation reflects actual parallel work.

## Why split into sections

- A landing page breaks naturally into header, hero, features, pricing, FAQ and footer. Each part can be written without seeing the others.
- One long model call is sequential: output tokens come out one at a time. Six shorter calls run at once, so wall time is roughly the slowest section instead of the sum.
- Measured on the demo: 14.5 s in parallel vs 70.3 s summed (4.8×). The plan step (about 9 s) is still sequential, and it is now the largest fixed cost.

## Keeping parallel agents consistent

- The planner fixes the theme once: colours, radius and fonts become CSS variables (`--bg --surface --ink --muted --accent --accent-ink --accent-soft --dark --dark-ink --line --radius`).
- Builders may only use those variables, so six agents land on one palette.
- Each section brief is self-contained, and every builder gets the list of section ids for anchor links.
- Found in testing: Tailwind opacity modifiers (`bg-opacity-10`, `/10`) don't work on `var()` colours. One badge rendered as an empty pill. Fix: an explicit `--accent-soft` variable plus a prompt rule that bans opacity modifiers on variables.

## Safety rules for generated HTML

- The sanitiser keeps one `<section>` and removes scripts, iframes, object/embed, style/link/meta, `on*=` handlers, `javascript:` URLs and non-data images.
- The prompt bans invented proof (testimonials, ratings, user counts) and lorem ipsum.

## Preview engine design

- **Stage**: the page renders at 1280 px in one document and is scaled with a CSS transform. While building it zooms out (min 0.42) so more of the page fits; when live it fits the width.
- **Overlay**: cursors sit in a fixed overlay and re-read `getBoundingClientRect()` every frame, so they stay on target while layout shifts and the canvas scrolls.
- **Reveal**: each finished section is inserted with every element `visibility:hidden` (layout stays final), then revealed step by step:
  - boxes are dragged out with a W×H badge
  - text blocks are typed with their size locked
  - SVGs appear behind a striped placeholder
- **Order**: steps go top to bottom, then outer to inner. Each section gets about 9 s at 1×, and at most 70 steps are animated. Smaller ones appear instantly.
- **Tailwind timing**: the Play CDN generates CSS after DOM mutations, so the engine waits about 260 ms before measuring.

## Caveats

- The Tailwind Play CDN is meant for prototypes. Compile Tailwind for production.
- Media-query breakpoints follow the browser window, not the 1280 px stage, so the preview always shows the desktop layout. Check mobile with the screenshot.

## v0.2: agent-native mode, design review, comments

### Why the coding agent should do the work

- Most people who would use this already have Claude Code, Codex, Cursor or Kiro, so asking them for a separate API key is friction.
- Agent mode moves the thinking into their agent. The run lives in a folder (`events.jsonl`, `plan.json`, `sections/`).
- The preview tails that folder. Whether the agent writes through CLI calls or the MCP server, the live animation is the same.
- Parallelism comes from the agent's own sub-agents. The skill tells the agent to start them all in one message.

### Platforms

- **Codex**: discovers skills in `.agents/skills/<name>/SKILL.md` per repo, or in the user's home ([Codex docs](https://developers.openai.com/codex/skills/create-skill)).
- **Claude Code**: uses `.claude/skills/`, `.claude/agents/` for sub-agent definitions, and `.mcp.json` for project MCP servers.
- **Cursor**: uses `.cursor/rules/*.mdc` and `.cursor/mcp.json`.
- **Kiro**: uses `.kiro/skills/` and `.kiro/settings/mcp.json`.
- **MCP**: one server covers every MCP-capable client. It is hand-written over stdio, so `npx` stays fast.

### Design skills

- **[Impeccable](https://github.com/pbakaus/impeccable)** (Apache-2.0) ships a CLI with `detect`, a deterministic anti-pattern scanner.
  - It is used as an optional review input, run on the served page.
  - Scanning the static file is not enough: Tailwind CSS only exists after the Play CDN runs, so a file scan reported flat type and cramped padding that were not real.
- **[UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)** (MIT) is a searchable style, palette and font database installed with `uipro init --ai <agent>`.
- Neither project's content is bundled. `init --design` runs their installers, and our design principles are our own text.

### Bugs found while testing, now fixed

- **Viewport units**: `min-h-[70vh]` in a hero made the preview iframe grow without limit, because `vh` equals the iframe height and the iframe height follows the content. The hero reached 7,753 px. Sanitising now converts `vh/svh/dvh` to pixels for an 800 px screen, and the prompt forbids them.
- **Contrast**: on the dark band the accent-coloured eyebrow text had a 1.9:1 contrast ratio (Impeccable caught it). Shared CSS now recolours `sb-eyebrow`, ghost buttons and cards inside `sb-dark`.
- **Eyebrows and cream backgrounds**: Impeccable flags tracked-caps eyebrows above headings and default cream backgrounds as AI tells. Both are now in the design principles.
- **False "truncated" review**: the review prompt clipped sections to 7,000 characters, so the reviewer reported the sections as cut off and rebuilt them for nothing. Long sections are now sent in full up to 16,000 characters, with an explicit note if clipped.
- **Non-section roots**: a builder returned a `<footer>` root and the submit was rejected. Non-section roots are now wrapped instead of rejected.
- **Idle gaps in replays**: replaying an agent-mode run took more than 6 minutes, because idle gaps (a person thinking) were kept. Replay now squeezes gaps to 3 s, and the share export of that run plays in about 35 s at 2×.

## v0.4: agent-only

- **Why**: the API-key mode was removed. People already pay for a coding agent, and a second model bill or key setup is friction. It also kept two code paths for one job.
- **Now**: swarm-build never calls a model. Planning, building, reviewing and comment edits are all done by the user's own agent and sub-agents, through the CLI or MCP.
- **Comments**: the preview's comment button copies a request for the agent ("Apply the swarm-build comments…"). The preview can't start an agent by itself, so the user pastes that request into the chat.
- **Videos**: `tools/record.mjs` records the replay of a finished run instead of driving a build.
