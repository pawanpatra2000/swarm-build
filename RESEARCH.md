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
