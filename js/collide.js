// collide.js — the static collision world: every park mesh (terrain, stairs,
// props) gets a BVH and the skate physics raycasts against it. Mesh
// collision, not proxies (owner, 2026-09-02: "they need to basically have
// mesh collision").

import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const _m3 = new THREE.Matrix3();

export class CollisionWorld {
  constructor() {
    this.meshes = [];
    this.active = this.meshes;                   // meshes minus the ignored prop
    this.ignored = null;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
    // a small ring of result objects: a caller may hold a hit while it
    // casts again (the ground probe holds its surface while the inside test
    // casts upward). One shared object was the self-jump: whatever the
    // inside test's ray touched overhead — a bench seat, a rail bar, a table
    // top — replaced the ground hit and the rider was placed on it
    this._hits = Array.from({ length: 16 }, () => ({ point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, object: null, backface: false }));
    this._hi = 0;
  }

  // temporarily leave one prop (and everything under it) out of the casts —
  // e.g. the rail you just dropped off, so the first sweeps can't start
  // inside its bar
  setIgnored(root) {
    if (root === this.ignored) return;
    this.ignored = root;
    if (!root) { this.active = this.meshes; return; }
    const under = new Set();
    root.traverse(o => under.add(o));
    this.active = this.meshes.filter(m => !under.has(m));
  }

  // register every mesh under `root` (world matrices must be final); meshes
  // flagged userData.noCollide (a quarter pipe's visual shell) are skipped
  add(root, tag = root.name || 'mesh') {
    root.updateWorldMatrix(true, true);
    root.traverse(o => {
      if (!o.isMesh || !o.geometry || o.userData.noCollide) return;
      if (!o.geometry.boundsTree) o.geometry.boundsTree = new MeshBVH(o.geometry);
      if (o.userData.collider !== 'proxy') o.userData.collider = tag;
      else o.userData.collider = tag;             // proxies report their prop's tag
      this.meshes.push(o);
    });
    if (!this.ignored) this.active = this.meshes;
  }

  clear() {
    this.meshes.length = 0;
    this.ignored = null;
    this.active = this.meshes;
  }

  // nearest surface along a ray; the normal is flipped to face the ray
  // origin so callers always get the side they are on. Returns null if none.
  cast(origin, dir, far) {
    this.ray.set(origin, dir);
    this.ray.far = far;
    this.ray.near = 0;
    const hits = this.ray.intersectObjects(this.active, false);
    if (!hits.length) return null;
    const h = hits[0];
    const out = this._hits[this._hi = (this._hi + 1) % this._hits.length];
    out.point.copy(h.point);
    out.normal.copy(h.face.normal).applyNormalMatrix(_m3.getNormalMatrix(h.object.matrixWorld)).normalize();
    out.backface = out.normal.dot(dir) > 0;      // we hit it from behind = we are inside
    if (out.backface) out.normal.negate();
    out.distance = h.distance;
    out.object = h.object;
    return out;
  }

  // is this point inside a closed mesh? (the first face straight above it is
  // seen from behind)
  inside(point, up = 3) {
    const h = this.cast(point, UP, up);
    return !!(h && h.backface);
  }

  // the same, but only for colliders whose tag passes `tagTest` — our own
  // closed proxies (quarter pipes, the halfpipe). A prop's mesh is an open,
  // double-sided thing (a bench seat has no underside): its backfaces say
  // nothing about being inside, and reading them as "inside" teleported the
  // rider onto the bench
  // (`dir` = which way to look; the rider passes its surface normal — a
  // straight-up ray from a transition's face meets the lip curling over it
  // and read as "inside", stopping every re-entry dead)
  insideOf(point, tagTest, up = 3, dir = UP) {
    const h = this.cast(point, dir, up);
    return !!(h && h.backface && tagTest(h.object.userData.collider || ''));
  }
}

const UP = new THREE.Vector3(0, 1, 0);
