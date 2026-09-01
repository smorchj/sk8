// clips.js — loads the mocap trick/ride clips and re-roots them for physics.
//
// A raw clip lives in its own capture space: bone quaternion deltas, a world
// hips position track, and a world board transform track, plus event tags
// (pop / flick / wrap / catch / land). The game's root is a physics-driven
// ground frame, so at bake time each clip is converted to "anchor space":
//
//   G(t) = the board's ground frame (XZ position + nose yaw) —
//          followed per-frame while grounded, FROZEN from pop to land, and
//          composed continuously through the landing rollout.
//
// Everything (hips, board) is expressed relative to G(t); at runtime the
// physics root replaces G. Nose = +Z in anchor space, always.
//
// Stance (regular = left foot forward) is measured per clip by FK'ing the
// feet against the board's nose axis — clips were solved from different
// skaters, so this is data, not an assumption. Mirrored variants (for the
// opposite stance) are baked lazily: swap L/R bone names, negate quat y/z,
// negate x positions (the documented mirror recipe for this rig).

import * as THREE from 'three';

const FPS = 30;
const HALF_LEN = 0.41;              // board half length (skateboard.glb bbox)

// Per-clip conversions the owner has called (2026-09-01): Impossible_V2 was
// captured as a NOLLIE impossible — "the rider animation must be mirrored and
// board needs to flip opposite; the authored animation already has board
// right". flipNose (180° nose relabel) + swapMirror (mirrored rider becomes
// the default) compose to a front-back mirror: the pop moves to the tail, the
// wrap moves to the back foot, travel is preserved. No nollies on this board.
const OVERRIDES = {
  impossible: { flipNose: true, swapMirror: true },
  kickflip: { rolloutEnd: 0.87 },   // owner: everything after 0.87 is broken capture
  // owner: heelflip capture turns after landing but the board doesn't follow —
  // remove the rider's post-land yaw drift relative to the board
  heelflip: { counterYawAfterLand: true },
};

const Y_AXIS = new THREE.Vector3(0, 1, 0);

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

// ── skeleton info (bind pose + hierarchy) for FK at bake time ───────────────

export function buildSkeletonInfo(charScene) {
  const bones = new Map();   // name -> {parent, pos:[3], quat:[4]}
  charScene.updateWorldMatrix(true, true);
  charScene.traverse(o => {
    if (!o.isBone) return;
    const name = o.name.replace(/[^A-Za-z0-9_]/g, '');
    const parent = o.parent && o.parent.isBone
      ? o.parent.name.replace(/[^A-Za-z0-9_]/g, '') : null;
    bones.set(name, {
      parent,
      pos: o.position.toArray(),
      quat: o.quaternion.toArray(),
    });
  });
  if (!bones.has('Hips')) throw new Error('[clips] skeleton has no Hips');
  return { bones, hipsBindQuat: bones.get('Hips').quat.slice() };
}

// FK a whole chain from Hips: world position AND orientation per bone.
// Exported for the landing foot-plant IK (anim.js).
export function fkChain(skel, names, getDelta, hipsPos, hipsRotAbs) {
  const out = new Map();
  for (const name of names) {
    const chain = [];
    let n = name;
    while (n && n !== 'Hips') { chain.unshift(n); n = skel.bones.get(n)?.parent; }
    if (n !== 'Hips') continue;
    let p = new THREE.Vector3().fromArray(hipsPos);
    let q = new THREE.Quaternion().fromArray(hipsRotAbs);
    for (const b of chain) {
      const info = skel.bones.get(b);
      const np = new THREE.Vector3().fromArray(info.pos).applyQuaternion(q).add(p);
      const lq = new THREE.Quaternion().fromArray(info.quat);
      const d = getDelta(b);
      if (d) lq.multiply(_q2.set(d[0], d[1], d[2], d[3]));
      const nq = q.clone().multiply(lq);
      p = np; q = nq;
      if (!out.has(b)) out.set(b, { pos: p, quat: q });
    }
  }
  return out;
}

// FK one bone's world (character-root-space) position at a baked frame.
// Exported: the anim controller uses it to keep feet planted during wind-up.
export function fkPosition(skel, boneName, getDelta, hipsPos, hipsRotAbs) {
  // chain from target up to Hips
  const chain = [];
  let n = boneName;
  while (n && n !== 'Hips') { chain.unshift(n); n = skel.bones.get(n)?.parent; }
  if (n !== 'Hips') return null;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(hipsPos),
    new THREE.Quaternion().fromArray(hipsRotAbs),
    new THREE.Vector3(1, 1, 1));
  const lm = new THREE.Matrix4();
  for (const b of chain) {
    const info = skel.bones.get(b);
    const d = getDelta(b);
    _q.fromArray(info.quat);
    if (d) { _q2.fromArray(d); _q.multiply(_q2); }
    lm.compose(new THREE.Vector3().fromArray(info.pos), _q, new THREE.Vector3(1, 1, 1));
    m.multiply(lm);
  }
  return new THREE.Vector3().setFromMatrixPosition(m);
}

// ── resampling helpers ──────────────────────────────────────────────────────

// keys: [[t, ...values]] -> value array at time t (lerp; quats get slerp+hemisphere)
function sampleKeys(keys, t, isQuat) {
  if (t <= keys[0][0]) return keys[0].slice(1);
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last.slice(1);
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; (keys[mid][0] <= t) ? lo = mid : hi = mid; }
  const a = keys[lo], b = keys[hi];
  const f = (t - a[0]) / (b[0] - a[0]);
  if (isQuat) {
    _q.set(a[1], a[2], a[3], a[4]);
    _q2.set(b[1], b[2], b[3], b[4]);
    if (_q.dot(_q2) < 0) { _q2.set(-_q2.x, -_q2.y, -_q2.z, -_q2.w); }
    _q.slerp(_q2, f);
    return [_q.x, _q.y, _q.z, _q.w];
  }
  const out = new Array(a.length - 1);
  for (let i = 1; i < a.length; i++) out[i - 1] = a[i] + (b[i] - a[i]) * f;
  return out;
}

const yawOfNose = (quat, noseSign) => {
  _v.set(0, 0, noseSign).applyQuaternion(_q.fromArray(quat));
  return Math.atan2(_v.x, _v.z);
};

// ── the baked clip ──────────────────────────────────────────────────────────

export class Clip {
  constructor(name, json, skel) {
    this.name = name;
    this._json = json;
    this._bake(json, skel);
  }

  // re-run the bake against a different character's skeleton (character swap)
  rebake(skel) { this._bake(this._json, skel); }

  _bake(json, skel) {
    const c = json.clip;
    const ov = OVERRIDES[this.name] || {};
    this.duration = c.duration;
    this.frames = Math.max(2, Math.round(c.duration * FPS) + 1);
    const N = this.frames;

    this.tags = {};
    for (const [t, tag] of (c.tags || [])) this.tags[tag] = t;

    // Broken capture tails (owner, 2026-09-01: kickflip's ending has broken
    // frames): the exporter prunes near-static keys, so a large hips key gap
    // after the land tag marks where the real rollout ends and the junk tail
    // begins. The game must never play past it.
    this.rolloutEnd = this.duration;
    if (this.tags.land != null) {
      const keyTimes = c.hips.map(k => k[0]).filter(t => t >= this.tags.land);
      for (let i = 1; i < keyTimes.length; i++) {
        if (keyTimes[i] - keyTimes[i - 1] > 0.2) { this.rolloutEnd = keyTimes[i - 1]; break; }
      }
      this.rolloutEnd = Math.max(this.rolloutEnd, this.tags.land + 0.12);
    }
    if (ov.rolloutEnd != null) this.rolloutEnd = ov.rolloutEnd;   // owner-called cut wins

    // 1) resample every bone track + hips + board to a uniform 30fps grid
    this.boneNames = Object.keys(c.tracks);
    const bones = new Map();
    for (const bn of this.boneNames) {
      const arr = new Float32Array(N * 4);
      for (let i = 0; i < N; i++) {
        const q = sampleKeys(c.tracks[bn], i / FPS, true);
        arr.set(q, i * 4);
      }
      bones.set(bn, arr);
    }
    const hipsW = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) hipsW.set(sampleKeys(c.hips, i / FPS, false), i * 3);

    const bt = c.props && c.props.skateboard;
    let boardPosW = null, boardQuatW = null;
    if (bt) {
      boardPosW = new Float32Array(N * 3);
      boardQuatW = new Float32Array(N * 4);
      const posKeys = bt.map(k => [k[0], k[1], k[2], k[3]]);
      const quatKeys = bt.map(k => [k[0], k[4], k[5], k[6], k[7]]);
      for (let i = 0; i < N; i++) {
        boardPosW.set(sampleKeys(posKeys, i / FPS, false), i * 3);
        boardQuatW.set(sampleKeys(quatKeys, i / FPS, true), i * 4);
      }
    }
    const boardless = !boardPosW;
    if (boardless && !/push/i.test(this.name)) {
      throw new Error(`[clips] ${this.name} has no skateboard track`);
    }
    // Board-less push clips (Push_Composed is in-place, human only): the board
    // is synthesized RIGID — constant heading from the kick direction (the
    // swing foot sweeps BACKWARD during ground contact, so travel is its
    // opposite) and a constant offset behind the standing (front) foot. The
    // board then cannot move in any direction but forward (owner requirement).
    this._synthBoard = false;
    if (boardless) {
      const feet = this._rawFeet(bones, hipsW, skel, N);
      const yVar = (arr) => {
        let m = 0; for (let i = 0; i < N; i++) m += arr[i * 3 + 1];
        m /= N;
        let v = 0; for (let i = 0; i < N; i++) { const dd = arr[i * 3 + 1] - m; v += dd * dd; }
        return v / N;
      };
      const standIsL = yVar(feet.L) <= yVar(feet.R);
      const stand = standIsL ? feet.L : feet.R;
      const swing = standIsL ? feet.R : feet.L;
      let lo = Infinity; for (let i = 0; i < N; i++) lo = Math.min(lo, swing[i * 3 + 1]);
      const TH = lo + 0.05;
      let kx = 0, kz = 0;
      for (let i = 0; i < N - 1; i++) {
        if (swing[i * 3 + 1] < TH) {
          kx += (swing[(i + 1) * 3] - swing[i * 3]) - (stand[(i + 1) * 3] - stand[i * 3]);
          kz += (swing[(i + 1) * 3 + 2] - swing[i * 3 + 2]) - (stand[(i + 1) * 3 + 2] - stand[i * 3 + 2]);
        }
      }
      const yaw = Math.atan2(-kx, -kz);          // nose = opposite of the kick
      const BOARD_BACK = -0.17;                  // board centre sits behind the front foot
      boardPosW = new Float32Array(N * 3);
      boardQuatW = new Float32Array(N * 4);
      const qy = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      for (let i = 0; i < N; i++) {
        boardPosW[i * 3] = stand[i * 3] + Math.sin(yaw) * BOARD_BACK;
        boardPosW[i * 3 + 1] = 0.07;
        boardPosW[i * 3 + 2] = stand[i * 3 + 2] + Math.cos(yaw) * BOARD_BACK;
        boardQuatW.set(qy, i * 4);
      }
      this._synthBoard = true;
    }

    // 2) resolve which end of the board track is the NOSE, then NORMALIZE the
    // track so +Z = physical nose in every clip (owner, 2026-09-01: the board
    // was rendering turned around in tricks/push — the anchor knew the front,
    // the mesh didn't. One convention, no per-clip cases downstream.)
    this._swapMirror = !!ov.swapMirror;
    this._counterYaw = !!ov.counterYawAfterLand;
    this.noseSignRaw = this._synthBoard ? 1 : this._resolveNose(boardPosW, boardQuatW, N);
    if (ov.flipNose) this.noseSignRaw = -this.noseSignRaw;
    if (this.noseSignRaw < 0) {
      const flip = new THREE.Quaternion(0, 1, 0, 0);       // rotY(π)
      for (let i = 0; i < N; i++) {
        _q.set(boardQuatW[i * 4], boardQuatW[i * 4 + 1], boardQuatW[i * 4 + 2], boardQuatW[i * 4 + 3]).multiply(flip);
        boardQuatW.set([_q.x, _q.y, _q.z, _q.w], i * 4);
      }
    }
    this.noseSign = 1;   // from here on, track +Z IS the nose

    // 3) stance from feet FK at a grounded reference moment
    const refT = this.tags.pop != null ? Math.max(0, this.tags.pop - 0.05) : this.duration / 2;
    const refI = Math.min(N - 1, Math.round(refT * FPS));
    const getDelta = (bn) => {
      const a = bones.get(bn);
      return a ? [a[refI * 4], a[refI * 4 + 1], a[refI * 4 + 2], a[refI * 4 + 3]] : null;
    };
    _q.fromArray(skel.hipsBindQuat);
    const dh = getDelta('Hips');
    if (dh) { _q2.fromArray(dh); _q.multiply(_q2); }
    const hipsRotAbs = [_q.x, _q.y, _q.z, _q.w];
    const hp = [hipsW[refI * 3], hipsW[refI * 3 + 1], hipsW[refI * 3 + 2]];
    const fl = fkPosition(skel, 'FootL', getDelta, hp, hipsRotAbs);
    const fr = fkPosition(skel, 'FootR', getDelta, hp, hipsRotAbs);
    _q.set(boardQuatW[refI * 4], boardQuatW[refI * 4 + 1], boardQuatW[refI * 4 + 2], boardQuatW[refI * 4 + 3]);
    const nose = _v.set(0, 0, this.noseSign).applyQuaternion(_q).setY(0).normalize().clone();
    const dl = fl.dot(nose), dr = fr.dot(nose);
    this.stance = dl > dr ? 'regular' : 'goofy';
    this.stanceMargin = Math.abs(dl - dr);        // meters between feet along nose axis
    // swapMirror: the DEFAULT variant is the mirrored bake, so the clip's
    // reported stance is the opposite of what the raw capture measured
    if (this._swapMirror) this.stance = this.stance === 'regular' ? 'goofy' : 'regular';

    // 4) ground path G(t) and 5) localize.
    // Push clips are rooted on the STANDING FOOT, not the board (owner,
    // 2026-09-01: the solver board track and the mocap foot disagree slightly —
    // rooted on the board, the standing foot slid around; the foot is the
    // contact truth, so the foot is the root and any residue shows on the board).
    let g;
    if (/push/i.test(this.name)) {
      g = this._footRootPath(bones, hipsW, boardQuatW, skel, N);
    } else {
      g = this._groundPath(boardPosW, boardQuatW, N);
    }
    this._skel = skel;
    this._raw = { bones, hipsW, boardPosW, boardQuatW, g };
    this.variants = {};
    this.variant(false);                  // prebake the default variant

    // wrap tricks (impossible): find the board-local point that moves LEAST
    // between wrap and catch — that's the orbit pivot, i.e. where the capture
    // skater's back foot was. The game re-pins it to the rendered back foot
    // so the wrap clears any body (owner, 2026-09-02: masc leg-through-board).
    this.wrapPivotZ = null;
    if (this.tags.wrap != null && this.tags.catch != null) {
      const v = this.variant(false);       // the default-played variant (swap-aware)
      const i0 = Math.max(0, Math.round(this.tags.wrap * FPS));
      const i1 = Math.min(this.frames - 1, Math.round(this.tags.catch * FPS));
      let bestZ = 0, bestVar = Infinity;
      for (let zi = -8; zi <= 8; zi++) {
        const z = zi * 0.05;
        let mx = 0, my = 0, mz = 0, n = 0;
        const pts = [];
        for (let i = i0; i <= i1; i++) {
          _q.set(v.boardQuat[i * 4], v.boardQuat[i * 4 + 1], v.boardQuat[i * 4 + 2], v.boardQuat[i * 4 + 3]);
          _v.set(0, 0.02, z).applyQuaternion(_q);
          _v.x += v.boardPos[i * 3]; _v.y += v.boardPos[i * 3 + 1]; _v.z += v.boardPos[i * 3 + 2];
          pts.push([_v.x, _v.y, _v.z]);
          mx += _v.x; my += _v.y; mz += _v.z; n++;
        }
        mx /= n; my /= n; mz /= n;
        let va = 0;
        for (const p of pts) va += (p[0] - mx) ** 2 + (p[1] - my) ** 2 + (p[2] - mz) ** 2;
        if (va < bestVar) { bestVar = va; bestZ = z; }
      }
      this.wrapPivotZ = bestZ;
    }
  }

  _resolveNose(bPos, bQuat, N) {
    const endY = (i, s) => {
      _q.set(bQuat[i * 4], bQuat[i * 4 + 1], bQuat[i * 4 + 2], bQuat[i * 4 + 3]);
      _v.set(0, 0, s * HALF_LEN).applyQuaternion(_q);
      return bPos[i * 3 + 1] + _v.y;
    };
    if (this.tags.pop != null) {
      // just after pop, the nose end rises while the tail strikes low
      const i0 = Math.min(N - 1, Math.round(this.tags.pop * FPS));
      const i1 = Math.min(N - 1, Math.round((this.tags.pop + 0.1) * FPS));
      const risePlus = endY(i1, +1) - endY(i0, +1);
      const riseMinus = endY(i1, -1) - endY(i0, -1);
      return risePlus >= riseMinus ? +1 : -1;
    }
    // no pop: nose = net travel direction of the board
    _v.set(bPos[(N - 1) * 3] - bPos[0], 0, bPos[(N - 1) * 3 + 2] - bPos[2]);
    if (_v.lengthSq() < 1e-4) return +1;
    let dot = 0;
    for (let i = 0; i < N; i += 5) {
      _q.set(bQuat[i * 4], bQuat[i * 4 + 1], bQuat[i * 4 + 2], bQuat[i * 4 + 3]);
      _v2.set(0, 0, 1).applyQuaternion(_q);
      dot += _v2.x * _v.x + _v2.z * _v.z;
    }
    return dot >= 0 ? +1 : -1;
  }

  // FK both feet in RAW capture space for every frame (bake-time analysis)
  _rawFeet(bones, hipsW, skel, N) {
    const hipsDelta = bones.get('Hips');
    const bindH = new THREE.Quaternion().fromArray(skel.hipsBindQuat);
    const out = { L: new Float32Array(N * 3), R: new Float32Array(N * 3) };
    for (let i = 0; i < N; i++) {
      const getD = (bn) => {
        const a = bones.get(bn);
        return a ? [a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]] : null;
      };
      _q.copy(bindH);
      if (hipsDelta) { _q2.set(hipsDelta[i * 4], hipsDelta[i * 4 + 1], hipsDelta[i * 4 + 2], hipsDelta[i * 4 + 3]); _q.multiply(_q2); }
      const hr = [_q.x, _q.y, _q.z, _q.w];
      const hp = [hipsW[i * 3], hipsW[i * 3 + 1], hipsW[i * 3 + 2]];
      const l = fkPosition(skel, 'FootL', getD, hp, hr);
      const r = fkPosition(skel, 'FootR', getD, hp, hr);
      out.L.set([l.x, l.y, l.z], i * 3);
      out.R.set([r.x, r.y, r.z], i * 3);
    }
    return out;
  }

  // Push ground path: anchor XZ = the standing foot's own trajectory (pinning
  // it at the origin exactly), yaw from the board quat (stable). Also derives
  // pushInfo: which foot pushes, the stroke ground-contact spans, and the loop
  // window (backswing→backswing) so the game can chain multiple strokes.
  _footRootPath(bones, hipsW, bQuat, skel, N) {
    const feet = this._rawFeet(bones, hipsW, skel, N);
    const stats = (arr) => {
      let mean = 0; for (let i = 0; i < N; i++) mean += arr[i * 3 + 1];
      mean /= N;
      let va = 0; for (let i = 0; i < N; i++) { const d = arr[i * 3 + 1] - mean; va += d * d; }
      return va / N;
    };
    const standIsL = stats(feet.L) <= stats(feet.R);
    const stand = standIsL ? feet.L : feet.R;
    const swing = standIsL ? feet.R : feet.L;

    // stroke contacts = local minima of the swing-foot height (brief toe-down
    // moments — threshold spans miss them, minima don't)
    let lo = Infinity; for (let i = 0; i < N; i++) lo = Math.min(lo, swing[i * 3 + 1]);
    const winF = Math.round(0.15 * FPS);
    const spans = [];
    for (let i = 1; i < N - 1; i++) {
      const y = swing[i * 3 + 1];
      if (y > lo + 0.10) continue;
      let isMin = true;
      for (let j = Math.max(0, i - winF); j <= Math.min(N - 1, i + winF); j++) {
        if (swing[j * 3 + 1] < y - 1e-6) { isMin = false; break; }
      }
      if (isMin) {
        const t = i / FPS;
        spans.push({ a: Math.max(0, t - 0.10), b: Math.min(this.duration, t + 0.14) });
        i += winF;
      }
    }
    const BACKSWING = 0.35;
    this.pushInfo = {
      standFoot: standIsL ? 'FootL' : 'FootR',
      spans,
      loopA: spans.length ? Math.max(0, spans[0].a - BACKSWING) : 0,
      // loop the WHOLE stroke sequence (all pushes), wrapping at matching phase
      loopB: spans.length > 1 ? Math.max(0, spans[spans.length - 1].a - BACKSWING)
        : (spans.length ? Math.min(this.duration, spans[0].b + BACKSWING) : this.duration),
      // where the step-back-on begins — the abort point when input stops
      tailStart: spans.length ? Math.min(this.duration, spans[spans.length - 1].b + 0.06) : 0,
    };

    const g = new Float32Array(N * 3);
    let prevYaw = 0;
    for (let i = 0; i < N; i++) {
      let yaw = yawOfNose(bQuat.subarray(i * 4, i * 4 + 4), this.noseSign);
      if (i > 0) {
        while (yaw - prevYaw > Math.PI) yaw -= 2 * Math.PI;
        while (yaw - prevYaw < -Math.PI) yaw += 2 * Math.PI;
      }
      prevYaw = yaw;
      g[i * 3] = stand[i * 3];
      g[i * 3 + 1] = stand[i * 3 + 2];
      g[i * 3 + 2] = yaw;
    }
    return g;
  }

  // G per frame: {x, z, yaw}; frozen pop→land; composed through the rollout.
  _groundPath(bPos, bQuat, N) {
    const raw = new Float32Array(N * 3);
    let prevYaw = 0;
    for (let i = 0; i < N; i++) {
      let yaw = yawOfNose(bQuat.subarray(i * 4, i * 4 + 4), this.noseSign);
      if (i > 0) { // unwrap
        while (yaw - prevYaw > Math.PI) yaw -= 2 * Math.PI;
        while (yaw - prevYaw < -Math.PI) yaw += 2 * Math.PI;
      }
      prevYaw = yaw;
      raw[i * 3] = bPos[i * 3];
      raw[i * 3 + 1] = bPos[i * 3 + 2];
      raw[i * 3 + 2] = yaw;
    }
    const g = new Float32Array(N * 3);
    const pop = this.tags.pop != null ? Math.round(this.tags.pop * FPS) : null;
    const land = this.tags.land != null ? Math.round(this.tags.land * FPS) : null;
    for (let i = 0; i < N; i++) {
      if (pop == null || i <= pop) {
        g.set(raw.subarray(i * 3, i * 3 + 3), i * 3);
      } else if (land == null || i < land) {
        g.set(g.subarray(pop * 3, pop * 3 + 3), i * 3);           // frozen in the air
      } else {
        // rollout: compose post-land board motion onto the frozen frame:
        // G(i) = G(pop) ∘ inv(F(land)) ∘ F(i)
        const gx = g[pop * 3], gz = g[pop * 3 + 1], gyaw = g[pop * 3 + 2];
        const lx = raw[land * 3], lz = raw[land * 3 + 1], lyaw = raw[land * 3 + 2];
        const dx = raw[i * 3] - lx, dz = raw[i * 3 + 1] - lz;
        const dyaw = raw[i * 3 + 2] - lyaw;
        const rot = gyaw - lyaw;
        const cs = Math.cos(rot), sn = Math.sin(rot);
        g[i * 3] = gx + cs * dx + sn * dz;
        g[i * 3 + 1] = gz - sn * dx + cs * dz;
        g[i * 3 + 2] = gyaw + dyaw;
      }
    }
    return g;
  }

  _localize(bones, hipsW, bPosW, bQuatW, g, skel, mirror) {
    const N = this.frames;
    const outBones = new Map();
    const swapLR = (n) => {
      const m = /^(.*?)([LR])$/.exec(n);
      return m ? m[1] + (m[2] === 'L' ? 'R' : 'L') : n;
    };
    for (const [n, arr] of bones) {
      if (n === 'Hips') continue;
      const name = mirror ? swapLR(n) : n;
      if (!mirror) { outBones.set(name, arr); continue; }
      const a = new Float32Array(N * 4);
      for (let i = 0; i < N; i++) {
        a[i * 4] = arr[i * 4];
        a[i * 4 + 1] = -arr[i * 4 + 1];
        a[i * 4 + 2] = -arr[i * 4 + 2];
        a[i * 4 + 3] = arr[i * 4 + 3];
      }
      outBones.set(name, a);
    }
    const hipsDelta = bones.get('Hips');
    const hipsPos = new Float32Array(N * 3);
    const hipsRot = new Float32Array(N * 4);
    const boardPos = new Float32Array(N * 3);
    const boardQuat = new Float32Array(N * 4);
    const bindH = new THREE.Quaternion().fromArray(skel.hipsBindQuat);
    const unyaw = new THREE.Quaternion();
    for (let i = 0; i < N; i++) {
      const gx = g[i * 3], gz = g[i * 3 + 1], gyaw = g[i * 3 + 2];
      unyaw.setFromAxisAngle(_v.set(0, 1, 0), -gyaw);
      // hips position
      _v2.set(hipsW[i * 3] - gx, hipsW[i * 3 + 1], hipsW[i * 3 + 2] - gz).applyQuaternion(unyaw);
      // hips absolute rotation (anchor space)
      _q.copy(bindH);
      if (hipsDelta) {
        _q2.set(hipsDelta[i * 4], hipsDelta[i * 4 + 1], hipsDelta[i * 4 + 2], hipsDelta[i * 4 + 3]);
        _q.multiply(_q2);
      }
      _q.premultiply(unyaw);
      // board
      const bp = new THREE.Vector3(bPosW[i * 3] - gx, bPosW[i * 3 + 1], bPosW[i * 3 + 2] - gz).applyQuaternion(unyaw);
      const bq = new THREE.Quaternion(bQuatW[i * 4], bQuatW[i * 4 + 1], bQuatW[i * 4 + 2], bQuatW[i * 4 + 3]).premultiply(unyaw);
      if (mirror) {
        _v2.x = -_v2.x;
        _q.set(_q.x, -_q.y, -_q.z, _q.w);
        bp.x = -bp.x;
        bq.set(bq.x, -bq.y, -bq.z, bq.w);
      }
      hipsPos.set([_v2.x, _v2.y, _v2.z], i * 3);
      hipsRot.set([_q.x, _q.y, _q.z, _q.w], i * 4);
      boardPos.set([bp.x, bp.y, bp.z], i * 3);
      boardQuat.set([bq.x, bq.y, bq.z, bq.w], i * 4);
    }

    // counterYawAfterLand: the capture turns after touchdown while the board
    // does not — remove the rider's yaw drift (vs the land frame) by rotating
    // hips rotation AND position back around the board's ground point.
    if (this._counterYaw && this.tags.land != null) {
      const li = Math.min(N - 1, Math.round(this.tags.land * FPS));
      const hipsYaw = (i) => {
        _q.set(hipsRot[i * 4], hipsRot[i * 4 + 1], hipsRot[i * 4 + 2], hipsRot[i * 4 + 3]);
        _v.set(0, 0, 1).applyQuaternion(_q);
        return Math.atan2(_v.x, _v.z);
      };
      const base = hipsYaw(li);
      let prev = 0;
      for (let i = li + 1; i < N; i++) {
        let d = hipsYaw(i) - base;
        while (d - prev > Math.PI) d -= 2 * Math.PI;
        while (d - prev < -Math.PI) d += 2 * Math.PI;
        prev = d;
        const bx = boardPos[i * 3], bz = boardPos[i * 3 + 2];
        const cy = Math.cos(-d), sy = Math.sin(-d);
        const x = hipsPos[i * 3] - bx, z = hipsPos[i * 3 + 2] - bz;
        hipsPos[i * 3] = bx + cy * x + sy * z;
        hipsPos[i * 3 + 2] = bz - sy * x + cy * z;
        _q2.setFromAxisAngle(Y_AXIS, -d);
        _q.set(hipsRot[i * 4], hipsRot[i * 4 + 1], hipsRot[i * 4 + 2], hipsRot[i * 4 + 3]).premultiply(_q2);
        hipsRot.set([_q.x, _q.y, _q.z, _q.w], i * 4);
      }
    }
    return { bones: outBones, hipsPos, hipsRot, boardPos, boardQuat };
  }

  variant(mirror) {
    const actual = this._swapMirror ? !mirror : mirror;   // nollie conversion swaps the roles
    const key = actual ? 'm' : 'n';
    if (!this.variants[key]) {
      const r = this._raw;
      this.variants[key] = this._localize(r.bones, r.hipsW, r.boardPosW, r.boardQuatW, r.g, this._skel, actual);
    }
    return this.variants[key];
  }

  // stance as the PLAYER sees it for a given variant
  stanceOf(mirror) {
    if (!mirror) return this.stance;
    return this.stance === 'regular' ? 'goofy' : 'regular';
  }

  // write the clip state at time t into a PoseBuffer (anchor space)
  sample(t, mirror, out) {
    const v = this.variant(mirror);
    const N = this.frames;
    const ft = Math.min(Math.max(t, 0), this.duration) * FPS;
    const i0 = Math.min(N - 1, Math.floor(ft));
    const i1 = Math.min(N - 1, i0 + 1);
    const f = ft - i0;
    out.bones.clear();
    for (const [n, arr] of v.bones) {
      _q.set(arr[i0 * 4], arr[i0 * 4 + 1], arr[i0 * 4 + 2], arr[i0 * 4 + 3]);
      _q2.set(arr[i1 * 4], arr[i1 * 4 + 1], arr[i1 * 4 + 2], arr[i1 * 4 + 3]);
      if (_q.dot(_q2) < 0) _q2.set(-_q2.x, -_q2.y, -_q2.z, -_q2.w);
      _q.slerp(_q2, f);
      out.bones.set(n, [_q.x, _q.y, _q.z, _q.w]);
    }
    const l3 = (arr) => [
      arr[i0 * 3] + (arr[i1 * 3] - arr[i0 * 3]) * f,
      arr[i0 * 3 + 1] + (arr[i1 * 3 + 1] - arr[i0 * 3 + 1]) * f,
      arr[i0 * 3 + 2] + (arr[i1 * 3 + 2] - arr[i0 * 3 + 2]) * f,
    ];
    const l4 = (arr) => {
      _q.set(arr[i0 * 4], arr[i0 * 4 + 1], arr[i0 * 4 + 2], arr[i0 * 4 + 3]);
      _q2.set(arr[i1 * 4], arr[i1 * 4 + 1], arr[i1 * 4 + 2], arr[i1 * 4 + 3]);
      if (_q.dot(_q2) < 0) _q2.set(-_q2.x, -_q2.y, -_q2.z, -_q2.w);
      _q.slerp(_q2, f);
      return [_q.x, _q.y, _q.z, _q.w];
    };
    out.hipsPos = l3(v.hipsPos);
    out.hipsRot = l4(v.hipsRot);
    out.board = { pos: l3(v.boardPos), quat: l4(v.boardQuat) };
    return out;
  }
}

// ── the store ───────────────────────────────────────────────────────────────

export async function loadClips(skel, onProgress) {
  const files = {
    ollie: 'Ollie_V1.json',
    kickflip: 'Kickflip_V5.json',
    heelflip: 'Heelflip.json',
    treflip: '360Flip_V3.json',
    impossible: 'Impossible_V2.json',
    push: 'Push_Composed.json',        // the owner's full multi-stroke push
    cruise: 'Cruise_slalom_revert.json',
  };
  const clips = {};
  for (const [key, file] of Object.entries(files)) {
    onProgress?.(`clip: ${file}`);
    const json = await fetch(`assets/anims/${file}`).then(r => {
      if (!r.ok) throw new Error(`fetch ${file}: ${r.status}`);
      return r.json();
    });
    clips[key] = new Clip(key, json, skel);
  }
  return clips;
}
