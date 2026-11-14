---
name: swarm-build
description: Build a web page or UI fast by planning it into sections and building every section in parallel with sub-agents, while a live preview shows each agent's cursor assembling the real page. Use when the user asks to "swarm build" a page, build a landing page or UI quickly in parallel, wants to watch agents build a UI live, or wants to apply comments left in the swarm-build preview.
---

# swarm-build

swarm-build gives you a live preview and a run folder.
- **You** (the coding agent) do the design thinking with your own model. No API key is needed.
- **Your sub-agents** write the sections.
- **The preview** animates each section as it lands.

Run every command from the project root.

`SB` below means: `{{SB}}`

## 1. Start

```bash
SB start --brief-file brief.txt --agent "<your product name>"   # or: SB start "<one-line brief>"
```

- Write the brief first. Name every section's real content. Give brand colours and fonts if known. State the tone. Write it in the user's language.
- `start` creates `.swarm/<run>/` and opens a preview server. Show the user the preview URL it prints; the build plays there live.
- If the project has a `DESIGN.md`, read it and follow it.
- If design skills such as Impeccable or UI UX Pro Max are installed, use them while planning.

## 2. Plan (you, not a sub-agent)

Run `SB guide plan` and follow it exactly. It prints the design principles and the plan JSON shape. Write `.swarm/plan.json` with 4 to 8 sections, then:

```bash
SB plan .swarm/plan.json
```

The command prints one task line per section.

## 3. Build all sections at the same time

Start one sub-agent per section **in a single message**, so they run in parallel. Give each sub-agent this exact instruction:

> Run `SB task <section-id>` and follow the instructions it prints. Write the section to `.swarm/out/<section-id>.html`, then run `SB submit <section-id> .swarm/out/<section-id>.html`. Reply only with "done" or the error.

- **No sub-agents** (some tools don't have them): do the sections yourself one after another with the same two commands. The preview still works.
- **Don't write sections yourself while sub-agents run.** Wait for all of them, then run `SB status`.

## 4. Review and fix

```bash
SB check --impeccable    # built-in design checks plus the Impeccable detector, if npx can fetch it
```

- Look at every `error` and `warning`, and also at the page itself: the screenshot, or `SB status` for the page path.
- For each section that really needs it, start a fix sub-agent with this instruction (again all in one message): "Run `SB task <id> --fix "<what to change>"`, follow it, then `SB submit <id> <file>`."
- At most 3 fixes. Then run `SB done`.

## 5. Comments from the user

The user can click any element in the preview and leave a comment.

- When they ask you to apply comments, run `SB comments`.
- For each section that has comments, start a sub-agent (all in one message) with this instruction: "Run `SB task <id> --comments`, follow it, then `SB submit <id> <file>`."
- Submitting resolves that section's open comments.

## 6. Put the page into the project

```bash
SB export auto --into .        # detects Next, React, Vue, Nuxt, Svelte, SvelteKit, Astro or plain HTML
```

- It writes the page and one component per section in the project's own conventions.
  - Next.js: `app/<route>/page.tsx` plus `components/swarm/<slug>/*.tsx`.
  - Nuxt: `pages/<route>.vue`.
  - SvelteKit: `src/routes/<route>/+page.svelte`.
  - Astro: `src/pages/<route>.astro`.
- Existing files are never overwritten. Use `--route <path>` to pick another path, or `--force` only if the user agrees.
- The markup needs Tailwind CSS v4, or v3.3 and later. If the command says Tailwind is missing, tell the user.
- Run the project's own build or type-check once and fix anything it reports in the generated files.
- If there's no project, skip this step. `.swarm/<run>/index.html` is a complete page.

## 7. Hand off

Tell the user:
- Where the page lives: its route, or `.swarm/<run>/index.html`.
- The preview URL.
- The speed-up from `SB done`.

Offer `SB export share` for a single-file replay they can send to someone.

## Rules

- Sections are HTML with Tailwind classes and the shared `sb-*` classes. Never put scripts in them.
- Don't invent testimonials, ratings, user counts or prices.
- Don't edit `.swarm/<run>/events.jsonl` by hand. Always use the commands.
