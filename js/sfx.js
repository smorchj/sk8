// sfx.js — the board's voice, synthesised.
//
// Nothing here is a recording. That is partly a licensing answer and mostly a
// better one: the sounds that matter most — the roll, the grind — are
// CONTINUOUS and speed-dependent, and a sample can only ever be right at the
// speed it was recorded. A loop pitched up to match 8 m/s sounds like a fan.
// Filtered noise driven off physics.speed() is right at every speed, every
// frame, for nothing.
//
// VARIATION is the whole problem with synthetic rolling: a fixed filter on a
// looping buffer is a drone, and the ear finds the loop in seconds. Four things
// fight that here, and they are all cheap:
//   · a long noise bed read by TWO sources at different rates, so the pattern
//     never comes round (7 s at 0.83x against 7 s at 1.19x)
//   · every filter and gain random-walks slowly, so the texture drifts
//   · GRAVEL: individual grains fired at a rate set by speed, each with its own
//     pitch and level — a real roll is a dense stream of micro-impacts, and
//     this is the part that actually stops it sounding like noise
//   · the paving's own joints, read off the height map, clunking past
//
// The one-shots are modelled on measurements of the owner's takes
// (tools/sfx-onsets.mjs, and a band analysis of the revert): a pop is a hard
// broadband crack over a woody ~180 Hz body; a landing is that an octave down
// with weight and wheels behind it, sitting 1 dB under to 9 dB over its pop; a
// revert is NOT a squeal but a 500-1200 Hz scrub that swells to full at 0.15 s
// and holds for 0.4 s. Air is SILENT, as it is in the recording.
//
// Everything reads the physics from outside. No hooks, nothing to keep in step.

import { groundKind, TILE } from './terrain.js';

const NOISE_SECONDS = 7;                 // long enough that the loop is not a rhythm
const WHEELBASE = 0.42;                  // m between the trucks — the gap in the "clunk-a"
const SEAMS_URL = 'assets/park/textures/concrete_seams.json';

// How each ground rolls. rumble/grain are levels, grainHz the grit's centre,
// body the deck resonance, roll an overall scale, gravelHz the grain pitch.
const GROUND = {
  concrete: { rumble: 1.00, grain: 0.55, grainHz: 1900, body: 1.2, roll: 1.00, gravelHz: 1200, gravel: 0.8, seams: true },
  asphalt:  { rumble: 0.95, grain: 0.95, grainHz: 1500, body: 0.7, roll: 0.95, gravelHz: 850,  gravel: 1.5, seams: false },
  grass:    { rumble: 0.35, grain: 0.45, grainHz: 3800, body: 0.2, roll: 0.32, gravelHz: 2600, gravel: 0.5, seams: false },
};
// props keep using the collider tag — they are their own objects
const PROPS = [
  { m: /ramp|pipe|haven/, v: { rumble: 0.95, grain: 0.5, grainHz: 2400, body: 1.9, roll: 1.05, gravelHz: 900, gravel: 0.35, seams: false } },  // ply: hollow and boomy
  { m: /rail/,            v: { rumble: 0.35, grain: 1.0, grainHz: 4600, body: 0.4, roll: 0.7,  gravelHz: 3000, gravel: 0.2, seams: false } },
  { m: /ledge|bench|table|bridge|stair/, v: { rumble: 0.8, grain: 0.85, grainHz: 3300, body: 0.9, roll: 0.95, gravelHz: 1900, gravel: 0.8, seams: false } },
];

const lerp = (a, b, t) => a + (b - a) * t;

export class SkateSfx {
  constructor({ listener, physics, anim }) {
    this.phys = physics;
    this.anim = anim;
    this.ctx = listener.context;
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(listener.getInput());

    this._noise = null;
    this._built = false;
    this._v = { ...GROUND.concrete };      // the voicing actually in use, eased toward the target
    this._dist = 0;                        // metres rolled — drives gravel and wobble
    this._gravelDue = 0;
    this._walk = [0, 0, 0];                // slow random walks for the bed
    this._u = null; this._w = null;        // last tile uv, for seam crossings
    this._wasGrounded = true; this._wasGrinding = false;
    this._wasReverting = false; this._wasPushing = false;
    this._fallV = 0; this._airT = 0;

    this.seams = { across: [0.25, 0.5, 0.75], along: [0.5], acrossDepth: [1, 1, 1], alongDepth: [1] };
    fetch(SEAMS_URL).then(r => r.json()).then(s => { if (s.across?.length) this.seams = s; })
      .catch(() => {/* the defaults are a plain grid */});
  }

  get running() { return this.ctx.state === 'running'; }

  _noiseBuffer() {
    if (!this._noise) {
      const n = Math.floor(this.ctx.sampleRate * NOISE_SECONDS);
      const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < n; i++) {          // a touch of brown in it: less hiss, more surface
        last = (last + (Math.random() * 2 - 1) * 0.35) * 0.94;
        d[i] = Math.max(-1, Math.min(1, (Math.random() * 2 - 1) * 0.7 + last));
      }
      this._noise = b;
    }
    return this._noise;
  }

  _build() {
    if (this._built || !this.running) return;
    const ctx = this.ctx;
    // both beds run through one bus so a seam can break the roll for a moment
    this.rollBus = ctx.createGain();
    this.rollBus.gain.value = 1;
    this.rollBus.connect(this.out);
    const bed = (rate, offset) => {
      const s = ctx.createBufferSource();
      s.buffer = this._noiseBuffer(); s.loop = true; s.playbackRate.value = rate;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500; lp.Q.value = 0.8;
      const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 190; body.Q.value = 1.3; body.gain.value = 7;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 0.7;
      const lpG = ctx.createGain(), bpG = ctx.createGain(); bpG.gain.value = 0.3;
      const g = ctx.createGain(); g.gain.value = 0;
      s.connect(lp); lp.connect(body); body.connect(lpG); lpG.connect(g);
      s.connect(bp); bp.connect(bpG); bpG.connect(g);
      g.connect(this.rollBus);
      s.start(0, offset);
      return { s, lp, body, bp, lpG, bpG, g };
    };
    // two reads of the same bed at rates with no common period
    this.bedA = bed(0.83, 0);
    this.bedB = bed(1.19, 3.1);

    const gsrc = ctx.createBufferSource(); gsrc.buffer = this._noiseBuffer(); gsrc.loop = true;
    const scrape = ctx.createBiquadFilter(); scrape.type = 'bandpass'; scrape.frequency.value = 2400; scrape.Q.value = 3;
    const ring = ctx.createBiquadFilter(); ring.type = 'peaking'; ring.frequency.value = 3100; ring.Q.value = 12; ring.gain.value = 0;
    const grindG = ctx.createGain(); grindG.gain.value = 0;
    gsrc.connect(scrape); scrape.connect(ring); ring.connect(grindG); grindG.connect(this.out);
    gsrc.start();
    this.grindVoice = { scrape, ring, gain: grindG };

    this._built = true;
  }

  setVolume(v) { this.out.gain.value = Math.max(0, Math.min(1.5, v)); }

  // ── builders ──────────────────────────────────────────────────────────────
  _burst({ at = 0, freq, q = 1, type = 'bandpass', dur, gain, sweepTo = null, attack = 0.002, hold = 0 }) {
    const ctx = this.ctx, t = ctx.currentTime + at;
    const s = ctx.createBufferSource(); s.buffer = this._noiseBuffer(); s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1e-4, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    if (hold) g.gain.setValueAtTime(gain, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    s.connect(f); f.connect(g); g.connect(this.out);
    s.start(t, Math.random() * (NOISE_SECONDS - 1)); s.stop(t + dur + 0.02);
  }

  _tone({ at = 0, freq, dur, gain, type = 'sine', sweepTo = null }) {
    const ctx = this.ctx, t = ctx.currentTime + at;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1e-4, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    o.connect(g); g.connect(this.out);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // ── hits ──────────────────────────────────────────────────────────────────
  pop(strength = 1) {
    if (!this.running) return;
    const v = 0.9 + Math.random() * 0.2;
    this._burst({ freq: 1500 * v, q: 0.9, dur: 0.075, gain: 0.5 * strength });
    this._burst({ freq: 5200 * v, q: 0.7, type: 'highpass', dur: 0.02, gain: 0.28 * strength });
    this._tone({ freq: 190 * v, sweepTo: 120 * v, dur: 0.1, gain: 0.34 * strength, type: 'triangle' });
  }

  land(impact = 1) {
    if (!this.running) return;
    const k = Math.max(0.35, Math.min(1.4, impact));
    const v = 0.9 + Math.random() * 0.2;
    this._burst({ freq: 900 * v, q: 0.8, dur: 0.11, gain: 0.5 * k });
    this._tone({ freq: 120 * v, sweepTo: 62 * v, dur: 0.16, gain: 0.45 * k, type: 'sine' });
    this._burst({ freq: 3000, q: 0.5, dur: 0.006, gain: 0.3 * k });
    this._burst({ freq: 380, q: 0.6, type: 'lowpass', dur: 0.22, gain: 0.22 * k, sweepTo: 900 });
  }

  // A revert is urethane scrubbing SIDEWAYS, not a squeal. Banded 500-1200 Hz,
  // swelling to full at ~0.15 s, holding, then dropping away by 0.42 — the
  // shape measured off the owner's revert_01 take.
  revert() {
    if (!this.running) return;
    const v = 0.92 + Math.random() * 0.16;
    this._burst({ freq: 820 * v, q: 1.1, dur: 0.44, gain: 0.62, sweepTo: 620 * v, attack: 0.14, hold: 0.14 });
    this._burst({ freq: 1500 * v, q: 1.5, dur: 0.40, gain: 0.24, sweepTo: 1000 * v, attack: 0.16, hold: 0.10 });
    this._burst({ freq: 300, q: 0.7, type: 'lowpass', dur: 0.34, gain: 0.20, attack: 0.12, hold: 0.08 });
    this._tone({ at: 0.05, freq: 210 * v, sweepTo: 165 * v, dur: 0.26, gain: 0.10, type: 'triangle' });
  }

  pushScuff() {
    if (!this.running) return;
    this._burst({ freq: 1100, q: 0.6, type: 'lowpass', dur: 0.16, gain: 0.2, sweepTo: 500, attack: 0.02 });
  }

  grindStart(kind) {
    if (!this.running) return;
    this._burst({ freq: kind === 'rail' ? 3400 : 1600, q: 1.2, dur: 0.09, gain: 0.34 });
  }

  bail() {
    if (!this.running) return;
    for (let i = 0; i < 5; i++) {
      const at = i * (0.05 + Math.random() * 0.08);
      this._burst({ at, freq: 700 + Math.random() * 1800, q: 1, dur: 0.06 + Math.random() * 0.05, gain: 0.3 });
      if (i % 2 === 0) this._tone({ at, freq: 110 + Math.random() * 80, dur: 0.09, gain: 0.2, type: 'triangle' });
    }
  }

  // A joint under the wheels is "clunk-A": the FRONT truck drops in, then the
  // back one a wheelbase later — which is why it is two sounds and not one. It
  // is all bottom end; the bright little bursts that used to be in here read as
  // crackling leaves. The roll also breaks for a moment as the wheels drop in.
  seam(level, depth, sp) {
    const gap = Math.min(0.17, Math.max(0.035, WHEELBASE / Math.max(sp, 2.4)));
    for (let i = 0; i < 2; i++) {
      const at = i * gap;
      const g = level * depth * (i ? 0.7 : 1);          // the back truck lands softer
      const v = 0.9 + Math.random() * 0.2;
      this._tone({ at, freq: 124 * v, sweepTo: 58 * v, dur: 0.11, gain: 0.5 * g, type: 'sine' });
      this._tone({ at, freq: 188 * v, sweepTo: 112 * v, dur: 0.06, gain: 0.18 * g, type: 'triangle' });
      this._burst({ at, freq: 300 * v, q: 0.7, type: 'lowpass', dur: 0.05, gain: 0.22 * g });
    }
    const t = this.ctx.currentTime, d = this.rollBus.gain;
    d.cancelScheduledValues(t);
    d.setValueAtTime(d.value, t);
    d.linearRampToValueAtTime(0.4, t + 0.012);          // the wheels leave the surface
    d.linearRampToValueAtTime(1, t + gap + 0.10);
  }

  // ── which surface, and its voicing ────────────────────────────────────────
  _voice() {
    const p = this.phys, tag = p.surface || '';
    const prop = PROPS.find(x => x.m.test(tag));
    if (prop) return prop.v;
    return GROUND[groundKind(p.pos.x, p.pos.z)] || GROUND.concrete;
  }

  // did we cross a joint between the last uv and this one?
  _seamCross(u0, u1, lines, depths) {
    if (u0 === null) return 0;
    let d = u1 - u0;
    if (Math.abs(d) > 0.5) d -= Math.sign(d);          // wrapped round the tile
    if (!d) return 0;
    const a = u0, b = u0 + d;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      for (let k = -1; k <= 1; k++) {                   // the tile repeats
        const x = L + k;
        if ((a < x && x <= b) || (b <= x && x < a)) return depths?.[i] ?? 1;
      }
    }
    return 0;
  }

  // ── per frame ─────────────────────────────────────────────────────────────
  update(dt) {
    this._build();
    if (!this._built) return;
    const p = this.phys, ctx = this.ctx, now = ctx.currentTime;
    const sp = p.speed();
    const grounded = p.grounded, grinding = !!p.grind;
    const rolling = grounded && !grinding && sp > 0.15;
    const f = Math.min(1, sp / 9);

    // ease the voicing so a seam between surfaces does not switch abruptly
    const want = this._voice(), v = this._v, k = Math.min(1, dt * 6);
    for (const key of Object.keys(want)) {
      v[key] = typeof want[key] === 'number' ? lerp(v[key] ?? want[key], want[key], k) : want[key];
    }

    // slow random walks: the surface is never the same twice
    for (let i = 0; i < 3; i++) {
      this._walk[i] += (Math.random() - 0.5) * dt * 1.6;
      this._walk[i] = Math.max(-1, Math.min(1, this._walk[i] * 0.995));
    }
    const [w0, w1, w2] = this._walk;

    this._dist += sp * dt;
    const wob = 1 + 0.09 * Math.sin(this._dist * 5.3) + 0.05 * Math.sin(this._dist * 11.7 + w0);

    const lvl = rolling ? Math.min(1, 0.05 + f * 0.85) * wob * v.roll : 0;
    for (const [bed, tilt] of [[this.bedA, 1], [this.bedB, -1]]) {
      bed.g.gain.setTargetAtTime(lvl * 0.15, now, rolling ? 0.05 : 0.09);
      bed.lp.frequency.setTargetAtTime((160 + f * 560) * (1 + 0.18 * w0 * tilt), now, 0.09);
      bed.bp.frequency.setTargetAtTime(v.grainHz * (0.5 + f * 0.6) * (1 + 0.22 * w1 * tilt), now, 0.09);
      bed.bpG.gain.setTargetAtTime((0.03 + f * 0.17) * v.grain * (1 + 0.25 * w2 * tilt), now, 0.09);
      bed.lpG.gain.setTargetAtTime(v.rumble, now, 0.12);
      bed.body.gain.setTargetAtTime(3 + 7 * v.body, now, 0.15);
    }

    // GRAVEL — the micro-impacts. Rate rises with speed, so it thickens as you
    // go rather than just getting louder.
    if (rolling && sp > 0.6) {
      const rate = (2.5 + f * 15) * v.gravel;
      this._gravelDue -= dt * rate;
      while (this._gravelDue <= 0) {
        this._gravelDue += 0.5 + Math.random();
        const j = 0.6 + Math.random() * 0.9;
        this._burst({ at: Math.random() * 0.02, freq: v.gravelHz * j, q: 1.1 + Math.random(),
          dur: 0.012 + Math.random() * 0.02, gain: (0.008 + 0.028 * f) * (0.5 + Math.random()) });
      }
    }

    // the paving's own joints
    if (rolling && v.seams && sp > 1.0) {
      const u = p.pos.x / TILE.concrete[0], w = p.pos.z / TILE.concrete[1];
      const uu = u - Math.floor(u), ww = w - Math.floor(w);
      const dA = this._seamCross(this._u, uu, this.seams.across, this.seams.acrossDepth);
      const dB = this._seamCross(this._w, ww, this.seams.along, this.seams.alongDepth);
      const d = Math.max(dA, dB);
      if (d) this.seam(Math.min(1, 0.3 + f), Math.min(1.3, d), sp);
      this._u = uu; this._w = ww;
    } else { this._u = null; this._w = null; }

    // ── grind ───────────────────────────────────────────────────────────────
    const gr = this.grindVoice;
    if (grinding) {
      const kind = p.grind.edge?.kind || 'ledge';
      const gv = Math.min(1, Math.abs(p.grind.v || sp) / 8);
      gr.gain.gain.setTargetAtTime(0.10 + gv * 0.30, now, 0.04);
      gr.scrape.frequency.setTargetAtTime((kind === 'rail' ? 2200 + gv * 2400 : 1200 + gv * 1200) * (1 + 0.12 * w1), now, 0.06);
      gr.scrape.Q.setTargetAtTime(kind === 'rail' ? 5 : 1.6, now, 0.06);
      gr.ring.gain.setTargetAtTime(kind === 'rail' ? 16 : 0, now, 0.06);
      gr.ring.frequency.setTargetAtTime(kind === 'rail' ? 3000 + gv * 900 : 900, now, 0.06);
    } else {
      gr.gain.gain.setTargetAtTime(0, now, 0.05);
    }
    if (grinding && !this._wasGrinding) this.grindStart(p.grind.edge?.kind);

    // ── state edges ─────────────────────────────────────────────────────────
    if (this._wasGrounded && !grounded) { this.pop(1); this._airT = 0; }
    if (!grounded) { this._airT += dt; this._fallV = Math.max(this._fallV, -p.vel.y); }
    if (!this._wasGrounded && grounded) {
      if (this._airT > 0.06) this.land(0.45 + this._fallV / 5);
      this._fallV = 0; this._airT = 0;
    }
    // the mocapped revert lives in the anim controller and never sets
    // physics.revert (that path only runs when there is no revert clip)
    const reverting = this.anim?.state === 'revert' || !!p.revert;
    if (reverting && !this._wasReverting) this.revert();
    const pushing = !!p.pushing;
    if (pushing && !this._wasPushing) this.pushScuff();

    this._wasGrounded = grounded;
    this._wasGrinding = grinding;
    this._wasReverting = reverting;
    this._wasPushing = pushing;
  }
}
