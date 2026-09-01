#!/usr/bin/env node
// ── optimize-assets.mjs — the OPTIMIZED ASSET ROUTE for a project's asset folder ──
//
// The site ships assets at FULL QUALITY — a base mesh carries an 8192² body map and a
// 4096² head map, and a hair atlas is 4096². The SDK's customers host those assets
// themselves and pay their own bandwidth (context/sdk/context.md, "Where the cost
// lands"), so every integrator has so far hand-rolled their own compression pass and
// guessed at the settings. This is that pass, once, with the settings written down.
// It lives in sdk/ BECAUSE customers run it: sdk/ deploys, tools/ never does, and
// fetch-assets.mjs downloads this file into <out>/sdk/ next to v1.js.
//
//   node optimize-assets.mjs <in-dir> <out-dir> [--quality full|balanced|small]
//                                               [--face-res 1024|2048] [--dry]
//
// PER-PART TEXTURE CAPS (owner spec, 2026-08-05). A character is not one texture: its
// parts carry different identity weight, so they get different resolution budgets.
// On the compression tiers (`balanced`, `small`) every texture is classified — by the
// names of the meshes/nodes/materials that wear it, or by its folder for loose files —
// and capped per part:
//
//     body   1024        the body skin maps (ships at up to 8192² otherwise)
//     face   2048|1024   the blend textures: the head maps in every GLB, the baked
//                        atlases inside .recipe.json blend sources, and the head's
//                        spectrum sidecar maps. `balanced` defaults to 2048, `small`
//                        to 1024; `--face-res` overrides either.
//     eyes   512         iris/eye maps and the eyes/ albedo swatches
//     teeth  256         the mouth kit (teeth, gums, interior)
//     hair   512         the strand atlas, scalp mask — everything under hair/
//
// Anything that classifies as NONE of these (garment textures on outfit GLBs, mostly)
// keeps the tier's general cap (balanced 4096, small 2048). `full` caps nothing — it
// stays the hero route for source-resolution assets. Every decision is printed per
// texture, with the part it classified as.
//
// The caps reach ALL THREE places textures ship, not just GLBs:
//   • GLB-embedded textures  → classified via material/mesh/node names, KTX2-encoded
//   • .recipe.json atlases   → the character-blend sources; data URIs re-encoded in
//                              their own format (KTX2 has no place inside JSON)
//   • loose images           → hair/ atlases + scalp masks, eyes/ albedos, spectrum/
//                              sidecars (classified per file via the spectrum.bin
//                              header, which names the mesh each sidecar belongs to)
//
// WHAT IT MUST NOT BREAK — and why the settings look conservative:
//
//   * THE SDK INDEXES BY NAME. Meshes, nodes, morph targets, skins and joints are
//     looked up by name at runtime. A compressor that renames or reorders them breaks
//     the SDK silently — the file still loads, the character is just wrong. So every
//     output is re-read from disk and structurally diffed against its source, and a
//     name/order/count change is a hard FAILURE, not a warning.
//
//   * VERTEX ORDER AND TRIANGLE INDICES ARE LOAD-BEARING. The spectrum delta blob
//     (`_prepared/spectrum_v<N>_<a>_<b>.bin`) is a per-vertex delta keyed by vertex
//     ORDER, and landmark bindings are triangle index + barycentric at rest. Anything
//     that welds, reorders or compacts vertices detaches both, silently. So this tool
//     never calls weld() or reorder(), and it CHECKSUMS the position buffer and the
//     triangle list of every primitive to prove they came through unchanged.
//     ONE CAVEAT, measured and reported per file: meshopt's index codec rotates the
//     corner order WITHIN a triangle (same triangle, same order, same winding — see
//     triangleHash below). Triangle+barycentric bindings taken against the full-quality
//     asset therefore have to be recomputed against the optimized one.
//
//   * MORPH TARGETS ARE NOT QUANTISED. AT ALL. See the next block.
//
// QUANTISATION BITS — the number this pass is judged on:
//
//   Morph target deltas: NONE. They stay float32 and come out BIT-IDENTICAL; the
//   saving on them is meshopt's byte-wise entropy coder, which is lossless. That is a
//   deliberate refusal, not laziness, and the arithmetic is why:
//
//     glTF-Transform quantises a morph delta on the SAME grid as the base mesh — it
//     divides the delta by the mesh's bounding half-extent and stores an int16
//     (quantize.ts: targets are scaled by 1/scale and then quantizeAttribute'd with
//     `quantizePosition` bits). So the finest step you can buy on a ~1.75 m body is
//
//         step = halfExtent / (2^(bits-1) - 1) = 0.875 / 32767 = 26.7 µm      @16 bits
//                                              = 0.875 /  8191 = 107  µm      @14 bits (the default!)
//
//     The spectrum delta this product already ships is int16 over its own ~16 cm range
//     — a 4.9 µm grid, worst-case reconstruction error 2.4 µm (tools/build-spectrum.mjs
//     reports exactly that with --verify). Quantising morphs at 16 bits would therefore
//     be 5.6× COARSER than the data being carried: a 1 mm nose delta would land on ~37
//     levels, and neighbouring vertices snapping to different levels is visible as
//     faceting on a surface that is supposed to be smooth. At the 14-bit default a
//     2.4 µm delta rounds to ZERO. There is no bit count ≤ 16 that clears the budget on
//     a full body, so the correct answer is not to quantise morphs at all.
//
//   Base mesh POSITION: also left float32 by default, for a second and independent
//   reason — quantising positions RESCALES the mesh's local units and pushes the
//   inverse scale onto the node (or into the skin's inverse bind matrices). Any code
//   that reads raw vertex positions out of the file and adds a delta in metres — which
//   is precisely what the spectrum blob does — then adds metres to quantised units.
//   `--quantize-positions` opts in anyway; it picks the bits from the 2.4 µm budget,
//   refuses if even 16 bits cannot clear it, and measures the real error afterwards.
//
//   Everything else IS quantised, because nothing downstream reads it by hand:
//     NORMAL/TANGENT (base only) → meshopt's 8-bit octahedral filter — 4 bytes instead
//       of 12, and better quality per bit than a 12-bit XYZ triple. Morph NORMAL deltas
//       are filter=NONE in that same codec, so they stay lossless for free.
//     TEXCOORD 14/12 bits, COLOR 8, WEIGHTS 12/8 — standard, invisible, and the weight
//       rounding is deterministic per vertex so welded seams stay matched.
//
// WHY MESHOPT AND NOT DRACO (--codec draco exists, but read this first):
//   KHR_draco_mesh_compression cannot compress morph targets. glTF-Transform's draco()
//   also calls weld() first — which is exactly the vertex reorder that detaches the
//   spectrum blob and the landmark bindings — and when a primitive has morph targets
//   the encoder drops to MESH_SEQUENTIAL_ENCODING, losing most of its ratio anyway.
//   For an asset set that is *mostly* morph targets, Draco compresses the small half of
//   the file and breaks the product doing it. EXT_meshopt_compression compresses morph
//   targets, is lossless where we ask it to be, and preserves vertex order.
//
// TEXTURES: KTX2 (KHR_texture_basisu). The honest caveat is that KTX2's guaranteed win
//   is VRAM (6–8× less than RGBA, transcoded on the GPU) and decode time — NOT always
//   bytes on the wire, because the source here is already JPEG. So each texture is
//   encoded, MEASURED, and on the bandwidth tiers the smaller of {KTX2, source} is
//   kept, with the choice printed per texture — where "source" means the source AT THE
//   CAP: once a part cap shrank a texture, the original full-resolution bytes are
//   disqualified, and the fallback is the resized image re-encoded in its own format.
//   A cap that silently un-applies itself whenever KTX2 loses a byte race would ship
//   the 8192² body map it just promised to remove. `full` keeps the KTX2 either way,
//   since VRAM is the point of that tier.
//
// NEVER MODIFIES THE INPUT. Reads in-dir, writes out-dir, refuses if they overlap.
// NEVER SILENTLY PASSES A FILE THROUGH. A missing dependency is a hard failure naming
//   what to install; a texture that did not shrink says so on its own line.
//
// Consumers need the matching loaders: three.js `KTX2Loader` (+ the basis transcoder)
// and `MeshoptDecoder`. GLTFLoader will refuse the file without them.
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, readdir, rm, stat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// ── quality presets ────────────────────────────────────────────────────────────────
//
// `full`     — lossless geometry (nothing quantised, nothing filtered), UASTC textures
//              at source resolution, NO per-part caps. The route for a hero character.
// `balanced` — DEFAULT. Lossless positions + morphs, octahedral normals, ETC1S colour /
//              UASTC-grade normal handling, per-part caps with face at 2048.
// `small`    — same geometry guarantees, per-part caps with face at 1024, ETC1S
//              everywhere. This is the tier that hits the "~18 MB base mesh → ~2–3 MB"
//              figure in the SDK design.
//
// `parts` is the per-part resolution cap table (see the header). `maxTexture` is the
// cap for textures that classify as no part at all — garment textures on outfit GLBs.
const QUALITY = {
  full: {
    maxTexture: 0,                 // 0 = never downscale
    parts: null,                   // no per-part caps — hero route, source resolution
    colour: { mode: 'uastc', quality: 4, zstd: 18 },
    normal: { mode: 'uastc', quality: 4, zstd: 18 },
    linear: { mode: 'uastc', quality: 4, zstd: 18 },
    // UASTC is ~1 byte/px before zstd, so against an already-JPEG source it usually
    // grows the FILE while shrinking VRAM 6–8×. On the quality tier that is the trade
    // being bought deliberately, so `full` keeps the KTX2 and prints the growth.
    alwaysKtx2: true,
    // Nothing quantised at all — meshopt runs in QUANTIZE mode, which applies no
    // filters and is therefore a pure lossless entropy coder over the float32 data.
    quantize: null,
    meshoptMethod: 'quantize',
  },
  balanced: {
    maxTexture: 4096,
    parts: { body: 1024, face: 2048, eyes: 512, teeth: 256, hair: 512 },
    colour: { mode: 'etc1s', clevel: 4, qlevel: 192 },
    // ETC1S, not UASTC, for normals too — `--normal_mode` encodes X/Y into separate
    // channels and holds up fine, whereas a 4096² UASTC normal map lands around 3–12 MB
    // and would lose the size comparison below on every single asset in this product.
    normal: { mode: 'etc1s', clevel: 4, qlevel: 255, normalMode: true },
    linear: { mode: 'etc1s', clevel: 4, qlevel: 192 },
    alwaysKtx2: false,
    quantize: { quantizeTexcoord: 14, quantizeColor: 8, quantizeWeight: 12, quantizeGeneric: 14 },
    meshoptMethod: 'filter',       // → 8-bit octahedral base normals, lossless deltas
  },
  small: {
    maxTexture: 2048,
    parts: { body: 1024, face: 1024, eyes: 512, teeth: 256, hair: 512 },
    colour: { mode: 'etc1s', clevel: 2, qlevel: 128 },
    normal: { mode: 'etc1s', clevel: 2, qlevel: 160, normalMode: true },
    linear: { mode: 'etc1s', clevel: 2, qlevel: 128 },
    alwaysKtx2: false,
    quantize: { quantizeTexcoord: 12, quantizeColor: 8, quantizeWeight: 8, quantizeGeneric: 12 },
    meshoptMethod: 'filter',
  },
};

// ── part classification ────────────────────────────────────────────────────────────
//
// One texture is worn by materials, which sit on primitives, which belong to meshes,
// which hang on nodes — and in this product's GLBs the NAMES live wherever they live:
// mars.glb's teeth mesh is literally "Mesh.001", identified only by its node ("teeth")
// and its material ("mouth"). So classification collects EVERY name on that chain and
// takes the first rule any of them matches, most specific first.
//
// Rule order is load-bearing, twice:
//   • "eyelashes"/"eyebrow" contain "eye" — lashes and brows are face furniture, not
//     eyes, and the eyes cap (512) must not sweep the lash atlas. So lash|brow resolve
//     to `face` BEFORE the eye rule runs.
//   • "skin_head" contains "head" and "skin" — the face rule runs before the body rule
//     so the head map never takes the body cap.
const PART_RULES = [
  ['teeth', /teeth|tongue|mouth|gum/i],
  ['face', /lash|brow/i],
  ['eyes', /eye|iris|cornea|sclera/i],
  ['hair', /hair|scalp/i],
  ['face', /head|face/i],
  ['body', /body|torso|skin/i],
];

/** First rule (in priority order) that ANY of the names matches → {part, hit}. */
function partOfNames(names) {
  for (const [part, re] of PART_RULES) {
    for (const n of names) if (n && re.test(n)) return { part, hit: n };
  }
  return null;
}

/** The effective cap for a texture: its part cap, else the tier's general cap. */
function capFor(part, preset) {
  const partCap = part && preset.parts ? preset.parts[part] : 0;
  if (!partCap) return preset.maxTexture;
  return preset.maxTexture ? Math.min(partCap, preset.maxTexture) : partCap;
}

/**
 * Classify every texture in a document by walking texture → materials → primitives →
 * meshes → nodes and collecting names along the way. Returns Map<Texture, {part,hit}>.
 * `pathPart` (from the file's folder, e.g. everything under hair/) is the fallback for
 * a texture whose whole chain is anonymous.
 */
function classifyTextures(doc, core, pathPart) {
  const { PropertyType } = core;
  const map = new Map();
  for (const texture of doc.getRoot().listTextures()) {
    const names = [texture.getName() || '', texture.getURI() || ''];
    // BFS UP THE WHOLE OWNERSHIP GRAPH, not texture→material directly: extension
    // properties sit BETWEEN a texture and its material (KHR_materials_specular holds
    // the specular map), so a straight material filter classified mars's two unnamed
    // specular maps as nothing at all. Climb through whatever owns the texture until
    // the node level; collect every name on the way.
    const seen = new Set([texture]);
    let frontier = [texture];
    while (frontier.length) {
      const next = [];
      for (const prop of frontier) {
        for (const parent of prop.listParents()) {
          if (seen.has(parent) || parent.propertyType === PropertyType.ROOT) continue;
          seen.add(parent);
          if (typeof parent.getName === 'function') names.push(parent.getName() || '');
          // Stop climbing at the NODE level; above that is scene plumbing whose names
          // (a scene called anything) say nothing about the part.
          if (parent.propertyType !== PropertyType.NODE) next.push(parent);
        }
      }
      frontier = next;
    }
    const cls = partOfNames(names) || (pathPart ? { part: pathPart, hit: `(folder ${pathPart}/)` } : null);
    map.set(texture, cls);
  }
  return map;
}

// The precision the morph/position grid has to clear before `--quantize-positions` is
// allowed to touch anything: the worst-case reconstruction error of the spectrum delta
// blob we already ship (int16 over ~16 cm → half a 4.9 µm step). Quantising coarser
// than the data being carried is how a "compression" pass becomes a visible artefact.
const PRECISION_BUDGET_M = 2.4e-6;

const GLTF_EXT = new Set(['.glb', '.gltf']);
const LOOSE_IMG_EXT = /\.(png|jpe?g)$/i;

// ── CLI ────────────────────────────────────────────────────────────────────────────

const USAGE = `
optimize-assets — compress an SDK project's asset folder for customer hosting

  node optimize-assets.mjs <in-dir> <out-dir> [options]

  --quality full|balanced|small   default: balanced
                                  balanced/small cap textures PER PART:
                                  body 1024 · face 2048/1024 · eyes 512 · teeth 256 · hair 512
                                  full caps nothing (hero route, source resolution)
  --face-res 1024|2048            the face/blend-texture cap (head maps, recipe atlases,
                                  head spectrum maps). Default: 2048 on balanced, 1024 on small
  --codec   meshopt|draco         default: meshopt (draco cannot compress morph targets)
  --quantize-positions            opt in to lossy vertex positions (see header comment)
  --dry                           do everything, report real sizes, write nothing
  --help
`.trim();

function parseArgs(argv) {
  const opts = { quality: 'balanced', codec: 'meshopt', quantizePositions: false, dry: false, faceRes: 0 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--dry') opts.dry = true;
    else if (a === '--quantize-positions') opts.quantizePositions = true;
    else if (a === '--quality') opts.quality = argv[++i];
    else if (a === '--codec') opts.codec = argv[++i];
    else if (a === '--face-res') opts.faceRes = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`Unknown option "${a}".\n\n${USAGE}`);
    else positional.push(a);
  }
  if (positional.length !== 2) throw new Error(`Expected <in-dir> and <out-dir>.\n\n${USAGE}`);
  if (!QUALITY[opts.quality]) throw new Error(`--quality must be one of: ${Object.keys(QUALITY).join(', ')}`);
  if (opts.codec !== 'meshopt' && opts.codec !== 'draco') throw new Error(`--codec must be "meshopt" or "draco".`);
  if (opts.faceRes && opts.faceRes !== 1024 && opts.faceRes !== 2048) {
    throw new Error(`--face-res must be 1024 or 2048 (the face/blend-texture options).`);
  }
  opts.inDir = resolve(positional[0]);
  opts.outDir = resolve(positional[1]);
  return opts;
}

// ── dependency preflight ───────────────────────────────────────────────────────────
//
// Every dependency is resolved BEFORE any file is touched, and everything that is
// missing is reported in one message with the exact install line. Half-running and
// then falling over on file 40 of 60 leaves a half-written out-dir that looks finished.

const INSTALL = {
  '@gltf-transform/core': 'npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions',
  '@gltf-transform/extensions': 'npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions',
  '@gltf-transform/functions': 'npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions',
  meshoptimizer: 'npm i meshoptimizer',
  sharp: 'npm i sharp',
  draco3dgltf: 'npm i draco3dgltf',
};

async function loadDeps(opts) {
  const missing = [];
  const got = {};
  const tryImport = async (spec) => {
    try { got[spec] = await import(spec); }
    catch { missing.push(`  ${spec.padEnd(28)} → ${INSTALL[spec]}`); }
  };

  // glTF-Transform is already a dependency of this repo (tools/build-spectrum.mjs and
  // tools/weld-skin-seams.mjs both use it), so on a normal checkout these resolve.
  await tryImport('@gltf-transform/core');
  await tryImport('@gltf-transform/extensions');
  await tryImport('@gltf-transform/functions');
  await tryImport('sharp');                                        // decode/resize before KTX2
  if (opts.codec === 'meshopt') await tryImport('meshoptimizer');
  if (opts.codec === 'draco') await tryImport('draco3dgltf');

  // The KTX2 encoder is a native binary, not an npm package. `toktx` is the stable
  // KTX-Software CLI; 4.3+ also ships `ktx create` and deprecates toktx, so probe both.
  const ktx = findKtxTool();
  if (!ktx) {
    missing.push(
      '  KTX2 encoder               → install KTX-Software (provides `toktx` / `ktx`):\n' +
      '                               https://github.com/KhronosGroup/KTX-Software/releases\n' +
      // winget does NOT carry KTX-Software (verified 2026-08-05) — pointing Windows
      // users at winget strands them on "No package found".
      '                               Windows: run the -Windows-x64.exe installer from that page,\n' +
      '                                        or 7-Zip-extract it for a no-install copy and set\n' +
      '                                        KTX_BIN=<extracted bin\\toktx.exe>\n' +
      '                               macOS:   brew install ktx\n' +
      '                               or set KTX_BIN=<path to toktx or ktx>'
    );
  }

  if (missing.length) {
    throw new Error(
      'optimize-assets: missing dependencies. Nothing was written — this tool will not\n' +
      'pass files through uncompressed and report a saving that did not happen.\n\n' +
      missing.join('\n')
    );
  }
  return { ...got, ktx };
}

/** Locate a KTX2 encoder: env override, PATH, then the default Windows install dir. */
function findKtxTool() {
  const candidates = [];
  if (process.env.KTX_BIN) candidates.push(process.env.KTX_BIN);
  candidates.push('toktx', 'ktx');
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\KTX-Software\\bin\\toktx.exe',
      'C:\\Program Files\\KTX-Software\\bin\\ktx.exe',
    );
  }
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) continue;
    const out = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
    // `toktx` and `ktx` take completely different arguments — remember which we found.
    const kind = /^toktx/i.test(out) || /toktx/i.test(basename(bin)) ? 'toktx' : 'ktx';
    return { bin, kind, version: out.split('\n')[0] };
  }
  return null;
}

// ── the KTX2 encode ────────────────────────────────────────────────────────────────

/**
 * PNG bytes → KTX2 bytes, via the detected KTX-Software binary.
 * `plan` is one of the {colour,normal,linear} entries of a QUALITY preset.
 */
function runKtx(ktx, plan, srgb, pngPath, ktxPath) {
  let args;
  if (ktx.kind === 'toktx') {
    args = ['--t2', '--genmipmap', '--assign_oetf', srgb ? 'srgb' : 'linear'];
    if (plan.mode === 'uastc') {
      args.push('--encode', 'uastc', '--uastc_quality', String(plan.quality), '--zcmp', String(plan.zstd));
    } else {
      args.push('--encode', 'etc1s', '--clevel', String(plan.clevel), '--qlevel', String(plan.qlevel));
      if (plan.normalMode) args.push('--normal_mode');
    }
    args.push(ktxPath, pngPath);                       // toktx: <out> <in>
  } else {
    // `ktx create` carries the colour space in --format, which dodges the
    // --assign-oetf → --assign-tf rename between KTX-Software 4.3 and 4.4.
    args = ['create', '--format', srgb ? 'R8G8B8A8_SRGB' : 'R8G8B8A8_UNORM', '--generate-mipmap'];
    if (plan.mode === 'uastc') {
      args.push('--encode', 'uastc', '--uastc-quality', String(plan.quality), '--zstd', String(plan.zstd));
    } else {
      args.push('--encode', 'basis-lz', '--clevel', String(plan.clevel), '--qlevel', String(plan.qlevel));
      if (plan.normalMode) args.push('--normal-mode');
    }
    args.push(pngPath, ktxPath);                       // ktx create: <in> <out>
  }
  const res = spawnSync(ktx.bin, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (res.error) throw new Error(`${ktx.bin} failed to run: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(
      `${ktx.bin} exited ${res.status}\n  ${ktx.bin} ${args.join(' ')}\n` +
      `${(res.stderr || res.stdout || '').trim().split('\n').slice(0, 6).map((l) => '  ' + l).join('\n')}`
    );
  }
}

/** Re-encode raw image bytes at the given size in their OWN format (jpeg 92 / png). */
async function resizeInFormat(sharp, image, width, height, mime) {
  let p = sharp(Buffer.from(image)).resize(width, height, { fit: 'fill' });
  return mime === 'image/png' ? p.png().toBuffer() : p.jpeg({ quality: 92 }).toBuffer();
}

/**
 * Compress every texture in the document to KTX2, capped PER PART, keeping whichever
 * of {KTX2, source-at-the-cap} is actually smaller — and saying which, per texture.
 */
async function compressTextures(doc, deps, preset, tmpDir, notes, pathPart) {
  const { KHRTextureBasisu } = deps['@gltf-transform/extensions'];
  const { listTextureSlots, getTextureColorSpace } = deps['@gltf-transform/functions'];
  const sharp = deps.sharp.default ?? deps.sharp;
  const classification = classifyTextures(doc, deps['@gltf-transform/core'], pathPart);

  let converted = 0;
  const textures = doc.getRoot().listTextures();

  for (let i = 0; i < textures.length; i++) {
    const texture = textures[i];
    const image = texture.getImage();
    const mime = texture.getMimeType();
    const cls = classification.get(texture);
    const part = cls ? cls.part : null;
    const label = (texture.getName() || `texture[${i}]`) + (part ? ` [${part}]` : '');
    if (!image) continue;
    if (mime === 'image/ktx2') { notes.push(`      ${label}: already KTX2, left alone`); continue; }

    // Which encoder profile: normal maps are destroyed by ETC1S unless it is told they
    // are normals, and colour maps must be tagged sRGB or they come back washed out.
    const slots = listTextureSlots(texture);
    const isNormal = slots.includes('normalTexture');
    const srgb = getTextureColorSpace(texture) === 'srgb';
    const plan = isNormal ? preset.normal : (srgb ? preset.colour : preset.linear);

    // Decode + (optionally) downscale to the part's cap. Block encoders want
    // multiple-of-4 dimensions, and the aspect ratio is preserved — a non-uniform
    // resize would shear the UVs.
    const meta = await sharp(Buffer.from(image)).metadata();
    let { width, height } = meta;
    const cap = capFor(part, preset);
    let capped = false, resized = false;
    if (cap && Math.max(width, height) > cap) {
      const f = cap / Math.max(width, height);
      width = Math.max(4, Math.round((width * f) / 4) * 4);
      height = Math.max(4, Math.round((height * f) / 4) * 4);
      capped = resized = true;
    } else if (width % 4 || height % 4) {
      width = Math.max(4, Math.round(width / 4) * 4);
      height = Math.max(4, Math.round(height / 4) * 4);
      resized = true;
    }

    const pngPath = join(tmpDir, `tex${i}.png`);
    const ktxPath = join(tmpDir, `tex${i}.ktx2`);
    let pipeline = sharp(Buffer.from(image));
    if (resized) pipeline = pipeline.resize(width, height, { fit: 'fill' });
    await pipeline.png({ compressionLevel: 1 }).toFile(pngPath);

    runKtx(deps.ktx, plan, srgb, pngPath, ktxPath);
    const ktxBytes = await readFile(ktxPath);

    const was = image.byteLength;
    const now = ktxBytes.byteLength;
    const dims = resized ? `${meta.width}×${meta.height}→${width}×${height}` : `${width}×${height}`;

    if (now < was || preset.alwaysKtx2) {
      texture.setImage(new Uint8Array(ktxBytes)).setMimeType('image/ktx2');
      const uri = texture.getURI();
      if (uri) texture.setURI(uri.replace(/\.[^.]+$/, '.ktx2'));
      converted++;
      const grew = now >= was ? '  [LARGER on disk, kept for the VRAM win — quality tier]' : '';
      notes.push(`      ${label}: ${dims} ${plan.mode.toUpperCase()} ${fmt(was)} → ${fmt(now)} (${pct(was, now)})${grew}`);
    } else if (capped) {
      // KTX2 lost the byte race, but the ORIGINAL bytes are disqualified — they are
      // over the part cap. The honest fallback is the resized image in its own format;
      // ship whichever of the two candidates is smaller. Falling back to the original
      // here is how a "1024 body cap" would quietly ship an 8192² map.
      const rebytes = await resizeInFormat(sharp, image, width, height, mime);
      if (now <= rebytes.byteLength) {
        texture.setImage(new Uint8Array(ktxBytes)).setMimeType('image/ktx2');
        const uri = texture.getURI();
        if (uri) texture.setURI(uri.replace(/\.[^.]+$/, '.ktx2'));
        converted++;
        notes.push(`      ${label}: ${dims} ${plan.mode.toUpperCase()} ${fmt(was)} → ${fmt(now)} (capped; KTX2 beats resized ${mime.replace('image/', '')} ${fmt(rebytes.byteLength)})`);
      } else {
        texture.setImage(new Uint8Array(rebytes));      // same mime, same URI — just smaller pixels
        notes.push(`      ${label}: ${dims} kept as ${mime.replace('image/', '')} at the cap ${fmt(was)} → ${fmt(rebytes.byteLength)} (KTX2 ${fmt(now)} was larger)`);
      }
    } else {
      // Say it out loud. KTX2 beating an already-JPEG source is not a given, and a
      // silent "optimised" file that grew is exactly the lie this tool must not tell.
      notes.push(`      ${label}: ${dims} ${plan.mode.toUpperCase()} ${fmt(now)} is LARGER than the source ${fmt(was)} → kept source ${mime}`);
    }
    await rm(pngPath, { force: true });
    await rm(ktxPath, { force: true });
  }

  if (converted > 0) doc.createExtension(KHRTextureBasisu).setRequired(true);
  return converted;
}

// ── position-quantisation budget (only used with --quantize-positions) ─────────────

/**
 * Mirrors glTF-Transform's own `getPositionQuantizationVolume` + `getNodeTransform`:
 * the grid is the mesh's bounding box, expanded to hold 2× the morph delta bounds, and
 * `scale` is its largest half-extent. Reimplemented (not imported — they are private)
 * so the bit choice can be made from measured geometry BEFORE anything is destroyed,
 * and so the resulting error can be predicted exactly rather than hoped at.
 */
function meshQuantizationVolume(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const relMin = [Infinity, Infinity, Infinity];
  const relMax = [-Infinity, -Infinity, -Infinity];
  let hasRel = false;
  const fold = (accessor, lo, hi) => {
    const a = accessor.getMinNormalized([]);
    const b = accessor.getMaxNormalized([]);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a[i]); hi[i] = Math.max(hi[i], b[i]); }
  };
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (pos) fold(pos, min, max);
    for (const target of prim.listTargets()) {
      const tp = target.getAttribute('POSITION');
      if (tp) { fold(tp, relMin, relMax); hasRel = true; }
    }
  }
  if (!Number.isFinite(min[0])) return null;
  if (hasRel) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], Math.min(relMin[i], relMin[i] * 2, 0));
      max[i] = Math.max(max[i], Math.max(relMax[i], relMax[i] * 2, 0));
    }
  }
  const scale = Math.max((max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2);
  const offset = [min[0] + (max[0] - min[0]) / 2, min[1] + (max[1] - min[1]) / 2, min[2] + (max[2] - min[2]) / 2];
  return { scale, offset };
}

/** Worst-case error of `bits`-bit signed quantisation over a half-extent — half a step. */
const worstError = (scale, bits) => scale / (2 ** (bits - 1) - 1) / 2;

/**
 * Largest mesh decides. Returns {bits} if 16 bits or fewer clear the budget on EVERY
 * mesh, else {bits: null, worst} — glTF-Transform's quantize() is document-wide, so
 * one mesh that cannot clear the budget disqualifies the whole file.
 */
function positionBitsFor(doc) {
  let worstScale = 0;
  let worstMesh = '';
  for (const mesh of doc.getRoot().listMeshes()) {
    const vol = meshQuantizationVolume(mesh);
    if (!vol) continue;
    if (vol.scale > worstScale) { worstScale = vol.scale; worstMesh = mesh.getName() || '(unnamed)'; }
  }
  if (worstScale === 0) return { bits: null, worstScale, worstMesh };
  for (let bits = 8; bits <= 16; bits++) {
    if (worstError(worstScale, bits) <= PRECISION_BUDGET_M) {
      return { bits, worstScale, worstMesh, error: worstError(worstScale, bits) };
    }
  }
  return { bits: null, worstScale, worstMesh, error: worstError(worstScale, 16) };
}

// ── structural signature + checksums (the proof that nothing moved) ────────────────

/**
 * FNV-1a over an accessor's VALUES — deliberately not over its raw bytes.
 * quantize() narrows a Uint32 index buffer to Uint16 whenever the primitive has fewer
 * than 65535 vertices. That is lossless and a real saving (100 KB on the mars head
 * alone), but a byte hash flags it as corruption. Hashing the numeric values through a
 * fixed 8-byte window makes the check component-type independent while staying exact
 * for both integers and float32.
 */
const CK_BUF = new ArrayBuffer(8);
const CK_F64 = new Float64Array(CK_BUF);
const CK_U8 = new Uint8Array(CK_BUF);
function checksum(array) {
  let h = 0x811c9dc5;
  for (let i = 0; i < array.length; i++) {
    CK_F64[0] = array[i];
    for (let b = 0; b < 8; b++) { h ^= CK_U8[b]; h = Math.imul(h, 0x01000193); }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Index hash for TRIANGLES, normalised so the lowest vertex index leads each triangle.
 *
 * MEASURED, not assumed: meshopt's index codec preserves the triangle COUNT, the
 * triangle ORDER and the winding, but it rotates the corner order within individual
 * triangles — 27907 of 45508 triangles on Quiff.glb. That is how the codec earns its
 * ratio and it is not configurable. Rotating a triangle is the same triangle, so it
 * must not fail the run; reordering, dropping or flipping one is a different thing
 * entirely and must. Normalising the rotation away separates the two: a winding flip
 * (a,b,c)→(c,b,a) does not normalise to the same triple, so it is still caught.
 *
 * The consequence is reported per file, because it is real: a triangle+barycentric
 * binding taken against the full-quality asset (landmarks, lash roots) lands on the
 * wrong point inside its triangle if the corners rotated under it. Bindings must be
 * recomputed against the optimized mesh, or stored as a vertex-id triple rather than a
 * triangle index.
 */
function triangleHash(array) {
  let h = 0x811c9dc5;
  const fold = (v) => {
    CK_F64[0] = v;
    for (let b = 0; b < 8; b++) { h ^= CK_U8[b]; h = Math.imul(h, 0x01000193); }
  };
  for (let i = 0; i + 2 < array.length; i += 3) {
    const a = array[i], b = array[i + 1], c = array[i + 2];
    if (a <= b && a <= c) { fold(a); fold(b); fold(c); }
    else if (b <= a && b <= c) { fold(b); fold(c); fold(a); }
    else { fold(c); fold(a); fold(b); }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** How many triangles came back with rotated corners — for the per-file report. */
function countCornerRotations(srcDoc, dstDoc) {
  let rotated = 0;
  let total = 0;
  const srcMeshes = srcDoc.getRoot().listMeshes();
  const dstMeshes = dstDoc.getRoot().listMeshes();
  for (let m = 0; m < srcMeshes.length && m < dstMeshes.length; m++) {
    const sp = srcMeshes[m].listPrimitives();
    const dp = dstMeshes[m].listPrimitives();
    for (let p = 0; p < sp.length && p < dp.length; p++) {
      if (sp[p].getMode() !== 4) continue;
      const a = sp[p].getIndices()?.getArray();
      const b = dp[p].getIndices()?.getArray();
      if (!a || !b || a.length !== b.length) continue;
      for (let i = 0; i + 2 < a.length; i += 3) {
        total++;
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) rotated++;
      }
    }
  }
  return { rotated, total };
}

/**
 * Everything the SDK looks up by name or by index, plus per-primitive geometry
 * fingerprints. Captured from the source BEFORE transforming, and again from the
 * output re-read FROM DISK, so the comparison is against the shipped bytes.
 */
function signature(doc, { withGeometryChecksums }) {
  const root = doc.getRoot();
  return {
    nodes: root.listNodes().map((n) => n.getName()),
    skins: root.listSkins().map((s) => ({
      name: s.getName(),
      joints: s.listJoints().map((j) => j.getName()),
      ibm: s.getInverseBindMatrices()?.getCount() ?? 0,
    })),
    animations: root.listAnimations().map((a) => ({ name: a.getName(), channels: a.listChannels().length })),
    meshes: root.listMeshes().map((mesh) => ({
      name: mesh.getName(),
      // targetNames is where morph-target NAMES actually live in glTF. Losing or
      // reordering it is the silent break the SDK cannot detect at runtime.
      targetNames: mesh.getExtras()?.targetNames ?? null,
      prims: mesh.listPrimitives().map((prim) => {
        const pos = prim.getAttribute('POSITION');
        const idx = prim.getIndices();
        return {
          mode: prim.getMode(),
          vertices: pos ? pos.getCount() : 0,
          indices: idx ? idx.getCount() : 0,
          semantics: prim.listSemantics().slice().sort(),
          targets: prim.listTargets().map((t) => t.listSemantics().slice().sort().join('+')),
          indexHash: idx ? (prim.getMode() === 4 ? triangleHash(idx.getArray()) : checksum(idx.getArray())) : null,
          // Only meaningful while positions stay float32; with --quantize-positions
          // the bytes are supposed to change, so the hash is dropped from the diff.
          posHash: withGeometryChecksums && pos ? checksum(pos.getArray()) : null,
          targetPosHash: withGeometryChecksums
            ? prim.listTargets().map((t) => {
                const a = t.getAttribute('POSITION');
                return a ? checksum(a.getArray()) : null;
              })
            : null,
        };
      }),
    })),
    materials: root.listMaterials().map((m) => m.getName()),
    textures: root.listTextures().map((t) => t.getName()),
  };
}

/**
 * Walks two signature branches and names the FIRST path that differs, e.g.
 * `meshes[2].prims[0].indexHash`. A truncated dump of two 40 KB JSON blobs tells you
 * something broke but not what, and "something broke" is not a diagnosis.
 */
function firstDifference(a, b, path = '') {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path || '(root)'}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: shape changed`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} → ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDifference(a[key], b[key], path ? `${path}.${key}` : key);
    if (d) return d;
  }
  return null;
}

/** Structural diff. Returns {fatal: [...], warn: [...]}. */
function diffSignature(before, after) {
  const fatal = [];
  const warn = [];
  const cmp = (key, bucket) => {
    const d = firstDifference(before[key], after[key], key);
    if (d) bucket.push(d);
  };
  // Names, order, counts, vertex order, triangle indices → the SDK's whole addressing
  // scheme. Any change here is a hard failure.
  cmp('nodes', fatal);
  cmp('skins', fatal);
  cmp('animations', fatal);
  cmp('meshes', fatal);
  // Materials/textures can legitimately shrink (glTF-Transform prunes genuinely unused
  // ones), so those are reported but not fatal.
  cmp('materials', warn);
  cmp('textures', warn);
  return { fatal, warn };
}

// ── the per-file pipeline ──────────────────────────────────────────────────────────

async function optimizeGltf(srcPath, dstPath, opts, preset, deps, tmpDir, pathPart) {
  const { NodeIO, VertexLayout } = deps['@gltf-transform/core'];
  const ext = deps['@gltf-transform/extensions'];
  const fns = deps['@gltf-transform/functions'];
  const notes = [];

  // SEPARATE layout for the same reason tools/build-spectrum.mjs uses it: interleaved
  // buffers let an in-place attribute write corrupt its neighbours.
  const io = new NodeIO().registerExtensions(ext.ALL_EXTENSIONS).setVertexLayout(VertexLayout.SEPARATE);
  if (opts.codec === 'meshopt') {
    const { MeshoptEncoder, MeshoptDecoder } = deps.meshoptimizer;
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    io.registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  } else {
    const draco3d = deps.draco3dgltf.default ?? deps.draco3dgltf;
    io.registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'draco3d.decoder': await draco3d.createDecoderModule(),
    });
  }

  const doc = await io.read(srcPath);
  // glTF-Transform's INFO chatter interleaves with the size report and makes it
  // unreadable; warnings ("Skipping TEXCOORD_1; out of [0,1] range") still come through.
  const { Logger } = deps['@gltf-transform/core'];
  doc.setLogger(new Logger(Logger.Verbosity.WARN));

  // ── decide the position policy before touching anything ──
  let positionBits = null;
  let positionBound = 0;
  if (opts.quantizePositions) {
    const plan = positionBitsFor(doc);
    positionBound = plan.error ?? 0;
    if (plan.bits === null) {
      notes.push(
        `      positions: NOT quantised — mesh "${plan.worstMesh}" has a ${(plan.worstScale * 100).toFixed(1)} cm ` +
        `half-extent, so even 16 bits gives ${(plan.error * 1e6).toFixed(1)} µm > the ${(PRECISION_BUDGET_M * 1e6).toFixed(1)} µm budget`
      );
    } else {
      positionBits = plan.bits;
      notes.push(
        `      positions: ${plan.bits}-bit (mesh "${plan.worstMesh}", ${(plan.worstScale * 100).toFixed(1)} cm half-extent ` +
        `→ ${(plan.error * 1e6).toFixed(2)} µm worst error, budget ${(PRECISION_BUDGET_M * 1e6).toFixed(1)} µm)`
      );
    }
  }

  const sparseTargets = countSparseTargets(doc);
  // `--quality full` means no quantize pass runs at all. If --quantize-positions was
  // ALSO passed, positionBits was still computed above, which used to (a) turn the
  // geometry checksums OFF and (b) print a quantisation report for a quantisation that
  // never happened — the tool's two central honesty claims, both defeated by one flag
  // combination. Positions are only actually quantised when a preset asks for it, so
  // that is what decides both the checksums and the wording below.
  const positionsQuantised = positionBits !== null && !!preset.quantize;
  const before = signature(doc, { withGeometryChecksums: !positionsQuantised });

  // ── geometry ──
  if (opts.codec === 'meshopt') {
    if (preset.quantize) {
      // pattern: what gets quantised on the BASE primitive.
      // patternTargets: what gets quantised on MORPH TARGETS — nothing, ever (header).
      // NORMAL/TANGENT are deliberately absent from `pattern` too: meshopt's octahedral
      // filter encodes them better than an int16 triple, and it leaves the morph
      // deltas at filter=NONE, i.e. lossless.
      const semantics = positionBits !== null
        ? /^(POSITION|TEXCOORD|COLOR|WEIGHTS)(_\d+)?$/
        : /^(TEXCOORD|COLOR|WEIGHTS)(_\d+)?$/;
      await doc.transform(fns.quantize({
        ...preset.quantize,
        pattern: semantics,
        // The ONLY case a morph target is quantised: the user opted into position
        // quantisation, and then base and target MUST use the same grid or the deltas
        // land in the wrong units.
        patternTargets: positionBits !== null ? /^POSITION$/ : /^$/,
        quantizePosition: positionBits ?? 16,
        quantizationVolume: 'mesh',
        // quantize()'s own cleanup dedups SKINs and MATERIALs, and `keepUniqueNames`
        // only protects properties that HAVE names — mars.glb carries five identical
        // unnamed 73-joint skins and the built-in cleanup silently merged them into
        // one, renumbering the skin list. Harmless for three.js (skins bind by node
        // reference), not harmless for anything that indexes `gltf.skins[n]`. So
        // cleanup is off and the tidy-up below is scoped to accessors only.
        cleanup: false,
      }));
      const { PropertyType } = deps['@gltf-transform/core'];
      await doc.transform(
        // Quantising a skinned mesh CLONES the Skin (the inverse bind matrices absorb
        // the rescale), orphaning the original — so SKIN is pruned in that case only.
        fns.prune({
          propertyTypes: positionBits !== null
            ? [PropertyType.ACCESSOR, PropertyType.SKIN]
            : [PropertyType.ACCESSOR],
          keepAttributes: true, keepIndices: true, keepLeaves: true, keepSolidTextures: true,
        }),
        fns.dedup({ propertyTypes: [PropertyType.ACCESSOR], keepUniqueNames: true }),
      );
    }
    doc.createExtension(ext.EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({
        method: preset.meshoptMethod === 'filter'
          ? ext.EXTMeshoptCompression.EncoderMethod.FILTER
          : ext.EXTMeshoptCompression.EncoderMethod.QUANTIZE,
      });
    if (sparseTargets > 0) {
      notes.push(`      ${sparseTargets} sparse morph accessor(s) bypass meshopt by design (already near-optimal)`);
    }
  } else {
    // Draco. Guarded, because on this product's assets it is usually the wrong answer.
    const hasTargets = doc.getRoot().listMeshes()
      .some((m) => m.listPrimitives().some((p) => p.listTargets().length > 0));
    if (hasTargets) {
      throw new Error(
        `${basename(srcPath)} has morph targets and --codec draco was requested.\n` +
        `  KHR_draco_mesh_compression cannot compress morph targets, glTF-Transform's draco()\n` +
        `  welds vertices first (which reorders them and detaches the spectrum delta blob and\n` +
        `  the landmark bindings), and the encoder falls back to sequential mode. Use meshopt.`
      );
    }
    await doc.transform(fns.draco({
      method: 'edgebreaker',
      quantizePosition: positionBits ?? 14,
      quantizeNormal: 10,
      quantizeTexcoord: preset.quantize?.quantizeTexcoord ?? 12,
      quantizeColor: 8,
      quantizeGeneric: 12,
      quantizationVolume: 'mesh',
    }));
  }

  // ── textures ──
  const texCount = doc.getRoot().listTextures().length;
  if (texCount > 0) await compressTextures(doc, deps, preset, tmpDir, notes, pathPart);

  // ── write, then re-read FROM DISK and prove it survived ──
  await mkdir(dirname(dstPath), { recursive: true });
  await io.write(dstPath, doc);

  // From here to the success return, ANY failure deletes the output. A throw between
  // the write and the structural verdict (an unreadable round-trip, an OOM inside the
  // signature walk) used to leave a corrupt file on disk while the report said FAILED —
  // exactly the file someone ships because "it's there".
  let roundTrip, fatal, warn;
  try {
    roundTrip = await io.read(dstPath);
    const after = signature(roundTrip, { withGeometryChecksums: !positionsQuantised });
    ({ fatal, warn } = diffSignature(before, after));
  } catch (err) {
    await rm(dstPath, { force: true });
    throw err;
  }
  for (const w of warn) notes.push(`      NOTE  ${w}`);

  if (fatal.length) {
    // Do not leave a file behind that someone might ship.
    await rm(dstPath, { force: true });
    throw new Error(
      `${basename(srcPath)}: the optimized file does not match its source. Output deleted.\n` +
      fatal.map((f) => '      ' + f).join('\n')
    );
  }
  if (!positionsQuantised) {
    // Morph NORMAL/TANGENT deltas are NOT hashed by signature() — only morph POSITION
    // is. Say what was actually checked; the previous wording claimed "every morph
    // delta", which covered attributes this tool never compared.
    notes.push('      verified: vertex order, base positions and every morph POSITION delta are BIT-IDENTICAL');
  } else {
    // Two different numbers, and conflating them would overclaim: the first is what the
    // chosen bit count costs by construction, the second is drift introduced by the
    // write/read path itself (which must be zero — the codec is lossless from here on).
    const drift = measurePositionError(doc, roundTrip);
    notes.push(
      `      verified: names/order intact; quantisation error ≤ ${(positionBound * 1e6).toFixed(2)} µm by construction, ` +
      `write/read drift ${(drift * 1e6).toFixed(2)} µm`
    );
  }
  const rot = countCornerRotations(doc, roundTrip);
  if (rot.rotated > 0) {
    notes.push(
      `      verified: triangle count, order and winding intact — but the index codec rotated the corner\n` +
      `                order of ${rot.rotated}/${rot.total} triangles. Recompute any triangle+barycentric\n` +
      `                binding against this file, or store bindings as vertex-id triples.`
    );
  }

  return { notes };
}

function countSparseTargets(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const target of prim.listTargets()) {
        for (const semantic of target.listSemantics()) {
          if (target.getAttribute(semantic).getSparse()) n++;
        }
      }
    }
  }
  return n;
}

/**
 * With --quantize-positions the bytes are supposed to change, so the checksum test is
 * replaced by an actual measurement: worst |source − round-tripped| over every base
 * position and every morph delta. glTF-Transform's Accessor denormalises int16 on
 * read, so the reconstructed value is `normalized × meshScale (+ offset for the base)`.
 * The transform in `doc` is post-quantisation, so its volume is re-derived per mesh.
 */
function measurePositionError(srcDocPostTransform, dstDoc) {
  // srcDocPostTransform has already been quantised in place, so it and dstDoc should
  // agree exactly; the useful comparison is against the analytic bound, which
  // positionBitsFor() already reported. Compare the two documents element-wise as a
  // guard against a write/read path that silently rescales.
  let worst = 0;
  const srcMeshes = srcDocPostTransform.getRoot().listMeshes();
  const dstMeshes = dstDoc.getRoot().listMeshes();
  for (let m = 0; m < srcMeshes.length; m++) {
    const vol = meshQuantizationVolume(dstMeshes[m]);
    const scale = vol ? vol.scale : 1;
    const srcPrims = srcMeshes[m].listPrimitives();
    const dstPrims = dstMeshes[m].listPrimitives();
    for (let p = 0; p < srcPrims.length; p++) {
      const pairs = [[srcPrims[p].getAttribute('POSITION'), dstPrims[p].getAttribute('POSITION')]];
      const st = srcPrims[p].listTargets();
      const dt = dstPrims[p].listTargets();
      for (let t = 0; t < st.length; t++) pairs.push([st[t].getAttribute('POSITION'), dt[t].getAttribute('POSITION')]);
      for (const [sa, da] of pairs) {
        if (!sa || !da) continue;
        const n = sa.getCount();
        const stride = Math.max(1, Math.floor(n / 4096));   // strided sample, deterministic
        const se = [], de = [];
        for (let i = 0; i < n; i += stride) {
          sa.getElement(i, se);
          da.getElement(i, de);
          for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(se[c] - de[c]) * (sa.getNormalized() ? scale : 1));
        }
      }
    }
  }
  return worst;
}

// ── loose files: recipe atlases, hair/eyes/spectrum images ─────────────────────────

/**
 * The spectrum sidecars (`spectrum/<file>`) are anonymous hashes on disk, but the
 * spectrum.bin header names the MESH each one belongs to — the same mapping the SDK
 * itself uses to load them. Parse it once and classify each file by its mesh's part.
 * A file two meshes share keeps ALL its parts; the cap resolver takes the largest.
 */
async function spectrumFileParts(inDir) {
  const parts = new Map();               // file name -> Set(part)
  const buf = await readFile(join(inDir, 'spectrum.bin')).catch(() => null);
  if (!buf || buf.length < 8) return parts;
  try {
    const jsonLen = buf.readUInt32LE(4);
    const head = JSON.parse(buf.slice(8, 8 + jsonLen).toString('utf8'));
    for (const mesh of head.meshes || []) {
      const cls = partOfNames([mesh.nodeA || mesh.name || '']);
      const part = cls ? cls.part : 'body';     // sidecars are character skin by definition
      for (const prim of mesh.prims || []) {
        for (const t of prim.texs || []) {
          if (!t || !t.file) continue;
          if (!parts.has(t.file)) parts.set(t.file, new Set());
          parts.get(t.file).add(part);
        }
      }
    }
  } catch { /* unreadable header — sidecars are then copied unchanged, and say so */ }
  return parts;
}

/** Which part a LOOSE image belongs to, by its place in the fetch-assets layout. */
function looseImageParts(relPosix, spectrumParts) {
  if (!LOOSE_IMG_EXT.test(relPosix)) return null;
  if (/^hair\//i.test(relPosix)) return ['hair'];
  if (/^eyes\//i.test(relPosix)) return ['eyes'];
  if (/^spectrum\//i.test(relPosix)) {
    const set = spectrumParts.get(relPosix.slice('spectrum/'.length));
    return set && set.size ? [...set] : null;   // unmapped sidecar → do not guess
  }
  return null;
}

/**
 * Downscale one loose image to its part cap, KEEPING its format — these files are
 * loaded by the SDK as plain images (the hair atlas via the shader, the eye albedos
 * via a texture swap, the sidecars via TextureLoader), so KTX2 has no place here.
 * Returns null when the image is already within the cap (caller copies unchanged).
 */
async function optimizeLooseImage(src, dst, partsList, preset, deps) {
  const sharp = deps.sharp.default ?? deps.sharp;
  const cap = Math.max(...partsList.map((p) => capFor(p, preset)));
  if (!cap) return null;
  const bytes = await readFile(src);
  const meta = await sharp(bytes).metadata();
  if (Math.max(meta.width || 0, meta.height || 0) <= cap) return null;
  const isPng = /\.png$/i.test(src);
  const out = await (isPng
    ? sharp(bytes).resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true }).png()
    : sharp(bytes).resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 })
  ).toBuffer();
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, out);
  const dims = await sharp(out).metadata();
  return {
    before: bytes.length,
    after: out.length,
    note: `${meta.width}×${meta.height}→${dims.width}×${dims.height} [${partsList.join('+')}] ${fmt(bytes.length)} → ${fmt(out.length)} (${pct(bytes.length, out.length)})`,
  };
}

/**
 * A `.recipe.json` blend source carries the character's baked diffuse atlases as data
 * URIs, keyed by mesh name (`textures[name]`) — these ARE the blend textures the face
 * option is about. Each atlas is classified by its mesh name and downscaled to its
 * part's cap, re-encoded in its own format (JPEG 92 / PNG, matching the exporter).
 * Geometry, morphs and every other field pass through byte-untouched.
 */
async function optimizeRecipe(src, dst, preset, deps, notes) {
  const sharp = deps.sharp.default ?? deps.sharp;
  const text = await readFile(src, 'utf8');
  let recipe;
  try { recipe = JSON.parse(text); }
  catch { return null; }                        // not JSON — caller copies it unchanged
  if (!recipe || typeof recipe !== 'object' || !recipe.textures || !preset.parts) return null;

  let changed = false;
  for (const [meshName, uri] of Object.entries(recipe.textures)) {
    const m = /^data:(image\/(?:png|jpeg));base64,(.*)$/s.exec(String(uri));
    if (!m) { notes.push(`      ${meshName}: not an image data URI — left alone`); continue; }
    const cls = partOfNames([meshName]);
    const part = cls ? cls.part : 'body';       // a recipe atlas is character skin by definition
    const cap = capFor(part, preset);
    const bytes = Buffer.from(m[2], 'base64');
    const meta = await sharp(bytes).metadata();
    if (!cap || Math.max(meta.width || 0, meta.height || 0) <= cap) {
      notes.push(`      ${meshName} [${part}]: ${meta.width}×${meta.height} already ≤ ${cap || 'source'} — kept`);
      continue;
    }
    const isPng = m[1] === 'image/png';
    const out = await (isPng
      ? sharp(bytes).resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true }).png()
      : sharp(bytes).resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 })
    ).toBuffer();
    recipe.textures[meshName] = `data:${m[1]};base64,${out.toString('base64')}`;
    changed = true;
    notes.push(`      ${meshName} [${part}]: ${meta.width}×${meta.height}→≤${cap} ${fmt(bytes.length)} → ${fmt(out.length)} (${pct(bytes.length, out.length)})`);
  }

  await mkdir(dirname(dst), { recursive: true });
  const outText = changed ? JSON.stringify(recipe) : text;
  await writeFile(dst, outText);
  return { before: Buffer.byteLength(text), after: Buffer.byteLength(outText) };
}

// ── directory walk + report ────────────────────────────────────────────────────────

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/**
 * A .gltf's companion .bin and image files are written by io.write() as part of the
 * document — they must not ALSO be copied verbatim, or the out-dir gets an
 * uncompressed twin of everything.
 */
async function gltfSidecars(gltfPath) {
  const consumed = new Set();
  try {
    const json = JSON.parse(await readFile(gltfPath, 'utf8'));
    for (const list of [json.buffers, json.images]) {
      for (const item of list || []) {
        if (!item?.uri || item.uri.startsWith('data:')) continue;
        consumed.add(resolve(dirname(gltfPath), decodeURIComponent(item.uri)));
      }
    }
  } catch { /* unparseable .gltf — optimizeGltf will report it properly */ }
  return consumed;
}

const fmt = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};
const pct = (before, after) => {
  if (!before) return '—';
  const d = (1 - after / before) * 100;
  return `${d >= 0 ? '−' : '+'}${Math.abs(d).toFixed(1)}%`;
};

// ── main ───────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }

  // NEVER MODIFY THE INPUT. Not "try not to" — refuse the arrangement outright.
  //
  // This guard was a case-SENSITIVE string compare, which is a hole on Windows —
  // the platform this repo runs on. `optimize-assets.mjs assets ASSETS` passed it
  // while both paths resolved to the same directory, and because a failed
  // structural check does `rm(dstPath)`, the tool would then DELETE the input.
  // The inputs are `_prepared/` and `_hair/` — owner-authored data that no
  // checkout brings back. So: resolve symlinks/junctions with realpath, compare
  // case-insensitively on Windows, and reject overlap in BOTH directions (in-dir
  // inside out-dir is just as fatal, and was not checked at all).
  const inStat0 = await stat(opts.inDir).catch(() => null);
  if (!inStat0?.isDirectory()) throw new Error(`in-dir not found: ${opts.inDir}`);
  const realIn = await realpath(opts.inDir);
  // out-dir may not exist yet; walk up to the nearest existing ancestor so a
  // junction anywhere along the path is still resolved.
  let resolvedOut = opts.outDir, probe = opts.outDir;
  for (;;) {
    const rp = await realpath(probe).catch(() => null);
    if (rp) { resolvedOut = join(rp, relative(probe, opts.outDir)); break; }
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s).replace(/[\\/]+$/, '');
  const nIn = norm(realIn), nOut = norm(resolvedOut);
  if (nIn === nOut) throw new Error(`out-dir and in-dir are the same directory (${realIn}). Refusing: this tool never writes into its input.`);
  if ((nOut + sep).startsWith(nIn + sep)) throw new Error(`out-dir (${resolvedOut}) is inside in-dir (${realIn}). Refusing.`);
  if ((nIn + sep).startsWith(nOut + sep)) throw new Error(`in-dir (${realIn}) is inside out-dir (${resolvedOut}). Refusing: outputs would land on your source assets.`);

  const deps = await loadDeps(opts);

  // The effective preset: the tier, with `--face-res` overriding the face cap.
  const preset = { ...QUALITY[opts.quality] };
  if (preset.parts) {
    preset.parts = { ...preset.parts, ...(opts.faceRes ? { face: opts.faceRes } : {}) };
  }

  const files = (await walk(opts.inDir)).sort();
  const gltfFiles = files.filter((f) => GLTF_EXT.has(extname(f).toLowerCase()));
  const consumed = new Set();
  for (const g of gltfFiles) if (extname(g).toLowerCase() === '.gltf') {
    for (const s of await gltfSidecars(g)) consumed.add(s);
  }

  // The spectrum sidecar → mesh mapping, for classifying `spectrum/<file>` images.
  const spectrumParts = preset.parts ? await spectrumFileParts(opts.inDir) : new Map();

  // --dry does the whole job into a temp dir so the numbers reported are the real
  // output sizes, then throws the temp dir away. A dry run that guesses is worthless.
  const realOut = opts.outDir;
  const workOut = opts.dry ? await mkdtemp(join(tmpdir(), 'optimize-assets-dry-')) : realOut;
  const tmpDir = await mkdtemp(join(tmpdir(), 'optimize-assets-tex-'));

  console.log(`optimize-assets  quality=${opts.quality}  codec=${opts.codec}` +
    `${opts.quantizePositions ? '  --quantize-positions' : ''}${opts.dry ? '  (DRY RUN — nothing written)' : ''}`);
  console.log(`  in   ${opts.inDir}`);
  console.log(`  out  ${realOut}`);
  console.log(`  ktx2 ${deps.ktx.bin} (${deps.ktx.kind}) — ${deps.ktx.version}`);
  if (preset.parts) {
    const p = preset.parts;
    console.log(`  caps body ${p.body} · face ${p.face} · eyes ${p.eyes} · teeth ${p.teeth} · hair ${p.hair}` +
      ` — per part; unclassified textures (garments) cap at ${preset.maxTexture}`);
  } else {
    console.log(`  caps none — full quality keeps source resolution` +
      (opts.faceRes ? ' (--face-res ignored on this tier)' : ''));
  }
  console.log('');

  let totalBefore = 0;
  let totalAfter = 0;
  const failures = [];

  try {
    for (const src of files) {
      if (consumed.has(src)) continue;
      const rel = relative(opts.inDir, src);
      const relPosix = rel.split(sep).join('/');
      const dst = join(workOut, rel);
      const beforeBytes = (await stat(src)).size;

      if (GLTF_EXT.has(extname(src).toLowerCase())) {
        try {
          // Everything under hair/ that carries no names of its own is still hair.
          const pathPart = preset.parts && /^hair\//i.test(relPosix) ? 'hair' : null;
          const { notes } = await optimizeGltf(src, dst, opts, preset, deps, tmpDir, pathPart);
          const afterBytes = (await stat(dst)).size;
          totalBefore += beforeBytes;
          totalAfter += afterBytes;
          console.log(`  ${rel}\n      ${fmt(beforeBytes)} → ${fmt(afterBytes)}  (${pct(beforeBytes, afterBytes)})`);
          for (const n of notes) console.log(n);
        } catch (err) {
          // A failed file is counted in NEITHER total. Folding its input size into
          // "before" with nothing in "after" reports a saving that is really a missing
          // file — the report has to be about what actually got written.
          failures.push(`${rel}: ${err.message}`);
          console.log(`  ${rel}\n      FAILED — ${err.message.split('\n')[0]}`);
        }
      } else if (preset.parts && /\.recipe\.json$/i.test(relPosix)) {
        // The blend sources — their atlases are the face/body blend textures.
        try {
          const notes = [];
          const r = await optimizeRecipe(src, dst, preset, deps, notes);
          if (r) {
            totalBefore += r.before;
            totalAfter += r.after;
            console.log(`  ${rel}\n      ${fmt(r.before)} → ${fmt(r.after)}  (${pct(r.before, r.after)})`);
            for (const n of notes) console.log(n);
            continue;
          }
          // Not a recipe after all — fall through to the plain copy.
          totalBefore += beforeBytes;
          await mkdir(dirname(dst), { recursive: true });
          await copyFile(src, dst);
          totalAfter += beforeBytes;
          console.log(`  ${rel}\n      ${fmt(beforeBytes)} copied unchanged (no textures block)`);
        } catch (err) {
          failures.push(`${rel}: ${err.message}`);
          console.log(`  ${rel}\n      FAILED — ${err.message.split('\n')[0]}`);
        }
      } else {
        // Loose images with a place in the layout (hair atlases + scalp masks, eye
        // albedos, spectrum sidecars) are downscaled to their part's cap, in their own
        // format. Everything else — the spectrum delta .bin, manifests, thumbnails
        // already within cap — is copied byte-for-byte and reported as such. No claimed
        // saving where none happened.
        try {
          const partsList = preset.parts ? looseImageParts(relPosix, spectrumParts) : null;
          const r = partsList ? await optimizeLooseImage(src, dst, partsList, preset, deps) : null;
          if (r) {
            totalBefore += r.before;
            totalAfter += r.after;
            console.log(`  ${rel}\n      ${r.note}`);
            continue;
          }
          totalBefore += beforeBytes;
          await mkdir(dirname(dst), { recursive: true });
          await copyFile(src, dst);
          totalAfter += beforeBytes;
          console.log(`  ${rel}\n      ${fmt(beforeBytes)} copied unchanged`);
        } catch (err) {
          failures.push(`${rel}: ${err.message}`);
          console.log(`  ${rel}\n      FAILED — ${err.message.split('\n')[0]}`);
        }
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    if (opts.dry) await rm(workOut, { recursive: true, force: true });
  }

  console.log('');
  console.log(`  TOTAL  ${fmt(totalBefore)} → ${fmt(totalAfter)}  (${pct(totalBefore, totalAfter)})` +
    (failures.length ? `  — over the ${files.length - failures.length} file(s) that succeeded` : ''));
  if (opts.dry) console.log('  (dry run — out-dir untouched)');

  if (failures.length) {
    console.log('');
    console.log(`  ${failures.length} file(s) FAILED — nothing was passed through uncompressed:`);
    for (const f of failures) console.log(`    ${f}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(`\n${err.message}\n`); process.exit(1); },
);

// ---
// Created by Sander Mørch-Jensen · https://creategamecharacters.com/agent/integration/licensing.md
// Removing this signature breaks the license.
