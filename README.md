# swarm-build

Describe a page in plain words. A planner AI splits it into sections, one AI agent per section writes its part at the same time, and a live preview shows each agent's cursor building the real UI.

The speed comes from the parallel model calls. The cursors only show you what is happening.

## Quickstart

```bash
npm install                      # installs playwright (only needed for recording)
export GCP_PROJECT=<your-gcp-project>   # Vertex AI, auth via `gcloud auth login`

# live preview: open the URL it prints, the build starts when the page loads
node src/server.mjs "Landing page for a small Pune bakery with menu, hours and an order form" --open

# brief from a file, up to 6 sections
node src/server.mjs --brief-file examples/kundli-matching.txt --open

# no preview, just build and print stats
node src/server.mjs "..." --headless

# replay a saved run without calling the model again
node src/server.mjs --replay out/<run>/run.json --open

# record a run to MP4 plus desktop and mobile screenshots
node tools/record.mjs --out out/demo.mp4 -- --brief-file examples/kundli-matching.txt
```

Options: `--sections N` (2 to 6), `--port 4777`, `--theme theme.json` (forces brand colours and fonts), `SWARM_MODEL` (default `gemini-3.5-flash`).

## What you get

Each run writes `out/<title>-<timestamp>/`:

- `index.html`: the finished page (Tailwind + shared theme variables)
- `sections/*.html`: each agent's section on its own
- `plan.json`: the planner's sections, theme and voice
- `run.json`: every event with timings, used by `--replay`

## The preview

- The Planner cursor circles while the page is split into sections.
- Each agent (Ada, Linus, Grace, Alan, Margaret, Dennis) gets a dashed slot and a live character count while it writes.
- When an agent finishes, its cursor assembles the real section: it drags out boxes with a size badge, types the text and draws the SVGs.
- At the end a card shows wall time, the time one agent would take doing the sections one after another, the speed-up and the cost. **Go live** shows the clean page and **Replay** plays the run again at 1×, 2× or 3×.
- `?autolive=1` goes live and scrolls through the page on its own (used by the recorder).

## Measured (Kundli Matching demo, 6 sections)

| | |
|---|---|
| Planning | 9.3 s |
| Building, all 6 at once | 14.5 s |
| Same 6 sections one after another | 70.3 s |
| Speed-up on the build step | 4.8× |
| Model cost | $0.18 (about ₹15), most of it output and thinking tokens |

Pricing assumed: Gemini 3.5 Flash on Vertex AI, $1.50 per 1M input tokens and $9.00 per 1M output tokens. Override with `SWARM_PRICE_IN` / `SWARM_PRICE_OUT`.

## Limits

- Output is static HTML with the Tailwind Play CDN. For production, compile Tailwind or port the sections to your framework.
- Agents don't see each other's code. Consistency comes from the shared theme variables and the planner's briefs, so check spacing between sections.
- Builder output is sanitised (no scripts, iframes, event handlers or external images), but review it before you ship it.
