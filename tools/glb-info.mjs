// glb-info.mjs — quick GLB inspector (no three.js needed): bbox from POSITION
// accessor min/max, node/mesh names, triangle count, images (mime + bytes).
// Usage: node tools/glb-info.mjs <file.glb> [...more]
import fs from 'node:fs';
import path from 'node:path';

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('not a GLB: ' + file);
  const len = buf.readUInt32LE(8);
  let off = 12; let json = null; let bin = null;
  while (off < len) {
    const clen = buf.readUInt32LE(off), ctype = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + clen);
    if (ctype === 0x4E4F534A) json = JSON.parse(chunk.toString('utf8'));
    else if (ctype === 0x004E4942) bin = chunk;
    off += 8 + clen;
  }
  return { json, bin };
}

function mat4(node) {
  if (node.matrix) return node.matrix;
  const t = node.translation || [0, 0, 0], r = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
  const [x, y, z, w] = r;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0,
    (2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0,
    (2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1];
}
const mul = (a, b) => { // a*b column-major
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];

for (const file of process.argv.slice(2)) {
  const { json, bin } = readGlb(file);
  const acc = json.accessors || [], bv = json.bufferViews || [];
  let tris = 0; let verts = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const meshNames = new Set();
  const visit = (ni, parent) => {
    const n = json.nodes[ni]; const m = mul(parent, mat4(n));
    if (n.mesh != null) {
      const mesh = json.meshes[n.mesh]; meshNames.add(mesh.name || ('mesh' + n.mesh));
      for (const prim of mesh.primitives) {
        const pa = acc[prim.attributes.POSITION];
        verts += pa.count;
        tris += prim.indices != null ? acc[prim.indices].count / 3 : pa.count / 3;
        for (const cx of [0, 1]) for (const cy of [0, 1]) for (const cz of [0, 1]) {
          const p = xform(m, [cx ? pa.max[0] : pa.min[0], cy ? pa.max[1] : pa.min[1], cz ? pa.max[2] : pa.min[2]]);
          for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
        }
      }
    }
    for (const c of n.children || []) visit(c, m);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  for (const r of scene?.nodes || []) visit(r, I);
  const images = (json.images || []).map(im => ({ mime: im.mimeType, kb: im.bufferView != null ? Math.round(bv[im.bufferView].byteLength / 1024) : null, name: im.name }));
  const size = max.map((v, i) => +(v - min[i]).toFixed(3));
  console.log(`== ${path.basename(file)}  ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
  console.log(`   bbox min ${min.map(v => +v.toFixed(3))} max ${max.map(v => +v.toFixed(3))}  size ${size}`);
  console.log(`   tris ${Math.round(tris)}  verts ${verts}  meshes [${[...meshNames].join(', ')}]  materials ${json.materials?.length || 0}  ext ${(json.extensionsUsed || []).join(',')}`);
  console.log(`   images: ${images.map(i => `${i.mime} ${i.kb}KB`).join(' | ')}`);
}
