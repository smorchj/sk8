#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// Pull an embed project's assets to disk, once, at BUILD TIME.
//
//   node fetch-assets.mjs --project <uuid> --key ggc_read_... --out ./assets
//
// WHY THIS SHIPS WITH THE SDK: every integrator was writing this themselves, and
// getting it wrong in the same three ways — driving a headless browser to download
// files that are plain HTTP, guessing asset URLs, and re-fetching 100 MB on every
// build. It is twenty lines of curl once you know the URLs; the whole problem was
// never knowing them.
//
// TWO KEYS, TWO JOBS — do not mix them up:
//   • ggc_read_…  (this script)  server-to-server, no browser. Reads your project
//     manifest so the script knows WHAT to fetch. Get one at /profile.html.
//   • ggc_proj_…  (your game)    browser-only, locked to your site's origin, and
//     validated at runtime by Creator.open(). Never put it in a build script; it
//     will not work, because a Node process has no Origin header to present.
//
// THE ASSETS THEMSELVES ARE NOT GATED. Only the manifest read is authenticated.
// You are downloading them so they can sit on YOUR hosting and be served to YOUR
// players — that is the design, and it is why embedding costs you no bandwidth
// from us and no per-player fee.
// ────────────────────────────────────────────────────────────────────────────
import { mkdir, writeFile, readFile, stat, readdir, copyFile } from 'node:fs/promises';
import { join, dirname, resolve, parse as parsePath, sep as pathSep } from 'node:path';
import { homedir } from 'node:os';

const SITE = process.env.GGC_SITE || 'https://creategamecharacters.ai';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const project = arg('project');
const key = arg('key', process.env.GGC_READ_KEY);
const out = arg('out', './assets');
const force = process.argv.includes('--force');
// Your save folder — where the site keeps your characters and outfits. You should not have
// to know its path: an agent handed the two keys and a destination has no way to learn it,
// and being asked for it is how a build quietly produces a project with no characters in it.
// So it is FOUND (see findSaveFolder below); --folder only overrides the search.
const folderArg = arg('folder', process.env.GGC_FOLDER);

if (!project || !key) {
  console.error(`usage: node fetch-assets.mjs --project <uuid> --key ggc_read_... [--out ./assets] [--force]

  --project  your project id, from ${SITE}/projects.html
  --key      a READ developer key (ggc_read_…), from ${SITE}/profile.html
             NOT your ggc_proj_ key — that one only works in a browser.
  --out      where to write (default ./assets)
  --force    re-download files that already exist
  --folder   your save folder, ONLY if the search below picks the wrong one. It is
             normally found for you — you should need nothing but the two keys.

  --github   owner/repo — push the built folder to a GitHub repo as ONE commit, so a
             CLOUD AGENT can reach your assets by cloning. Needs a fine-grained token
             with Contents: Read and write, via --gh-token or GITHUB_TOKEN. The token
             goes straight to api.github.com and is stored nowhere.
  --publish  which folder to push (default: --out). Point it at the optimized folder
             to keep the repo small.
  --repo-path  where in the repo (default: assets)
  --branch   which branch (default: the repo's default branch)`);
  process.exit(1);
}

// ── FINDING YOUR SAVE FOLDER ────────────────────────────────────────────────
// The site holds that folder as a browser permission handle, which carries a NAME and no
// path — so the page genuinely cannot tell anyone where it is, and this script cannot ask
// it. What it can do is recognise one: a save folder is the directory with `characters/`
// holding `<id>.char.bin`, or `outfits/` holding a `.glb`. That signature is specific
// enough that finding it beats being told, and being told is what nobody could do.
const SAVE_ROOTS = () => {
  const h = homedir();
  const roots = [process.cwd(), h];
  for (const d of ['Desktop', 'Documents', 'Downloads', 'OneDrive', 'OneDrive/Desktop', 'OneDrive/Documents']) roots.push(join(h, d));
  // …and every parent of the working directory, so a game repo beside the save folder finds it.
  let cur = resolve(process.cwd());
  for (let i = 0; i < 4; i++) { const up = dirname(cur); if (up === cur) break; roots.push(up); cur = up; }
  return [...new Set(roots)];
};
const hasAny = async (dir, test) => {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (await test(e, dir)) return true;
  }
  return false;
};
async function looksLikeSaveFolder(dir) {
  const chars = join(dir, 'characters');
  if ((await stat(chars).catch(() => null))?.isDirectory()) {
    // one level down: characters/<Name>/<id>.char.bin
    const named = await hasAny(chars, async (e) =>
      e.isDirectory() && await hasAny(join(chars, e.name), async (f) => f.isFile() && /\.char\.bin$/i.test(f.name)));
    if (named) return true;
  }
  const outs = join(dir, 'outfits');
  if ((await stat(outs).catch(() => null))?.isDirectory()) {
    if (await hasAny(outs, async (e) => e.isFile() && /\.glb$/i.test(e.name))) return true;
  }
  return false;
}
async function findSaveFolder() {
  if (folderArg) return { dir: folderArg, how: 'you passed --folder' };
  const seen = new Set();
  for (const root of SAVE_ROOTS()) {
    if (!(await stat(root).catch(() => null))?.isDirectory()) continue;
    if (await looksLikeSaveFolder(root)) return { dir: root, how: 'found' };
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const cand = join(root, e.name);
      if (seen.has(cand)) continue; seen.add(cand);
      if (await looksLikeSaveFolder(cand)) return { dir: cand, how: 'found' };
    }
  }
  return { dir: null, how: 'not found' };
}

const auth = { Authorization: `Bearer ${key}` };

async function getJson(url) {
  const r = await fetch(url, { headers: auth });
  const body = await r.text();
  if (!r.ok) {
    // Say which of the three likely things went wrong. An integrator running this
    // in CI has no other diagnostic, and "401" alone sends people to the wrong fix.
    let hint = '';
    if (r.status === 401) hint = '\n  → the key was not accepted. Is it a ggc_read_ key, and not revoked?';
    if (r.status === 403) hint = '\n  → the key is the wrong kind. A ggc_proj_ key cannot be used here (no Origin from Node) — use a ggc_read_ key.';
    if (r.status === 404) hint = '\n  → no project with that id on this account. Check the id at ' + SITE + '/projects.html';
    throw new Error(`GET ${url} → ${r.status}${hint}\n  ${body.slice(0, 300)}`);
  }
  return JSON.parse(body);
}

// Download one file, skipping it if it is already on disk at the same size. A
// build that re-pulls 100 MB every time gets disabled by whoever owns CI, and then
// the assets go stale instead.
async function download(url, dest) {
  const existing = await stat(dest).catch(() => null);
  const r = await fetch(url, { headers: auth });
  if (!r.ok) {
    if (r.status === 404) { console.log(`  skip   ${url.replace(SITE, '')} (not present)`); return 0; }
    throw new Error(`GET ${url} → ${r.status}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (existing && !force && existing.size === buf.length) {
    console.log(`  have   ${dest}  (${(buf.length / 1e6).toFixed(1)} MB)`);
    return 0;
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`  got    ${dest}  (${(buf.length / 1e6).toFixed(1)} MB)`);
  return buf.length;
}

const { project: proj } = await getJson(`${SITE}/api/sdk/projects/${project}/manifest`);
const a = proj.assets || {};
console.log(`\n${proj.name} → ${out}\n`);

let total = 0;
const bases = a.bases || [];
const hair = a.hair || [];

// Base meshes + their face recipes. The recipe is the 68 identity sliders as morph
// data; without it the SDK has a body slider and no face.
for (const b of bases) {
  total += await download(`${SITE}/api/prepared/${b}`, join(out, 'bases', `${b}.glb`));
  total += await download(`${SITE}/agent/integration/face-recipe/${b}.json`, join(out, 'bases', `${b}.face.json`));
}

// Hair ships SEATED PER BASE — <Style>.venus.glb is not the same file as
// <Style>.mars.glb and they are not interchangeable. Fetch the variants for the
// bases this project actually uses, plus the scalp data the conform needs.
for (const h of hair) {
  for (const b of bases) total += await download(`${SITE}/_hair/${h}/${h}.${b}.glb`, join(out, 'hair', h, `${h}.${b}.glb`));
  total += await download(`${SITE}/_hair/${h}/scalp.json`, join(out, 'hair', h, 'scalp.json'));
  total += await download(`${SITE}/_hair/${h}/scalp_mask.png`, join(out, 'hair', h, 'scalp_mask.png'));
  total += await download(`${SITE}/_hair/${h}/thumb.jpg`, join(out, 'hair', h, 'thumb.jpg'));
  // THE STRAND COVERAGE ATLAS AND ITS PARAMS. `mh_materials.json` names the atlas
  // (`params.alpha_stem` → textures/<stem>.png, or textures.alpha_r/alpha), and the shader
  // reads root/seed/density out of the same file. Without them the cards render as flat
  // untextured quads with no alpha cut — hair as slabs, which is exactly how it looked.
  total += await download(`${SITE}/_hair/${h}/mh_materials.json`, join(out, 'hair', h, 'mh_materials.json'));
  try {
    const mm = JSON.parse(await readFile(join(out, 'hair', h, 'mh_materials.json'), 'utf8'));
    const entry = (mm.materials || []).find((m) => m.kind === 'hair') || (mm.materials || [])[0] || {};
    const params = entry.params || {}, textures = entry.textures || {};
    const rel = params.alpha_stem ? `textures/${params.alpha_stem}.png` : (textures.alpha_r || textures.alpha);
    if (rel) total += await download(`${SITE}/_hair/${h}/${rel}`, join(out, 'hair', h, rel));
    // Any other texture the material names travels with it.
    for (const v of Object.values(textures)) {
      if (typeof v === 'string' && v !== rel) total += await download(`${SITE}/_hair/${h}/${v}`, join(out, 'hair', h, v));
    }
  } catch { console.log(`  NOTE   hair ${h} has no readable mh_materials.json — its atlas cannot be found`); }
}

// EYE COLOURS — the same 18 albedos the editor's Eyes panel offers, listed by
// samples/eye/colors/eyes.json. A creator without an eye-colour picker is missing one of
// the first things anyone reaches for.
{
  const idx = `${SITE}/samples/eye/colors/eyes.json`;
  const r = await fetch(idx, { headers: auth }).catch(() => null);
  if (r && r.ok) {
    const j = await r.json();
    await mkdir(join(out, 'eyes'), { recursive: true });
    await writeFile(join(out, 'eyes', 'eyes.json'), JSON.stringify(j));
    for (const c of (j.colors || [])) {
      if (c && c.file) total += await download(`${SITE}/samples/eye/colors/${c.file}`, join(out, 'eyes', c.file));
    }
  } else console.log('  NOTE   eye colour index not found — the creator will have no eye picker');
}

// ── YOUR characters and outfits — COPIED, never downloaded ──────────────────
// These are not on any server and never will be: saved characters live in the
// browser's local store and outfits live in your connected folder on disk. No key
// can fetch them because there is nothing to fetch from. So this step copies them
// out of that folder, and it is why --folder exists.
//
// (An agent that does not know this goes looking for a download endpoint, fails to
// find one, and concludes it must drive a browser to export each character by hand.
// That happened, and it cost about an hour.)
const presets = a.presets || [];
const outfits = a.outfits || [];
// Garment styles — named material looks (garment-styles/<garment>__<style>.style.bin in the
// save folder). A project brings ALL of a garment's styles or a chosen few; the game swaps
// them at runtime on the same outfit geometry.
const styles = a.styles || [];
let missingFromFolder = [];
const found = (presets.length || outfits.length || styles.length) ? await findSaveFolder() : { dir: null, how: 'not needed' };
const folder = found.dir;
if ((presets.length || outfits.length || styles.length) && !folder) {
  // A HARD STOP, not a note. This used to print a suggestion and exit 0, so a build that
  // fetched no characters at all reported SUCCESS: the manifest came out with an empty
  // `presets`, the game booted with a body slider and nothing to blend, and the only clue
  // was a line in a log nobody reads. A build that cannot produce what the project asked
  // for has failed, and it has to say so in its exit code.
  console.error(`
  FAILED: this project includes ${presets.length} character(s) and ${outfits.length} outfit(s),`);
  console.error('  which live in your save folder on this machine — and no save folder was found.');
  console.error('  A save folder is the one holding characters/<Name>/<id>.char.bin or outfits/*.glb.');
  console.error('  Pass it explicitly:  --folder "C:/path/to/your/save/folder"');
  process.exit(2);
} else if (folder) {
  console.log(`
  save folder: ${folder}  (${found.how})`);
  // Copy a character's SOURCE files only: `<id>.base.glb`, `<id>.char.bin` and
  // `<id>.charmeta.json`. That trio is the character.
  //
  // NOT the `GLBs/` subfolder beside them. That is where the site drops manual
  // exports — Ember's is 198 MB of `Ember_character_2.glb` … `_6.glb`, one per time
  // someone pressed Export. Copying it made a single character 252 MB, which would
  // put a three-character project at three quarters of a gigabyte before hair. They
  // are outputs, not inputs, and the SDK never reads them.
  // `.recipe.json` is the BLEND SOURCE — sparse vertex offsets the SDK installs as a
  // morph target so the game can mix saved characters. Published from the project page.
  const CHAR_SRC = /\.(base\.glb|char\.bin|charmeta\.json|recipe\.json)$/i;
  const copyCharacter = async (from, to) => {
    let n = 0;
    for (const e of await readdir(from, { withFileTypes: true }).catch(() => [])) {
      if (!e.isFile() || !CHAR_SRC.test(e.name)) continue;   // skips GLBs/ and anything else
      const d = join(to, e.name);
      await mkdir(dirname(d), { recursive: true });
      await copyFile(join(from, e.name), d);
      n += (await stat(d)).size;
    }
    return n;
  };

  // A character is SAVED under its display name but STORED under a sanitised one:
  // "Amber Heron 65" is the folder "Amber_Heron_65" (shared/asset-store.js safe()).
  // Looking it up by the raw name finds nothing and reports a miss for a character
  // that is sitting right there, so try the sanitised form too — same rule, verbatim.
  const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const resolveDir = async (base, name) => {
    for (const cand of [name, safeName(name)]) {
      const p = join(base, cand);
      if ((await stat(p).catch(() => null))?.isDirectory()) return p;
    }
    return null;
  };

  for (const name of presets) {
    const src = await resolveDir(join(folder, 'characters'), name);
    if (!src) { console.log(`  MISS   characters/${name} (not in ${folder})`); missingFromFolder.push('character ' + name); continue; }
    const n = await copyCharacter(src, join(out, 'characters', safeName(name)));
    // A folder can outlive the character in it — deleting a character does not always
    // sweep its folder, so the disk keeps husks with no source trio left. Copying zero
    // bytes and printing "copied" would tell you a character shipped when nothing did,
    // and the SDK would then fail to load a name your manifest promised.
    if (n === 0) {
      console.log(`  EMPTY  characters/${name} — the folder exists but holds no .base.glb/.char.bin/.charmeta.json.`);
      console.log('         This is a leftover from a deleted character. Untick it in the project.');
      missingFromFolder.push('character ' + name + ' (empty folder)');
      continue;
    }
    total += n;
    console.log(`  copied characters/${name}  (${(n / 1e6).toFixed(1)} MB)`);
  }

  for (const stem of outfits) {
    let n = 0, got = false;
    for (const ext of ['.glb', '.meta.json', '.exact.bin']) {
      const src = join(folder, 'outfits', stem + ext);
      if (!(await stat(src).catch(() => null))?.isFile()) continue;
      const dst = join(out, 'outfits', stem + ext);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      n += (await stat(dst)).size;
      if (ext === '.glb') got = true;
    }
    if (!got) { console.log(`  MISS   outfits/${stem}.glb (not in ${folder})`); missingFromFolder.push('outfit ' + stem); continue; }
    total += n;
    console.log(`  copied outfits/${stem}  (${(n / 1e6).toFixed(1)} MB)`);
  }

  for (const stem of styles) {
    const src = join(folder, 'garment-styles', stem + '.style.bin');
    if (!(await stat(src).catch(() => null))?.isFile()) {
      console.log(`  MISS   garment-styles/${stem}.style.bin (not in ${folder})`);
      missingFromFolder.push('garment style ' + stem);
      continue;
    }
    const dst = join(out, 'garment-styles', stem + '.style.bin');
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    const n = (await stat(dst)).size;
    total += n;
    console.log(`  copied garment-styles/${stem}  (${(n / 1e6).toFixed(1)} MB)`);
  }
}

// ── THE SPECTRUM DELTA ──────────────────────────────────────────────────────
// The feminine↔masculine blend IS this file: a per-vertex position/normal delta the
// SDK uploads as ONE GPU morph target, so every character in a crowd shares one
// geometry and carries only a weight. Without it the SDK loads a single fixed shape
// and the body slider does nothing — which looks like a broken slider rather than a
// missing download, so it is fetched here and never left optional.
if (bases.length >= 2) {
  const [a, b] = bases;
  total += await download(`${SITE}/api/spectrum/${a}-${b}`, join(out, 'spectrum.bin'));

  // ── AND ITS SIDECAR MAPS ──────────────────────────────────────────────────
  // The blob is not self-contained: its header names the maps that differ between the two
  // anchors (head colour, both normals, both ORM, the lash atlas) as separate files, and the
  // SDK loads them from `spectrum/<file>` next to it. Downloading only the .bin left every
  // one of those 404ing at runtime — the body blended, the skin detail did not, and the only
  // clue was a handful of failed image requests.
  //
  // They come from GET /api/spectrum/file/<name>, which is the same endpoint the site uses.
  try {
    const buf = await readFile(join(out, 'spectrum.bin'));
    // [4-byte magic][uint32 json length][json][binary blocks]
    const jsonLen = buf.readUInt32LE(4);
    const head = JSON.parse(buf.slice(8, 8 + jsonLen).toString('utf8'));
    const files = new Set();
    for (const mesh of head.meshes || []) {
      for (const prim of mesh.prims || []) {
        for (const t of prim.texs || []) if (t && t.file) files.add(t.file);
      }
    }
    for (const f of files) {
      total += await download(`${SITE}/api/spectrum/file/${encodeURIComponent(f)}`, join(out, 'spectrum', f));
    }
    if (files.size) console.log(`  spectrum: ${files.size} sidecar map(s) — the maps that differ between the two bases`);
  } catch (e) {
    console.log('  NOTE   could not read spectrum.bin to find its sidecar maps:', e.message);
    console.log('         the body will blend but skin detail will not — the SDK 404s on spectrum/*.jpg');
  }
}

// ── THE SDK ITSELF, AND THE TWO MODULES IT IMPORTS ─────────────────────────
// `v1.js` is not a bundle: it imports the hair shader and the record codec as siblings
// (`../agent/integration/hair-shader.js`, `../record-codec.js`). Loaded from our CDN those
// resolve fine. SELF-HOSTED they resolve against the customer's own origin and 404, and the
// creator dies at import with nothing useful in the console — an integrator then hand-copies
// two files they had no way to know about. So the build pulls all three, in the layout the
// imports expect: <out>/sdk/v1.js beside <out>/record-codec.js and
// <out>/agent/integration/hair-shader.js.
{
  const sdkFiles = [
    ['/sdk/v1.js', join(out, 'sdk', 'v1.js')],
    ['/record-codec.js', join(out, 'record-codec.js')],
    ['/agent/integration/hair-shader.js', join(out, 'agent', 'integration', 'hair-shader.js')],
    // THIS script's own --github dependency. It ships to integrators as <out>/sdk/
    // fetch-assets.mjs, and it imports ./github-publish.mjs as a sibling — so without this
    // line the copy an integrator actually runs dies at import the moment they pass --github,
    // on a module they were never told existed. Same failure the three files above document.
    ['/github-publish.mjs', join(out, 'sdk', 'github-publish.mjs')],
    // The OPTIMIZED ASSET ROUTE — the compression pass with the texture caps written
    // down (body 1024, face 2048/1024, eyes 512, teeth 256, hair 512). Pulled here so
    // the version an integrator runs matches the assets this script just fetched.
    ['/sdk/optimize-assets.mjs', join(out, 'sdk', 'optimize-assets.mjs')],
  ];
  for (const [url, dest] of sdkFiles) total += await download(SITE + url, dest);
  console.log('  sdk: import from ./assets/sdk/v1.js to self-host, or from ' + SITE + '/sdk/v1.js to always get the latest');
}

// ── THE SDK MANIFEST ────────────────────────────────────────────────────────
// `project.json` above is the SITE's view of a project (what you ticked). This is the
// RUNTIME's view: where each file landed on your hosting. They are deliberately
// different documents — the site cannot know your folder layout, and the SDK must not
// have to guess it. Writing it here is what makes `Creator.open({assets})` work with no
// configuration at all.
await mkdir(out, { recursive: true });
const manifest = {
  v: 1,
  base: { url: `bases/${bases[0]}.glb` },
  spectrum: bases.length >= 2 ? { url: 'spectrum.bin' } : null,
  // The 68 identity sliders. Without this entry the SDK installs no face morphs and every
  // character comes out with the SAME FACE — which is what "a crowd of unique characters"
  // fails as, silently, with no error anywhere.
  face: { url: `bases/${bases[0]}.face.json` },
  hair: {},
  outfits: {},
  // Garment styles: named material looks per garment — `garment-styles/*.style.bin`,
  // readable with the record codec shipped beside the SDK (record-codec.js,
  // deserializeCharacter). Each record carries `baked`: per-material PNG blobs +
  // factors to assign; geometry is untouched, so a crowd swaps looks for free.
  styles: {},
  eyes: { index: 'eyes/eyes.json' },
};
for (const h of hair) {
  // `a` and `b` are the two SEATED bakes — one per base. A style fitted at both ends is
  // a per-vertex lerp between them; with only `a` it is rigid and correct at that end.
  const a = `hair/${h}/${h}.${bases[0]}.glb`;
  const b = bases[1] ? `hair/${h}/${h}.${bases[1]}.glb` : null;
  manifest.hair[h] = {
    a,
    ...(b ? { b } : {}),
    ...(await stat(join(out, 'hair', h, 'scalp_mask.png')).catch(() => null) ? { scalp: { mask: 'scalp_mask.png' } } : {}),
  };
}
// ── OUTFITS: ONE ENTRY PER OUTFIT, FITTED AT BOTH ENDS ──────────────────────
// An outfit saved on venus and the same outfit saved on mars are TWO SAVES OF ONE
// GARMENT SET, and the SDK lerps between them exactly as the body lerps between its
// two anchors. Emitting them as two separate one-ended entries — which is what this
// did first — means the clothes never blend with the body: the shirt stays at venus
// shape while the torso morphs to mars, and it intersects. That is the "clothes glitch
// through the body" report, and it was a manifest bug, not a fitting bug.
//
// PAIRED BY GARMENT SET, NEVER BY NAME. The two ends are independent saves whose names
// can differ (the jumpsuit is "Prison Jumpsuit" on venus and "Prisoner" on mars), and
// two different outfits can share a name. Matching on the sorted garment list is the
// only identity that actually holds — the same rule the editor's outfit pairing uses.
{
  const metaOf = async (stem) => {
    try { return JSON.parse(await readFile(join(out, 'outfits', stem + '.meta.json'), 'utf8')); }
    catch { return null; }
  };
  const setKey = (m) => (m && m.garments || []).map((g) => g.name).filter(Boolean).sort().join('|');
  const groups = new Map();
  for (const stem of outfits) {
    const meta = await metaOf(stem);
    // No readable garment set means it cannot be PROVEN blendable, so it stands alone
    // and stays wearable at its own end rather than being paired on a guess.
    const key = setKey(meta) || `@solo:${stem}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ stem, meta, base: (meta && meta.meshId) || (stem.startsWith('mars') ? 'mars' : 'venus') });
  }
  for (const g of groups.values()) {
    const at = (b) => g.find((x) => x.base === b);
    const A = at(bases[0]) || g[0];
    const B = bases[1] ? at(bases[1]) : null;
    const id = (A.meta && A.meta.name) || A.stem.replace(/^(venus|mars)__/, '');
    // The body-hide mask needs NOTHING here. It is already saved inside `<stem>.exact.bin`
    // (`manifest.bodyHidden`), which is copied alongside the GLB — for BOTH ends, since the
    // copy step walks every stem — and the SDK reads them at load time with the app's own
    // deserializer, one mask per end (the two fits cover different skin, so the mask rides
    // the body slider exactly as the fit does). Extracting it at build time was a second
    // source of truth for data the outfit already carries.
    manifest.outfits[id] = {
      // TAGGED, not inferred. The site already knows which saves are the same outfit at
      // both ends of the spectrum — it pairs them by GARMENT SET to draw the M+F badge in
      // the picker. Say so here rather than shipping names for a consumer to pattern-match:
      // "mars__punk" and "venus__punk" happen to rhyme, but "Prison Jumpsuit"/"Prisoner"
      // do not, and matching on names would silently miss that pair.
      ends: Object.fromEntries(g.map((x) => [x.base, `outfits/${x.stem}.glb`])),
      bases: g.map((x) => x.base).sort(),
      a: `outfits/${A.stem}.glb`,
      ...(B && B.stem !== A.stem ? { b: `outfits/${B.stem}.glb` } : {}),
      ...(A.meta && A.meta.occ ? { occ: A.meta.occ } : {}),
      ...(A.meta && A.meta.tuck ? { tuck: A.meta.tuck } : {}),
    };
    if (!B || B.stem === A.stem) {
      console.log(`  NOTE   outfit "${id}" is fitted at ${A.base} only — it is correct at that end`);
      console.log('         of the slider and approximate away from it. Save it on the other base to fix.');
    }
  }
}
// Garment styles — indexed per garment so a game addresses them as
// (garment, style) rather than pattern-matching file stems. Only styles whose
// file actually landed are named; a MISS above already counted the rest.
for (const stem of styles) {
  if (!(await stat(join(out, 'garment-styles', stem + '.style.bin')).catch(() => null))?.isFile()) continue;
  const i = stem.indexOf('__');   // garment ids are single-underscore slugs; the first __ separates garment from style
  if (i <= 0) { console.log(`  NOTE   garment style "${stem}" has no __ separator — skipped from the manifest`); continue; }
  const gar = stem.slice(0, i), st = stem.slice(i + 2);
  (manifest.styles[gar] = manifest.styles[gar] || {})[st] = `garment-styles/${stem}.style.bin`;
}

// Blend sources: one entry per saved character that has a published recipe. A preset with
// no recipe is silently unblendable, so say which are missing rather than shipping a project
// whose "character blending" quietly does nothing.
manifest.presets = {};
const noRecipe = [];
for (const name of presets) {
  const dir = join(out, 'characters', String(name).replace(/[^a-zA-Z0-9_.-]/g, '_'));
  const files = await readdir(dir).catch(() => []);
  const rec = files.find((f) => f.endsWith('.recipe.json'));
  if (rec) manifest.presets[name] = { recipe: `characters/${String(name).replace(/[^a-zA-Z0-9_.-]/g, '_')}/${rec}` };
  else noRecipe.push(name);
}
if (noRecipe.length) {
  console.log(`
  ${noRecipe.length} character(s) have no published recipe, so the game cannot blend them:`);
  console.log('  ' + noRecipe.join(', '));
  console.log('  Fix: open /projects.html — a missing recipe is baked when that page opens.');
  console.log('  (The bake needs a live WebGL context, so no build script or key can do it here.)');
}
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(join(out, 'project.json'), JSON.stringify(proj, null, 2));

// EVERYTHING THE PROJECT ASKED FOR, OR A NON-ZERO EXIT. A build that silently drops assets
// hands the game a manifest that promises characters it does not carry, and the failure then
// surfaces as "setBlend does nothing" hours later, in someone else's code. Say it here.
if (missingFromFolder.length || noRecipe.length) {
  console.error(`
  FAILED: ${missingFromFolder.length + noRecipe.length} of this project's assets did not make it into ${out}.`);
  for (const m of missingFromFolder) console.error('    missing from the save folder: ' + m);
  for (const n of noRecipe) console.error('    no blend recipe published: ' + n);
  console.error('  The manifest written above lists only what IS there, so nothing downstream lies —');
  console.error('  but this build is incomplete. Fix the list above and re-run.');
  process.exit(3);
}

console.log(`\ndone — ${(total / 1e6).toFixed(1)} MB downloaded this run.`);
console.log('Remember the credit line: "Powered by creategamecharacters.com" — in your creator,');
console.log('on a splash screen, or in the main menu. That is what the assets are free against.');
console.log(`Next: compress for shipping (per-part texture caps — body 1024, face 2048, eyes 512,
teeth 256, hair 512; pass --face-res 1024 for the smaller face option), then point the
SDK at the optimized folder:

  node ${out}/sdk/optimize-assets.mjs ${out} ${out}-min
  Creator.open({ key: 'ggc_proj_...', assets: '${/^([a-zA-Z]:|\/)/.test(out) ? out : './' + out.replace(/^\.\//, '')}-min/' })
`);

// ── PUBLISH TO GITHUB ───────────────────────────────────────────────────────
// `--github owner/repo` pushes the folder this run just built, as ONE commit.
//
// WHY IT LIVES HERE and not in the browser: a cloud agent cannot see your save folder, so it
// cannot build a project at all — but it CAN clone a repo. This is the bridge. And it has to
// be the CLI rather than a button on the site, because the assets worth publishing are the
// OPTIMIZED ones and the optimizer is Node (gltf-transform); a browser button could only push
// the full-size folder, which is 100+ MB of GLB into a git repo.
//
// So the intended order is: build, optimize, publish the optimized folder —
//   node fetch-assets.mjs --project <id> --key ggc_read_... --out ./assets
//   node ./assets/sdk/optimize-assets.mjs ./assets ./assets-min
//   node fetch-assets.mjs --project <id> --key ggc_read_... --out ./assets --publish ./assets-min --github you/your-game
// and `--publish` defaults to `--out` when you just want the full-quality folder up there.
//
// THE TOKEN IS NEVER STORED. Pass --gh-token, or set GITHUB_TOKEN / GH_TOKEN. It goes straight
// from this process to api.github.com and is written nowhere — not by this script and not by
// the site. A fine-grained token needs exactly one permission: Contents: Read and write, on
// the one repo you are publishing to.
const ghRepo = arg('github');
if (ghRepo) {
  const { publishToGitHub, isSkippedFromPublish } = await import('./github-publish.mjs')
    .catch(() => import(new URL('../shared/github-publish.mjs', import.meta.url).href));
  const ghToken = arg('gh-token', process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  if (!ghToken) {
    console.error(`
  --github needs a token. Make a FINE-GRAINED token with "Contents: Read and write" on that one
  repo (github.com → Settings → Developer settings → Fine-grained tokens), then either:
      --gh-token ghp_...
      GITHUB_TOKEN=ghp_...   (env)
  It is used for this push only and stored nowhere.`);
    process.exit(4);
  }
  const from = resolve(arg('publish', out));
  const repoPath = arg('repo-path', 'assets');

  // Walk the folder we are publishing. Paths go up with forward slashes whatever the OS —
  // a Windows backslash in a git tree entry creates a file literally named "a\b".
  const files = [];
  let skipped = 0, skippedBytes = 0;
  const collect = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await collect(p); continue; }
      const rel = p.slice(from.length + 1).split(pathSep).join('/');
      const bytes = await readFile(p);
      // The editor's save records and each character's own baked base mesh are copied into
      // the project folder so you can reopen a character — the RUNTIME never opens them, and
      // on a real project they are most of the bytes. Left out, and counted, because a
      // publish that silently drops files reads as complete when it is not.
      if (isSkippedFromPublish(rel)) { skipped++; skippedBytes += bytes.length; continue; }
      files.push({ path: rel, bytes });
    }
  };
  await collect(from);
  if (skipped) {
    console.log(`  skipping ${skipped} file(s), ${(skippedBytes / 1048576).toFixed(0)} MB — save records and per-character base meshes the SDK never loads`);
  }

  // GitHub hard-refuses a blob over 100 MB, and a repo full of 50 MB files is a repo nobody
  // can clone. Name the offender before spending the upload.
  const big = files.filter((f) => f.bytes.length > 50 * 1024 * 1024);
  if (big.length) {
    console.error(`
  These files are too big for a git repo (over 50 MB), so the push was not attempted:`);
    for (const f of big) console.error(`    ${(f.bytes.length / 1048576).toFixed(1)} MB  ${f.path}`);
    console.error('  Optimize first (node ' + out + '/sdk/optimize-assets.mjs ' + out + ' ' + out + '-min) and publish that folder with --publish.');
    process.exit(5);
  }

  const totalMb = files.reduce((n, f) => n + f.bytes.length, 0) / 1048576;
  console.log(`\npublishing ${files.length} file(s), ${totalMb.toFixed(1)} MB, from ${from}`);
  let lastPct = -1;
  const res = await publishToGitHub({
    token: ghToken,
    repo: ghRepo,
    branch: arg('branch'),
    prefix: repoPath,
    files,
    message: arg('message', `Publish character assets for project ${project}`),
    onProgress: (p) => {
      if (p.phase === 'start') console.log(`  ${p.repo} @ ${p.branch}${p.firstCommit ? '  (first commit — creating the branch)' : ''}`);
      else if (p.phase === 'warn') console.log('  NOTE: ' + p.message);
      else if (p.phase === 'blob') {
        const pct = Math.floor((p.done / p.total) * 10) * 10;
        if (pct !== lastPct) { lastPct = pct; console.log(`  uploading… ${pct}%  (${p.done}/${p.total})`); }
      }
    },
  });
  console.log(`
published — commit ${res.commit.slice(0, 7)}, ${res.files} file(s)${res.removed ? `, ${res.removed} stale file(s) removed` : ''}
  repo:   ${res.url}
  pages:  ${res.pages}   (once GitHub Pages is enabled for that branch)

A cloud agent can now reach these with nothing but the repo — no key, no access to this machine:
  git clone https://github.com/${ghRepo.replace('https://github.com/', '')}
  Creator.open({ key: 'ggc_proj_...', assets: '${repoPath}/' })`);
}

// ---
// Created by Sander Mørch-Jensen · https://creategamecharacters.com/agent/integration/licensing.md
// Removing this signature breaks the license.
