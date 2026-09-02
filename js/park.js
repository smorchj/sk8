// park.js — the rural "Skate Barn" park (owner's reference render, 2026-09-02):
// a raised concrete pad with a staircase down to the street slab, a grass
// bank between the levels, an asphalt lot behind, and the owner's Meshy props
// placed around it. Ground = js/terrain.js (one mesh, blended shader), grass
// cards = js/grass.js, collision = js/collide.js (every mesh, BVH).
//
// The mini-ramp GLBs share one mesh: ramp.glb is loaded ONCE and each
// placement swaps the base-color map (ramp_tex/v1..7) on a cloned material.

import * as THREE from 'three';
import { buildGrass } from './grass.js';
import { CollisionWorld } from './collide.js';
import { makeTerrain, makeStairs, heightAt, pavedMask, TILE } from './terrain.js';

const T = 'assets/park/textures/';
const M = 'assets/park/';

// placements: [model, x, z, rotY(deg), scale, variant]
// (the quarter-pipe model's transition faces its local +X — measured with
// height probes, 2026-09-02; rotY 90 turns it to face −Z)
const LAYOUT = [
  // quarter pipes behind the pad, faces toward it (−Z)
  ['ramp', -13, 17.5, 90, 2.6, 1],
  ['ramp', -7, 17.5, 90, 2.6, 2],
  ['ramp', 7, 17.5, 90, 2.6, 3],
  ['ramp', 13, 17.5, 90, 2.6, 4],
  // quarter pipes on the pad's sides, facing in (+X on the left, −X on the right)
  ['ramp', -19.5, 4, 0, 2.6, 5],
  ['ramp', -19.5, 12, 0, 2.6, 6],
  ['ramp', 19.5, 4, 180, 2.6, 7],
  ['ramp', 19.5, 12, 180, 2.6, 2],
  // the halfpipe on the upper grass (owner: it was far too small)
  ['ramp2', 32, 8, 90, 6.0],
  // street level: the concrete hip, the rail, the curve bridge
  ['ramp_haven', 0, -27, 0, 4.0],
  ['grind_rail', 7, -14, 0, 1.8],
  ['curve_bridge', -9, -21, 0, 3.0],
  // the picnic table on the upper grass
  ['picnic_table', -27, 10, 30, 1.0],
];

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
    box.setFromObject(obj);                     // sit on the terrain
    obj.position.set(x, heightAt(x, z) - box.min.y - 0.01, z);
    obj.updateMatrixWorld(true);
    box.setFromObject(obj);
    footprints.push({ x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2, hw: (box.max.x - box.min.x) / 2, hd: (box.max.z - box.min.z) / 2 });
    obj.userData.park = { name, variant: variant || null };
    group.add(obj);
    props.push(obj);
  }

  // ── collision: terrain, stairs, every prop (mesh collision, BVH) ──────────
  // The Meshy ramps are OPEN SHELLS at the back (owner got stuck inside one):
  // seal them with invisible boxes under the decks so the backs are walls.
  const sealMat = new THREE.MeshBasicMaterial({ visible: false });
  const SEALS = {
    ramp: [{ x: [-0.5, -0.12], y: [-0.29, 0.27], z: [-0.5, 0.5] }],       // deck side is local −X
    ramp2: [{ x: [-0.5, -0.34], y: [-0.2, 0.18], z: [-0.39, 0.39] }, { x: [0.34, 0.5], y: [-0.2, 0.18], z: [-0.39, 0.39] }],
  };
  for (const p of props) {
    for (const s of SEALS[p.userData.park.name] || []) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(s.x[1] - s.x[0], s.y[1] - s.y[0], s.z[1] - s.z[0]), sealMat);
      b.position.set((s.x[0] + s.x[1]) / 2, (s.y[0] + s.y[1]) / 2, (s.z[0] + s.z[1]) / 2);
      b.name = 'seal';
      p.add(b);                                 // inherits the prop's scale/rotation
    }
  }
  onProgress?.('park: collision');
  scene.add(group);                             // world matrices need the scene
  group.updateWorldMatrix(true, true);
  world.add(terrain, 'terrain');
  world.add(stairs, 'stairs');
  for (const p of props) world.add(p, p.userData.park.name);

  // ── grass cards on the meadow ─────────────────────────────────────────────
  onProgress?.('park: grass');
  const exclude = (x, z) =>
    pavedMask(x, z) > 0.45 ||
    footprints.some(f => Math.abs(x - f.x) < f.hw + 0.3 && Math.abs(z - f.z) < f.hd + 0.3);
  const grass = await buildGrass({ renderer, exclude, heightAt, radius: 95 });
  group.add(grass.group);

  return { group, props, base, world, terrain, update: (dt) => grass.update(dt) };
}
