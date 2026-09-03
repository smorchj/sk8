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
const STEP_UP = 0.04;          // m — a prop's top higher than this above the wheels is a curb: the board
                               // stops at it, it never rolls up onto it (owner: "on top of the rail
                               // stand without an ollie — physically impossible")
const BODY_PROBES = [0.03, 0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.95, 1.1];   // m up the rider, every ~12 cm
                               // from the wheels to the waist — a prop's face at ANY of these is a
                               // wall: a bench seat overhangs, a rail's bar and a seat plank are thin,
                               // and probes at the wheels and knees alone passed under/between them
                               // (owner: "never ollied, yet ended up on top of the bench", "I drive
                               // through them")
const WALL_REACH = 0.14;       // m — keep this much between the board and a wall
const UP_SMOOTH = 30;          // 1/s — surface normal smoothing over triangulated curves
const LAND_LOOKAHEAD = 0.3;    // s — start tilting to the landing surface this early
const VERT_GUIDE = 2.5;        // 1/s — how firmly a vert air is guided back into the face
const VERT_OUT = 0.22;         // m — where a vert air hangs, out from the coping plane
const VERT_LAUNCH_OUT = 0.35;  // m/s — minimum outward speed leaving the lip
const PIVOT = 0.35;            // fraction of the steer rate available at a standstill (kick-turn)
// pumping (owner, 2026-09-03): HOLDING the wind-up while riding a transition
// pumps, up and down alike — the swing trick: the rider works against the
// extra push of a concave curve. The gain follows the centripetal
// acceleration (speed² × curvature): a flat, a straight bank face or the
// convex coping give nothing, the kink at a bank's foot and a bowl do
const PUMP_K = 0.12;           // fraction of the centripetal acceleration added along the travel
const PUMP_MAX = 2.5;          // m/s² — cap on that
const PUMP_AC_CAP = 25;        // m/s² — centripetal acceleration considered (tiny radii, mesh noise)
// gap transfers (owner, 2026-09-03: quarter pipes side by side with gaps —
// "gapping over, it shoots me out the back"): a vert air that would come down
// beside its own ramp, near a NEIGHBOURING face to the left or right, is
// guided onto that face (Tony Hawk's transfer assist) and the board turns to
// match it. Only faces the rider is in front of and that look roughly the
// same way qualify — never a ramp behind the launch ramp or one facing it.
const TRANSFER_REACH = 3.0;    // m — a neighbouring coping this close to where the air would come down
const TRANSFER_ACCEL = 9.0;    // m/s² — how hard the air is pulled onto that face
const TRANSFER_TURN = 5.0;     // 1/s — how fast the board turns to the new face's fall line
const TRANSFER_INSET = 0.9;    // m — aim this far in from a coping's ends, never at the very edge
const EDGE_SNAP = 0.35;        // m — an air that comes down a hair outside a ramp's width is put this
                               // far onto the ramp and lands on its face (owner: "anything landing by
                               // the edge, I'm literally getting pushed away from the pipe")
const POP_GRACE = 0.14;        // s after leaving a surface in which a pop still counts
const GRIND_SNAP = 0.42;       // m — how close (horizontally) the board must come down to an edge
                               // (generous, Skate-style: half a board; the wall probe keeps you
                               // WALL_REACH off a face, so the window to catch a ledge on a wall
                               // is the difference)
const GRIND_DRAG = 1.1;        // m/s² — grinding scrubs speed
const GRIND_MIN_V = 1.0;       // m/s — slower than half this and you stall off
const GRIND_MIN_ALONG = 0.8;   // m/s — travel along the edge needed to catch it at all
const GRIND_INSIDE = 0.12;     // m — how far inside a ledge's top the board may be and still catch its edge
const GRIND_TURN = 10;         // 1/s — how fast the board heading follows a chained bend
// the board's contact geometry, measured on assets/skateboard.glb (board
// frame, the root sits at the wheels' bottom): the truck hangers' underside
// 0.022 up, the deck's underside 0.094 up, axles at z +0.208 / −0.278, wheels
// out to |x| 0.114. What rests on an edge comes from these, not a tuned gap
// (owner, 2026-09-03: "the 50-50 does not always hit the trucks", "the board
// slide often has the actual board go through")
const BOARD = { hanger: 0.022, deck: 0.094, axleF: 0.208, axleB: 0.278, wheelX: 0.114 };
const SLIDE_IN = 0.05;         // m — a ledge slide's deck contact sits this far in from the board's centre
const GRIND_RECATCH = 0.45;    // s after leaving an edge before the same edge can catch again
// only the quarter pipes and the halfpipe are transitions (steep faces you
// ride, land on, and pop vert from); the hip is banks, ledges and walls
const TRANSITION = /^ramp2?$/;
const isTransition = (tag) => TRANSITION.test(tag);
// a prop: a bench, a ledge, a table, a rail, the hip — anything that is not
// the terrain and not a transition
const isProp = (tag) => !!tag && tag !== 'terrain' && tag !== 'stairs' && !TRANSITION.test(tag);
const RIDE_MIN_Y = 0.8;        // on a prop the ground must be within ~37° of level: a chamfer, a
                               // rounded edge, a leg's foot is a WALL, never a surface to ride
                               // (owner: "the rider must stop riding sideways on every wall surface")
const GRIND_IGNORE = 0.3;      // s after leaving a rail during which its prop doesn't collide
const GRIND_EXIT_OUT = 0.3;    // m — how far a ledge exit steps toward the ledge's open side

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _n = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3();
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _x = new THREE.Vector3();
const _lat = new THREE.Vector3(), _m4 = new THREE.Matrix4(), _dn = new THREE.Vector3();
const _eu = new THREE.Vector3(), _po = new THREE.Vector3();
const _tl = new THREE.Vector3(), _tq = new THREE.Vector3(), _ta = new THREE.Vector3(), _tv = new THREE.Vector3();
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
    this.pump = false;                       // the wind-up is held: pump through concave curves
    this.pumpA = 0;                          // m/s² — centripetal acceleration of the path right now (0 in the air / on a flat)
    this._curv = 0;                          // smoothed concave curvature of the path (1/m)
    this.airTime = 0;
    this.airSpin = 0;                        // accumulated in-air yaw (180s/360s)
    this.events = [];                        // 'land' events for the anim ctrl
    this.groundY = 0;                        // height of the surface under the board
    this.surface = null;                     // collider tag under the board
    this.vert = null;                        // {out, lip} while in a vert air off a transition
    this.edges = [];                         // grindable segments {a, b, dir, len, kind, name, prop}
    this.transitions = [];                   // transition faces {a, b (coping ends), out (horizontal, out of the face), prop}
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
    const onRamp = TRANSITION.test(this.surface || '');
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
  setTransitions(list) { this.transitions = list || []; }

  // set the heading from outside (a revert's 180, a reset): the facing
  // follows — the facing is the master on the ground, and a heading written
  // behind its back was undone on the next step (owner: "the revert 180
  // leaves the rider in the starting position")
  setYaw(yaw) {
    this.yaw = yaw;
    this._surfaceForward();
  }

  // how far a point lies beyond a coping's ENDS, along the coping (0 while
  // between them) — sideways, ignoring how far out from the face it is
  _beyondEnds(t, p) {
    _tv.subVectors(t.b, t.a);
    const len = Math.hypot(_tv.x, _tv.z);
    if (len < 1e-6) return 0;
    const u = ((p.x - t.a.x) * _tv.x + (p.z - t.a.z) * _tv.z) / (len * len);
    return u < 0 ? -u * len : u > 1 ? (u - 1) * len : 0;
  }

  // the point on a transition's coping line nearest to p (horizontally)
  _closestOnCoping(t, p, out, inset = 0) {
    _tv.subVectors(t.b, t.a);
    const len2 = _tv.x * _tv.x + _tv.z * _tv.z;
    let u = len2 > 1e-9 ? ((p.x - t.a.x) * _tv.x + (p.z - t.a.z) * _tv.z) / len2 : 0;
    const m = len2 > 1e-9 ? Math.min(0.5, inset / Math.sqrt(len2)) : 0;
    u = Math.max(m, Math.min(1 - m, u));
    return out.copy(t.a).addScaledVector(_tv, u);
  }
  _nearestFace(p) {
    let best = null, bestD = 1.5;
    for (const t of this.transitions) {
      const q = this._closestOnCoping(t, p, _tq);
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  // a vert air's landing face: its own ramp, unless the air is coming down
  // beside it and a neighbouring face (left/right, a gap away) is closer —
  // then that face becomes the guide's plane, the air is pulled onto it and
  // the board turns to it
  _transferTarget(dt) {
    const v = this.vert, vel = this.vel;
    if (!this.transitions.length) return;
    // where this air comes down, ballistic, at coping height
    const h = this.pos.y - v.lip.y, vy = vel.y;
    const disc = vy * vy + 2 * G * h;
    const tLand = disc > 0 ? (vy + Math.sqrt(disc)) / G : 0;
    _tl.set(this.pos.x + vel.x * tLand, v.lip.y, this.pos.z + vel.z * tLand);
    // its own ramp keeps the air as long as the air comes down within its
    // WIDTH (sideways — how far out from the face it hangs is the ordinary
    // vert air and never a reason to transfer); only an air heading past
    // the ramp's end is leaving it, and then the nearest neighbouring face
    // it is moving toward takes over
    let best = null, bestD = TRANSFER_REACH;
    if (v.face && this._beyondEnds(v.face, _tl) <= 0.3) { v.target = null; return; }
    if (v.target) {                                          // a chosen neighbour is sticky
      const q = this._closestOnCoping(v.target, _tl, _tq);
      best = v.target; bestD = Math.hypot(_tl.x - q.x, _tl.z - q.z) - 0.5;
    }
    for (const t of this.transitions) {
      if (t === v.face || t === v.target) continue;
      const q = this._closestOnCoping(t, _tl, _tq);
      const d = Math.hypot(_tl.x - q.x, _tl.z - q.z);
      if (d >= bestD) continue;
      // in front of that face, moving toward it, and that face looking
      // roughly our ramp's way (a sideways neighbour, round a corner at
      // most) — never a ramp behind the launch ramp, never one facing us
      if ((this.pos.x - q.x) * t.out.x + (this.pos.z - q.z) * t.out.z < -0.3) continue;
      if ((q.x - this.pos.x) * vel.x + (q.z - this.pos.z) * vel.z <= 0) continue;
      if (v.face && v.face.out.dot(t.out) < -0.2) continue;
      best = t; bestD = d;
    }
    if (!best) return;
    v.target = best;
    const q = this._closestOnCoping(best, _tl, _tq, TRANSFER_INSET);   // well inside its width
    v.out.copy(best.out);
    v.lip.copy(q);
    // pull the air onto the spot VERT_OUT in front of that coping
    if (tLand > 0.05) {
      _ta.copy(q).addScaledVector(best.out, VERT_OUT);
      const ax = ((_ta.x - this.pos.x) / tLand - vel.x) / Math.max(tLand, 0.1);
      const az = ((_ta.z - this.pos.z) / tLand - vel.z) / Math.max(tLand, 0.1);
      const m = Math.hypot(ax, az);
      const k = m > TRANSFER_ACCEL ? TRANSFER_ACCEL / m : 1;
      vel.x += ax * k * dt;
      vel.z += az * k * dt;
    }
    // and turn the board (root: facing AND tilt) onto the new face's fall
    // line — nose up the face or nose down it, whichever is nearer — so the
    // rider comes down straight into it instead of carving across it and
    // off its side. Never against the player: while they hold a spin the
    // assist waits (a held 180 finishes to whichever way is nearer once
    // they let go)
    if (Math.abs(this.steer) < 0.2 && Math.abs(this.spin) < 0.2) {
      const upFace = Math.atan2(-best.out.x, -best.out.z);
      let d1 = upFace - this.yaw, d2 = upFace + Math.PI - this.yaw;
      while (d1 > Math.PI) d1 -= 2 * Math.PI; while (d1 < -Math.PI) d1 += 2 * Math.PI;
      while (d2 > Math.PI) d2 -= 2 * Math.PI; while (d2 < -Math.PI) d2 += 2 * Math.PI;
      const step = (Math.abs(d1) <= Math.abs(d2) ? d1 : d2) * Math.min(1, dt * TRANSFER_TURN);
      if (Math.abs(step) > 1e-6) {
        _qs.setFromAxisAngle(WORLD_UP, step);
        this.forward.applyQuaternion(_qs);
        this.up.applyQuaternion(_qs);
        this.yaw += step;
      }
    }
  }

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
    // the board's heading relative to the edge (kept through chained bends)
    this.grind = { edge, t, s, v: Math.max(Math.abs(along), GRIND_MIN_V), kind, yawOff: yaw - edgeYaw };
    this.grounded = true;
    this.vert = null;
    this.up.set(0, 1, 0);
    this._surfaceForward();
    this._placeOnEdge();
    this.events.push({ type: 'grind', kind, name: edge.name, airTime: this.airTime });
  }

  _placeOnEdge(dt = 0) {
    const g = this.grind, e = g.edge, d = e.dir;
    if (dt > 0) {                                        // ease the heading round a bend
      const target = Math.atan2(d.x, d.z) + g.yawOff;
      let dy = target - this.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      this.yaw += dy * Math.min(1, dt * GRIND_TURN);
    }
    // the board's plane holds the edge line (along it in a 50-50, across it
    // in a slide), so a sloped edge pitches/rolls the board with it (owner:
    // "the board's angle needs to follow the ledge"): up = the most vertical
    // direction perpendicular to the edge
    _eu.copy(WORLD_UP).addScaledVector(d, -WORLD_UP.dot(d)).normalize();
    // what rests on the edge: a 50-50 hangs the truck hangers on it, a slide
    // the deck's underside. On a LEDGE (a solid top beside the edge) the
    // board also tips toward the open side so the inner wheels sit on the
    // top instead of inside it — a 50-50 rolls out until they clear, a slide
    // pitches about the corner with the outer end hanging (the locked-in look)
    let lift, tilt = 0, inward = 0;
    if (g.kind === '5050') {
      lift = BOARD.hanger;
      if (e.open) tilt = Math.atan(BOARD.hanger / BOARD.wheelX);
    } else {
      lift = BOARD.deck;
      if (e.open) {
        inward = SLIDE_IN;
        const noseIn = this.noseDir(_f).dot(e.open) < 0;   // which truck is over the top
        tilt = Math.atan(BOARD.deck / ((noseIn ? BOARD.axleF : BOARD.axleB) + inward));
      }
    }
    this.up.copy(_eu);
    if (tilt) this.up.multiplyScalar(Math.cos(tilt)).addScaledVector(e.open, Math.sin(tilt)).normalize();
    this._surfaceForward();
    this.pos.copy(e.a).addScaledVector(d, g.t);
    if (inward) this.pos.addScaledVector(_o.copy(e.open).multiplyScalar(-Math.cos(tilt)).addScaledVector(_eu, Math.sin(tilt)), inward);
    this.pos.addScaledVector(this.up, -lift);
    this.vel.copy(d).multiplyScalar(g.s * g.v);
    this.groundY = this.pos.y;
    this.surface = e.name;
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
    // a chained bend: flow onto the next/previous segment without leaving
    while (g.t > g.edge.len && g.edge.next) { g.t -= g.edge.len; g.edge = g.edge.next; this.surface = g.edge.name; }
    while (g.t < 0 && g.edge.prev) { g.edge = g.edge.prev; g.t += g.edge.len; this.surface = g.edge.name; }
    if (g.t < 0 || g.t > g.edge.len) {                   // off the end
      g.t = Math.min(g.edge.len, Math.max(0, g.t));
      this._placeOnEdge();
      this._endGrind('end');
      this._leave();
      return;
    }
    this._placeOnEdge(dt);
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
    this._yawFromForward();
  }

  // the heading from the facing. On a steep face the horizontal projection
  // of the facing is useless (a board pointing up a vert wall with a slight
  // carve projects to "sideways"): read the heading as if the face were
  // unrolled flat — the fall line's heading plus the board's angle to the
  // fall line within the plane. (owner: after a gap the rider slid sideways
  // down the neighbouring quarter pipe — the board had turned across it)
  _yawFromForward() {
    const f = this.forward, up = this.up;
    let y;
    if (up.y > 0.98) {
      y = Math.atan2(f.x, f.z);
    } else {
      _g.copy(WORLD_UP).addScaledVector(up, -up.y).normalize();   // up the slope, in the plane
      _x.crossVectors(up, _g).normalize();                        // across it (+X when up-slope is +Z)
      const along = f.dot(_g), lat = f.dot(_x);
      if (along * along + lat * lat < 0.04) return;
      y = Math.atan2(_g.x, _g.z) + Math.atan2(lat, along);
    }
    while (y - this.yaw > Math.PI) y -= 2 * Math.PI;             // continuous (spins count on)
    while (y - this.yaw < -Math.PI) y += 2 * Math.PI;
    this.yaw = y;
  }

  // turn the board: the facing rotates about the surface normal and the
  // heading follows. (Re-deriving the facing from the horizontal heading
  // every step turned the board across a steep face and slid the rider
  // sideways up and down quarter pipes.)
  _turnForward(d) {
    if (!d) return;
    _qs.setFromAxisAngle(this.up, d);
    this.forward.applyQuaternion(_qs);
    this.yaw += d;
  }

  // the first RIDEABLE surface along a ray. Thin steep faces crossing the ray
  // (a bench's chamfer, a rail's brace), faces far from the current tilt and
  // the backfaces of open prop meshes are skipped — not ridden, and not a
  // reason to leave the ground. A backface of one of OUR closed colliders (a
  // transition proxy) means we are inside it: returned as is with `_inside`
  // set, for the caller to escape.
  _groundCast(origin, dir, far, up, minDot, minYFloor = -1) {
    this._inside = false;
    _po.copy(origin);
    let left = far, used = 0;
    for (let i = 0; i < 4 && left > 0; i++) {
      const hit = this.world.cast(_po, dir, left);
      if (!hit) return null;
      const tag = hit.object.userData.collider || '';
      const transition = TRANSITION.test(tag);
      if (hit.backface) {
        if (transition) { this._inside = true; hit.distance += used; return hit; }
      } else {
        const minY = Math.max(minYFloor, transition ? -1 : isProp(tag) ? RIDE_MIN_Y : 0.5);
        if (hit.normal.y >= minY && hit.normal.dot(up) >= minDot) { hit.distance += used; return hit; }
      }
      const adv = hit.distance + 0.002;                   // skip past this face
      used += adv; left -= adv;
      _po.addScaledVector(dir, adv);
    }
    return null;
  }

  // the air sweep: a plain cast that passes through a prop's backfaces
  _sweepCast(origin, dir, far) {
    _po.copy(origin);
    let left = far, used = 0;
    for (let i = 0; i < 4 && left > 0; i++) {
      const hit = this.world.cast(_po, dir, left);
      if (!hit) return null;
      if (!hit.backface || TRANSITION.test(hit.object.userData.collider || '')) { hit.distance += used; return hit; }
      const adv = hit.distance + 0.002;
      used += adv; left -= adv;
      _po.addScaledVector(dir, adv);
    }
    return null;
  }

  _stepGround(dt) {
    const up = this.up, vel = this.vel;
    this._keepForward();                       // the facing lives in the surface plane; the heading follows it
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
    this._turnForward(dyaw);

    if (this.revert) {
      // ── revert ── a SKID: momentum keeps its direction while the board
      // spins under it, so truck grip must not apply mid-spin.
      const r = this.revert;
      r.t += dt;
      const u = Math.min(1, r.t / r.dur);
      const e = u * u * (3 - 2 * u);
      this._turnForward(r.from + r.dir * Math.PI * e - this.yaw);
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
      for (let k = 0; k < BODY_PROBES.length; k++) {
        _o.copy(this.pos).addScaledVector(up, BODY_PROBES[k]);
        const hit = this.world.cast(_o, _d, spd * dt + WALL_REACH);
        if (!hit) continue;
        const prop = isProp(hit.object.userData.collider || '');
        // wheel height: anything steep is a wall (on a prop, anything steeper
        // than a rideable top). Higher up: a prop's face at any angle is a
        // wall — the body cannot pass through a bench, a table, a ledge; on
        // the terrain and the transitions only a near-vertical face is (a
        // transition rising ahead is NOT a wall)
        const wall = k <= 1 ? hit.normal.dot(up) < (prop ? RIDE_MIN_Y : WALL_DOT)
                            : (prop || hit.normal.dot(up) < 0.15);
        if (wall) {
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
      // the first rideable face under us — only a transition may tilt the
      // rider steeply; on a bench, a rail, a table, the hip the ground is a
      // near-level top, never a slat's side, a chamfer or a bevel (owner: the
      // rider ended up lying on the curved bench, "riding sideways on every
      // wall surface"). Thin steep faces crossing the probe are skipped.
      let hit = this._groundCast(_o, _d, PROBE_UP + PROBE_DOWN, up, 0.45);
      if (!hit && !this._inside) {
        // nothing rideable along our tilt (a wall next to a bank, a step's
        // riser): look straight down
        hit = this._groundCast(_o.copy(this.pos).addScaledVector(WORLD_UP, PROBE_UP), DOWN, PROBE_UP + PROBE_DOWN, up, -1, 0.3);
      }
      // (the inside test starts a hair out along the SURFACE normal — straight
      // up from a contact point on a steep face pokes into the ramp itself
      // and used to fire a bogus escape onto the deck. Only OUR closed
      // colliders count: a prop's backface is just its open, double-sided
      // mesh — reading it as "inside" put the rider on top of the bench)
      if (this._inside || this.world.insideOf(_o.copy(this.pos).addScaledVector(up, 0.04), isTransition)) {
        // INSIDE a transition collider (owner: "stuck inside the quarter
        // pipe") — get back onto the top surface straight above and stop.
        // Done here, in full: letting the escape ray fall through to the
        // drop test below read its length as a 5 m ledge and threw the rider
        // back in
        const top = this.world.cast(_o.copy(this.pos).addScaledVector(WORLD_UP, 6), DOWN, 12);
        if (top && !top.backface) {
          this.pos.copy(top.point);
          up.copy(top.normal.y >= 0.5 ? top.normal : WORLD_UP);
          this.groundY = this.pos.y;
          this.surface = top.object.userData.collider || null;
        }
        vel.set(0, 0, 0);
        this._turn = 0; this._prevN = null;
        return;
      }
      if (hit && PROBE_UP - hit.distance > STEP_UP && isProp(hit.object.userData.collider || '')) {
        // a prop's top more than a wheel's height ABOVE the wheels (a rail's
        // base, a bench foot, a plank): a curb. The board stops against it;
        // it never rolls up onto it — that takes an ollie
        this.pos.addScaledVector(vel, -dt);
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
        // pumping: the concave curvature of the path (the normal turning
        // against the travel), smoothed over the mesh facets
        this._curv += ((convex ? 0 : _dn.length() / step) - this._curv) * Math.min(1, dt * 20);
        this.pumpA = Math.min(PUMP_AC_CAP, vel.lengthSq() * this._curv);
        if (this.pump) {
          const v2 = vel.lengthSq();
          const a = Math.min(PUMP_MAX, PUMP_K * this.pumpA);
          if (a > 0 && v2 > 0.25 && v2 < VMAX * VMAX * 1.2) vel.addScaledVector(_d.copy(vel).multiplyScalar(1 / Math.sqrt(v2)), a * dt);
        }
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
        // snapping onto the surface lifts the contact point; that height is
        // paid for in speed (energy), or a halfpipe pumps itself: +1 m/s a
        // pass with nobody pumping
        const lift = hit.point.y - this.pos.y;
        this.pos.copy(hit.point);
        if (lift > 0) {
          const v2 = vel.lengthSq(), v2n = v2 - 2 * G * lift;
          if (v2 > 1e-6) vel.multiplyScalar(v2n > 0 ? Math.sqrt(v2n / v2) : 0);
        }
        up.lerp(hit.normal, Math.min(1, dt * UP_SMOOTH)).normalize();
        this._keepForward();                   // carry the facing onto the new tilt
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
    this.pumpA = 0;
    this._curv = 0;
    this.airSpin = 0;
    this._prevN = null;
    this._turn = 0;
    if (this.up.y < 0.6) {
      _x.set(this.up.x, 0, this.up.z).normalize();          // horizontal "out of the face"
      this.vert = { out: _x.clone(), lip: this.pos.clone(), face: this._nearestFace(this.pos), target: null, turned: 0 };
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
    // a 360 is a LOCAL spin: the root turns about ITS OWN up, the tilt it left
    // the lip with stays (owner, 2026-09-03: "a 360 is a local spin around
    // local Y" — spinning about the world axis flipped the rider)
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
        const ahead = this._sweepCast(_o, _d, spd * LAND_LOOKAHEAD + 0.15);
        const aheadTag = ahead?.object.userData.collider || '';
        const aheadMinY = TRANSITION.test(aheadTag) ? 0.05 : isProp(aheadTag) ? RIDE_MIN_Y : 0.5;
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
      this._transferTarget(dt);                            // a gap to a neighbouring face? retargets out/lip
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
      const hit = this._sweepCast(_o, _d, step + 0.12);
      // a ramp's END PANEL hit from the air, just below the face's edge: the
      // rider is coming down a hair outside the ramp's width — put them onto
      // the face, never deflect them off the side (owner: "anything landing
      // by the edge, I'm getting pushed away from the pipe"). Well below the
      // face it is a wall like any other.
      if (hit && !hit.backface && hit.object.userData.panel) {
        _o.copy(hit.point).addScaledVector(hit.normal, -EDGE_SNAP);
        const top = this._groundCast(_o.addScaledVector(WORLD_UP, 3), DOWN, 6, WORLD_UP, -1);
        if (top && !top.backface && top.point.y < hit.point.y + 0.4 && TRANSITION.test(top.object.userData.collider || '')) {
          this.pos.copy(top.point);
          this.up.copy(top.normal);
          vel.addScaledVector(this.up, -vel.dot(this.up));
          vel.multiplyScalar(LAND_DAMP);
          this.grounded = true;
          this.groundY = this.pos.y;
          this.surface = top.object.userData.collider || null;
          this.surfaceFace = top.object.userData.faceWorld || null;
          this.vert = null;
          this._keepForward();
          this.events.push({ type: 'land', airTime: this.airTime });
          return;
        }
      }
      if (hit && hit.backface) {
        // we are INSIDE a solid (a corner case at a ledge's edge): sliding on
        // its inner faces just oscillates in place — climb out onto the top
        const top = this.world.cast(_o.copy(this.pos).addScaledVector(WORLD_UP, 6), DOWN, 12);
        if (top && !top.backface) {
          this.pos.copy(top.point);
          this.up.copy(top.normal.y >= 0.5 ? top.normal : WORLD_UP);
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
      const landTag = hit ? (hit.object.userData.collider || '') : '';
      const transition = hit && TRANSITION.test(landTag);
      // (a vert air lands steep only on a transition — never on a prop's
      // side or a ledge's wall beside the ramp)
      const rideable = hit && (hit.normal.y > (transition ? 0.05 : isProp(landTag) ? RIDE_MIN_Y : 0.5));
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
        // a gap transfer touches down ON the new face's fall line (nose up
        // it or down it, whichever the board is nearer to), so it rolls
        // straight down instead of carving across and off the side
        if (this.vert?.target && Math.abs(this.steer) < 0.2 && Math.abs(this.spin) < 0.2) {
          const o = this.vert.target.out;
          const s = this.forward.x * o.x + this.forward.z * o.z > 0 ? 1 : -1;
          this.forward.set(o.x * s, 0, o.z * s);
        }
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
