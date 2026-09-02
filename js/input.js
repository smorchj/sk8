// input.js — Skate-style flick-it controls.
//
// MOUSE: click and HOLD anywhere = wind up (crouch); while held the camera is
// frozen and the mouse is the flick stick. Releasing with a flick decides the
// trick (owner's spec, stance-mapped in anim.js):
//   flick up                    → ollie (fakie ollie when rolling fakie)
//   flick right / left          → kickflip / heelflip by stance
//   tall oblong circular motion → impossible
//   wide oblong circular motion → 360 flip
// Releasing gently cancels (stand back up). Mouse movement while UNCLICKED
// orbits the camera (cb.look) — never during a hold.
//
// TOUCH: the lower ~42% is the trick pad (hold + flick); upper area drags to
// steer, double-tap pushes. Keyboard mirrors everything for desk play.

const PAD_FRAC = 0.42;            // bottom fraction of the screen = trick pad
const FLICK_WINDOW = 140;         // ms of trail that counts as "the flick"
const FLICK_MIN_PX = 22;
const FLICK_MIN_SPEED = 0.22;     // px/ms
const LOOP_TURN = 4.4;            // rad of accumulated turning = a circle
const OBLONG = 1.3;               // aspect ratio gate for impossible vs treflip

export class Input {
  constructor(callbacks) {
    this.cb = callbacks;          // {windupStart, windupEnd(gesture), push, revert(dir), brake(on)}
    this.steer = 0;               // -1..1 live steering state
    this.holdingTrick = false;

    this._keys = new Set();
    this._trickPtr = null;        // {id, samples:[{t,x,y}]}
    this._steerPtr = null;        // {id, x0}
    this._edgePtr = null;         // {id, dir} — touch-hold on a screen edge while AIRBORNE = spin
    this._edgeSteer = 0;
    this._lastUpperTap = 0;

    this._canvas = document.getElementById('gesture');
    this._ctx = this._canvas.getContext('2d');
    this._fade = 0;

    addEventListener('pointerdown', e => this._down(e));
    addEventListener('pointermove', e => this._move(e));
    addEventListener('pointerup', e => this._up(e));
    addEventListener('pointercancel', e => this._up(e, true));
    addEventListener('keydown', e => this._key(e, true));
    addEventListener('keyup', e => this._key(e, false));
    addEventListener('mousemove', e => {
      // free-look ONLY while unclicked — a held trick pointer freezes the camera
      if (!this._trickPtr && e.buttons === 0) this.cb.look?.(e.movementX || 0, e.movementY || 0);
    });
    addEventListener('resize', () => this._resize());
    this._resize();
  }

  _resize() {
    this._canvas.width = innerWidth * devicePixelRatio;
    this._canvas.height = innerHeight * devicePixelRatio;
  }

  _inPad(y) { return y > innerHeight * (1 - PAD_FRAC); }

  _down(e) {
    if (e.target.closest && e.target.closest('#creatorbar, #creatorPanel')) return;
    const isTouch = e.pointerType === 'touch';
    // touch: hold a screen EDGE to spin in the air (owner: no way to 180 on
    // phone otherwise). Also armable DURING wind-up so the rotation starts the
    // instant you pop — it feeds a separate spin channel that never steers the
    // grounded board. Left edge spins left, right edge right; release stops.
    if (isTouch && (this.cb.isAirborne?.() || this.holdingTrick) &&
      (e.clientX < innerWidth * 0.20 || e.clientX > innerWidth * 0.80)) {
      if (this._edgePtr) return;
      this._edgePtr = { id: e.pointerId, dir: e.clientX < innerWidth * 0.20 ? -1 : 1 };
      this._edgeSteer = this._edgePtr.dir;
      return;
    }
    // mouse/pen: any click on the world = wind-up hold. touch: lower pad only.
    if (!isTouch || this._inPad(e.clientY)) {
      if (this._trickPtr) return;
      this._trickPtr = { id: e.pointerId, samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }] };
      this.holdingTrick = true;
      this.cb.windupStart?.();
    } else {
      if (this._steerPtr) return;
      const now = performance.now();
      if (now - this._lastUpperTap < 280) this.cb.push?.();
      this._lastUpperTap = now;
      this._steerPtr = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: now, pushed: false };
    }
  }

  _move(e) {
    if (this._trickPtr && e.pointerId === this._trickPtr.id) {
      this._trickPtr.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      if (this._trickPtr.samples.length > 400) this._trickPtr.samples.shift();
      this._fade = 1;
      // MANUAL: pull BACK (down) on the pad and HOLD — a quick down-flick is
      // still a cancel; only a sustained pull becomes a manual
      const p0 = this._trickPtr.samples[0];
      const dy = e.clientY - p0.y, dx = e.clientX - p0.x;
      if (!this._manualOn && !this._manualTimer && dy > 55 && dy > Math.abs(dx)) {
        this._manualTimer = setTimeout(() => {
          this._manualTimer = null;
          if (this._trickPtr) { this._manualOn = true; this.cb.manualStart?.(); }
        }, 180);
      }
    } else if (this._steerPtr && e.pointerId === this._steerPtr.id) {
      const p = this._steerPtr;
      const dx = e.clientX - p.x0, dy = e.clientY - p.y0;
      // PUSH SWIPE (mobile): a fast downward swipe on the left/right side of
      // the screen = one push stroke. Re-arms so a continued downward rub
      // keeps the strokes coming; steering is locked for that drag.
      const onSide = p.x0 < innerWidth * 0.38 || p.x0 > innerWidth * 0.62;
      if (onSide && dy > 55 && dy > Math.abs(dx) * 1.2 && performance.now() - p.t0 < 450) {
        p.pushed = true;
        p.x0 = e.clientX; p.y0 = e.clientY; p.t0 = performance.now();   // re-arm
        this._dragSteer = 0;
        this.cb.push?.();
        return;
      }
      // a push-swipe drag that moves clearly sideways becomes a steer drag
      // again (owner bug: the lock ate the turn, so an ollie never spun)
      if (p.pushed && Math.abs(dx) > 45) { p.pushed = false; p.x0 = e.clientX; p.y0 = e.clientY; }
      if (!p.pushed) this._dragSteer = Math.max(-1, Math.min(1, (e.clientX - p.x0) / 110));
    }
  }

  _up(e, cancelled = false) {
    if (this._edgePtr && e.pointerId === this._edgePtr.id) {
      this._edgePtr = null;
      this._edgeSteer = 0;
      return;
    }
    if (this._trickPtr && e.pointerId === this._trickPtr.id) {
      const samples = this._trickPtr.samples;
      this._trickPtr = null;
      this.holdingTrick = false;
      if (this._manualTimer) { clearTimeout(this._manualTimer); this._manualTimer = null; }
      if (this._manualOn) {                       // release ends the manual
        this._manualOn = false;
        this.cb.manualEnd?.();
        return;
      }
      this.cb.windupEnd?.(cancelled ? { type: 'cancel' } : this._classify(samples));
    } else if (this._steerPtr && e.pointerId === this._steerPtr.id) {
      this._steerPtr = null;
      this._dragSteer = 0;
    }
  }

  _classify(samples) {
    if (samples.length < 3) return { type: 'cancel' };   // motionless tap = stand back up
    const now = performance.now();

    // 1) loop? accumulated signed turning along the whole trail
    let turn = 0;
    let px = null, py = null, pa = null;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const s of samples) {
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
      if (px !== null) {
        const dx = s.x - px, dy = s.y - py;
        if (dx * dx + dy * dy < 9) continue;
        const a = Math.atan2(dy, dx);
        if (pa !== null) {
          let d = a - pa;
          while (d > Math.PI) d -= 2 * Math.PI;
          while (d < -Math.PI) d += 2 * Math.PI;
          turn += d;
        }
        pa = a;
      }
      px = s.x; py = s.y;
    }
    const w = maxX - minX, h = maxY - minY;
    if (Math.abs(turn) > LOOP_TURN && Math.max(w, h) > 40) {
      if (h > w * OBLONG) return { type: 'impossible', strength: 1 };
      if (w > h * OBLONG) return { type: 'treflip', strength: 1 };
      // round-ish circle: pick the longer axis anyway
      return { type: h >= w ? 'impossible' : 'treflip', strength: 1 };
    }

    // 2) flick: displacement over the last FLICK_WINDOW ms
    const last = samples[samples.length - 1];
    let first = samples[0];
    for (let i = samples.length - 1; i >= 0; i--) {
      if (now - samples[i].t > FLICK_WINDOW) break;
      first = samples[i];
    }
    const dx = last.x - first.x, dy = last.y - first.y;
    const dt = Math.max(1, last.t - first.t);
    const dist = Math.hypot(dx, dy);
    const speed = dist / dt;
    if (dist < FLICK_MIN_PX || speed < FLICK_MIN_SPEED) return { type: 'cancel' };
    const strength = Math.min(1, speed / 1.6);
    if (-dy > Math.abs(dx)) return { type: 'ollie', strength };
    if (dy > Math.abs(dx)) return { type: 'cancel' };            // downward flick
    return { type: dx > 0 ? 'flickRight' : 'flickLeft', strength };
  }

  _key(e, down) {
    if (e.repeat) return;
    let k = e.key.toLowerCase();
    if (e.code === 'Space' || k === 'space' || k === 'spacebar') k = ' ';
    if (down) this._keys.add(k); else this._keys.delete(k);
    if (k === ' ') {
      e.preventDefault();
      if (down) { this.holdingTrick = true; this.cb.windupStart?.(); }
      else { this.holdingTrick = false; this.cb.windupEnd?.({ type: 'ollie', strength: 1 }); }
    }
    if (k === 'm') {
      if (down) this.cb.manualStart?.(); else this.cb.manualEnd?.();
    }
    if (k === 'w') {
      if (down) this.cb.pushStart?.(); else this.cb.pushEnd?.();
    }
    if (down) {
      if (k === 'q') this.cb.revert?.(-1);
      if (k === 'e') this.cb.revert?.(1);
      if (k === 'k') this._directTrick('kickflip');
      if (k === 'h') this._directTrick('heelflip');
      if (k === 'i') this._directTrick('impossible');
      if (k === 't') this._directTrick('treflip');
      if (k === 'c') this.cb.toggleCam?.();
      if (k === 'x') this.cb.toggleSlow?.();
      if (k === 'r') this.cb.reset?.();
    }
    this.cb.brake?.(this._keys.has('s'));
  }

  _directTrick(name) {
    // keyboard shortcut: instant wind-up + named trick (uses whatever crouch there is)
    if (!this.holdingTrick) this.cb.windupStart?.();
    this.holdingTrick = false;
    this.cb.windupEnd?.({ type: name, strength: 1, direct: true });
  }

  update(dt) {
    let s = 0;
    if (this._keys.has('a') || this._keys.has('arrowleft')) s -= 1;
    if (this._keys.has('d') || this._keys.has('arrowright')) s += 1;
    if (this._dragSteer) s += this._dragSteer;
    this.steer = Math.max(-1, Math.min(1, s));
    this.spin = this._edgeSteer;          // edge-hold: air-spin only, never grounded steer

    // gesture trail
    const ctx = this._ctx, dpr = devicePixelRatio;
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    if (this._trickPtr && this._trickPtr.samples.length > 1) {
      ctx.strokeStyle = 'rgba(120,190,255,0.85)';
      ctx.lineWidth = 5 * dpr;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const ss = this._trickPtr.samples;
      ctx.moveTo(ss[0].x * dpr, ss[0].y * dpr);
      for (const s2 of ss) ctx.lineTo(s2.x * dpr, s2.y * dpr);
      ctx.stroke();
    }
  }
}
