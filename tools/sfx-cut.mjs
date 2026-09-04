// sfx-cut.mjs — cut the game's one-shots out of the owner's SFX takes.
//
// The cut points come from tools/sfx-onsets.mjs (pop/land transients) and
// tools/sfx-loop.mjs (the steadiest loopable stretch). They are written down
// here rather than re-detected, so a re-run always produces the same files.
//
// WAV, mono, 44.1 kHz, 16-bit — not AAC. A one-shot has to fire on the frame
// the physics says so, and every AAC decoder prepends priming samples, which
// puts a few milliseconds of silence in front of a crack that is supposed to be
// instant. The roll loop needs sample-exact ends for the same reason: its
// boundaries sit on zero crossings and get NO fade, because a fade at each end
// is a dip you would hear once per loop.
//
//   node tools/sfx-cut.mjs [--src <dir>] [--out assets/sfx]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const SRC = flag('src', 'C:/Users/smorc/Downloads/skate-sounds-mp3/skate sounds');
const OUT = flag('out', 'assets/sfx');
const SR = 44100;

// name, source, start, length, peak target dBFS, fades (ms in/out)
// The ollie take is three performances repeated three times over (the same air
// times and levels recur at +8.32 s and +16.40 s), so only the first of each is
// cut. A pop ends before its own landing; the air is silent.
const CUTS = [
  // ── ollie: the tail cracking the ground ──────────────────────────────────
  { name: 'ollie_pop_1', src: '02_ollie_pop/ollie_standing_01.mp3', t: 4.502, len: 0.30, db: -3, fade: [1, 40] },
  { name: 'ollie_pop_2', src: '02_ollie_pop/ollie_standing_01.mp3', t: 7.164, len: 0.30, db: -3, fade: [1, 40] },
  { name: 'ollie_pop_3', src: '02_ollie_pop/ollie_standing_01.mp3', t: 9.969, len: 0.30, db: -3, fade: [1, 40] },
  // ── ollie: deck and wheels coming down ───────────────────────────────────
  { name: 'ollie_land_1', src: '02_ollie_pop/ollie_standing_01.mp3', t: 4.993, len: 0.45, db: -3, fade: [1, 60] },
  { name: 'ollie_land_2', src: '02_ollie_pop/ollie_standing_01.mp3', t: 7.590, len: 0.45, db: -3, fade: [1, 60] },
  { name: 'ollie_land_3', src: '02_ollie_pop/ollie_standing_01.mp3', t: 10.406, len: 0.45, db: -3, fade: [1, 60] },
  // ── the revert's scrape (7 takes in the source; the three cleanest) ──────
  { name: 'revert_1', src: '05_slide/revert_01.mp3', t: 1.600, len: 1.05, db: -4, fade: [2, 80] },
  { name: 'revert_2', src: '05_slide/revert_01.mp3', t: 10.300, len: 0.82, db: -4, fade: [2, 80] },
  { name: 'revert_3', src: '05_slide/revert_01.mp3', t: 17.440, len: 0.86, db: -4, fade: [2, 80] },
  // ── rolling: the steadiest stretch of the take, looped ───────────────────
  { name: 'roll_loop', src: '01_roll/rolling_01.mp3', t: 2.065, len: 1.499, db: -6, fade: [0, 0], loop: true },
];

fs.mkdirSync(OUT, { recursive: true });

// Each source is decoded ONCE, whole, and sliced by sample index. ffmpeg's
// -ss seek on an MP3 is a fast frame seek that drifts tens of milliseconds —
// enough to cut in past a transient and leave a one-shot that is nothing but
// the decay (it put a -33 dBFS 'pop' and a -42 dBFS 'landing' in the first run).
const cache = new Map();
const whole = (file) => {
  if (!cache.has(file)) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'],
      { maxBuffer: 1 << 28, encoding: 'buffer' });
    if (r.status !== 0) { console.error('decode failed:', file, r.stderr?.toString().slice(0, 200)); process.exit(1); }
    cache.set(file, new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2)));
  }
  return cache.get(file);
};
const decode = (file, t, len) => {
  const pcm = whole(file);
  const a = Math.max(0, Math.round(t * SR)), b = Math.min(pcm.length, Math.round((t + len) * SR));
  return pcm.subarray(a, b);
};

const wav = (samples) => {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], 44 + i * 2);
  return b;
};

const manifest = [];
for (const c of CUTS) {
  const src = path.join(SRC, c.src);
  const raw = decode(src, c.t, c.len);
  const n = raw.length;
  const out = new Int16Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(raw[i]));
  const gain = peak ? (Math.pow(10, c.db / 20) * 32767) / peak : 1;
  const fi = Math.round(c.fade[0] / 1000 * SR), fo = Math.round(c.fade[1] / 1000 * SR);
  for (let i = 0; i < n; i++) {
    let g = gain;
    if (fi && i < fi) g *= i / fi;
    if (fo && i > n - fo) g *= (n - i) / fo;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(raw[i] * g)));
  }
  const file = path.join(OUT, c.name + '.wav');
  fs.writeFileSync(file, wav(out));
  const kb = fs.statSync(file).size / 1024;
  manifest.push({ name: c.name, file: c.name + '.wav', seconds: +(n / SR).toFixed(3), loop: !!c.loop, kb: +kb.toFixed(0) });
  console.log(`${c.name.padEnd(14)} ${(n / SR).toFixed(3)}s  ${kb.toFixed(0).padStart(4)} KB  peak ${(20 * Math.log10(peak / 32768)).toFixed(1)} -> ${c.db} dBFS${c.loop ? '  (loop, no fades)' : ''}`);
}

fs.writeFileSync(path.join(OUT, 'manifest.json'),
  JSON.stringify({ sampleRate: SR, note: 'cut by tools/sfx-cut.mjs from the owner\'s takes', clips: manifest }, null, 2) + '\n');
console.log(`\n${manifest.length} clips, ${(manifest.reduce((s, m) => s + m.kb, 0) / 1024).toFixed(2)} MB -> ${OUT}/manifest.json`);
