// swarm-build live preview: original cursor engine (clean-room; the visual idea credits Joel Califa's Swarm).
// Follows the run's event stream. Every cursor is a real agent; when its section lands, the cursor
// assembles the real markup: crosshair boxes, a text box then typing with a caret, pen-tool lines,
// ruler guides that text snaps to, and alt-drag duplicates for repeated items.
(() => {
  'use strict';
  const WIDTHS = [375, 768, 1280, 1440];
  const SECTION_BUDGET_MS = 9000; // assembly animation per section at 1x
  const MAX_ANIMATED_STEPS = 70;
  const SLOT_H = { short: 140, medium: 460, tall: 700 };
  const INLINE = new Set(['a', 'span', 'strong', 'em', 'b', 'i', 'u', 'br', 'small', 'code', 'mark', 'sup', 'sub', 'abbr', 'time', 's', 'del', 'ins', 'kbd', 'label', 'q', 'cite', 'wbr']);
  const MEDIA = new Set(['svg', 'img', 'video', 'canvas', 'picture']);
  const REASON = { build: 'writing', fix: 'fixing', comment: 'comment', restore: 'restoring' };

  const $ = (s) => document.querySelector(s);
  const canvas = $('#canvas'), frameBody = $('#frame-body'), iframe = $('#stage'), overlay = $('#overlay');
  const params = new URLSearchParams(location.search);
  const EMBED = window.__SWARM_EMBED__ || null; // static share file: events baked in, no server
  const initialWidth = Number(params.get('width')) || (params.get('device') === 'mobile' ? 375 : 1280);

  const S = {
    speed: Math.min(3, Math.max(1, Number(params.get('speed')) || 1)),
    width: Math.min(1920, Math.max(320, initialWidth)),
    autolive: params.get('autolive') === '1',
    events: [], received: -1, timers: [], token: 0, ready: false, queue: [],
    catchingUp: !EMBED && params.get('replay') !== '1', // events before the sync marker are shown at once
    mode: 'idle', scale: 1, plan: null, meta: null, stats: null,
    agents: new Map(), planner: null, animating: 0,
    runStart: null, timerFixed: null, replaying: false, replayStart: 0,
    userScrollAt: 0, finaleShown: false, commenting: false, comments: new Map(),
    hoverEl: null, popTarget: null, follow: null, tour: false, mouse: { x: -999, y: -999 },
    flocking: false, guides: [], watching: false, sectionHover: null,
  };
  window.__swarm = S;
  let doc = null, win = null; // stage document and window

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtS = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const live = (tok) => (tok && typeof tok === 'object' ? tok.live() : tok === S.token);
  const css = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  // The frame loop runs 60 times a second; only touch the DOM when a value really changes.
  const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
  const setStyle = (el, k, v) => { if (el && el.style[k] !== v) el.style[k] = v; };

  function tween(ms, fn, tok) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (!live(tok)) return resolve(false);
        const p = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
        fn(p);
        if (p < 1) requestAnimationFrame(tick); else resolve(true);
      };
      requestAnimationFrame(tick);
    });
  }

  // Stage element rect -> client coordinates of this page.
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    const f = iframe.getBoundingClientRect();
    const s = S.scale;
    const left = f.left + r.left * s, top = f.top + r.top * s, width = r.width * s, height = r.height * s;
    return { left, top, width, height, right: left + width, bottom: top + height, iw: r.width, ih: r.height };
  }
  const stageX = (x) => iframe.getBoundingClientRect().left + x * S.scale;

  // ---------- sound: synthesised with Web Audio, no files ----------
  const Sound = (() => {
    let ctx = null, master = null, on = localStorage.getItem('swarm-sound') !== 'off', lastKey = 0;
    const PENTA = [329.63, 369.99, 415.3, 493.88, 554.37, 659.25, 739.99, 830.61, 987.77, 1108.73]; // E major pentatonic
    function ensure() {
      if (ctx || !on) return ctx;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain();
        master.gain.value = 0.35;
        master.connect(ctx.destination);
      } catch { ctx = null; }
      return ctx;
    }
    const ready = () => on && ensure() && ctx.state === 'running';
    function pan(x) {
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) { p.pan.value = clamp((x / innerWidth) * 2 - 1, -0.9, 0.9); p.connect(master); return p; }
      return master;
    }
    function blip({ freq, dur = 0.05, type = 'square', gain = 0.06, x = innerWidth / 2, attack = 0.002, noise = false }) {
      if (!ready()) return;
      const t = ctx.currentTime;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      g.connect(pan(x));
      let src;
      if (noise) {
        const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        src = ctx.createBufferSource();
        src.buffer = buf;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = freq;
        src.connect(hp);
        hp.connect(g);
      } else {
        src = ctx.createOscillator();
        src.type = type;
        src.frequency.value = freq;
        src.connect(g);
      }
      src.start(t);
      src.stop(t + dur + 0.02);
    }
    return {
      get on() { return on; },
      get locked() { return on && (!ctx || ctx.state !== 'running'); },
      unlock() { if (on && ensure() && ctx.state !== 'running') ctx.resume(); },
      toggle() { on = !on; localStorage.setItem('swarm-sound', on ? 'on' : 'off'); if (on) this.unlock(); return on; },
      key(x, space) {
        const now = performance.now();
        if (now - lastKey < 28) return; // keep it a patter, not a roar
        lastKey = now;
        blip({ freq: space ? 1800 : 3200 + Math.random() * 900, dur: 0.018, gain: 0.05, x, noise: true });
        blip({ freq: space ? 110 : 160 + Math.random() * 30, dur: 0.04, type: 'sine', gain: 0.045, x });
      },
      click(x) { blip({ freq: 2600, dur: 0.012, gain: 0.07, x, noise: true }); setTimeout(() => blip({ freq: 2200, dur: 0.01, gain: 0.05, x, noise: true }), 70); },
      snap(x) { blip({ freq: 4200, dur: 0.01, gain: 0.08, x, noise: true }); },
      note(x, size = 0.5) {
        const i = clamp(Math.round((1 - size) * 6 + (x / innerWidth) * 3), 0, PENTA.length - 1);
        blip({ freq: PENTA[i], dur: 0.9, type: 'sine', gain: 0.05, x, attack: 0.01 });
        blip({ freq: PENTA[i] * 2, dur: 0.5, type: 'triangle', gain: 0.012, x, attack: 0.01 });
      },
      tick(step) { blip({ freq: 600 + step * 90, dur: 0.02, type: 'triangle', gain: 0.03 }); },
      swell() { [164.81, 246.94].forEach((f) => blip({ freq: f, dur: 1.6, type: 'sine', gain: 0.03, attack: 0.6 })); },
      arp() { [329.63, 415.3, 493.88, 659.25].forEach((f, i) => setTimeout(() => blip({ freq: f, dur: 0.5, type: 'sine', gain: 0.04 }), i * 90)); },
      chord() { [329.63, 415.3, 493.88, 659.25].forEach((f) => blip({ freq: f, dur: 2.2, type: 'sine', gain: 0.035, attack: 0.03 })); },
      sweep() { [659.25, 493.88, 329.63].forEach((f, i) => setTimeout(() => blip({ freq: f, dur: 0.4, type: 'sine', gain: 0.035 }), i * 70)); },
    };
  })();

  // ---------- stage iframe ----------
  const STAGE_DOC = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.tailwindcss.com"><\/script>
<link id="sb-fonts" rel="stylesheet" href="data:text/css,">
<style id="sb-theme"></style>
<style>
html,body{margin:0;overflow:hidden}
.min-h-screen,.h-screen{min-height:680px!important;height:auto!important}
.sb-empty{height:720px;display:grid;place-items:center;color:#a8a29e;font:500 22px Inter,system-ui,sans-serif}
.sb-slot{position:relative;margin:14px 24px;border:2px dashed color-mix(in srgb,var(--c) 55%,transparent);border-radius:16px;background:color-mix(in srgb,var(--c) 5%,transparent);overflow:hidden;padding:22px 26px;font-family:Inter,system-ui,sans-serif}
.sb-slot-label{font-size:20px;color:#3f3a35}.sb-slot-label b{color:var(--c)}
.sb-slot-brief{margin-top:8px;max-width:760px;font-size:15px;line-height:1.5;color:#78716c}
.sb-slot-bar{position:absolute;left:26px;right:26px;bottom:22px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--c) 15%,transparent);overflow:hidden}
.sb-slot-bar i{display:block;height:100%;width:0;background:var(--c);border-radius:3px;transition:width .3s}
.sb-slot::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.55) 50%,transparent 70%);background-size:250% 100%;animation:sbshim 1.8s linear infinite}
.sb-slot.failed{border-style:solid;border-color:#dc2626}
@keyframes sbshim{from{background-position:150% 0}to{background-position:-100% 0}}
</style></head><body><div id="root"><div class="sb-empty">Waiting for the planner…</div></div></body></html>`;

  function setupStage() {
    return new Promise((resolve) => {
      iframe.addEventListener('load', () => {
        doc = iframe.contentDocument;
        win = iframe.contentWindow;
        doc.addEventListener('mousemove', onStageMove, true);
        doc.addEventListener('click', onStageClick, true);
        doc.addEventListener('keydown', onKey);
        doc.addEventListener('pointerdown', () => Sound.unlock(), true);
        doc.addEventListener('wheel', () => { S.userScrollAt = performance.now(); stopTour(); }, { passive: true });
        resolve();
      }, { once: true });
      iframe.srcdoc = STAGE_DOC;
    });
  }
  const root = () => doc.getElementById('root');
  const hostOf = (id) => doc.querySelector(`[data-slot="${css(id)}"]`) || doc.querySelector(`[data-section="${css(id)}"]`);

  // ---------- cursors: one shape per tool ----------
  const TOOLS = {
    arrow: { hx: 4, hy: 2, svg: (c) => `<path d="M4 2.5v17l4.6-4.2 3.2 7 3-1.4-3.2-6.9h6.4z" fill="${c}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>` },
    cross: { hx: 12, hy: 12, svg: (c) => `<path d="M12 2v8M12 14v8M2 12h8M14 12h8" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M12 2v8M12 14v8M2 12h8M14 12h8" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>` },
    ibeam: { hx: 12, hy: 12, svg: (c) => `<path d="M8.5 3h7M8.5 21h7M12 3v18" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><path d="M8.5 3h7M8.5 21h7M12 3v18" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/>` },
    pen: { hx: 3, hy: 21, svg: (c) => `<path d="M3 21l3.5-9L15 3.5l5.5 5.5L12 17.5z" fill="${c}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8.6" cy="15.4" r="1.6" fill="#fff"/>` },
    copy: { hx: 4, hy: 2, svg: (c) => `<path d="M4 2.5v17l4.6-4.2 3.2 7 3-1.4-3.2-6.9h6.4z" fill="${c}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><circle cx="18.5" cy="18.5" r="5" fill="#fff"/><path d="M18.5 15.8v5.4M15.8 18.5h5.4" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>` },
  };
  class Cursor {
    constructor(name, color, x, y) {
      this.color = color;
      this.el = document.createElement('div');
      this.el.className = 'cursor';
      this.el.style.setProperty('--c', color);
      this.el.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"></svg><span class="tag"></span><span class="bubble"></span>`;
      this.svg = this.el.querySelector('svg');
      this.el.querySelector('.tag').textContent = name;
      this.bubble = this.el.querySelector('.bubble');
      overlay.append(this.el);
      this.vx = 0; this.vy = 0;
      this.tool('arrow');
      this.move(x, y);
      this.say('');
    }
    tool(name) {
      if (name === this._tool) return;
      this._tool = name;
      const t = TOOLS[name];
      this.svg.innerHTML = t.svg(this.color);
      this.hx = t.hx; this.hy = t.hy;
      this.el.dataset.tool = name;
      this.move(this.x ?? 0, this.y ?? 0);
    }
    move(x, y) { this.x = x; this.y = y; this.el.style.transform = `translate(${x - this.hx}px, ${y - this.hy}px)`; }
    say(t) { if (t === this._said) return; this._said = t; this.bubble.textContent = t; this.bubble.style.display = t ? '' : 'none'; }
    travel(target, ms, tok) {
      const sx = this.x, sy = this.y;
      return tween(ms, (p) => { const t = target(); const e = ease(p); this.move(lerp(sx, t.x, e), lerp(sy, t.y, e)); }, tok);
    }
    state(cls) { this.el.classList.remove('parked', 'gone'); if (cls) this.el.classList.add(cls); }
    remove() { this.el.remove(); }
  }

  const make = (cls, color, html = '') => {
    const b = document.createElement('div');
    b.className = cls;
    if (color) b.style.setProperty('--c', color);
    b.innerHTML = html;
    overlay.append(b);
    return b;
  };
  const makeBox = (color, cls = '') => make(`dragbox ${cls}`, color, '<span class="dim"></span>');
  const place = (el, x, y, w, h) => Object.assign(el.style, { transform: `translate(${x}px, ${y}px)`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, h)}px` });

  // ---------- rulers and guides ----------
  const rulerTop = make('ruler ruler-h');
  const rulerLeft = make('ruler ruler-v');
  let rulersShown = false;
  function layoutRulers(show) {
    if (!show && !rulersShown) return;
    rulersShown = show;
    const c = canvas.getBoundingClientRect();
    const f = iframe.getBoundingClientRect();
    rulerTop.classList.toggle('on', show);
    rulerLeft.classList.toggle('on', show);
    place(rulerTop, c.left, c.top, c.width, 18);
    place(rulerLeft, c.left, c.top, 18, c.height);
    // tick marks every 100 stage px, aligned with the frame
    const step = 100 * S.scale;
    rulerTop.style.backgroundSize = `${step}px 100%, ${step / 10}px 100%`;
    rulerTop.style.backgroundPosition = `${f.left - c.left}px 0, ${f.left - c.left}px 0`;
    rulerLeft.style.backgroundSize = `100% ${step}px, 100% ${step / 10}px`;
    rulerLeft.style.backgroundPosition = `0 ${f.top - c.top}px, 0 ${f.top - c.top}px`;
  }

  // ---------- panel ----------
  function logLine(t, html) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${fmtS(t || 0)}</span>${html}`;
    $('#log').prepend(li);
    while ($('#log').children.length > 200) $('#log').lastChild.remove();
  }
  const setPhase = (t) => { $('#phase').textContent = t; };
  const who = (a) => `<b style="color:${a.color}">${esc(a.name)}</b>`;

  function agentRow(a) {
    let li = document.querySelector(`#agents li[data-id="${css(a.id)}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = a.id;
      li.tabIndex = 0;
      li.style.setProperty('--c', a.color);
      li.innerHTML = '<span class="dot"></span><span class="who"></span><span class="t"></span><span class="what"></span>';
      $('#agents').append(li);
      li.querySelector('.who').innerHTML = `${esc(a.name)}<small>${esc(a.section.name)}</small>`;
    }
    if (li.dataset.status !== a.status) li.dataset.status = a.status;
    if (li.classList.contains('following') !== (S.follow === a.id)) li.classList.toggle('following', S.follow === a.id);
    const what = {
      thinking: `${REASON[a.reason] || 'writing'}${a.chars ? ` · ${fmtK(a.chars)} chars` : '…'}`,
      building: `assembling · ${a.step}/${a.steps}`,
      done: `${a.rebuilds ? `done (${a.rebuilds} rebuild${a.rebuilds > 1 ? 's' : ''})` : 'done'}${a.chars ? ` · ${fmtK(a.chars)} chars` : ''}${a.ms ? ` in ${fmtS(a.ms)}` : ''}`,
      failed: 'failed',
    }[a.status];
    setText(li.querySelector('.what'), what);
    const t = a.status === 'done' || a.status === 'failed' ? a.ms || 0 : performance.now() - a.startAt;
    setText(li.querySelector('.t'), fmtS(t));
  }

  function renderComments() {
    const list = [...S.comments.values()];
    const open = list.filter((c) => c.status === 'open' || c.status === 'working').length;
    $('#comment-count').textContent = list.length ? `· ${open} open` : '';
    $('#comments').innerHTML = list.map((c, i) => `<li data-id="${esc(c.id)}" data-status="${esc(c.status)}"><span class="n">${i + 1}</span><span>${esc(c.text)}<small>${esc(c.section)}${c.target ? ` · ${esc(c.target.slice(0, 60))}` : ''}${c.status !== 'open' ? ` · ${esc(c.status)}` : ''}</small></span></li>`).join('');
    $('#watching').hidden = !S.watching || EMBED;
    $('#apply').hidden = !open || S.watching || EMBED;
    $('#comment-hint').hidden = list.length > 0 || EMBED;
    overlay.querySelectorAll('.pin').forEach((p) => { if (!S.comments.has(p.dataset.id)) p.remove(); });
    list.forEach((c, i) => {
      let pin = overlay.querySelector(`.pin[data-id="${css(c.id)}"]`);
      if (!pin) pin = make('pin');
      pin.dataset.id = c.id;
      pin.textContent = String(i + 1);
      pin.className = `pin ${c.status === 'open' ? '' : c.status}`;
    });
  }

  function commentEl(c) {
    const sec = doc && doc.querySelector(`[data-section="${css(c.section)}"]`);
    if (!sec) return hostOf(c.section);
    if (c.path) { try { const el = sec.querySelector(c.path); if (el) return el; } catch {} }
    return sec;
  }

  // ---------- reset ----------
  function reset() {
    S.token++;
    S.timers.forEach(clearTimeout);
    S.timers = [];
    S.agents.forEach((a) => a.cursor.remove());
    S.agents.clear();
    if (S.planner) S.planner.remove();
    S.planner = null;
    overlay.querySelectorAll('.cursor, .dragbox, .pin, .guide, .caret, .anchor, .penline, .measure, .dupghost').forEach((n) => n.remove());
    S.guides = [];
    S.comments.clear();
    if (doc) {
      root().innerHTML = '<div class="sb-empty">Waiting for the planner…</div>';
      doc.getElementById('sb-theme').textContent = '';
    }
    ['#agents', '#log', '#review', '#comments'].forEach((s) => ($(s).innerHTML = ''));
    $('#review-box').hidden = true;
    $('#finale').hidden = true;
    $('#apply-msg').hidden = true;
    Object.assign(S, { mode: 'idle', plan: null, stats: null, animating: 0, finaleShown: false, runStart: null, timerFixed: null, flocking: false, follow: null });
    renderComments();
    window.__swarmDone = false;
  }

  // ---------- events ----------
  // instant: catching up on events that already happened (page reload, late open) - show results, no animation.
  function handle(e, instant = false) {
    const tok = S.token;
    if (!S.replaying && e.t != null && !instant && S.timerFixed == null) S.runStart = performance.now() - e.t;
    switch (e.type) {
      case 'meta':
        S.meta = e;
        $('#brief').textContent = e.brief; $('#brief').title = e.brief;
        $('#model').textContent = e.model ? `${e.model}` : 'your coding agent';
        logLine(e.t, '<b>brief</b> received');
        break;
      case 'plan:start': {
        S.mode = 'planning';
        setPhase('planning');
        const r = canvas.getBoundingClientRect();
        S.planner = new Cursor('Planner', '#111111', r.left + r.width / 2, r.top + r.height / 2);
        S.planner.say('planning the sections…');
        logLine(e.t, '<b>planner</b> started'); if (!instant) Sound.swell();
        break;
      }
      case 'plan:done':
        S.plan = e.plan;
        doc.getElementById('sb-theme').textContent = e.stageCSS || '';
        if (e.fonts) doc.getElementById('sb-fonts').href = e.fonts;
        renderSlots(e.plan);
        S.mode = 'build';
        setPhase('building');
        $('#frame-url').textContent = e.plan.title;
        if (!S.planner) { const r = canvas.getBoundingClientRect(); S.planner = new Cursor('Planner', '#111111', r.left + r.width / 2, r.top + 120); }
        S.planner.say(`${e.plan.sections.length} sections · fanning out`);
        logLine(e.t, `<b>plan</b> ${e.plan.sections.length} sections${e.ms ? ` in ${fmtS(e.ms)}` : ''}`);
        if (instant) S.planner.state('gone');
        else {
          Sound.arp();
          setTimeout(() => S.planner && S.planner.state('gone'), 2500 / S.speed);
        }
        break;
      case 'agent:start': {
        if (!S.plan) break;
        const section = S.plan.sections.find((s) => s.id === e.id);
        if (!section) break;
        let a = S.agents.get(e.id);
        const reason = e.reason || 'build';
        if (!a) {
          const from = S.planner || { x: innerWidth / 2, y: innerHeight / 2 };
          a = { id: e.id, name: e.agent.name, color: e.agent.color, section, chars: 0, rebuilds: 0, phase: Math.random() * 6.28, cursor: new Cursor(e.agent.name, e.agent.color, from.x, from.y) };
          S.agents.set(e.id, a);
        } else {
          a.rebuilds++;
          a.cursor.state();
        }
        Object.assign(a, { status: 'thinking', reason, chars: 0, startAt: performance.now(), ms: null, step: 0, steps: 0, note: e.note || '' });
        a.cursor.tool('arrow');
        if (reason !== 'build') {
          a.rework && a.rework.remove();
          a.rework = makeBox(a.color, 'rework');
          if (reason === 'comment') S.comments.forEach((c) => { if (c.section === e.id && c.status === 'open') c.status = 'working'; });
          renderComments();
          S.flocking = false;
          if (S.mode === 'live' || S.mode === 'done') S.mode = 'build';
        }
        agentRow(a);
        logLine(e.t, `${who(a)} ${reason === 'build' ? '→' : reason === 'fix' ? 'fixing' : 'comment on'} ${esc(section.name)}${e.note ? ` <span>${esc(e.note.slice(0, 80))}</span>` : ''}`);
        break;
      }
      case 'agent:progress': {
        const a = S.agents.get(e.id);
        if (!a) break;
        a.chars = e.chars;
        const bar = doc.querySelector(`.sb-slot[data-slot="${css(e.id)}"] .sb-slot-bar i`);
        if (bar) bar.style.width = `${clamp(e.chars / 9000, 0.03, 0.97) * 100}%`;
        break;
      }
      case 'agent:done': {
        let a = S.agents.get(e.id);
        if (!a && S.plan) { handle({ type: 'agent:start', id: e.id, agent: e.agent, reason: e.reason, t: e.t }, instant); a = S.agents.get(e.id); }
        if (!a) break;
        a.chars = e.chars || e.html.length;
        a.ms = e.ms || a.ms;
        if (a.rework) { a.rework.remove(); a.rework = null; }
        const resolve = () => { (e.resolves || []).forEach((id) => { const c = S.comments.get(id); if (c) c.status = 'resolved'; }); renderComments(); };
        if (instant || e.reason === 'restore') {
          placeInstant(a, e.html);
          resolve();
          if (instant) logLine(e.t, `${who(a)} ${e.reason === 'build' || !e.reason ? 'wrote' : e.reason === 'restore' ? 'restored' : 'rebuilt'} ${esc(a.section.name)}`);
          if (!instant) { logLine(e.t, `${who(a)} restored ${esc(a.section.name)} to v${e.restored}`); Sound.note(innerWidth / 2, 0.4); afterWork(); }
          break;
        }
        logLine(e.t, `${who(a)} ${e.reason === 'build' || !e.reason ? 'wrote' : 'rebuilt'} ${esc(a.section.name)}${e.ms ? ` · ${fmtS(e.ms)}` : ''}`);
        S.animating++;
        assemble(a, e.html, tok)
          .catch((err) => { console.error('assemble failed', err); placeInstant(a, e.html); })
          .finally(() => { if (!live(tok)) return; S.animating--; resolve(); afterWork(); });
        break;
      }
      case 'agent:error': {
        const a = S.agents.get(e.id);
        if (!a) break;
        a.status = 'failed'; a.ms = performance.now() - a.startAt;
        a.cursor.say('failed');
        if (a.rework) { a.rework.remove(); a.rework = null; }
        const slot = doc.querySelector(`.sb-slot[data-slot="${css(e.id)}"]`);
        if (slot) { slot.classList.add('failed'); slot.querySelector('.sb-slot-brief').textContent = e.message; }
        logLine(e.t, `<b style="color:#fca5a5">${esc(a.name)} failed</b> <span>${esc(String(e.message).slice(0, 100))}</span>`);
        afterWork();
        break;
      }
      case 'review:done': {
        const real = (e.findings || []).filter((f) => f.severity !== 'info');
        $('#review').innerHTML = `<div><b>${real.length}</b> finding${real.length === 1 ? '' : 's'}</div>`
          + real.slice(0, 12).map((f) => `<div class="fix"><strong>${esc(f.id || f.source)}</strong> · ${esc(f.message)}</div>`).join('');
        $('#review-box').hidden = false;
        logLine(e.t, `<b>checks</b> ${real.length} findings`);
        break;
      }
      case 'comment:add':
        S.comments.set(e.comment.id, { ...e.comment });
        renderComments();
        logLine(e.t, `<b>comment</b> on ${esc(e.comment.section)}: ${esc(e.comment.text.slice(0, 60))}`); if (!instant) Sound.click(innerWidth / 2);
        break;
      case 'watch':
        S.watching = Boolean(e.on);
        renderComments();
        break;
      case 'done':
        S.stats = e.stats;
        S.timerFixed = e.t;
        if (instant) { S.finaleShown = true; S.mode = 'live'; setPhase('done'); S.agents.forEach((a) => a.cursor.state('gone')); }
        logLine(e.t, `<b>done</b>${e.stats.speedup ? ` ${e.stats.speedup}× vs one agent` : ''}`);
        if (!instant) afterWork();
        break;
      case 'error':
        $('#error').textContent = `Build failed: ${e.message}`;
        $('#error').hidden = false;
        setPhase('error');
        break;
    }
  }

  function renderSlots(plan) {
    root().innerHTML = '';
    plan.sections.forEach((s) => {
      const ag = s.agent || { name: 'Agent', color: '#888' };
      const d = doc.createElement('div');
      d.className = 'sb-slot';
      d.dataset.slot = s.id;
      d.style.setProperty('--c', ag.color);
      d.style.height = `${SLOT_H[s.height] || SLOT_H.medium}px`;
      d.innerHTML = `<div class="sb-slot-label"><b>${esc(ag.name)}</b> · ${esc(s.name)}</div><div class="sb-slot-brief">${esc(s.brief)}</div><div class="sb-slot-bar"><i></i></div>`;
      root().append(d);
    });
  }

  function parseSection(html) {
    const tpl = doc.createElement('template');
    tpl.innerHTML = String(html).trim();
    return tpl.content.querySelector('section') || tpl.content.firstElementChild;
  }
  function placeInstant(a, html) {
    const host = hostOf(a.id);
    const sec = parseSection(html);
    if (!host || !sec) return;
    host.replaceWith(sec);
    try { sec.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 300 }); } catch {}
    a.el = sec;
    a.status = 'done';
    a.cursor.state(S.mode === 'live' ? 'gone' : 'parked');
    agentRow(a);
  }

  // ---------- step extraction ----------
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const sideOn = (cs, side) => parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none' && !transparent(cs[`border${side}Color`]);
  function boxKind(el, cs) {
    const tag = el.localName;
    if (tag === 'hr') return { kind: 'line', side: 'Top' };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return { kind: 'rect' };
    const fill = !transparent(cs.backgroundColor) || (cs.backgroundImage && cs.backgroundImage !== 'none') || (cs.boxShadow && cs.boxShadow !== 'none');
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((s) => sideOn(cs, s));
    if (!fill && sides.length === 1) return { kind: 'line', side: sides[0] };
    if (fill || sides.length) return { kind: 'rect' };
    return null;
  }
  function isTextBlock(el) {
    if (!el.textContent.trim()) return false;
    for (const d of el.querySelectorAll('*')) {
      if (d.closest('svg')) continue;
      if (!INLINE.has(d.localName)) return false;
    }
    return true;
  }
  // Repeated siblings (cards, nav links, rows): same tag and classes, at least 3 of them.
  const signature = (el) => `${el.localName}|${el.className && el.className.baseVal == null ? el.className : ''}|${el.children.length}`;
  function collect(sec) {
    const steps = [], structural = [], dups = [];
    const visit = (el, depth) => {
      if (MEDIA.has(el.localName)) { steps.push({ kind: 'media', el, depth }); return; }
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none') return;
      const box = boxKind(el, cs);
      if (el !== sec && isTextBlock(el)) { steps.push({ kind: box && box.kind === 'rect' ? 'button' : 'text', el, depth }); return; }
      if (box && box.kind === 'line') { steps.push({ kind: 'line', side: box.side, el, depth }); structural.push(el); }
      else if (box) steps.push({ kind: 'rect', el, depth });
      else structural.push(el);
      const kids = [...el.children];
      const groups = new Map();
      kids.forEach((k) => { const g = signature(k); groups.set(g, [...(groups.get(g) || []), k]); });
      for (const k of kids) {
        const g = groups.get(signature(k));
        if (g.length >= 3 && g[0] !== k && k.textContent.trim().length < 600) { dups.push({ kind: 'dup', el: k, master: g[0], prev: g[g.indexOf(k) - 1], depth: depth + 1 }); continue; }
        visit(k, depth + 1);
      }
    };
    visit(sec, 0);
    return { steps, structural, dups };
  }
  const textNodes = (el) => {
    const out = [];
    const w = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  };
  const revealDeep = (el) => { el.style.visibility = 'visible'; el.querySelectorAll('*').forEach((d) => d.style && (d.style.visibility = 'visible')); };
  const fadeIn = (el, extra = {}) => { try { el.animate([{ opacity: 0, ...extra }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'ease-out' }); } catch {} };

  // The left edge most text in the section shares becomes a ruler guide.
  function pickGuide(sec, steps) {
    const base = sec.getBoundingClientRect();
    const counts = new Map();
    for (const s of steps) {
      if (s.kind !== 'text') continue;
      const x = Math.round(s.el.getBoundingClientRect().left);
      if (x - base.left < 8) continue;
      counts.set(x, (counts.get(x) || 0) + 1);
    }
    let best = null;
    counts.forEach((n, x) => { if (n >= 2 && (!best || n > best.n)) best = { x, n }; });
    return best ? best.x : null;
  }

  // ---------- assembling one section ----------
  async function assemble(a, html, outerTok) {
    // A newer submit of the same section cancels this animation.
    const job = (a.job = (a.job || 0) + 1);
    const tok = { live: () => live(outerTok) && a.job === job };
    const host = hostOf(a.id);
    const sec = parseSection(html);
    if (!sec || !host) return;
    const all = [sec, ...sec.querySelectorAll('*')].filter((e) => e.localName === 'svg' || !e.parentElement || !e.parentElement.closest('svg'));
    all.forEach((e) => e.style && (e.style.visibility = 'hidden'));
    host.replaceWith(sec);
    a.el = sec;
    a.status = 'building';
    a.step = 0;
    await sleep(260); // Tailwind's runtime generates classes after the DOM changes
    if (!live(tok)) return;

    const { steps, structural, dups } = collect(sec);
    structural.forEach((e) => (e.style.visibility = 'visible'));
    for (const s of steps) {
      const r = s.el.getBoundingClientRect();
      s.top = r.top; s.left = r.left;
      s.area = r.width * r.height;
      s.chars = s.kind === 'text' || s.kind === 'button' ? s.el.textContent.trim().length : 0;
      s.zero = r.width < 1 || r.height < 1;
    }
    const ordered = steps.filter((s) => !s.zero).sort((x, y) => Math.round(x.top / 6) - Math.round(y.top / 6) || x.depth - y.depth || x.left - y.left);
    // duplicates go right after the last step inside their master
    for (const d of dups) {
      const r = d.el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { revealDeep(d.el); continue; }
      let at = -1;
      ordered.forEach((s, i) => { if (s.el === d.master || d.master.contains(s.el)) at = i; });
      ordered.splice(at + 1, 0, d);
    }
    const rank = [...ordered].sort((x, y) => ((y.area || 0) + (y.chars || 0) * 400) - ((x.area || 0) + (x.chars || 0) * 400));
    rank.forEach((s, i) => { s.instant = s.kind !== 'dup' && (i >= MAX_ANIMATED_STEPS || (s.kind === 'rect' && s.area < 900) || ((s.kind === 'text' || s.kind === 'button') && s.chars < 2)); });
    const dur = (s) => (s.instant ? 0 : 240 + ({
      rect: 380 + Math.min(300, (s.area || 0) / 2000), media: 450, line: 520, dup: 650,
      button: 380 + Math.min(900, s.chars * 22), text: Math.min(1400, Math.max(300, s.chars * 22)),
    }[s.kind] || 300));
    const guideX = pickGuide(sec, ordered);
    const total = ordered.reduce((n, s) => n + dur(s), 0) + (guideX != null ? 900 : 0) || 1;
    const k = Math.min(1, (a.reason === 'build' ? SECTION_BUDGET_MS : SECTION_BUDGET_MS * 0.6) / total) / S.speed;
    a.steps = ordered.length;
    let guide = null;

    for (const s of ordered) {
      if (!live(tok)) return;
      a.step++;
      if (s.instant) { revealDeep(s.el); continue; }
      if (guideX != null && !guide && s.kind === 'text' && Math.round(s.el.getBoundingClientRect().left) === guideX) {
        guide = await dragGuide(a, sec, guideX, 900 * k, tok);
      }
      await runStep(a, s, dur(s) * k, tok, guide);
    }
    all.forEach((e) => e.style && (e.style.visibility = ''));
    if (guide) { guide.el.classList.add('fade'); setTimeout(() => { guide.el.remove(); S.guides = S.guides.filter((g) => g !== guide); }, 600); }
    a.status = 'done';
    a.cursor.tool('arrow');
    a.cursor.say(`done${a.ms ? ` · ${fmtS(a.ms)}` : ''}`);
    Sound.note(rectOf(sec).left + 40, 0.15);
    await a.cursor.travel(() => { const r = rectOf(sec); return { x: r.right - Math.min(140, r.width / 3), y: r.top + 16 }; }, 400 / S.speed, tok);
    a.cursor.state('parked');
  }

  async function dragGuide(a, sec, x, ms, tok) {
    const c = a.cursor;
    const lr = rulerLeft.getBoundingClientRect();
    c.tool('arrow');
    c.say('guide');
    await c.travel(() => ({ x: lr.left + 9, y: clamp(rectOf(sec).top + 40, lr.top + 30, lr.bottom - 30) }), ms * 0.35, tok);
    const g = { sec, x, el: make('guide', '#ef4444', '<span></span>') };
    S.guides.push(g);
    Sound.click(c.x);
    const startX = lr.left + 9;
    await tween(ms * 0.65, (p) => {
      const tx = lerp(startX, stageX(x), ease(p));
      g.drawX = tx;
      c.move(tx, c.y);
      g.el.firstChild.textContent = `${Math.round((tx - stageX(0)) / S.scale)}`;
    }, tok);
    g.drawX = null;
    return g;
  }

  async function runStep(a, s, d, tok, guide) {
    const el = s.el, c = a.cursor;
    const travel = Math.min(260, d * 0.3);
    const work = d - travel;
    const rect = () => rectOf(el);

    if (s.kind === 'rect' || s.kind === 'button') {
      c.tool('cross');
      c.say(s.kind === 'button' ? 'button' : `<${el.localName}>`);
      await c.travel(() => { const r = rect(); return { x: r.left, y: r.top }; }, travel, tok);
      const box = makeBox(a.color);
      const dim = box.firstChild;
      Sound.click(c.x);
      await tween(s.kind === 'button' ? work * 0.4 : work, (p) => {
        const r = rect(); const e = ease(p);
        place(box, r.left, r.top, r.width * e, r.height * e);
        dim.textContent = `${Math.round(r.iw * e)} × ${Math.round(r.ih * e)}`;
        c.move(r.left + r.width * e, r.top + r.height * e);
      }, tok);
      box.remove();
      el.style.visibility = 'visible';
      Sound.note(c.x, clamp((s.area || 0) / 400000, 0, 1));
      if (s.kind === 'rect') { fadeIn(el); return; }
      await typeInto(a, el, work * 0.6, tok, false);
      return;
    }
    if (s.kind === 'text') {
      c.tool('ibeam');
      c.say('text');
      await c.travel(() => { const r = rect(); return { x: r.left, y: r.top }; }, travel * 0.8, tok);
      // drag the text box first, then type into it
      const box = makeBox(a.color, 'textbox');
      await tween(Math.min(240, work * 0.18), (p) => {
        const r = rect(); const e = easeOut(p);
        place(box, r.left, r.top, r.width * e, r.height * e);
        c.move(r.left + r.width * e, r.top + r.height * e);
      }, tok);
      if (guide && Math.round(el.getBoundingClientRect().left) === guide.x) {
        // snap onto the guide: the box starts a few px off and clicks into place
        Sound.snap(c.x);
        guide.el.classList.add('hit');
        setTimeout(() => guide.el.classList.remove('hit'), 300);
      }
      c.say('typing');
      await typeInto(a, el, work * 0.82, tok, true, box);
      box.remove();
      return;
    }
    if (s.kind === 'line') {
      c.tool('pen');
      c.say('pen');
      const ends = () => {
        const r = rect();
        if (s.side === 'Left') return [{ x: r.left, y: r.top }, { x: r.left, y: r.bottom }];
        if (s.side === 'Right') return [{ x: r.right, y: r.top }, { x: r.right, y: r.bottom }];
        if (s.side === 'Bottom') return [{ x: r.left, y: r.bottom }, { x: r.right, y: r.bottom }];
        return [{ x: r.left, y: r.top }, { x: r.right, y: r.top }];
      };
      await c.travel(() => ends()[0], travel, tok);
      const a1 = make('anchor', a.color), a2 = make('anchor', a.color), line = make('penline', a.color);
      Sound.click(c.x);
      await tween(work * 0.8, (p) => {
        const [p0, p1] = ends();
        const x = lerp(p0.x, p1.x, ease(p)), y = lerp(p0.y, p1.y, ease(p));
        a1.style.transform = `translate(${p0.x - 4}px, ${p0.y - 4}px)`;
        a2.style.transform = `translate(${x - 4}px, ${y - 4}px)`;
        const len = Math.hypot(x - p0.x, y - p0.y);
        const ang = Math.atan2(y - p0.y, x - p0.x);
        Object.assign(line.style, { width: `${len}px`, transform: `translate(${p0.x}px, ${p0.y}px) rotate(${ang}rad)` });
        c.move(x, y);
      }, tok);
      Sound.click(c.x);
      el.style.visibility = 'visible';
      [a1, a2, line].forEach((n) => n.remove());
      return;
    }
    if (s.kind === 'dup') {
      // alt-drag a copy of the master into place, with red spacing between it and the previous item
      const m = s.master;
      c.tool('copy');
      c.say('⌥ duplicate');
      await c.travel(() => { const r = rectOf(m); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, travel, tok);
      const ghost = make('dupghost', a.color);
      const meas = make('measure', '#ef4444', '<span></span>');
      Sound.click(c.x);
      await tween(work * 0.6, (p) => {
        const mr = rectOf(m), tr = rect();
        const e = ease(p);
        const x = lerp(mr.left, tr.left, e), y = lerp(mr.top, tr.top, e);
        place(ghost, x, y, tr.width, tr.height);
        c.move(x + tr.width / 2, y + tr.height / 2);
        const pr = s.prev ? rectOf(s.prev) : mr;
        const horizontal = Math.abs(tr.top - pr.top) < Math.abs(tr.left - pr.left);
        if (horizontal) {
          const x0 = pr.right, x1 = x;
          place(meas, Math.min(x0, x1), y + tr.height / 2, Math.abs(x1 - x0), 1);
          meas.dataset.dir = 'h';
          meas.firstChild.textContent = `${Math.round(Math.abs(x1 - x0) / S.scale)}`;
        } else {
          const y0 = pr.bottom, y1 = y;
          place(meas, x + tr.width / 2, Math.min(y0, y1), 1, Math.abs(y1 - y0));
          meas.dataset.dir = 'v';
          meas.firstChild.textContent = `${Math.round(Math.abs(y1 - y0) / S.scale)}`;
        }
      }, tok);
      ghost.remove();
      meas.remove();
      Sound.note(c.x, 0.6);
      // the copy appears, then its own text is retyped quickly
      const nodes = textNodes(el);
      const orig = nodes.map((n) => n.data);
      nodes.forEach((n) => (n.data = ''));
      revealDeep(el);
      fadeIn(el);
      const total = orig.reduce((x, t) => x + t.length, 0);
      c.tool('ibeam');
      await tween(Math.min(work * 0.4, 600), (p) => {
        let left = Math.round(total * p);
        nodes.forEach((node, i) => { const take = Math.min(orig[i].length, Math.max(0, left)); left -= take; node.data = orig[i].slice(0, take); });
        if (p < 1 && Math.random() < 0.5) Sound.key(c.x);
      }, tok);
      nodes.forEach((node, i) => (node.data = orig[i]));
      return;
    }
    // media: placeholder, then reveal
    c.tool('cross');
    c.say(el.localName === 'svg' ? 'drawing svg' : 'media');
    await c.travel(() => { const r = rect(); return { x: r.left, y: r.top }; }, travel, tok);
    const box = makeBox(a.color, 'media');
    box.firstChild.textContent = el.localName;
    await tween(work * 0.65, (p) => { const r = rect(); const e = ease(p); place(box, r.left, r.top, r.width * e, r.height * e); c.move(r.left + r.width * e, r.top + r.height * e); }, tok);
    box.remove();
    revealDeep(el);
    fadeIn(el, { transform: 'scale(.94)', clipPath: 'inset(0 0 100% 0)' });
    Sound.note(c.x, 0.5);
    await sleep(work * 0.35);
  }

  async function typeInto(a, el, ms, tok, caret = true, box = null) {
    const c = a.cursor;
    const cs = win.getComputedStyle(el);
    const prev = { minHeight: el.style.minHeight, minWidth: el.style.minWidth, fontSize: el.style.fontSize };
    if (cs.display !== 'inline') { el.style.minHeight = `${el.offsetHeight}px`; el.style.minWidth = `${el.offsetWidth}px`; }
    const fs = parseFloat(cs.fontSize) || 16;
    const grow = fs >= 28; // big headings start small and step up to size while typing
    const nodes = textNodes(el);
    const orig = nodes.map((n) => n.data);
    const lens = orig.map((t) => t.length);
    const totalChars = lens.reduce((x, y) => x + y, 0);
    const joined = orig.join('');
    nodes.forEach((n) => (n.data = ''));
    revealDeep(el);
    const car = caret ? make('caret', a.color) : null;
    const lineH = parseFloat(cs.lineHeight) || fs * 1.3 || 20;
    let typed = 0, lastStep = -1;
    const fill = (n) => {
      let left = n;
      nodes.forEach((node, i) => { const take = Math.max(0, Math.min(lens[i], left)); left -= take; const want = orig[i].slice(0, take); if (node.data !== want) node.data = want; });
    };
    // where the caret goes: the end of the last typed character
    const caretPos = () => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!n.data.length) continue;
        const range = doc.createRange();
        range.setStart(n, n.data.length - 1);
        range.setEnd(n, n.data.length);
        const rr = range.getClientRects();
        const last = rr[rr.length - 1];
        if (last) {
          const f = iframe.getBoundingClientRect();
          return { x: f.left + last.right * S.scale, y: f.top + last.top * S.scale, h: last.height * S.scale };
        }
      }
      const r = rectOf(el);
      return { x: r.left, y: r.top, h: lineH * S.scale };
    };
    await tween(ms, (p) => {
      const n = Math.round(totalChars * p);
      fill(n);
      if (grow) {
        const step = Math.min(6, Math.floor(p * 7));
        el.style.fontSize = `${Math.round(lerp(18, fs, Math.min(1, step / 6)))}px`;
        if (step !== lastStep) { lastStep = step; if (step > 0) Sound.tick(step); }
      }
      const pos = caretPos();
      c.move(pos.x + 2, pos.y + pos.h / 2);
      if (car) place(car, pos.x, pos.y, Math.max(1.5, 2 * S.scale), pos.h);
      if (box) { const r = rectOf(el); place(box, r.left, r.top, r.width, r.height); }
      if (n > typed) { Sound.key(c.x, (joined[n - 1] || ' ') === ' '); typed = n; }
    }, tok);
    fill(totalChars);
    el.style.minHeight = prev.minHeight;
    el.style.minWidth = prev.minWidth;
    el.style.fontSize = prev.fontSize;
    if (car) { car.classList.add('blink'); await sleep(Math.min(260, ms * 0.15)); car.remove(); }
  }

  // ---------- after work: finale or back to live ----------
  function busy() { return S.animating > 0 || [...S.agents.values()].some((a) => a.status === 'thinking' || a.status === 'building'); }
  function afterWork() {
    if (busy()) return;
    if (S.stats && !S.finaleShown) return showFinale();
    if (S.finaleShown) { S.mode = 'live'; setPhase(S.watching ? 'listening' : 'done'); S.agents.forEach((a) => a.cursor.state('gone')); }
  }
  function showFinale() {
    S.finaleShown = true;
    S.mode = 'done';
    setPhase('done');
    const st = S.stats;
    $('#f-wall').textContent = fmtS((st.planMs || 0) + (st.buildWallMs || 0));
    $('#f-line').textContent = `${st.sections} sections built at the same time in ${fmtS(st.buildWallMs)}.`;
    $('#f-agents').textContent = String(st.built ?? st.sections);
    $('#f-seq').textContent = st.sumMs ? fmtS(st.sumMs) : '—';
    $('#f-speed').textContent = st.speedup ? `${st.speedup}×` : '—';
    $('#f-sections').textContent = String(st.sections);
    $('#finale').hidden = false;
    Sound.chord();
    S.flocking = true; // cursors gather around your mouse until you go live
    S.agents.forEach((a) => { a.cursor.state(); a.cursor.tool('arrow'); a.cursor.say(''); });
    if (S.autolive) setTimeout(() => goLive(), 2600);
  }

  async function goLive() {
    const tok = S.token;
    $('#finale').hidden = true;
    S.mode = 'live';
    S.flocking = false;
    setPhase(S.watching ? 'listening' : 'live');
    Sound.sweep();
    S.agents.forEach((a) => a.cursor.state('gone'));
    await sleep(700);
    if (!live(tok)) return;
    if (S.autolive) {
      canvas.scrollTop = 0;
      await sleep(800);
      const max = () => canvas.scrollHeight - canvas.clientHeight;
      await tween(clamp(max() * 3.2, 5000, 16000), (p) => { canvas.scrollTop = max() * (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2); }, tok);
      await sleep(900);
      window.__swarmDone = true;
    }
  }

  // ---------- replay (only on request) ----------
  // Long idle gaps (a person thinking, an agent between steps) are squeezed to MAX_GAP so replays stay watchable.
  const MAX_GAP = 3000;
  function replay(evs = S.events.slice()) {
    const watching = S.watching;
    reset();
    S.watching = watching;
    const tok = S.token;
    S.replaying = true;
    S.replayStart = performance.now();
    let prev = 0, shift = 0;
    evs = evs.filter((e) => e.type !== 'watch').map((e) => { const t = e.t || 0; if (t - prev > MAX_GAP) shift += t - prev - MAX_GAP; prev = t; return { ...e, t: t - shift }; });
    evs.forEach((e) => S.timers.push(setTimeout(() => {
      if (!live(tok)) return;
      if (e.type === 'done') S.timerFixed = e.t;
      handle(e);
    }, e.t / S.speed)));
    const end = evs.length ? (evs[evs.length - 1].t || 0) / S.speed + 20 : 0;
    S.timers.push(setTimeout(() => { if (!live(tok)) return; S.replaying = false; S.queue.splice(0).forEach((e) => handle(e)); }, end));
  }

  // ---------- comments ----------
  function setCommenting(on) {
    if (EMBED) return;
    S.commenting = on;
    document.body.classList.toggle('commenting', on);
    $('#comment-toggle').setAttribute('aria-pressed', String(on));
    hideSectionBar();
    if (!on) { hideHover(); closePopover(); }
    else { $('#finale').hidden = true; if (S.mode === 'done') { S.mode = 'live'; S.flocking = false; } S.agents.forEach((a) => a.status === 'done' && a.cursor.state('gone')); }
  }
  function hideHover() { overlay.querySelector('.hoverbox')?.remove(); S.hoverEl = null; }
  function pickTarget(t) {
    let el = t && t.nodeType === 1 ? t : t?.parentElement;
    if (!el || !el.closest('[data-section]')) return null;
    if (el.closest('svg') && el.localName !== 'svg') el = el.closest('svg');
    return el;
  }
  function describe(el) {
    const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 70);
    return `<${el.localName}>${text ? ` "${text}"` : ''}`;
  }
  function pathWithin(el, sec) {
    if (el === sec) return '';
    const parts = [];
    for (let n = el; n && n !== sec; n = n.parentElement) {
      const sibs = [...n.parentElement.children].filter((x) => x.localName === n.localName);
      parts.unshift(sibs.length > 1 ? `${n.localName}:nth-of-type(${sibs.indexOf(n) + 1})` : n.localName);
    }
    return `:scope > ${parts.join(' > ')}`;
  }
  function onStageMove(e) {
    const f = iframe.getBoundingClientRect();
    S.mouse = { x: f.left + e.clientX * S.scale, y: f.top + e.clientY * S.scale };
    if (S.commenting) {
      if (!$('#popover').hidden) return;
      const el = pickTarget(e.target);
      if (!el) return hideHover();
      S.hoverEl = el;
      let box = overlay.querySelector('.hoverbox');
      if (!box) box = make('hoverbox', null, '<span></span>');
      box.firstChild.textContent = `${el.closest('[data-section]').dataset.section} › ${el.localName}`;
      return;
    }
    const sec = e.target.closest && e.target.closest('[data-section]');
    if (sec && !busy() && !EMBED) showSectionBar(sec.dataset.section);
  }
  function onStageClick(e) {
    Sound.unlock();
    const a = e.target.closest && e.target.closest('a');
    if (S.commenting) {
      e.preventDefault(); e.stopPropagation();
      const el = pickTarget(e.target);
      if (el) openPopover(el);
      return;
    }
    if (a) {
      e.preventDefault();
      const id = (a.getAttribute('href') || '').startsWith('#') ? a.getAttribute('href').slice(1) : null;
      const target = id && doc.getElementById(id);
      if (target) { const r = rectOf(target); canvas.scrollTo({ top: canvas.scrollTop + r.top - canvas.getBoundingClientRect().top, behavior: 'smooth' }); }
    }
  }
  function openPopover(el, sectionId) {
    const sec = el.closest('[data-section]');
    S.popTarget = { el, section: sectionId || sec.dataset.section, target: describe(el), path: sec ? pathWithin(el, sec) : '' };
    $('#pop-target').textContent = `${S.popTarget.section} · ${S.popTarget.target}`;
    const r = rectOf(el);
    const pop = $('#popover');
    pop.hidden = false;
    pop.style.left = `${clamp(r.left, 8, innerWidth - 316)}px`;
    pop.style.top = `${clamp(r.top + 40, 64, innerHeight - 170)}px`;
    $('#pop-text').value = '';
    $('#pop-text').focus();
  }
  function closePopover() { $('#popover').hidden = true; S.popTarget = null; }
  async function submitComment(ev) {
    ev.preventDefault();
    const text = $('#pop-text').value.trim();
    if (!text || !S.popTarget) return;
    const { section, target, path } = S.popTarget;
    closePopover();
    const r = await fetch('api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section, target, path, text }) });
    if (!r.ok) showError(`Comment failed: ${(await r.json().catch(() => ({}))).error || r.status}`);
  }
  // Without `swarm-build watch` running, copy a request the user pastes into their agent's chat.
  const AGENT_REQUEST = 'Apply the swarm-build comments: run `npx -y swarm-build watch` and follow the skill.';
  async function applyComments() {
    const msg = $('#apply-msg');
    msg.hidden = false;
    try {
      await navigator.clipboard.writeText(AGENT_REQUEST);
      msg.textContent = 'Copied. Paste it to your coding agent; its sub-agents rebuild the commented sections here.';
    } catch {
      msg.textContent = `Tell your coding agent: "${AGENT_REQUEST}"`;
    }
    setCommenting(false);
  }
  function showError(t) { const e = $('#error'); e.textContent = t; e.hidden = false; setTimeout(() => (e.hidden = true), 5000); }

  // ---------- section toolbar: code, history, undo, comment ----------
  let barHideTimer = null;
  function showSectionBar(id) {
    if (S.commenting || !S.plan) return;
    clearTimeout(barHideTimer);
    S.sectionHover = id;
    const s = S.plan.sections.find((x) => x.id === id);
    $('#sb-name').textContent = s ? s.name : id;
    $('#section-bar').hidden = false;
  }
  function hideSectionBar() { $('#section-bar').hidden = true; S.sectionHover = null; }
  async function sectionAction(act) {
    const id = S.sectionHover;
    if (!id) return;
    if (act === 'comment') { setCommenting(true); const sec = doc.querySelector(`[data-section="${css(id)}"]`); if (sec) openPopover(sec, id); return; }
    if (act === 'undo') {
      const r = await fetch('api/section/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) showError(j.error || 'Nothing to undo');
      return;
    }
    const r = await fetch(`api/section?id=${encodeURIComponent(id)}`);
    const j = await r.json();
    if (!r.ok) return showError(j.error || 'Section not found');
    if (act === 'code') openModal(`${id} · code`, [{ label: 'HTML', text: j.html }, { label: 'JSX', text: j.jsx }]);
    if (act === 'history') openHistory(id, j.versions);
  }
  function openModal(title, tabs) {
    $('#modal-title').textContent = title;
    const tabsEl = $('#modal-tabs');
    tabsEl.innerHTML = tabs.map((t, i) => `<button type="button" data-i="${i}" aria-pressed="${i === 0}">${esc(t.label)}</button>`).join('');
    tabsEl.hidden = tabs.length < 2;
    let current = 0;
    const show = (i) => {
      current = i;
      tabsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.i) === i)));
      const t = tabs[i];
      $('#modal-body').innerHTML = t.html != null ? t.html : `<pre><code>${esc(t.text)}</code></pre>`;
    };
    tabsEl.onclick = (e) => { const b = e.target.closest('button'); if (b) show(Number(b.dataset.i)); };
    $('#modal-copy').hidden = tabs.every((t) => t.text == null);
    $('#modal-copy').onclick = async () => { try { await navigator.clipboard.writeText(tabs[current].text || ''); $('#modal-copy').textContent = 'Copied'; setTimeout(() => ($('#modal-copy').textContent = 'Copy'), 1200); } catch { showError('Copy failed'); } };
    show(0);
    $('#modal').hidden = false;
  }
  function openHistory(id, versions) {
    const rows = [...versions].reverse().map((v, i) => `<li><b>v${v.n}</b> <span>${esc(v.reason || '')}</span> <time>${v.at ? new Date(v.at).toLocaleTimeString() : ''}</time>
      <a href="api/section/version?id=${encodeURIComponent(id)}&n=${v.n}" target="_blank" rel="noopener">view</a>
      ${i === 0 ? '<em>current</em>' : `<button type="button" data-restore="${v.n}">Restore</button>`}</li>`).join('');
    openModal(`${id} · history`, [{ label: 'Versions', html: `<ol class="history">${rows || '<li>No versions yet.</li>'}</ol>` }]);
    $('#modal-body').onclick = async (e) => {
      const b = e.target.closest('[data-restore]');
      if (!b) return;
      const r = await fetch('api/section/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, n: Number(b.dataset.restore) }) });
      if (r.ok) $('#modal').hidden = true; else showError('Restore failed');
    };
  }

  // ---------- tour, hide, follow ----------
  function stopTour() { if (S.tour) { S.tour = false; $('#tour').setAttribute('aria-pressed', 'false'); } }

  // ---------- frame loop ----------
  function frame(now) {
    if (doc && root()) {
      const w = S.width;
      const building = S.mode === 'build' || S.mode === 'planning';
      const fitW = Math.min(1, (canvas.clientWidth - 64) / w);
      const stageH = Math.max(root().offsetHeight, 720);
      const fitH = (canvas.clientHeight - 64 - 32) / stageH;
      const minScale = w <= 400 ? 0.6 : w <= 800 ? 0.5 : 0.42;
      const target = building ? clamp(fitH, Math.min(minScale, fitW), fitW) : fitW;
      S.scale = Math.abs(target - S.scale) < 0.001 ? target : lerp(S.scale, target, 0.08);
      setStyle(iframe, 'width', `${w}px`);
      setStyle(iframe, 'height', `${stageH}px`);
      setStyle(iframe, 'transform', `scale(${S.scale})`);
      setStyle(frameBody, 'width', `${w * S.scale}px`);
      setStyle(frameBody, 'height', `${stageH * S.scale}px`);
      setStyle($('#frame'), 'width', `${w * S.scale}px`);
      setText($('#frame-width'), `${w}px`);

      const anyBuilding = [...S.agents.values()].some((a) => a.status === 'building');
      layoutRulers(anyBuilding);
      S.guides.forEach((g) => {
        const r = rectOf(g.sec);
        const x = g.drawX ?? stageX(g.x);
        place(g.el, x, r.top, 1, r.height);
      });

      const t = now / 1000;
      if (S.planner && S.mode === 'planning') {
        const r = canvas.getBoundingClientRect();
        S.planner.move(r.left + r.width / 2 + Math.cos(t * 1.6) * 160, r.top + r.height * 0.42 + Math.sin(t * 2.1) * 70);
      }
      const followY = [];
      const list = [...S.agents.values()];
      list.forEach((a, i) => {
        const c = a.cursor;
        if (a.status === 'thinking') {
          const host = hostOf(a.id);
          if (host) {
            const r = rectOf(host);
            let tx = r.left + r.width * (0.55 + 0.28 * Math.sin(t * 0.9 + a.phase));
            let ty = r.top + Math.min(r.height, 300 * S.scale) * (0.55 + 0.25 * Math.cos(t * 1.3 + a.phase));
            // shy of your mouse
            const dx = tx - S.mouse.x, dy = ty - S.mouse.y, dist = Math.hypot(dx, dy);
            if (dist < 70) { tx += (dx / (dist || 1)) * (70 - dist); ty += (dy / (dist || 1)) * (70 - dist); }
            c.move(lerp(c.x, tx, 0.07), lerp(c.y, ty, 0.07));
            if (a.rework) place(a.rework, r.left, r.top, r.width, r.height);
          }
          c.say(a.reason === 'build' ? `thinking${a.chars ? ` · ${fmtK(a.chars)} chars` : '…'}` : `${REASON[a.reason]}${a.note ? `: ${a.note.slice(0, 40)}` : ''}`);
          followY.push({ id: a.id, y: c.y });
        }
        if (a.status === 'building') followY.push({ id: a.id, y: c.y });
        if (S.flocking && a.status === 'done') {
          // boids-lite: orbit the mouse, keep apart from each other
          const hasMouse = S.mouse.x > 0;
          const cx = hasMouse ? S.mouse.x : canvas.getBoundingClientRect().left + canvas.clientWidth / 2;
          const cy = hasMouse ? S.mouse.y : canvas.getBoundingClientRect().top + canvas.clientHeight / 2;
          const ang = t * 0.9 + (i / list.length) * Math.PI * 2;
          let tx = cx + Math.cos(ang) * 90, ty = cy + Math.sin(ang) * 60;
          list.forEach((b) => { if (b === a) return; const dx = c.x - b.cursor.x, dy = c.y - b.cursor.y, d = Math.hypot(dx, dy); if (d < 40 && d > 0) { tx += (dx / d) * 20; ty += (dy / d) * 20; } });
          c.vx = lerp(c.vx, (tx - c.x) * 0.08, 0.2);
          c.vy = lerp(c.vy, (ty - c.y) * 0.08, 0.2);
          c.move(c.x + c.vx, c.y + c.vy);
        }
        agentRow(a);
      });
      // comment pins and hover box follow their elements
      S.comments.forEach((c) => {
        const pin = overlay.querySelector(`.pin[data-id="${css(c.id)}"]`);
        const el = commentEl(c);
        if (!pin || !el) return;
        const r = rectOf(el);
        setStyle(pin, 'transform', `translate(${Math.round(r.left + 4)}px, ${Math.round(r.top + 4)}px)`);
      });
      if (S.hoverEl) {
        const box = overlay.querySelector('.hoverbox');
        if (box && S.hoverEl.isConnected) { const r = rectOf(S.hoverEl); place(box, r.left, r.top, r.width, r.height); } else hideHover();
      }
      if (S.sectionHover) {
        const sec = doc.querySelector(`[data-section="${css(S.sectionHover)}"]`);
        if (!sec || busy()) hideSectionBar();
        else {
          const r = rectOf(sec);
          const cr = canvas.getBoundingClientRect();
          const bar = $('#section-bar');
          bar.style.transform = `translate(${Math.min(r.right, cr.right - 12) - bar.offsetWidth - 8}px, ${clamp(r.top + 8, cr.top + 8, cr.bottom - 40)}px)`;
        }
      }
      // camera: tour, a followed agent, or the average of the agents at work
      if (S.tour) {
        const max = canvas.scrollHeight - canvas.clientHeight;
        canvas.scrollTop = Math.min(max, canvas.scrollTop + 1.6 * S.speed);
        if (canvas.scrollTop >= max - 1 && !building) stopTour();
      } else if (now - S.userScrollAt > 2500) {
        const pick = S.follow ? followY.filter((f) => f.id === S.follow) : followY;
        if (pick.length) {
          const cr = canvas.getBoundingClientRect();
          const avg = pick.reduce((x, f) => x + f.y, 0) / pick.length;
          const d = (avg - cr.top) - canvas.clientHeight * 0.45;
          if (Math.abs(d) > 4) canvas.scrollTop += d * 0.05;
        }
      }
    }
    // timer: live run time, frozen at the moment the build finished
    let ms = null;
    if (S.timerFixed != null) ms = S.timerFixed;
    else if (S.replaying) ms = (performance.now() - S.replayStart) * S.speed;
    else if (S.runStart != null) ms = performance.now() - S.runStart;
    if (ms != null) setText($('#timer'), fmtS(ms));
    const snd = $('#sound');
    setText(snd, Sound.on ? (Sound.locked ? '🔈' : '🔊') : '🔇');
    const title = Sound.on ? (Sound.locked ? 'Click anywhere to turn sound on (M)' : 'Sound on (M)') : 'Sound off (M)';
    if (snd.title !== title) snd.title = title;
    requestAnimationFrame(frame);
  }

  // ---------- wiring ----------
  function onKey(e) {
    if (e.target.closest && e.target.closest('textarea, input')) { if (e.key === 'Escape') closePopover(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'c') setCommenting(!S.commenting);
    if (k === 'm') { Sound.toggle(); $('#sound').setAttribute('aria-pressed', String(Sound.on)); }
    if (k === 'h') document.body.classList.toggle('clean');
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) $('#modal').hidden = true;
      else if (!$('#popover').hidden) closePopover();
      else if (document.body.classList.contains('clean')) document.body.classList.remove('clean');
      else setCommenting(false);
    }
  }
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', () => Sound.unlock(), true);
  document.addEventListener('mousemove', (e) => {
    S.mouse = { x: e.clientX, y: e.clientY };
    if (document.body.classList.contains('clean') && e.clientY < 8) document.body.classList.remove('clean');
  });
  canvas.addEventListener('wheel', () => { S.userScrollAt = performance.now(); stopTour(); }, { passive: true });
  canvas.addEventListener('mouseleave', () => { barHideTimer = setTimeout(hideSectionBar, 400); });
  $('#section-bar').addEventListener('mouseenter', () => clearTimeout(barHideTimer));
  $('#section-bar').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) sectionAction(b.dataset.act); });
  $('#modal-close').addEventListener('click', () => ($('#modal').hidden = true));
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });
  document.querySelectorAll('[data-speed]').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === S.speed));
    b.addEventListener('click', () => { S.speed = Number(b.dataset.speed); document.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
  });
  const setWidth = (w) => {
    S.width = clamp(Math.round(w), 320, 1920);
    document.querySelectorAll('[data-width]').forEach((x) => x.setAttribute('aria-pressed', String(Number(x.dataset.width) === S.width)));
  };
  document.querySelectorAll('[data-width]').forEach((b) => b.addEventListener('click', () => setWidth(Number(b.dataset.width))));
  setWidth(S.width);
  // drag the frame edge to any width
  $('#resize').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = S.width, s = S.scale;
    const move = (ev) => setWidth(startW + ((ev.clientX - startX) * 2) / s);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
    document.body.classList.add('resizing');
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  $('#agents').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    S.follow = S.follow === li.dataset.id ? null : li.dataset.id;
    S.userScrollAt = 0;
    stopTour();
    const a = S.agents.get(li.dataset.id);
    if (a && a.el && !busy()) { const r = rectOf(a.el); canvas.scrollTo({ top: canvas.scrollTop + r.top - canvas.getBoundingClientRect().top - 40, behavior: 'smooth' }); }
  });
  $('#sound').addEventListener('click', () => { if (Sound.on && Sound.locked) Sound.unlock(); else Sound.toggle(); $('#sound').setAttribute('aria-pressed', String(Sound.on)); });
  $('#tour').addEventListener('click', () => { S.tour = !S.tour; $('#tour').setAttribute('aria-pressed', String(S.tour)); if (S.tour && canvas.scrollTop >= canvas.scrollHeight - canvas.clientHeight - 2) canvas.scrollTop = 0; });
  $('#hide').addEventListener('click', () => document.body.classList.add('clean'));
  $('#go-live').addEventListener('click', goLive);
  $('#replay').addEventListener('click', () => replay());
  $('#replay-top').addEventListener('click', () => replay());
  $('#comment-toggle').addEventListener('click', () => setCommenting(!S.commenting));
  $('#comment-now').addEventListener('click', () => { goLive(); setCommenting(true); });
  $('#popover').addEventListener('submit', submitComment);
  $('#pop-cancel').addEventListener('click', closePopover);
  $('#apply').addEventListener('click', applyComments);
  $('#comments').addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    const c = S.comments.get(li.dataset.id); const el = c && commentEl(c); if (!el) return;
    const r = rectOf(el);
    canvas.scrollTo({ top: canvas.scrollTop + r.top - canvas.getBoundingClientRect().top - 80, behavior: 'smooth' });
  });

  // ---------- event intake ----------
  // ?replay=1: collect the saved run first, then play it back with its original timing.
  let replayTimer = null, replayStarted = false;
  function intake(e) {
    if (e.type === 'hello') return;
    if (params.get('replay') === '1' && !replayStarted && e.type !== 'reset') {
      if (e.type === 'sync') return;
      if (e.seq != null && e.seq <= S.received) return;
      if (e.seq != null) S.received = e.seq;
      S.events.push(e);
      clearTimeout(replayTimer);
      replayTimer = setTimeout(() => { replayStarted = true; const go = () => (S.ready ? replay(S.events.slice()) : setTimeout(go, 100)); go(); }, 400);
      return;
    }
    if (e.type === 'reset') { S.events = []; S.received = -1; S.replaying = false; S.catchingUp = false; reset(); return; }
    if (e.type === 'sync') {
      // Everything so far happened before this page opened: it's on screen already. Now go live.
      const finishSync = () => {
        S.catchingUp = false;
        if (e.elapsed != null && S.timerFixed == null) S.runStart = performance.now() - e.elapsed;
        if (S.stats && !busy()) { S.finaleShown = true; S.mode = 'live'; setPhase(S.watching ? 'listening' : 'done'); S.agents.forEach((a) => a.cursor.state('gone')); }
      };
      if (!S.ready) S.queue.push({ type: '__sync', run: finishSync }); else finishSync();
      return;
    }
    if (e.seq != null && e.seq <= S.received) return;
    if (e.seq != null) S.received = e.seq;
    S.events.push(e);
    if (!S.ready || S.replaying) { S.queue.push(e); return; }
    handle(e, S.catchingUp);
  }
  function drainQueue() {
    S.queue.splice(0).forEach((e) => (e.type === '__sync' ? e.run() : handle(e, S.catchingUp)));
  }

  setupStage().then(() => {
    S.ready = true;
    reset();
    if (EMBED) {
      $('#comment-toggle').hidden = true;
      $('#comments-box').hidden = true;
      if (EMBED.page) { const url = URL.createObjectURL(new Blob([EMBED.page], { type: 'text/html' })); $('#open-page').href = url; $('#open-page-bar').href = url; }
      S.events = EMBED.events.slice();
      replay(S.events);
      return;
    }
    drainQueue();
  });
  requestAnimationFrame(frame);

  if (!EMBED) {
    const es = new EventSource('events');
    es.onopen = () => { if (S.mode === 'idle') setPhase('waiting'); };
    es.onmessage = (m) => intake(JSON.parse(m.data));
    es.onerror = () => setPhase('reconnecting');
    // The heartbeat is the source of truth for "your agent is listening" (a killed watch never sends "off").
    setInterval(async () => {
      try {
        const j = await (await fetch('api/run')).json();
        if (Boolean(j.watching) !== S.watching) { S.watching = Boolean(j.watching); renderComments(); if (S.mode === 'live') setPhase(S.watching ? 'listening' : 'done'); }
      } catch { /* server gone */ }
    }, 4000);
  }
})();
