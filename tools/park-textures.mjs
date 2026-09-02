// park-textures.mjs — bring the owner's tileable ground textures (and their
// normal maps) into the game at a web-friendly size: 2048 wide, aspect kept.
// Albedo → JPEG q85 (sRGB); normals → JPEG q92 (linear data, no color space).
// Usage: node tools/park-textures.mjs name=path [name=path …]
//   e.g. grass=… concrete=… asphalt=… concrete_n=… asphalt_n=…
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2).map(a => a.split('='));
if (!args.length) { console.error('usage: park-textures name=path …'); process.exit(1); }
const outDir = 'assets/park/textures';
fs.mkdirSync(outDir, { recursive: true });
for (const [name, src] of args) {
  const isNormal = /_n$/.test(name);
  const out = path.join(outDir, name + '.jpg');
  const meta = await sharp(src).metadata();
  await sharp(src).resize({ width: 2048, withoutEnlargement: true })
    .jpeg({ quality: isNormal ? 92 : 85, mozjpeg: true, chromaSubsampling: isNormal ? '4:4:4' : '4:2:0' })
    .toFile(out);
  console.log(`${name}: ${meta.width}x${meta.height} → ${out} ${(fs.statSync(out).size / 1024).toFixed(0)} KB${isNormal ? ' (normal map)' : ''}`);
}
