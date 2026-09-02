// grass.js — instanced grass cards over the meadow, from the owner's clump
// renders (assets/park/grass/*.webp, RGBA). Owner (2026-09-02): the cards
// must NOT get regular direct shadows — they use AO-style shading instead:
// roots darkened, lighting through an UP normal (so a card is lit like the
// ground it stands on, both sides alike), plus a gentle wind sway.
// Cards avoid the plaza, the lot, the path and the props' footprints.

import * as THREE from 'three';

const CARDS = {                         // width (m) of a full-size card, how many, tint
  meadow: { w: 1.5, count: 2600, tint: 0xd6dccb },
  lush: { w: 1.4, count: 1500, tint: 0xd2dcc6 },
  sparse: { w: 1.3, count: 900, tint: 0xd0d4c2 },
  dry: { w: 1.4, count: 800, tint: 0xd4d6c4 },
};
const UP = new THREE.Vector3(0, 1, 0);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// two quads crossed at 90°, standing on y=0, uv v=0 at the roots
function crossedCards(w, h) {
  const pos = [], uv = [], idx = [];
  const quad = (ax, az) => {
    const b = pos.length / 3;
    pos.push(-ax * w / 2, 0, -az * w / 2, ax * w / 2, 0, az * w / 2, ax * w / 2, h, az * w / 2, -ax * w / 2, h, -az * w / 2);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  quad(1, 0);
  quad(0, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3));
  g.setIndex(idx);
  return g;
}

export async function buildGrass({ renderer, exclude, heightAt = () => 0, radius = 90, seed = 7 }) {
  const group = new THREE.Group();
  group.name = 'grass';
  const texLoader = new THREE.TextureLoader();
  const rand = mulberry32(seed);
  const uniforms = { uTime: { value: 0 } };
  const aniso = renderer.capabilities.getMaxAnisotropy();

  for (const [name, cfg] of Object.entries(CARDS)) {
    const map = await texLoader.loadAsync(`assets/park/grass/${name}.webp`);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = aniso;
    const h = cfg.w / (map.image.width / map.image.height);
    const geo = crossedCards(cfg.w, h);
    const mat = new THREE.MeshStandardMaterial({
      map, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1, metalness: 0,
      color: cfg.tint,                       // sit the pale renders into the meadow
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vRoot;\nvarying vec3 vUpN;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vRoot = uv.y;
          vUpN = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
          #ifdef USE_INSTANCING
            float ph = dot(instanceMatrix[3].xz, vec2(0.37, 0.61));
          #else
            float ph = 0.0;
          #endif
          float sway = sin(uTime * 1.7 + ph) * 0.06 + sin(uTime * 3.1 + ph * 1.7) * 0.02;
          transformed.x += sway * uv.y * uv.y;
          transformed.z += sway * 0.5 * uv.y * uv.y;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRoot;\nvarying vec3 vUpN;')
        .replace('#include <normal_fragment_begin>', `
          vec3 normal = normalize(vUpN);
          vec3 nonPerturbedNormal = normal;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb *= mix(0.45, 1.0, smoothstep(0.0, 0.7, vRoot));`);
    };
    const mesh = new THREE.InstancedMesh(geo, mat, cfg.count);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;                // one scatter; fog fades the far ones
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    let placed = 0, tries = 0;
    while (placed < cfg.count && tries < cfg.count * 25) {
      tries++;
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * radius;
      p.set(Math.cos(a) * r, 0, Math.sin(a) * r + 8);
      if (exclude(p.x, p.z)) continue;
      p.y = heightAt(p.x, p.z) - 0.02;
      q.setFromAxisAngle(UP, rand() * Math.PI);
      const sc = 0.7 + rand() * 0.6;
      s.set(sc, sc * (0.85 + rand() * 0.3), sc);
      m.compose(p, q, s);
      mesh.setMatrixAt(placed++, m);
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }
  return { group, update: (dt) => { uniforms.uTime.value += dt; } };
}
