// physics.js — the skate controller. This IS the root of everything visible:
// a ground-contact point + nose yaw, Skate-style. Animation never moves the
// root; it only plays relative to it.
//
// Conventions: +Y up. `yaw` is the direction the board's NOSE points
// (anchor +Z rotated about Y). `rollSign` +1 = rolling nose-first,
// -1 = rolling fakie (tail leads). Travel direction = nose * rollSign.

import * as THREE from 'three';

export const G = 9.81;

const VMAX = 9.0;              // top rolling speed, m/s
const PUSH_ACCEL = 9.5;        // m/s² during a stroke's ground contact — a real
                               // push is a strong burst, tapering toward VMAX
const ROLL_FRICTION = 0.28;    // m/s² plain rolling drag
const BRAKE_FRICTION = 3.2;    // m/s² foot-drag brake
const STEER_RATE_LO = 2.1;     // rad/s of board yaw at slow speed
const STEER_RATE_HI = 0.85;    // rad/s at top speed
const CARVE_SCRUB = 0.25;      // speed lost per rad of turning
const GRIP = 14;               // 1/s — how fast lateral velocity dies (trucks grip)
const LAND_DAMP = 0.955;       // speed kept on touchdown
const AIR_SPIN_RATE = 6.0;     // rad/s of root spin at full input while airborne
                               // (fast enough that a skill-5 pop completes a 360)

export class SkatePhysics {
  constructor() {
    this.pos = new THREE.Vector3(0, 0, 0);   // board ground contact point
    this.vel = new THREE.Vector3();
    this.yaw = 0;                            // nose direction
    this.rollSign = 1;                       // +1 nose-first, -1 fakie
    this.grounded = true;
    this.steer = 0;                          // -1..1 (left..right of TRAVEL)
    this.spin = 0;                           // extra air-spin input (touch edge-hold)
    this.braking = false;
    this.pushing = false;                    // set by anim ctrl during stroke window
    this.crouch = 0;                         // 0..1, driven by input hold
    this.airTime = 0;
    this.airSpin = 0;                        // accumulated in-air yaw (180s/360s)
    this.events = [];                        // 'land' events for the anim ctrl

    // revert = quick grounded 180 of board+body, flips rollSign at the end
    this.revert = null;                      // {t, dur, dir, from}
    this._steerSm = 0;
  }

  noseDir(out) {
    return (out || new THREE.Vector3()).set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }
  travelDir(out) {
    return this.noseDir(out).multiplyScalar(this.rollSign);
  }
  speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  pop(vy) {
    if (!this.grounded) return;
    this.grounded = false;
    this.vel.y = vy;
    this.airTime = 0;
    this.airSpin = 0;
  }

  startRevert(dir = 1) {  // dir: +1 = frontside-ish (yaw +), -1 = other way
    if (!this.grounded || this.revert) return;
    this.revert = { t: 0, dur: 0.28, dir, from: this.yaw };
  }

  update(dt) {
    if (this.grounded) {
      // ── steering ──
      const sp = this.speed();
      this._steerSm += (this.steer - this._steerSm) * Math.min(1, dt * 10);
      const f = Math.min(1, sp / VMAX);
      const rate = STEER_RATE_LO + (STEER_RATE_HI - STEER_RATE_LO) * f;
      const spdGate = Math.min(1, sp / 0.6);       // can't pivot a parked board
      // positive steer = turn RIGHT of travel = yaw decreases (+Y rotation is CCW)
      const dyaw = -this._steerSm * rate * spdGate * dt;
      this.yaw += dyaw;

      // ── revert ── a revert is a SKID: momentum keeps its direction while the
      // board spins under it, so truck grip must not apply mid-spin.
      if (this.revert) {
        const r = this.revert;
        r.t += dt;
        const u = Math.min(1, r.t / r.dur);
        const e = u * u * (3 - 2 * u);
        this.yaw = r.from + r.dir * Math.PI * e;
        if (u >= 1) {
          this.revert = null;
          this.rollSign = -this.rollSign;
          this.vel.x *= 0.92; this.vel.z *= 0.92;   // the skid costs a little
        }
        this.pos.addScaledVector(this.vel, dt);
        return;
      }

      // ── velocity follows the trucks ──
      const nose = this.noseDir(_n);
      let v = this.vel.x * nose.x + this.vel.z * nose.z;      // signed along nose
      const latX = this.vel.x - nose.x * v;
      const latZ = this.vel.z - nose.z * v;
      const gripK = Math.max(0, 1 - GRIP * dt);
      // rolling friction + carve scrub + brake
      let drag = ROLL_FRICTION + Math.abs(dyaw / Math.max(dt, 1e-4)) * CARVE_SCRUB;
      if (this.braking) drag += BRAKE_FRICTION;
      const sgn = Math.sign(v) || this.rollSign;
      v -= sgn * Math.min(Math.abs(v), drag * dt);
      // push — strong burst per stroke, tapering as speed approaches VMAX
      if (this.pushing && Math.abs(v) < VMAX) {
        v += this.rollSign * PUSH_ACCEL * Math.max(0.2, 1 - Math.abs(v) / VMAX) * dt;
      }
      this.vel.x = nose.x * v + latX * gripK;
      this.vel.z = nose.z * v + latZ * gripK;
      // keep rollSign honest while clearly moving
      if (Math.abs(v) > 0.4) this.rollSign = Math.sign(v);
    } else {
      this.airTime += dt;
      this.vel.y -= G * dt;
      // in-air spins: steering rotates the WHOLE root (rider + board + clip),
      // so any trick can go 180/360 (owner request — root must not be stuck).
      // `spin` is the touch edge-hold channel; drag/keys get boosted authority
      // in the air so a held turn carries into a real spin.
      const target = Math.max(-1, Math.min(1, this.steer * 1.5 + this.spin));
      this._steerSm += (target - this._steerSm) * Math.min(1, dt * 8);
      const d = -this._steerSm * AIR_SPIN_RATE * dt;
      this.yaw += d;
      this.airSpin += d;
    }

    this.pos.addScaledVector(this.vel, dt);

    if (!this.grounded && this.vel.y <= 0 && this.pos.y <= 0) {
      this.pos.y = 0;
      this.vel.y = 0;
      this.grounded = true;
      this.vel.x *= LAND_DAMP;
      this.vel.z *= LAND_DAMP;
      this.events.push({ type: 'land', airTime: this.airTime });
    }
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}

const _n = new THREE.Vector3();
