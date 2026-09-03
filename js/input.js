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

    // POINTER LOCK (owner, 2026-09-03: "the mouse never goes away so I click
    // off screen"): a click on the world captures and hides the cursor, so a
    // wind-up flick or a look-around can never wander out of the window and
    // land on something else. Escape gives the cursor back (the browser does
    // that itself), and any panel — the map editor, the review, the creator —
    // releases it. While locked the mouse reports MOVEMENT, not a position,
    // so the gesture sampler follows a virtual cursor of its own.
    this._lockEl = document.getElementById('viewport') || document.body;
    this._vx = innerWidth / 2;
    this._vy = innerHeight / 2;
    this._disabled = false;
    document.addEventListener('pointerlockchange', () => { if (!this.locked) this._vx = innerWidth / 2, this._vy = innerHeight / 2; });
    document.addEventListener('pointerlockerror', () => { this._lockDenied = true; });   // an embedded viewer refuses it: ask once

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

  get locked() { return document.pointerLockElement === this._lockEl; }

  get disabled() { return this._disabled; }
  set disabled(v) { this._disabled = v; if (v) { this.unlock(); document.body.classList.remove('holding'); } }

  // Pointer lock is not available everywhere: an embedded viewer (the Claude
  // browser pane) refuses it — "the root document of this element is not
  // valid for pointer lock". Where it IS granted (a normal browser window)
  // the cursor is pinned and hidden for the whole session. Where it is not,
  // the hold still captures the pointer to the canvas and hides the cursor,
  // so a flick cannot press anything else on the page.
  lock() {
    if (this._disabled || this.locked || this._lockDenied || !this._lockEl?.requestPointerLock) return;
    try {
      const r = this._lockEl.requestPointerLock({ unadjustedMovement: true });
      if (r && r.catch) r.catch(() => { this._lockDenied = true; });
    } catch { this._lockDenied = true; }
  }

  unlock() { if (this.locked) document.exitPointerLock?.(); }

  // where the mouse "is": its own position when free, a virtual point moved by
  // the raw deltas when locked. Call once per pointer event.
  _at(e) {
    if (e.pointerType !== 'touch' && this.locked) {
      this._vx += e.movementX || 0;
      this._vy += e.movementY || 0;
    } else {
      this._vx = e.clientX;
      this._vy = e.clientY;
    }
    return this._vx;
  }

  _resize() {
    this._canvas.width = innerWidth * devicePixelRatio;
    this._canvas.height = innerHeight * devicePixelRatio;
  }

  _inPad(y) { return y > innerHeight * (1 - PAD_FRAC); }

  _down(e) {
    if (this.disabled) return;                  // the map editor owns the mouse
    if (e.target.closest && e.target.closest('#creatorbar, #creatorPanel, #mapEditor, #recPanel')) return;
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
      // TOUCH, in the air: the same press is a GRAB — hold to grab, lift to
      // let go (owner: the ollie is done normally, the grab is a transition
      // in the air). Desktop grabs with G only (owner, 2026-09-03); a mouse
      // press in the air is just the hold, armed for the landing (pumping)
      if (isTouch && this.cb.isAirborne?.() && !this._trickPtr) {
        if (this._grabPtr) return;
        this._grabPtr = { id: e.pointerId };
        this.cb.grabStart?.();
        return;
      }
      if (this._trickPtr) return;
      if (!isTouch) {                                   // capture the cursor for the hold
        this.lock();
        this._vx = innerWidth / 2; this._vy = innerHeight / 2;
        // the drag belongs to the canvas until the button comes up: it can no
        // longer press a button, the HUD or anything else on the way past
        try { e.target?.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
        document.body.classList.add('holding');         // and the cursor gets out of the way
      }
      this._at(e);
      this._trickPtr = { id: e.pointerId, samples: [{ t: performance.now(), x: this._vx, y: this._vy }] };
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
    if (this.disabled) return;
    this._at(e);
    const mx = this._vx, my = this._vy;
    if (this._trickPtr && e.pointerId === this._trickPtr.id) {
      this._trickPtr.samples.push({ t: performance.now(), x: mx, y: my });
      if (this._trickPtr.samples.length > 400) this._trickPtr.samples.shift();
      this._fade = 1;
      // MANUAL (owner spec): DOUBLE swipe down — a completed down-flick armed
      // recently, then a second downward pull on a new touch enters the manual
      // and holds it until the finger lifts.
      const p0 = this._trickPtr.samples[0];
      const dy = my - p0.y, dx = mx - p0.x;
      if (!this._manualOn && this._downFlickAt &&
          performance.now() - this._downFlickAt < 450 && dy > 55 && dy > Math.abs(dx)) {
        this._downFlickAt = 0;
        this._manualOn = true;
        this.cb.manualStart?.();
      }
    } else if (this._steerPtr && e.pointerId === this._steerPtr.id) {
      const p = this._steerPtr;
      const dx = mx - p.x0, dy = my - p.y0;
      // PUSH SWIPE (mobile): a fast downward swipe on the left/right side of
      // the screen = one push stroke. Re-arms so a continued downward rub
      // keeps the strokes coming; steering is locked for that drag.
      const onSide = p.x0 < innerWidth * 0.38 || p.x0 > innerWidth * 0.62;
      if (onSide && dy > 55 && dy > Math.abs(dx) * 1.2 && performance.now() - p.t0 < 450) {
        p.pushed = true;
        p.x0 = mx; p.y0 = my; p.t0 = performance.now();   // re-arm
        this._dragSteer = 0;
        this.cb.push?.();
        return;
      }
      // a push-swipe drag that moves clearly sideways becomes a steer drag
      // again (owner bug: the lock ate the turn, so an ollie never spun)
      if (p.pushed && Math.abs(dx) > 45) { p.pushed = false; p.x0 = mx; p.y0 = my; }
      if (!p.pushed) this._dragSteer = Math.max(-1, Math.min(1, (mx - p.x0) / 110));
    }
  }

  _up(e, cancelled = false) {
    if (this.disabled) return;
    if (this._edgePtr && e.pointerId === this._edgePtr.id) {
      this._edgePtr = null;
      this._edgeSteer = 0;
      return;
    }
    if (this._grabPtr && e.pointerId === this._grabPtr.id) {
      this._grabPtr = null;
      this.cb.grabEnd?.();
      return;
    }
    if (this._trickPtr && e.pointerId === this._trickPtr.id) {
      const samples = this._trickPtr.samples;
      this._trickPtr = null;
      this.holdingTrick = false;
      document.body.classList.remove('holding');
      if (this._manualOn) {                       // release ends the manual
        this._manualOn = false;
        this.cb.manualEnd?.();
        return;
      }
      const g = cancelled ? { type: 'cancel' } : this._classify(samples);
      if (g.type === 'downflick') this._downFlickAt = performance.now();
      this.cb.windupEnd?.(g);
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
    if (dy > Math.abs(dx)) return { type: 'downflick' };         // arms the manual double-swipe
    return { type: dx > 0 ? 'flickRight' : 'flickLeft', strength };
  }

  _key(e, down) {
    if (this.disabled) return;
    if (e.repeat) return;
    let k = e.key.toLowerCase();
    if (e.code === 'Space' || k === 'space' || k === 'spacebar') k = ' ';
    if (down) this._keys.add(k); else this._keys.delete(k);
    if (k === ' ') {
      e.preventDefault();
      if (down) { this.holdingTrick = true; this.cb.windupStart?.(); }
      else { this.holdingTrick = false; this.cb.windupEnd?.({ type: 'ollie', strength: 1 }); }
    }
    if (k === 's' && down && performance.now() - (this._lastSDown || 0) < 300) {
      this._sManual = true;
      this.cb.manualStart?.();
    }
    if (k === 's') {
      if (down) this._lastSDown = performance.now();
      else if (this._sManual) { this._sManual = false; this.cb.manualEnd?.(); }
    }
    if (k === 'w') {
      if (down) this.cb.pushStart?.(); else this.cb.pushEnd?.();
    }
    if (k === 'g') {                      // grab: hold in the air, release to let go
      if (down) this.cb.grabStart?.(); else this.cb.grabEnd?.();
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
    this.cb.brake?.(this._keys.has('s') && !this._sManual);
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
