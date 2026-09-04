// terrain.js — the park ground as ONE mesh with two levels (owner's reference:
// a raised concrete pad with a staircase down to the street slab), a grass
// bank between them, small undulations on the grass, and a blended ground
// shader: grass / cracked concrete / asphalt feathered by noise, with the
// paving's joints given real depth and grass growing up out of them — both
// read off the owner's concrete HEIGHT map, which registers pixel for pixel
// with the concrete albedo. The stairs are separate concrete boxes.

import * as THREE from 'three';

export const LEVEL = { lower: 0, upper: 0.72 };
export const BANK = { z0: -5.5, z1: 0 };            // bank between the levels (z0 lower → z1 upper)
export const STAIRS = { hw: 2.4, z0: -1.6, z1: 0, steps: 4 };   // corridor |x|<hw, treads from z0 up to z1

// concrete / asphalt footprints (world XZ, centre + half sizes)
export const RECTS = {
  concrete: [
    { x: 0, z: -18, hw: 22, hd: 12 },       // the street slab (lower level)
    { x: 0, z: 8, hw: 18, hd: 8 },          // the raised pad
    { x: 0, z: 22, hw: 2, hd: 6 },          // pad → lot path
    { x: 0, z: -2.8, hw: STAIRS.hw, hd: 2.8 },   // stairs corridor
  ],
  asphalt: [
    { x: 0, z: 37, hw: 30, hd: 10 },        // the lot
  ],
};
export const TILE = { grass: [5.2, 2.84], concrete: [5.0, 2.73], asphalt: [3.2, 1.75] };

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rectSdf = (r, x, z) => {
  const dx = Math.abs(x - r.x) - r.hw, dz = Math.abs(z - r.z) - r.hd;
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
};
// value noise (JS twin of the shader's — same shape, not bit-identical)
const hash21 = (x, y) => { let px = (x * 123.34) % 1, py = (y * 456.21) % 1; if (px < 0) px += 1; if (py < 0) py += 1; const d = px * px + py * py + (px + py) * 45.32; px += d; py += d; const v = (px * py) % 1; return v < 0 ? v + 1 : v; };
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy), b = hash21(ix + 1, iy), c = hash21(ix, iy + 1), d = hash21(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
export function fbm(x, y) { let v = 0, a = 0.5; for (let i = 0; i < 3; i++) { v += a * vnoise(x, y); x *= 2.03; y *= 2.03; a *= 0.5; } return v; }

// hard-surface mask (0 grass … 1 paved) — the shader's twin, used to keep
// grass cards off the concrete and to keep the paved ground flat
export function pavedMask(x, z) {
  let sd = 1e9;
  for (const r of RECTS.concrete) sd = Math.min(sd, rectSdf(r, x, z));
  for (const r of RECTS.asphalt) sd = Math.min(sd, rectSdf(r, x, z));
  const n = (fbm(x * 0.35, z * 0.35) - 0.5) * 2.2;
  return 1 - smooth(-0.9, 0.9, sd + n);
}

// Which ground you are standing on, by the SAME rects and noise the shader
// blends with — the whole park floor is one mesh under one collider tag, so a
// collision tag cannot tell grass from concrete from asphalt. The audio asks
// this so each surface can sound like itself.
export function groundKind(x, z) {
  let sdC = 1e9, sdA = 1e9;
  for (const r of RECTS.concrete) sdC = Math.min(sdC, rectSdf(r, x, z));
  for (const r of RECTS.asphalt) sdA = Math.min(sdA, rectSdf(r, x, z));
  const n = (fbm(x * 0.35, z * 0.35) - 0.5) * 2.2;
  const mC = 1 - smooth(-0.9, 0.9, sdC + n);
  if (mC > 0.5) return 'concrete';
  const mA = (1 - smooth(-0.9, 0.9, sdA + n)) * (1 - mC);
  if (mA > 0.5) return 'asphalt';
  return 'grass';
}

// analytic ground height (the mesh samples this)
export function heightAt(x, z) {
  // the corridor cut stays strictly under the stair boxes (mesh vertices sit
  // every 0.4 m; a cut at the landing edge made a dip in front of the top step)
  const inCorridor = Math.abs(x) < STAIRS.hw && z < STAIRS.z1 - 0.45;
  let h = inCorridor ? LEVEL.lower : LEVEL.lower + (LEVEL.upper - LEVEL.lower) * smooth(BANK.z0, BANK.z1, z);
  // gentle undulation on the grass only
  const paved = pavedMask(x, z);
  const bank = (z > BANK.z0 - 1 && z < BANK.z1 + 1) ? 1 : 0;
  h += (fbm(x * 0.09, z * 0.09) - 0.5) * 0.16 * (1 - paved) * (1 - bank);
  return h;
}

function makeTerrainGeometry(size = 150, step = 0.4, cz = 8) {
  const n = Math.round(size / step) + 1;
  const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++, k++) {
      const x = -size / 2 + i * step, z = cz - size / 2 + j * step;
      pos[k * 3] = x; pos[k * 3 + 1] = heightAt(x, z); pos[k * 3 + 2] = z;
      uv[k * 2] = x; uv[k * 2 + 1] = z;              // uv = world metres (tangent frame + tiling)
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let t = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

const GLSL_NOISE = `
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; } return v; }
float rectSdf(vec2 p, vec4 r){ vec2 d = abs(p - r.xy) - r.zw; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
`;

// how the paving reads — the owner's height map (assets/park/textures/
// concrete_h.jpg) drives BOTH the relief and the grass line, so the joints that
// are dark in the albedo are the joints that sink and the joints grass grows
// out of. Live-tunable: SK8.park.ground.set({ depth: 0.05 }).
export const GROUND = {
  depth: 0.035,               // how deep the joints read, in metres
  fadeNear: 16, fadeFar: 44,  // the relief fades out over this distance (m)
  fillFar: 0.06,              // grass level out on the open paving (height units)
  fillEdge: 0.82,             // grass level right at the paving's edge
  fillReach: 4.5,             // how far in from the edge the level falls back (m)
  fillNoise: 0.16,            // the waterline wanders instead of running level
  soft: 0.07,                 // softness of the grass/concrete line, in height units
  crackAO: 0.55,              // how dark a deep joint goes
};

// the blended ground material (MeshStandardMaterial + custom layer blend)
export function makeGroundMaterial(tex) {
  const rectsC = RECTS.concrete.map(r => new THREE.Vector4(r.x, r.z, r.hw, r.hd));
  const rectsA = RECTS.asphalt.map(r => new THREE.Vector4(r.x, r.z, r.hw, r.hd));
  const u = {
    tGrass: { value: tex.grass }, tGrassN: { value: tex.grassN },
    tConcrete: { value: tex.concrete }, tConcreteN: { value: tex.concreteHN },
    tConcreteH: { value: tex.concreteH },
    tAsphalt: { value: tex.asphalt }, tAsphaltN: { value: tex.asphaltN },
    tileG: { value: new THREE.Vector2(...TILE.grass) },
    tileC: { value: new THREE.Vector2(...TILE.concrete) },
    tileA: { value: new THREE.Vector2(...TILE.asphalt) },
    rectsC: { value: rectsC }, rectsA: { value: rectsA },
    uDepth: { value: GROUND.depth },
    uFade: { value: new THREE.Vector2(GROUND.fadeNear, GROUND.fadeFar) },
    uFill: { value: new THREE.Vector4(GROUND.fillFar, GROUND.fillEdge, GROUND.fillReach, GROUND.fillNoise) },
    uSoft: { value: GROUND.soft },
    uCrackAO: { value: GROUND.crackAO },
  };
  const mat = new THREE.MeshStandardMaterial({
    map: tex.grass, normalMap: tex.concreteHN, roughness: 0.93, metalness: 0,
  });
  mat.normalScale.set(1.0, 1.0);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorldPos;
        uniform sampler2D tGrass, tGrassN, tConcrete, tConcreteN, tConcreteH, tAsphalt, tAsphaltN;
        uniform vec2 tileG, tileC, tileA, uFade;
        uniform vec4 uFill;
        uniform float uDepth, uSoft, uCrackAO;
        uniform vec4 rectsC[${rectsC.length}];
        uniform vec4 rectsA[${rectsA.length}];
        ${GLSL_NOISE}
        // The paving is flat (pavedMask keeps the undulation off it), so the eye
        // ray can be marched straight against the world y plane — no tangent
        // frame needed. Returns the uv the eye really lands on once the joints
        // have their depth; height 0 = deep joint, 1 = tile top.
        vec2 parallaxUv(vec2 uv0, vec3 V, float depth) {
          vec2 duvAll = (-V.xz / max(V.y, 0.30)) * depth / tileC;   // uv crossed over the full depth
          float layers = mix(6.0, 16.0, clamp(1.0 - V.y, 0.0, 1.0)); // more steps the flatter we look
          float dz = 1.0 / layers;
          vec2 duv = duvAll * dz, uv = uv0, prevUv = uv0;
          float t = 0.0, d = 1.0 - texture2D(tConcreteH, uv0).r, pt = 0.0, pd = d;
          for (int i = 0; i < 16; i++) {
            if (float(i) >= layers || d <= t) break;
            pt = t; pd = d; prevUv = uv;
            t += dz; uv += duv;
            d = 1.0 - texture2D(tConcreteH, uv).r;
          }
          float a = d - t, b = pd - pt;                    // a <= 0 < b at the crossing
          return mix(uv, prevUv, clamp(a / min(a - b, -1e-5), 0.0, 1.0));
        }
        // layer weights: x = concrete, y = asphalt, z = paving cover before the
        // grass line (the joints keep their groove and their shade under grass)
        vec3 groundMasks(vec2 p, float h) {
          float sdC = 1e9; for (int i = 0; i < ${rectsC.length}; i++) sdC = min(sdC, rectSdf(p, rectsC[i]));
          float sdA = 1e9; for (int i = 0; i < ${rectsA.length}; i++) sdA = min(sdA, rectSdf(p, rectsA[i]));
          float n = (fbm(p * 0.35) - 0.5) * 2.2;                    // natural wobble of the edge
          float cover = 1.0 - smoothstep(-0.9, 0.9, sdC + n);
          float mA = 1.0 - smoothstep(-0.9, 0.9, sdA + n);
          // Grass rises into the paving like water: it fills the joints first
          // and only reaches the tile tops at the very edge, so the boundary
          // runs along the cracks instead of across a straight noise line.
          float edge = smoothstep(-uFill.z, 0.2, sdC + n * 0.5);
          float level = mix(uFill.x, uFill.y, edge) + (fbm(p * 0.8) - 0.5) * uFill.w;
          float mC = cover * smoothstep(level - uSoft, level + uSoft, h);
          mA *= 1.0 - mC;
          return vec3(mC, mA, cover);
        }`)
      .replace('#include <map_fragment>', `
        vec2 p = vWorldPos.xz;
        vec3 Vw = cameraPosition - vWorldPos;
        float viewDist = length(Vw);
        Vw /= max(viewDist, 1e-4);
        vec2 uvG = p / tileG, uvA = p / tileA, uvC = p / tileC;
        float relief = uDepth * (1.0 - smoothstep(uFade.x, uFade.y, viewDist));
        if (relief > 0.0004) uvC = parallaxUv(uvC, Vw, relief);     // the joints sink
        float hC = texture2D(tConcreteH, uvC).r;
        vec3 mk = groundMasks(p, hC);
        vec3 cG = texture2D(tGrass, uvG).rgb;
        cG *= 0.82 + 0.36 * fbm(p * 0.03);                         // breaks the tiling
        vec3 cC = texture2D(tConcrete, uvC).rgb * 0.92;
        vec3 cA = texture2D(tAsphalt, uvA).rgb;
        vec3 albedo = mix(mix(cG, cC, mk.x), cA, mk.y);
        // a joint sits in its own shade — the grass that filled it does too
        albedo *= mix(1.0, mix(uCrackAO, 1.0, smoothstep(0.0, 0.5, hC)), mk.z);
        diffuseColor.rgb *= albedo;
        float slope = 1.0 - clamp(normalize(vNormal).y, 0.0, 1.0);
        diffuseColor.rgb *= 1.0 - 0.15 * slope;`)
      .replace('#include <normal_fragment_maps>', `
        vec3 nC = texture2D(tConcreteN, uvC).xyz * 2.0 - 1.0;
        vec3 nG = texture2D(tGrassN, uvG).xyz * 2.0 - 1.0;
        vec3 nA = texture2D(tAsphaltN, uvA).xyz * 2.0 - 1.0;
        // blended on the paving's COVER, not on the grass line: a joint is a
        // groove whatever grows in it
        vec3 mapN = normalize(mix(mix(nG * vec3(0.6, 0.6, 1.0), nC, mk.z), nA * vec3(0.7, 0.7, 1.0), mk.y));
        mapN.xy *= normalScale;
        normal = normalize(tbn * mapN);`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = mix(0.96, mix(0.95, 0.86, smoothstep(0.25, 0.62, hC)), mk.x);`);
  };
  mat.customProgramCacheKey = () => 'sk8-ground';
  // live tuning (LAW ZERO: we look at the render while we turn the knobs)
  mat.userData.ground = {
    get: () => ({ ...GROUND }),
    set(o) {
      Object.assign(GROUND, o);
      u.uDepth.value = GROUND.depth;
      u.uFade.value.set(GROUND.fadeNear, GROUND.fadeFar);
      u.uFill.value.set(GROUND.fillFar, GROUND.fillEdge, GROUND.fillReach, GROUND.fillNoise);
      u.uSoft.value = GROUND.soft;
      u.uCrackAO.value = GROUND.crackAO;
      return { ...GROUND };
    },
  };
  return mat;
}

// the stairs: concrete boxes stacked in the corridor (also colliders)
export function makeStairs(concreteMat) {
  const g = new THREE.Group();
  g.name = 'stairs';
  const rise = (LEVEL.upper - LEVEL.lower) / STAIRS.steps;
  const tread = (STAIRS.z1 - STAIRS.z0) / STAIRS.steps;
  for (let i = 0; i < STAIRS.steps; i++) {
    const z0 = STAIRS.z0 + i * tread;
    const h = rise * (i + 1);
    const box = new THREE.Mesh(new THREE.BoxGeometry(STAIRS.hw * 2, h, STAIRS.z1 - z0), concreteMat);
    box.position.set(0, LEVEL.lower + h / 2, (z0 + STAIRS.z1) / 2);
    box.castShadow = true; box.receiveShadow = true;
    g.add(box);
  }
  return g;
}

export function makeTerrain(tex) {
  const mesh = new THREE.Mesh(makeTerrainGeometry(), makeGroundMaterial(tex));
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}
