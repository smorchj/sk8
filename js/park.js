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
import { MeshBVH } from 'three-mesh-bvh';
import { makeTerrain, makeStairs, heightAt, pavedMask, TILE } from './terrain.js';
import { buildStairRails } from './rails.js';

const T = 'assets/park/textures/';
const M = 'assets/park/';
export const LAYOUT_KEY = 'sk8layout';

// models the editor can place: default scale, sink, whether it is a
// quarter pipe (profile collider + variants)
export const MODELS = {
  ramp: { label: 'quarter pipe', scale: 2.6, variants: 7, qp: true },
  ramp2: { label: 'halfpipe', scale: 6.0, pipe: true },      // profile collider too (see pipeProxy)
  ramp_haven: { label: 'concrete hip', scale: 5.0, sink: 0.28, field: true },
  grind_rail: { label: 'rail', scale: 1.4 },
  curve_bridge: { label: 'curve bridge', scale: 3.0 },
  picnic_table: { label: 'picnic table', scale: 1.0 },
  // owner's 2026-09-03 Meshy DIY spot: three grind tiers on a slab. It collides
  // as its OWN MESH — no box proxies, they never fit this shape and left the
  // board floating. SINK IS WORLD METRES and the editor does not rescale it, so
  // after resizing set sink = 0.072 * scale by hand (scale 4 -> 0.29,
  // scale 7 -> 0.50) or the slab stands proud.
  skate_ledge: { label: 'DIY ledge', scale: 4.0, sink: 0.28 },
  // the easter egg: gap over it between two quarter pipes and the music comes
  // on (js/boombox.js). Collides as its own mesh — you can clip it and it will
  // stop you, which is half the fun of aiming for it.
  boombox: { label: 'boombox', scale: 0.4 },
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
  { model: 'skate_ledge', x: -5, z: -14, rot: 0, scale: 4.0, sink: 0.28 },
  { model: 'boombox', x: 0, z: 17.5, rot: -90, scale: 0.4 },   // the gap between the two rows of quarter pipes
];

// grindable edges per model, in the model's local space (probed on the
// meshes). Copings are deliberately NOT here (owner: lip tricks come from
// animation).
// a polyline (curved tops) → consecutive ledge segments that share a CHAIN
// id: a grind flows from one to the next without leaving (the heading eases
// round the bend — owner: "the curved bench jagged grinds")
let chainSeq = 0;
const poly = (pts, chain = 'c' + (chainSeq++)) => pts.slice(1).map((p, i) => [pts[i], p, 'ledge', chain]);
// the curved bench's seat: its inner and outer top edges (local, probed on the
// mesh). Grindable both, and the SOLID the bench collides as is built from them
const BENCH_INNER = [
  [-0.904, 0.118, -0.628], [-0.545, 0.118, -0.491], [-0.27, 0.118, -0.351], [-0.041, 0.118, -0.205],
  [0.125, 0.118, -0.061], [0.243, 0.118, 0.082], [0.34, 0.118, 0.213], [0.447, 0.118, 0.401],
  [0.531, 0.118, 0.603], [0.611, 0.118, 0.856],
];
const BENCH_OUTER = [
  [-0.452, 0.118, -0.755], [-0.134, 0.118, -0.601], [0.145, 0.118, -0.441], [0.346, 0.118, -0.269],
  [0.492, 0.118, -0.109], [0.611, 0.118, 0.058], [0.727, 0.118, 0.261], [0.825, 0.118, 0.472],
  [0.922, 0.118, 0.731],
];
const EDGES = {
  grind_rail: [[[-0.86, 0.154, 0], [0.86, 0.154, 0], 'rail']],
  // the picnic table (owner: "two types of benches, none grindable"): both
  // bench seats' outer edges (0.36 m up) and both long edges of the table
  // top (0.64 m up) — probed 2026-09-02
  picnic_table: [
    [[-0.92, 0.0, -0.65], [0.92, 0.0, -0.65], 'ledge'],
    [[-0.92, 0.0, 0.65], [0.92, 0.0, 0.65], 'ledge'],
    [[-0.92, 0.28, -0.32], [0.92, 0.28, -0.32], 'ledge'],
    [[-0.92, 0.28, 0.32], [0.92, 0.28, 0.32], 'ledge'],
  ],
  // the curved bench (0.70 m up): grinds on its two OUTER edges, the middle
  // of the top rides (owner, 2026-09-03). Both corner lines traced on the
  // collision mesh 2026-09-03 (cross-scans at ten stations; the top is
  // ~0.9 m wide and the old centreline sat up to 0.12 m off it).
  curve_bridge: [...poly(BENCH_INNER), ...poly(BENCH_OUTER)],
  // the DIY spot is three tiers, each with a rusty grind strip along the edge
  // that faces the rider: the high concrete ledge, the low one, and the steel
  // bar on posts out front. Cross-sectioned on the mesh 2026-09-03 — the drops
  // sit at x -0.105, -0.019 and the bar's top runs x 0.153..0.173. All three
  // span z -0.43..0.18.
  // All three are 'ledge', including the bar: 'rail' makes the physics ignore
  // the WHOLE prop for a moment on dismount (physics.js, so you cannot land
  // inside a bar), which here would drop the rider through the concrete they
  // are standing on.
  skate_ledge: [
    [[-0.105, 0.0806, -0.43], [-0.105, 0.0806, 0.18], 'ledge'],   // high ledge
    [[-0.019, 0.0324, -0.43], [-0.019, 0.0324, 0.18], 'ledge'],   // low ledge
    [[0.163, 0.0514, -0.425], [0.163, 0.0514, 0.20], 'ledge'],    // the steel bar
  ],
  // (corners re-probed 2026-09-03 with the board's real contact geometry: the
  // rim's corner is at local z −0.278 and its bank crest is a straight line
  // that reaches the top at |x| 0.33, not 0.3 — the old line sagged 7 cm)
  ramp_haven: [
    [[-0.55, -0.062, 0.413], [0.55, -0.062, 0.413], 'ledge'],   // front ledge
    [[-0.3, 0.093, 0.163], [0.3, 0.093, 0.163], 'ledge'],       // the plateau's front edge
    [[-0.92, -0.059, -0.278], [-0.33, 0.241, -0.278], 'ledge', 'rim'], // the back rim: slope, level, slope
    [[-0.33, 0.241, -0.278], [0.33, 0.241, -0.278], 'ledge', 'rim'],
    [[0.33, 0.241, -0.278], [0.92, -0.059, -0.278], 'ledge', 'rim'],
  ],
};
// PROPS THAT COLLIDE AS SOLIDS (owner, 2026-09-03: "the other bench/table and
// the rail also need proxy collision"): boxes in the model's local space, y
// measured UP FROM THE MODEL'S FLOOR (the placement puts that floor on the
// ground). Probed on the meshes at scale 1. The visual mesh stops colliding;
// the grind edges are unchanged.
const SOLIDS = {
  picnic_table: [
    { x: [-0.95, 0.95], y: [0, 0.63], z: [-0.32, 0.32] },      // the table top, solid to the ground (fills the slot in the top)
    { x: [-0.95, 0.95], y: [0, 0.36], z: [0.38, 0.63] },       // the two bench seats
    { x: [-0.95, 0.95], y: [0, 0.36], z: [-0.63, -0.38] },
  ],
  grind_rail: [
    { x: [-0.95, 0.95], y: [0.24, 0.30], z: [-0.03, 0.03] },   // the bar (top = the edge height, 0.154 local + floor)
    { x: [-0.95, 0.95], y: [0, 0.08], z: [-0.07, 0.07] },      // the base strip along its length (a curb)
    { x: [-0.88, -0.82], y: [0, 0.24], z: [-0.03, 0.03] },     // the posts
    { x: [0.82, 0.88], y: [0, 0.24], z: [-0.03, 0.03] },
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
  // keep the previous layout as a one-step undo (owner, 2026-09-03: a test
  // overwrote the whole map) — SK8.park.setLayout(JSON.parse(localStorage['sk8layout.prev']).props)
  const prev = localStorage.getItem(LAYOUT_KEY);
  if (prev) localStorage.setItem(LAYOUT_KEY + '.prev', prev);
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
    // the owner's height map and the normal baked from it — both register
    // pixel for pixel with concrete.jpg (tools/park-height.mjs)
    concreteH: await tex('concrete_h', false), concreteHN: await tex('concrete_hn', false),
    asphalt: await tex('asphalt', true), asphaltN: await tex('asphalt_n', false),
  };
  const terrain = makeTerrain(groundTex);
  group.add(terrain);
  const stairMat = new THREE.MeshStandardMaterial({
    map: groundTex.concrete.clone(), normalMap: groundTex.concreteHN.clone(), roughness: 0.9, metalness: 0, color: 0xc9c8c0,
  });
  stairMat.map.repeat.set(4.8 / TILE.concrete[0], 1.6 / TILE.concrete[1]);
  stairMat.normalMap.repeat.copy(stairMat.map.repeat);
  stairMat.map.needsUpdate = stairMat.normalMap.needsUpdate = true;
  const stairs = makeStairs(stairMat);
  group.add(stairs);
  const stairRails = buildStairRails();                     // handrails down the stairs (spline tubes, grindable)
  group.add(stairRails.group);
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

  // the halfpipe's profile: heights along its local X (deck, transition, flat,
  // transition, deck) sampled once on the unscaled model. Its visual mesh —
  // the frame, the railings, the ground slab — never collides (owner,
  // 2026-09-03: the rider rode its braces sideways and launched off facets).
  // Measured on the model: the flat/transitions are 0.30 half-wide, the
  // decks 0.383 from |x| 0.34 out to the ends at |x| 0.5; the slab bottom
  // is at y −0.394.
  const PIPE = { halfW: 0.30, deckHalfW: 0.383, deckFrom: 0.34, ground: -0.4 };
  const pipeProfile = (() => {
    const ref = base.ramp2.clone();
    ref.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    // the ridden surface only: transition → its top plateau (the coping) on
    // each side. The model's 0.7 m step up to the raised decks is NOT part
    // of the strip — riding into a vertical strip quad lifted the rider onto
    // the deck (owner: "it would self-adjust at the top"); the decks are the
    // seal boxes' tops, their fronts the wall above the plateau
    const N = 100, prof = [];
    for (let i = 0; i <= N; i++) {
      const x = -0.335 + 0.67 * i / N;
      ray.set(new THREE.Vector3(x, 2, 0), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(ref, true)[0];
      if (hit) prof.push({ x, y: hit.point.y });
    }
    return prof;
  })();

  const props = [];
  const edges = [];
  const transitions = [];                                   // {a, b, out, prop}: coping lines for the gap-transfer assist
  const sealMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  const panelMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.FrontSide });

  // the halfpipe's collider in its local space: the swept profile (double-
  // sided: rideable from above, solid from below), back walls under both
  // deck edges, and one-sided end panels facing outward along both sides —
  // built exactly under the profile, so nothing invisible hangs over the flat
  function pipeProxy() {
    const P = pipeProfile;
    const hw = (x) => Math.abs(x) >= PIPE.deckFrom ? PIPE.deckHalfW : PIPE.halfW;
    const hwWall = hw;
    const ground = PIPE.ground;
    const pos = [], idx = [];
    const V = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
    // (the profile runs −X → +X, the opposite way to the quarter pipe's, so
    // the quads are wound the other way round to keep the normals UP — a
    // downward normal reads as a backface = "inside", and froze the rider)
    let a = V(P[0].x, P[0].y, -hw(P[0].x)), b = V(P[0].x, P[0].y, hw(P[0].x));
    for (let i = 1; i < P.length; i++) {
      const w = hw(P[i].x);
      const c = V(P[i].x, P[i].y, -w), d = V(P[i].x, P[i].y, w);
      idx.push(a, b, c, c, b, d);
      a = c; b = d;
    }
    // back walls under both deck edges, normals facing OUT of the pipe
    for (const [p, outward] of [[P[0], -1], [P[P.length - 1], 1]]) {
      const w = hw(p.x);
      const t0 = V(p.x, p.y, -w), t1 = V(p.x, p.y, w), g0 = V(p.x, ground, -w), g1 = V(p.x, ground, w);
      if (outward < 0) idx.push(t0, g0, t1, t1, g0, g1); else idx.push(t0, t1, g0, g0, t1, g1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, sealMat);
    mesh.userData.collider = 'proxy'; mesh.userData.proxy = true;
    mesh.name = 'halfpipe collider';
    const ppos = [], pidx = [];
    const PV = (x, y, z) => { ppos.push(x, y, z); return ppos.length / 3 - 1; };
    const tri = (i0, i1, i2, outward) => {
      const p = (k) => new THREE.Vector3(ppos[k * 3], ppos[k * 3 + 1], ppos[k * 3 + 2]);
      const n = new THREE.Vector3().subVectors(p(i1), p(i0)).cross(new THREE.Vector3().subVectors(p(i2), p(i0)));
      if (n.z * outward < 0) pidx.push(i0, i2, i1); else pidx.push(i0, i1, i2);
    };
    for (const outward of [-1, 1]) {
      for (let i = 1; i < P.length; i++) {
        const z0 = outward * hwWall(P[i - 1].x), z1 = outward * hwWall(P[i].x);
        const a0 = PV(P[i - 1].x, ground, z0), a1 = PV(P[i - 1].x, P[i - 1].y, z0);
        const b1 = PV(P[i].x, P[i].y, z1), b0 = PV(P[i].x, ground, z1);
        tri(a0, a1, b1, outward);
        tri(a0, b1, b0, outward);
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(ppos, 3));
    pg.setIndex(pidx);
    pg.computeVertexNormals();
    const panels = new THREE.Mesh(pg, panelMat);
    panels.userData.collider = 'proxy'; panels.userData.proxy = true;
    panels.userData.panel = true;
    panels.name = 'halfpipe end panels';
    mesh.add(panels);
    return mesh;
  }

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

  // the unscaled models' lowest point: a prop stands on the ground by THIS,
  // never by a bounding box of the placed object — that box grows once the
  // rebuild hangs collision proxies/seals under it, and every later
  // re-placement (a drag, a sink step) would lift the prop by their depth
  const baseMinY = {};
  for (const [name, m] of Object.entries(base)) baseMinY[name] = new THREE.Box3().setFromObject(m).min.y;

  // place (or re-place) one prop from its placement record
  function placeProp(rec) {
    const spec = MODELS[rec.model];
    if (!spec || !base[rec.model]) return null;
    let obj = rec.obj;
    if (!obj) {
      obj = base[rec.model].clone();
      obj.traverse(o => { if (o.isMesh) o.userData.noCollide = !!(spec.qp || spec.pipe); });   // a QP's / the halfpipe's shell never collides: their profile proxies do
      obj.userData.park = rec;
      rec.obj = obj;
      group.add(obj);
      props.push(obj);
    }
    if (spec.qp) applyVariant(obj, rec.variant || 1);
    const scale = rec.scale || spec.scale;
    obj.scale.setScalar(scale);
    obj.rotation.set(0, THREE.MathUtils.degToRad(rec.rot || 0), 0);
    obj.position.set(rec.x, heightAt(rec.x, rec.z) - baseMinY[rec.model] * scale - 0.01 - (rec.sink ?? spec.sink ?? 0), rec.z);
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
    // a side is "covered" when another quarter pipe's body stands just
    // outside it — at ANY angle (owner's rows fan out 30° between ramps;
    // the old rule wanted the same heading within 5° and a flush fit, so an
    // end panel stood between two faces as an invisible wall). Sample points
    // a hand outside the panel along the profile; if most of them lie inside
    // a neighbour's volume, the neighbour's face continues ours: no panel.
    const nb = { L: false, R: false };
    const others = props.filter(o => o !== obj && o.userData.park.model === 'ramp');
    const footX = rampProfile[0].x, backX = rampProfile[rampProfile.length - 1].x;
    const yAt = (x) => {                                       // profile height at a local x
      let best = rampProfile[0];
      for (const q of rampProfile) if (Math.abs(q.x - x) < Math.abs(best.x - x)) best = q;
      return best.y;
    };
    const _w = new THREE.Vector3();
    for (const [side, zs] of [['L', -0.5], ['R', 0.5]]) {
      let inside = 0, n = 0;
      for (let k = 0; k < 6; k++) {
        const t = k / 5, x = footX + (backX - footX) * t;
        _w.set(x, Math.min(yAt(x), 0.3) - 0.05, zs + Math.sign(zs) * 0.12);  // just outside, just under the lip
        obj.localToWorld(_w);
        n++;
        for (const o of others) {
          const l = o.worldToLocal(_w.clone());
          const lo = Math.min(footX, backX), hi = Math.max(footX, backX);
          if (Math.abs(l.z) <= 0.55 && l.x >= lo - 0.05 && l.x <= hi + 0.05 && l.y <= yAt(l.x) + 0.1 && l.y >= -0.4) { inside++; break; }
        }
      }
      if (inside >= 4) nb[side] = true;
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
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, sealMat);
    mesh.userData.collider = 'proxy'; mesh.userData.proxy = true;
    mesh.name = 'qp collider';
    // end panels: ONE-SIDED, facing outward — they stop a rider coming at the
    // ramp's side from the ground, but never hold a rider in from inside
    // (owner: "driving off the side of the ramp sometimes blocks the rider")
    const ppos = [], pidx = [];
    const PV = (x, y, z) => { ppos.push(x, y, z); return ppos.length / 3 - 1; };
    const tri = (i0, i1, i2, outward) => {
      // wind so the face normal points outward (along ±Z local)
      const p = (k) => new THREE.Vector3(ppos[k * 3], ppos[k * 3 + 1], ppos[k * 3 + 2]);
      const n = new THREE.Vector3().subVectors(p(i1), p(i0)).cross(new THREE.Vector3().subVectors(p(i2), p(i0)));
      if (n.z * outward < 0) pidx.push(i0, i2, i1); else pidx.push(i0, i1, i2);
    };
    for (const [side, z, outward] of [['L', z0, -1], ['R', z1, 1]]) {
      if (nb[side]) continue;                                 // a neighbour: no panel, one surface
      const g0 = PV(rampProfile[0].x, ground, z);
      let prev = PV(rampProfile[0].x, rampProfile[0].y, z);
      for (let i = 1; i < rampProfile.length; i++) {
        const cur = PV(rampProfile[i].x, rampProfile[i].y, z);
        tri(g0, prev, cur, outward);
        prev = cur;
      }
      tri(g0, prev, PV(back.x, ground, z), outward);
    }
    if (pidx.length) {
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(ppos, 3));
      pg.setIndex(pidx);
      pg.computeVertexNormals();
      const panels = new THREE.Mesh(pg, panelMat);
      panels.userData.collider = 'proxy'; panels.userData.proxy = true;
      panels.userData.panel = true;                             // the physics snaps an air that hits this onto the ramp
      panels.name = 'qp end panels';
      mesh.add(panels);
    }
    return mesh;
  }

  // THE CURVED BENCH COLLIDES AS A SOLID (owner, 2026-09-03: "you need a
  // proper collision — problem with using the mesh as collision"): its mesh
  // is a comb of slats, legs and slat ends at every angle, and the wall
  // probes carved the speed away face by face, or read a mis-wound face from
  // behind and let the rider through the seat. The solid: the ring between
  // the seat's inner and outer top edges, extruded from the model's floor to
  // the seat top, closed, wound outward. Rideable on top, clean walls on the
  // sides, the edges still grind. The visual mesh no longer collides.
  function benchProxy(minY) {
    const N = 14;
    const resample = (pts) => {
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
      const L = cum[cum.length - 1], out = [];
      for (let k = 0; k < N; k++) {
        const t = L * k / (N - 1);
        let i = 1; while (i < cum.length - 1 && cum[i] < t) i++;
        const f = (t - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
        out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * f]);
      }
      return out;
    };
    const I = resample(BENCH_INNER), O = resample(BENCH_OUTER);
    const top = BENCH_INNER[0][1], bot = minY - 0.02;
    const pos = [], idx = [];
    const V = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
    const It = I.map(q => V(q[0], top, q[1])), Ot = O.map(q => V(q[0], top, q[1]));
    const Ib = I.map(q => V(q[0], bot, q[1])), Ob = O.map(q => V(q[0], bot, q[1]));
    const P = (k) => new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
    // a quad wound so its normal agrees with `want`
    const quad = (a, b, c, d, want) => {
      const n = new THREE.Vector3().subVectors(P(b), P(a)).cross(new THREE.Vector3().subVectors(P(c), P(a)));
      if (n.dot(want) < 0) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
    };
    const UP = new THREE.Vector3(0, 1, 0), DN = new THREE.Vector3(0, -1, 0);
    for (let k = 0; k < N - 1; k++) {
      const out = new THREE.Vector3(O[k][0] - I[k][0], 0, O[k][1] - I[k][1]);
      quad(It[k], Ot[k], Ot[k + 1], It[k + 1], UP);                       // seat top
      quad(Ib[k], Ob[k], Ob[k + 1], Ib[k + 1], DN);                       // underside
      quad(Ot[k], Ot[k + 1], Ob[k + 1], Ob[k], out);                      // outer wall
      quad(It[k], It[k + 1], Ib[k + 1], Ib[k], out.clone().negate());     // inner wall
    }
    const tan0 = new THREE.Vector3(I[0][0] - I[1][0], 0, I[0][1] - I[1][1]);
    const tan1 = new THREE.Vector3(I[N - 1][0] - I[N - 2][0], 0, I[N - 1][1] - I[N - 2][1]);
    quad(It[0], Ot[0], Ob[0], Ib[0], tan0);                                // the two ends
    quad(It[N - 1], Ot[N - 1], Ob[N - 1], Ib[N - 1], tan1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, sealMat);
    mesh.userData.collider = 'proxy'; mesh.userData.proxy = true;
    mesh.name = 'bench collider';
    return mesh;
  }

  // THE HIP COLLIDES AS A HEIGHT FIELD (owner, 2026-09-03: "do the hip as
  // well"): its top surface sampled on the model every 2 cm (10 cm at the
  // placed scale) and rebuilt as a clean grid — the banks, the plateau, the
  // front ledge, the sides as steep facets down to the floor. No Meshy seams
  // or thin faces. Its grind edges were probed on the mesh and match this
  // within a sample. Built once, shared by every placed hip.
  // a prop whose shape is past boxes collides as a HEIGHT FIELD sampled off
  // its own model (the hip)
  const fieldGeo = {};
  function fieldProxy(name) {
    if (!fieldGeo[name]) {
      const src = base[name];
      src.updateWorldMatrix(true, true);
      src.traverse(o => { if (o.isMesh && o.geometry && !o.geometry.boundsTree) o.geometry.boundsTree = new MeshBVH(o.geometry); });
      const bb = new THREE.Box3().setFromObject(src);
      const step = 0.02, floor = bb.min.y - 0.02;
      const nx = Math.ceil((bb.max.x - bb.min.x) / step) + 3, nz = Math.ceil((bb.max.z - bb.min.z) / step) + 3;
      const x0 = bb.min.x - step, z0 = bb.min.z - step;
      const ray = new THREE.Raycaster();
      ray.firstHitOnly = true;
      const from = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
      const pos = [];
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const x = x0 + i * step, z = z0 + j * step;
        ray.set(from.set(x, bb.max.y + 1, z), down);
        const h = ray.intersectObject(src, true)[0];
        pos.push(x, h ? h.point.y : floor, z);
      }
      const idx = [];
      for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx.push(a, c, b, b, c, d);                          // wound for +Y normals
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      fieldGeo[name] = g;
      console.log(`[park] ${name} field collider: ${nx}x${nz} samples, ${idx.length / 3} tris`);
    }
    const m = new THREE.Mesh(fieldGeo[name], sealMat);
    m.userData.collider = 'proxy'; m.userData.proxy = true;
    m.name = name + ' field collider';
    return m;
  }

  // (re)build every collider and every grind edge from the current props
  function rebuild() {
    world.clear();
    world.add(terrain, 'terrain');
    world.add(stairs, 'stairs');
    world.add(stairRails.group, 'stair_rail');
    for (const p of props) {
      // drop old proxies/seals
      // (by the flag: world.add renames a proxy's collider tag to the prop's
      // model, so the old test missed them and every rebuild stacked another)
      for (const c of [...p.children]) if (c.userData.proxy) p.remove(c);
      const rec = p.userData.park;
      if (MODELS[rec.model].qp) {
        const proxy = rampProxy(p);
        // the direction OUT of the face (toward whoever rides in): the pop
        // logic launches vert along it even at the ramp's nearly flat foot
        proxy.userData.faceWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(p.quaternion);
        p.add(proxy);
      } else if (MODELS[rec.model].pipe) {
        p.add(pipeProxy());
      } else if (rec.model === 'curve_bridge') {
        p.traverse(o => { if (o.isMesh && !o.userData.proxy) o.userData.noCollide = true; });
        p.add(benchProxy(baseMinY.curve_bridge));
      }
      if (MODELS[rec.model].field) {
        p.traverse(o => { if (o.isMesh && !o.userData.proxy) o.userData.noCollide = true; });
        p.add(fieldProxy(rec.model));
      }
      if (SOLIDS[rec.model]) {
        p.traverse(o => { if (o.isMesh && !o.userData.proxy) o.userData.noCollide = true; });
        // the 1 cm lift matches placeProp's 1 cm drop, so a solid's floor lands
        // exactly on the ground — but it is a LOCAL offset under a scaled prop, so
        // it has to be divided by the scale or a big prop floats (the 4x ledge sat
        // 3 cm high)
        const floor = baseMinY[rec.model] + 0.01 / (rec.scale || MODELS[rec.model].scale);
        for (const b of SOLIDS[rec.model]) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(b.x[1] - b.x[0], b.y[1] - b.y[0], b.z[1] - b.z[0]), sealMat);
          m.position.set((b.x[0] + b.x[1]) / 2, floor + (b.y[0] + b.y[1]) / 2, (b.z[0] + b.z[1]) / 2);
          m.userData.collider = 'proxy'; m.userData.proxy = true;
          m.name = rec.model + ' solid';
          p.add(m);
        }
      }
      for (const s of SEALS[rec.model] || []) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(s.x[1] - s.x[0], s.y[1] - s.y[0], s.z[1] - s.z[0]), sealMat);
        b.position.set((s.x[0] + s.x[1]) / 2, (s.y[0] + s.y[1]) / 2, (s.z[0] + s.z[1]) / 2);
        b.userData.collider = 'proxy'; b.userData.proxy = true;
        p.add(b);
      }
      p.updateWorldMatrix(true, true);
      world.add(p, rec.model);
    }
    // the transitions' coping lines (world), for the physics' gap transfers
    transitions.length = 0;
    for (const p of props) {
      const spec = MODELS[p.userData.park.model];
      if (spec.qp) {
        const maxY = Math.max(...rampProfile.map(q => q.y));
        const cop = rampProfile.find(q => q.y >= maxY - 0.01);          // the first top-height sample from the front
        transitions.push({
          a: p.localToWorld(new THREE.Vector3(cop.x, cop.y, -0.5)),
          b: p.localToWorld(new THREE.Vector3(cop.x, cop.y, 0.5)),
          out: new THREE.Vector3(1, 0, 0).applyQuaternion(p.quaternion).setY(0).normalize(),
          prop: p,
        });
      } else if (spec.pipe) {
        for (const sgn of [-1, 1]) {                                    // both transitions of the halfpipe
          const side = pipeProfile.filter(q => sgn * q.x > 0.15 && Math.abs(q.x) < PIPE.deckFrom);
          if (!side.length) continue;
          const top = Math.max(...side.map(q => q.y));
          const ordered = sgn > 0 ? side : side.slice().reverse();      // from the flat outward
          const cop = ordered.find(q => q.y >= top - 0.005);
          transitions.push({
            a: p.localToWorld(new THREE.Vector3(cop.x, cop.y, -PIPE.halfW)),
            b: p.localToWorld(new THREE.Vector3(cop.x, cop.y, PIPE.halfW)),
            out: new THREE.Vector3(-sgn, 0, 0).applyQuaternion(p.quaternion).setY(0).normalize(),
            prop: p,
          });
        }
      }
    }
    edges.length = 0;
    for (const p of props) {
      const mine = [];
      for (const [la, lb, kind, chain = null] of EDGES[p.userData.park.model] || []) {
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
        const e = { a, b, dir, len, kind, name: `${p.userData.park.model} ${kind}`, prop: p, open, chain, next: null, prev: null };
        mine.push(e);
        edges.push(e);
      }
      // link chained segments end to start
      for (const e of mine) {
        if (!e.chain) continue;
        for (const f of mine) {
          if (f === e || f.chain !== e.chain) continue;
          if (f.a.distanceTo(e.b) < 1e-3) { e.next = f; f.prev = e; }
        }
      }
    }
    edges.push(...stairRails.edges);                        // the handrails (already chained)
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
    group, props, base, world, terrain, edges, transitions, variants,
    ground: terrain.material.userData.ground,        // SK8.park.ground.set({ depth, fillEdge, … })
    placeProp, removeProp, rebuild, setLayout, getLayout,
    update: (dt) => grass.update(dt),
  };
}
