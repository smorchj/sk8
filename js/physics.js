// physics.js — the skate controller. This IS the root of everything visible:
// a ground-contact point + nose yaw, Skate-style. Animation never moves the
// root; it only plays relative to it.
//
// Surfaces (owner, 2026-09-02: "we need real skate physics here"): the board
// rides the park's MESHES — terrain, stairs, ramps, rails, everything — via
// BVH raycasts (collide.js). Grounded, it follows the surface under it along
// the surface normal (so transitions up to vert work), gravity acts along the
// slope, trucks keep the velocity in the tangent plane. Leaving a lip or a
// ledge means air; the air sweep lands on whatever it flies into.
//
// Conventions: +Y up. `yaw` is the heading of the board's NOSE (anchor +Z
// rotated about Y); `forward` is that heading laid onto the surface; `up` is
// the surface normal (world up when flat / airborne). `rollSign` +1 = rolling
// nose-first, -1 = fakie. Travel direction = nose * rollSign.

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
const SUBSTEP = 1 / 240;       // s — fixed physics step (curved transitions need it)
const PROBE_UP = 0.35;         // m — ground probe starts this far out along the surface normal
const PROBE_DOWN = 0.32;       // m — surface may be this far below and still count as ground
const DROP_MIN = 0.07;         // m — a sudden drop bigger than this is a ledge: the wheels roll off
const TURN_WINDOW = 0.25;      // m of travel over which convex turning is accumulated
const TURN_LEAVE = 0.6;        // ≈35° of convex turn inside that window = an edge, leave
const WALL_DOT = 0.55;         // hit normal · up below this = a wall: slide, don't climb
const WALL_PROBES = [0.08, 0.45];   // m above the contact point: wheel height, knee height
const WALL_REACH = 0.24;       // m — keep this much between the board and a wall
const UP_SMOOTH = 30;          // 1/s — surface normal smoothing over triangulated curves
const LAND_LOOKAHEAD = 0.3;    // s — start tilting to the landing surface this early
const VERT_GUIDE = 2.5;        // 1/s — how firmly a vert air is guided back into the face
const VERT_OUT = 0.22;         // m — where a vert air hangs, out from the coping plane
const VERT_LAUNCH_OUT = 0.35;  // m/s — minimum outward speed leaving the lip
const PIVOT = 0.35;            // fraction of the steer rate available at a standstill (kick-turn)
const POP_GRACE = 0.14;        // s after leaving a surface in which a pop still counts

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _n = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3();
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _x = new THREE.Vector3();
const _lat = new THREE.Vector3(), _m4 = new THREE.Matrix4(), _dn = new THREE.Vector3();

export class SkatePhysics {
  constructor(world = null) {
    this.world = world;                      // CollisionWorld (null = flat y=0 plane)
    this.pos = new THREE.Vector3(0, 0, 0);   // board ground contact point
    this.vel = new THREE.Vector3();
    this.yaw = 0;                            // nose heading
    this.up = new THREE.Vector3(0, 1, 0);    // surface normal under the board
    this.forward = new THREE.Vector3(0, 0, 1);   // nose heading on the surface
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
    this.groundY = 0;                        // height of the surface under the board
    this.surface = null;                     // collider tag under the board
    this.vert = null;                        // {out, lip} while in a vert air off a transition

    // revert = quick grounded 180 of board+body, flips rollSign at the end
    this.revert = null;                      // {t, dur, dir, from}
    this._steerSm = 0;
    this._turn = 0;                          // accumulated convex turn (detachment)
  }

  setWorld(w) { this.world = w; }

  noseDir(out) {
    return (out || new THREE.Vector3()).set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }
  travelDir(out) {
    return this.noseDir(out).multiplyScalar(this.rollSign);
  }
  speed() {
    return this.grounded ? this.vel.length() : Math.hypot(this.vel.x, this.vel.z);
  }
  // the root's orientation: nose along the surface, up = surface normal
  rootQuat(out) {
    _x.crossVectors(this.up, this.forward).normalize();
    _m4.makeBasis(_x, this.up, this.forward);
    return out.setFromRotationMatrix(_m4);
  }
  // metres of air under the board (0 when grounded)
  heightAboveGround() {
    if (this.grounded) return 0;
    if (!this.world) return Math.max(0, this.pos.y);
    const hit = this.world.cast(_o.copy(this.pos).addScaledVector(WORLD_UP, 0.05), DOWN, 80);
    return hit ? Math.max(0, hit.distance - 0.05) : Math.max(0, this.pos.y);
  }

  // an ollie is WORLD up (owner, 2026-09-02): on a transition the pop goes
  // straight up and the ride-up momentum carries the air — popping along the
  // surface normal threw the rider away from the quarter pipe
  pop(vy) {
    // a pop a few frames after the lip/ledge still counts (POP_GRACE): an
    // ollie AT the coping is the move, and the clip's pop tag lands late
    if (!this.grounded && this.airTime > POP_GRACE) return;
    if (!this.grounded) { this.vel.y += vy; return; }
    this.grounded = false;
    this.vel.y += vy;
    this.airTime = 0;
    this.airSpin = 0;
  }

  startRevert(dir = 1) {  // dir: +1 = frontside-ish (yaw +), -1 = other way
    if (!this.grounded || this.revert) return;
    this.revert = { t: 0, dur: 0.28, dir, from: this.yaw };
  }

  update(dt) {
    const n = Math.min(12, Math.max(1, Math.ceil(dt / SUBSTEP)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (this.grounded) this._stepGround(h); else this._stepAir(h);
    }
  }

  _surfaceForward() {
    const nose = this.noseDir(_n);
    _f.copy(nose).addScaledVector(this.up, -nose.dot(this.up));
    if (_f.lengthSq() < 0.04) _f.copy(this.forward);     // near-vertical: keep the last one
    this.forward.copy(_f.normalize());
  }

  _stepGround(dt) {
    const up = this.up, vel = this.vel;
    this._surfaceForward();
    const fwd = this.forward;

    // ── steering ──
    const sp = vel.length();
    this._steerSm += (this.steer - this._steerSm) * Math.min(1, dt * 10);
    const f = Math.min(1, sp / VMAX);
    const rate = STEER_RATE_LO + (STEER_RATE_HI - STEER_RATE_LO) * f;
    // a parked or blocked board can still kick-turn (owner: turning must work
    // with no forward momentum, or a wall traps you facing it)
    const spdGate = PIVOT + (1 - PIVOT) * Math.min(1, sp / 0.6);
    // positive steer = turn RIGHT of travel = yaw decreases (+Y rotation is CCW)
    const dyaw = -this._steerSm * rate * spdGate * dt;
    this.yaw += dyaw;

    if (this.revert) {
      // ── revert ── a SKID: momentum keeps its direction while the board
      // spins under it, so truck grip must not apply mid-spin.
      const r = this.revert;
      r.t += dt;
      const u = Math.min(1, r.t / r.dur);
      const e = u * u * (3 - 2 * u);
      this.yaw = r.from + r.dir * Math.PI * e;
      if (u >= 1) {
        this.revert = null;
        this.rollSign = -this.rollSign;
        vel.multiplyScalar(0.92);                 // the skid costs a little
      }
    } else {
      // ── velocity follows the trucks (in the surface's tangent plane) ──
      vel.addScaledVector(up, -vel.dot(up));
      let v = vel.dot(fwd);                      // signed along nose
      _lat.copy(vel).addScaledVector(fwd, -v);
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
      vel.copy(fwd).multiplyScalar(v).addScaledVector(_lat, gripK);
      // keep rollSign honest while clearly moving
      if (Math.abs(v) > 0.4) this.rollSign = Math.sign(v);
    }

    // ── gravity along the slope (transitions slow you going up, speed you down) ──
    _g.set(0, -G, 0).addScaledVector(up, G * up.y);
    vel.addScaledVector(_g, dt);

    // ── walls: a steep face ahead stops/slides the board (curbs, ramp backs,
    // side panels). Two probes: wheel height and knee height. ──
    let spd = vel.length();
    if (this.world && spd > 1e-4) {
      _d.copy(vel).multiplyScalar(1 / spd);
      for (let k = 0; k < WALL_PROBES.length; k++) {
        _o.copy(this.pos).addScaledVector(up, WALL_PROBES[k]);
        const hit = this.world.cast(_o, _d, spd * dt + WALL_REACH);
        // wheel height: anything steep is a wall. Knee height: only a near-
        // vertical face (a transition rising ahead is NOT a wall)
        if (hit && hit.normal.dot(up) < (k === 0 ? WALL_DOT : 0.15)) {
          const into = vel.dot(hit.normal);
          if (into < 0) vel.addScaledVector(hit.normal, -into * 1.02);
          // don't let this step carry us into the face
          const room = Math.max(0, hit.distance - WALL_REACH);
          spd = vel.length();
          if (spd * dt > room) vel.multiplyScalar(spd > 1e-6 ? room / (spd * dt) : 0);
          break;
        }
      }
    }
    this.pos.addScaledVector(vel, dt);

    // ── stay on the surface: probe along the surface normal ──
    if (this.world) {
      _o.copy(this.pos).addScaledVector(up, PROBE_UP);
      _d.copy(up).negate();
      let hit = this.world.cast(_o, _d, PROBE_UP + PROBE_DOWN);
      if (hit && !hit.backface && hit.normal.dot(up) < 0.45) {
        // the probe found a face far from our current tilt (a wall next to a
        // bank, a step's riser): that is not the ground — look straight down
        hit = this.world.cast(_o.copy(this.pos).addScaledVector(WORLD_UP, PROBE_UP), DOWN, PROBE_UP + PROBE_DOWN);
        if (hit && hit.normal.y < 0.3) hit = null;
      }
      // (the inside test starts a hair out along the SURFACE normal — straight
      // up from a contact point on a steep face pokes into the ramp itself
      // and used to fire a bogus escape onto the deck)
      if ((hit && hit.backface) || this.world.inside(_o.copy(this.pos).addScaledVector(up, 0.04))) {
        // INSIDE a mesh (owner: "stuck inside the quarter pipe") — get back
        // onto the top surface straight above and stop
        hit = this.world.cast(_o.copy(this.pos).addScaledVector(WORLD_UP, 6), DOWN, 12);
        up.copy(WORLD_UP);
        vel.set(0, 0, 0);
      }
      if (hit) {
        // detachment over a CONVEX edge (a coping, the deck's back): the
        // surface turns away from the path. Convex = the normal rotates INTO
        // the direction of travel (a transition's base is concave and never
        // detaches). Polygonal meshes turn a few degrees per facet, so the
        // turn is accumulated over the last ~TURN_WINDOW metres of travel and
        // only a real edge crosses TURN_LEAVE. A sudden drop is a ledge.
        _dn.subVectors(hit.normal, up);
        const step = Math.max(1e-4, vel.length() * dt);
        const convex = _dn.dot(vel) > 0;
        this._turn = this._turn * Math.exp(-step / TURN_WINDOW) + (convex ? _dn.length() : 0);
        const drop = hit.distance - PROBE_UP;          // how far the surface fell away
        if (this._turn > TURN_LEAVE || drop > DROP_MIN) {
          this._turn = 0;
          this._leave();
          return;
        }
        this.pos.copy(hit.point);
        up.lerp(hit.normal, Math.min(1, dt * UP_SMOOTH)).normalize();
        vel.addScaledVector(up, -vel.dot(up));
        this.groundY = this.pos.y;
        this.surface = hit.object.userData.collider || null;
      } else {
        this._leave();                 // the surface ended: a lip, a ledge, a drop
      }
    } else {
      this.pos.y = 0;
      this.groundY = 0;
    }
  }

  // leaving a surface. Off a steep TRANSITION this is a vert air (the Skate
  // way): the tangent velocity already points up the face; remember the
  // face so the air can be guided back into it and the rider comes down on
  // the transition — fakie unless they spin.
  _leave() {
    this.grounded = false;
    this.airTime = 0;
    this.airSpin = 0;
    if (this.up.y < 0.6) {
      _x.set(this.up.x, 0, this.up.z).normalize();          // horizontal "out of the face"
      this.vert = { out: _x.clone(), lip: this.pos.clone() };
      // the vert launch: straight up with a touch OUT — never inward over the
      // coping onto the deck (the last facet of a not-quite-vert ramp points
      // in). Speed along the coping is kept, so a carving entry still travels.
      const vOut = this.vel.dot(_x);
      if (vOut < VERT_LAUNCH_OUT) this.vel.addScaledVector(_x, VERT_LAUNCH_OUT - vOut);
    } else this.vert = null;
    this.events.push({ type: 'leave', vert: !!this.vert });
  }

  _stepAir(dt) {
    const vel = this.vel;
    this.airTime += dt;
    vel.y -= G * dt;
    // in-air spins: steering rotates the WHOLE root (rider + board + clip),
    // so any trick can go 180/360 (owner request — root must not be stuck).
    // `spin` is the touch edge-hold channel; drag/keys get boosted authority
    // in the air so a held turn carries into a real spin.
    const target = Math.max(-1, Math.min(1, this.steer * 1.5 + this.spin));
    this._steerSm += (target - this._steerSm) * Math.min(1, dt * 8);
    const d = -this._steerSm * AIR_SPIN_RATE * dt;
    this.yaw += d;
    this.airSpin += d;
    // the root KEEPS the tilt it left the surface with (owner: it must not
    // turn upright in the air); only when the landing surface is close does
    // it blend to that surface's normal — a quarter pipe air comes back into
    // the face still tilted, a flyout onto the ground straightens up late
    if (this.world && vel.y < 0) {                             // only while coming down
      const spd = vel.length();
      if (spd > 1e-4) {
        _o.copy(this.pos).addScaledVector(WORLD_UP, 0.06);
        _d.copy(vel).multiplyScalar(1 / spd);
        const ahead = this.world.cast(_o, _d, spd * LAND_LOOKAHEAD + 0.15);
        if (ahead && ahead.normal.y > 0.05 && vel.dot(ahead.normal) < 0) {
          const tta = ahead.distance / spd;                      // s to impact
          if (tta < LAND_LOOKAHEAD) {
            const k = tta < 0.05 ? 1 : Math.min(1, dt / tta);
            this.up.lerp(ahead.normal, k).normalize();
          }
        }
      }
    }
    this._surfaceForward();
    // vert-air guide (Skate's lip assist): hold the air a little OUT from the
    // coping plane so the return comes down on the face just below the lip —
    // never inside it onto the deck, never drifting away from the ramp
    if (this.vert) {
      _x.subVectors(this.pos, this.vert.lip);
      const outDist = _x.dot(this.vert.out);              // m out from the coping plane
      const want = Math.max(-0.8, Math.min(0.8, (VERT_OUT - outDist) * 2.5));
      const out = vel.dot(this.vert.out);
      vel.addScaledVector(this.vert.out, (want - out) * Math.min(1, dt * VERT_GUIDE));
    }

    const step = vel.length() * dt;
    if (this.world && step > 1e-6) {
      // sweep the contact point; whatever it flies into is the landing
      _o.copy(this.pos).addScaledVector(WORLD_UP, 0.06);
      _d.copy(vel).normalize();
      const hit = this.world.cast(_o, _d, step + 0.06);
      // rideable landing: anything up to ~80° — a transition's face is a
      // landing whether you came out of it or dropped into it. A wall
      // (steeper) is slid along while still falling (the root never "lands"
      // lying on a wall)
      const rideable = hit && (hit.normal.y > (this.vert ? 0.05 : 0.17));
      if (hit && vel.dot(hit.normal) < 0 && !rideable) {
        vel.addScaledVector(hit.normal, -vel.dot(hit.normal) * 1.02);
        this.pos.copy(hit.point).addScaledVector(hit.normal, 0.03).addScaledVector(WORLD_UP, -0.06);
        return;
      }
      if (hit && vel.dot(hit.normal) < 0) {
        this.pos.copy(hit.point);
        this.up.copy(hit.normal);
        vel.addScaledVector(this.up, -vel.dot(this.up));
        vel.multiplyScalar(LAND_DAMP);
        this.grounded = true;
        this.groundY = this.pos.y;
        this.surface = hit.object.userData.collider || null;
        this.vert = null;
        this._surfaceForward();
        this.events.push({ type: 'land', airTime: this.airTime });
        return;
      }
    }
    this.pos.addScaledVector(vel, dt);

    if (!this.world && vel.y <= 0 && this.pos.y <= 0) {    // flat fallback
      this.pos.y = 0;
      vel.y = 0;
      this.grounded = true;
      vel.x *= LAND_DAMP; vel.z *= LAND_DAMP;
      this.events.push({ type: 'land', airTime: this.airTime });
    }
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}
