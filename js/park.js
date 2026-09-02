// park.js — the rural "Skate Barn" park (owner's reference render, 2026-09-02):
// a cracked concrete plaza in a meadow, an asphalt lot behind it, and the
// owner's Meshy props placed around it. Tileable ground textures + normal
// maps are the owner's (Gemini), models are Meshy exports optimized by
// tools/park-models.mjs, grass cards by js/grass.js.
//
// The mini-ramp GLBs share one mesh: ramp.glb is loaded ONCE and each
// placement swaps the base-color map (ramp_tex/v1..7) on a cloned material.
//
// Collision/riding on ramps is NOT here yet — the physics ground is still
// the flat plane; the props are decoration until ramp/grind physics lands.

import * as THREE from 'three';
import { buildGrass } from './grass.js';

const T = 'assets/park/textures/';
const M = 'assets/park/';

// physical size (m) one texture tile covers — tuned by eye against the rider
const TILE = { grass: [5.2, 2.84], concrete: [8.8, 4.8], asphalt: [3.2, 1.75] };

// plaza / lot / path footprints (also keep grass cards out)
const PLAZA = { w: 36, d: 28, x: 0, z: 0 };
const LOT = { w: 60, d: 24, x: 0, z: 28 };
const PATH = { w: 4, d: 14, x: 0, z: 21 };

// placements: [model, x, z, rotY(deg), scale, variant]
const LAYOUT = [
  // quarter pipes along the far edge, faces toward the plaza
  ['ramp', -9, 13, 180, 2.6, 1],
  ['ramp', -3, 13, 180, 2.6, 2],
  ['ramp', 3, 13, 180, 2.6, 3],
  ['ramp', 9, 13, 180, 2.6, 4],
  // banks on the sides
  ['ramp', -16, -4, 90, 2.6, 5],
  ['ramp', -16, 4, 90, 2.6, 6],
  ['ramp', 16, -4, -90, 2.6, 7],
  ['ramp2', 16, 5, -90, 3.0],
  // the big concrete ramp, rail, bridge, table
  ['ramp_haven', 0, -13, 0, 4.0],
  ['grind_rail', 5, -3, 0, 1.8],
  ['curve_bridge', -7, -7, 0, 3.0],
  ['picnic_table', 19, -13, 30, 1.0],
];

const inRect = (r, x, z, pad = 0) => Math.abs(x - r.x) < r.w / 2 + pad && Math.abs(z - r.z) < r.d / 2 + pad;

export async function buildPark({ scene, loader, renderer, onProgress }) {
  const group = new THREE.Group();
  group.name = 'park';
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const texLoader = new THREE.TextureLoader();
  const tile = async (file, name, w, h, srgb) => {
    const t = await texLoader.loadAsync(T + file + '.jpg');
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(w / TILE[name][0], h / TILE[name][1]);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return t;
  };

  // ── sky: a soft gradient dome; fog fades into its horizon colour ──────────
  const horizon = new THREE.Color(0xcfdbe8), zenith = new THREE.Color(0x5f8fc7);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(360, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { horizon: { value: horizon }, zenith: { value: zenith } },
      vertexShader: 'varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 horizon, zenith; varying vec3 vW;
        void main(){ float h = clamp(normalize(vW).y, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, zenith, pow(h, 0.55)), 1.0); }`,
    }));
  sky.frustumCulled = false;
  group.add(sky);
  scene.background = horizon.clone();
  scene.fog = new THREE.Fog(horizon.clone(), 70, 220);

  // ── ground: meadow everywhere, concrete plaza, asphalt lot, path ──────────
  onProgress?.('park: ground');
  const plane = (w, h, mat, y) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    m.receiveShadow = true;
    return m;
  };
  // owner's grass normals: 'grass_soft_n' (default) or 'grass_detail_n'
  const meadowMat = new THREE.MeshStandardMaterial({
    map: await tile('grass', 'grass', 400, 400, true),
    normalMap: await tile('grass_soft_n', 'grass', 400, 400, false),
    roughness: 1, metalness: 0, color: 0xe6e9df,
  });
  meadowMat.normalScale.set(0.6, 0.6);
  const meadow = plane(400, 400, meadowMat, 0);
  const concreteMat = (w, h) => new THREE.MeshStandardMaterial({
    map: null, normalMap: null, roughness: 0.9, metalness: 0, color: 0xc3c2bb,
  });
  const plazaMat = concreteMat();
  plazaMat.map = await tile('concrete', 'concrete', PLAZA.w, PLAZA.d, true);
  plazaMat.normalMap = await tile('concrete_n', 'concrete', PLAZA.w, PLAZA.d, false);
  plazaMat.normalScale.set(0.7, 0.7);
  const plaza = plane(PLAZA.w, PLAZA.d, plazaMat, 0.004);
  const lotMat = new THREE.MeshStandardMaterial({
    map: await tile('asphalt', 'asphalt', LOT.w, LOT.d, true),
    normalMap: await tile('asphalt_n', 'asphalt', LOT.w, LOT.d, false),
    roughness: 0.95, metalness: 0,
  });
  lotMat.normalScale.set(0.5, 0.5);
  const lot = plane(LOT.w, LOT.d, lotMat, 0.003);
  lot.position.z = LOT.z;
  const pathMat = concreteMat();
  pathMat.map = await tile('concrete', 'concrete', PATH.w, PATH.d, true);
  pathMat.normalMap = await tile('concrete_n', 'concrete', PATH.w, PATH.d, false);
  pathMat.normalScale.set(0.7, 0.7);
  const path = plane(PATH.w, PATH.d, pathMat, 0.0035);
  path.position.z = PATH.z;
  group.add(meadow, plaza, lot, path);

  // ── models ────────────────────────────────────────────────────────────────
  const names = [...new Set(LAYOUT.map(p => p[0]))];
  const base = {};
  for (const n of names) {
    onProgress?.(`park: ${n}`);
    base[n] = (await loader.loadAsync(M + n + '.glb')).scene;
  }
  const variants = {};
  for (const p of LAYOUT) {
    if (p[0] !== 'ramp' || !p[5] || variants[p[5]]) continue;
    const t = await texLoader.loadAsync(`${M}ramp_tex/v${p[5]}.webp`);
    t.flipY = false;                            // glTF UV convention
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    variants[p[5]] = t;
  }

  const box = new THREE.Box3();
  const props = [];
  const footprints = [];
  for (const [name, x, z, rotDeg, scale, variant] of LAYOUT) {
    const obj = base[name].clone();
    obj.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      if (variant && variants[variant]) {
        o.material = o.material.clone();        // shared mesh, own texture
        o.material.map = variants[variant];
        o.material.needsUpdate = true;
      }
    });
    obj.scale.setScalar(scale);
    obj.rotation.y = THREE.MathUtils.degToRad(rotDeg);
    obj.updateMatrixWorld(true);
    box.setFromObject(obj);                     // sit on the ground
    obj.position.set(x, -box.min.y, z);
    obj.updateMatrixWorld(true);
    box.setFromObject(obj);
    footprints.push({ x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2, w: box.max.x - box.min.x, d: box.max.z - box.min.z });
    obj.userData.park = { name, variant: variant || null };
    group.add(obj);
    props.push(obj);
  }

  // ── grass cards on the meadow ─────────────────────────────────────────────
  onProgress?.('park: grass');
  const exclude = (x, z) =>
    inRect(PLAZA, x, z, -0.4) || inRect(LOT, x, z, -0.3) || inRect(PATH, x, z, -0.2) ||
    footprints.some(f => inRect(f, x, z, 0.3));
  const grass = await buildGrass({ renderer, exclude, radius: 95 });
  group.add(grass.group);

  scene.add(group);
  return { group, props, base, update: (dt) => grass.update(dt) };
}
