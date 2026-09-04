// sfx-loop.mjs — find the best loopable stretch of a continuous SFX recording
// (rolling wheels, a grind), so the game loops the good part instead of the
// whole take with its walk-ups, bumps and hand-offs.
//
// A good loop is steady (the level does not wander), clean (no transient inside
// it — a crack in a loop becomes a metronome), and it MEETS ITSELF at the seam:
// the last moments have to match the first in level and in spectral balance, or
// every wrap clicks. Each candidate window is scored on those three, and the
// boundaries are then nudged to the nearest zero crossing so the splice cannot
// pop.
//
//   node tools/sfx-loop.mjs <file> [--len 2.0,2.5,3.0] [--top 5]
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
if (!file) { console.error('usage: sfx-loop <file> [--len 2.0,2.5,3.0] [--top 5]'); process.exit(1); }

const SR = 48000, HOP = 256;
const LENS = String(flag('len', '1.5,2.0,2.5,3.0')).split(',').map(Number);
const TOP = +flag('top', 5);

const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'],
  { maxBuffer: 1 << 28, encoding: 'buffer' });
if (dec.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
const pcm = new Int16Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 2));
const N = pcm.length, dur = N / SR;

// ── per-frame level, and a crude 3-band balance for the seam test ───────────
const frames = Math.floor((N - HOP) / HOP);
const rms = new Float64Array(frames), lo = new Float64Array(frames), hi = new Float64Array(frames);
const rise = new Float64Array(frames);
let prev = 0, loS = 0;
for (let f = 0; f < frames; f++) {
  let acc = 0, accHi = 0, accLo = 0;
  for (let i = f * HOP; i < f * HOP + HOP; i++) {
    const x = pcm[i] / 32768;
    acc += x * x;
    const h = x - 0.97 * prev; prev = x;            // pre-emphasised = the top end
    accHi += h * h;
    loS += (x - loS) * 0.02;                        // one-pole low pass ~150 Hz
    accLo += loS * loS;
  }
  rms[f] = Math.sqrt(acc / HOP);
  hi[f] = Math.sqrt(accHi / HOP);
  lo[f] = Math.sqrt(accLo / HOP);
}
for (let f = 1; f < frames; f++) rise[f] = Math.max(0, hi[f] - hi[f - 1]);

const db = (x) => 20 * Math.log10(x + 1e-9);
const mean = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i]; return t / Math.max(1, e - s); };

// a transient scale for this recording, so "clean" means clean FOR THIS TAKE
const riseSorted = Float64Array.from(rise).sort();
const riseP99 = riseSorted[Math.floor(frames * 0.99)];

const cands = [];
const STEP = Math.round(0.05 * SR / HOP);
for (const L of LENS) {
  const W = Math.round(L * SR / HOP);
  if (W >= frames) continue;
  for (let s = 0; s + W < frames; s += STEP) {
    const e = s + W;
    // steadiness: how much the level wanders, in dB
    let m = 0; for (let f = s; f < e; f++) m += db(rms[f]); m /= W;
    let v = 0; for (let f = s; f < e; f++) { const d = db(rms[f]) - m; v += d * d; }
    const wander = Math.sqrt(v / W);
    // cleanliness: the biggest attack inside
    let mx = 0; for (let f = s; f < e; f++) mx = Math.max(mx, rise[f]);
    const spike = mx / (riseP99 + 1e-12);
    // seam: do the last 80 ms match the first 80 ms?
    const B = Math.round(0.08 * SR / HOP);
    const seamLvl = Math.abs(db(mean(rms, s, s + B)) - db(mean(rms, e - B, e)));
    const tone = (a) => db(mean(hi, a, a + B)) - db(mean(lo, a, a + B));
    const seamTone = Math.abs(tone(s) - tone(e - B));
    if (m < -60) continue;                          // near silence is not a roll
    const score = wander * 1.0 + spike * 6.0 + seamLvl * 1.2 + seamTone * 0.8;
    cands.push({ t: s * HOP / SR, len: L, meanDb: m, wander, spike, seamLvl, seamTone, score });
  }
}
cands.sort((a, b) => a.score - b.score);

// keep the best few that do not overlap each other
const picked = [];
for (const c of cands) {
  if (picked.some(p => c.t < p.t + p.len && p.t < c.t + c.len)) continue;
  picked.push(c);
  if (picked.length >= TOP) break;
}

// nudge to zero crossings so the splice cannot click
const zc = (t) => {
  let i = Math.round(t * SR);
  for (let k = 0; k < 2000 && i + k < N - 1; k++) {
    if (pcm[i + k] <= 0 && pcm[i + k + 1] > 0) return (i + k) / SR;
  }
  return t;
};

console.log(`${file}\n  ${dur.toFixed(2)} s   best loops (lower score = steadier, cleaner, better seam)\n`);
console.log('   #     start      len     level    wander   spike   seam dB  seam tone   score');
picked.forEach((c, i) => {
  const a = zc(c.t), b = zc(c.t + c.len);
  console.log(`  ${String(i + 1).padStart(2)}  ${a.toFixed(3).padStart(7)}  ${(b - a).toFixed(3).padStart(7)}  ${c.meanDb.toFixed(1).padStart(7)}  ${c.wander.toFixed(2).padStart(7)}  ${c.spike.toFixed(2).padStart(6)}  ${c.seamLvl.toFixed(2).padStart(7)}  ${c.seamTone.toFixed(2).padStart(8)}  ${c.score.toFixed(2).padStart(6)}`);
});
console.log(`\n  cut the winner with:\n  ffmpeg -i "${file}" -ss ${picked[0] ? zc(picked[0].t).toFixed(3) : '0'} -t ${picked[0] ? (zc(picked[0].t + picked[0].len) - zc(picked[0].t)).toFixed(3) : '0'} -af "afade=t=in:d=0.01,afade=t=out:st=… " out.wav`);
