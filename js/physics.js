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
const DROP_MIN = 0.22;         // m — a sudden drop bigger than this is a ledge: the wheels roll off
                               // (smaller steps — model edges, stair treads — are just snapped
                               // down; owner: every little step read as a self-jump)
const TURN_WINDOW = 0.25;      // m of travel over which convex turning is accumulated
const TURN_LEAVE = 0.8;        // ≈46° of convex turn inside that window = an edge, leave (a 28° hip crest is not)
const TURN_TIME = 0.25;        // s — the accumulated turn also fades with time (slow crawls)
const WALL_DOT = 0.55;         // hit normal · up below this = a wall: slide, don't climb
const WALL_PROBES = [0.08, 0.45];   // m above the contact point: wheel height, knee height
const WALL_REACH = 0.14;       // m — keep this much between the board and a wall
const UP_SMOOTH = 30;          // 1/s — surface normal smoothing over triangulated curves
const LAND_LOOKAHEAD = 0.3;    // s — start tilting to the landing surface this early
const VERT_GUIDE = 2.5;        // 1/s — how firmly a vert air is guided back into the face
const VERT_OUT = 0.22;         // m — where a vert air hangs, out from the coping plane
const VERT_LAUNCH_OUT = 0.35;  // m/s — minimum outward speed leaving the lip
const PIVOT = 0.35;            // fraction of the steer rate available at a standstill (kick-turn)
const POP_GRACE = 0.14;        // s after leaving a surface in which a pop still counts
const GRIND_SNAP = 0.42;       // m — how close (horizontally) the board must come down to an edge
                               // (generous, Skate-style: half a board; the wall probe keeps you
                               // WALL_REACH off a face, so the window to catch a ledge on a wall
                               // is the difference)
const GRIND_DRAG = 1.1;        // m/s² — grinding scrubs speed
const GRIND_MIN_V = 1.0;       // m/s — slower than half this and you stall off
const GRIND_MIN_ALONG = 0.8;   // m/s — travel along the edge needed to catch it at all
const GRIND_INSIDE = 0.12;     // m — how far inside a ledge's top the board may be and still catch its edge
const GRIND_LIFT = { '5050': 0.055, boardslide: 0.125 };   // root below the edge: trucks / deck on it
const GRIND_RECATCH = 0.45;    // s after leaving an edge before the same edge can catch again
const GRIND_IGNORE = 0.3;      // s after leaving a rail during which its prop doesn't collide
const GRIND_EXIT_OUT = 0.3;    // m — how far a ledge exit steps toward the ledge's open side

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _n = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3();
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _x = new THREE.Vector3();
const _lat = new THREE.Vector3(), _m4 = new THREE.Matrix4(), _dn = new THREE.Vector3();
const _qs = new THREE.Quaternion();

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
    this.edges = [];                         // grindable segments {a, b, dir, len, kind, name, prop}
    this.grind = null;                       // {edge, t, s, v, kind} while grinding
    this._lastEdge = null;
    this._ignoreT = 0;

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
    if (this.grind) {                        // ollie out of a grind
      this._endGrind('pop');
      this.grounded = false;
      this.vel.y += vy;
      this.airTime = 0;
      this.airSpin = 0;
      this.events.push({ type: 'leave' });
      return;
    }
    // a pop a few frames after the lip/ledge still counts (POP_GRACE): an
    // ollie AT the coping is the move, and the clip's pop tag lands late
    if (!this.grounded && this.airTime > POP_GRACE) return;
    if (!this.grounded) { this.vel.y += vy; return; }
    // (on a transition collider any real slope launches vert; a halfpipe's
    // flat bottom has no horizontal normal and pops like flat ground)
    const onRamp = /^ramp/.test(this.surface || '');
    const horiz = Math.hypot(this.up.x, this.up.z);
    if (this.up.y < 0.6 || (onRamp && (horiz > 0.12 || this.surfaceFace))) {
      // popping ON a transition: a vert air with extra height — the momentum
      // that was carrying the board into the ramp is dropped, the same as at
      // the lip (owner: "I almost always ollie over and end up behind"). On
      // a quarter pipe that holds for the whole curve, its flat foot included
      // (the collider knows which way its face points).
      this._leaveVert(horiz > 0.12 ? null : this.surfaceFace);
      this.vel.y += vy * (0.55 + 0.45 * Math.max(0, this.up.y));
      return;
    }
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
      this._tickIgnore(h);
      if (this.grind) this._stepGrind(h);
      else if (this.grounded) this._stepGround(h);
      else this._stepAir(h);
    }
  }

  // ── grinds ────────────────────────────────────────────────────────────────
  // Grindable edges (rails, copings) are world segments from the park. The
  // Skate way: no input starts a grind — the board catches an edge when it
  // comes DOWN onto it; the board's angle at contact decides 50-50 (along
  // the edge) vs boardslide (across it). Ollie out any time; the edge's end
  // or a stall drops you off.
  setEdges(edges) { this.edges = edges || []; }

  _findEdge() {
    let best = null, bestD = GRIND_SNAP;
    for (const e of this.edges) {
      if (e === this._lastEdge && this.airTime < GRIND_RECATCH) continue;   // just left it
      _x.subVectors(this.pos, e.a);
      const raw = _x.dot(e.dir);
      const along = this.vel.dot(e.dir);
      if ((raw > e.len && along > 0) || (raw < 0 && along < 0)) continue;   // past an end, moving away
      if (Math.abs(along) < GRIND_MIN_ALONG) continue;   // no travel along it: that's a landing on top, not a grind
      const t = Math.min(e.len, Math.max(0, raw));
      _o.copy(e.a).addScaledVector(e.dir, t);           // nearest point on the edge
      const dh = this.pos.y - _o.y;
      if (dh < -0.10 || dh > 0.34) continue;             // board must be at/above the edge
      // a ledge catches from its OPEN side (or a hair inside): landing on
      // the middle of a bench or a table top rides it instead
      if (e.open && (this.pos.x - _o.x) * e.open.x + (this.pos.z - _o.z) * e.open.z < -GRIND_INSIDE) continue;
      const d = Math.hypot(this.pos.x - _o.x, this.pos.z - _o.z);
      if (d < bestD) { bestD = d; best = { edge: e, t }; }
    }
    return best;
  }

  _startGrind(edge, t) {
    const dir = edge.dir;
    const nose = this.noseDir(_n);
    const c = nose.x * dir.x + nose.z * dir.z;           // nose along the edge?
    const kind = Math.abs(c) > 0.6 ? '5050' : 'boardslide';
    const along = this.vel.x * dir.x + this.vel.z * dir.z;
    const s = along >= 0 ? 1 : -1;
    const edgeYaw = Math.atan2(dir.x, dir.z);
    let yaw;
    if (kind === '5050') {
      yaw = c >= 0 ? edgeYaw : edgeYaw + Math.PI;
      this.rollSign = (c >= 0 ? 1 : -1) * s;
    } else {
      const y1 = edgeYaw + Math.PI / 2, y2 = edgeYaw - Math.PI / 2;
      const d1 = Math.sin(y1) * nose.x + Math.cos(y1) * nose.z;
      const d2 = Math.sin(y2) * nose.x + Math.cos(y2) * nose.z;
      yaw = d1 >= d2 ? y1 : y2;
    }
    // keep the yaw continuous with where we came from (spins count from here)
    while (yaw - this.yaw > Math.PI) yaw -= 2 * Math.PI;
    while (yaw - this.yaw < -Math.PI) yaw += 2 * Math.PI;
    this.yaw = yaw;
    this.grind = { edge, t, s, v: Math.max(Math.abs(along), GRIND_MIN_V), kind };
    this.grounded = true;
    this.vert = null;
    this.up.set(0, 1, 0);
    this._surfaceForward();
    this._placeOnEdge();
    this.events.push({ type: 'grind', kind, name: edge.name, airTime: this.airTime });
  }

  _placeOnEdge() {
    const g = this.grind;
    this.pos.copy(g.edge.a).addScaledVector(g.edge.dir, g.t);
    this.pos.y -= GRIND_LIFT[g.kind];                    // trucks / deck on the edge, not the wheels
    this.vel.copy(g.edge.dir).multiplyScalar(g.s * g.v);
    this.groundY = this.pos.y;
    this.surface = g.edge.name;
  }

  _endGrind(reason) {
    const g = this.grind;
    if (!g) return;
    this.grind = null;
    this._lastEdge = g.edge;                             // no re-catching its end point
    this.vel.copy(g.edge.dir).multiplyScalar(g.s * g.v);
    // the contact point sat under the edge (trucks/deck on it): come off ON
    // the top and don't collide with the rail itself for a moment, or the
    // first sweep starts inside its bar and "lands" on its underside
    const top = g.edge.a.y + (g.edge.b.y - g.edge.a.y) * (g.t / g.edge.len);
    if (this.pos.y < top + 0.01) this.pos.y = top + 0.01;
    // come off toward the OPEN side of a ledge (a fall straight down the
    // corner line can thread into the block); the park measured which side
    // is open when it built the edge
    if (g.edge.open) this.pos.addScaledVector(g.edge.open, GRIND_EXIT_OUT);
    // only a RAIL's prop is ignored (a thin bar the root sat inside); a ledge
    // belongs to a solid block — ignoring that let a stall fall through it
    if (this.world && g.edge.prop && g.edge.kind === 'rail') { this.world.setIgnored(g.edge.prop); this._ignoreT = GRIND_IGNORE; }
    this.events.push({ type: 'grindEnd', kind: g.kind, reason });
  }

  _tickIgnore(dt) {
    if (this._ignoreT > 0) {
      this._ignoreT -= dt;
      if (this._ignoreT <= 0 && this.world) this.world.setIgnored(null);
    }
  }

  _stepGrind(dt) {
    const g = this.grind, dir = g.edge.dir;
    g.v += -G * dir.y * g.s * dt;                        // an inclined rail speeds/slows you
    g.v -= GRIND_DRAG * dt;
    if (g.v < GRIND_MIN_V * 0.5) {                       // stalled: drop off
      this._endGrind('stall');
      this._leave();
      return;
    }
    g.t += g.s * g.v * dt;
    if (g.t < 0 || g.t > g.edge.len) {                   // off the end
      g.t = Math.min(g.edge.len, Math.max(0, g.t));
      this._placeOnEdge();
      this._endGrind('end');
      this._leave();
      return;
    }
    this._placeOnEdge();
    this._surfaceForward();
  }

  _surfaceForward() {
    const nose = this.noseDir(_n);
    _f.copy(nose).addScaledVector(this.up, -nose.dot(this.up));
    if (_f.lengthSq() < 0.04) _f.copy(this.forward);     // near-vertical: keep the last one
    this.forward.copy(_f.normalize());
  }

  // keep the CURRENT facing (not the heading) on the plane of `up`, and let
  // the heading follow it — used in the air and on touchdown so a spin is
  // even and a landing never snaps
  _keepForward() {
    _f.copy(this.forward).addScaledVector(this.up, -this.forward.dot(this.up));
    if (_f.lengthSq() < 0.04) { this._surfaceForward(); return; }
    this.forward.copy(_f.normalize());
    const h = Math.hypot(this.forward.x, this.forward.z);
    if (h > 0.25) this.yaw = Math.atan2(this.forward.x, this.forward.z);
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
      // only transition colliders (ramps, halfpipe) and the hip's banks may
      // tilt the rider steeply; on a bench, a rail, a table the ground is a
      // near-level top — never a slat's side or a bevel (owner: the rider
      // ended up lying on the curved bench)
      const steepOK = hit && /^ramp/.test(hit.object.userData.collider || '');
      const minY = steepOK ? -1 : 0.5;
      if (hit && !hit.backface && (hit.normal.dot(up) < 0.45 || hit.normal.y < minY)) {
        // the probe found a face far from our current tilt (a wall next to a
        // bank, a step's riser): that is not the ground — look straight down
        hit = this.world.cast(_o.copy(this.pos).addScaledVector(WORLD_UP, PROBE_UP), DOWN, PROBE_UP + PROBE_DOWN);
        if (hit && hit.normal.y < Math.max(0.3, minY)) hit = null;
      }
      // (the inside test starts a hair out along the SURFACE normal — straight
      // up from a contact point on a steep face pokes into the ramp itself
      // and used to fire a bogus escape onto the deck)
      if ((hit && hit.backface) || this.world.inside(_o.copy(this.pos).addScaledVector(up, 0.04))) {
        // INSIDE a mesh (owner: "stuck inside the quarter pipe") — get back
        // onto the top surface straight above and stop. Done here, in full:
        // letting the escape ray fall through to the drop test below read
        // its length as a 5 m ledge and threw the rider back in
        const top = this.world.cast(_o.copy(this.pos).addScaledVector(WORLD_UP, 6), DOWN, 12);
        if (top && !top.backface) {
          this.pos.copy(top.point);
          up.copy(top.normal);
          this.groundY = this.pos.y;
          this.surface = top.object.userData.collider || null;
        }
        vel.set(0, 0, 0);
        this._turn = 0; this._prevN = null;
        return;
      }
      if (hit) {
        // detachment over a CONVEX edge (a coping, the deck's back): the
        // surface turns away from the path. Convex = the normal rotates INTO
        // the direction of travel (a transition's base is concave and never
        // detaches). Polygonal meshes turn a few degrees per facet, so the
        // turn is accumulated over the last ~TURN_WINDOW metres of travel and
        // only a real edge crosses TURN_LEAVE. A sudden drop is a ledge.
        // the turn is the change of the RAW surface normal between steps —
        // never raw-vs-smoothed, which reads a rough mesh's jitter as a random
        // walk and launched the rider mid-bank (owner: self-jumping)
        if (this._prevN) _dn.subVectors(hit.normal, this._prevN); else _dn.set(0, 0, 0);
        (this._prevN || (this._prevN = new THREE.Vector3())).copy(hit.normal);
        const step = Math.max(1e-4, vel.length() * dt);
        const convex = _dn.dot(vel) > 0;
        // NET turn: concave turns pay back convex ones, so bumps cancel and
        // only a monotonic edge (coping, deck back) accumulates
        this._turn = Math.max(0, this._turn * Math.exp(-step / TURN_WINDOW - dt / TURN_TIME) + (convex ? _dn.length() : -_dn.length()));
        if (vel.lengthSq() < 0.25) this._turn = 0;      // at a crawl the "turn" is jitter (a stall on a bank)
        const drop = hit.distance - PROBE_UP;          // how far the surface fell away
        if (this._turn > TURN_LEAVE || drop > DROP_MIN) {
          this.lastLeave = { why: this._turn > TURN_LEAVE ? 'edge' : 'drop', turn: +this._turn.toFixed(2), drop: +drop.toFixed(3), speed: +vel.length().toFixed(2), pos: this.pos.toArray().map(v => +v.toFixed(2)), surface: this.surface };
          this._turn = 0;
          this._leave();
          return;
        }
        this.pos.copy(hit.point);
        up.lerp(hit.normal, Math.min(1, dt * UP_SMOOTH)).normalize();
        vel.addScaledVector(up, -vel.dot(up));
        this.groundY = this.pos.y;
        this.surface = hit.object.userData.collider || null;
        this.surfaceFace = hit.object.userData.faceWorld || null;
      } else {
        this.lastLeave = { why: 'no-surface', speed: +vel.length().toFixed(2), pos: this.pos.toArray().map(v => +v.toFixed(2)), up: up.toArray().map(v => +v.toFixed(2)), surface: this.surface };
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
  // leave as a vert air whatever the steepness (a pop on a transition);
  // `outDir` overrides the face direction when the normal is nearly vertical
  _leaveVert(outDir = null) {
    const keep = this.up.clone();
    if (outDir) this.up.set(outDir.x, 0.5, outDir.z).normalize();
    else { this.up.y = Math.min(this.up.y, 0.59); this.up.normalize(); }
    this._leave();
    this.up.copy(keep);
  }

  _leave() {
    this.grounded = false;
    this.airTime = 0;
    this.airSpin = 0;
    this._prevN = null;
    this._turn = 0;
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
    this.airSpin += d;
    // the spin turns the root about ITS OWN up (owner: the air spin looked
    // laggy and snapped — re-deriving the facing from the heading through a
    // tilted up swings unevenly); the heading follows the facing
    _qs.setFromAxisAngle(this.up, d);
    this.forward.applyQuaternion(_qs);
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
        const aheadMinY = /^ramp/.test(ahead?.object.userData.collider || '') ? 0.05 : 0.5;
        if (ahead && ahead.normal.y > aheadMinY && vel.dot(ahead.normal) < 0) {
          const tta = ahead.distance / spd;                      // s to impact
          if (tta < LAND_LOOKAHEAD) {
            const k = tta < 0.05 ? 1 : Math.min(1, dt / tta);
            this.up.lerp(ahead.normal, k).normalize();
          }
        }
      }
    }
    this._keepForward();
    // vert-air guide (Skate's lip assist): hold the air a little OUT from the
    // coping plane so the return comes down on the face just below the lip —
    // never inside it onto the deck, never drifting away from the ramp
    if (this.vert) {
      _x.subVectors(this.pos, this.vert.lip);
      const outDist = _x.dot(this.vert.out);              // m out from the coping plane
      const want = Math.max(-0.8, Math.min(0.8, (VERT_OUT - outDist) * 2.5));
      const out = vel.dot(this.vert.out);
      vel.addScaledVector(this.vert.out, (want - out) * Math.min(1, dt * VERT_GUIDE));
      // and a soft leash ALONG the coping toward where the air started, so a
      // drifting air comes back down on the ramp, not beside it (owner:
      // landing off the side blocked the rider)
      _lat.crossVectors(WORLD_UP, this.vert.out).normalize();
      const latDist = _x.dot(_lat);
      const wantLat = Math.max(-1.0, Math.min(1.0, -latDist * 1.5));
      const lat = vel.dot(_lat);
      vel.addScaledVector(_lat, (wantLat - lat) * Math.min(1, dt * VERT_GUIDE * 0.6));
    }

    // coming down onto a rail or a coping = a grind (checked before the
    // landing sweep: the edge is above whatever is under it)
    // (also on the way UP near the apex, Skate-style: an ollie that just
    // reaches an edge snaps to it; a board still rising fast passes a lower
    // edge — a picnic table's bench — and can reach the table top)
    if (this.edges.length && !this.vert && vel.y < 1.2 && this.airTime > 0.04) {
      const e = this._findEdge();
      if (e) { this._startGrind(e.edge, e.t); return; }
    }

    const step = vel.length() * dt;
    if (this.world && step > 1e-6) {
      // sweep the contact point; whatever it flies into is the landing
      _o.copy(this.pos).addScaledVector(WORLD_UP, 0.06);
      _d.copy(vel).normalize();
      // (reach past the lift so a surface right under a slow fall is found)
      const hit = this.world.cast(_o, _d, step + 0.12);
      if (hit && hit.backface) {
        // we are INSIDE a solid (a corner case at a ledge's edge): sliding on
        // its inner faces just oscillates in place — climb out onto the top
        const top = this.world.cast(_o.copy(this.pos).addScaledVector(WORLD_UP, 6), DOWN, 12);
        if (top && !top.backface) {
          this.pos.copy(top.point);
          this.up.copy(top.normal);
          vel.set(0, 0, 0);
          this.grounded = true;
          this.groundY = this.pos.y;
          this.surface = top.object.userData.collider || null;
          this.vert = null;
          this._surfaceForward();
          this.events.push({ type: 'land', airTime: this.airTime });
        }
        return;
      }
      // rideable landing: anything up to ~80° — a transition's face is a
      // landing whether you came out of it or dropped into it. A wall
      // (steeper) is slid along while still falling (the root never "lands"
      // lying on a wall)
      // (steep faces are landings only on transition colliders — a rail's
      // brace or a ledge's wall is not; owner: "rides sideways in strange places")
      const transition = hit && /^ramp/.test(hit.object.userData.collider || '');
      const rideable = hit && (hit.normal.y > ((this.vert || transition) ? 0.05 : 0.5));
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
        this.surfaceFace = hit.object.userData.faceWorld || null;
        this.vert = null;
        this._keepForward();
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
