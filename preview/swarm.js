// swarm-build preview: original cursor engine.
// Follows the run's event stream and animates each agent assembling its real section inside an iframe stage.
(() => {
  'use strict';
  const DEVICES = { desktop: { w: 1280, min: 0.42 }, mobile: { w: 390, min: 0.6 } };
  const SECTION_BUDGET_MS = 9000; // assembly animation per section at 1x
  const MAX_ANIMATED_STEPS = 70;
  const SLOT_H = { short: 140, medium: 460, tall: 700 };
  const INLINE = new Set(['a', 'span', 'strong', 'em', 'b', 'i', 'u', 'br', 'small', 'code', 'mark', 'sup', 'sub', 'abbr', 'time', 's', 'del', 'ins', 'kbd', 'label', 'q', 'cite', 'wbr']);
  const MEDIA = new Set(['svg', 'img', 'video', 'canvas', 'picture']);
  const REASON = { build: 'writing', fix: 'fixing', comment: 'comment' };

  const $ = (s) => document.querySelector(s);
  const canvas = $('#canvas'), frameBody = $('#frame-body'), iframe = $('#stage'), overlay = $('#overlay');
  const params = new URLSearchParams(location.search);
  const EMBED = window.__SWARM_EMBED__ || null; // static share file: events baked in, no server

  const S = {
    speed: Math.min(3, Math.max(1, Number(params.get('speed')) || 1)),
    device: params.get('device') === 'mobile' ? 'mobile' : 'desktop',
    autolive: params.get('autolive') === '1',
    events: [], received: -1, timers: [], token: 0, ready: false, queue: [],
    mode: 'idle', scale: 1, plan: null, meta: null, stats: null,
    agents: new Map(), planner: null, reviewer: null, animating: 0, clock: null, clockStop: null,
    userScrollAt: 0, finaleShown: false, commenting: false, comments: new Map(),
    hoverEl: null, popTarget: null, replaying: false,
  };
  window.__swarm = S;
  let doc = null, win = null; // stage document and window

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const live = (tok) => tok === S.token;
  const css = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

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

  // Stage element rect -> client coordinates of the parent page.
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    const f = iframe.getBoundingClientRect();
    const s = S.scale;
    const left = f.left + r.left * s, top = f.top + r.top * s, width = r.width * s, height = r.height * s;
    return { left, top, width, height, right: left + width, bottom: top + height, iw: r.width, ih: r.height };
  }

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
        doc.addEventListener('wheel', () => { S.userScrollAt = performance.now(); }, { passive: true });
        resolve();
      }, { once: true });
      iframe.srcdoc = STAGE_DOC;
    });
  }
  const root = () => doc.getElementById('root');
  const hostOf = (id) => doc.querySelector(`[data-slot="${css(id)}"]`) || doc.querySelector(`[data-section="${css(id)}"]`);

  // ---------- cursors ----------
  class Cursor {
    constructor(name, color, x, y) {
      this.el = document.createElement('div');
      this.el.className = 'cursor';
      this.el.style.setProperty('--c', color);
      this.el.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2.5v17l4.6-4.2 3.2 7 3-1.4-3.2-6.9h6.4z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span class="tag"></span><span class="bubble"></span>`;
      this.el.querySelector('.tag').textContent = name;
      this.bubble = this.el.querySelector('.bubble');
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
    state(cls) { this.el.classList.remove('parked', 'gone'); if (cls) this.el.classList.add(cls); }
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

  // ---------- panel ----------
  function logLine(t, html) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${fmtS(t || 0)}</span>${html}`;
    $('#log').prepend(li);
  }
  const setPhase = (t) => { $('#phase').textContent = t; };
  const who = (a) => `<b style="color:${a.color}">${esc(a.name)}</b>`;

  function agentRow(a) {
    let li = document.querySelector(`#agents li[data-id="${css(a.id)}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = a.id;
      li.style.setProperty('--c', a.color);
      li.innerHTML = '<span class="dot"></span><span class="who"></span><span class="t"></span><span class="what"></span>';
      $('#agents').append(li);
      li.querySelector('.who').innerHTML = `${esc(a.name)}<small>${esc(a.section.name)}</small>`;
    }
    li.dataset.status = a.status;
    const what = {
      thinking: `${REASON[a.reason] || 'writing'} · ${fmtK(a.chars)} chars`,
      building: `assembling · ${a.step}/${a.steps}`,
      done: `${a.rebuilds ? `done (${a.rebuilds} rebuild${a.rebuilds > 1 ? 's' : ''})` : 'done'} · ${fmtK(a.chars)} chars in ${fmtS(a.ms || 0)}`,
      failed: 'failed',
    }[a.status];
    li.querySelector('.what').textContent = what;
    const t = a.status === 'done' || a.status === 'failed' ? a.ms || 0 : performance.now() - a.startAt;
    li.querySelector('.t').textContent = fmtS(t);
  }

  function renderComments() {
    const list = [...S.comments.values()];
    const open = list.filter((c) => c.status === 'open').length;
    $('#comment-count').textContent = list.length ? `· ${open} open` : '';
    $('#comments').innerHTML = list.map((c, i) => `<li data-id="${esc(c.id)}" data-status="${esc(c.status)}"><span class="n">${i + 1}</span><span>${esc(c.text)}<small>${esc(c.section)}${c.target ? ` · ${esc(c.target.slice(0, 60))}` : ''}${c.status !== 'open' ? ` · ${esc(c.status)}` : ''}</small></span></li>`).join('');
    $('#apply').hidden = !open || EMBED;
    $('#comment-hint').hidden = list.length > 0 || EMBED;
    overlay.querySelectorAll('.pin').forEach((p) => { if (!S.comments.has(p.dataset.id)) p.remove(); });
    list.forEach((c, i) => {
      let pin = overlay.querySelector(`.pin[data-id="${css(c.id)}"]`);
      if (!pin) { pin = document.createElement('div'); pin.className = 'pin'; pin.dataset.id = c.id; overlay.append(pin); }
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
    [S.planner, S.reviewer].forEach((c) => c && c.remove());
    S.planner = S.reviewer = null;
    overlay.innerHTML = '';
    S.comments.clear();
    if (doc) {
      root().innerHTML = '<div class="sb-empty">Waiting for the planner…</div>';
      doc.getElementById('sb-theme').textContent = '';
    }
    ['#agents', '#log', '#review', '#comments'].forEach((s) => ($(s).innerHTML = ''));
    $('#review-box').hidden = true;
    $('#finale').hidden = true;
    $('#apply-msg').hidden = true;
    Object.assign(S, { mode: 'idle', plan: null, stats: null, animating: 0, finaleShown: false, clock: null, clockStop: null });
    renderComments();
    window.__swarmDone = false;
  }

  // ---------- events ----------
  function handle(e) {
    const tok = S.token;
    switch (e.type) {
      case 'meta':
        S.meta = e;
        S.clock = performance.now() - (e.t || 0) / (S.replaying ? S.speed : 1);
        $('#brief').textContent = e.brief; $('#brief').title = e.brief;
        $('#model').textContent = e.model ? `${e.model}` : e.mode === 'agent' ? 'your coding agent' : '';
        logLine(e.t, '<b>brief</b> received');
        break;
      case 'plan:start': {
        S.mode = 'planning';
        setPhase('planning');
        const r = canvas.getBoundingClientRect();
        S.planner = new Cursor('Planner', '#111111', r.left + r.width / 2, r.top + r.height / 2);
        S.planner.say('choosing a design direction…');
        logLine(e.t, '<b>planner</b> started');
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
        if (S.planner) S.planner.say(`plan ready · ${e.plan.sections.length} sections`);
        else { const r = canvas.getBoundingClientRect(); S.planner = new Cursor('Planner', '#111111', r.left + r.width / 2, r.top + 120); S.planner.say(`plan ready · ${e.plan.sections.length} sections`); }
        logLine(e.t, `<b>plan</b> ${e.plan.sections.length} sections${e.ms ? ` in ${fmtS(e.ms)}` : ''}`);
        if (e.plan.design?.direction) logLine(e.t, `<b>direction</b> ${esc(e.plan.design.direction.slice(0, 140))}${e.plan.design.direction.length > 140 ? '…' : ''}`);
        setTimeout(() => S.planner && S.planner.state('gone'), 2500 / S.speed);
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
        if (reason !== 'build') {
          a.rework && a.rework.remove();
          a.rework = makeBox(a.color, 'rework');
          if (reason === 'comment') S.comments.forEach((c) => { if (c.section === e.id && c.status === 'open') c.status = 'working'; });
          renderComments();
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
        if (!a && S.plan) { handle({ type: 'agent:start', id: e.id, agent: e.agent, reason: e.reason, t: e.t }); a = S.agents.get(e.id); }
        if (!a) break;
        a.chars = e.chars || e.html.length;
        a.ms = e.ms;
        if (a.rework) { a.rework.remove(); a.rework = null; }
        logLine(e.t, `${who(a)} ${e.reason === 'build' || !e.reason ? 'wrote' : 'rebuilt'} ${esc(a.section.name)}${e.ms ? ` · ${fmtS(e.ms)}` : ''}`);
        S.animating++;
        assemble(a, e.html, tok)
          .catch((err) => console.error('assemble failed', err))
          .finally(() => {
            if (!live(tok)) return;
            S.animating--;
            (e.resolves || []).forEach((id) => { const c = S.comments.get(id); if (c) c.status = 'resolved'; });
            renderComments();
            maybeFinale();
          });
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
        maybeFinale();
        break;
      }
      case 'review:start': {
        S.mode = 'review';
        setPhase('reviewing');
        const r = canvas.getBoundingClientRect();
        S.reviewer = S.reviewer || new Cursor('Reviewer', '#f2b84b', r.left + r.width / 2, r.top + 80);
        S.reviewer.state();
        S.reviewer.say('checking contrast, hierarchy, layout…');
        logLine(e.t, '<b>review</b> started');
        break;
      }
      case 'review:done': {
        S.mode = 'build';
        setPhase('building');
        if (S.reviewer) { S.reviewer.say(e.fixes?.length ? `${e.fixes.length} section(s) to fix` : 'looks good'); setTimeout(() => S.reviewer && S.reviewer.state('gone'), 1800 / S.speed); }
        const box = $('#review');
        const real = (e.findings || []).filter((f) => f.severity !== 'info');
        box.innerHTML = `<div>${esc(e.summary || '')}</div><div><b>${real.length}</b> automated finding${real.length === 1 ? '' : 's'}, <b>${(e.fixes || []).length}</b> fix${(e.fixes || []).length === 1 ? '' : 'es'}</div>`
          + (e.fixes || []).map((f) => `<div class="fix"><strong>${esc(f.id)}</strong> · ${esc(f.problem)}</div>`).join('');
        $('#review-box').hidden = false;
        logLine(e.t, `<b>review</b> ${(e.fixes || []).length} fixes`);
        break;
      }
      case 'comment:add':
        S.comments.set(e.comment.id, { ...e.comment });
        renderComments();
        logLine(e.t, `<b>comment</b> on ${esc(e.comment.section)}: ${esc(e.comment.text.slice(0, 60))}`);
        break;
      case 'done':
        S.stats = e.stats;
        logLine(e.t, `<b>done</b>${e.stats.speedup ? ` ${e.stats.speedup}× vs one agent` : ''}`);
        maybeFinale();
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

  // ---------- step extraction ----------
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  function isBox(el, cs) {
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'hr') return true;
    if (!transparent(cs.backgroundColor)) return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    if (cs.boxShadow && cs.boxShadow !== 'none') return true;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none' && !transparent(cs[`border${side}Color`])) return true;
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
    const steps = [], structural = [];
    const visit = (el, depth) => {
      if (MEDIA.has(el.localName)) { steps.push({ kind: 'media', el, depth }); return; }
      const cs = win.getComputedStyle(el);
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
    const w = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  };
  const revealDeep = (el) => { el.style.visibility = 'visible'; el.querySelectorAll('*').forEach((d) => d.style && (d.style.visibility = 'visible')); };
  const fadeIn = (el, extra = {}) => { try { el.animate([{ opacity: 0, ...extra }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' }); } catch {} };

  // ---------- assembling one section ----------
  async function assemble(a, html, tok) {
    const host = hostOf(a.id);
    const tpl = doc.createElement('template');
    tpl.innerHTML = html.trim();
    const sec = tpl.content.querySelector('section') || tpl.content.firstElementChild;
    if (!sec || !host) return;
    const all = [sec, ...sec.querySelectorAll('*')].filter((e) => e.localName === 'svg' || !e.parentElement || !e.parentElement.closest('svg'));
    all.forEach((e) => e.style && (e.style.visibility = 'hidden'));
    host.replaceWith(sec);
    a.el = sec;
    a.status = 'building';
    a.step = 0;
    await sleep(260); // Tailwind's runtime generates classes after the DOM changes
    if (!live(tok)) return;

    const { steps, structural } = collect(sec);
    structural.forEach((e) => (e.style.visibility = 'visible'));
    const base = sec.getBoundingClientRect();
    for (const s of steps) {
      const r = s.el.getBoundingClientRect();
      s.top = r.top - base.top;
      s.left = r.left - base.left;
      s.area = r.width * r.height;
      s.chars = s.kind === 'text' || s.kind === 'button' ? s.el.textContent.trim().length : 0;
      s.zero = r.width < 1 || r.height < 1;
    }
    const ordered = steps.filter((s) => !s.zero).sort((x, y) => Math.round(x.top / 6) - Math.round(y.top / 6) || x.depth - y.depth || x.left - y.left);
    const rank = [...ordered].sort((x, y) => (y.area + y.chars * 400) - (x.area + x.chars * 400));
    rank.forEach((s, i) => { s.instant = i >= MAX_ANIMATED_STEPS || (s.kind === 'rect' && s.area < 900) || ((s.kind === 'text' || s.kind === 'button') && s.chars < 2); });
    const dur = (s) => (s.instant ? 0 : 240 + (s.kind === 'rect' ? 380 + Math.min(300, s.area / 2000) : s.kind === 'media' ? 450 : s.kind === 'button' ? 380 + Math.min(900, s.chars * 22) : Math.min(1400, Math.max(250, s.chars * 22))));
    const total = ordered.reduce((n, s) => n + dur(s), 0) || 1;
    const k = Math.min(1, (a.reason === 'build' ? SECTION_BUDGET_MS : SECTION_BUDGET_MS * 0.6) / total) / S.speed;
    a.steps = ordered.length;

    for (const s of ordered) {
      if (!live(tok)) return;
      a.step++;
      if (s.instant) { revealDeep(s.el); continue; }
      await runStep(a, s, dur(s) * k, tok);
    }
    all.forEach((e) => e.style && (e.style.visibility = ''));
    a.status = 'done';
    a.cursor.say(`done · ${fmtS(a.ms || 0)}`);
    await a.cursor.travel(() => { const r = rectOf(sec); return { x: r.right - Math.min(140, r.width / 3), y: r.top + 16 }; }, 400 / S.speed, tok);
    a.cursor.state('parked');
  }

  async function runStep(a, s, d, tok) {
    const el = s.el, c = a.cursor;
    const travel = Math.min(260, d * 0.3);
    const work = d - travel;
    const rect = () => rectOf(el);

    if (s.kind === 'rect' || s.kind === 'button') {
      c.say(s.kind === 'button' ? 'button' : `<${el.localName}>`);
      await c.travel(() => { const r = rect(); return { x: r.left, y: r.top }; }, travel, tok);
      const box = makeBox(a.color);
      const dim = box.firstChild;
      await tween(s.kind === 'button' ? work * 0.4 : work, (p) => {
        const r = rect(); const e = ease(p);
        place(box, r.left, r.top, r.width * e, r.height * e);
        dim.textContent = `${Math.round(r.iw * e)} × ${Math.round(r.ih * e)}`;
        c.move(r.left + r.width * e, r.top + r.height * e);
      }, tok);
      box.remove();
      el.style.visibility = 'visible';
      if (s.kind === 'rect') { fadeIn(el); return; }
      await typeInto(a, el, work * 0.6, tok);
      return;
    }
    if (s.kind === 'text') {
      c.say('typing');
      await c.travel(() => { const r = rect(); return { x: r.left, y: r.top + Math.min(r.height, 28 * S.scale) / 2 }; }, travel, tok);
      await typeInto(a, el, work, tok);
      return;
    }
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

  async function typeInto(a, el, ms, tok) {
    const c = a.cursor;
    const cs = win.getComputedStyle(el);
    const prev = { minHeight: el.style.minHeight, minWidth: el.style.minWidth };
    if (cs.display !== 'inline') { el.style.minHeight = `${el.offsetHeight}px`; el.style.minWidth = `${el.offsetWidth}px`; }
    const nodes = textNodes(el);
    const orig = nodes.map((n) => n.data);
    const lens = orig.map((t) => t.length);
    const totalChars = lens.reduce((x, y) => x + y, 0);
    nodes.forEach((n) => (n.data = ''));
    revealDeep(el);
    const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 || 20;
    const fill = (n) => { let left = n; nodes.forEach((node, i) => { const take = Math.max(0, Math.min(lens[i], left)); left -= take; const want = orig[i].slice(0, take); if (node.data !== want) node.data = want; }); };
    await tween(ms, (p) => {
      fill(Math.round(totalChars * p));
      const r = rectOf(el);
      const lh = lineH * S.scale;
      const lines = Math.max(1, Math.round(r.height / lh));
      const lp = p * lines;
      const li = Math.min(lines - 1, Math.floor(lp));
      c.move(r.left + r.width * (lp - li), r.top + (li + 0.5) * lh);
    }, tok);
    fill(totalChars);
    el.style.minHeight = prev.minHeight;
    el.style.minWidth = prev.minWidth;
  }

  // ---------- finale, go live ----------
  function busy() { return S.animating > 0 || [...S.agents.values()].some((a) => a.status === 'thinking' || a.status === 'building'); }
  function maybeFinale() {
    if (!S.stats || busy() || S.finaleShown) return;
    S.finaleShown = true;
    S.clockStop = performance.now();
    setPhase('done');
    const st = S.stats;
    $('#f-wall').textContent = fmtS((st.planMs || 0) + (st.buildWallMs || 0));
    $('#f-line').textContent = st.planMs
      ? `${st.sections} sections planned in ${fmtS(st.planMs)}, then built at the same time in ${fmtS(st.buildWallMs)}.`
      : `${st.sections} sections built at the same time in ${fmtS(st.buildWallMs)}.`;
    $('#f-agents').textContent = String(st.built ?? st.sections);
    $('#f-seq').textContent = st.sumMs ? fmtS(st.sumMs) : '—';
    $('#f-speed').textContent = st.speedup ? `${st.speedup}×` : '—';
    $('#f-cost').textContent = st.costUsd != null ? `$${st.costUsd.toFixed(3)}` : st.tokens ? `${fmtK(st.tokens.out)} tokens` : 'your agent';
    $('#finale').hidden = false;
    if (S.autolive) setTimeout(() => goLive(), 2600);
  }

  async function goLive() {
    const tok = S.token;
    $('#finale').hidden = true;
    S.mode = 'live';
    setPhase('live');
    S.agents.forEach((a) => a.cursor.state('gone'));
    await sleep(700);
    if (!live(tok)) return;
    canvas.scrollTop = 0;
    if (S.autolive) {
      await sleep(800);
      const max = () => canvas.scrollHeight - canvas.clientHeight;
      await tween(clamp(max() * 3.2, 5000, 16000), (p) => { canvas.scrollTop = max() * (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2); }, tok);
      await sleep(900);
      window.__swarmDone = true;
    }
  }

  // ---------- replay ----------
  // Long idle gaps (a person thinking, an agent between steps) are squeezed to MAX_GAP so replays stay watchable.
  const MAX_GAP = 3000;
  function replay(evs = S.events.slice()) {
    reset();
    const tok = S.token;
    S.replaying = true;
    let prev = 0, shift = 0;
    evs = evs.map((e) => { const t = e.t || 0; if (t - prev > MAX_GAP) shift += t - prev - MAX_GAP; prev = t; return { ...e, t: t - shift }; });
    evs.forEach((e) => S.timers.push(setTimeout(() => live(tok) && handle(e), e.t / S.speed)));
    const end = evs.length ? (evs[evs.length - 1].t || 0) / S.speed + 20 : 0;
    S.timers.push(setTimeout(() => { if (!live(tok)) return; S.replaying = false; S.queue.splice(0).forEach((e) => handle(e)); }, end));
    S.clock = performance.now();
  }

  // ---------- comments ----------
  function setCommenting(on) {
    if (EMBED) return;
    S.commenting = on;
    document.body.classList.toggle('commenting', on);
    $('#comment-toggle').setAttribute('aria-pressed', String(on));
    if (!on) { hideHover(); closePopover(); }
    else { $('#finale').hidden = true; S.mode = S.mode === 'build' ? 'build' : 'live'; S.agents.forEach((a) => a.status === 'done' && a.cursor.state('gone')); }
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
    if (!S.commenting || !$('#popover').hidden) return;
    const el = pickTarget(e.target);
    if (!el) return hideHover();
    S.hoverEl = el;
    let box = overlay.querySelector('.hoverbox');
    if (!box) { box = document.createElement('div'); box.className = 'hoverbox'; box.innerHTML = '<span></span>'; overlay.append(box); }
    box.firstChild.textContent = `${el.closest('[data-section]').dataset.section} › ${el.localName}`;
  }
  function onStageClick(e) {
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
  function openPopover(el) {
    const sec = el.closest('[data-section]');
    S.popTarget = { el, section: sec.dataset.section, target: describe(el), path: pathWithin(el, sec) };
    $('#pop-target').textContent = `${S.popTarget.section} · ${S.popTarget.target}`;
    const r = rectOf(el);
    const pop = $('#popover');
    pop.hidden = false;
    pop.style.left = `${clamp(r.left, 8, innerWidth - 316)}px`;
    pop.style.top = `${clamp(r.bottom + 8, 64, innerHeight - 170)}px`;
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
  // Comments are applied by the user's coding agent; copy the request so it can be pasted into the chat.
  const AGENT_REQUEST = 'Apply the swarm-build comments: run `npx -y swarm-build comments` and follow the skill.';
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

  // ---------- frame loop ----------
  function frame(now) {
    if (doc && root()) {
      const dev = DEVICES[S.device];
      const fitW = Math.min(1, (canvas.clientWidth - 48) / dev.w);
      const stageH = Math.max(root().offsetHeight, 720);
      const fitH = (canvas.clientHeight - 48 - 32) / stageH;
      const target = S.mode === 'build' || S.mode === 'review' ? clamp(fitH, dev.min, fitW) : fitW;
      S.scale = Math.abs(target - S.scale) < 0.001 ? target : lerp(S.scale, target, 0.06);
      if (iframe.style.width !== `${dev.w}px`) iframe.style.width = `${dev.w}px`;
      iframe.style.height = `${stageH}px`;
      iframe.style.transform = `scale(${S.scale})`;
      frameBody.style.width = `${dev.w * S.scale}px`;
      frameBody.style.height = `${stageH * S.scale}px`;
      $('#frame').style.width = `${dev.w * S.scale}px`;

      const t = now / 1000;
      if (S.planner && S.mode === 'planning') {
        const r = canvas.getBoundingClientRect();
        S.planner.move(r.left + r.width / 2 + Math.cos(t * 1.6) * 160, r.top + r.height * 0.42 + Math.sin(t * 2.1) * 70);
      }
      if (S.reviewer && S.mode === 'review') {
        const f = iframe.getBoundingClientRect();
        const cr = canvas.getBoundingClientRect();
        const y = Math.max(f.top, cr.top) + ((t * 120) % Math.max(200, Math.min(f.height, cr.height) - 60));
        S.reviewer.move(lerp(S.reviewer.x, f.left + f.width * (0.3 + 0.4 * Math.sin(t * 0.8)), 0.08), lerp(S.reviewer.y, y, 0.15));
      }
      const followY = [];
      S.agents.forEach((a) => {
        if (a.status === 'thinking') {
          const host = hostOf(a.id);
          if (host) {
            const r = rectOf(host);
            const tx = r.left + r.width * (0.55 + 0.28 * Math.sin(t * 0.9 + a.phase));
            const ty = r.top + Math.min(r.height, 300 * S.scale) * (0.55 + 0.25 * Math.cos(t * 1.3 + a.phase));
            a.cursor.move(lerp(a.cursor.x, tx, 0.07), lerp(a.cursor.y, ty, 0.07));
            if (a.rework) place(a.rework, r.left, r.top, r.width, r.height);
          }
          a.cursor.say(a.reason === 'build' ? `thinking · ${fmtK(a.chars)} chars` : `${REASON[a.reason]}${a.note ? `: ${a.note.slice(0, 40)}` : ''}${a.chars ? ` · ${fmtK(a.chars)}` : ''}`);
          if (a.reason !== 'build') followY.push(a.cursor.y);
        }
        if (a.status === 'building') followY.push(a.cursor.y);
        agentRow(a);
      });
      // comment pins and hover box follow their elements
      S.comments.forEach((c) => {
        const pin = overlay.querySelector(`.pin[data-id="${css(c.id)}"]`);
        const el = commentEl(c);
        if (!pin || !el) return;
        const r = rectOf(el);
        pin.style.transform = `translate(${r.left + 4}px, ${r.top + 4}px)`;
      });
      if (S.hoverEl) {
        const box = overlay.querySelector('.hoverbox');
        if (box && S.hoverEl.isConnected) { const r = rectOf(S.hoverEl); place(box, r.left, r.top, r.width, r.height); } else hideHover();
      }
      if ((S.mode === 'build' || S.mode === 'review') && now - S.userScrollAt > 2500) {
        if (!followY.length) S.agents.forEach((a) => a.status === 'thinking' && followY.push(a.cursor.y));
        if (S.mode === 'review' && S.reviewer) followY.push(S.reviewer.y);
        if (followY.length) {
          const cr = canvas.getBoundingClientRect();
          const avg = followY.reduce((x, y) => x + y, 0) / followY.length;
          const d = (avg - cr.top) - canvas.clientHeight * 0.45;
          if (Math.abs(d) > 4) canvas.scrollTop += d * 0.05;
        }
      }
    }
    if (S.clock != null) $('#timer').textContent = fmtS(((S.clockStop || now) - S.clock) * (S.replaying ? S.speed : 1));
    requestAnimationFrame(frame);
  }

  // ---------- wiring ----------
  function onKey(e) {
    if (e.target.closest && e.target.closest('textarea, input')) { if (e.key === 'Escape') closePopover(); return; }
    if (e.key === 'c' || e.key === 'C') setCommenting(!S.commenting);
    if (e.key === 'Escape') { if (!$('#popover').hidden) closePopover(); else setCommenting(false); }
  }
  document.addEventListener('keydown', onKey);
  canvas.addEventListener('wheel', () => (S.userScrollAt = performance.now()), { passive: true });
  document.querySelectorAll('[data-speed]').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === S.speed));
    b.addEventListener('click', () => { S.speed = Number(b.dataset.speed); document.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
  });
  document.querySelectorAll('[data-device]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.device === S.device));
    b.addEventListener('click', () => { S.device = b.dataset.device; document.querySelectorAll('[data-device]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
  });
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

  // ?replay=1: collect the saved run first, then play it back with its original timing.
  let replayTimer = null, replayStarted = false;
  function intake(e) {
    if (e.type === 'hello') return;
    if (params.get('replay') === '1' && !replayStarted && e.type !== 'reset') {
      if (e.seq != null && e.seq <= S.received) return;
      if (e.seq != null) S.received = e.seq;
      S.events.push(e);
      clearTimeout(replayTimer);
      replayTimer = setTimeout(() => { replayStarted = true; const go = () => (S.ready ? replay(S.events.slice()) : setTimeout(go, 100)); go(); }, 400);
      return;
    }
    if (e.type === 'reset') { S.events = []; S.received = -1; S.replaying = false; reset(); return; }
    if (e.seq != null && e.seq <= S.received) return;
    if (e.seq != null) S.received = e.seq;
    S.events.push(e);
    if (!S.ready || S.replaying) { S.queue.push(e); return; }
    handle(e);
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
    S.queue.splice(0).forEach((e) => handle(e));
  });
  requestAnimationFrame(frame);

  if (!EMBED) {
    const es = new EventSource('events');
    es.onopen = () => setPhase(S.mode === 'idle' ? 'waiting' : S.mode);
    es.onmessage = (m) => intake(JSON.parse(m.data));
    es.onerror = () => setPhase('reconnecting');
  }
})();
