// swarm-build preview: original cursor engine.
// Listens to the build event stream and animates each agent assembling its real section.
(() => {
  'use strict';
  const STAGE_W = 1280;
  const MIN_SCALE = 0.42;
  const SECTION_BUDGET_MS = 9000; // animation time per section at 1x
  const MAX_ANIMATED_STEPS = 70;
  const SLOT_H = { short: 140, medium: 460, tall: 700 };
  const INLINE = new Set(['a', 'span', 'strong', 'em', 'b', 'i', 'u', 'br', 'small', 'code', 'mark', 'sup', 'sub', 'abbr', 'time', 's', 'del', 'ins', 'kbd', 'label', 'q', 'cite', 'wbr']);
  const MEDIA = new Set(['svg', 'img', 'video', 'canvas', 'picture']);

  const $ = (s) => document.querySelector(s);
  const canvas = $('#canvas'), frameBody = $('#frame-body'), stage = $('#stage'), overlay = $('#overlay');
  const params = new URLSearchParams(location.search);

  const S = {
    speed: Math.min(3, Math.max(1, Number(params.get('speed')) || 1)),
    autolive: params.get('autolive') === '1',
    events: [], received: -1, timers: [], token: 0,
    mode: 'idle', scale: 1, plan: null, meta: null, stats: null,
    agents: new Map(), planner: null, animating: 0, clock: null, clockStop: null,
    userScrollAt: 0, finaleShown: false,
  };
  window.__swarm = S;

  // ---------- small helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const live = (tok) => tok === S.token;

  function tween(ms, fn, tok) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (!live(tok)) return resolve(false);
        const p = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
        fn(p);
        if (p < 1) requestAnimationFrame(tick);
        else resolve(true);
      };
      requestAnimationFrame(tick);
    });
  }

  // ---------- cursors ----------
  class Cursor {
    constructor(name, color, x, y) {
      this.el = document.createElement('div');
      this.el.className = 'cursor';
      this.el.style.setProperty('--c', color);
      this.el.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2.5v17l4.6-4.2 3.2 7 3-1.4-3.2-6.9h6.4z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span class="tag"></span><span class="bubble"></span>`;
      this.el.querySelector('.tag').textContent = name;
      this.bubble = this.el.querySelector('.bubble');
      this.color = color;
      overlay.append(this.el);
      this.move(x, y);
      this.say('');
    }
    move(x, y) { this.x = x; this.y = y; this.el.style.transform = `translate(${x}px, ${y}px)`; }
    say(t) { if (t === this._said) return; this._said = t; this.bubble.textContent = t; this.bubble.style.display = t ? '' : 'none'; }
    travel(target, ms, tok) {
      const sx = this.x, sy = this.y;
      return tween(ms, (p) => { const t = target(); const e = ease(p); this.move(lerp(sx, t.x, e), lerp(sy, t.y, e)); }, tok);
    }
    remove() { this.el.remove(); }
  }

  function makeBox(color, cls = '') {
    const b = document.createElement('div');
    b.className = `dragbox ${cls}`;
    b.style.setProperty('--c', color);
    b.innerHTML = '<span class="dim"></span>';
    overlay.append(b);
    return b;
  }
  const place = (el, x, y, w, h) => Object.assign(el.style, { transform: `translate(${x}px, ${y}px)`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, h)}px` });

  // ---------- UI: panel, log, top bar ----------
  function logLine(t, html) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${fmtS(t)}</span>${html}`;
    $('#log').prepend(li);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function setPhase(t) { $('#phase').textContent = t; }

  function agentRow(a) {
    let li = document.querySelector(`#agents li[data-id="${a.id}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = a.id;
      li.style.setProperty('--c', a.color);
      li.innerHTML = `<span class="dot"></span><span class="who"></span><span class="t"></span><span class="what"></span>`;
      $('#agents').append(li);
    }
    li.dataset.status = a.status;
    li.querySelector('.who').innerHTML = `${esc(a.name)}<small>${esc(a.section.name)}</small>`;
    const what = {
      waiting: 'queued',
      thinking: `writing · ${fmtK(a.chars)} chars`,
      building: `assembling · ${a.step}/${a.steps}`,
      done: `done · ${fmtK(a.chars)} chars in ${fmtS(a.ms)}`,
      failed: 'failed',
    }[a.status];
    li.querySelector('.what').textContent = what;
    const t = a.ms != null ? a.ms : a.startAt != null ? performance.now() - a.startAt : 0;
    li.querySelector('.t').textContent = fmtS(t);
  }

  // ---------- reset ----------
  function reset() {
    S.token++;
    S.timers.forEach(clearTimeout);
    S.timers = [];
    S.agents.forEach((a) => a.cursor && a.cursor.remove());
    S.agents.clear();
    if (S.planner) S.planner.remove();
    S.planner = null;
    overlay.innerHTML = '';
    stage.innerHTML = '<div class="stage-empty">Waiting for the planner…</div>';
    stage.removeAttribute('style');
    $('#agents').innerHTML = '';
    $('#log').innerHTML = '';
    $('#finale').hidden = true;
    S.mode = 'idle'; S.plan = null; S.stats = null; S.animating = 0; S.finaleShown = false;
    S.clock = null; S.clockStop = null;
    window.__swarmDone = false;
  }

  // ---------- event handling ----------
  function handle(e) {
    const tok = S.token;
    switch (e.type) {
      case 'meta':
        S.meta = e;
        S.clock = performance.now() - e.t / S.speedFactor();
        $('#brief').textContent = e.brief; $('#brief').title = e.brief;
        $('#model').textContent = e.model;
        logLine(e.t, '<b>brief</b> received');
        break;
      case 'plan:start': {
        S.mode = 'planning';
        setPhase('planning');
        const r = canvas.getBoundingClientRect();
        S.planner = new Cursor('Planner', '#111111', r.left + r.width / 2, r.top + r.height / 2);
        S.planner.say('splitting the page into sections…');
        logLine(e.t, '<b>planner</b> started');
        break;
      }
      case 'plan:done':
        S.plan = e.plan;
        applyTheme(e.plan.theme);
        renderSlots(e.plan);
        S.mode = 'build';
        setPhase('building');
        $('#frame-url').textContent = e.plan.title;
        if (S.planner) S.planner.say(`plan ready · ${e.plan.sections.length} sections`);
        logLine(e.t, `<b>plan</b> ${e.plan.sections.length} sections in ${fmtS(e.ms)}`);
        break;
      case 'agent:start': {
        const section = S.plan.sections.find((s) => s.id === e.id);
        const from = S.planner || { x: innerWidth / 2, y: innerHeight / 2 };
        const a = {
          id: e.id, name: e.agent.name, color: e.agent.color, section, status: 'thinking', chars: 0,
          startAt: performance.now(), ms: null, step: 0, steps: 0, phase: Math.random() * 6.28,
          cursor: new Cursor(e.agent.name, e.agent.color, from.x, from.y),
        };
        S.agents.set(e.id, a);
        agentRow(a);
        logLine(e.t, `<b style="color:${a.color}">${esc(a.name)}</b> → ${esc(section.name)}`);
        if (S.planner && S.agents.size === S.plan.sections.length) {
          const p = S.planner;
          setTimeout(() => p.el.classList.add('gone'), 900);
        }
        break;
      }
      case 'agent:progress': {
        const a = S.agents.get(e.id);
        if (!a) break;
        a.chars = e.chars;
        const bar = document.querySelector(`.slot[data-slot="${e.id}"] .slot-bar i`);
        if (bar) bar.style.width = `${clamp(e.chars / 9000, 0.03, 0.97) * 100}%`;
        break;
      }
      case 'agent:done': {
        const a = S.agents.get(e.id);
        if (!a) break;
        a.chars = e.html.length;
        a.ms = e.ms;
        logLine(e.t, `<b style="color:${a.color}">${esc(a.name)}</b> wrote ${esc(a.section.name)} · ${fmtS(e.ms)}`);
        S.animating++;
        assemble(a, e.html, tok).catch((err) => console.error('assemble failed', err)).finally(() => { if (live(tok)) { S.animating--; maybeFinale(); } });
        break;
      }
      case 'agent:error': {
        const a = S.agents.get(e.id);
        if (!a) break;
        a.status = 'failed'; a.ms = performance.now() - a.startAt;
        a.cursor.say('failed');
        const slot = document.querySelector(`.slot[data-slot="${e.id}"]`);
        if (slot) { slot.classList.add('failed'); slot.querySelector('.slot-brief').textContent = e.message; }
        logLine(e.t, `<b style="color:#fca5a5">${esc(a.name)} failed</b>`);
        break;
      }
      case 'done':
        S.stats = e.stats;
        logLine(e.t, `<b>done</b> ${e.stats.speedup}× vs sequential`);
        maybeFinale();
        break;
      case 'error':
        $('#error').textContent = `Build failed: ${e.message}`;
        $('#error').hidden = false;
        setPhase('error');
        break;
    }
  }
  S.speedFactor = () => 1;

  function applyTheme(t) {
    const v = { '--bg': t.bg, '--surface': t.surface, '--ink': t.ink, '--muted': t.muted, '--accent': t.accent, '--accent-ink': t.accentInk, '--accent-soft': t.accentSoft || 'color-mix(in srgb, var(--accent) 14%, transparent)', '--dark': t.dark, '--dark-ink': t.darkInk, '--line': t.line, '--radius': t.radius, '--font': `'${t.font}', system-ui, sans-serif`, '--heading-font': `'${t.headingFont}', '${t.font}', serif` };
    for (const [k, val] of Object.entries(v)) if (val) stage.style.setProperty(k, val);
    const fams = [...new Set([t.font, t.headingFont])].filter(Boolean);
    if (fams.length && !document.querySelector('link[data-theme-font]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.dataset.themeFont = '1';
      l.href = `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700`).join('&')}&display=swap`;
      document.head.append(l);
    }
  }

  function renderSlots(plan) {
    stage.innerHTML = '';
    const agents = (S.meta && S.meta.agents) || [];
    plan.sections.forEach((s, i) => {
      const ag = agents[i % Math.max(agents.length, 1)] || { name: 'Agent', color: '#888' };
      const d = document.createElement('div');
      d.className = 'slot';
      d.dataset.slot = s.id;
      d.style.setProperty('--c', ag.color);
      d.style.height = `${SLOT_H[s.height] || SLOT_H.medium}px`;
      d.innerHTML = `<div class="slot-label"><b>${esc(ag.name)}</b> · ${esc(s.name)}</div><div class="slot-brief">${esc(s.brief)}</div><div class="slot-bar"><i></i></div>`;
      stage.append(d);
    });
  }

  // ---------- step extraction ----------
  function isBox(el, cs) {
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'hr') return true;
    const bg = cs.backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    if (cs.boxShadow && cs.boxShadow !== 'none') return true;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none' && !/rgba\([^)]*,\s*0\)$/.test(cs[`border${side}Color`])) return true;
    }
    return false;
  }

  function isTextBlock(el) {
    if (!el.textContent.trim()) return false;
    for (const d of el.querySelectorAll('*')) {
      if (d.closest('svg')) continue;
      if (!INLINE.has(d.localName)) return false;
    }
    return true;
  }

  function collect(sec) {
    const steps = [];
    const structural = [];
    const visit = (el, depth) => {
      const tag = el.localName;
      if (MEDIA.has(tag)) { steps.push({ kind: 'media', el, depth }); return; }
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      const box = isBox(el, cs);
      if (el !== sec && isTextBlock(el)) { steps.push({ kind: box ? 'button' : 'text', el, depth }); return; }
      if (box) steps.push({ kind: 'rect', el, depth }); else structural.push(el);
      for (const c of el.children) visit(c, depth + 1);
    };
    visit(sec, 0);
    return { steps, structural };
  }

  const textNodes = (el) => {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  };
  const revealDeep = (el) => { el.style.visibility = 'visible'; el.querySelectorAll('*').forEach((d) => { if (d.style) d.style.visibility = 'visible'; }); };
  const fadeIn = (el, extra = {}) => { try { el.animate([{ opacity: 0, ...extra }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' }); } catch {} };

  // ---------- assembling one section ----------
  async function assemble(a, html, tok) {
    const slot = document.querySelector(`.slot[data-slot="${a.id}"]`);
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const sec = tpl.content.querySelector('section') || tpl.content.firstElementChild;
    if (!sec || !slot) return;
    const all = [sec, ...sec.querySelectorAll('*')].filter((e) => e.localName === 'svg' || !e.parentElement || !e.parentElement.closest('svg'));
    all.forEach((e) => { if (e.style) e.style.visibility = 'hidden'; });
    slot.replaceWith(sec);
    a.el = sec;
    a.status = 'building';
    await sleep(260); // let the Tailwind runtime generate classes before measuring
    if (!live(tok)) return;

    const { steps, structural } = collect(sec);
    structural.forEach((e) => (e.style.visibility = 'visible'));
    const base = sec.getBoundingClientRect();
    for (const s of steps) {
      const r = s.el.getBoundingClientRect();
      s.top = (r.top - base.top) / S.scale;
      s.left = (r.left - base.left) / S.scale;
      s.area = (r.width * r.height) / (S.scale * S.scale);
      s.chars = s.kind === 'text' || s.kind === 'button' ? s.el.textContent.trim().length : 0;
      s.zero = r.width < 1 || r.height < 1;
    }
    const ordered = steps.filter((s) => !s.zero).sort((x, y) => Math.round(x.top / 6) - Math.round(y.top / 6) || x.depth - y.depth || x.left - y.left);
    // Animate the biggest pieces, reveal the rest instantly when their turn comes.
    const rank = [...ordered].sort((x, y) => (y.area + y.chars * 400) - (x.area + x.chars * 400));
    rank.forEach((s, i) => { s.instant = i >= MAX_ANIMATED_STEPS || (s.kind === 'rect' && s.area < 900) || (s.kind !== 'media' && s.kind !== 'rect' && s.chars < 2); });
    const dur = (s) => (s.instant ? 0 : 240 + (s.kind === 'rect' ? 380 + Math.min(300, s.area / 2000) : s.kind === 'media' ? 450 : s.kind === 'button' ? 380 + Math.min(900, s.chars * 22) : Math.min(1400, Math.max(250, s.chars * 22))));
    const total = ordered.reduce((n, s) => n + dur(s), 0) || 1;
    const k = Math.min(1, SECTION_BUDGET_MS / total) / S.speed;
    a.steps = ordered.length;

    for (const s of ordered) {
      if (!live(tok)) return;
      a.step++;
      if (s.instant) { revealDeep(s.el); continue; }
      const d = dur(s) * k;
      await runStep(a, s, d, tok);
    }
    all.forEach((e) => { if (e.style) e.style.visibility = ''; });
    a.status = 'done';
    a.cursor.say(`done · ${fmtS(a.ms)}`);
    const r = sec.getBoundingClientRect();
    await a.cursor.travel(() => ({ x: r.right - 140, y: sec.getBoundingClientRect().top + 16 }), 400 / S.speed, tok);
    a.cursor.el.classList.add('parked');
  }

  async function runStep(a, s, d, tok) {
    const el = s.el, c = a.cursor;
    const travel = Math.min(260, d * 0.3);
    const work = d - travel;
    const rect = () => el.getBoundingClientRect();

    if (s.kind === 'rect' || s.kind === 'button') {
      c.say(s.kind === 'button' ? 'button' : `<${el.localName}>`);
      await c.travel(() => { const r = rect(); return { x: r.left, y: r.top }; }, travel, tok);
      const box = makeBox(a.color);
      const dim = box.firstChild;
      const dragMs = s.kind === 'button' ? work * 0.4 : work;
      await tween(dragMs, (p) => {
        const r = rect(); const e = ease(p);
        place(box, r.left, r.top, r.width * e, r.height * e);
        dim.textContent = `${Math.round((r.width * e) / S.scale)} × ${Math.round((r.height * e) / S.scale)}`;
        c.move(r.left + r.width * e, r.top + r.height * e);
      }, tok);
      box.remove();
      if (s.kind === 'rect') { el.style.visibility = 'visible'; fadeIn(el); return; }
      el.style.visibility = 'visible';
      await typeInto(a, el, work * 0.6, tok, true);
      return;
    }
    if (s.kind === 'text') {
      c.say('typing');
      await c.travel(() => { const r = rect(); return { x: r.left, y: r.top + Math.min(r.height, 28) / 2 }; }, travel, tok);
      await typeInto(a, el, work, tok, false);
      return;
    }
    // media: placeholder, then reveal
    c.say(el.localName === 'svg' ? 'drawing svg' : 'media');
    await c.travel(() => { const r = rect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, travel, tok);
    const box = makeBox(a.color, 'media');
    box.firstChild.textContent = el.localName;
    await tween(work * 0.65, () => { const r = rect(); place(box, r.left, r.top, r.width, r.height); c.move(r.left + r.width / 2, r.top + r.height / 2); }, tok);
    box.remove();
    revealDeep(el);
    fadeIn(el, { transform: 'scale(.92)' });
    await sleep(work * 0.35);
  }

  async function typeInto(a, el, ms, tok, alreadyVisible) {
    const c = a.cursor;
    const cs = getComputedStyle(el);
    const prev = { minHeight: el.style.minHeight, minWidth: el.style.minWidth };
    if (cs.display !== 'inline') {
      el.style.minHeight = `${el.offsetHeight}px`;
      el.style.minWidth = `${el.offsetWidth}px`;
    }
    const nodes = textNodes(el);
    const orig = nodes.map((n) => n.data);
    const lens = orig.map((t) => t.length);
    const totalChars = lens.reduce((x, y) => x + y, 0);
    nodes.forEach((n) => (n.data = ''));
    if (!alreadyVisible) revealDeep(el); else el.querySelectorAll('*').forEach((d) => d.style && (d.style.visibility = 'visible'));
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 || 20;
    const fill = (n) => {
      let left = n;
      nodes.forEach((node, i) => { const take = Math.max(0, Math.min(lens[i], left)); left -= take; const want = orig[i].slice(0, take); if (node.data !== want) node.data = want; });
    };
    await tween(ms, (p) => {
      fill(Math.round(totalChars * p));
      const r = el.getBoundingClientRect();
      const lines = Math.max(1, Math.round(r.height / (lineH * S.scale)));
      const lp = p * lines;
      const li = Math.min(lines - 1, Math.floor(lp));
      c.move(r.left + r.width * (lp - li), r.top + (li + 0.5) * lineH * S.scale);
    }, tok);
    fill(totalChars);
    el.style.minHeight = prev.minHeight;
    el.style.minWidth = prev.minWidth;
  }

  // ---------- finale + go live ----------
  function maybeFinale() {
    if (!S.stats || S.animating > 0 || S.finaleShown) return;
    S.finaleShown = true;
    S.clockStop = performance.now();
    setPhase('done');
    const st = S.stats;
    $('#f-wall').textContent = fmtS(st.wallMs);
    $('#f-line').textContent = `${st.sections} sections planned in ${fmtS(st.planMs)}, then built at the same time in ${fmtS(st.buildWallMs)}.`;
    $('#f-agents').textContent = String(st.sections - st.failed);
    $('#f-seq').textContent = fmtS(st.sumMs);
    $('#f-speed').textContent = `${st.speedup}×`;
    $('#f-cost').textContent = `$${st.costUsd.toFixed(3)}`;
    const dir = String(st.outDir).split(/[\\/]/).pop();
    $('#open-page').href = `/out/${dir}/index.html`;
    $('#finale').hidden = false;
    if (S.autolive) setTimeout(() => goLive(), 2600);
  }

  async function goLive() {
    const tok = S.token;
    $('#finale').hidden = true;
    S.mode = 'live';
    setPhase('live');
    S.agents.forEach((a) => a.cursor.el.classList.add('gone'));
    await sleep(900);
    if (!live(tok)) return;
    canvas.scrollTop = 0;
    if (S.autolive) {
      await sleep(800);
      const max = () => canvas.scrollHeight - canvas.clientHeight;
      const ms = clamp(max() * 3.2, 5000, 16000);
      await tween(ms, (p) => { canvas.scrollTop = max() * (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2); }, tok);
      await sleep(900);
      window.__swarmDone = true;
    }
  }

  // ---------- replay (client side, original timing / speed) ----------
  function replay() {
    const evs = S.events.slice();
    reset();
    const tok = S.token;
    const t0 = performance.now();
    S.speedFactor = () => S.speed;
    evs.forEach((e) => S.timers.push(setTimeout(() => live(tok) && handle(e), e.t / S.speed)));
    S.clock = t0;
  }

  // ---------- frame loop: scale, wander, scroll-follow, panel ----------
  function frame(now) {
    // scale: zoom out while building so more of the page is visible; full width when live.
    const fitW = Math.min(1, (canvas.clientWidth - 48) / STAGE_W);
    const stageH = stage.offsetHeight || 720;
    const fitH = (canvas.clientHeight - 48 - 32) / stageH;
    const target = S.mode === 'build' ? clamp(fitH, MIN_SCALE, fitW) : fitW;
    S.scale = Math.abs(target - S.scale) < 0.001 ? target : lerp(S.scale, target, 0.06);
    stage.style.transform = `scale(${S.scale})`;
    frameBody.style.width = `${STAGE_W * S.scale}px`;
    frameBody.style.height = `${stageH * S.scale}px`;
    $('#frame').style.width = `${STAGE_W * S.scale}px`;

    const t = now / 1000;
    if (S.planner && S.mode === 'planning') {
      const r = canvas.getBoundingClientRect();
      S.planner.move(r.left + r.width / 2 + Math.cos(t * 1.6) * 160, r.top + r.height * 0.42 + Math.sin(t * 2.1) * 70);
    }
    const followY = [];
    S.agents.forEach((a) => {
      if (a.status === 'thinking') {
        const host = document.querySelector(`.slot[data-slot="${a.id}"]`);
        if (host) {
          const r = host.getBoundingClientRect();
          const tx = r.left + r.width * (0.55 + 0.28 * Math.sin(t * 0.9 + a.phase));
          const ty = r.top + Math.min(r.height, 300) * (0.55 + 0.25 * Math.cos(t * 1.3 + a.phase));
          a.cursor.move(lerp(a.cursor.x, tx, 0.07), lerp(a.cursor.y, ty, 0.07));
        }
        a.cursor.say(`thinking · ${fmtK(a.chars)} chars`);
      }
      if (a.status === 'building') followY.push(a.cursor.y);
      agentRow(a);
    });
    if (S.mode === 'build' && now - S.userScrollAt > 2500) {
      if (!followY.length) S.agents.forEach((a) => a.status === 'thinking' && followY.push(a.cursor.y));
      if (followY.length) {
        const cr = canvas.getBoundingClientRect();
        const avg = followY.reduce((x, y) => x + y, 0) / followY.length;
        const want = canvas.scrollTop + (avg - cr.top) - canvas.clientHeight * 0.45;
        const d = want - canvas.scrollTop;
        if (Math.abs(d) > 4) canvas.scrollTop += d * 0.05;
      }
    }
    if (S.clock != null) $('#timer').textContent = fmtS(((S.clockStop || now) - S.clock) * (S.speedFactor() || 1));
    requestAnimationFrame(frame);
  }

  // ---------- wiring ----------
  canvas.addEventListener('wheel', () => (S.userScrollAt = performance.now()), { passive: true });
  document.querySelectorAll('.speed button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === S.speed));
    b.addEventListener('click', () => {
      S.speed = Number(b.dataset.speed);
      document.querySelectorAll('.speed button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
  });
  $('#go-live').addEventListener('click', goLive);
  $('#replay').addEventListener('click', replay);
  $('#replay-top').addEventListener('click', replay);

  reset();
  requestAnimationFrame(frame);
  const es = new EventSource('/events');
  es.onopen = () => setPhase(S.mode === 'idle' ? 'waiting' : S.mode);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.seq != null && e.seq <= S.received) return; // ignore buffer resend after reconnect
    if (e.seq != null) S.received = e.seq;
    S.events.push(e);
    if (S.clock == null && e.type !== 'meta') S.clock = performance.now() - e.t;
    handle(e);
    if (e.type === 'done' || e.type === 'error') es.close();
  };
})();
