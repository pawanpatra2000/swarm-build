---
name: swarm-build
description: Build a real web page fast by planning it into sections and generating every section in parallel with AI agents, with a live swarm-cursor preview. Use when the user asks to "build a landing page fast", "swarm build a UI", "show agents building the page live", or wants a recorded demo of a UI being built.
---

# swarm-build

Tool folder: `/Users/pp/Documents/GitHub/swarm-build`. Needs Node 20+, `gcloud auth login`, and `GCP_PROJECT` set.

## Steps

1. **Write the brief** to a file. Name every section's real content, give brand colours and fonts exactly, and state the tone. Say "no testimonials, ratings or user counts" unless the user supplies real ones.
2. **Pick a mode**:
   - The user wants to watch: `node src/server.mjs --brief-file brief.txt --open`. The build starts when the page opens.
   - The user wants a video: `node tools/record.mjs --out out/<name>.mp4 -- --brief-file brief.txt`. This needs `PLAYWRIGHT_BROWSERS_PATH` pointing at an installed Chromium, and ffmpeg.
   - You only need the files: `node src/server.mjs --brief-file brief.txt --headless`.
3. **Check the result**: open `out/<run>/screenshot-desktop.png` and `screenshot-mobile.png`, or take your own. Look for empty pills (opacity on var colours), clashing spacing between sections, and invented claims.
4. **Fix**: to fix one section, edit `out/<run>/sections/<id>.html` and the matching block in `index.html`. If many sections are wrong, change the brief and run again.
5. **Report** the path of `index.html`, the speed-up and cost from the last log line, and the video path if you recorded one.

## Notes

- Use `--theme theme.json` to force brand tokens. Its keys are `bg surface ink muted accent accentInk accentSoft dark darkInk line radius font headingFont`.
- Use `--replay out/<run>/run.json` to re-show a run without paying for model calls.
- A typical 6-section page costs about $0.18 with gemini-3.5-flash.
