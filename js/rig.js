// rig.js — applies baked pose data to a creategamecharacters.ai character.
//
// Convention (CLAUDE.md): clip bone tracks are BIND-RELATIVE deltas
// (bone.quaternion = bind * delta). The Hips bone is special: the clip carries
// its world position and we bake an ABSOLUTE local rotation for it (anchor
// space, nose = +Z). The scene root is the physics ground frame — the rig only
// ever writes local data under it. Hips is NEVER the root.

import * as THREE from 'three';

const AXIS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

// A PoseBuffer is one frame of authored pose, in anchor space (nose = +Z):
//   bones: Map(name -> [x,y,z,w] bind-relative delta), Hips excluded
//   hipsPos: [x,y,z] | null      (anchor-space position of the Hips bone)
//   hipsRot: [x,y,z,w] | null    (anchor-space ABSOLUTE hips rotation)
//   board:  { pos:[3], quat:[4] } | null   (anchor-space board transform)
export function makeBuffer() {
  return { bones: new Map(), hipsPos: null, hipsRot: null, board: null };
}

export function clearBuffer(b) {
  b.bones.clear();
  b.hipsPos = null; b.hipsRot = null; b.board = null;
}

// out = a blended toward b by t (0..1). Missing bone in one side = identity.
export function blendBuffers(out, a, b, t) {
  out.bones.clear();
  const names = new Set([...a.bones.keys(), ...b.bones.keys()]);
  for (const n of names) {
    const da = a.bones.get(n), db = b.bones.get(n);
    da ? _qa.fromArray(da) : _qa.identity();
    db ? _qb.fromArray(db) : _qb.identity();
    _qa.slerp(_qb, t);
    out.bones.set(n, [_qa.x, _qa.y, _qa.z, _qa.w]);
  }
  const lerp3 = (pa, pb) => [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
  out.hipsPos = a.hipsPos && b.hipsPos ? lerp3(a.hipsPos, b.hipsPos) : (t < 0.5 ? a.hipsPos : b.hipsPos) || a.hipsPos || b.hipsPos;
  if (a.hipsRot && b.hipsRot) {
    _qa.fromArray(a.hipsRot); _qb.fromArray(b.hipsRot); _qa.slerp(_qb, t);
    out.hipsRot = [_qa.x, _qa.y, _qa.z, _qa.w];
  } else out.hipsRot = (t < 0.5 ? a.hipsRot : b.hipsRot) || a.hipsRot || b.hipsRot;
  if (a.board && b.board) {
    _qa.fromArray(a.board.quat); _qb.fromArray(b.board.quat); _qa.slerp(_qb, t);
    out.board = { pos: lerp3(a.board.pos, b.board.pos), quat: [_qa.x, _qa.y, _qa.z, _qa.w] };
  } else out.board = (t < 0.5 ? a.board : b.board) || a.board || b.board;
  return out;
}

// Multiply an extra local-axis rotation onto a buffer's bone delta (procedural layers:
// crouch, lean, arm balance). Order: existing * extra.
export function addRot(buffer, name, axis, angle) {
  if (!angle) return;
  _q.setFromAxisAngle(AXIS[axis], angle);
  const cur = buffer.bones.get(name);
  if (cur) {
    _qa.fromArray(cur).multiply(_q);
    buffer.bones.set(name, [_qa.x, _qa.y, _qa.z, _qa.w]);
  } else {
    buffer.bones.set(name, [_q.x, _q.y, _q.z, _q.w]);
  }
}

export class Rig {
  constructor(charScene) {
    this.bones = new Map();
    charScene.traverse(o => {
      if (o.isBone) this.bones.set(o.name.replace(/[^A-Za-z0-9_]/g, ''), o);
    });
    this.bind = new Map();
    for (const [n, b] of this.bones) this.bind.set(n, b.quaternion.clone());
    this.hips = this.bones.get('Hips');
    if (!this.hips) throw new Error('[rig] no Hips bone found');
    this.hipsBindPos = this.hips.position.clone();
    this.hipsBindRot = this.hips.quaternion.clone();

    // The hips bone may sit under an armature node with its own transform.
    // We author hips pos/rot in the character-root's space, so cache the
    // conversion into the hips' parent space once. (Identity for GGC exports,
    // but never assume.)
    charScene.updateWorldMatrix(true, true);
    this._charScene = charScene;
    this._parentInv = new THREE.Matrix4();
    this._parentInvQ = new THREE.Quaternion();
    this._refreshParent();
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
  }

  _refreshParent() {
    // hips.parent world matrix relative to character scene root
    const rel = new THREE.Matrix4().copy(this._charScene.matrixWorld).invert()
      .multiply(this.hips.parent.matrixWorld);
    this._parentInv.copy(rel).invert();
    this._parentInvQ.setFromRotationMatrix(this._parentInv);
  }

  // Write one PoseBuffer to the skeleton. Bones absent from the buffer reset to bind.
  // SDK characters carry a LIVE rest pose in bone.userData.gccRestQ (it changes
  // with body morphs) — always prefer it over the load-time cache (sdk.md §5).
  apply(buffer) {
    for (const [n, bone] of this.bones) {
      if (n === 'Hips') continue;
      const bind = bone.userData.gccRestQ || this.bind.get(n);
      const d = buffer.bones.get(n);
      if (d) {
        _q.fromArray(d);
        bone.quaternion.copy(bind).multiply(_q);
      } else {
        bone.quaternion.copy(bind);
      }
    }
    if (buffer.hipsPos) {
      this._v.fromArray(buffer.hipsPos).applyMatrix4(this._parentInv);
      this.hips.position.copy(this._v);
    } else {
      this.hips.position.copy(this.hipsBindPos);
    }
    if (buffer.hipsRot) {
      _q.fromArray(buffer.hipsRot).premultiply(this._parentInvQ);
      this.hips.quaternion.copy(_q);
    } else {
      this.hips.quaternion.copy(this.hipsBindRot);
    }
  }
}
