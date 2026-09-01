#!/usr/bin/env node
// optimize-plain.mjs — plain-image optimization of the creator bundle for
// GitHub Pages hosting (owner spec, 2026-09-01): NO KTX2, just downscale —
// nothing above 1024, mouth/teeth capped at 128, eyes at 256. GLB-embedded
// PNG/JPEG textures are resized in place (bin chunk rebuilt, offsets fixed);
// standalone images resized file-level; .char.bin and every other file copied
// verbatim (proprietary format — never touched). Also drops the outfits the
// game no longer offers, keeping the manifest honest.
//
//   node tools/optimize-plain.mjs assets/creator assets/creator-min

import { mkdir, readFile, writeFile, readdir, copyFile, stat, rm } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import sharp from 'sharp';

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) { console.error('usage: node optimize-plain.mjs <in> <out>'); process.exit(1); }

const CAP_DEFAULT = 1024;
const CAP_HAIR = 512;
const CAP_EYES = 256;
const CAP_MOUTH = 128;
const JPEG_Q = 82;
// outfits the game offers (matches js/creator.js OUTFIT_ALLOW)
const OUTFIT_ALLOW = /crop-top|casual|prison/i;

const capFor = (name) => {
  const n = String(name || '').toLowerCase();
  if (/teeth|tongue|mouth/.test(n)) return CAP_MOUTH;
  if (/\beye|iris|sclera|cornea/.test(n)) return CAP_EYES;
  if (/hair|scalp|card|strand|fringe|bun\b|braid/.test(n)) return CAP_HAIR;
  return CAP_DEFAULT;
};

let saved = 0, files = 0;

async function resizeImage(buf, mime, cap) {
  const img = sharp(buf, { limitInputPixels: 1e9 });
  const meta = await img.metadata();
  if (!meta.width || Math.max(meta.width, meta.height) <= cap) return null;
  const resized = img.resize({ width: cap, height: cap, fit: 'inside' });
  if (mime === 'image/png' || meta.format === 'png') return await resized.png({ palette: false }).toBuffer();
  return await resized.jpeg({ quality: JPEG_Q }).toBuffer();
}

// rebuild a GLB with resized embedded images; returns null if nothing shrank
async function optimizeGLB(buf, label) {
  if (buf.readUInt32LE(0) !== 0x46546c67) return null;         // not glb
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart, buf.length);
  if (!json.images?.length || !json.bufferViews) return null;

  // name an image by everything that references it (image name, texture name,
  // material slots) so the caps can find eyes/teeth
  const texOfImage = (idx) => {
    const names = [json.images[idx].name || ''];
    (json.textures || []).forEach((t, ti) => {
      if (t.source === idx) {
        names.push(t.name || '');
        (json.materials || []).forEach(m => {
          for (const slot of ['baseColorTexture', 'metallicRoughnessTexture']) {
            if (m.pbrMetallicRoughness?.[slot]?.index === ti) names.push(m.name || '');
          }
          for (const slot of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) {
            if (m[slot]?.index === ti) names.push(m.name || '');
          }
        });
      }
    });
    return names.join(' ');
  };

  const replacements = new Map();   // bufferView index -> new Buffer
  for (let i = 0; i < json.images.length; i++) {
    const im = json.images[i];
    if (im.bufferView == null) continue;
    const bv = json.bufferViews[im.bufferView];
    const src = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    try {
      const out = await resizeImage(src, im.mimeType, capFor(texOfImage(i)));
      if (out && out.length < src.length) {
        replacements.set(im.bufferView, out);
        if (out !== null && im.mimeType === 'image/png' && out[0] === 0xff) im.mimeType = 'image/jpeg';
      }
    } catch (e) { /* unreadable image: leave as-is */ }
  }
  if (!replacements.size) return null;

  // rebuild the bin chunk preserving bufferView order, 4-byte aligned
  const parts = [];
  let off = 0;
  for (let i = 0; i < json.bufferViews.length; i++) {
    const bv = json.bufferViews[i];
    const data = replacements.get(i) || bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const pad = (4 - (off % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
    bv.byteOffset = off;
    bv.byteLength = data.length;
    parts.push(data);
    off += data.length;
  }
  const endPad = (4 - (off % 4)) % 4;
  if (endPad) { parts.push(Buffer.alloc(endPad)); off += endPad; }
  const newBin = Buffer.concat(parts, off);
  if (json.buffers?.[0]) json.buffers[0].byteLength = newBin.length;

  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' '.repeat(jsonPad))]);
  const total = 12 + 8 + jsonBuf.length + 8 + newBin.length;
  const head = Buffer.alloc(12 + 8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  head.writeUInt32LE(jsonBuf.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(newBin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jsonBuf, binHead, newBin], total);
}

async function walk(src, dst) {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name), d = join(dst, e.name);
    const rel = relative(inDir, s).replace(/\\/g, '/');
    if (e.isDirectory()) {
      // drop outfits the game does not offer
      if (/^outfits$/.test(relative(inDir, src)) === false && /^outfits\//.test(rel + '/')) { /* fallthrough */ }
      await walk(s, d);
      continue;
    }
    files++;
    const ext = extname(e.name).toLowerCase();
    // outfit files not offered by the game: skip entirely
    if (/^outfits\//.test(rel) && !OUTFIT_ALLOW.test(e.name)) { files--; continue; }
    const before = (await stat(s)).size;
    if (ext === '.glb') {
      const out = await optimizeGLB(await readFile(s), rel).catch(err => { console.warn('  glb skip', rel, err.message); return null; });
      if (out) { await writeFile(d, out); saved += before - out.length; continue; }
      await copyFile(s, d);
    } else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
      try {
        const out = await resizeImage(await readFile(s), ext === '.png' ? 'image/png' : 'image/jpeg', capFor(rel));
        if (out) { await writeFile(d, out); saved += before - out.length; continue; }
      } catch { /* copy as-is */ }
      await copyFile(s, d);
    } else {
      await copyFile(s, d);
    }
  }
}

await rm(outDir, { recursive: true, force: true });
await walk(inDir, outDir);

// manifest: keep only the outfits the game offers
const manPath = join(outDir, 'manifest.json');
try {
  const man = JSON.parse(await readFile(manPath, 'utf8'));
  if (man.outfits) {
    for (const k of Object.keys(man.outfits)) {
      if (!OUTFIT_ALLOW.test(k)) delete man.outfits[k];
    }
  }
  await writeFile(manPath, JSON.stringify(man, null, 2));
} catch (e) { console.warn('manifest trim skipped:', e.message); }

console.log(`done — ${files} files, saved ${(saved / 1e6).toFixed(0)} MB`);
