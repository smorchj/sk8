// main.js — boot: scene, assets, physics root, loop.
//
// Scene graph law (CLAUDE.md): playerRoot is the physics ground frame
// (board contact + nose yaw). Board and character live under it and are
// driven in its local space by the anim controller. Hips is never the root.
//
// The rider comes ONLY from the creategamecharacters.ai project ("sk8opia farm
// demo") via the embedded SDK — basemesh + project outfits, spawned from the
// player's saved recipe. No fallbacks: if the SDK fails, the error is shown.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { Rig } from './rig.js';
import { buildSkeletonInfo, loadClips } from './clips.js';
import { SkatePhysics } from './physics.js';
import { Input } from './input.js';
import { SkateAnim } from './anim.js';
import { RiderCreator } from './creator.js';

const BOARD_GLB = 'assets/skateboard.glb';
const NOSE_FLIP = true;   // skateboard.glb visual nose is on -Z; game nose = +Z

const loadmsg = (s) => { const el = document.getElementById('loadmsg'); if (el) el.textContent = s; };

// ── renderer / scene ────────────────────────────────────────────────────────

const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87a6c4);           // placeholder sky
scene.fog = new THREE.Fog(0x87a6c4, 60, 160);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.05, 400);
camera.position.set(0, 1.8, -4);

const hemi = new THREE.HemisphereLight(0xdfeaff, 0x3c4436, 0.7);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
sun.position.set(18, 26, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 80;
const SS = 14;
sun.shadow.camera.left = -SS; sun.shadow.camera.right = SS;
sun.shadow.camera.top = SS; sun.shadow.camera.bottom = -SS;
sun.shadow.bias = -0.0015;
scene.add(sun);
scene.add(sun.target);

// ground — flat asphalt-ish plane for physics work; the farm comes later
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x6d6f6a, roughness: 0.96, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(400, 200, 0x8a8d86, 0x7c7f78);
grid.position.y = 0.002;
grid.material.opacity = 0.35; grid.material.transparent = true;
scene.add(grid);
for (let i = -10; i <= 10; i++) {
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12, 400),
    new THREE.MeshStandardMaterial({ color: 0xb8bbb2, roughness: 1 }),
  );
  line.rotation.x = -Math.PI / 2;
  line.position.set(i * 8, 0.004, 0);
  scene.add(line);
}

function resize(w, h) {
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
new ResizeObserver(es => resize(es[0].contentRect.width, es[0].contentRect.height)).observe(viewport);
resize(viewport.clientWidth, viewport.clientHeight);

// ── loaders ─────────────────────────────────────────────────────────────────

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const ktx2 = new KTX2Loader()
  .setTranscoderPath('https://unpkg.com/three@0.170.0/examples/jsm/libs/basis/')   // per sdk.md
  .detectSupport(renderer);
loader.setKTX2Loader(ktx2);

// ── player root + board ─────────────────────────────────────────────────────

const playerRoot = new THREE.Group();
scene.add(playerRoot);

loadmsg('skateboard…');
const boardGltf = await loader.loadAsync(BOARD_GLB);
const boardNode = new THREE.Group();
const boardMesh = boardGltf.scene;
boardMesh.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
if (NOSE_FLIP) boardMesh.rotation.y = Math.PI;
boardNode.add(boardMesh);
boardNode.position.y = 0.07;
playerRoot.add(boardNode);

// ── character management ────────────────────────────────────────────────────

let charScene = null;        // current rider Object3D (always an SDK spawn)
let rig = null;
let skel = null;
let clips = null;

// The SDK character is the SDK's: no mesh deletion, no material/shadow
// stomping, no manual bone resets (owner, 2026-09-01 — the documented pipe
// only). Rest pose comes from the documented c.toRest().

// verification markers (SKATE.md protocol) — RED = FootL, GREEN = FootR,
// BLUE ARROW = board nose. Rebuilt on every character swap.
const markerState = { visible: false, feet: [], skel: null, nose: null };
{
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 10),
    new THREE.MeshBasicMaterial({ color: 0x2266ff, depthTest: false, transparent: true, opacity: 0.95 }));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.06, 0.52);
  nose.renderOrder = 999;
  nose.visible = false;
  boardNode.add(nose);
  markerState.nose = nose;
}
function attachMarkers() {
  for (const f of markerState.feet) f.parent?.remove(f);
  markerState.feet = [];
  if (markerState.skel) { scene.remove(markerState.skel); markerState.skel = null; }
  const mk = (color) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
    m.renderOrder = 999;
    return m;
  };
  const fl = mk(0xff2244), fr = mk(0x22ff44);
  rig.bones.get('FootL')?.add(fl);
  rig.bones.get('FootR')?.add(fr);
  markerState.feet = [fl, fr];
  markerState.skel = new THREE.SkeletonHelper(charScene);
  scene.add(markerState.skel);
  setMarkers(markerState.visible);
}
function setMarkers(v) {
  markerState.visible = v;
  for (const f of markerState.feet) f.visible = v;
  if (markerState.skel) markerState.skel.visible = v;
  markerState.nose.visible = v;
}
addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'b') setMarkers(!markerState.visible);
});

// swap the active rider (initial spawn AND creator swaps go through here)
let charCtrl = null;         // the SDK character controller (spawn handle)
async function setCharacter(obj, ctrl) {
  if (charScene && charScene !== obj) playerRoot.remove(charScene);
  charScene = obj;
  charCtrl = ctrl || charCtrl;
  if (obj.parent !== playerRoot) playerRoot.add(obj);
  charCtrl?.toRest?.();                       // documented rest, then capture bind
  obj.updateWorldMatrix(true, true);
  rig = new Rig(obj);
  skel = buildSkeletonInfo(obj);
  if (!clips) {
    loadmsg?.('trick clips…');
    clips = await loadClips(skel, loadmsg);
    console.log('[sk8] clip stances:',
      Object.entries(clips).map(([k, c]) =>
        `${k}: ${c.stance} (margin ${c.stanceMargin.toFixed(2)}m, raw nose ${c.noseSignRaw > 0 ? '+Z' : '-Z'} → normalized +Z)`).join('\n  '));
  } else {
    for (const c of Object.values(clips)) c.rebake(skel);
  }
  if (anim) { anim.rig = rig; anim.skel = skel; }
  attachMarkers();
}

// ── spawn the rider: SDK project character first, local GLB as fallback ─────

let stance = localStorage.sk8stance || 'regular';
let anim = null;

// per-trick skill levels (1..5): higher = higher pop (and, later, better
// landing odds once bailing arrives). Lives with the rider profile.
const SKILL_TRICKS = ['ollie', 'kickflip', 'heelflip', 'treflip', 'impossible'];
let skills = {};
try { skills = JSON.parse(localStorage.sk8skills || '{}'); } catch { skills = {}; }
for (const t of SKILL_TRICKS) skills[t] = Math.min(5, Math.max(1, skills[t] || 1));
const getSkill = (n) => skills[n] || 1;
const setSkill = (n, l) => {
  skills[n] = Math.min(5, Math.max(1, l | 0));
  localStorage.sk8skills = JSON.stringify(skills);
};

const creator = new RiderCreator({
  THREE, GLTFLoader, renderer,
  ktx2Loader: ktx2, meshoptDecoder: MeshoptDecoder,
  getStance: () => stance,
  getSkills: () => ({ ...skills }),
  setSkill,
  setStance: (s) => setStance(s),
  onCharacter: (obj, ctrl) => setCharacter(obj, ctrl),
  onDone: () => {
    if (!charScene) return;
    charCtrl?.toRest?.();
    charScene.updateWorldMatrix(true, true);
    rig = new Rig(charScene);
    skel = buildSkeletonInfo(charScene);
    for (const c of Object.values(clips)) c.rebake(skel);
    if (anim) { anim.rig = rig; anim.skel = skel; }
    attachMarkers();
  },
});

// The SDK is the character system — there is no fallback. If it fails, the
// error is shown, loudly (owner's rule).
loadmsg('rider (creategamecharacters.ai)…');
try {
  await creator._apply();                       // spawns from saved recipe or project defaults
} catch (e) {
  console.error('[sk8] SDK rider failed:', e);
  const el = document.getElementById('loading');
  if (el) el.innerHTML = `<div style="color:#ff6b6b;font-size:17px">Character SDK failed</div>
    <div id="loadmsg" style="font-size:13px;color:#c98">${String(e.message || e)}</div>
    <div style="font-size:12px;color:#67707f">Serve from http://127.0.0.1:5101 (project origin lock) and check assets/creator/.</div>`;
  throw e;
}

// ── game objects ────────────────────────────────────────────────────────────

const physics = new SkatePhysics();
physics.vel.set(0, 0, 2.0);

anim = new SkateAnim({ rig, clips, physics, stance, skel, getSkill });

const trickEl = document.getElementById('trickname');
let trickFlashT = 0;
anim.onTrick = (label) => {
  trickEl.textContent = label;
  trickEl.classList.add('show');
  trickFlashT = 1.2;
};

const input = new Input({
  windupStart: () => anim.windupStart(),
  windupEnd: (g) => { lastGesture = g.type; anim.windupEnd(g); },
  push: () => anim.pushStroke(),
  pushStart: () => anim.pushStart(),
  pushEnd: () => anim.pushEnd(),
  isAirborne: () => !physics.grounded,
  revert: (d) => anim.revert(d),
  brake: (on) => { physics.braking = on; },
  toggleCam: () => { freecam = !freecam; controls.enabled = freecam; },
  toggleSlow: () => { slowmo = !slowmo; },
  reset: () => { physics.pos.set(0, 0, 0); physics.vel.set(0, 0, 2); physics.yaw = 0; physics.rollSign = 1; },
  // free-look: mouse movement while UNCLICKED orbits the chase cam; a held
  // wind-up freezes the camera (owner's spec) — input.js gates this already.
  look: (dx, dy) => {
    lookYaw -= dx * 0.0032;
    lookPitch = Math.max(-0.35, Math.min(0.55, lookPitch + dy * 0.0022));
  },
});
let lastGesture = '—';
let lookYaw = 0, lookPitch = 0;

// stance buttons (also settable from inside the creator panel)
const bReg = document.getElementById('stanceRegular');
const bGoof = document.getElementById('stanceGoofy');
function setStance(s) {
  stance = s;
  localStorage.sk8stance = s;
  if (anim) anim.setStance(s);
  bReg.classList.toggle('active', s === 'regular');
  bGoof.classList.toggle('active', s === 'goofy');
}
bReg.addEventListener('click', () => setStance('regular'));
bGoof.addEventListener('click', () => setStance('goofy'));
setStance(stance);

document.getElementById('openCreator').addEventListener('click', () => creator.open());

// ── camera ──────────────────────────────────────────────────────────────────

let freecam = false, slowmo = false;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enabled = false;
controls.target.set(0, 1, 0);

const camPos = new THREE.Vector3(0, 1.8, -4);
const camLook = new THREE.Vector3();
const _travel = new THREE.Vector3();

function updateCamera(dt) {
  if (freecam) { controls.update(); return; }
  // chase the VELOCITY direction, not the board yaw — during air spins (and
  // revert skids) the board whirls while momentum doesn't, and the camera
  // must ride the momentum (owner: 180s were jarring). rollSign flips on
  // landing keep travelDir aligned with velocity, so there is no snap.
  if (physics.speed() > 0.5) {
    _travel.set(physics.vel.x, 0, physics.vel.z).normalize();
  } else {
    physics.travelDir(_travel);
  }
  // free-look relaxes back to the chase view — but NEVER while winding up:
  // the camera must hold still from click to release (owner's spec)
  if (!input.holdingTrick) {
    const relax = Math.exp(-dt * 0.9);
    lookYaw *= relax;
    lookPitch *= relax;
  }
  _lookDir.copy(_travel).applyAxisAngle(_up, lookYaw);
  const want = new THREE.Vector3().copy(physics.pos)
    .addScaledVector(_lookDir, -3.8).add(new THREE.Vector3(0, 1.55 + lookPitch * 2.2, 0));
  const k = 1 - Math.exp(-dt * 4.5);
  camPos.lerp(want, k);
  camera.position.copy(camPos);
  camLook.lerp(new THREE.Vector3().copy(physics.pos).add(new THREE.Vector3(0, 0.9, 0)), 1 - Math.exp(-dt * 7));
  camera.lookAt(camLook);
}
const _lookDir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// ── HUD ─────────────────────────────────────────────────────────────────────

const hud = document.getElementById('hud');
document.getElementById('keys').textContent =
  'A/D steer (in air: SPIN 180/360)   W push   S brake\nSPACE hold+release ollie\nK kickflip H heelflip I impossible T 360flip\nQ/E revert   C freecam   X slowmo   R reset\nB markers';

function updateHUD() {
  const p = physics;
  const tr = anim.trick;
  hud.textContent =
    `stance ${stance}   ${p.rollSign > 0 ? 'NOSE-first' : 'FAKIE'}   ${anim.state}${p.pushing ? ' +push' : ''}\n` +
    `speed ${p.speed().toFixed(2)} m/s   crouch ${anim.crouch.toFixed(2)}   y ${p.pos.y.toFixed(2)}\n` +
    `clip ${tr ? `${tr.name}${tr.mirror ? ' (mirrored)' : ''} t=${tr.t.toFixed(2)}` : '—'}` +
    (anim.state === 'push' ? `   pushT ${anim.time.toFixed(2)}` : '') + `\n` +
    `gesture ${lastGesture}   last trick ${anim.lastTrick}`;
}

// ── loop ────────────────────────────────────────────────────────────────────

document.getElementById('loading').remove();
const clock = new THREE.Clock();

function tick(dt) {
  input.update(dt);
  physics.steer = input.steer;
  physics.spin = input.spin || 0;
  physics.update(dt);

  const buf = anim.update(dt, input.steer);

  playerRoot.position.copy(physics.pos);
  playerRoot.rotation.set(0, physics.yaw, 0);
  if (buf.board) {
    boardNode.position.fromArray(buf.board.pos);
    boardNode.quaternion.fromArray(buf.board.quat);
  }
  rig.apply(buf);
  anim.plantPostRig(rig, boardNode, playerRoot);   // landing feet-on-board invariant

  sun.position.set(physics.pos.x + 18, 26, physics.pos.z + 10);
  sun.target.position.copy(physics.pos);
  updateCamera(dt);

  if (trickFlashT > 0) { trickFlashT -= dt; if (trickFlashT <= 0) trickEl.classList.remove('show'); }
}

function frame() {
  requestAnimationFrame(frame);
  let dt = Math.min(clock.getDelta(), 0.05);
  if (slowmo) dt *= 0.25;
  tick(dt);
  updateHUD();
  renderer.render(scene, camera);
}
frame();

// ── debug handle (LAW ZERO: we look before we claim) ────────────────────────

let inspect = false;
window.SK8 = {
  physics, camera, controls, setStance, creator, boardNode, playerRoot, skills, setSkill,
  get anim() { return anim; },
  get rig() { return rig; },
  get clips() { return clips; },
  get input() { return input; },
  markers: setMarkers,
  inspect(on = true, dist = 3.0, height = 1.1) {
    inspect = on;
    if (on) {
      physics.vel.set(0, 0, 0);
      physics.pos.set(0, 0, 0);
      physics.yaw = 0;
      freecam = true; controls.enabled = true;
      camera.position.set(dist, height, 0);
      controls.target.set(0, 0.9, 0);
    } else {
      freecam = false; controls.enabled = false;
      physics.vel.set(0, 0, 2);
    }
  },
  step(seconds, dt = 1 / 60) {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) tick(dt);
    updateHUD();
    renderer.render(scene, camera);
    return { state: anim.state, speed: +physics.speed().toFixed(2), y: +physics.pos.y.toFixed(2), yaw: +physics.yaw.toFixed(2), rollSign: physics.rollSign };
  },
};
