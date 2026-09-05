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
import { buildSkeletonInfo, loadClips, loadGrabs } from './clips.js';
import { buildPark } from './park.js';
import { MapEditor } from './editor.js';
import { SkatePhysics } from './physics.js';
import { Input } from './input.js';
import { Recorder } from './recorder.js';
import { SkateAnim } from './anim.js';
import { RiderCreator, faceOf } from './creator.js';
import { idle } from './idle.js';
import { makeBuffer } from './rig.js';
import { buildSoleData } from './sole.js';
import { Boombox } from './boombox.js';
import { SkateSfx } from './sfx.js';

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

// ground + props: the rural park (js/park.js) — loaded after the loaders exist.
// Physics still rides the flat y=0 plane; ramps are decoration until ramp
// physics lands.

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

// ── the park ────────────────────────────────────────────────────────────────

loadmsg('park…');
const park = await buildPark({ scene, loader, renderer, onProgress: loadmsg });

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
let soleData = null;

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
let grabs = {};              // grab POSES from the Pose Studio (assets/poses/)
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
    grabs = await loadGrabs(loadmsg);
    console.log('[sk8] clip stances:',
      Object.entries(clips).map(([k, c]) =>
        `${k}: ${c.stance} (margin ${c.stanceMargin.toFixed(2)}m, raw nose ${c.noseSignRaw > 0 ? '+Z' : '-Z'} → normalized +Z)`).join('\n  '));
  } else {
    for (const c of Object.values(clips)) c.rebake(skel);
  }
  if (anim) { anim.rig = rig; anim.skel = skel; }
  soleData = buildSoleData(charScene, rig);
  attachMarkers();
}

// ── spawn the rider: SDK project character first, local GLB as fallback ─────

let stance = localStorage.sk8stance || 'regular';
let anim = null;

// per-trick skill levels (1..5): higher = higher pop (and, later, better
// landing odds once bailing arrives). Lives with the rider profile.
const SKILL_TRICKS = ['ollie', 'kickflip', 'heelflip', 'treflip', 'impossible', 'indy'];
let skills = {};
try { skills = JSON.parse(localStorage.sk8skills || '{}'); } catch { skills = {}; }
for (const t of SKILL_TRICKS) skills[t] = Math.min(5, Math.max(1, skills[t] || 1));
const getSkill = (n) => skills[n] || 1;
const setSkill = (n, l) => {
  skills[n] = Math.min(5, Math.max(1, l | 0));
  localStorage.sk8skills = JSON.stringify(skills);
};

const creator = new RiderCreator({
  THREE, GLTFLoader, renderer, scene,
  ktx2Loader: ktx2, meshoptDecoder: MeshoptDecoder,
  onOpen: (front) => creatorMode(true, front),
  onClose: () => creatorMode(false),
  frame: (kind) => creatorFrame(kind),
  music: () => boombox,
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
    soleData = buildSoleData(charScene, rig);
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

// The run starts perched on a quarter pipe's coping, and you drop in (owner,
// 2026-09-04). The lip to pick is chosen from the park rather than written
// down, so it survives the owner moving the ramps: of every coping line, take
// the highest one that faces the middle of the park, since that is the one with
// a run-out in front of it. `out` points DOWN the transition.
//
// The physics needs nothing for this — a rider set on the coping rolls over the
// lip, catches the transition and comes out the bottom at ~5.9 m/s on its own.
// What it does NOT have is a drop-in ANIMATION, so until one is captured the
// rider rides down in its normal pose.
const CENTRE = new THREE.Vector3(0, 0, 4);
function pickLip() {
  let best = null;
  for (const t of park.transitions) {
    const mid = t.a.clone().add(t.b).multiplyScalar(0.5);
    const toCentre = CENTRE.clone().sub(mid).setY(0).normalize();
    const faces = t.out.dot(toCentre);            // the transition drops toward the park
    if (faces < 0.3) continue;
    const score = mid.y + faces * 0.6;
    if (!best || score > best.score) best = { score, mid, out: t.out.clone() };
  }
  return best;
}
const LIP = pickLip();
const START = LIP
  // the root is the TAIL's contact point (the take is anchored on the back foot), and
  // the tail rests ON the coping: root at the lip line, so the deck's other 0.7 m —
  // nose and front wheels — hangs out over the transition (owner: "the wheels should
  // be past the coping")
  // the ROOT is the contact under the back foot and it must sit ON the deck —
  // put past the lip it slid down the transition face (measured: root 7 cm out,
  // 33 cm down, rider on its side). The nose hanging over the coping comes from
  // the clip's board track, which reaches 0.71 m ahead of the back foot.
  ? { x: LIP.mid.x - LIP.out.x * 0.14, y: LIP.mid.y + 0.02, z: LIP.mid.z - LIP.out.z * 0.14,
      yaw: Math.atan2(LIP.out.x, LIP.out.z), drop: true }
  : { x: 0, y: 0, z: -16, yaw: 0, drop: false };   // no ramps in the layout: the old flat start
// perched on the lip, the run does not begin until the player commits
let waiting = START.drop;
// The chase camera sits behind the deck, where the coping and the nose hanging
// over it are hidden by the rider — from there a perch reads as standing on the
// deck (owner's screenshots, 2026-09-05). While perched the camera stands on
// the RAMP side, low, three-quarter: back wheels on the coping, nose out over
// the transition, both in view. The chase springs back in as the rider drops.
const PERCH_CAM = LIP ? { pos: new THREE.Vector3(), look: new THREE.Vector3() } : null;   // filled by perchFraming()
function perchFraming() {
  if (!LIP) return;
  const t = park.transitions.find(t => t.a.clone().add(t.b).multiplyScalar(0.5).distanceTo(LIP.mid) < 0.01) || park.transitions[0];
  const lipDir = t.b.clone().sub(t.a).setY(0).normalize();
  PERCH_CAM.look.set(START.x, START.y, START.z).addScaledVector(LIP.out, 0.35).add(new THREE.Vector3(0, 0.5, 0));
  PERCH_CAM.pos.copy(PERCH_CAM.look).addScaledVector(LIP.out, 2.2).addScaledVector(lipDir, 1.6).add(new THREE.Vector3(0, -0.35, 0));
}
perchFraming();
function toStart() {
  physics.pos.set(START.x, START.y, START.z);
  physics.vel.set(0, 0, 0);
  physics.rollSign = 1; physics.up.set(0, 1, 0); physics.grounded = true;
  physics.vert = null; physics.grind = null;
  physics.setYaw(START.yaw);
  waiting = START.drop;
  if (!START.drop) physics.vel.set(0, 0, 2);
}
// the first input tips it in — a drop-in is a commitment, not a roll-up
function commit() {
  if (!waiting) return;
  waiting = false;
  if (LIP) physics.vel.copy(LIP.out).multiplyScalar(0.8);
  anim?.dropIn();                                  // the captured drop-in, from its commit tag
}
// the boombox easter egg: gap over it and the park's music comes on
const boombox = new Boombox({ camera, park });

const physics = new SkatePhysics(park.world);
// the board's voice — synthesised, driven off the physics from outside
const sfx = new SkateSfx({ listener: boombox.listener, physics, anim: null });
physics.setEdges(park.edges);
physics.setTransitions(park.transitions);   // coping lines: gap transfers between neighbouring faces
toStart();
const _rootQ = new THREE.Quaternion();

anim = new SkateAnim({ rig, clips, physics, stance, skel, getSkill, grabs });
sfx.anim = anim;

const trickEl = document.getElementById('trickname');
let trickFlashT = 0;
anim.onTrick = (label) => {
  trickEl.textContent = label;
  trickEl.classList.add('show');
  trickFlashT = 1.2;
};
const flash = (label) => { trickEl.textContent = label; trickEl.classList.add('show'); trickFlashT = 1.8; };

// the game actions the input drives — every one of these is recorded (see
// recorder.js) so a run can be replayed input for input
const actions = {
  windupStart: () => anim.windupStart(),
  windupEnd: (g) => { lastGesture = g.type; anim.windupEnd(g); },
  push: () => anim.pushStroke(),
  pushStart: () => anim.pushStart(),
  pushEnd: () => anim.pushEnd(),
  grabStart: () => anim.grabStart('indy'),
  grabEnd: () => anim.grabEnd(),
  manualStart: () => anim.manualStart(),
  manualEnd: () => anim.manualEnd(),
  revert: (d) => anim.revert(d),
  brake: (on) => { physics.braking = on; },
  toggleCam: () => { freecam = !freecam; controls.enabled = freecam; },
  toggleSlow: () => { slowmo = !slowmo; },
  reset: () => toStart(),
};
const recordedActions = Object.fromEntries(Object.entries(actions).map(([k, f]) => [k, (...a) => { recorder.cb(k, a); return f(...a); }]));
const input = new Input({
  ...recordedActions,
  isAirborne: () => !physics.grounded,
  // free-look: mouse movement while UNCLICKED orbits the chase cam; a held
  // wind-up freezes the camera (owner's spec) — input.js gates this already.
  look: (dx, dy) => {
    lookYaw -= dx * 0.0032;
    lookPitch = Math.max(-0.35, Math.min(0.55, lookPitch + dy * 0.0022));
  },
});
const recorder = new Recorder({
  physics, anim, input, park,
  getStance: () => stance, setStance, getSkills: () => ({ ...skills }), setSkill,
  fire: (name, args) => actions[name]?.(...args),
  flash,
  tick: (dt, headless) => tick(dt, headless),
  paint: () => paint(),
  present: () => {                         // show the physics root as it is (a scrub preview: no simulation)
    playerRoot.position.copy(physics.pos);
    playerRoot.quaternion.copy(physics.rootQuat(_rootQ));
    updateCamera(1 / 30);
    updateHUD();
    renderer.render(scene, camera);
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
updateRiderTag();

addEventListener('keydown', () => commit());
addEventListener('pointerdown', () => commit());
document.getElementById('openCreator').addEventListener('click', () => { input.unlock(); creator.open(); });
addEventListener('keydown', (e) => {                 // Esc from the game opens the menu too
  if (e.key === 'Escape' && !creator.open_ && !editor?.on && !recorder.replaying) { input.unlock(); creator.open(); }
});

// ── camera ──────────────────────────────────────────────────────────────────

let freecam = false, slowmo = false;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enabled = false;
controls.target.set(0, 1, 0);

const camPos = new THREE.Vector3(0, 1.8, -4);
const camLook = new THREE.Vector3();

// ── the creator's camera: yours to spin and zoom, closing in on the face ──
// While the creator is open the rider stands still at the spot, input is off
// the board, and OrbitControls has the camera with limits that keep it out
// of the ground and off the rider's nose. Tabs ask for 'body' or 'face' and
// the orbit target and distance ease over.
let inCreator = false;
let charYaw0 = 0;                  // the rider's own yaw, restored when the creator closes
const idleBuf = makeBuffer();      // the creator's rider stands (animation.md idle)
let idleT = 0;
const crFrame = { target: new THREE.Vector3(), dist: 3.0, t: 1, pos: null, kind: 'body',   // pos: a place to swing to (the front of the face)
  from: new THREE.Vector3(), fromTarget: new THREE.Vector3() };                        // where the swing started (an exact tween, whatever the frame rate)
const _crTo = new THREE.Vector3(), _crDir = new THREE.Vector3();
function creatorMode(on, front = false) {
  inCreator = on;
  input.disabled = on;
  document.body.classList.toggle('creator', on);
  if (on) {
    // the creator's rider stands on the flat slab, as it always did — never at
    // the lip. A held drop-in perch under the idle fought it and left the board
    // on its end, and the lip's edge tipped the root down the transition (owner's
    // screenshots, 2026-09-05). SKATE puts the rider on the lip (creatorMode off).
    physics.pos.set(0, 0, -16); physics.up.set(0, 1, 0); physics.setYaw(0); physics.grounded = true;
    physics.vel.set(0, 0, 0);
    if (anim && anim.state === 'trick' && anim.trick?.name === 'dropin') { anim.trick = null; anim._toState('ride'); }
    controls.enabled = true;
    controls.enablePan = false;
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 0.45; controls.maxDistance = 6;
    controls.minPolarAngle = 0.35; controls.maxPolarAngle = 1.62;
    controls.autoRotate = true; controls.autoRotateSpeed = -0.6;
    controls.addEventListener('start', stopSpin);
    // start behind-left of the rider, looking at the chest, then ease to the body frame
    charYaw0 = charScene.rotation.y;
    faceFront();                                 // square to the camera before the first frame
    const { forward } = faceOf(charScene, THREE);
    const side = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    camera.position.copy(physics.pos).addScaledVector(forward, 3.0).addScaledVector(side, 1.1).add(new THREE.Vector3(0, 1.5, 0));
    controls.target.copy(physics.pos).add(new THREE.Vector3(0, 1.0, 0));
    creatorFrame('body', true);
  } else {
    if (charScene) { charScene.rotation.y = charYaw0; charScene.updateWorldMatrix(true, true); }
    controls.removeEventListener('start', stopSpin);
    controls.autoRotate = false;
    controls.enabled = freecam;
    controls.minDistance = 0; controls.maxDistance = Infinity;
    controls.minPolarAngle = 0; controls.maxPolarAngle = Math.PI;
    toStart();                                       // SKATE: onto the lip, perched, until the player commits
    updateRiderTag();
  }
}
function stopSpin() { controls.autoRotate = false; }
// A skater stands SIDEWAYS on the board, so the mesh's face looks ~107 deg off
// the root's forward. In the creator the rider stands square to the camera
// instead. Re-applied every frame because picking a rider or an outfit respawns
// the character, which would put the stance back.
function faceFront() {
  if (!charScene) return;
  const face = faceOf(charScene, THREE, 'Hips').forward;   // the BODY squares up, not the head
  const rootFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(playerRoot.quaternion);
  const d = Math.atan2(face.x, face.z) - Math.atan2(rootFwd.x, rootFwd.z);
  if (Math.abs(d) < 1e-4) return;
  charScene.rotation.y -= d;
  charScene.updateWorldMatrix(true, true);
}
function creatorFrame(kind, snap = false) {
  if (!charScene) return;
  crFrame.kind = kind;
  if (kind === 'face') {
    // the eyes say where the face is and which way it looks (a skater stands
    // sideways on the board); the camera swings round to meet it
    const { target, forward } = faceOf(charScene, THREE);
    crFrame.target.copy(target);
    crFrame.dist = 0.75;
    crFrame.pos = target.clone().addScaledVector(forward, 0.75); crFrame.pos.y += 0.06;
  } else {
    crFrame.target.copy(physics.pos).y += 0.95;
    crFrame.dist = 3.0;
    crFrame.pos = null;                                  // keep whatever angle the player had
  }
  crFrame.t = snap ? 1 : 0;
  crFrame.from.copy(camera.position); crFrame.fromTarget.copy(controls.target);
}
function updateCreatorCamera(dt) {
  if (crFrame.t < 1) {
    crFrame.t = Math.min(1, crFrame.t + dt / 0.6);
    const k = 1 - Math.pow(1 - crFrame.t, 3);          // ease out
    // OrbitControls rebuilds the camera from its own damping and auto-rotate
    // every frame and would undo a swing, so both are off while it runs; the
    // face is re-read each frame in case the pose is still settling
    controls.autoRotate = false; controls.enableDamping = false;
    if (crFrame.kind === 'face') {
      const { target, forward } = faceOf(charScene, THREE);
      crFrame.target.copy(target);
      crFrame.pos = target.clone().addScaledVector(forward, crFrame.dist); crFrame.pos.y += 0.06;
    }
    if (crFrame.t >= 1) controls.enableDamping = true;
    _crDir.subVectors(camera.position, controls.target);
    const d = _crDir.length(); _crDir.divideScalar(d || 1);
    controls.target.lerpVectors(crFrame.fromTarget, crFrame.target, k);
    if (crFrame.pos) _crTo.copy(crFrame.pos);
    else { _crDir.subVectors(crFrame.from, crFrame.fromTarget).normalize(); _crTo.copy(crFrame.target).addScaledVector(_crDir, crFrame.dist); }
    camera.position.lerpVectors(crFrame.from, _crTo, k);
  }
  controls.update();
}
function updateRiderTag() {
  const el = document.getElementById('riderTag');
  if (el) el.textContent = creator.state.name || '';
}
const _travel = new THREE.Vector3();

function updateCamera(dt) {
  if (inCreator) { updateCreatorCamera(dt); return; }
  if (waiting && PERCH_CAM) { camera.position.copy(PERCH_CAM.pos); camera.lookAt(PERCH_CAM.look); return; }
  if (freecam) { controls.update(); return; }
  // chase the VELOCITY direction, not the board yaw — during air spins (and
  // revert skids) the board whirls while momentum doesn't, and the camera
  // must ride the momentum (owner: 180s were jarring). rollSign flips on
  // landing keep travelDir aligned with velocity, so there is no snap.
  // The chase heading (and the chest side) only turn ON THE GROUND (owner,
  // 2026-09-03: "the camera should not turn while in air" — off a quarter
  // pipe the velocity reverses mid-air and the camera swung round, losing the
  // rider); frozen from leave to touchdown, then it turns at a limited rate,
  // orbiting round the rider instead of lerping the camera through them
  if (physics.grounded) {
    if (physics.speed() > 0.5) {
      _travel.set(physics.vel.x, 0, physics.vel.z).normalize();
    } else {
      physics.travelDir(_travel);
    }
    let dy = Math.atan2(_travel.x, _travel.z) - chaseYaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    chaseYaw += dy * (1 - Math.exp(-dt * 6));
    // chest side relative to travel: regular nose-first = right; flips with
    // stance and with fakie — and it's travel-based, so air spins don't swing it
    chaseSide = (stance === 'regular' ? -1 : 1) * physics.rollSign;
  }
  // free-look relaxes back to the chase view — but NEVER while winding up:
  // the camera must hold still from click to release (owner's spec)
  if (!input.holdingTrick) {
    const relax = Math.exp(-dt * 0.9);
    lookYaw *= relax;
    lookPitch *= relax;
  }
  _lookDir.set(Math.sin(chaseYaw + lookYaw), 0, Math.cos(chaseYaw + lookYaw));

  // Skate-style framing (owner, 2026-09-02): sit a bit OFF to the rider's
  // chest side (3/4 view instead of a static tail-cam), lead the look ahead
  // of the motion, breathe with speed, and roll gently with the carve.
  const sp = physics.speed();
  const sideSign = chaseSide;
  _sideDir.set(_lookDir.z, 0, -_lookDir.x);              // right of travel
  const dist = 3.1 + sp * 0.11;
  const want = new THREE.Vector3().copy(physics.pos)
    .addScaledVector(_lookDir, -dist)
    .addScaledVector(_sideDir, sideSign * 0.85)
    .add(new THREE.Vector3(0, 1.35 + lookPitch * 2.2, 0));
  const lookTarget = new THREE.Vector3().copy(physics.pos)
    .addScaledVector(_lookDir, 1.2)                       // lead the motion
    .addScaledVector(_sideDir, sideSign * 0.12)
    .add(new THREE.Vector3(0, 0.85, 0));
  // lazy sideways, TIGHT in height: a rider dropping 9 m back into a ramp
  // at 10 m/s left the lagging camera 4 m above them, looking down
  const kH = 1 - Math.exp(-dt * 3.3), kV = 1 - Math.exp(-dt * 14);
  camPos.x += (want.x - camPos.x) * kH;
  camPos.z += (want.z - camPos.z) * kH;
  camPos.y += (want.y - camPos.y) * kV;
  // the spring arm, the way every game does it: if the park is between the
  // rider and the camera, the camera comes in along its own arm to just in
  // front of what blocks it, and looks up at the rider from there. Nothing
  // else — no lifting, no top-down (owner, 2026-09-03)
  // the boom (camPos) is never shortened itself — the arm only decides how
  // much of it the camera uses this frame, or shortening feeds back and the
  // camera converges onto the rider
  camera.position.copy(springArm(camPos, dt));
  camLook.lerp(lookTarget, 1 - Math.exp(-dt * 5.5));
  camera.lookAt(camLook);
  // carve roll + speed FOV breathing
  camRoll += ((-input.steer * 0.045) - camRoll) * (1 - Math.exp(-dt * 4));
  camera.rotateZ(camRoll);
  const wantFov = 55 + Math.min(10, sp * 0.85);
  if (Math.abs(camera.fov - wantFov) > 0.05) {
    camera.fov += (wantFov - camera.fov) * (1 - Math.exp(-dt * 2.5));
    camera.updateProjectionMatrix();
  }
}
const _lookDir = new THREE.Vector3();
let chaseYaw = 0, chaseSide = 1;          // the chase heading / chest side, frozen in the air
const _camDir = new THREE.Vector3(), _camEye = new THREE.Vector3();
const CAM_MARGIN = 0.3, CAM_MIN = 1.0;
const ARM_HOLD = 0.4;                      // s the ray must stay clear before the arm lets out again
const ARM_OUT = 2.5;                       // 1/s — how fast it lets out then
let armFrac = 1, armClearT = 1;            // the arm's length as a fraction of the wanted one; time the ray has been clear
// the spring arm, with the lag every game gives it: it comes IN the instant
// something is between the rider and the camera, and only lets back OUT once
// the ray has stayed clear for a while. Without that it let out the moment a
// ray was clear and snapped in again a few frames later, all the way down a
// ramp — the owner's "camera jitter" (a 0.9→1.26 m sawtooth every 6 frames)
const _camOut = new THREE.Vector3();
function springArm(boom, dt) {
  _camEye.copy(physics.pos).y += 0.9;                     // the rider's chest
  _camDir.subVectors(boom, _camEye);
  const d = _camDir.length();
  if (d < 1e-3) return _camOut.copy(boom);
  _camDir.multiplyScalar(1 / d);
  const hit = park.world.cast(_camEye, _camDir, d);
  const allowed = hit ? Math.min(1, Math.max(CAM_MIN, hit.distance - CAM_MARGIN) / d) : 1;
  if (allowed < armFrac) { armFrac = allowed; armClearT = 0; }
  else {
    armClearT += dt;
    if (armClearT > ARM_HOLD) armFrac += (allowed - armFrac) * (1 - Math.exp(-dt * ARM_OUT));
  }
  return _camOut.copy(_camEye).addScaledVector(_camDir, d * armFrac);
}
const _sideDir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
let camRoll = 0;

// ── HUD ─────────────────────────────────────────────────────────────────────

const hud = document.getElementById('hud');
document.getElementById('keys').textContent =
  'A/D steer (in air: SPIN 180/360)   W push   S brake (double-tap+hold = MANUAL)\nSPACE hold+release ollie\nK kickflip H heelflip I impossible T 360flip\nG (hold, in the air) indy grab\nQ/E revert   C freecam   X slowmo   R reset\nB markers   M map editor   F3 debug   Esc frees the mouse\nF4 review the recording: scrub, N tags a bug, save';

// the debug readout is off by default (owner, 2026-09-03); F3 or SK8.hud() shows it
function showHUD(on = !document.body.classList.contains('debug')) {
  document.body.classList.toggle('debug', on);
}
addEventListener('keydown', (e) => {
  if (e.code === 'F3') { e.preventDefault(); if (!e.repeat) showHUD(); return; }
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  // bug recording (owner, 2026-09-03): F4 reviews the session so far — scrub
  // the timeline, N tags the moment shown, save writes it to _scratch/
  if (e.code === 'F4') { e.preventDefault(); if (!e.repeat) recorder.review(); }
  if (e.key.toLowerCase() === 'n' && !e.repeat && !recorder.replaying) recorder.tag();   // live: "that, just now"
});

function updateHUD() {
  if (!document.body.classList.contains('debug')) return;
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
// the front door: you build your skater first (owner, 2026-09-04). The loop
// runs under it so the rider stands there breathing while you work.
queueMicrotask(() => creator.open({ front: true }));

// headless = a review seek: physics + the anim state machine only, no rig,
// IK, camera or grass work (the visuals cannot feed back into the physics)
function tick(dt, headless = false) {
  if (!recorder.replaying) input.update(dt);      // (a replay sets the channels itself)
  recorder.frame(dt);
  if (inCreator) { physics.vel.set(0, 0, 0); input.steer = 0; }
  if (waiting && !inCreator) {                       // perched on the coping: the take's own perch, held
    anim.dropInPerch();
    if (input.steer || anim.holding) commit();       // (a key or click commits via the listeners below)
    else { physics.vel.set(0, 0, 0); input.steer = 0; }
  }
  physics.steer = input.steer;
  physics.spin = input.spin || 0;
  physics.pump = anim.holding && anim.state === 'windup';   // the held wind-up pumps a transition (anim state: replays match)
  physics.update(dt);

  const buf = anim.update(dt, input.steer);
  if (headless) { recorder.replayEnd(); return; }

  playerRoot.position.copy(physics.pos);
  playerRoot.quaternion.copy(physics.rootQuat(_rootQ));   // nose along the surface, up = its normal
  // the sun's shadow frustum rides along with the player (the park is big)
  sun.target.position.set(physics.pos.x, 0, physics.pos.z);
  sun.position.set(physics.pos.x + 18, 26, physics.pos.z + 10);
  park.update(dt);                                  // grass wind
  boombox.update(dt, physics);                      // gapped the boombox? switch the music on
  sfx.update(dt);                                   // roll, grind, pop, land
  if (inCreator) {
    // the creator's rider stands rather than crouching on the board: the idle
    // from creategamecharacters.ai's animation.md. No sole/plant passes — those
    // exist to hold the feet on the deck.
    idleT += dt;
    rig.apply(idle(idleBuf, idleT));
    boardNode.position.set(0, 0.07, 0);              // resting flat under the rider (origin is mid-height)
    boardNode.quaternion.identity();
    faceFront();
  } else {
    if (buf.board) {
      boardNode.position.fromArray(buf.board.pos);
      boardNode.quaternion.fromArray(buf.board.quat);
    }
    rig.apply(buf);
    anim.soleAttach(rig, boardNode, soleData, playerRoot);   // mesh-level sole-to-deck contact
    anim.groundFeetIK(rig, boardNode, soleData);     // per-foot residual planting
    anim.plantPostRig(rig, boardNode, playerRoot);   // landing feet-on-board invariant
  }

  sun.position.set(physics.pos.x + 18, 26, physics.pos.z + 10);
  sun.target.position.copy(physics.pos);
  updateCamera(dt);

  if (trickFlashT > 0) { trickFlashT -= dt; if (trickFlashT <= 0) trickEl.classList.remove('show'); }
  recorder.replayEnd();
}

// the visual half of tick(), with nothing advanced: the pose the anim
// controller last produced, put on the rig, and the camera snapped to it.
// A scrub re-simulates headless and ends with ONE of these.
function paint() {
  if (!rig) return;
  playerRoot.position.copy(physics.pos);
  playerRoot.quaternion.copy(physics.rootQuat(_rootQ));
  sun.target.position.copy(physics.pos);
  sun.position.set(physics.pos.x + 18, 26, physics.pos.z + 10);
  const buf = anim.out;
  if (buf.board) {
    boardNode.position.fromArray(buf.board.pos);
    boardNode.quaternion.fromArray(buf.board.quat);
  }
  rig.apply(buf);
  anim.soleAttach(rig, boardNode, soleData, playerRoot);
  anim.groundFeetIK(rig, boardNode, soleData);
  anim.plantPostRig(rig, boardNode, playerRoot);
  updateCamera(1.0);                 // a big dt: the chase springs land at once
  updateHUD();
  renderer.render(scene, camera);
}

let paused = false;          // SK8.pause(): the live loop only renders; SK8.step() drives time
function frame() {
  requestAnimationFrame(frame);
  let dt = Math.min(clock.getDelta(), 0.05);
  if (slowmo) dt *= 0.25;
  if (!paused) {
    if (recorder.replaying) recorder.advance();   // the review's play/pause/speed
    else tick(dt);
  }
  updateHUD();
  renderer.render(scene, camera);
}
frame();

// ── debug handle (LAW ZERO: we look before we claim) ────────────────────────

// the map editor (M): pauses the game, frees the camera, edits the layout
const editor = new MapEditor({
  renderer, camera, controls, park, physics, input,
  setPaused: (on) => { paused = on; freecam = on; },
});

let inspect = false;
window.SK8 = {
  physics, camera, controls, setStance, creator, get charScene() { return charScene; }, boardNode, playerRoot, skills, setSkill, park, editor,
  boombox,                                          // SK8.boombox.gapped() / .off() / .setVolume(0.5)
  sfx,                                              // SK8.sfx.pop() / .land() / .setVolume(0.6)
  pause(on = true) { paused = on; },
  hud(on = true) { showHUD(on); },
  // bug recordings: SK8.replay('/_scratch/rec-….json') opens it in the review
  // panel; SK8.replayTo(frame) seeks there at once
  recorder,
  replay: (src) => recorder.load(src),
  replayTo(n) {
    recorder.seek(n);
    updateHUD();
    renderer.render(scene, camera);
    return recorder.replaying ? { frame: recorder.replaying.i, divergence: recorder.replaying.divergence } : { done: true };
  },
  replayStop: () => recorder.close(),
  get anim() { return anim; },
  get rig() { return rig; },
  get clips() { return clips; },
  get soleData() { return soleData; },
  get input() { return input; },
  markers: setMarkers,
  inspect(on = true, dist = 3.0, height = 1.1) {
    inspect = on;
    if (on) {
      physics.vel.set(0, 0, 0);
      physics.pos.set(START.x, 0, START.z);
      physics.up.set(0, 1, 0); physics.setYaw(START.yaw);
      freecam = true; controls.enabled = true;
      camera.position.set(START.x + dist, height, START.z);
      controls.target.set(START.x, 0.9, START.z);
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
