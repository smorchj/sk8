// boombox.js — the park's music comes out of a boombox, not out of nowhere.
//
// It sits in the gap between two quarter pipes. Gap over it and it switches on:
// a snatch of radio tuning first — hiss hunting across the dial, a couple of
// heterodyne squeals — and then the track comes up. Gap it again to retune to
// the next one.
//
// The trick detection watches `physics.grounded` / `pos` from the outside and
// never touches the physics: leaving the ground opens a flight, passing over
// the box's top inside `gapRadius` marks it, and touching down again pays out.
// So a roll-past is not a gap, and neither is an ollie somewhere else.
//
// Everything is positional off one PannerNode at the box, so the music is
// loudest at the ramps and thins out across the park — but `refDistance` and
// `rolloff` are wide enough that it still carries as the soundtrack.

import * as THREE from 'three';

export const BOOMBOX = {
  gapRadius: 2.6,      // m — how near the flight path has to pass, horizontally
  gapClear: 0.12,      // m — the board has to actually clear its top
  minAir: 0.22,        // s — anything shorter is a hop, not a gap
  volume: 0.85,
  refDistance: 9,      // m — full volume within this, then it falls away
  rolloff: 0.55,
  maxDistance: 150,
  tune: 1.25,          // s of dial-hunting before the track comes up
  retune: 0.7,         // s of it when changing track
  fade: 0.9,           // s for the track to come up under the hiss
};

const MANIFEST = 'assets/music/manifest.json';
const DIR = 'assets/music/';

export class Boombox {
  constructor({ camera, park }) {
    this.park = park;
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);                       // three keeps the WebAudio listener on the camera
    this.ctx = this.listener.context;

    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = BOOMBOX.refDistance;
    p.rolloffFactor = BOOMBOX.rolloff;
    p.maxDistance = BOOMBOX.maxDistance;
    p.connect(this.listener.getInput());
    this.panner = p;

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(p);

    this.on = false;
    this.track = -1;
    this.tracks = [];
    this.obj = null;
    this.wasGrounded = true;
    this.flight = null;
    this._el = null;
    this._src = null;
    this.onTrack = null;                             // (name, index) — for the HUD to announce

    fetch(MANIFEST).then(r => r.json()).then(m => { this.tracks = m.tracks || []; })
      .catch(() => console.warn('[boombox] no music manifest'));

    // browsers hold the context shut until the player has interacted
    const unlock = () => {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (this.ctx.state === 'running') {
        removeEventListener('keydown', unlock); removeEventListener('pointerdown', unlock);
      }
    };
    addEventListener('keydown', unlock);
    addEventListener('pointerdown', unlock);
  }

  // ── where the box is, in the world ────────────────────────────────────────
  _resolve() {
    const found = this.park.props.find(o => o.userData.park?.model === 'boombox') || null;
    if (found !== this.obj) { this.obj = found; this._box = null; }
    if (this.obj && !this._box) {
      const b = new THREE.Box3().setFromObject(this.obj);
      this._box = { centre: b.getCenter(new THREE.Vector3()), top: b.max.y };
      const c = this._box.centre;
      this.panner.positionX ? (this.panner.positionX.value = c.x, this.panner.positionY.value = c.y, this.panner.positionZ.value = c.z)
                            : this.panner.setPosition(c.x, c.y, c.z);
    }
    return this._box;
  }

  // ── the gap watch ─────────────────────────────────────────────────────────
  update(dt, physics) {
    const box = this._resolve();
    if (!box) { this.wasGrounded = physics.grounded; return; }
    const grounded = physics.grounded;

    if (this.wasGrounded && !grounded) this.flight = { over: false, air: 0 };
    if (!grounded && this.flight) {
      this.flight.air += dt;
      const p = physics.pos, c = box.centre;
      if (Math.hypot(p.x - c.x, p.z - c.z) < BOOMBOX.gapRadius && p.y > box.top + BOOMBOX.gapClear) this.flight.over = true;
    }
    if (!this.wasGrounded && grounded) {
      if (this.flight?.over && this.flight.air >= BOOMBOX.minAir) this.gapped();
      this.flight = null;
    }
    this.wasGrounded = grounded;
  }

  // gapped it: switch on, or retune to the next track
  gapped() {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const first = !this.on;
    this.on = true;
    const hiss = first ? BOOMBOX.tune : BOOMBOX.retune;
    this._static(hiss);
    this._play((this.track + 1) % Math.max(this.tracks.length, 1), hiss);
    return this.tracks[(this.track) % Math.max(this.tracks.length, 1)]?.name;
  }

  off(fade = 0.4) {
    this.on = false;
    const t = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.setValueAtTime(Math.max(this.musicGain.gain.value, 1e-4), t);
    this.musicGain.gain.exponentialRampToValueAtTime(1e-4, t + fade);
    const el = this._el;
    if (el) setTimeout(() => { if (!this.on && el === this._el) el.pause(); }, fade * 1000 + 50);
  }

  // ── the menu: the same box, heard from nowhere in particular ──────────────
  // The creator plays a track straight to the speakers (no panner) so it is
  // the menu's music, not a faint box somewhere in the park. Browsers keep
  // the context shut until a gesture, so `menu()` may only *arm* it: the
  // first click or key in the menu is what actually starts the sound.
  menu(i) {
    this._menuTrack = i;
    this._wantMenu = true;
    this._tryMenu();
    if (this.ctx.state !== 'running') {
      const go = () => { if (this._wantMenu) this._tryMenu(); if (this.ctx.state === 'running') { removeEventListener('keydown', go, true); removeEventListener('pointerdown', go, true); } };
      addEventListener('keydown', go, true);
      addEventListener('pointerdown', go, true);
    }
  }
  _tryMenu() {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.ctx.state !== 'running' || !this.tracks.length || this._menuOn) return;
    this._menuOn = true;
    // straight out, bypassing the panner
    this.musicGain.disconnect();
    this.musicGain.connect(this.listener.getInput());
    this.on = true;
    this._play(this._menuTrack % this.tracks.length, 0);
  }
  // the menu closes: the music goes, and the box is back to being a box in the
  // park that has not been switched on yet
  menuOff(fade = 1.4) {
    this._wantMenu = false;
    if (!this._menuOn) return;
    this._menuOn = false;
    this.off(fade);
    setTimeout(() => { this.musicGain.disconnect(); this.musicGain.connect(this.panner); this.track = -1; }, fade * 1000 + 80);
  }

  setVolume(v) { BOOMBOX.volume = Math.max(0, Math.min(1, v)); if (this.on) this.musicGain.gain.value = BOOMBOX.volume; }

  // ── the track ─────────────────────────────────────────────────────────────
  _play(i, delay) {
    if (!this.tracks.length) return;
    this.track = i;
    const t = this.tracks[i];
    if (!this._el) {
      this._el = new Audio();
      this._el.loop = true;
      this._src = this.ctx.createMediaElementSource(this._el);   // streams: a 4-min track decoded whole is ~90 MB
      this._src.connect(this.musicGain);
    }
    this._el.src = DIR + t.file;
    this._el.currentTime = 0;
    const now = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(1e-4, now);
    this._el.play().catch(() => {/* still locked; the next gap will land */});
    // the track comes up under the tail of the hiss
    this.musicGain.gain.setValueAtTime(1e-4, now + delay * 0.55);
    this.musicGain.gain.exponentialRampToValueAtTime(BOOMBOX.volume, now + delay * 0.55 + BOOMBOX.fade);
    this.onTrack?.(t.name, i);
  }

  // ── the radio, synthesised: no sample, and it is never twice the same ─────
  _noise() {
    if (!this._nb) {
      const n = Math.floor(this.ctx.sampleRate * 2);
      this._nb = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this._nb.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return this._nb;
  }

  _static(dur) {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const out = ctx.createGain();
    out.connect(this.panner);
    out.gain.setValueAtTime(1e-4, t0);
    out.gain.exponentialRampToValueAtTime(0.45, t0 + 0.04);
    out.gain.setValueAtTime(0.45, t0 + dur * 0.6);
    out.gain.exponentialRampToValueAtTime(1e-4, t0 + dur);

    // hiss hunting across the dial
    const src = ctx.createBufferSource();
    src.buffer = this._noise(); src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.6;
    const steps = 8;
    for (let i = 0; i < steps; i++) bp.frequency.setValueAtTime(420 + Math.random() * 2900, t0 + dur * i / steps);
    src.connect(bp); bp.connect(out);
    src.start(t0); src.stop(t0 + dur);

    // heterodyne squeals as it crosses a carrier
    const squeals = dur > 1 ? 3 : 2;
    for (let i = 0; i < squeals; i++) {
      const when = t0 + dur * (0.12 + 0.3 * i) + Math.random() * 0.06;
      if (when > t0 + dur - 0.1) break;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(800 + Math.random() * 1900, when);
      o.frequency.exponentialRampToValueAtTime(380 + Math.random() * 2200, when + 0.2);
      g.gain.setValueAtTime(1e-4, when);
      g.gain.exponentialRampToValueAtTime(0.16, when + 0.03);
      g.gain.exponentialRampToValueAtTime(1e-4, when + 0.2);
      o.connect(g); g.connect(out);
      o.start(when); o.stop(when + 0.22);
    }
    // the clunk of the switch
    const cl = ctx.createOscillator(), cg = ctx.createGain();
    cl.type = 'square'; cl.frequency.setValueAtTime(160, t0);
    cg.gain.setValueAtTime(0.12, t0); cg.gain.exponentialRampToValueAtTime(1e-4, t0 + 0.06);
    cl.connect(cg); cg.connect(out); cl.start(t0); cl.stop(t0 + 0.07);
  }
}
