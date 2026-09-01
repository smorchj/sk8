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
const BOARD_REST_Y = 0.07;   // board origin height when flat on ground

// push clip windows (Push_from_standstill, 2.38s) — tuned by eye
const PUSH_IN = 0.20, PUSH_OUT = 2.30, STROKE_A = 0.55, STROKE_B = 1.75;

export class SkateAnim {
  constructor({ rig, clips, physics, stance, skel, getSkill }) {
    this.rig = rig;
    this.clips = clips;
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
    if (!this.phys.grounded) return;
    if (this.state === 'ride' || this.state === 'push' || this.state === 'landing') {
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
    if (this.state === 'ride' && Math.abs(this._alongNose()) < 6.5) {
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
    if (this.state === 'ride' && Math.abs(this._alongNose()) < 6.5) {
      this._toState('push');
      this.time = this.clips.push.pushInfo?.loopA ?? 0.2;
    }
  }

  push() { this.pushStroke(); }   // compat alias

  revert(dir) {
    if (!this.phys.grounded) return;
    if (this.state !== 'ride' && this.state !== 'landing') return;
    this.phys.startRevert(dir);
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

    for (const e of phys.drainEvents()) {
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
          const cy = Math.cos(phys.yaw), sy = Math.sin(phys.yaw);
          phys.pos.x += cy * tr.landFrame.x + sy * tr.landFrame.z;
          phys.pos.z += -sy * tr.landFrame.x + cy * tr.landFrame.z;
          phys.yaw += tr.landFrame.yaw;
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

    // crouch envelope
    if (this.state === 'windup' && this.holding) {
      this.crouch = Math.min(1, this.crouch + dt / CROUCH_UP);
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
      this._leanLayer(pose, steer);
      if (this.time >= clip.duration - 0.05) { phys.pushing = false; this._toState('ride'); }
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
      tr.clip.sample(tr.t, tr.mirror, pose);
      if (!tr.popped && pose.board) {     // wind-in: board glued to the ground
        pose.board.pos[1] = Math.min(pose.board.pos[1], BOARD_REST_Y);
      }
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
          const chain = fkChain(this.skel, ['Ball' + backBone, 'Foot' + backBone], getD, pose.hipsPos, pose.hipsRot);
          const foot = chain.get('Ball' + backBone) || chain.get('Foot' + backBone);
          if (foot) {
            _q.fromArray(pose.board.quat);
            _v.set(0, 0.02, tr.clip.wrapPivotZ).applyQuaternion(_q);
            // the deck's TOP SURFACE meets the SOLE — the bone sits inside the
            // shoe, so pin the surface a shoe-gap below the bone along the
            // deck-top normal (owner: foot poked through the wrapping board)
            const SOLE_GAP = 0.065;
            _va.set(0, 1, 0).applyQuaternion(_q);
            const tx = foot.pos.x - _va.x * SOLE_GAP;
            const tz = foot.pos.z - _va.z * SOLE_GAP;
            const dx = tx - (pose.board.pos[0] + _v.x);
            const dz = tz - (pose.board.pos[2] + _v.z);
            const lim = 0.3;
            pose.board.pos[0] += Math.min(lim, Math.max(-lim, dx)) * w;
            pose.board.pos[2] += Math.min(lim, Math.max(-lim, dz)) * w;
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
    if (this.state === 'ride' || this.state === 'windup') feet = ['L', 'R'];
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
    const lean = steer * this.phys.rollSign * 0.14 * sp;   // board banks with the turn
    pose.board = {
      pos: [0, BOARD_REST_Y, 0],
      quat: _q.setFromAxisAngle(_z, lean).toArray(),
    };
    // idle bob
    addRot(pose, 'Spine_03', 'x', Math.sin(this._t * 1.7) * 0.015);
    this._leanLayer(pose, steer);
    if (pose.hipsPos) pose.hipsPos[1] += Math.sin(this._t * 2.3) * 0.004;
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
    // bone matrixWorlds are stale from the LAST render (they'd include last
    // frame's shift and the correction would converge to half) — refresh the
    // freshly-applied raw pose before measuring
    playerRoot.updateMatrixWorld(true);
    let feet = null;
    if (this.state === 'ride' || this.state === 'windup' || this.state === 'landing') {
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
