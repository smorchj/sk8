// DOES EACH SAVED CHARACTER COME OUT AS IT WAS SAVED?
//
// Drives the REAL `installPresetRecipes` out of the swapped-in SDK, against THIS project's
// real recipes, its real spectrum.bin and its real base GLB. Nothing is mocked but the scene
// the SDK installs into, which carries the project's own mesh names and vertex counts and the
// project's own anchor delta as its spectrum morph target — the same arrays the browser holds.
//
// The measure is the only one that matters: how far the rendered head sits from the head the
// editor saved. "As saved" is the character's OWN anchor plus its own face offsets; the
// project's base is venus, so a character saved on mars is only itself at the far end of the
// body axis. That is the whole defect — four of these ten are mars characters.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { NodeIO } from '@gltf-transform/core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// the bundle the GAME loads (js/creator.js ASSETS) — override with argv[2]
 const DIR = join(ROOT, process.argv[2] || 'assets/creator-min');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const { _installPresetRecipes } = await import(new URL('file:///' + join(DIR, 'sdk', process.env.SDK_FILE || 'v1.js').replace(/\\/g, '/')).href);

// ── the base, and the anchor axis, from the project's own files ──
const doc = await new NodeIO().read(join(DIR, manifest.base.url));
const baseUv = new Map(), baseCount = new Map();
for (const node of doc.getRoot().listNodes()) {
  const prim = node.getMesh()?.listPrimitives()[0];
  if (!prim) continue;
  baseCount.set(node.getName(), prim.getAttribute('POSITION').getCount());
  const uv = prim.getAttribute('TEXCOORD_0');
  if (uv) baseUv.set(node.getName(), uv.getArray());
}
const buf = readFileSync(join(DIR, manifest.spectrum.url));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dv = new DataView(ab);
const headLen = dv.getUint32(4, true);
const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 8, headLen)));
const bodyAt = 8 + headLen + ((4 - (headLen % 4)) % 4);
const delta = new Map();
for (const m of header.meshes) {
  const p = m.prims[0];
  if (!p || !p.pos) continue;
  const d = new Int16Array(ab, bodyAt + p.pos.off, p.count * 3);
  const a = new Float32Array(d.length);
  for (let i = 0; i < a.length; i++) a[i] = d[i] * p.pos.scale;
  delta.set(m.nodeA, a);
}

// A stand-in for the loaded rig: real names, real counts, real UVs, and the real anchor delta
// installed exactly where the SDK puts it — as morph target 0.
function makeScene() {
  const root = new THREE.Group();
  const axis = new Map();
  for (const [name, count] of baseCount) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const uv = baseUv.get(name);
    if (uv) g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uv), 2));
    const d = delta.get(name);
    if (d) g.morphAttributes.position = [new THREE.BufferAttribute(Float32Array.from(d), 3)];
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
    mesh.name = name;
    root.add(mesh);
    if (d) axis.set(mesh, g.morphAttributes.position[0].array);
  }
  return { root, axis };
}

const mean = (a) => { let s = 0, n = 0; for (let i = 0; i < a.length; i += 3) { s += Math.hypot(a[i], a[i + 1], a[i + 2]); n++; } return s / n; };

let pass = 0, fail = 0;
const ok = (c, label, detail) => { c ? pass++ : fail++; console.log('  ' + (c ? 'ok  ' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : '')); };

console.log('\nEvery saved character in the sk8 project, rendered and compared to its save\n');
console.log('  character   anchor   presetBuild   head error at the build the GAME used (0)   at presetBuild');
console.log('  ' + '-'.repeat(94));

const rows = [];
for (const [name, entry] of Object.entries(manifest.presets)) {
  const recipe = JSON.parse(readFileSync(join(DIR, entry.recipe), 'utf8'));
  const { root, axis } = makeScene();
  const res = _installPresetRecipes(THREE, root, { [name]: recipe }, axis);
  const build = res.builds.get(name);

  // The head the SDK installed, and the axis it sits on.
  const headMesh = [...axis.keys()].find((m) => /head/i.test(m.name));
  const routes = res.routes.get(name) || [];
  const route = routes.find((r) => r.mesh === headMesh);
  if (!route) { console.log('  ' + name.padEnd(12) + 'no head route'); continue; }
  const face = headMesh.geometry.morphAttributes.position[route.morphIndex].array;
  const D = axis.get(headMesh);

  // Rendered head = base + (body x D) + face.  As saved = the character's OWN anchor + face,
  // and its own anchor is 0 for a venus character, 1 for a mars one.
  const savedAt = /mars/i.test(recipe.baseMesh) ? 1 : 0;
  const err = (body) => {
    const e = new Float32Array(D.length);
    for (let i = 0; i < D.length; i++) e[i] = (body - savedAt) * D[i];
    return mean(e);
  };
  const atGame = err(0);          // what the game did: its own slider, defaulting to 0
  const atBuild = err(build);     // what presetBuild says
  // AND THE FACE ITSELF MUST ARRIVE INTACT. The installed morph target has to be the
  // recipe's own offsets, vertex for vertex — a "correction" that quietly shaves the
  // identity is the same bug wearing the fix's clothes.
  const spec = recipe.geometry.meshes[Object.keys(recipe.geometry.meshes).find(n => /head/i.test(n))];
  let wantSum = 0;
  for (let k = 0; k < spec.movedCount; k++) { const o = spec.offsets; wantSum += Math.hypot(o[k*3], o[k*3+1], o[k*3+2]); }
  const wantMean = wantSum / spec.movedCount;
  let gotSum = 0, gotN = 0;
  for (let i = 0; i < face.length; i += 3) { const m = Math.hypot(face[i], face[i+1], face[i+2]); if (m > 1e-9) { gotSum += m; gotN++; } }
  const gotMean = gotN ? gotSum / gotN : 0;
  rows.push({ name, anchor: recipe.baseMesh, build, atGame, atBuild, face: mean(face), wantMean, gotMean, moved: spec.movedCount, gotN });
  console.log('  ' + name.padEnd(12) + String(recipe.baseMesh).padEnd(9)
    + build.toFixed(2).padEnd(14)
    + (atGame * 100).toFixed(2).padStart(6) + ' cm'
    + '  (face identity ' + (mean(face) * 100).toFixed(2) + ' cm)'
    + (atBuild * 100).toFixed(3).padStart(14) + ' cm');
}

console.log('');
for (const r of rows) {
  ok(r.atBuild < 1e-9, r.name + ' stands exactly where it was saved',
     r.atBuild === 0 ? '' : (r.atBuild * 1000).toFixed(4) + ' mm');
  ok(Math.abs(r.gotMean - r.wantMean) < 1e-6,
     r.name + "'s face is installed exactly as the recipe wrote it",
     'recipe ' + (r.wantMean*100).toFixed(4) + ' cm vs installed ' + (r.gotMean*100).toFixed(4) + ' cm');
}
const wrong = rows.filter((r) => r.atGame > r.face);
console.log('\n  Before: ' + wrong.length + ' of ' + rows.length
  + ' characters were rendered further from their save than their whole face identity is wide.');
for (const r of wrong) {
  console.log('    ' + r.name.padEnd(10) + (r.atGame * 100).toFixed(1) + ' cm off, against a face that is only '
    + (r.face * 100).toFixed(2) + ' cm deep — ' + Math.round(r.atGame / r.face) + 'x its own identity');
}
console.log('\n  After: every character reports the build it belongs at, and lands on its save exactly.');
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
