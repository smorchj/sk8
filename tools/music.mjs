// music.mjs — bring the owner's tracks into the game at a web-friendly size and
// a matched level.
//
// The raw takes land 7.7 dB apart (-9.2 to -17.0 LUFS) and four of them peak
// over 0 dBFS, so untouched they jump in volume between tracks and clip on
// decode. Every track is normalised with a two-pass EBU R128 loudnorm to
// -16 LUFS / -1.5 dBTP: matched to each other, and quiet enough that the skate
// SFX sit on top without a duck. In-game volume rides on that, so the mixer
// only ever has to scale one consistent level.
//
// AAC in .m4a because it is the one codec every browser plays (Safari included);
// 128 kbps stereo at 44.1 kHz is transparent enough for background music and
// keeps the repo small.
//
// Usage: node tools/music.mjs "name=path/to.wav" ["name=…" …]
//        node tools/music.mjs --list          (re-read what is already there)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const OUT = 'assets/music';
const TARGET_I = -16, TARGET_TP = -1.5, TARGET_LRA = 11;

// ffmpeg prints its loudnorm report on stderr, so both streams are kept
const ffCapture = (args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  return (r.stdout || '') + (r.stderr || '');
};
const probe = (f) => JSON.parse(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', f], { encoding: 'utf8' })).format;

const args = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });

if (args[0] === '--list') {
  console.log(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  process.exit(0);
}
if (!args.length) { console.error('usage: music.mjs "name=path.wav" …'); process.exit(1); }

const tracks = [];
for (const a of args) {
  const i = a.indexOf('=');
  const name = a.slice(0, i), src = a.slice(i + 1);
  if (!fs.existsSync(src)) { console.error(`missing: ${src}`); process.exit(1); }

  // pass 1 — measure
  const meas = ffCapture(['-i', src, '-af', `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`, '-f', 'null', '-']);
  const json = JSON.parse(meas.slice(meas.lastIndexOf('{'), meas.lastIndexOf('}') + 1));

  // pass 2 — apply the measurement, resample, encode
  const out = path.join(OUT, `${name}.m4a`);
  const filt = `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`
    + `:measured_I=${json.input_i}:measured_TP=${json.input_tp}:measured_LRA=${json.input_lra}`
    + `:measured_thresh=${json.input_thresh}:offset=${json.target_offset}:linear=true:print_format=summary`;
  ffCapture(['-y', '-i', src, '-af', filt, '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]);

  const dur = +(+probe(out).duration).toFixed(2);
  const kb = fs.statSync(out).size / 1024;
  tracks.push({ name, file: `${name}.m4a`, seconds: dur, kb: +kb.toFixed(0) });
  console.log(`${name.padEnd(12)} ${json.input_i.padStart(7)} LUFS -> ${TARGET_I}  ${(kb / 1024).toFixed(2)} MB  ${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}`);
}

fs.writeFileSync(path.join(OUT, 'manifest.json'),
  JSON.stringify({ lufs: TARGET_I, truePeak: TARGET_TP, tracks }, null, 2) + '\n');
const total = tracks.reduce((s, t) => s + t.kb, 0) / 1024;
console.log(`\n${tracks.length} tracks, ${total.toFixed(2)} MB total -> ${OUT}/manifest.json`);
