// sfx-onsets.mjs — find the transients in a skate SFX clip and pair them into
// pop → land, so a one-shot can be cut and fired on the game's own physics
// events instead of guessed at.
//
// A pop (the tail cracking the ground) and a landing (deck and wheels) are both
// broadband hits with a near-instant attack. The detector pre-emphasises the
// signal (transients live up high; rumble and room tone do not), takes a short
// RMS envelope, and picks peaks off the RISE of that envelope, which fires on
// the attack rather than the loudest point of the decay.
//
// Pairing: a standing ollie's air time is short and consistent, so the first
// strong hit inside [pairMin, pairMax] after a pop is its landing. Hits inside
// the window that are much quieter are the foot dragging up the deck, not a
// landing, so the pair takes the loudest candidate.
//
//   node tools/sfx-onsets.mjs <file> [--pair-min 0.22] [--pair-max 0.85]
//                                    [--sens 1.0] [--json out.json]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
if (!file) { console.error('usage: sfx-onsets <file.mp3> [--pair-min s] [--pair-max s] [--sens k] [--json out]'); process.exit(1); }

const SR = 48000, HOP = 256;                        // 5.33 ms per frame
const PAIR_MIN = +flag('pair-min', 0.22), PAIR_MAX = +flag('pair-max', 0.85);
const SENS = +flag('sens', 1.0);
const MIN_DB = +flag('min-db', -32);            // dB below the loudest hit: quieter than this is room tone, a foot scuff, not a hit

// ── decode to mono float ────────────────────────────────────────────────────
const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'],
  { maxBuffer: 1 << 28, encoding: 'buffer' });
if (dec.status !== 0) { console.error('ffmpeg failed:', dec.stderr?.toString().slice(0, 300)); process.exit(1); }
const pcm = new Int16Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 2));
const N = pcm.length, dur = N / SR;

// ── envelope of the pre-emphasised signal ───────────────────────────────────
const frames = Math.floor((N - HOP) / HOP);
const env = new Float64Array(frames);
let prev = 0;
for (let f = 0; f < frames; f++) {
  let acc = 0;
  for (let i = f * HOP; i < f * HOP + HOP; i++) {
    const x = pcm[i] / 32768;
    const hp = x - 0.97 * prev;                     // pre-emphasis: keep the crack, drop the rumble
    prev = x;
    acc += hp * hp;
  }
  env[f] = Math.sqrt(acc / HOP);
}
// rise only — the attack, not the decay
const rise = new Float64Array(frames);
for (let f = 1; f < frames; f++) rise[f] = Math.max(0, env[f] - env[f - 1]);

// ── adaptive threshold, then peak pick ──────────────────────────────────────
const sorted = Float64Array.from(rise).sort();
const med = sorted[Math.floor(frames * 0.5)];
const p95 = sorted[Math.floor(frames * 0.95)];
const thresh = (med + (p95 - med) * 0.55) / SENS;
const MIN_GAP = Math.round(0.055 / (HOP / SR));     // 55 ms — one hit, not its ringing

const peaks = [];
for (let f = 2; f < frames - 2; f++) {
  if (rise[f] < thresh) continue;
  if (rise[f] < rise[f - 1] || rise[f] < rise[f + 1]) continue;
  if (peaks.length && f - peaks[peaks.length - 1].f < MIN_GAP) {
    if (rise[f] > rise[peaks[peaks.length - 1].f]) peaks[peaks.length - 1] = { f, rise: rise[f] };
    continue;
  }
  peaks.push({ f, rise: rise[f] });
}
// peak loudness = the envelope's height just after the attack
for (const p of peaks) {
  let pk = 0;
  for (let f = p.f; f < Math.min(frames, p.f + 12); f++) pk = Math.max(pk, env[f]);
  p.t = p.f * HOP / SR;
  p.level = pk;
  p.db = 20 * Math.log10(pk + 1e-9);
}

// a real hit stands up against the loudest one; the rest is noise floor and scuffs
const loudest = peaks.reduce((m, p) => Math.max(m, p.db), -999);
const strong = peaks.filter(p => p.db >= loudest + MIN_DB);

// ── pair pop → land ─────────────────────────────────────────────────────────
const used = new Set();
const pairs = [];
for (let i = 0; i < strong.length; i++) {
  if (used.has(i)) continue;
  const pop = strong[i];
  let best = -1;
  for (let j = i + 1; j < strong.length; j++) {
    const dt = strong[j].t - pop.t;
    if (dt < PAIR_MIN) continue;
    if (dt > PAIR_MAX) break;
    if (best < 0 || strong[j].level > strong[best].level) best = j;
  }
  if (best < 0) continue;
  for (let k = i + 1; k <= best; k++) used.add(k);
  pairs.push({ pop, land: strong[best], air: +(strong[best].t - pop.t).toFixed(3) });
}

// ── report ──────────────────────────────────────────────────────────────────
const f3 = (x) => x.toFixed(3).padStart(7);
console.log(`${file}\n  ${dur.toFixed(2)} s, ${peaks.length} transients (${strong.length} strong), ${pairs.length} pop/land pairs`);
console.log(`  threshold ${thresh.toExponential(2)}  (median ${med.toExponential(2)}, p95 ${p95.toExponential(2)})\n`);
console.log('   #     pop      land      air     pop dB   land dB   land-pop dB');
pairs.forEach((p, n) => {
  console.log(`  ${String(n + 1).padStart(2)}  ${f3(p.pop.t)}  ${f3(p.land.t)}  ${f3(p.air)}   ${p.pop.db.toFixed(1).padStart(6)}   ${p.land.db.toFixed(1).padStart(6)}   ${(p.land.db - p.pop.db).toFixed(1).padStart(6)}`);
});
if (pairs.length) {
  const airs = pairs.map(p => p.air).sort((a, b) => a - b);
  const mean = airs.reduce((a, b) => a + b, 0) / airs.length;
  console.log(`\n  air time: min ${airs[0].toFixed(3)}  median ${airs[airs.length >> 1].toFixed(3)}  mean ${mean.toFixed(3)}  max ${airs[airs.length - 1].toFixed(3)} s`);
}
const orphans = strong.filter((p, i) => !pairs.some(q => q.pop === p || q.land === p));
if (orphans.length) console.log(`\n  ${orphans.length} unpaired transient(s): ${orphans.slice(0, 14).map(p => p.t.toFixed(2)).join(', ')}${orphans.length > 14 ? ' …' : ''}`);

const out = flag('json', null);
if (out) {
  fs.writeFileSync(out, JSON.stringify({
    file, duration: +dur.toFixed(3), sampleRate: SR,
    pairs: pairs.map(p => ({ pop: +p.pop.t.toFixed(3), land: +p.land.t.toFixed(3), air: p.air, popDb: +p.pop.db.toFixed(1), landDb: +p.land.db.toFixed(1) })),
    transients: peaks.map(p => ({ t: +p.t.toFixed(3), db: +p.db.toFixed(1) })),
  }, null, 2) + '\n');
  console.log(`\n  wrote ${out}`);
}
