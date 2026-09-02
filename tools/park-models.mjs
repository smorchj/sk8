// park-models.mjs — build the park's model set from the owner's Meshy exports.
//
// * The 7 "mini ramp" GLBs share the EXACT mesh (owner, 2026-09-02): keep ONE
//   optimized geometry (ramp.glb) and only the base-color texture of each
//   variant (ramp_tex/v1..7.webp) — instances swap the map at runtime.
// * Everything else is optimized with gltf-transform: meshopt compression,
//   mesh simplification, 1024px WebP textures.
//
// Usage: node tools/park-models.mjs            (reads C:\Users\smorc\Downloads)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import sharp from 'sharp';

const DL = 'C:/Users/smorc/Downloads/';
const OUT = 'assets/park';
const glb = (stem) => `${DL}Meshy_AI_${stem}_texture.glb`;

const RAMP_VARIANTS = [
  'Rustic_Mini_Ramp_0828080600', 'Rustic_Mini_Ramp_0828080806', 'Rustic_Mini_Ramp_0828081013',
  'Rustic_Mini_Ramp_0828081024', 'Rustic_Mini_Ramp_0828081312', 'Rustic_Mini_Ramp_0828081319',
  '_0828080509',
];
const MODELS = {                       // out name → source stem
  ramp: RAMP_VARIANTS[0],
  ramp2: '_0828081413',
  ramp_haven: 'Graffiti_Ramp_Haven_0827183823',
  picnic_table: 'Green_Grate_Picnic_Ta_0828074552',
  skatepark_geo: 'Empty_Skatepark_Geome_0828074545',
  grind_rail: 'Neon_Grind_Rail_0828074556',
  curve_bridge: 'Graffiti_Curve_Bridge_0828074603',
};

function readGlb(file) {
  const buf = fs.readFileSync(file);
  const len = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < len) {
    const clen = buf.readUInt32LE(off), ctype = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + clen);
    if (ctype === 0x4E4F534A) json = JSON.parse(chunk.toString('utf8'));
    else if (ctype === 0x004E4942) bin = chunk;
    off += 8 + clen;
  }
  return { json, bin };
}

function baseColor(file) {
  const { json, bin } = readGlb(file);
  const mat = json.materials[0];
  const ti = mat.pbrMetallicRoughness?.baseColorTexture?.index;
  if (ti == null) throw new Error('no baseColorTexture in ' + file);
  const im = json.images[json.textures[ti].source];
  const bv = json.bufferViews[im.bufferView];
  return { bytes: bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), mime: im.mimeType };
}

fs.mkdirSync(`${OUT}/ramp_tex`, { recursive: true });

// 1) ramp variant textures
for (let i = 0; i < RAMP_VARIANTS.length; i++) {
  const { bytes } = baseColor(glb(RAMP_VARIANTS[i]));
  const out = `${OUT}/ramp_tex/v${i + 1}.webp`;
  await sharp(bytes).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(out);
  console.log(`ramp texture v${i + 1} ← ${RAMP_VARIANTS[i]}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

// 2) optimized models (reuse a previous _scratch/opt run when present)
for (const [name, stem] of Object.entries(MODELS)) {
  const out = `${OUT}/${name}.glb`;
  const cached = `_scratch/opt/${stem}.glb`;
  if (fs.existsSync(cached)) { fs.copyFileSync(cached, out); console.log(`${name}: from cache  ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`); continue; }
  const src = glb(stem);
  const simplify = ['ramp', 'ramp2'].includes(name) ? '' : ' --simplify true --simplify-error 0.0005';
  execSync(`npx --yes @gltf-transform/cli optimize "${src}" "${out}" --compress meshopt --texture-compress webp --texture-size 1024${simplify}`, { stdio: 'inherit' });
  console.log(`${name}: ${(fs.statSync(src).size / 1048576).toFixed(1)} MB → ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
}
