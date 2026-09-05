// anim.js — the skate state machine. Physics owns the root; this decides what
// the body and board do inside it, and WHEN physics pops/lands relative to the
// clip's authored tags.
//
// States: ride → windup → trick(prepop→air) → landing → ride, plus push.
// The wind-up is procedural crouch ON TOP of the riding pose — the board stays
// flat on the ground and the feet stay on the deck (owner requirement); the
// trick clip takes over just before its own pop so the pop always matches.

import * as THREE from 'three';
import { makeBuffer, blendBuffers, addRot } from './rig.js';
import { fkPosition, fkChain } from './clips.js';
import { measureSoleDrop } from './sole.js';
import { G } from './physics.js';

const LEG = {
  L: ['UpperLegL', 'LowerLegL', 'FootL'],
  R: ['UpperLegR', 'LowerLegR', 'FootR'],
};

const PREPOP = 0.10;         // start trick clips this long before their pop tag
const CROUCH_UP = 0.55;      // s to full wind-up
const CROUCH_DOWN = 0.30;    // s to stand back up
const FADE = 0.12;           // s default crossfade on state changes
const LEAN_TAU = 0.20;         // s — how fast the body's lean chases the steer input
const DROPIN_PERCH_T = 0.30;   // s into the drop-in take: settled on the coping, before anything moves
const DROPIN_RUN_IN = 0.12;    // s of the take to play before 'commit' so the tip reads, not snaps
const DROPIN_PERCH_OUT = 0.36; // m the perched rider+board sit OUT over the lip: back wheels on the coping, front half in the air.
                               // The physics root (the contact) stays on the deck behind — put on the edge it slides down the face.
const GRAB_IN = 0.16;        // s to reach the grab pose after the input
const GRAB_OUT = 0.14;       // s to let go after release
const GRAB_LAND = 0.22;      // let go this long before touchdown, no matter what
const AIR_POSE_DELAY = 0.12; // s airborne before a plain leave shows the air pose
const BOARD_REST_Y = 0.07;   // board origin height when flat on ground

// push clip windows (Push_from_standstill, 2.38s) — tuned by eye
const PUSH_IN = 0.20, PUSH_OUT = 2.30, STROKE_A = 0.55, STROKE_B = 1.75;

export class SkateAnim {
  constructor({ rig, clips, physics, stance, skel, getSkill, grabs }) {
    this.rig = rig;
    this.clips = clips;
    this.grabs = grabs || {};             // grab POSES (indy…), blended over the ollie air
    this.phys = physics;
    this.stance = stance;                 // 'regular' | 'goofy' (player's choice)
    this.skel = skel || null;             // for FK foot planting (updated on character swap)
    this.getSkill = getSkill || (() => 1);   // per-trick skill level 1..5

    this.state = 'ride';
    this.crouch = 0;
    this.holding = false;
    this.time = 0;                        // generic state clock
    this.trick = null;                    // {clip, mirror, t, rate, popped, label}
    this.lastTrick = '—';
    this.onTrick = null;                  // callback(label)

    this.lean = 0;                        // eased steer, for the LEAN only (see update)
    this.out = makeBuffer();              // what the rig gets
    this._pose = makeBuffer();            // working buffer
    this._tmp = makeBuffer();             // scratch (landing measurements)
    this._fadeFrom = null;                // snapshot buffer for crossfades
    this._fadeT = 0; this._fadeDur = FADE;
    this._snap = makeBuffer();
    this._booted = false;                 // first frame: no fade from the empty buffer
    this.pushHeld = false;                // stroke keeps looping while true (keyboard hold)
    this._swipeHold = 0;                  // seconds of push left from the last swipe
    this._soleDy = 0;                     // smoothed mesh-level sole-to-deck correction
    this._footFix = { L: new THREE.Vector3(), R: new THREE.Vector3() };  // per-foot board-space corrections
    this._dt = 1 / 60;

    // base riding pose: a straight-rolling moment of a clip whose nose axis is
    // trustworthy (verified 2026-09-01 with foot markers; cruise is
    // back-and-forth so its travel-derived nose is NOT trustworthy — avoid)
    this.ridePoseClip = 'kickflip';
    this.ridePoseT = 0.02;
    this._t = 0;                          // global time for idle bob
  }

  setStance(s) { this.stance = s; }

  // ── input events ──────────────────────────────────────────────────────────

  windupStart() {
    // pressed in the air: no wind-up, but the hold is armed — it engages by
    // itself on landing (one long hold pumps every transition)
    if (!this.phys.grounded) { this.holding = true; return; }
    if (this.state === 'ride' || this.state === 'push' || this.state === 'landing' || this.state === 'grind') {
      this._toState('windup');
      this.holding = true;
    }
  }

  windupEnd(gesture) {
    this.holding = false;
    if (this.state !== 'windup') return;
    const type = gesture.type;
    if (type === 'cancel') { this._toState('ride'); return; }
    const name = this._mapGesture(type);
    if (!name) { this._toState('ride'); return; }
    this._startTrick(name, gesture.strength ?? 1);
  }

  // Push: hold = stroke after stroke (the clip's stroke cycle loops), release =
  // one finishing stroke then step back on the board (owner, 2026-09-01: you
  // push multiple times BEFORE stepping back on — never stroke/step/stroke/step).
  pushStart() {
    if (!this.phys.grounded) return;
    this.pushHeld = true;
    if (this.state === 'ride') {
      this._toState('push');
      this.time = this.clips.push.pushInfo?.loopA ?? 0.2;
    }
  }

  pushEnd() { this.pushHeld = false; }

  // one down-swipe (mobile) = keep pushing for a beat; keep swiping = the clip
  // keeps rolling through ALL its strokes; stop swiping = step back on
  pushStroke() {
    if (!this.phys.grounded) return;
    this._swipeHold = 0.75;
    if (this.state === 'ride') {
      this._toState('push');
      this.time = this.clips.push.pushInfo?.loopA ?? 0.2;
    }
  }

  push() { this.pushStroke(); }   // compat alias

  // Manual (recovered Manual_V1): grounded balance — hold to stay up on the
  // tail, release to set down. pop/land tags are lift/set-down moments.
  manualStart() {
    if (!this.phys.grounded) return;
    if (!['ride', 'push', 'landing', 'windup'].includes(this.state)) return;
    this._manualOut = false;
    this._toState('manual');
    this.lastTrick = 'Manual';
    this.onTrick?.('Manual');
  }

  manualEnd() {
    if (this.state !== 'manual' || this._manualOut) return;
    this._manualOut = true;
    const land = this.clips.manual.tags.land;
    if (this.time < land) {
      blendBuffers(this._snap, this.out, this.out, 0);
      this._fadeFrom = this._snap;
      this._fadeT = 0;
      this._fadeDur = 0.12;
      this.time = land;                 // straight to the set-down
    }
  }

  // The MOCAPPED revert (cruise 10.20→11.43): one tap spins the authored 180
  // and stops; a second tap before the 180 point rides the full 360 to the
  // clip's end. Q/E (dir) pick the spin side via mirroring — both fs and bs
  // are covered by the one capture.
  revert(dir) {
    if (!this.phys.grounded) return;
    const clip = this.clips.revertclip;
    if (this.state === 'revert') {
      if (this._rev && this.time < (clip.halfT ?? 0.55) + 0.12) this._rev.want360 = true;
      return;
    }
    if (this.state !== 'ride' && this.state !== 'landing') return;
    if (!clip) { this.phys.startRevert(dir); return; }
    // ONE capture = one spin direction per stance. Mirroring for the other
    // direction flips the rider's STANCE with it (owner bug, 2026-09-02: "the
    // body is wrong"), so the body always plays its stance-correct variant;
    // a backside revert needs its own capture before Q/E can differ.
    const stanceMirror = clip.stance !== this.stance;
    this._rev = { mirror: stanceMirror, dir, want360: false };
    this._toState('revert');
    this.lastTrick = 'Revert';
    this.onTrick?.('Revert');
  }

  _mapGesture(type) {
    // owner spec: goofy — flick right = kickflip, flick left = heelflip.
    // regular mirrors that.
    if (type === 'flickRight') return this.stance === 'goofy' ? 'kickflip' : 'heelflip';
    if (type === 'flickLeft') return this.stance === 'goofy' ? 'heelflip' : 'kickflip';
    if (type === 'ollie' || type === 'kickflip' || type === 'heelflip'
      || type === 'impossible' || type === 'treflip') return type;
    return null;
  }

  _alongNose() {
    const n = this.phys.noseDir(_v);
    return this.phys.vel.x * n.x + this.phys.vel.z * n.z;
  }

  // ── state machinery ───────────────────────────────────────────────────────

  _toState(s) {
    // snapshot current output for a crossfade (not on the very first frame —
    // fading up from the empty buffer shows a floating bind pose at boot)
    if (this._booted) {
      blendBuffers(this._snap, this.out, this.out, 0);
      this._fadeFrom = this._snap;
      this._fadeT = 0;
      this._fadeDur = FADE;
    }
    this.state = s;
    this.time = 0;
  }

  // Grabs (owner, 2026-09-02): "indy is a grab in air and the ollie is done
  // normally before that. You should be able to transition while the
  // character is in the air as long as the board is not flipping." So a grab
  // is an INPUT DURING THE AIR — hold to grab, release to let go — allowed on
  // any trick once its board is caught (an ollie's board never flips). The
  // pose blends in from whatever the air pose is, holds, and is let go before
  // touchdown so the landing plant always gets the feet back.
  // The input is STICKY (owner: the indy felt unresponsive — a press just
  // before the pop or the lip was thrown away): hold the button whenever,
  // the grab engages the moment the air is eligible, and lets go on release.
  grabStart(name = 'indy') {
    this.wantGrab = name;
    return this._tryGrab();
  }

  _tryGrab() {
    const name = this.wantGrab;
    const tr = this.trick;
    const grab = name && this.grabs[name];
    if (!grab || this.state !== 'trick' || !tr || !tr.popped || this.phys.grounded) return false;
    if (tr.grab) { tr.grabHeld = true; return true; }     // re-grab before it faded out
    const tg = tr.clip.tags;
    // a plain air (lip, ledge) and an ollie never flip; a flip trick only
    // after its catch
    const caught = tr.name === 'ollie' || tr.name === 'air' || (tg.catch != null && tr.t >= tg.catch);
    if (!caught) return false;                             // board still flipping
    tr.grab = grab;
    tr.grabVar = grab.variantFor(this.stance);
    tr.grabT = 0; tr.grabHeld = true; tr.grabRelT = 0; tr.grabW = 0;
    const pretty = { indy: 'Indy' }[name] || name;
    tr.label = (tr.name === 'ollie' || tr.name === 'air') ? pretty : `${tr.label} ${pretty}`;
    this.lastTrick = tr.label;
    this.onTrick?.(tr.label);
    return true;
  }

  grabEnd() {
    this.wantGrab = null;
    const tr = this.trick;
    if (tr && tr.grab) tr.grabHeld = false;
  }

  _startAir() {
    const clip = this.clips.ollie;
    if (!clip || clip.tags.land == null) return;
    const landT = clip.tags.land;
    // (the hold is NOT dropped here: a held wind-up rides through the air and
    // re-engages on landing — one long hold pumps every transition)
    this.trick = {
      clip, mirror: clip.stance !== this.stance, name: 'air', vy: 0,
      t: Math.max(clip.tags.pop + 0.05, landT - 0.20),   // the catch: board under the feet
      rate: 1, popped: true, grab: null, grabVar: null, label: 'Air',
    };
    this._toState('trick');
    this._fadeDur = 0.15;
  }

  // The drop-in (owner, 2026-09-05): the rider tips off the coping and rides
  // the transition down. It runs on the trick machinery like _startAir does —
  // popped already, vy 0, so the physics never launches — from the clip's
  // 'commit' tag (the board starting to rotate down) to its 'land' (the wheels
  // biting the transition), where the normal landing hand-off takes over. The
  // physics carries the root down the ramp; the clip is the body and the deck.
  // The wait on the lip is the first half of the owner's take — tail on the
  // coping, nose hanging out, back foot pressing the tail — so that is what
  // plays while waiting: the clip HELD on a perch frame (rate 0). popped:true
  // does two things here: the physics never pops, and the wind-in clamp that
  // glues a board flat to the ground is skipped, so the track's tilted deck
  // shows as captured.
  dropInPerch() {
    const clip = this.clips.dropin;
    if (!clip || clip.tags.land == null) return false;
    if (this.state === 'trick' && this.trick?.name === 'dropin') return true;
    this.trick = {
      clip, mirror: clip.stance !== this.stance, name: 'dropin', vy: 0,
      t: DROPIN_PERCH_T, rate: 0, popped: true, held: true, perchW: 1,
      grab: null, grabVar: null, label: 'Drop in',
    };
    this._toState('trick');
    this._fadeDur = 0.12;
    return true;
  }

  // committing releases the hold: the take runs on from the perch through its
  // commit (the board rotating down) to land (the wheels biting the transition),
  // where the normal landing hand-off takes over. Physics carries the root.
  dropIn() {
    const clip = this.clips.dropin;
    if (!clip || clip.tags.land == null) return false;
    if (!(this.state === 'trick' && this.trick?.name === 'dropin')) this.dropInPerch();
    const tr = this.trick;
    tr.held = false;
    tr.rate = 1;
    tr.t = Math.max(tr.t, (clip.tags.commit ?? 0) - DROPIN_RUN_IN);
    this.lastTrick = 'Drop in';
    this.onTrick?.('Drop in');
    return true;
  }

  _startTrick(name, strength) {
    const clip = this.clips[name];
    if (!clip || clip.tags.pop == null) { this._toState('ride'); return; }
    const mirror = clip.stance !== this.stance;
    // pop height comes from WIND-UP × SKILL, never from the clip (owner spec):
    // the clip's air phase rate-fits whatever airtime physics produces.
    const skill = this.getSkill(name);
    const crouchEff = Math.max(this.crouch, (strength ?? 1) * 0.5);
    const vy = (2.2 + 1.3 * crouchEff) * (0.8 + 0.13 * (skill - 1));
    this.trick = {
      clip, mirror, name, vy,
      t: Math.max(0, clip.tags.pop - PREPOP),
      rate: 1,
      popped: false,
      grab: null, grabVar: null,          // set by grabStart() in the air
    };
    const fakie = this.phys.rollSign < 0;
    const pretty = { ollie: 'Ollie', kickflip: 'Kickflip', heelflip: 'Heelflip', impossible: 'Impossible', treflip: '360 Flip' }[name];
    this.trick.label = (fakie ? 'Fakie ' : '') + pretty + (mirror ? '' : '');
    this._toState('trick');
  }

  update(dt, steer) {
    this._t += dt;
    this._dt = dt;
    const phys = this.phys;
    // The steer input snaps to full deflection on the frame the key goes down,
    // and leaning straight off it banked the rider in ONE frame (owner,
    // 2026-09-04: "it snaps to the lean instead of leaning smoothly"). The lean
    // eases toward the input; the TURN itself still answers immediately, so the
    // board goes where you point it and the body catches up.
    this.lean += (steer - this.lean) * (1 - Math.exp(-dt / LEAN_TAU));

    for (const e of phys.drainEvents()) {
      // left the ground without a trick (a lip, a ledge, the stairs): hold a
      // compact air pose — the ollie clip just before its catch — so the
      // landing machinery (plant, fold-in) works exactly like a trick's
      if (e.type === 'leave' && (this.state === 'ride' || this.state === 'push' || this.state === 'landing' || this.state === 'windup' || this.state === 'grind')) {
        // a vert air or a grind exit is real air right away; anything else
        // waits AIR_POSE_DELAY — a hop over a model edge must not read as a
        // jump (owner: "strange self jump on all props")
        if (e.vert || this.state === 'grind') this._startAir();
        else this._airPending = AIR_POSE_DELAY;
        continue;
      }
      // the board caught a rail/coping: 50-50 or boardslide, a procedural
      // balance pose (owner: arms out, no capture needed)
      if (e.type === 'grind') {
        this.grindKind = e.kind;
        this._toState('grind');
        this._fadeDur = 0.10;
        this.lastTrick = e.kind === '5050' ? '50-50' : 'Boardslide';
        this.onTrick?.(this.lastTrick);
        continue;
      }
      if (e.type === 'land' && this.state === 'trick') {
        const tr = this.trick;
        const landT = tr.clip.tags.land ?? tr.clip.duration;
        tr.t = Math.max(tr.t, landT);                       // snap to the land tag
        // The capture drifted between pop and land, so the clip's board sits
        // OFF the anchor at touchdown. Fold that offset into the physics root
        // (world positions unchanged — invisible) and retarget the rollout, so
        // the board IS the root again when riding resumes (owner bug: board
        // landing off-root, character floating off the board while blending).
        tr.clip.sample(landT, tr.mirror, this._tmp);
        const b = this._tmp.board;
        if (b) {
          _v.set(0, 0, 1).applyQuaternion(_q.fromArray(b.quat));
          tr.landFrame = { x: b.pos[0], z: b.pos[2], yaw: Math.atan2(_v.x, _v.z) };
          // the offset lies in the ROOT's plane — along the landing surface,
          // never into it: on a transition the old horizontal shift pushed the
          // root into the wall, the inside-escape fired and stopped the rider
          // dead on every re-entry (owner: "it slows down at the landing")
          // only the FORWARD part of the offset moves the root: a clip's
          // sideways drift (the ollie lands 0.21 m to the side) is capture
          // drift, not travel — folded in, ten airs walked a pumping rider
          // 2 m across the halfpipe and off its side
          tr.landFrame.x = 0;
          // …and never INTO a wall: a rider who came down against the hip's
          // side was folded 9 cm into it by the ollie clip's forward offset
          // and stood inside the hip (owner's recording, 2026-09-03 50.6 s)
          if (Math.abs(tr.landFrame.z) > 1e-3 && phys.world) {
            _v.copy(phys.forward).multiplyScalar(Math.sign(tr.landFrame.z));
            _va.copy(phys.pos).addScaledVector(phys.up, 0.1);
            if (phys.world.cast(_va, _v, Math.abs(tr.landFrame.z) + 0.14)) tr.landFrame.z = 0;
          }
          phys.pos.addScaledVector(phys.forward, tr.landFrame.z);
          // the heading fold only for a real trick: the ollie clip lands a
          // couple of degrees off, and folding that into the root on every
          // plain air turned the rider a little more each pass
          if (tr.name !== 'air') phys.setYaw(phys.yaw + tr.landFrame.yaw);
          else tr.landFrame.yaw = 0;
          const n = phys.noseDir(_v);
          const va = phys.vel.x * n.x + phys.vel.z * n.z;
          if (Math.abs(va) > 0.3) phys.rollSign = Math.sign(va) || phys.rollSign;
          this._retarget(this.out, tr.landFrame);           // fade source in the new anchor
        }
        // spun in the air? name it (Ollie 180, Kickflip 360, …)
        const halfTurns = Math.round(Math.abs(phys.airSpin) / Math.PI);
        if (halfTurns >= 1) {
          this.lastTrick = `${tr.label} ${halfTurns * 180}`;
          this.onTrick?.(this.lastTrick);
        }
        this._toState('landing');
        this._fadeDur = 0.08;
        this._beginPlant(tr);
      }
    }

    // deferred air pose: only if we are still airborne after the delay
    if (this._airPending != null) {
      if (phys.grounded) this._airPending = null;
      else if ((this._airPending -= dt) <= 0 || this.wantGrab) { this._airPending = null; this._startAir(); }
    }
    // a held grab button engages as soon as the air allows it
    if (this.wantGrab && !(this.trick && this.trick.grab)) this._tryGrab();

    // a held wind-up survives an air: back on the ground it re-engages by
    // itself, so one long hold pumps every transition (owner, 2026-09-03:
    // "just hold the click as long as I do, it is pumping automatically")
    if (this.holding && phys.grounded && (this.state === 'ride' || this.state === 'landing' || this.state === 'push')) this.windupStart();
    // crouch envelope. Pumping: the held wind-up stands up through a
    // transition's curve (where the push is) and sinks again on the flat —
    // the crouch follows the curve's centripetal acceleration
    if (this.state === 'windup' && this.holding) {
      const target = 1 - 0.85 * Math.min(1, (phys.pumpA || 0) / 12);
      if (this.crouch < target) this.crouch = Math.min(target, this.crouch + dt / CROUCH_UP);
      else this.crouch = Math.max(target, this.crouch - dt / CROUCH_DOWN);
    } else if (this.state !== 'trick') {
      this.crouch = Math.max(0, this.crouch - dt / CROUCH_DOWN);
    }
    phys.crouch = this.crouch;

    const pose = this._pose;

    if (this.state === 'ride' || this.state === 'windup') {
      this._ridePose(pose, steer);
      phys.pushing = false;
    } else if (this.state === 'push') {
      const clip = this.clips.push;
      const info = clip.pushInfo;
      this.time += dt;
      this._swipeHold = Math.max(0, this._swipeHold - dt);
      const held = this.pushHeld || this._swipeHold > 0;
      if (info && this.time >= info.loopB && held && phys.speed() < 8.2) {
        this.time = info.loopA + (this.time - info.loopB);   // next stroke, same phase
      }
      // input stopped: step back on NOW — jump to the tail with a short fade
      // instead of playing the remaining strokes (owner spec)
      if (info && !held && this.time < info.tailStart) {
        blendBuffers(this._snap, this.out, this.out, 0);
        this._fadeFrom = this._snap;
        this._fadeT = 0;
        this._fadeDur = 0.15;
        this.time = info.tailStart;
      }
      const t = Math.min(this.time, clip.duration - 0.034);
      const mirror = clip.stance !== this.stance;
      clip.sample(t, mirror, pose);
      phys.pushing = info
        ? info.spans.some(s => t >= s.a && t <= s.b)
        : (t > STROKE_A && t < STROKE_B);
      // push clip's board bobs with the stroke; pin it to the ground plane
      if (pose.board) { pose.board.pos[1] = Math.min(pose.board.pos[1], BOARD_REST_Y); }
      // FAKIE PUSH (owner bug: after a 180 the push moonwalked): the stroke is
      // authored toward the nose, but fakie travel is tail-first — so the RIDER
      // turns 180° to stroke along travel while the board keeps its true,
      // nose-backward orientation.
      if (phys.rollSign < 0) {
        if (pose.hipsPos) { pose.hipsPos[0] = -pose.hipsPos[0]; pose.hipsPos[2] = -pose.hipsPos[2]; }
        if (pose.hipsRot) {
          _q.setFromAxisAngle(_y, Math.PI);
          _q2.fromArray(pose.hipsRot).premultiply(_q);
          pose.hipsRot = [_q2.x, _q2.y, _q2.z, _q2.w];
        }
        if (pose.board) { pose.board.pos[0] = -pose.board.pos[0]; pose.board.pos[2] = -pose.board.pos[2]; }
      }
      this._leanLayer(pose, this.lean);
      if (this.time >= clip.duration - 0.05) { phys.pushing = false; this._toState('ride'); }
    } else if (this.state === 'revert') {
      const clip = this.clips.revertclip;
      this.time += dt;
      const half = clip.halfT ?? 0.55;
      let exit = null;
      if (!this._rev.want360 && this.time >= half) exit = 'half';
      else if (this.time >= clip.duration - 0.034) exit = 'full';
      clip.sample(Math.min(this.time, clip.duration - 0.034), this._rev.mirror, pose);
      phys.vel.x *= 1 - 0.3 * dt;        // the skid scrubs a little speed
      phys.vel.z *= 1 - 0.3 * dt;
      phys.pushing = false;
      if (exit && pose.board) {
        // fold the spun board frame into the physics root (world-invisible),
        // flip rollSign on the 180; the 360 comes back around to itself
        const b = pose.board;
        _v.set(0, 0, 1).applyQuaternion(_q.fromArray(b.quat));
        const f = { x: b.pos[0], z: b.pos[2], yaw: Math.atan2(_v.x, _v.z) };
        const cy = Math.cos(phys.yaw), sy = Math.sin(phys.yaw);
        phys.pos.x += cy * f.x + sy * f.z;
        phys.pos.z += -sy * f.x + cy * f.z;
        phys.setYaw(phys.yaw + f.yaw);            // (the facing follows, or the 180 is undone next step)
        if (exit === 'half') phys.rollSign = -phys.rollSign;
        else { this.lastTrick = 'Revert 360'; this.onTrick?.(this.lastTrick); }
        this._retarget(this.out, f);
        this._retarget(pose, f);
        this._toState('ride');
      }
    } else if (this.state === 'grind') {
      this._ridePose(pose, 0);
      this._grindLayer(pose, dt);
      phys.pushing = false;
      if (!phys.grind) this._toState('ride');       // (the physics ended it without a leave)
    } else if (this.state === 'manual') {
      const clip = this.clips.manual;
      const mirror = clip.stance !== this.stance;
      this.time += dt;
      const A = 0.95, B = 1.80;         // balance loop inside [pop..land]
      if (!this._manualOut && this.time >= B) this.time = A + (this.time - B);
      clip.sample(Math.min(this.time, clip.duration - 0.034), mirror, pose);
      this._leanLayer(pose, this.lean * 0.5);
      phys.pushing = false;
      if (this.time >= clip.duration - 0.05) this._toState('ride');
    } else if (this.state === 'trick') {
      const tr = this.trick;
      tr.t += dt * tr.rate;
      if (!tr.popped && tr.t >= tr.clip.tags.pop) {
        tr.popped = true;
        phys.pop(tr.vy);
        const Tclip = (tr.clip.tags.land ?? tr.clip.duration) - tr.clip.tags.pop;
        const Tphys = 2 * tr.vy / G;
        tr.rate = Math.min(1.8, Math.max(0.45, Tclip / Tphys));   // clip fits the physics airtime
        this.lastTrick = tr.label;
        this.onTrick?.(tr.label);
      }
      const landT = tr.clip.tags.land ?? tr.clip.duration;
      if (tr.popped && tr.t > landT - 0.033 && !phys.grounded) {
        tr.t = landT - 0.033;             // hold the catch until physics touches down
      }
      if (tr.name === 'air' && phys.grounded && tr.t > landT - 0.04) {
        // an air pose but already on the ground with no land event (a snap
        // onto a lower surface): land it now
        phys.events.push({ type: 'land', airTime: 0 });
      }
      tr.clip.sample(tr.t, tr.mirror, pose);
      if (tr.name === 'dropin' && tr.perchW > 0) {
        // out over the coping (anchor +Z = the nose = down the ramp); the physics
        // root stays on the deck, so this is a visual lead that the run-in gives
        // back to the physics as the root goes over the edge
        if (!tr.held) tr.perchW = Math.max(0, tr.perchW - dt / DROPIN_RUN_IN);
        const out = DROPIN_PERCH_OUT * tr.perchW;
        if (pose.hipsPos) pose.hipsPos[2] += out;
        if (pose.board) pose.board.pos[2] += out;
      }
      if (!tr.popped && pose.board) {     // wind-in: board glued to the ground
        pose.board.pos[1] = Math.min(pose.board.pos[1], BOARD_REST_Y);
      }
      if (tr.popped && tr.grabVar) this._grabLayer(tr, pose, dt);
      // wrap-pivot retarget (impossible): re-pin the board's orbit to the
      // RENDERED back foot so the wrap clears any body's stance
      if (tr.popped && pose.board && tr.clip.wrapPivotZ != null && this.skel) {
        const tg = tr.clip.tags;
        const w =
          tr.t < tg.wrap ? Math.max(0, (tr.t - tg.pop) / Math.max(0.03, tg.wrap - tg.pop)) :
          tr.t < tg.catch - 0.05 ? 1 :
          Math.max(0, (tg.land - tr.t) / Math.max(0.03, tg.land - (tg.catch - 0.05)));
        if (w > 0.001) {
          const backBone = (this.stance === 'regular') ? 'R' : 'L';
          const getD = (bn) => pose.bones.get(bn) || null;
          const chain = fkChain(this.skel,
            ['Toe' + backBone, 'Ball' + backBone, 'Foot' + backBone], getD, pose.hipsPos, pose.hipsRot);
          const foot = chain.get('Ball' + backBone) || chain.get('Foot' + backBone);
          if (foot) {
            _q.fromArray(pose.board.quat);
            _v.set(0, 0.02, tr.clip.wrapPivotZ).applyQuaternion(_q);
            _va.set(0, 1, 0).applyQuaternion(_q);       // deck-top normal
            const tx = foot.pos.x - _va.x * 0.05;       // rough pre-position…
            const tz = foot.pos.z - _va.z * 0.05;
            const dx = tx - (pose.board.pos[0] + _v.x);
            const dz = tz - (pose.board.pos[2] + _v.z);
            const lim = 0.3;
            pose.board.pos[0] += Math.min(lim, Math.max(-lim, dx)) * w;
            pose.board.pos[2] += Math.min(lim, Math.max(-lim, dz)) * w;
            // …then an EXACT surface resolve (owner: still poking through on
            // both ends): transform this character's measured sole vertices by
            // the current pose and push the board out along its deck normal
            // until the deepest point sits on the face. No constants to tune.
            const sd = this._soleRef && this._soleRef[backBone];
            if (sd && sd.length) {
              // The wrap is end-over-end: half the cycle the face legitimately
              // points AWAY from the foot. Only sole points in the shallow
              // CONTACT BAND just behind the face are real pokes — resolve
              // those; leave the far-side phase alone.
              let minD = 0;
              for (const c of sd) {
                const bn = c.bone.name.replace(/[^A-Za-z0-9_]/g, '');
                const f = chain.get(bn);
                if (!f) continue;
                _vb.copy(c.p).applyQuaternion(f.quat).add(f.pos);
                const d = (_vb.x - pose.board.pos[0]) * _va.x
                  + (_vb.y - pose.board.pos[1]) * _va.y
                  + (_vb.z - pose.board.pos[2]) * _va.z - 0.07;
                if (d > -0.10 && d < minD) minD = d;
              }
              if (minD < 0) {
                const pw = Math.min(1, w * 2);   // penetration resolves at full
                pose.board.pos[0] += _va.x * minD * pw;   // strength even while
                pose.board.pos[1] += _va.y * minD * pw;   // the pin still ramps
                pose.board.pos[2] += _va.z * minD * pw;
              }
            }
          }
        }
      }
    } else if (this.state === 'landing') {
      const tr = this.trick;
      tr.t += dt;
      const end = Math.min(tr.clip.rolloutEnd, (tr.clip.tags.land ?? 0) + 0.55);
      tr.clip.sample(tr.t, tr.mirror, pose);
      if (tr.landFrame) this._retarget(pose, tr.landFrame);   // rollout in the re-anchored frame
      const u = (tr.t - tr.clip.tags.land) / (end - tr.clip.tags.land);
      if (u >= 1) { this._toState('ride'); this._fadeDur = 0.25; }
    }

    // wind-up crouch layer (board untouched — it stays flat on the ground).
    // The feet must STAY ON THE DECK: measure their FK height before and after
    // the crouch and move the hips by exactly the difference (owner bug,
    // 2026-09-01: feet lifted off the board while crouching).
    if (this.state === 'windup' || ((this.state === 'ride') && this.crouch > 0.001)) {
      const before = this._feetY(pose);
      this._crouchLayer(pose, this.crouch);
      if (before != null && pose.hipsPos) {
        const after = this._feetY(pose);
        if (after != null) pose.hipsPos[1] -= (after - before);
      }
    }

    this._booted = true;
    // crossfade from snapshot
    if (this._fadeFrom) {
      this._fadeT += dt;
      const u = Math.min(1, this._fadeT / this._fadeDur);
      blendBuffers(this.out, this._fadeFrom, pose, u * u * (3 - 2 * u));
      if (u >= 1) this._fadeFrom = null;
    } else {
      blendBuffers(this.out, pose, pose, 0);
    }

    // THE LANDING INVARIANT (owner, 2026-09-01): feet NEVER leave the board
    // when landing ANY trick. From touchdown until the ride pose has fully
    // taken over, both feet are IK-planted onto the deck in BOARD space —
    // targets glide from where the clip lands them to the riding stance, so
    // contact is unbreakable no matter the clip, the stance, or the blend.
    this._updatePlant(dt);

    return this.out;
  }

  // ── grabs ─────────────────────────────────────────────────────────────────

  // Blend the authored grab POSE over whatever the air pose is. Weight ramps
  // in from the grab input, holds while held, ramps out on release — and is
  // forced out before touchdown from the physics' remaining airtime — the
  // LINEAR (smoothstep) fallback the owner described for grabs without
  // blend-in/out animations. While it holds, the board is re-seated under the
  // RENDERED feet so the tuck carries the board — a grabbed board never
  // leaves the soles.
  _grabLayer(tr, pose, dt) {
    tr.grabT += dt;
    if (!tr.grabHeld) tr.grabRelT += dt;
    const phys = this.phys;
    const vy = phys.vel.y, y = phys.heightAboveGround();
    const remain = (vy + Math.sqrt(vy * vy + 2 * G * y)) / G;     // s until touchdown
    const ss = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
    const w = ss(tr.grabT / GRAB_IN) * ss(1 - tr.grabRelT / GRAB_OUT) * ss(remain / GRAB_LAND);
    tr.grabW = w;
    if (w <= 0.001) {
      if (!tr.grabHeld || remain < GRAB_LAND * 0.5) { tr.grab = null; tr.grabVar = null; }
      return;
    }
    const gv = tr.grabVar;
    // hips: the authored lean relative to the board (the clip's board, before
    // it is re-seated under the feet below — the lean is what shapes the tuck)
    if (gv.hipsLean && pose.hipsRot && pose.board) {
      _qb.fromArray(pose.board.quat).multiply(_qc.fromArray(gv.hipsLean));
      _qa.fromArray(pose.hipsRot);
      if (_qa.dot(_qb) < 0) _qb.set(-_qb.x, -_qb.y, -_qb.z, -_qb.w);
      _qa.slerp(_qb, w);
      pose.hipsRot = [_qa.x, _qa.y, _qa.z, _qa.w];
    }
    for (const [n, q] of Object.entries(gv.pose)) {
      const cur = pose.bones.get(n);
      cur ? _qa.fromArray(cur) : _qa.identity();
      _qb.fromArray(q);
      _qa.slerp(_qb, w);
      pose.bones.set(n, [_qa.x, _qa.y, _qa.z, _qa.w]);
    }
    if (!pose.board || !pose.hipsPos || !pose.hipsRot || !this.skel) return;
    // feet frame (see clips.js Grab): ankles + balls of the RENDERED body
    const getD = (bn) => pose.bones.get(bn) || null;
    const L = this.stance === 'regular';
    const feet = fkChain(this.skel, ['FootL', 'FootR', 'BallL', 'BallR'], getD, pose.hipsPos, pose.hipsRot);
    const front = feet.get(L ? 'FootL' : 'FootR'), back = feet.get(L ? 'FootR' : 'FootL');
    const ballL = feet.get('BallL'), ballR = feet.get('BallR');
    if (!front || !back || !ballL || !ballR) return;
    const mid = _vc.addVectors(front.pos, back.pos).multiplyScalar(0.5);
    _v.subVectors(front.pos, back.pos).normalize();                          // z: nose
    // y: the feet's own up (bind up axes rotated by the current feet), ⟂ z —
    // identical to tools/pose-from-studio.mjs so the authored offset holds
    const fu = this._footUpLocal();
    _vd.copy(fu.L).applyQuaternion(feet.get('FootL').quat)
      .add(_ve.copy(fu.R).applyQuaternion(feet.get('FootR').quat));
    _vb.copy(_vd).addScaledVector(_v, -_vd.dot(_v)).normalize();            // y: deck normal
    if (_vb.lengthSq() < 0.5) return;
    _va.crossVectors(_vb, _v).normalize();                                   // x = y × z
    _m.makeBasis(_va, _vb, _v);
    _qb.setFromRotationMatrix(_m);
    if (gv.boardPos && gv.boardQuat) {
      _vd.copy(mid).addScaledVector(_va, gv.boardPos[0]).addScaledVector(_vb, gv.boardPos[1]).addScaledVector(_v, gv.boardPos[2]);
      _qb.multiply(_qc.fromArray(gv.boardQuat));
    } else {
      _vd.copy(mid).addScaledVector(_vb, -0.21);        // no authored board: deck under the ankles
    }
    _qa.fromArray(pose.board.quat);
    if (_qa.dot(_qb) < 0) _qb.set(-_qb.x, -_qb.y, -_qb.z, -_qb.w);
    _qa.slerp(_qb, w);
    pose.board.quat = [_qa.x, _qa.y, _qa.z, _qa.w];
    pose.board.pos = [
      pose.board.pos[0] + (_vd.x - pose.board.pos[0]) * w,
      pose.board.pos[1] + (_vd.y - pose.board.pos[1]) * w,
      pose.board.pos[2] + (_vd.z - pose.board.pos[2]) * w,
    ];
  }

  // each foot bone's "up" in its own bind frame (bind-pose world up pulled
  // back through the bind chain) — cached per skeleton
  _footUpLocal() {
    if (this._footUp && this._footUp.skel === this.skel) return this._footUp;
    const bind = fkChain(this.skel, ['FootL', 'FootR'], () => null, [0, 0, 0], this.skel.hipsBindQuat);
    const up = (side) => {
      const f = bind.get('Foot' + side);
      return f ? new THREE.Vector3(0, 1, 0).applyQuaternion(f.quat.clone().invert()) : new THREE.Vector3(0, 1, 0);
    };
    this._footUp = { skel: this.skel, L: up('L'), R: up('R') };
    return this._footUp;
  }

  // ── landing foot plant ────────────────────────────────────────────────────

  _footAnchors(buf) {
    // both feet of `buf`, expressed in its board's local frame
    if (!buf.board || !buf.hipsPos || !buf.hipsRot || !this.skel) return null;
    const getD = (bn) => buf.bones.get(bn) || null;
    const w = fkChain(this.skel, ['FootL', 'FootR'], getD, buf.hipsPos, buf.hipsRot);
    const fl = w.get('FootL'), fr = w.get('FootR');
    if (!fl || !fr) return null;
    _q.fromArray(buf.board.quat).invert();
    const toBoard = (p) => p.clone().sub(_v.fromArray(buf.board.pos)).applyQuaternion(_q);
    return { L: toBoard(fl.pos), R: toBoard(fr.pos) };
  }

  _beginPlant(tr) {
    if (!this.skel) return;
    // where the clip puts the feet at the land tag (on the deck, per the data)
    const landT = tr.clip.tags.land ?? tr.clip.duration;
    tr.clip.sample(landT, tr.mirror, this._tmp);
    if (tr.landFrame) this._retarget(this._tmp, tr.landFrame);
    let land = this._footAnchors(this._tmp);
    // where the riding pose wants them
    const ride = makeBuffer();
    this._ridePose(ride, 0);
    const rideA = this._footAnchors(ride);
    if (!rideA) { this._plant = null; return; }
    if (!land) land = { L: rideA.L.clone(), R: rideA.R.clone() };
    // targets must be ON THE DECK no matter how sloppy the capture's catch was
    const onDeck = (v) => {
      v.x = Math.min(0.10, Math.max(-0.10, v.x));
      v.z = Math.min(0.34, Math.max(-0.34, v.z));
      v.y = Math.min(0.26, Math.max(0.14, v.y));
      return v;
    };
    onDeck(land.L); onDeck(land.R); onDeck(rideA.L); onDeck(rideA.R);
    const total = (Math.min(tr.clip.rolloutEnd, landT + 0.55) - landT) + 0.25;
    this._plant = { land, ride: rideA, t: 0, total: Math.max(0.2, total), w: 1, mix: 0 };
  }

  _updatePlant(dt) {
    const pd = this._plant;
    if (!pd) return;
    if (this.state === 'windup' || this.state === 'trick' || this.state === 'push') {
      this._plant = null;                    // a new action releases the feet
      return;
    }
    pd.t += dt;
    const mixU = Math.min(1, pd.t / pd.total);
    pd.mix = mixU * mixU * (3 - 2 * mixU);
    // release only AFTER the ride crossfade has fully converged on the ride
    // pose — its feet ARE the plant targets by then, so letting go is a no-op.
    // Releasing during the fade lets the uncorrected blend leak through.
    if (this.state !== 'landing' && !this._fadeFrom) {
      pd.w = Math.max(0, pd.w - dt / 0.12);
      if (pd.w <= 0) this._plant = null;
    }
  }

  // The actual plant, run AFTER rig.apply on the REAL rendered skeleton —
  // true bone world positions, true board node. No parallel model to
  // disagree with what's on screen.
  plantPostRig(rig, boardNode, playerRoot) {
    const pd = this._plant;
    if (!pd || pd.w <= 0.001) return;
    playerRoot.updateMatrixWorld(true);
    for (const side of ['L', 'R']) {
      const tLocal = pd.land[side].clone().lerp(pd.ride[side], pd.mix);
      tLocal.y += this._soleDy;            // ankle targets ride the sole calibration
      const T = boardNode.localToWorld(tLocal);
      this._legIK(rig, side, T, pd.w);
    }
  }

  // analytic two-bone leg IK on the REAL rendered bones: put this side's ankle
  // at world target T, preserving the foot's world orientation. Shared by the
  // landing plant and the grounded per-foot sole correction.
  _legIK(rig, side, T, weight) {
    {
      const up = rig.bones.get('UpperLeg' + side);
      const low = rig.bones.get('LowerLeg' + side);
      const foot = rig.bones.get('Foot' + side);
      if (!up || !low || !foot) return;
      const preUp = _qa.copy(up.quaternion), preLow = _qb.copy(low.quaternion), preFoot = _qc.copy(foot.quaternion);
      const H = up.getWorldPosition(_va);
      const K = low.getWorldPosition(_vb);
      const A = foot.getWorldPosition(_vc);
      const footWorldQ = foot.getWorldQuaternion(_qd);
      const L1 = H.distanceTo(K), L2 = K.distanceTo(A);
      if (L1 < 1e-4 || L2 < 1e-4) return;
      const d = Math.min(Math.max(T.distanceTo(H), Math.abs(L1 - L2) + 1e-3), L1 + L2 - 1e-3);

      // 1) knee bend so the hip→ankle distance matches the target distance
      const v1 = _vd.copy(H).sub(K).normalize();
      const v2 = _ve.copy(A).sub(K).normalize();
      const cur = Math.acos(Math.min(1, Math.max(-1, v1.dot(v2))));
      const want = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2))));
      const axis = _vf.copy(v2).cross(v1);
      if (axis.lengthSq() < 1e-8) { up.getWorldQuaternion(_qe); axis.set(1, 0, 0).applyQuaternion(_qe); }
      axis.normalize();
      // pick the bend sign that moves |hip→ankle| toward d (tested, not assumed)
      let ang = want - cur;
      _qe.setFromAxisAngle(axis, ang);
      const a1 = _vg.copy(A).sub(K).applyQuaternion(_qe).add(K);
      _qf.setFromAxisAngle(axis, -ang);
      const a2 = _vh.copy(A).sub(K).applyQuaternion(_qf).add(K);
      if (Math.abs(a2.distanceTo(H) - d) < Math.abs(a1.distanceTo(H) - d)) { ang = -ang; _qe.copy(_qf); }
      // apply the WORLD rotation _qe to the lower leg bone
      up.getWorldQuaternion(_qf);                       // low's parent world rot
      _qg.copy(_qf).invert().multiply(_qe).multiply(_qf);
      low.quaternion.premultiply(_qg);
      up.updateMatrixWorld(true);

      // 2) swing the whole leg about the hip so the ankle reaches the target
      const A1 = foot.getWorldPosition(_vg);
      _vh.copy(A1).sub(H).normalize();
      _vi.copy(T).sub(H).normalize();
      _qe.setFromUnitVectors(_vh, _vi);
      up.parent.getWorldQuaternion(_qf);                // up's parent world rot
      _qg.copy(_qf).invert().multiply(_qe).multiply(_qf);
      up.quaternion.premultiply(_qg);
      up.updateMatrixWorld(true);

      // 3) the foot keeps the orientation the animation gave it
      low.getWorldQuaternion(_qe).invert();
      foot.quaternion.copy(_qe.multiply(footWorldQ));

      // weight: ease the whole correction out during release
      if (weight < 1) {
        up.quaternion.copy(preUp.slerp(up.quaternion, weight));
        low.quaternion.copy(preLow.slerp(low.quaternion, weight));
        foot.quaternion.copy(preFoot.slerp(foot.quaternion, weight));
        up.updateMatrixWorld(true);
      }
    }
  }

  // Grounded per-foot placement retargeting (owner, 2026-09-02): body morphs
  // move the feet off the deck — feminine hovered vertically, masculine's
  // wider pelvis lands the WHOLE STANCE wide of the board. Each contacting
  // foot's ankle is pulled onto the deck footprint (lateral toward the
  // centreline, along-board within the deck) at its mesh-measured sole
  // height; the leg IK absorbs the difference — a wide-hipped rider's legs
  // simply angle inward, exactly like real bodies on a narrow board.
  groundFeetIK(rig, boardNode, soleData) {
    if (!soleData) return;
    let feet = null;
    if (['ride','windup','manual','revert','grind'].includes(this.state)) feet = ['L', 'R'];
    else if (this.state === 'push') {
      const info = this.clips.push.pushInfo;
      const mirror = this.clips.push.stance !== this.stance;
      let sf = info?.standFoot === 'FootL' ? 'L' : 'R';
      if (mirror) sf = sf === 'L' ? 'R' : 'L';
      feet = [sf];
    } else if (this.state === 'trick' && this.trick && !this.trick.popped) feet = ['L', 'R'];
    const k = 1 - Math.exp(-25 * this._dt);
    const LAT = 0.055, LONG = 0.36;         // where ankles may sit on the deck
    for (const side of ['L', 'R']) {
      const fix = this._footFix[side];
      const foot = rig.bones.get('Foot' + side);
      const active = feet && feet.includes(side) && foot;
      if (active) {
        const A = foot.getWorldPosition(_vg);
        _vh.copy(A);
        boardNode.worldToLocal(_vh);        // ankle in board space
        _vt.set(
          Math.min(LAT, Math.max(-LAT, _vh.x)) - _vh.x,
          measureSoleDrop(soleData, boardNode, [side]),
          Math.min(LONG, Math.max(-LONG, _vh.z)) - _vh.z,
        );
        fix.lerp(_vt, k);
        if (fix.lengthSq() > 4e-6) {
          _vt.copy(_vh).add(fix);
          this._legIK(rig, side, boardNode.localToWorld(_vt), 1);
        }
      } else {
        fix.lerp(_vz, k);                   // decay toward zero when free
      }
    }
  }

  // riding: mocap base pose + bob + lean; board procedural flat + carve roll
  _ridePose(pose, steer) {
    const base = this.clips[this.ridePoseClip];
    const mirror = base.stance !== this.stance;
    base.sample(this.ridePoseT, mirror, pose);
    // flatten the sampled board — riding board is procedural
    const sp = Math.min(1, this.phys.speed() / 5);
    const lean = this.lean * this.phys.rollSign * 0.14 * sp;   // board banks with the turn (eased)
    pose.board = {
      pos: [0, BOARD_REST_Y, 0],
      quat: _q.setFromAxisAngle(_z, lean).toArray(),
    };
    // idle bob
    addRot(pose, 'Spine_03', 'x', Math.sin(this._t * 1.7) * 0.015);
    this._leanLayer(pose, this.lean);
    if (pose.hipsPos) pose.hipsPos[1] += Math.sin(this._t * 2.3) * 0.004;
    // debug: try a rotation on a bone from the console (SK8.anim.boneTest = {bone, axis, angle})
    if (this.boneTest) addRot(pose, this.boneTest.bone, this.boneTest.axis, this.boneTest.angle);
  }

  // grind balance (owner, 2026-09-02: "arms out balancing type animations,
  // easily done through code"): knees bent, arms out wide, a slow wobble;
  // a boardslide twists the torso toward the direction of travel (the board
  // is across the rail, the rider still looks where they're going)
  _grindLayer(pose, dt) {
    this._grindT = (this._grindT || 0) + dt;
    const c = 0.35;
    const before = this._feetY(pose);
    this._crouchLayer(pose, c);
    if (before != null && pose.hipsPos) {
      const after = this._feetY(pose);
      if (after != null) pose.hipsPos[1] -= (after - before);
    }
    this._uprightLayer(pose, 0.75);
    // arms out to the sides: on this rig UpperArm 'z' abducts (measured:
    // L negative, R positive; 1.3 rad ≈ horizontal)
    const wob = Math.sin(this._grindT * 2.6) * 0.06;
    addRot(pose, 'UpperArmL', 'z', -1.25 + wob);
    addRot(pose, 'UpperArmR', 'z', 1.25 + wob);
    addRot(pose, 'UpperArmL', 'x', 0.2);
    addRot(pose, 'UpperArmR', 'x', 0.2);
    addRot(pose, 'Spine_01', 'z', wob * 0.5);
    if (this.grindKind === 'boardslide') {
      // travel in root space is ±X (the board is across the edge)
      const n = this.phys.noseDir(_v);
      const side = Math.sign(this.phys.vel.x * n.z - this.phys.vel.z * n.x) || 1;
      addRot(pose, 'Spine_01', 'y', side * 0.35);
      addRot(pose, 'Spine_03', 'y', side * 0.3);
      addRot(pose, 'Head', 'y', side * 0.25);
    }
  }

  // a grind tilts the root with the edge (a ledge 50-50 rolls out so the
  // inner wheels clear the top, a ledge slide pitches over the corner, a
  // sloped rail runs downhill); the rider stays mostly upright over it —
  // counter-rotate the hips about the deck line by most of the tilt, and the
  // legs take the difference (the feet stay on the deck: IK + sole plant)
  _uprightLayer(pose, k) {
    if (!pose.hipsRot || !pose.hipsPos) return;
    this.phys.rootQuat(_qa).invert();
    _vb.set(0, 1, 0).applyQuaternion(_qa);          // world up, in root space
    if (_vb.y > 0.9999) return;
    _qb.setFromUnitVectors(_y, _vb);
    _qb.slerp(_qc.identity(), 1 - k);
    const PIVOT_Y = 0.145;                          // deck top
    _vc.set(pose.hipsPos[0], pose.hipsPos[1] - PIVOT_Y, pose.hipsPos[2]).applyQuaternion(_qb);
    pose.hipsPos[0] = _vc.x; pose.hipsPos[1] = _vc.y + PIVOT_Y; pose.hipsPos[2] = _vc.z;
    _qa.fromArray(pose.hipsRot).premultiply(_qb);
    pose.hipsRot = [_qa.x, _qa.y, _qa.z, _qa.w];
  }

  _leanLayer(pose, steer) {
    const sp = Math.min(1, this.phys.speed() / 5);
    const s = steer * sp;
    if (!s) return;
    // body leans into the turn about the DECK LINE (owner: the pivot is down
    // at the feet, not up at the hips — rotating in place at the hips swings
    // the feet off the board). Rotate the hips AROUND a pivot at deck height
    // on the board's long axis; the feet sit on that line and barely move.
    const roll = s * this.phys.rollSign * 0.16;   // bank INTO the turn (right turn = right lean)
    const PIVOT_Y = 0.145;                     // deck top
    _q.setFromAxisAngle(_z, roll);
    if (pose.hipsPos) {
      const px = pose.hipsPos[0], py = pose.hipsPos[1] - PIVOT_Y;
      const c = Math.cos(roll), sn = Math.sin(roll);
      pose.hipsPos[0] = px * c - py * sn;      // rotate about Z through the pivot
      pose.hipsPos[1] = PIVOT_Y + px * sn + py * c;
    }
    if (pose.hipsRot) {
      _q2.fromArray(pose.hipsRot).premultiply(_q);
      pose.hipsRot = [_q2.x, _q2.y, _q2.z, _q2.w];
    }
    addRot(pose, 'Spine_01', 'z', -roll * 0.6);
    addRot(pose, 'Head', 'z', -roll * 0.4);
  }

  // MESH-LEVEL sole contact (owner, 2026-09-02): after the rig is applied,
  // attach the lowest outfit/shoe point of the contacting feet to the deck top
  // by shifting the whole body vertically. Which feet count is state truth:
  // riding/wind-up/landing = both, push = the standing foot, airborne = none
  // (flips must separate). Runs after the IK plant; the plant's targets carry
  // the same offset so the two never fight.
  soleAttach(rig, boardNode, soleData, playerRoot) {
    this._soleRef = soleData;             // also used by the wrap surface resolve
    // bone matrixWorlds are stale from the LAST render (they'd include last
    // frame's shift and the correction would converge to half) — refresh the
    // freshly-applied raw pose before measuring
    playerRoot.updateMatrixWorld(true);
    let feet = null;
    if (['ride','windup','landing','manual','revert','grind'].includes(this.state)) {
      feet = ['L', 'R'];
    } else if (this.state === 'push') {
      const info = this.clips.push.pushInfo;
      const mirror = this.clips.push.stance !== this.stance;
      let sf = info?.standFoot === 'FootL' ? 'L' : 'R';
      if (mirror) sf = sf === 'L' ? 'R' : 'L';
      feet = [sf];
    } else if (this.state === 'trick' && this.trick && !this.trick.popped) {
      feet = ['L', 'R'];
    }
    // rig.apply resets the hips from the buffer every frame, so this reads the
    // RAW pose — chase the absolute correction, smoothed (fast engage, gentler
    // release into the air).
    const target = feet ? measureSoleDrop(soleData, boardNode, feet) : 0;
    const k = 1 - Math.exp(-(feet ? 25 : 8) * this._dt);
    this._soleDy += (target - this._soleDy) * k;
    if (Math.abs(this._soleDy) > 1e-4 && rig.hips) {
      rig.hips.position.y += this._soleDy;
      rig.hips.updateWorldMatrix(true, true);
    }
  }

  // express a buffer relative to a measured 2D ground frame {x, z, yaw}
  _retarget(buf, f) {
    const cy = Math.cos(-f.yaw), sy = Math.sin(-f.yaw);
    const rot2 = (p) => {
      const x = p[0] - f.x, z = p[2] - f.z;
      p[0] = cy * x + sy * z;
      p[2] = -sy * x + cy * z;
    };
    _q2.setFromAxisAngle(_y, -f.yaw);
    if (buf.hipsPos) rot2(buf.hipsPos);
    if (buf.hipsRot) {
      _q.fromArray(buf.hipsRot).premultiply(_q2);
      buf.hipsRot = [_q.x, _q.y, _q.z, _q.w];
    }
    if (buf.board) {
      rot2(buf.board.pos);
      _q.fromArray(buf.board.quat).premultiply(_q2);
      buf.board.quat = [_q.x, _q.y, _q.z, _q.w];
    }
  }

  // mean FK height of both foot bones for the current pose buffer
  _feetY(pose) {
    if (!this.skel || !pose.hipsPos || !pose.hipsRot) return null;
    const getD = (bn) => pose.bones.get(bn) || null;
    const l = fkPosition(this.skel, 'FootL', getD, pose.hipsPos, pose.hipsRot);
    const r = fkPosition(this.skel, 'FootR', getD, pose.hipsPos, pose.hipsRot);
    if (!l || !r) return null;
    return (l.y + r.y) / 2;
  }

  // crouch with feet staying on the deck: fold knees + drop hips together
  _crouchLayer(pose, c) {
    if (c <= 0.001) return;
    if (pose.hipsPos) pose.hipsPos[1] -= 0.20 * c;
    addRot(pose, 'UpperLegL', 'x', -0.50 * c);
    addRot(pose, 'UpperLegR', 'x', -0.50 * c);
    addRot(pose, 'LowerLegL', 'x', 0.92 * c);
    addRot(pose, 'LowerLegR', 'x', 0.92 * c);
    addRot(pose, 'FootL', 'x', -0.38 * c);
    addRot(pose, 'FootR', 'x', -0.38 * c);
    addRot(pose, 'Spine_01', 'x', 0.22 * c);
    addRot(pose, 'UpperArmL', 'x', -0.25 * c);
    addRot(pose, 'UpperArmR', 'x', -0.25 * c);
  }
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _y = new THREE.Vector3(0, 1, 0);
const _z = new THREE.Vector3(0, 0, 1);
// IK scratch registers (leg solve)
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
const _vd = new THREE.Vector3(), _ve = new THREE.Vector3(), _vf = new THREE.Vector3();
const _vg = new THREE.Vector3(), _vh = new THREE.Vector3(), _vi = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _qd = new THREE.Quaternion(), _qe = new THREE.Quaternion(), _qf = new THREE.Quaternion();
const _qg = new THREE.Quaternion(), _qh = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _vt = new THREE.Vector3();
const _vz = new THREE.Vector3(0, 0, 0);
