// tile-seams.mjs — read the real joint lines out of the concrete height map, so
// the wheels clunk over the seams you can actually SEE rather than over a guessed
// grid.
//
// The joints are the long dark lines in concrete_h.jpg (dark = deep). Averaging
// the darkness down every column finds the joints that run across the tile;
// averaging along every row finds the ones that run along it. A crack is dark
// too, but it wanders, so it never darkens a whole column or row the way a
// straight joint does — the averaging is what separates them.
//
// Output is in NORMALISED texture coordinates, which the game multiplies by
// TILE.concrete (5.0 x 2.73 m) to get world spacing. Re-run it if the height
// map is ever rebaked.
//
//   node tools/tile-seams.mjs [--in assets/park/textures/concrete_h.jpg]
//                             [--out assets/park/textures/concrete_seams.json]
import fs from 'node:fs';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const IN = flag('in', 'assets/park/textures/concrete_h.jpg');
const OUT = flag('out', 'assets/park/textures/concrete_seams.json');

const { data, info } = await sharp(IN).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const at = (x, y) => data[(y * W + x) * C] / 255;

// darkness profiles, and a robust baseline for each
const prof = (n, m, get) => {
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < m; j++) s += 1 - get(i, j); p[i] = s / m; }
  return p;
};
const cols = prof(W, H, (x, y) => at(x, y));      // vertical joints (constant x)
const rows = prof(H, W, (y, x) => at(x, y));      // horizontal joints (constant y)

// A joint is a run of columns darker than the surround. Threshold at the
// midpoint between the median and the strongest, then take each run's centre.
function lines(p, span) {
  const s = Float64Array.from(p).sort();
  const med = s[Math.floor(s.length * 0.5)];
  const hi = s[Math.floor(s.length * 0.995)];
  const th = med + (hi - med) * 0.45;
  const out = [];
  let a = -1;
  for (let i = 0; i < p.length; i++) {
    if (p[i] >= th) { if (a < 0) a = i; }
    else if (a >= 0) { out.push({ a, b: i - 1 }); a = -1; }
  }
  if (a >= 0) out.push({ a, b: p.length - 1 });
  return out.map(r => {
    // centre of mass of the run, and how deep it is against the median
    let num = 0, den = 0, peak = 0;
    for (let i = r.a; i <= r.b; i++) { const w = p[i] - med; num += i * w; den += w; peak = Math.max(peak, p[i]); }
    return {
      at: +((den ? num / den : (r.a + r.b) / 2) / p.length).toFixed(5),
      width: +(((r.b - r.a + 1) / p.length) * span).toFixed(4),      // metres
      depth: +((peak - med) / (hi - med)).toFixed(3),                 // 0..1, how strong a joint
    };
  }).filter(l => l.depth > 0.35);
}

const TILE = [5.0, 2.73];                        // must match TILE.concrete in js/terrain.js
const across = lines(cols, TILE[0]);             // lines at constant u -> crossed moving in world X
const along = lines(rows, TILE[1]);              // lines at constant v -> crossed moving in world Z

const gaps = (ls, span) => ls.length < 2 ? [] : ls.slice(1).map((l, i) => +((l.at - ls[i].at) * span).toFixed(2));

const out = {
  note: 'joint lines read off the concrete height map by tools/tile-seams.mjs; positions are normalised texture coords',
  source: IN, tile: TILE,
  across: across.map(l => l.at), acrossDepth: across.map(l => l.depth),
  along: along.map(l => l.at), alongDepth: along.map(l => l.depth),
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

console.log(`${IN}  ${W}x${H}`);
console.log(`  across (constant u, ${TILE[0]} m tile): ${across.length} joints`);
across.forEach(l => console.log(`    u ${l.at.toFixed(4)}  x ${(l.at * TILE[0]).toFixed(2)} m  width ${(l.width * 100).toFixed(1)} cm  depth ${l.depth.toFixed(2)}`));
console.log(`    spacing: ${gaps(across, TILE[0]).join(', ')} m`);
console.log(`  along  (constant v, ${TILE[1]} m tile): ${along.length} joints`);
along.forEach(l => console.log(`    v ${l.at.toFixed(4)}  z ${(l.at * TILE[1]).toFixed(2)} m  width ${(l.width * 100).toFixed(1)} cm  depth ${l.depth.toFixed(2)}`));
console.log(`    spacing: ${gaps(along, TILE[1]).join(', ')} m`);
console.log(`\n  wrote ${OUT}`);
