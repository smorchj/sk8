// park.js — the rural "Skate Barn" park (owner's reference render, 2026-09-02):
// a raised concrete pad with a staircase down to the street slab, a grass
// bank between the levels, an asphalt lot behind, and the owner's Meshy props
// placed around it. Ground = js/terrain.js (one mesh, blended shader), grass
// cards = js/grass.js, collision = js/collide.js (every mesh, BVH).
//
// The layout is DATA (owner, 2026-09-02: "let me create the map, let me place
// every asset"): a list of placements, editable in-game (js/editor.js),
// saved in localStorage 'sk8layout', with DEFAULT_LAYOUT as the fallback.
//
// Quarter pipes never collide with their bumpy Meshy shell: each gets a smooth
// collider swept from the model's sampled profile, and the end panel toward a
// touching neighbour is omitted so rows of ramps read as one surface.

import * as THREE from 'three';
import { buildGrass } from './grass.js';
import { CollisionWorld } from './collide.js';
import { makeTerrain, makeStairs, heightAt, pavedMask, TILE } from './terrain.js';

const T = 'assets/park/textures/';
const M = 'assets/park/';
export const LAYOUT_KEY = 'sk8layout';

// models the editor can place: default scale, sink, whether it is a
// quarter pipe (profile collider + variants)
export const MODELS = {
  ramp: { label: 'quarter pipe', scale: 2.6, variants: 7, qp: true },
  ramp2: { label: 'halfpipe', scale: 6.0 },
  ramp_haven: { label: 'concrete hip', scale: 5.0, sink: 0.28 },
  grind_rail: { label: 'rail', scale: 1.4 },
  curve_bridge: { label: 'curve bridge', scale: 3.0 },
  picnic_table: { label: 'picnic table', scale: 1.0 },
};

// the quarter-pipe model's transition faces its local +X (height-probed);
// rotY 90 turns it to face −Z. {model, x, z, rot(deg), scale, variant, sink}
export const DEFAULT_LAYOUT = [
  // two rows of three behind the pad, facing it; two of two on the sides
  ...[-10.4, -7.8, -5.2].map((x, i) => ({ model: 'ramp', x, z: 17.5, rot: 90, scale: 2.6, variant: i + 1 })),
  ...[5.2, 7.8, 10.4].map((x, i) => ({ model: 'ramp', x, z: 17.5, rot: 90, scale: 2.6, variant: i + 4 })),
  ...[6.7, 9.3].map((z, i) => ({ model: 'ramp', x: -19.5, z, rot: 0, scale: 2.6, variant: [7, 2][i] })),
  ...[6.7, 9.3].map((z, i) => ({ model: 'ramp', x: 19.5, z, rot: 180, scale: 2.6, variant: [3, 6][i] })),
  { model: 'ramp2', x: 32, z: 8, rot: 90, scale: 6.0 },
  { model: 'ramp_haven', x: 0, z: -27, rot: 0, scale: 5.0, sink: 0.28 },
  { model: 'grind_rail', x: 7, z: -14, rot: 0, scale: 1.4 },
  { model: 'curve_bridge', x: -9, z: -21, rot: 0, scale: 3.0 },
  { model: 'picnic_table', x: -27, z: 10, rot: 30, scale: 1.0 },
];

// grindable edges per model, in the model's local space (probed on the
// meshes). Copings are deliberately NOT here (owner: lip tricks come from
// animation).
const EDGES = {
  grind_rail: [[[-0.86, 0.154, 0], [0.86, 0.154, 0], 'rail']],
  ramp_haven: [
    [[-0.55, -0.06, 0.41], [0.55, -0.06, 0.41], 'ledge'],    // front ledge
    [[-0.3, 0.10, 0.17], [0.3, 0.10, 0.17], 'ledge'],        // the plateau's front edge
    [[-0.92, -0.059, -0.27], [-0.3, 0.241, -0.27], 'ledge'], // the back rim: slope, level, slope
    [[-0.3, 0.241, -0.27], [0.3, 0.241, -0.27], 'ledge'],
    [[0.3, 0.241, -0.27], [0.92, -0.059, -0.27], 'ledge'],
  ],
};
// the halfpipe is an open shell: seal boxes under its decks (local space)
const SEALS = {
  ramp2: [{ x: [-0.5, -0.34], y: [-0.2, 0.18], z: [-0.39, 0.39] }, { x: [0.34, 0.5], y: [-0.2, 0.18], z: [-0.39, 0.39] }],
};

export function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    if (saved && Array.isArray(saved.props) && saved.props.length) return saved.props;
  } catch { /* fall through */ }
  return DEFAULT_LAYOUT.map(p => ({ ...p }));
}
export function saveLayout(props) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, props }));
}

export async function buildPark({ scene, loader, renderer, onProgress }) {
  const group = new THREE.Group();
  group.name = 'park';
  const world = new CollisionWorld();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const texLoader = new THREE.TextureLoader();
  const tex = async (file, srgb) => {
    const t = await texLoader.loadAsync(T + file + '.jpg');
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
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

  // ── ground: one terrain mesh, two levels, blended shader; the stairs ──────
  onProgress?.('park: ground');
  const groundTex = {
    grass: await tex('grass', true), grassN: await tex('grass_soft_n', false),
    concrete: await tex('concrete', true), concreteN: await tex('concrete_n', false),
    asphalt: await tex('asphalt', true), asphaltN: await tex('asphalt_n', false),
  };
  const terrain = makeTerrain(groundTex);
  group.add(terrain);
  const stairMat = new THREE.MeshStandardMaterial({
    map: groundTex.concrete.clone(), normalMap: groundTex.concreteN.clone(), roughness: 0.9, metalness: 0, color: 0xc9c8c0,
  });
  stairMat.map.repeat.set(4.8 / TILE.concrete[0], 1.6 / TILE.concrete[1]);
  stairMat.normalMap.repeat.copy(stairMat.map.repeat);
  stairMat.map.needsUpdate = stairMat.normalMap.needsUpdate = true;
  const stairs = makeStairs(stairMat);
  group.add(stairs);
  scene.add(group);

  // ── models (all loaded once; instances are clones) ────────────────────────
  const base = {};
  for (const n of Object.keys(MODELS)) {
    onProgress?.(`park: ${n}`);
    base[n] = (await loader.loadAsync(M + n + '.glb')).scene;
    base[n].traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }
  const variants = {};
  for (let v = 1; v <= MODELS.ramp.variants; v++) {
    const t = await texLoader.loadAsync(`${M}ramp_tex/v${v}.webp`);
    t.flipY = false;                            // glTF UV convention
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    variants[v] = t;
  }

  // the quarter pipe's profile: heights along its local +X (front → back) at
  // its centre line, sampled once on the unscaled model
  const rampProfile = (() => {
    const ref = base.ramp.clone();
    ref.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const N = 48, prof = [];
    for (let i = 0; i <= N; i++) {
      const x = 0.5 - i / N;                                 // front (+X, low) → back (−X, deck)
      ray.set(new THREE.Vector3(x, 2, 0), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(ref, true)[0];
      prof.push({ x, y: hit ? hit.point.y : -0.29 });
    }
    return prof;
  })();

  const props = [];
  const edges = [];
  const sealMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });

  function applyVariant(obj, variant) {
    obj.traverse(o => {
      if (!o.isMesh || o.userData.collider === 'proxy') return;
      if (variant && variants[variant]) {
        if (!o.userData.ownMaterial) { o.material = o.material.clone(); o.userData.ownMaterial = true; }
        o.material.map = variants[variant];
        o.material.needsUpdate = true;
      }
    });
  }

  // place (or re-place) one prop from its placement record
  function placeProp(rec) {
    const spec = MODELS[rec.model];
    if (!spec || !base[rec.model]) return null;
    let obj = rec.obj;
    if (!obj) {
      obj = base[rec.model].clone();
      obj.traverse(o => { if (o.isMesh) o.userData.noCollide = spec.qp; });   // a QP's shell never collides
      obj.userData.park = rec;
      rec.obj = obj;
      group.add(obj);
      props.push(obj);
    }
    if (spec.qp) applyVariant(obj, rec.variant || 1);
    obj.scale.setScalar(rec.scale || spec.scale);
    obj.rotation.set(0, THREE.MathUtils.degToRad(rec.rot || 0), 0);
    obj.position.set(rec.x, 0, rec.z);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.y = heightAt(rec.x, rec.z) - box.min.y - 0.01 - (rec.sink ?? spec.sink ?? 0);
    obj.updateMatrixWorld(true);
    return obj;
  }

  function removeProp(obj) {
    const i = props.indexOf(obj);
    if (i >= 0) props.splice(i, 1);
    group.remove(obj);
  }

  // a quarter pipe's smooth collider in its own local space: the swept
  // profile, the back wall, and end panels only where no neighbour touches
  function rampProxy(obj) {
    const spec = MODELS.ramp;
    const s = obj.scale.x;
    const nb = { L: false, R: false };
    for (const o of props) {
      if (o === obj || o.userData.park.model !== 'ramp') continue;
      const dRot = Math.abs(((o.rotation.y - obj.rotation.y + Math.PI) % (2 * Math.PI)) - Math.PI);
      if (dRot > 0.09) continue;
      const l = obj.worldToLocal(o.position.clone());         // in units of this ramp
      if (Math.abs(l.x) < 0.15 && Math.abs(Math.abs(l.z) - 1) < 0.12) nb[l.z > 0 ? 'R' : 'L'] = true;
    }
    const pos = [], idx = [];
    const V = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
    const z0 = -0.5 - (nb.L ? 0.02 : 0), z1 = 0.5 + (nb.R ? 0.02 : 0);
    const ground = -0.31;
    let a = V(rampProfile[0].x, rampProfile[0].y, z0), b = V(rampProfile[0].x, rampProfile[0].y, z1);
    for (let i = 1; i < rampProfile.length; i++) {
      const p = rampProfile[i];
      const c = V(p.x, p.y, z0), d = V(p.x, p.y, z1);
      idx.push(a, c, b, b, c, d);
      a = c; b = d;
    }
    const back = rampProfile[rampProfile.length - 1];
    const ga = V(back.x, ground, z0), gb = V(back.x, ground, z1);
    idx.push(a, ga, b, b, ga, gb);                            // back wall
    for (const [side, z] of [['L', z0], ['R', z1]]) {
      if (nb[side]) continue;                                 // a neighbour: no panel, one surface
      const g0 = V(rampProfile[0].x, ground, z);
      let prev = V(rampProfile[0].x, rampProfile[0].y, z);
      for (let i = 1; i < rampProfile.length; i++) {
        const cur = V(rampProfile[i].x, rampProfile[i].y, z);
        idx.push(g0, prev, cur);
        prev = cur;
      }
      idx.push(g0, prev, V(back.x, ground, z));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, sealMat);
    mesh.userData.collider = 'proxy';
    mesh.name = 'qp collider';
    return mesh;
  }

  // (re)build every collider and every grind edge from the current props
  function rebuild() {
    world.clear();
    world.add(terrain, 'terrain');
    world.add(stairs, 'stairs');
    for (const p of props) {
      // drop old proxies/seals
      for (const c of [...p.children]) if (c.userData.collider === 'proxy') p.remove(c);
      const rec = p.userData.park;
      if (MODELS[rec.model].qp) p.add(rampProxy(p));
      for (const s of SEALS[rec.model] || []) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(s.x[1] - s.x[0], s.y[1] - s.y[0], s.z[1] - s.z[0]), sealMat);
        b.position.set((s.x[0] + s.x[1]) / 2, (s.y[0] + s.y[1]) / 2, (s.z[0] + s.z[1]) / 2);
        b.userData.collider = 'proxy';
        p.add(b);
      }
      p.updateWorldMatrix(true, true);
      world.add(p, rec.model);
    }
    edges.length = 0;
    for (const p of props) {
      for (const [la, lb, kind] of EDGES[p.userData.park.model] || []) {
        const a = p.localToWorld(new THREE.Vector3(...la));
        const b = p.localToWorld(new THREE.Vector3(...lb));
        const dir = b.clone().sub(a);
        const len = dir.length();
        dir.multiplyScalar(1 / len);
        let open = null;
        if (kind === 'ledge') {                 // which side is the drop? probe both
          const mid = a.clone().add(b).multiplyScalar(0.5);
          const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
          const hAt = (t) => {
            const h = world.cast(mid.clone().addScaledVector(perp, t).add(new THREE.Vector3(0, 3, 0)), new THREE.Vector3(0, -1, 0), 20);
            return h ? h.point.y : -999;
          };
          open = perp.clone().multiplyScalar(hAt(0.3) < hAt(-0.3) ? 1 : -1);
        }
        edges.push({ a, b, dir, len, kind, name: `${p.userData.park.model} ${kind}`, prop: p, open });
      }
    }
  }

  function setLayout(list) {
    for (const p of [...props]) removeProp(p);
    for (const rec of list) placeProp({ ...rec, obj: null });
    rebuild();
  }
  const getLayout = () => props.map(p => {
    const { obj, ...rec } = p.userData.park;
    return { ...rec };
  });

  onProgress?.('park: props');
  setLayout(loadLayout());

  // ── grass cards on the meadow (boot-time footprint exclusion) ─────────────
  onProgress?.('park: grass');
  const footprints = props.map(p => {
    const b = new THREE.Box3().setFromObject(p);
    return { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2, hw: (b.max.x - b.min.x) / 2, hd: (b.max.z - b.min.z) / 2 };
  });
  const exclude = (x, z) =>
    pavedMask(x, z) > 0.45 ||
    footprints.some(f => Math.abs(x - f.x) < f.hw + 0.3 && Math.abs(z - f.z) < f.hd + 0.3);
  const grass = await buildGrass({ renderer, exclude, heightAt, radius: 95 });
  group.add(grass.group);

  return {
    group, props, base, world, terrain, edges, variants,
    placeProp, removeProp, rebuild, setLayout, getLayout,
    update: (dt) => grass.update(dt),
  };
}
