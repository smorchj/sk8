// recorder.js — records the session, then lets the owner REVIEW it: scrub a
// timeline, watch the run again (slow motion, jump back), and tag each bug
// where it happens (owner, 2026-09-03: "a recording to tag — I can't predict
// the future"). The tagged recording is saved to the dev server's _scratch/
// drop box and replays frame for frame in another session (SK8.replay(url)).
//
// Every frame: dt, the two input channels (steer, spin), the discrete input
// callbacks that fired since the last frame (wind-up, pop, push, grab, revert,
// brake, reset …) and a compact physics state. The game is deterministic given
// the layout, stance, skills, the start state and the dt sequence.

export class Recorder {
  constructor({ physics, anim, input, park, getStance, setStance, getSkills, setSkill, fire, flash, tick }) {
    Object.assign(this, { physics, anim, input, park, getStance, setStance, getSkills, setSkill, fire, flash, tick });
    this.frames = [];          // [dt, steer, spin, cbs|0, x, y, z, yaw, vx, vy, vz, upY, grounded, surfId, animId]
    this.tags = [];            // {id, frame, t}
    this.pending = [];         // callbacks fired since the last frame: [name, ...args]
    this.strings = [];         // interned surface / anim state names
    this.start = null;         // physics + anim snapshot at the first frame
    this.time = 0;
    this.replaying = null;     // {rec, i, time, divergence}
    this.playing = false;
    this.speed = 1;
    this.acc = 0;
    this.checkpoints = [];     // {i, time, snap} — quiet moments to seek back to
    this.limit = 90000;        // frames (25 min at 60 fps)
    this.panel = null;
    this.saved = false;
    this._key = (e) => this._onKey(e);
  }

  _intern(s) {
    s = s == null ? '' : String(s);
    let i = this.strings.indexOf(s);
    if (i < 0) { i = this.strings.length; this.strings.push(s); }
    return i;
  }

  _snapshot() {
    const p = this.physics;
    return {
      pos: p.pos.toArray(), vel: p.vel.toArray(), yaw: p.yaw, up: p.up.toArray(), forward: p.forward.toArray(),
      rollSign: p.rollSign, grounded: p.grounded, airTime: p.airTime, surface: p.surface,
      anim: this.anim.state,
    };
  }
  _applySnapshot(s) {
    const p = this.physics;
    p.pos.fromArray(s.pos); p.vel.fromArray(s.vel); p.yaw = s.yaw;
    p.up.fromArray(s.up); p.forward.fromArray(s.forward);
    p.rollSign = s.rollSign; p.grounded = s.grounded; p.airTime = s.airTime || 0;
    p.surface = s.surface; p.vert = null; p.grind = null; p.revert = null; p._lastEdge = null;
    p._steerSm = 0; p._turn = 0; p._prevN = null; p.airSpin = 0; p.braking = false; p.pushing = false; p._ignoreT = 0;
    p.world?.setIgnored(null);
    this.anim._toState(s.anim || 'ride');
    this.anim.trick = null; this.anim._airPending = null; this.anim.wantGrab = null;
  }

  // an input callback fired (between frames)
  cb(name, args) {
    if (this.replaying) return;
    this.pending.push([name, ...args]);
  }

  // called once per game frame, after the input channels are read
  frame(dt) {
    if (this.replaying) return;
    if (!this.start) this.start = this._snapshot();
    if (this.frames.length >= this.limit) return;
    const p = this.physics;
    this.time += dt;
    this.frames.push([
      +dt.toFixed(5), +this.input.steer.toFixed(3), +(this.input.spin || 0).toFixed(3),
      this.pending.length ? this.pending : 0,
      +p.pos.x.toFixed(4), +p.pos.y.toFixed(4), +p.pos.z.toFixed(4), +p.yaw.toFixed(4),
      +p.vel.x.toFixed(3), +p.vel.y.toFixed(3), +p.vel.z.toFixed(3), +p.up.y.toFixed(3),
      p.grounded ? 1 : 0, this._intern(p.surface), this._intern(this.anim.state),
    ]);
    this.pending = [];
    this.saved = false;
  }

  // start a fresh recording from the current state
  restartRecording() {
    this.frames = []; this.tags = []; this.pending = []; this.strings = [];
    this.start = null; this.time = 0; this.saved = false;
  }

  toJSON() {
    return {
      version: 1, saved: new Date().toISOString(), frames: this.frames.length, tags: this.tags,
      stance: this.getStance(), skills: this.getSkills(), layout: this.park.getLayout(),
      start: this.start, strings: this.strings, data: this.frames,
    };
  }

  // save to the dev server's _scratch/ drop box (or download it)
  async save() {
    const rec = this.replaying ? this.replaying.rec : this.toJSON();
    rec.tags = this.tags;
    const name = `rec-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    const json = JSON.stringify(rec);
    let where = '';
    try {
      const r = await fetch(`/_scratch/${name}`, { method: 'POST', body: json, headers: { 'Content-Type': 'text/plain' } });
      if (r.ok) where = `_scratch/${name}`;
    } catch { /* not the dev server */ }
    if (!where) try {                                   // no drop box (e.g. GitHub Pages): download instead
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch { /* no DOM */ }
    this.saved = true;
    const msg = `saved ${where || name}: ${rec.data.length} frames, ${this.tags.length} bug tag(s)`;
    this.flash?.(msg);
    if (this.panel) this.panel.querySelector('.recMsg').textContent = msg;
    console.log('[sk8 rec] ' + msg);
    return where || name;
  }

  // ── replay ────────────────────────────────────────────────────────────────
  async load(src) {
    const rec = typeof src === 'string' ? await (await fetch(src)).json() : src;
    this.review(rec);
    return rec;
  }

  replayStart(rec) {
    this.input.disabled = true;
    if (rec.layout) this.park.setLayout(rec.layout.map(r => ({ ...r })));
    if (rec.stance) this.setStance(rec.stance);
    for (const [k, v] of Object.entries(rec.skills || {})) this.setSkill(k, v);
    if (rec.start) this._applySnapshot(rec.start);
    this.replaying = { rec, i: 0, divergence: null, time: 0 };
    this.checkpoints = [];
  }

  replayStop() {
    this.replaying = null;
    this.playing = false;
    this.input.disabled = false;
  }

  // one recorded frame → the dt to tick with, after firing that frame's
  // callbacks and setting the input channels; null when finished
  replayBegin() {
    const r = this.replaying;
    if (!r || r.i >= r.rec.data.length) return null;
    const f = r.rec.data[r.i];
    if (f[3]) for (const c of f[3]) this.fire(c[0], c.slice(1));
    this.input.steer = f[1];
    this.input.spin = f[2];
    return f[0];
  }

  // after the tick: compare with what was recorded; keep quiet checkpoints
  replayEnd() {
    const r = this.replaying;
    if (!r) return;
    const f = r.rec.data[r.i];
    const p = this.physics, a = this.anim;
    // (a frame's recorded state is its START; after this tick we are at the
    // start of the next one)
    const g = r.rec.data[r.i + 1];
    const d = g ? Math.hypot(p.pos.x - g[4], p.pos.y - g[5], p.pos.z - g[6]) : 0;
    if (!r.divergence && d > 0.02) {
      r.divergence = { frame: r.i + 1, d: +d.toFixed(3), recorded: [g[4], g[5], g[6]], replayed: p.pos.toArray().map(v => +v.toFixed(3)) };
      console.warn('[sk8 rec] replay diverged', r.divergence);
    }
    r.time += f[0];
    r.i++;
    const last = this.checkpoints[this.checkpoints.length - 1];
    if ((!last || r.i - last.i >= 90) && a.state === 'ride' && !a.trick && p.grounded && !p.grind && !p.vert && !p.revert) {
      this.checkpoints.push({ i: r.i, time: r.time, snap: this._snapshot() });
    }
  }

  // the live loop, while replaying: play at `speed` (frames per rendered frame)
  advance() {
    if (!this.replaying || !this.playing) return;
    this.acc += this.speed;
    while (this.acc >= 1) {
      this.acc -= 1;
      const rdt = this.replayBegin();
      if (rdt == null) { this.playing = false; break; }
      this.tick(rdt);
    }
    this._refresh();
  }

  // jump to a frame: back = restore the nearest quiet checkpoint before it
  // (or restart), then run forward
  seek(frame) {
    const r = this.replaying;
    if (!r) return;
    frame = Math.max(0, Math.min(r.rec.data.length, Math.round(frame)));
    if (frame < r.i) {
      let cp = null;
      for (const c of this.checkpoints) if (c.i <= frame) cp = c;
      if (cp) { this._applySnapshot(cp.snap); r.i = cp.i; r.time = cp.time; }
      else { this._applySnapshot(r.rec.start); r.i = 0; r.time = 0; r.divergence = null; }
    }
    let guard = 0;
    while (r.i < frame && guard++ < 200000) {
      const rdt = this.replayBegin();
      if (rdt == null) break;
      this.tick(rdt);
    }
    this._refresh();
  }

  // the recorded state of frame i (reading a bug without replaying)
  recorded(i, rec = this.replaying?.rec) {
    const f = rec?.data[i];
    if (!f) return null;
    return { frame: i, dt: f[0], steer: f[1], spin: f[2], cbs: f[3] || [], pos: [f[4], f[5], f[6]], yaw: f[7], vel: [f[8], f[9], f[10]], upY: f[11], grounded: !!f[12], surface: rec.strings[f[13]], anim: rec.strings[f[14]] };
  }

  // ── review: the timeline panel ────────────────────────────────────────────
  // F4: replay the session so far (or a loaded recording) with a scrubbable
  // timeline; N (or the button) tags the moment shown; save writes it out
  review(rec = null) {
    if (this.replaying) return;
    if (!rec) {
      if (!this.frames.length) { this.flash?.('nothing recorded yet'); return; }
      rec = this.toJSON();
    } else {
      this.tags = rec.tags || [];
    }
    this.replayStart(rec);
    this.playing = false;
    this.speed = 1;
    this._panel();
    addEventListener('keydown', this._key);
    this._refresh();
    this.flash?.('REVIEW: scrub the timeline, N tags a bug');
  }

  // tag the moment currently shown (review) — or, live, the last moment
  tag() {
    const r = this.replaying;
    const frame = r ? r.i : this.frames.length;
    const t = +(r ? r.time : this.time).toFixed(2);
    const tag = { id: this.tags.length + 1, frame, t };
    this.tags.push(tag);
    this.saved = false;
    this.flash?.(`BUG #${tag.id} at ${t.toFixed(1)} s`);
    console.log(`[sk8 rec] bug #${tag.id} tagged at frame ${frame} (${t}s)`);
    this._refresh();
    return tag;
  }
  untag(id) {
    this.tags = this.tags.filter(t => t.id !== id);
    this._refresh();
  }

  close() {
    if (!this.replaying) return;
    removeEventListener('keydown', this._key);
    this.replayStop();
    this.panel?.remove(); this.panel = null;
    // the game goes on from here; the next recording starts here too
    this.restartRecording();
  }

  _onKey(e) {
    if (!this.replaying) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const r = this.replaying;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); this.playing = !this.playing; this._refresh(); }
    else if (k === 'arrowleft') { e.preventDefault(); this.seek(r.i - (e.shiftKey ? 600 : 120)); }
    else if (k === 'arrowright') { e.preventDefault(); this.seek(r.i + (e.shiftKey ? 600 : 120)); }
    else if (k === 'arrowdown') { e.preventDefault(); this.seek(r.i - 6); }
    else if (k === 'arrowup') { e.preventDefault(); this.seek(r.i + 6); }
    else if (k === 'n') { if (!e.repeat) this.tag(); }
    else if (k === 'escape') { this.close(); }
    else if (e.code === 'F4') { e.preventDefault(); }
  }

  _panel() {
    if (this.panel) return this.panel;
    const d = document.createElement('div');
    d.id = 'recPanel';
    d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:64px;z-index:31;background:rgba(18,20,26,.94);color:#e6e9ef;font:13px/1.45 system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4)';
    d.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <b>Review</b><span class="recPos" style="color:#aab2c0"></span>
        <span style="margin-left:auto;color:#8a93a3">Space play/pause · ←/→ 2 s (Shift 10 s) · ↑/↓ frames · N tag · Esc close</span>
      </div>
      <canvas class="recBar" height="28" style="width:100%;height:28px;display:block;border-radius:6px;cursor:pointer;background:#2a3040"></canvas>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center">
        <button data-a="back10">⏮ 10 s</button><button data-a="back2">◀ 2 s</button>
        <button data-a="play">▶ play</button>
        <button data-a="fwd2">2 s ▶</button>
        <button data-a="speed" data-v="0.25">¼×</button><button data-a="speed" data-v="0.5">½×</button><button data-a="speed" data-v="1">1×</button><button data-a="speed" data-v="4">4×</button>
        <button data-a="tag" style="background:#7a2f3a;border-color:#a04050">🐞 tag this moment (N)</button>
        <span class="recTags" style="color:#ffb3b3"></span>
        <button data-a="save" style="margin-left:auto;background:#2f5a3a;border-color:#3f7a4a">save recording</button>
        <button data-a="close">close</button>
      </div>
      <div class="recMsg" style="color:#8fd3a0;margin-top:4px;min-height:16px"></div>`;
    document.body.appendChild(d);
    for (const b of d.querySelectorAll('button')) b.style.cssText += ';background:#2a3040;color:#e6e9ef;border:1px solid #3a4256;border-radius:6px;padding:4px 9px;font:12px system-ui,sans-serif;cursor:pointer' + (b.dataset.a === 'tag' ? ';background:#7a2f3a;border-color:#a04050' : b.dataset.a === 'save' ? ';background:#2f5a3a;border-color:#3f7a4a' : '');
    d.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      const r = this.replaying;
      const a = b.dataset.a;
      if (a === 'back10') this.seek(r.i - 600);
      if (a === 'back2') this.seek(r.i - 120);
      if (a === 'fwd2') this.seek(r.i + 120);
      if (a === 'play') { this.playing = !this.playing; this._refresh(); }
      if (a === 'speed') { this.speed = +b.dataset.v; this._refresh(); }
      if (a === 'tag') this.tag();
      if (a === 'save') this.save();
      if (a === 'close') this.close();
      if (a === 'untag') this.untag(+b.dataset.id);
    });
    const bar = d.querySelector('.recBar');
    const seekAt = (e) => { const rect = bar.getBoundingClientRect(); const u = (e.clientX - rect.left) / rect.width; this.seek(u * this.replaying.rec.data.length); };
    let drag = false;
    bar.addEventListener('pointerdown', (e) => { drag = true; this.playing = false; seekAt(e); });
    bar.addEventListener('pointermove', (e) => { if (drag) seekAt(e); });
    addEventListener('pointerup', () => { drag = false; });
    this.panel = d;
    return d;
  }

  _refresh() {
    const d = this.panel, r = this.replaying;
    if (!d || !r) return;
    const n = r.rec.data.length;
    const total = r.rec.data.reduce((s, f) => s + f[0], 0);
    d.querySelector('.recPos').textContent = `${r.time.toFixed(1)} s / ${total.toFixed(1)} s · frame ${r.i}/${n} · ${this.playing ? 'playing' : 'paused'} ${this.speed}×`;
    d.querySelector('button[data-a=play]').textContent = this.playing ? '⏸ pause' : '▶ play';
    d.querySelector('.recTags').innerHTML = this.tags.length
      ? this.tags.map(t => `<span style="margin-right:6px">#${t.id} ${t.t.toFixed(1)}s <button data-a="untag" data-id="${t.id}" style="padding:0 5px;background:#3a2530;color:#ffb3b3;border:1px solid #6a3540;border-radius:4px;cursor:pointer">×</button></span>`).join('')
      : 'no tags yet';
    const bar = d.querySelector('.recBar');
    const W = bar.width = bar.clientWidth * (devicePixelRatio || 1), H = bar.height = 28 * (devicePixelRatio || 1);
    const g = bar.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#2a3040'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#3d6dff'; g.fillRect(0, 0, W * (r.i / Math.max(1, n)), H);
    for (const t of this.tags) { const x = W * (t.frame / Math.max(1, n)); g.fillStyle = '#ff5a5a'; g.fillRect(x - 1.5, 0, 3, H); }
    g.fillStyle = '#fff'; g.fillRect(W * (r.i / Math.max(1, n)) - 1, 0, 2, H);
  }
}
