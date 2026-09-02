// pose-from-studio.mjs — turn a Pose Studio grab snapshot into a game grab pose.
//
// Input (dumped from the Studio at the grab frame):
//   { t, take, pose: {Bone:[x,y,z,w]} (snapshotPose = bind-relative deltas),
//     world: {FootL,FootR,BallL,BallR,Hips,...: {p:[3], q:[4]}} (boneWorld),
//     board: {p:[3], X:[3], Y:[3], Z:[3]} (the prop's WORLD basis; the Studio
//            shows the mesh, whose visual nose is −Z, so +Z points to the tail) }
// Output: assets/poses/<name>.json — pose + board + hips lean, all relative to
// the FEET FRAME (origin = ankle midpoint, z = back→front ankle, y = deck
// normal from the toe direction, x = y × z) so any body reproduces it.
// Board quaternion is converted to the GAME convention (+Z = nose).
//
// Usage: node tools/pose-from-studio.mjs <raw.json> <out.json> <name> <regular|goofy>
import fs from 'node:fs';

const [rawPath, outPath, name = 'indy grab', stance = 'regular'] = process.argv.slice(2);
if (!rawPath || !outPath) { console.error('usage: pose-from-studio <raw.json> <out.json> [name] [stance]'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return mul(a, 1 / l); };
// quaternions as [x,y,z,w]
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map(v => v / l); };
// basis columns (x,y,z) → quaternion
function qFromBasis(x, y, z) {
  const m = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];   // row-major
  const tr = m[0] + m[4] + m[8];
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s, 0.25 * s]; }
  else if (m[0] > m[4] && m[0] > m[8]) { const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2; q = [0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s]; }
  else if (m[4] > m[8]) { const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2; q = [(m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s, (m[2] - m[6]) / s]; }
  else { const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2; q = [(m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s, (m[3] - m[1]) / s]; }
  return qnorm(q);
}

const rotv = (q, v) => { const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q)); return [r[0], r[1], r[2]]; };

const W = raw.world;
const regular = stance !== 'goofy';
const front = W[regular ? 'FootL' : 'FootR'].p, back = W[regular ? 'FootR' : 'FootL'].p;
const mid = mul(add(front, back), 0.5);
const z = norm(sub(front, back));                                    // nose
// deck normal = the FEET's own up (bind-pose local up axes rotated by the
// current foot orientation — "the board rotates with the foot"), from
// _scratch/foot_axes.json dumped by the game's rig. Fallback: toe direction.
let y;
const axesPath = process.argv[6] || 'assets/poses/foot_axes.json';
if (fs.existsSync(axesPath)) {
  const ax = JSON.parse(fs.readFileSync(axesPath, 'utf8'));
  const upL = rotv(W.FootL.q, ax.L.up), upR = rotv(W.FootR.q, ax.R.up);
  y = norm(add(upL, upR));
  console.log('feet up (world):', upL.map(v => +v.toFixed(3)), upR.map(v => +v.toFixed(3)));
} else {
  const toe = norm(sub(mul(add(W.BallL.p, W.BallR.p), 0.5), mid));   // toe direction
  y = mul(cross(z, toe), regular ? -1 : 1);
  console.warn('no foot axes file — using the toe-direction normal');
}
y = norm(sub(y, mul(z, dot(y, z))));                                 // ⟂ nose
const x = norm(cross(y, z));
const qF = qFromBasis(x, y, z);

// board: Studio basis (+Z tail) → game (+Z nose): X→−X, Z→−Z
const B = raw.board;
const qBoardWorld = qFromBasis(mul(B.X, -1), B.Y, mul(B.Z, -1));
const d = sub(B.p, mid);
const boardPos = [dot(d, x), dot(d, y), dot(d, z)];
const boardQuat = qnorm(qmul(qconj(qF), qBoardWorld));
const hipsLean = qnorm(qmul(qconj(qBoardWorld), W.Hips.q));

// sanity: feet vs deck (deck top = +0.075 along the board's y)
const report = {};
for (const bn of ['FootL', 'FootR', 'BallL', 'BallR', 'HandR', 'HandL']) {
  if (!W[bn]) continue;
  const e = sub(W[bn].p, B.p);
  report[bn] = { aboveDeck: +(dot(e, B.Y) - 0.075).toFixed(3), lateral: +(dot(e, B.X) * -1).toFixed(3), alongNose: +(dot(e, B.Z) * -1).toFixed(3) };
}

const out = {
  name, stance,
  source: { take: raw.take, t: raw.t, tool: 'creategamecharacters.ai Pose Studio' },
  hold: [0.22, 0.72],
  pose: raw.pose,
  board: { pos: boardPos.map(v => +v.toFixed(4)), quat: boardQuat.map(v => +v.toFixed(5)) },
  hipsLean: hipsLean.map(v => +v.toFixed(5)),
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log('wrote', outPath, 'bones', Object.keys(raw.pose).length);
console.log('feet frame: nose', z.map(v => +v.toFixed(3)), 'normal', y.map(v => +v.toFixed(3)));
console.log('board in feet frame: pos', out.board.pos, 'quat', out.board.quat);
console.log('hipsLean', out.hipsLean);
console.log('feet vs deck (m):', JSON.stringify(report));
