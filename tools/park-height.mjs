// park-height.mjs — bring a grayscale HEIGHT map for a ground texture into the
// game, and bake the tangent-space NORMAL that belongs to it.
//
// The owner's concrete height map is the grayscale twin of concrete.jpg: same
// joints, same cracks, same grass tufts, pixel for pixel. Resizing it to the
// albedo's exact size keeps that registration, so the shader can use one uv for
// colour, depth and blending. Dark = deep (joint / crack), light = high (tile
// top, grass tufts standing proud).
//
// Outputs (assets/park/textures/):
//   <name>_h.jpg   grayscale height, albedo-sized, JPEG q94 (luma table only)
//   <name>_hn.jpg  normal from that height, OpenGL convention (+Y up), q94 4:4:4
//
// Usage: node tools/park-height.mjs <name> <height-src> [--ref=path] [--strength=6]
//   e.g. node tools/park-height.mjs concrete ~/Downloads/height.jpg
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const [name, src] = argv.filter(a => !a.startsWith('--'));
if (!name || !src) { console.error('usage: park-height <name> <height-src> [--ref=path] [--strength=6]'); process.exit(1); }

const outDir = 'assets/park/textures';
const ref = flags.ref || path.join(outDir, name + '.jpg');       // the albedo we must register with
const strength = Number(flags.strength ?? 6);
const blur = Number(flags.blur ?? 0.8);                          // tames JPEG grain before the Sobel

const rm = await sharp(ref).metadata();
const W = rm.width, H = rm.height;
const sm = await sharp(src).metadata();
const drift = Math.abs((sm.width / sm.height) / (W / H) - 1) * 100;
console.log(`ref ${path.basename(ref)} ${W}x${H} · src ${sm.width}x${sm.height} · aspect drift ${drift.toFixed(2)}%`);
if (drift > 1) console.warn('  ! over 1% — the height will not register with the albedo across the tile');

// ── height: exactly the albedo's pixel grid, single channel ────────────────
const hOut = path.join(outDir, `${name}_h.jpg`);
await sharp(src).resize(W, H, { fit: 'fill' }).toColourspace('b-w')
  .jpeg({ quality: 94, mozjpeg: true }).toFile(hOut);

// ── normal: Sobel on the (slightly blurred) height, wrapping at the seams ──
const { data: h } = await sharp(src).resize(W, H, { fit: 'fill' }).toColourspace('b-w')
  .blur(blur).raw().toBuffer({ resolveWithObject: true });
const nrm = Buffer.alloc(W * H * 3);
const at = (x, y) => h[((y + H) % H) * W + ((x + W) % W)] / 255;   // wrap keeps the tile seamless
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // 3x3 Sobel: gx along the image +x (= uv +u), gy along the image +y
    const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
    const l = at(x - 1, y), r = at(x + 1, y);
    const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
    const gx = ((tr + 2 * r + br) - (tl + 2 * l + bl)) / 8;
    const gy = ((bl + 2 * b + br) - (tl + 2 * t + tr)) / 8;
    // three loads the JPEG flipped (uv v=0 is the bottom row), so +v is -y:
    // n = normalize(-dh/du, -dh/dv, 1) = normalize(-gx, +gy, 1/strength)
    let nx = -gx * strength, ny = gy * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    const k = (y * W + x) * 3;
    nrm[k] = Math.round((nx / len * 0.5 + 0.5) * 255);
    nrm[k + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
    nrm[k + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
  }
}
const nOut = path.join(outDir, `${name}_hn.jpg`);
await sharp(nrm, { raw: { width: W, height: H, channels: 3 } })
  .jpeg({ quality: 94, mozjpeg: true, chromaSubsampling: '4:4:4' }).toFile(nOut);

const kb = f => (fs.statSync(f).size / 1024).toFixed(0) + ' KB';
console.log(`${hOut} ${kb(hOut)}  (height)`);
console.log(`${nOut} ${kb(nOut)}  (normal from height, strength ${strength})`);
