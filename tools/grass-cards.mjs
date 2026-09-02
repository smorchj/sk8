// grass-cards.mjs — turn the owner's grass clump renders (one clump per image
// on a BLACK background — the PNGs carry no real alpha) into game grass cards:
// alpha keyed from brightness (black → transparent), the generator's sparkle
// badge in the bottom-right corner cleared, cropped to the clump, 1024 px
// wide WebP with alpha.
// Usage: node tools/grass-cards.mjs <srcDir>   (meadow/sparse/dry/lush-source.png)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const src = process.argv[2];
if (!src) { console.error('usage: grass-cards <srcDir>'); process.exit(1); }
const outDir = 'assets/park/grass';
fs.mkdirSync(outDir, { recursive: true });

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

for (const name of ['meadow', 'sparse', 'dry', 'lush']) {
  const file = path.join(src, `${name}-source.png`);
  if (!fs.existsSync(file)) { console.warn('missing', file); continue; }
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const badgeL = Math.round(width * 0.88), badgeT = Math.round(height * 0.80);
  let opaque = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const bright = Math.max(r, g, b);
      let a = smooth(14, 70, bright);                      // black background → clear
      if (x >= badgeL && y >= badgeT) a = 0;               // generator badge
      data[i + 3] = Math.round(a * 255);
      if (a > 0.5) opaque++;
    }
  }
  const keyed = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const trimmed = await sharp(keyed).trim({ threshold: 20 }).toBuffer({ resolveWithObject: true });
  const out = path.join(outDir, `${name}.webp`);
  await sharp(trimmed.data).resize({ width: 1024, withoutEnlargement: true })
    .webp({ quality: 85, alphaQuality: 90 }).toFile(out);
  const meta = await sharp(out).metadata();
  console.log(`${name}: ${width}x${height} (${(100 * opaque / (width * height)).toFixed(0)}% opaque) → ${meta.width}x${meta.height} ${meta.channels}ch  ${(fs.statSync(out).size / 1024).toFixed(0)} KB  aspect ${(meta.width / meta.height).toFixed(3)}`);
}
