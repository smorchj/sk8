// rails.js — handrails down the stairs, built in code (owner, 2026-09-03:
// "hand rails down the stairs — something you can do programmatically with
// splines"). One steel tube per side along a spline: a level run onto the
// landing, the slope parallel to the step nosings, a run-out past the bottom
// step; posts into the treads. The tube is solid (a prop collider: the
// board stops against it, never rides over it) and grindable along its whole
// length — a chained edge polyline on the tube's top, so a grind flows round
// both bends like the curved bench.

import * as THREE from 'three';
import { STAIRS, LEVEL } from './terrain.js';

const R = 0.025;                 // m — tube radius
const HEIGHT = 0.95;             // m — rail top above the nosing line / the landing
const INSET = 0.25;              // m — from the stairs' side walls
const POST_R = 0.018;

export function buildStairRails() {
  const group = new THREE.Group();
  group.name = 'stair rails';
  const mat = new THREE.MeshStandardMaterial({ color: 0x2b3036, metalness: 0.85, roughness: 0.32 });
  const rise = (LEVEL.upper - LEVEL.lower) / STAIRS.steps;
  const tread = (STAIRS.z1 - STAIRS.z0) / STAIRS.steps;
  // the nosing line: the first step's nose up to the landing's edge, and
  // where it would meet the ground below the bottom step
  const zTop = STAIRS.z1 - tread, yTop = LEVEL.upper;
  const zBot = STAIRS.z0, yBot = LEVEL.lower + rise;
  const slope = (yTop - yBot) / (zTop - zBot);
  const zGround = zBot - (yBot - LEVEL.lower) / slope;
  const railY = (z) => HEIGHT + (z >= zTop ? yTop : z <= zGround ? LEVEL.lower : yTop - (zTop - z) * slope);
  // the tread under a z (the boxes stack: the highest one that reaches z)
  const treadY = (z) => {
    if (z >= STAIRS.z1) return LEVEL.upper;
    if (z < STAIRS.z0) return LEVEL.lower;
    return LEVEL.lower + rise * (Math.floor((z - STAIRS.z0) / tread) + 1);
  };

  const edges = [];
  for (const side of [-1, 1]) {
    const x = side * (STAIRS.hw - INSET);
    const P = (z) => new THREE.Vector3(x, railY(z), z);
    // straight runs with rounded corners: two knots close to each bend
    const pts = [P(zTop + 0.8), P(zTop + 0.12), P(zTop - 0.12), P(zGround + 0.12), P(zGround - 0.12), P(zGround - 0.7)];
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, R, 10, false), mat);
    tube.castShadow = true;
    tube.receiveShadow = true;
    tube.name = 'stair rail';
    group.add(tube);
    for (const end of [pts[0], pts[pts.length - 1]]) {          // closed ends
      const cap = new THREE.Mesh(new THREE.SphereGeometry(R, 10, 8), mat);
      cap.position.copy(end);
      cap.castShadow = true;
      group.add(cap);
    }
    for (const z of [zTop + 0.5, zTop - 0.6, zGround - 0.45]) {   // posts
      const bottom = treadY(z), top = railY(z) - R;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(POST_R, POST_R, top - bottom, 8), mat);
      post.position.set(x, (top + bottom) / 2, z);
      post.castShadow = true;
      post.name = 'stair rail post';
      group.add(post);
    }
    // the grindable line: the tube's top, chained along the bends
    const top = curve.getSpacedPoints(16).map(p => p.add(new THREE.Vector3(0, R, 0)));
    const chain = side < 0 ? 'stairRailL' : 'stairRailR';
    let prev = null;
    for (let i = 1; i < top.length; i++) {
      const a = top[i - 1], b = top[i];
      const dir = b.clone().sub(a);
      const len = dir.length();
      dir.multiplyScalar(1 / len);
      const e = { a, b, dir, len, kind: 'rail', name: 'stair rail', prop: group, open: null, chain, next: null, prev };
      if (prev) prev.next = e;
      edges.push(e);
      prev = e;
    }
  }
  return { group, edges };
}
