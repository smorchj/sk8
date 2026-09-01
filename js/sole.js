// sole.js — mesh-level foot contact (owner, 2026-09-02): the animations are
// close, but body morphs change proportions — feminine riders hovered above
// the deck, masculine stances clipped through it. Bones can't see shoe soles;
// the OUTFIT MESH can. So: find the lowest sole vertices of the actual
// character (shoes included) once per character build, then each frame attach
// the lowest contacting point to the top of the board's collision surface.
//
// The board's collision surface: deck top at board-local y = +0.07 over the
// deck footprint (measured from skateboard.glb's bounds).

import * as THREE from 'three';

export const DECK_TOP_Y = 0.07;          // board-local deck top
export const DECK_HALF_X = 0.17;         // contact footprint (a little forgiving)
export const DECK_HALF_Z = 0.45;

const FOOT_RE = { L: /^(Foot|Ball|Toe)L$/, R: /^(Foot|Ball|Toe)R$/ };
const KEEP = 24;                         // lowest sole candidates kept per foot

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

// Scan every skinned mesh (body + outfit + shoes) for vertices dominantly
// skinned to a foot bone; keep the lowest per side in that bone's local space.
// Must be called with the character at REST (after c.toRest()).
export function buildSoleData(charScene, rig) {
  charScene.updateWorldMatrix(true, true);
  const cands = { L: [], R: [] };
  charScene.traverse(mesh => {
    if (!mesh.isSkinnedMesh) return;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const si = geo.attributes.skinIndex;
    const sw = geo.attributes.skinWeight;
    if (!pos || !si || !sw) return;
    const bones = mesh.skeleton.bones;
    for (let i = 0; i < pos.count; i++) {
      let best = 0, bw = -1;
      const idx = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)];
      const wts = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
      for (let k = 0; k < 4; k++) if (wts[k] > bw) { bw = wts[k]; best = idx[k]; }
      if (bw < 0.4) continue;
      const bone = bones[best];
      if (!bone) continue;
      const bn = bone.name.replace(/[^A-Za-z0-9_]/g, '');
      const side = FOOT_RE.L.test(bn) ? 'L' : FOOT_RE.R.test(bn) ? 'R' : null;
      if (!side) continue;
      mesh.getVertexPosition(i, _v);                 // skinned, mesh-local
      _v.applyMatrix4(mesh.matrixWorld);             // → world (character rest)
      cands[side].push({ bn, x: _v.x, y: _v.y, z: _v.z });
    }
  });
  const out = { L: [], R: [] };
  for (const side of ['L', 'R']) {
    cands[side].sort((a, b) => a.y - b.y);
    for (const c of cands[side].slice(0, KEEP)) {
      const bone = rig.bones.get(c.bn);
      if (!bone) continue;
      _m.copy(bone.matrixWorld).invert();
      out[side].push({ bone, p: new THREE.Vector3(c.x, c.y, c.z).applyMatrix4(_m) });
    }
    if (!out[side].length) console.warn('[sole] no sole vertices found for foot', side);
  }
  console.log(`[sole] calibrated: L ${out.L.length} pts, R ${out.R.length} pts`);
  return out;
}

// How far the body must move vertically (world) so the lowest sole point over
// the deck sits exactly ON the deck top. Positive = raise (penetrating),
// negative = lower (hovering). Returns 0 when no participating sole is over
// the deck footprint.
export function measureSoleDrop(soleData, boardNode, feet) {
  if (!soleData) return 0;
  boardNode.updateWorldMatrix(true, false);
  _m.copy(boardNode.matrixWorld).invert();
  let minY = Infinity;
  for (const side of feet) {
    for (const c of soleData[side]) {
      _v.copy(c.p).applyMatrix4(c.bone.matrixWorld).applyMatrix4(_m);
      if (Math.abs(_v.x) > DECK_HALF_X || Math.abs(_v.z) > DECK_HALF_Z) continue;
      if (_v.y < minY) minY = _v.y;
    }
  }
  if (minY === Infinity) return 0;
  return DECK_TOP_Y - minY;
}
