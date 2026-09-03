// recorder.js — records the session for bug reports and replays it frame for
// frame (owner, 2026-09-03: "add a record for me with tagging so I can show
// you all the bugs" / "then you can replay my input exactly").
//
// Every frame: its dt, the two input channels (steer, spin), the discrete
// input callbacks that fired since the last frame (wind-up, pop, push, grab,
// revert, brake, reset …) and a compact physics state (for divergence
// checks and for reading the bug without replaying). N tags the moment as a
// bug; F4 saves the recording to the dev server's _scratch/ drop box (and
// downloads it). The game is deterministic given the layout, stance, skills,
// the start state and the dt sequence, so SK8.replay(url) reproduces the run.

export class Recorder {
  constructor({ physics, anim, input, park, getStance, setStance, getSkills, setSkill, fire, flash }) {
    Object.assign(this, { physics, anim, input, park, getStance, setStance, getSkills, setSkill, fire, flash });
    this.frames = [];          // [dt, steer, spin, cbs|0, x, y, z, yaw, vx, vy, vz, upY, grounded, surfId, animId]
    this.tags = [];            // {id, frame, t}
    this.pending = [];         // callbacks fired since the last frame: [name, ...args]
    this.strings = [];         // interned surface / anim state names
    this.start = null;         // physics + anim snapshot at the first frame
    this.time = 0;
    this.replaying = null;     // {rec, i, divergence}
    this.limit = 90000;        // frames (25 min at 60 fps)
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
  }

  // N: mark this moment as a bug
  tag() {
    if (this.replaying) return null;
    const t = { id: this.tags.length + 1, frame: this.frames.length, t: +this.time.toFixed(2) };
    this.tags.push(t);
    this.flash?.(`BUG #${t.id} tagged`);
    console.log(`[sk8 rec] bug #${t.id} tagged at frame ${t.frame} (${t.t}s)`);
    return t;
  }

  toJSON() {
    return {
      version: 1, saved: new Date().toISOString(), frames: this.frames.length, tags: this.tags,
      stance: this.getStance(), skills: this.getSkills(), layout: this.park.getLayout(),
      start: this.start, strings: this.strings, data: this.frames,
    };
  }

  // F4: save to the dev server's _scratch/ drop box, and download it
  async save() {
    const name = `rec-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    const json = JSON.stringify(this.toJSON());
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
    const msg = `recording saved: ${this.frames.length} frames, ${this.tags.length} bug tag(s)${where ? ' → ' + where : ''}`;
    this.flash?.(msg);
    console.log('[sk8 rec] ' + msg);
    return where || name;
  }

  // ── replay ────────────────────────────────────────────────────────────────
  async load(src) {
    const rec = typeof src === 'string' ? await (await fetch(src)).json() : src;
    this.replayStart(rec);
    return rec;
  }

  replayStart(rec) {
    const p = this.physics;
    this.input.disabled = true;
    if (rec.layout) this.park.setLayout(rec.layout.map(r => ({ ...r })));
    if (rec.stance) this.setStance(rec.stance);
    for (const [k, v] of Object.entries(rec.skills || {})) this.setSkill(k, v);
    const s = rec.start;
    if (s) {
      p.pos.fromArray(s.pos); p.vel.fromArray(s.vel); p.yaw = s.yaw;
      p.up.fromArray(s.up); p.forward.fromArray(s.forward);
      p.rollSign = s.rollSign; p.grounded = s.grounded; p.airTime = s.airTime || 0;
      p.surface = s.surface; p.vert = null; p.grind = null; p.revert = null;
      p._steerSm = 0; p._turn = 0; p._prevN = null; p.airSpin = 0; p.braking = false; p.pushing = false;
      this.anim._toState(s.anim || 'ride');
    }
    this.replaying = { rec, i: 0, divergence: null, time: 0 };
    console.log(`[sk8 rec] replaying ${rec.data.length} frames, tags: ${(rec.tags || []).map(t => `#${t.id}@${t.frame}`).join(' ') || 'none'}`);
  }

  replayStop() {
    this.replaying = null;
    this.input.disabled = false;
  }

  // one recorded frame → returns the dt to tick with, after firing that
  // frame's callbacks and setting the input channels; null when finished
  replayBegin() {
    const r = this.replaying;
    if (!r || r.i >= r.rec.data.length) { if (r) this.replayStop(); return null; }
    const f = r.rec.data[r.i];
    if (f[3]) for (const c of f[3]) this.fire(c[0], c.slice(1));
    this.input.steer = f[1];
    this.input.spin = f[2];
    return f[0];
  }

  // after the tick: compare with what was recorded
  replayEnd() {
    const r = this.replaying;
    if (!r) return;
    const f = r.rec.data[r.i];
    const p = this.physics;
    const d = Math.hypot(p.pos.x - f[4], p.pos.y - f[5], p.pos.z - f[6]);
    if (!r.divergence && d > 0.02) {
      r.divergence = { frame: r.i, d: +d.toFixed(3), recorded: [f[4], f[5], f[6]], replayed: p.pos.toArray().map(v => +v.toFixed(3)) };
      console.warn('[sk8 rec] replay diverged', r.divergence);
    }
    r.time += f[0];
    r.i++;
  }

  // the recorded state of frame i (for reading a bug without replaying)
  recorded(i, rec = this.replaying?.rec) {
    const f = rec?.data[i];
    if (!f) return null;
    return { frame: i, dt: f[0], steer: f[1], spin: f[2], cbs: f[3] || [], pos: [f[4], f[5], f[6]], yaw: f[7], vel: [f[8], f[9], f[10]], upY: f[11], grounded: !!f[12], surface: rec.strings[f[13]], anim: rec.strings[f[14]] };
  }
}
