// Created by Sander Mørch-Jensen — creategamecharacters.com
// License: https://creategamecharacters.com/agent/integration/licensing.md
// Removing this signature breaks the license.
//
// ── the embedded creator runtime, v1 ─────────────────────────────────────────
//
// A game imports this one module, points it at its OWN copy of the assets, and gets a
// character creator inside its own scene. The game owns every pixel of the UI; this file
// owns the character.
//
//   import { Creator } from 'https://creategamecharacters.ai/sdk/v1.js';
//   const creator = await Creator.open({ key: 'ggc_proj_…', assets: './assets/', THREE });
//   const c = creator.spawn({ body: 0.35, face: { jawWidth: 0.6 }, hair: 'Quiff' });
//   scene.add(c.object3D);
//   c.setBody(0.8);                      // one morph weight, per character, any frame
//   c.toRest();                          // forget any animator pose — stand at rest
//   localStorage.mine = JSON.stringify(c.toRecipe());   // this is "saving"
//
// THE FOUR LAWS THIS FILE IS BUILT ON — breaking any of them breaks the product, not
// just this file. They are stated here because every one of them has already been
// re-litigated at least once:
//
//  1. NOTHING IS EVER BAKED. There is no GLB export in this module and there must never
//     be one. A character is a list of numbers — body t, the identity slider values, a
//     hair id, an outfit id, skin params. A few hundred bytes of JSON. `toRecipe()` is
//     the only serialiser and it returns JSON.
//
//  2. ONE GEOMETRY, SHARED BY THE WHOLE CROWD. The site blends the body per-vertex on
//     the CPU because the site has ONE character and its factory/exporter need real
//     geometry to measure. Doing that here would give every character its own copy of
//     the mesh: 50 NPCs = 50 meshes = dead. So the spectrum delta — which is already a
//     quantised per-vertex position/normal delta, i.e. already the shape of a morph
//     target — is uploaded ONCE as a GPU morph target, and a character is a morph
//     WEIGHT. Same for the identity sliders. `spawn()` shares `BufferGeometry` by
//     reference; per character there is only an influences array, a Skeleton, and
//     material params. Do not "simplify" this back to a CPU lerp.
//
//  3. THE CLOTHING FACTORY IS NOT IN HERE. No fitting, no wrap, no tuck, no garment
//     generation, no sculpt brush, no photo scan. An outfit arrives already fitted at
//     BOTH ends and is lerped between the two saved fits, exactly as the body is.
//     Fitting is authoring work, done once per outfit on the site.
//
//  4. ASSETS ARE CUSTOMER-HOSTED. Serving 40 MB per player out of our storage is fatal;
//     the customer fetches the project once at build time and serves it themselves. The
//     gate is THIS MODULE (key-validated), not the assets. `assets` is their base URL.
//
// three.js is a PEER — the game supplies it. Nothing here bundles or pins three.

const SITE = 'https://creategamecharacters.ai';
const VALIDATE_PATH = '/api/sdk/validate';
// The key service is production by default and needs no configuration — but it has to be
// OVERRIDABLE, or the SDK cannot be exercised anywhere except production: a staging origin,
// a self-hosted preview and a local integration test all validate against a different host.
// Hardcoding it meant the very first end-to-end test of this module could not run at all.
// Public only in the sense that `Creator.open({ site })` accepts it; it changes WHERE the key
// is checked, never WHETHER it is.
const validateUrl = (site) => String(site || SITE).replace(/\/+$/, '') + VALIDATE_PATH;

// The delta blob's format identity. Kept in sync with the builder by hand — a blob from a
// newer builder must be REFUSED, never half-read. A stale reader that silently skips the
// fields it does not recognise is how a body once shipped wearing the wrong normal map
// with no error anywhere: it looked like a bug in the art, not in the code.
const SPECTRUM_MAGIC = 0x43455053;   // 'SPEC' little-endian
const SPECTRUM_VERSION = 5;

// ── conform constants ────────────────────────────────────────────────────────
// These are the site's measured values, not taste. They are what the hair replay uses;
// do not round them.
const CONFORM_K = 4;          // nearest scalp/skin samples per hair vertex. ONE is not
                              // enough: a single-nearest lookup makes the driver field
                              // piecewise constant, adjacent vertex rows on a strand jump
                              // between samples, and the strand kinks into zigzags at the
                              // front hairline (reported, fixed by blending K).
const CONFORM_D0 = 0.02;      // m — full follow at or under this distance from the scalp
const CONFORM_D1 = 0.08;      // m — beyond this a card is exactly rigid again, so the hang
                              // shape of long hair is untouched
const CARD_SHORT = 0.07;      // m — bbox diagonal discriminator. Under it a card is a
                              // sideburn/fringe tuft and rides its root RIGIDLY; over it,
                              // a long strand that drapes and needs the per-vertex field.
const GRID_CELL = 0.02;       // m — hash grid cell for the nearest-vertex queries
const WELD_Q = 20000;         // position quantisation for welding coincident card verts

// smoothstep fade from full follow (<= D0) to none (>= D1)
function fade(d) {
  if (d <= CONFORM_D0) return 1;
  if (d >= CONFORM_D1) return 0;
  const t = 1 - (d - CONFORM_D0) / (CONFORM_D1 - CONFORM_D0);
  return t * t * (3 - 2 * t);
}

// ── small helpers ────────────────────────────────────────────────────────────

// SECURITY BOUNDARY - not a convenience default. Asset paths arrive from manifests and
// recipes, and a recipe travels between players the moment a game ships character sharing
// or import. An absolute http(s) path here would let one player's recipe pull assets from a
// server the attacker controls: hijacked delivery, and every viewer's IP reported to them.
// So the base a game declared in Creator.open({ assets }) is enforced - everything resolves
// inside it. Hosting assets on another domain still works: make that domain the base.
// data: and blob: stay allowed - they are inline and local, and cannot reach a third party.
function joinUrl(base, rel) {
  const r = String(rel);
  if (r.startsWith('data:') || r.startsWith('blob:')) return r;
  if (/^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith('//')) {
    throw new Error('[gcc] refusing an absolute asset URL: ' + r.slice(0, 120) +
      '\n  Asset paths must be relative to the assets base given to Creator.open({ assets }). ' +
      'This is a security boundary: a shared or imported recipe could otherwise point at a ' +
      'server this game does not control. To host assets elsewhere, make that location the base.');
  }
  return String(base).replace(/\/+$/, '') + '/' + String(rel).replace(/^\/+/, '');
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`[gcc] ${r.status} fetching ${url}`);
  return r.json();
}

function isIdentityMatrix(m) {
  const e = m.elements;
  return e[0] === 1 && e[5] === 1 && e[10] === 1 && e[15] === 1 &&
    e[1] === 0 && e[2] === 0 && e[3] === 0 && e[4] === 0 && e[6] === 0 && e[7] === 0 &&
    e[8] === 0 && e[9] === 0 && e[11] === 0 && e[12] === 0 && e[13] === 0 && e[14] === 0;
}

// ── peer three.js ────────────────────────────────────────────────────────────
// The game supplies three. We take it from the options, or from a bare `three` specifier
// the integrator has mapped (import map / bundler alias). We NEVER bundle a copy: two
// copies of three in one page means `instanceof` fails across the boundary and the
// character silently refuses to render inside the game's scene.
async function resolveThree(opts) {
  if (opts.THREE) return opts.THREE;
  try { return await import('three'); } catch (_) { /* fall through to the real message */ }
  throw new Error(
    '[gcc] three.js not found. Pass it in — Creator.open({ THREE, … }) — or map the bare ' +
    '"three" specifier in your import map. The SDK deliberately does not bundle three: a ' +
    'second copy in the page breaks every instanceof check against your own scene.');
}

async function resolveGLTFLoader(opts) {
  if (opts.GLTFLoader) return opts.GLTFLoader;
  try { return (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader; } catch (_) {}
  try { return (await import('three/examples/jsm/loaders/GLTFLoader.js')).GLTFLoader; } catch (_) {}
  throw new Error(
    '[gcc] GLTFLoader not found. Pass it in — Creator.open({ GLTFLoader, … }). It is an ' +
    'addon, not part of the three core, so the SDK cannot assume where your build keeps it.');
}

// ── the key gate ─────────────────────────────────────────────────────────────
// The SDK module is the gated piece — not the assets. Any signed-in user can already
// export the assets from the browser, so a runtime asset gate would be theatre. This is
// a deliberate owner decision (2026-08-02), not an oversight.
//
// The key is a PUBLISHABLE, origin-locked, permanently read-only key (the Stripe /
// Google-Maps model). The browser sets `Origin` and page JS cannot forge it, so a key
// lifted from one game does not work on another site. Honest limit: curl can spoof
// Origin, so this is deterrent + rate limit + one-click revocation, not a cryptographic
// lock. Never describe it as more than that to an integrator.
// ── the offline grace ────────────────────────────────────────────────────────
// A game that has validated ONCE must keep working with no connection — owner, 2026-08-31:
// "all it takes is one online check and then it works again."
//
// The failure this fixes was found in a real game (DialogQuest), not imagined: the wifi
// dropped, `open()` threw, the game fell back to loading the base GLB on its own, and the
// character stood there NAKED. Hair and outfits exist only through this module, so a refused
// key undresses everybody. Offline is a normal state for a game, not an error.
//
// WHAT THE CACHE MAY AND MAY NOT DO. It stands in for a server that could not be REACHED,
// never for a server that answered. A 401/402/403 is a real answer: the cache is dropped and
// the refusal stands, so revocation still takes effect the moment the player is online —
// which is the only moment it could ever have taken effect anyway. There is deliberately NO
// expiry: a deadline fires exactly when someone is offline and can do nothing about it, and
// the gate here was never cryptographic (the module and the assets are already on their
// disk — see context/sdk/context.md). The licence is what covers that; this cache only stops
// us breaking paying customers who lost their wifi.
const LICENCE_CACHE = 'gcc.licence.';   // + the publishable key — project keys are public by design

function licenceStore() {
  // A sandboxed iframe THROWS on the property access itself rather than returning undefined,
  // so this cannot be a plain `typeof` guard at the call sites.
  try { return (typeof localStorage !== 'undefined' && localStorage) || null; } catch (_) { return null; }
}

function rememberLicence(key, project) {
  const ls = licenceStore();
  if (!ls) return;
  try { ls.setItem(LICENCE_CACHE + key, JSON.stringify({ at: Date.now(), project })); }
  catch (_) { /* quota or private mode — the online path is unaffected, so this stays silent */ }
}

function recallLicence(key) {
  const ls = licenceStore();
  if (!ls) return null;
  try {
    const raw = ls.getItem(LICENCE_CACHE + key);
    const v = raw ? JSON.parse(raw) : null;
    return (v && v.project) ? v : null;
  } catch (_) { return null; }
}

function forgetLicence(key) {
  const ls = licenceStore();
  if (!ls) return;
  try { ls.removeItem(LICENCE_CACHE + key); } catch (_) { /* nothing to clear */ }
}

// Say it once, and say WHEN — an integrator debugging a stale project needs the date, and a
// player who is simply on a train needs no alarm.
function warnCachedLicence(cached) {
  let when = '';
  try { when = new Date(cached.at).toISOString().slice(0, 10); } catch (_) { when = 'earlier'; }
  console.warn('[gcc] offline — using the key check cached on ' + when +
    '. The character is complete; it re-checks by itself when a connection returns.');
}

async function validateKey(key, site) {
  if (!key || typeof key !== 'string') {
    throw new Error('[gcc] Creator.open({ key }) is required — a project key from creategamecharacters.ai.');
  }
  const URL_ = validateUrl(site);
  let res;
  try {
    res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
  } catch (e) {
    // OFFLINE — nobody refused this key, there was nobody to ask.
    const cached = recallLicence(key);
    if (cached) { warnCachedLicence(cached); return cached.project || {}; }
    // Name the actual failure. "Invalid key" when the real problem is a blocked request
    // sends the integrator hunting through their dashboard for an hour.
    throw new Error('[gcc] could not reach the key service at ' + URL_ +
      ' — network error or blocked by CSP/ad-blocker (' + (e && e.message) + '). This device ' +
      'has no earlier check to fall back on: the FIRST validation needs a connection, once. ' +
      'After that this game runs offline.');
  }
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON body handled below */ }
  if (!res.ok || !body || body.ok !== true) {
    // OUR SIDE FAILING IS NOT THEIR KEY FAILING. A 5xx, a gateway timeout or a rate limit says
    // nothing about whether this key is good, and locking every player out of a shipped game
    // because our worker had a bad five minutes is the same outage as being offline — so it
    // takes the same cached path. Only a real refusal drops the cache.
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      const cached = recallLicence(key);
      if (cached) { warnCachedLicence(cached); return cached.project || {}; }
    } else {
      forgetLicence(key);
    }
    const why = (body && (body.error || body.message)) ||
      (res.status === 401 ? 'the key was rejected' :
       res.status === 403 ? 'this page\'s origin is not on the key\'s allowlist' :
       res.status === 402 ? 'the project has no active subscription' :
       res.status === 429 ? 'rate limited' : 'HTTP ' + res.status);
    throw new Error('[gcc] project key rejected: ' + why +
      '. Check the key and its origin allowlist at creategamecharacters.ai (this page\'s ' +
      'origin is ' + (typeof location !== 'undefined' ? location.origin : 'unknown') + ').');
  }
  // The one online check the offline path stands on.
  rememberLicence(key, body.project || {});
  return body.project || {};
}

// A project key answers two questions: WHICH project, and is this origin allowed to use it.
// On our own site neither is open. The user signed in before the tool would open at all, and
// the assets are ours, not a customer's copy — so the signed-in session is the authorisation
// and a key would only be the site holding a customer credential against itself.
//
// This cannot weaken the key path. `/api/me` is OUR route: a game's page has no such endpoint
// on its own origin, so a cross-origin caller cannot reach this branch at all, and the
// origin-locked key flow above is untouched. Owner, 2026-08-08: "the validation happens with
// the logged in user. the product key is not needed since the user is already logged in to use
// this tool at all."
async function validateSession(token, site) {
  if (typeof fetch !== 'function' || typeof location === 'undefined') {
    throw new Error('[gcc] Creator.open({ token }) is the site\'s own signed-in path and needs ' +
      'a browser. A game passes { key } instead.');
  }
  const URL_ = new URL('/api/me', site ? new URL(site, location.origin) : location.origin).toString();
  let res;
  try {
    res = await fetch(URL_, {
      credentials: 'include',
      headers: token ? { authorization: 'Bearer ' + token } : {},
    });
  } catch (e) {
    throw new Error('[gcc] could not reach the session check at ' + URL_ +
      ' — network error (' + (e && e.message) + ').');
  }
  if (res.status === 401) {
    throw new Error('[gcc] not signed in. The site\'s own tools authorise with the signed-in ' +
      'user rather than a project key — sign in and reopen.');
  }
  if (!res.ok) throw new Error('[gcc] session check failed: HTTP ' + res.status + '.');
  const body = await res.json().catch(() => null);
  if (!body || !body.user) throw new Error('[gcc] session check returned no user.');
  // Same shape as the key path returns: informational, surfaced as `creator.project`.
  return { id: 'site', session: true, user: body.user.id, isAdmin: !!body.isAdmin };
}

// ── the spectrum delta blob ──────────────────────────────────────────────────
//
// FILE = [ uint32 MAGIC ][ uint32 headerByteLength ][ header JSON, utf8 ][ pad to 4 ][ body ]
//
// The body is a run of blocks, each padded to 4 bytes, each addressed by a byte offset
// from the start of the body. A block is Int16, quantised PER BLOCK:
//
//     value(t) = A[i] + q[i] * scale * t
//
// which is exactly a relative morph target at weight t. That equivalence is the whole
// reason a crowd is affordable here — see law 2 at the top of this file. A block whose
// maxAbs was 0 is written as `null` and occupies NO BYTES; treat null as a zero vector.
// The anchor id is baked into a base's mesh names — the same mesh is `GEO-body_venus` on one
// end and `GEO-body_mars` on the other. Strip it so a mask (or anything else) authored at one
// end can be matched against the other. `bases` comes from the outfit's manifest entry, so
// only a real anchor slug is ever stripped: a mesh legitimately called `arm_left` is safe.
function normMeshName(name, bases) {
  const list = (bases || []).filter(Boolean);
  if (!list.length) return String(name || '');
  return String(name || '').replace(new RegExp('_(' + list.join('|') + ')$', 'i'), '');
}

function parseSpectrum(buf) {
  if (!buf || buf.byteLength < 8) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== SPECTRUM_MAGIC) {
    throw new Error('[gcc] the spectrum blob is not a spectrum blob (bad magic) — check the ' +
      'asset path; a 404 HTML page reaches here as bytes.');
  }
  const headLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen)));
  const bodyAt = 8 + headLen + ((4 - (headLen % 4)) % 4);
  // REFUSE a version we do not read. Skipping unknown fields is not graceful degradation
  // here — the fields ARE the character, and a half-applied blend looks like an art bug.
  if (header.v !== SPECTRUM_VERSION) {
    throw new Error(`[gcc] spectrum blob is v${header.v}, this SDK reads v${SPECTRUM_VERSION}. ` +
      'Re-export the project assets from creategamecharacters.ai. Blending is refused rather ' +
      'than half-applied.');
  }
  return { header, buf, bodyAt };
}

// Dequantise one Int16 block into a fresh Float32Array of per-vertex deltas.
// `null`/missing block → zeros (a mesh that is byte-identical on both anchors).
function dequantBlock(spec, ref, count) {
  const out = new Float32Array(count * 3);
  if (!ref) return out;
  const q = new Int16Array(spec.buf, spec.bodyAt + ref.off, count * 3);
  const s = ref.scale;
  for (let i = 0; i < out.length; i++) out[i] = q[i] * s;
  return out;
}

// ── morph target plumbing ────────────────────────────────────────────────────
//
// three packs position/normal/color morph targets into ONE data texture per geometry and
// walks the parallel arrays by index. If `morphAttributes.normal` exists it must have the
// SAME length as `morphAttributes.position` or the packer dereferences `undefined` and
// throws. The head arrives with 51 expression targets and no normal morphs; our spectrum
// target genuinely needs one (the body's normal delta reaches 0.69 on a unit vector — a
// flat chest lit as breasts is exactly this delta going missing).
//
// So we pad the missing slots with ONE shared zero attribute referenced N times. The
// packer only reads it, so the repetition costs a single array, not N.
function zeroAttr(THREE, geom, itemSize) {
  const key = '__gccZero' + itemSize;
  let a = geom.userData[key];
  if (!a) {
    const count = geom.attributes.position.count;
    a = geom.userData[key] = new THREE.BufferAttribute(new Float32Array(count * itemSize), itemSize);
  }
  return a;
}

/**
 * Install one relative morph target and return its SLOT index — reusing a slot that residency
 * has released, if there is one.
 *
 * SLOTS ARE STABLE FOR LIFE. Every route in this module — the spectrum, each identity slider,
 * each blended source character, each garment's second fit — holds an integer index into these
 * parallel arrays, and three requires a mesh's `morphTargetInfluences` to be exactly as long as
 * them. So a target that is no longer wanted frees its BUFFER (see `freeMorphSlot`) and leaves
 * the slot behind for the next one. Splicing it out instead would silently repoint every route
 * after it and desync every live character's influence array — the whole crowd, quietly wrong.
 */
function appendMorphTarget(THREE, geom, { position, normal }) {
  const ma = geom.morphAttributes || (geom.morphAttributes = {});
  if (!ma.position) ma.position = [];
  geom.morphTargetsRelative = true;

  const free = geom.userData.__gccFreeSlots;
  if (free && free.length) {
    const slot = free.pop();
    ma.position[slot] = new THREE.BufferAttribute(position, 3);
    if (normal) {
      if (!ma.normal) { ma.normal = []; while (ma.normal.length < ma.position.length) ma.normal.push(zeroAttr(THREE, geom, 3)); }
      ma.normal[slot] = new THREE.BufferAttribute(normal, 3);
    } else if (ma.normal) ma.normal[slot] = zeroAttr(THREE, geom, 3);
    geom.morphTexture?.dispose?.();     // packed for the old contents
    geom.morphTexture = null;
    return slot;
  }
  // (`morphTargetsRelative` is set above: glTF morph targets are RELATIVE deltas and so are
  // ours. A geometry that had no targets at all defaults to false, and the shader would treat
  // our delta as an absolute position — the body folds into a point at the origin.)
  const idx = ma.position.length;
  // Pad every OTHER slot up to the same length first, so all parallel arrays stay aligned.
  for (const key of Object.keys(ma)) {
    if (key === 'position') continue;
    const arr = ma[key];
    const size = arr.length ? arr[0].itemSize : 3;
    while (arr.length < idx) arr.push(zeroAttr(THREE, geom, size));
  }
  ma.position.push(new THREE.BufferAttribute(position, 3));
  if (normal) {
    if (!ma.normal) { ma.normal = []; while (ma.normal.length < idx) ma.normal.push(zeroAttr(THREE, geom, 3)); }
    ma.normal.push(new THREE.BufferAttribute(normal, 3));
  } else if (ma.normal) {
    ma.normal.push(zeroAttr(THREE, geom, 3));
  }
  for (const key of Object.keys(ma)) {
    if (key === 'position' || key === 'normal') continue;
    const arr = ma[key];
    const size = arr.length ? arr[0].itemSize : 3;
    while (arr.length < ma.position.length) arr.push(zeroAttr(THREE, geom, size));
  }
  // The packed morph texture was built for the old target count.
  geom.morphTexture?.dispose?.();
  geom.morphTexture = null;
  return idx;
}

/**
 * Release a morph target's data, keeping its slot. The big delta buffer is dropped — that is
 * the memory actually reclaimed — and the slot goes on a free list for the next installer.
 *
 * The caller must ALSO zero that slot's influence on every live character (see
 * `Creator._releaseSlot`): the next target to take the slot would otherwise inherit whatever
 * weight the last one was left at, and a background character would suddenly wear a stranger's
 * nose.
 */
function freeMorphSlot(THREE, geom, slot) {
  const ma = geom.morphAttributes || {};
  if (!ma.position || slot < 0 || slot >= ma.position.length) return false;
  const free = geom.userData.__gccFreeSlots || (geom.userData.__gccFreeSlots = []);
  if (free.includes(slot)) return false;                 // already released
  const z = zeroAttr(THREE, geom, 3);                    // one shared zero buffer per geometry
  ma.position[slot] = z;
  if (ma.normal) ma.normal[slot] = z;
  free.push(slot);
  geom.morphTexture?.dispose?.();
  geom.morphTexture = null;
  return true;
}

// ── the shared template rig ──────────────────────────────────────────────────

/**
 * Walk the loaded base rig and install the spectrum delta as ONE morph target per mesh.
 *
 * Mapping a block to a mesh follows the blob's own rule and nothing else:
 *   node = byName(mesh.nodeA)   — the anchor-A node name, verbatim
 *   parts = node.isMesh ? [node] : node.children.filter(isMesh)   — a multi-primitive
 *           glTF mesh arrives as a Group of Meshes, IN ORDER, and prims index into it
 * There is no name matching anywhere in this format; morph targets align by ARRAY INDEX.
 */
// -- THE HEAD IS ITS OWN SLIDER (owner design, 2026-09-04) --------------------
//
// "Mars and Venus face is also a slider. Separate from body. So that u can slide body up
// without making face more/less masculine." -- and "face" there means the WHOLE HEAD.
//
// Why it has to exist: a saved character is the base plus an offset, so the offset rides
// whatever head the base is currently wearing. Drag the body from feminine to masculine and
// the head underneath becomes the masculine head, so a character saved as feminine grows
// masculine features. Measured on the shipped anchors: the head travels 14.74 cm between
// them, of which 13.97 cm is only the SKELETON being a different size and 1.33 cm (max 4.12)
// is the head genuinely being shaped differently. Saved face identities run 0.12-0.57 cm, so
// that 1.33 cm is about four times the whole character -- it does not perturb the face, it
// replaces it.
//
// Why it CANNOT be a world-space head blend: the anchors are 16 cm apart in height, so
// blending head positions in world space drags the height along and the head leaves the neck.
// The two bases share a rig and a vertex order, and that is what tells the two apart:
//
//   rigid(v) = sum over the vertex's OWN skin weights of that bone's rest-position change
//   shape(v) = delta(v) - rigid(v)
//
// rigid is where a vertex goes because the skeleton is a different size; shape is what is
// left over, which is the head being a different head. rigid follows the BODY slider so the
// head stays on the neck, shape follows the HEAD slider.
//
// THE SEAM IS WHY THIS IS A FIELD AND NOT A MESH LIST. The head mesh reaches down past the
// neck to the chest, where the body mesh meets it, so splitting the two meshes apart splits
// the character at the collarbone. Instead the SPLIT itself is faded: `headness` is 0 at the
// neck-base joint and 1 by 40% of the way up to the head joint -- the same field and the same
// two joints the editor's head sliders already use. Where it is 0 the whole delta stays in
// `rigid` and the vertex behaves exactly as the body does; where it is 1 the split is
// complete. Coincident vertices either side of any seam get the same weight by construction.
//
// AND SETTING HEAD = BODY REPRODUCES TODAY EXACTLY: rigid + shape is the delta, vertex for
// vertex, so the old single blend is the diagonal of the new pair. Nothing regresses.
const HEAD_JOINT = /^head$/i;
const NECK_JOINT = /^neck/i;

function headnessField(geom, jointY) {
  const pos = geom.attributes.position;
  let neckY = null, headY = null;
  for (const [name, y] of jointY) {
    if (HEAD_JOINT.test(name)) headY = y;
    else if (NECK_JOINT.test(name)) neckY = neckY == null ? y : Math.min(neckY, y);
  }
  if (neckY == null || headY == null || !(headY > neckY)) return null;
  const span = (headY - neckY) * 0.4;
  const w = new Float32Array(pos.count);
  for (let v = 0; v < pos.count; v++) w[v] = Math.max(0, Math.min(1, (pos.getY(v) - neckY) / span));
  return w;
}

// Every bone's rest POSITION, in character space, on each anchor. Anchor A is the rig as
// loaded; anchor B is the local TRS the blob carries.
//
// FULL TRS DOWN THE CHAIN, NEVER A SUM OF TRANSLATIONS. Adding local translations only is
// right where the chain is unrotated and unscaled, and the spine happens to be nearly so --
// which is why it read plausibly at first. The MOUTH RIG is not: its eleven joints hang
// under a rotated parent, and translation-summing gave the teeth a rig share of 15.25 cm
// against a real travel of 14.87 cm. The teeth then rode 1.3 cm further than the head they
// live in and came out through the face the moment the head and body separated.
function boneRestDelta(THREE, root, spec) {
  const clean = (n) => (THREE.PropertyBinding ? THREE.PropertyBinding.sanitizeNodeName(n) : n);
  const localB = new Map();
  for (const n of spec.header.nodes || []) localB.set(clean(n.name), n);

  const delta = new Map(), jointY = new Map();
  const mA = new THREE.Matrix4(), mB = new THREE.Matrix4();
  const q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const walk = (node, parentA, parentB) => {
    const worldA = new THREE.Matrix4().multiplyMatrices(parentA,
      mA.compose(node.position, node.quaternion, node.scale));
    const nb = node.name ? localB.get(node.name) : null;
    const worldB = new THREE.Matrix4().multiplyMatrices(parentB, nb
      ? mB.compose(v.fromArray(nb.t), q.fromArray(nb.r), s.fromArray(nb.s))
      : mB.compose(node.position, node.quaternion, node.scale));
    if (node.name) {
      const pa = worldA.elements, pb = worldB.elements;
      delta.set(node.name, [pb[12] - pa[12], pb[13] - pa[13], pb[14] - pa[14]]);
      jointY.set(node.name, pa[13]);
    }
    for (const c of node.children) walk(c, worldA, worldB);
  };
  const I = new THREE.Matrix4();
  for (const c of root.children) walk(c, I, I);
  return { delta, jointY };
}

// Split one mesh's delta into the part that is the HEAD ASSEMBLY TRAVELLING and the part that
// is anything else, faded by `headness` so the chest seam cannot come apart.
//
// The rule is simpler than it first looked, and the teeth are what taught it. The teeth have
// NO shape difference of their own: measured on the anchors their delta is 14.87 cm and their
// rig explains 14.87 cm of it, to the last micron. They are the same teeth, placed lower and
// further forward by a masculine mouth rig. So splitting per-vertex by each mesh's own bones
// left the teeth riding the body while the head shape was held back, and they came through the
// lip — the mouth sitting differently is part of the head being a different head.
//
// So: the only thing that rides the BODY is the head joint's own travel, which is what keeps
// the head on the neck. Everything else in the head assembly — the surface being shaped
// differently, the eyes sitting differently, the mouth sitting differently, the hairline
// sitting differently — rides the HEAD. One constant vector does it, the same one the hair
// uses, so every part of the head arrives at the same place by construction.
//
//   shape(v) = headness(v) * (delta(v) - headTravel)
//   rigid(v) = delta(v) - shape(v)
//
// headness 0 leaves the whole delta on the body, exactly as the body mesh does; headness 1
// leaves only the travel there. head = body still sums to the delta vertex for vertex.
function splitByRig(position, headTravel, headness) {
  if (!headTravel || !headness) return null;
  const n = position.length / 3;
  const rigid = new Float32Array(position.length);
  const shape = new Float32Array(position.length);
  for (let v = 0; v < n; v++) {
    const h = headness[v], i = v * 3;
    for (let c = 0; c < 3; c++) {
      shape[i + c] = h * (position[i + c] - headTravel[c]);
      rigid[i + c] = position[i + c] - shape[i + c];
    }
  }
  return { rigid, shape };
}

function installSpectrumMorphs(THREE, root, spec) {
  const byName = new Map();
  root.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });

  const entries = [];       // { mesh, morphIndex, texs, kind: 'all' | 'rigid' | 'shape' }
  const { delta: boneDelta, jointY } = boneRestDelta(THREE, root, spec);
  // The head joint's own travel: what a thing rigidly attached to the head -- a hair style,
  // seated on the anchor heads -- has to move by when the BODY changes and the head does not.
  let headRigid = null;
  for (const [name, d] of boneDelta) if (HEAD_JOINT.test(name)) headRigid = d;

  for (const m of spec.header.meshes) {
    const node = byName.get(m.nodeA);
    if (!node) { console.warn('[gcc] spectrum: no node named', m.nodeA, '— that mesh will not blend'); continue; }
    const parts = node.isMesh ? [node] : node.children.filter((c) => c.isMesh);
    m.prims.forEach((p, pi) => {
      const mesh = parts[pi];
      if (!mesh || !mesh.geometry) return;
      const g = mesh.geometry;
      if (g.attributes.position.count !== p.count) {
        console.warn(`[gcc] spectrum: ${m.nodeA}[${pi}] has ${g.attributes.position.count}v on the ` +
          `base but ${p.count}v in the delta — skipped (the base GLB and the delta are from ` +
          'different exports; re-export the project assets).');
        return;
      }
      const position = dequantBlock(spec, p.pos, p.count);
      const normal = g.attributes.normal ? dequantBlock(spec, p.nrm, p.count) : null;
      // Head-group meshes get TWO targets so the head has an axis of its own; everything
      // else keeps the single one it has always had. `normal` rides `rigid`: moving a rest
      // pose does not reshade a surface, and the shape half is a centimetre of relief that
      // the shader renormalises anyway.
      const split = isHeadMesh(mesh.name) && headRigid
        ? splitByRig(position, headRigid, headnessField(g, jointY)) : null;
      if (split) {
        const ri = appendMorphTarget(THREE, g, { position: split.rigid, normal });
        const sh = appendMorphTarget(THREE, g, { position: split.shape, normal: null });
        entries.push({ mesh, morphIndex: ri, texs: p.texs || null, kind: 'rigid' });
        entries.push({ mesh, morphIndex: sh, texs: null, kind: 'shape' });
      } else {
        const morphIndex = appendMorphTarget(THREE, g, { position, normal });
        entries.push({ mesh, morphIndex, texs: p.texs || null, kind: 'all' });
      }
      // Skin weights: the blob only carries them when the two anchors are genuinely
      // weighted apart, and today they never are. A weight blend is NOT expressible as a
      // morph weight (a morph target cannot move a joint index), so if a future blob does
      // ship them this is where it has to be handled.
      // TODO(spec): per-anchor skin weights are null in every blob built to date; if the
      // builder ever emits them, decide whether the SDK lerps them per character (which
      // costs a per-character skinWeight attribute, i.e. per-character geometry) or pins
      // them to one anchor. Undecided, so nothing is implemented.
      if (p.weights) console.warn('[gcc] spectrum: this blob carries per-anchor skin weights; the SDK does not blend them (see TODO(spec) in v1.js).');
    });
  }

  return { entries, headRigid };
}

/**
 * Load extra named morph targets — the identity ("68 sliders") set — onto the same shared
 * geometry, from a second GLB carrying the same meshes.
 *
 * TODO(spec): the asset format for the identity morphs is not specified anywhere. The site's
 * face sliders are CPU deformations, not morph targets, so there is no existing file to read;
 * the SDK design simply asserts "they are already morphs". Implemented here as the safe,
 * obvious thing: a GLB whose meshes carry named morph targets and match the base by NAME and
 * VERTEX COUNT. If the project export settles on a different container (a packed .bin like the
 * spectrum blob would be much smaller), this function is the only place that changes.
 */
async function installFaceMorphs(THREE, root, faceGltf) {
  const byName = new Map();
  root.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.name) byName.set(o.name, o); });
  const names = [];                       // slider name, in declaration order
  const routes = new Map();               // sliderName -> [{ mesh, morphIndex }]

  faceGltf.scene.traverse((src) => {
    if (!(src.isMesh || src.isSkinnedMesh) || !src.geometry) return;
    const dst = byName.get(src.name);
    if (!dst) { console.warn('[gcc] identity morphs: no base mesh named', src.name, '— skipped'); return; }
    const sg = src.geometry, dg = dst.geometry;
    if (!sg.morphAttributes || !sg.morphAttributes.position) return;
    if (sg.attributes.position.count !== dg.attributes.position.count) {
      console.warn(`[gcc] identity morphs: "${src.name}" is ${sg.attributes.position.count}v vs ` +
        `${dg.attributes.position.count}v on the base — skipped (mismatched export).`);
      return;
    }
    const targetNames = (sg.userData && sg.userData.targetNames) || [];
    sg.morphAttributes.position.forEach((attr, i) => {
      const name = targetNames[i] || (src.name + '_' + i);
      const nrm = sg.morphAttributes.normal && sg.morphAttributes.normal[i];
      // Copy out of the donor GLB: it is disposed straight after, and a BufferAttribute
      // handed to the shared geometry must outlive it.
      const morphIndex = appendMorphTarget(THREE, dg, {
        position: Float32Array.from(attr.array),
        normal: nrm ? Float32Array.from(nrm.array) : null,
      });
      if (!routes.has(name)) { routes.set(name, []); names.push(name); }
      routes.get(name).push({ mesh: dst, morphIndex });
    });
  });
  return { names, routes };
}

// Install the 68 identity sliders from the PUBLISHED RECIPE (`face-recipe/<base>.json`),
// which is the format the site actually ships — sparse per-vertex deltas per mesh:
//
//   sliders: { noseWidth: { region, range:[-1,1], targets:[ {mesh,count,i,dx,dy,dz} ] } }
//
// The GLB reader above expects a donor mesh with morph attributes; nothing produces one.
// So every project loaded with no `face` entry, every setFace() was a silent no-op, and a
// crowd of "unique" characters came out as one face repeated — which is exactly how it
// looked the first time this ran. Sparse → dense is the whole conversion: a morph target
// is a full-length delta buffer, and these deltas are the same thing with the zeros left
// out.
function installFaceRecipe(THREE, root, recipe) {
  const byName = new Map();
  root.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.name) byName.set(o.name, o); });
  const names = [];
  const routes = new Map();
  const missing = new Set();

  for (const [slider, def] of Object.entries(recipe.sliders || {})) {
    for (const t of (def.targets || [])) {
      const dst = byName.get(t.mesh);
      if (!dst || !dst.geometry) { missing.add(t.mesh); continue; }
      const n = dst.geometry.attributes.position.count;
      const pos = new Float32Array(n * 3);          // zero = neutral everywhere else
      const { i, dx, dy, dz } = t;
      for (let k = 0; k < i.length; k++) {
        const v = i[k] * 3;
        // A vertex index past the end means this recipe was built for a different export
        // of the mesh. Silently writing out of range would corrupt neighbouring sliders.
        if (v + 2 >= pos.length) continue;
        pos[v] = dx[k]; pos[v + 1] = dy[k]; pos[v + 2] = dz[k];
      }
      const morphIndex = appendMorphTarget(THREE, dst.geometry, { position: pos, normal: null });
      if (!routes.has(slider)) { routes.set(slider, []); names.push(slider); }
      routes.get(slider).push({ mesh: dst, morphIndex });
    }
  }
  if (missing.size) {
    console.warn('[gcc] face recipe names meshes this base does not have: ' + [...missing].join(', '));
  }
  return { names, routes };
}

// ── CHARACTER BLENDING — mixing SAVED CHARACTERS, the second of the two blends ──
//
// The body spectrum is one blend; this is the other, and it is the one that turns a handful
// of the owner's saved characters into a crowd of unique people. Without it every character
// wears the same face and the product is worth nothing.
//
// A saved character's RECIPE is sparse per-vertex offsets per mesh — the same shape as the
// spectrum delta and the 68 identity sliders (character-editor/blend-core.js resolveRecipe):
//
//   recipe.geometry.meshes[name] = { key:'uv'|'index', vertexCount, movedCount,
//                                    indices | uvs, offsets:[dx,dy,dz …] }
//
// So it installs the SAME way: one morph target per source character, and a character is a
// weight across them. That is what keeps geometry shared — the editor's Blender writes into
// live vertices because it has exactly one character on screen; a crowd cannot afford that.
//
// LASH LAW, carried over from blend-core: eyelashes are NEVER blended. Their cards are
// rebuilt every load by the lash binding, so a recipe delta measured after that reshaping
// double-transforms them into a scribble.
// The three rules a recipe crosses the spectrum by, ported verbatim from blend-core.js —
// they are the difference between "the slider does nothing" and a working blend:
//   * mesh names carry the anchor they were saved on ("GEO-head_mars" vs "GEO-head_venus"),
//     so an exact-name lookup silently drops every cross-gender source;
//   * GEOMETRY crosses for the HEAD only — body shape belongs to the body slider;
//   * TEXTURE crosses for every mesh, because skin tone is one bake across the neck seam
//     and gating the body's tone parted head from body at the collarbone.
const anchorless = (n) => String(n).replace(/_(venus|mars)$/i, '');
const isHeadMesh = (n) => /head|eye|teeth|tongue|brow/i.test(n);
function lookupMesh(byName, name) {
  const direct = byName.get(name);
  if (direct) return { mesh: direct, crossAnchor: false };
  const want = anchorless(name);
  for (const [k, v] of byName) if (anchorless(k) === want) return { mesh: v, crossAnchor: true };
  return null;
}
// UV-keyed specs carry their own correspondence: match the NEAREST uv, never a rounded
// string key — values either side of a bucket boundary round apart and those vertices
// vanish from the blend.
function uvGrid(uv, count, cell) {
  const g = new Map();
  for (let i = 0; i < count; i++) {
    const k = Math.floor(uv[i * 2] / cell) + ',' + Math.floor(uv[i * 2 + 1] / cell);
    let a = g.get(k); if (!a) g.set(k, a = []); a.push(i);
  }
  return g;
}

// Exported underscored (below) so dev/sdk-check.mjs drives the REAL installer — the build a
// recipe comes back with is a numeric claim, and a numeric claim gets a numeric test.
// A RECIPE PUBLISHED BEFORE 2026-09-04 HAS THE BUILD HIDDEN IN ITS OFFSETS, and it is already
// in games, in projects and in the community hub — so it repairs itself here rather than
// waiting for someone to re-save fifty characters. The correction is a MEASUREMENT of what is
// actually in the offsets, not a guess: the spectrum morph target on each mesh IS the vector
// from this base to the other anchor, so projecting the recipe's own offsets onto it says how
// far along that axis they sit. The BODY is the probe in both directions — the editor's tools
// never move body vertices, so its offsets are the build and nothing else — and a same-anchor
// source projects to +t while one from the far anchor projects to -t, which is exactly the
// 1 - t the axis conversion wants. `spectrumByMesh` is that delta per mesh; without it (no
// second anchor in the project) there is nothing to separate and the offsets pass through.
function stripBakedBuild(id, pending, spectrumByMesh, bodyProbe) {
  if (!spectrumByMesh || !spectrumByMesh.size) return null;
  // THE BODY IS THE ONLY HONEST PROBE, and it is the probe even when it is not installed.
  // The head axis is very nearly a 15 cm vertical translation, so ANY face with a small net
  // vertical bias projects onto it strongly — the sk8 project's Heiring read as 75% "build"
  // and had 1.5 mm shaved off a 2.7 mm face. A cross-anchor source's body offsets are not
  // installed (body shape belongs to the slider), but they are still measured, which is why
  // `bodyProbe` is carried past the skip rather than lost at it.
  const probe = bodyProbe || pending.find((e) => !isHeadMesh(e.mesh.name) && spectrumByMesh.has(e.mesh));
  if (!probe || !spectrumByMesh.has(probe.mesh)) return null;
  const D = spectrumByMesh.get(probe.mesh), P = probe.pos;
  if (!D || D.length !== P.length) return null;
  let num = 0, den = 0, mag = 0;
  for (let i = 0; i < D.length; i++) { num += P[i] * D[i]; den += D[i] * D[i]; mag += P[i] * P[i]; }
  if (den < 1e-12) return null;
  const t = num / den;
  let err = 0;
  for (let i = 0; i < D.length; i++) { const e = P[i] - t * D[i]; err += e * e; }
  // THE RESIDUAL IS MEASURED AGAINST THE RECIPE'S OWN OFFSETS, NEVER AGAINST THE AXIS.
  // The question is "how much of THIS recipe is the body axis", and dividing by the axis
  // answers a different one: a face identity is ~0.3 cm against an axis of ~15 cm, so it
  // divides down to a couple of percent and passes a check it should fail. Measured that way,
  // a cross-anchor source — whose only probe is the head, because its body offsets are not
  // installed — had 1% of the axis subtracted out of it, which is 0.15 cm off a 0.28 cm face:
  // over half the character. Found on the sk8 project's own Steve and Heiring, 2026-09-04.
  if (mag < 1e-12) return 0;                               // nothing moved: nothing baked in
  const explained = Math.sqrt(Math.max(0, mag - err) / mag);
  if (explained < 0.75) {
    console.info(`[gcc] preset "${id}" states no build, and only ${(explained * 100).toFixed(0)}% of its offsets lie along the body axis — that is a face, not a build, so it is used exactly as published.`);
    return 0;
  }
  if (Math.abs(t) < 0.005) return 0;                       // authored at the anchor: nothing baked in
  for (const e of pending) {
    const d = spectrumByMesh.get(e.mesh);
    if (!d || d.length !== e.pos.length) continue;
    for (let i = 0; i < e.pos.length; i++) e.pos[i] -= t * d[i];
  }
  console.info(`[gcc] preset "${id}" was published without a build; ${(Math.abs(t) * 100).toFixed(0)}% of the body axis was baked into its offsets and has been separated out. Re-save it in the editor to store this properly.`);
  return t;
}

function installPresetRecipes(THREE, root, recipes, spectrumByMesh) {
  const byName = new Map();
  root.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.name) byName.set(o.name, o); });
  const routes = new Map();          // preset id -> [{ mesh, morphIndex }]
  const names = [];
  const atlases = new Map();          // preset id -> Map(baseMeshName -> texture uri)
  const builds = new Map();           // preset id -> the Build it was saved at, on THIS base's axis
  const heads = new Map();            // preset id -> where its HEAD stood, on THIS base's axis

  for (const [id, recipe] of Object.entries(recipes || {})) {
    const meshes = (recipe && recipe.geometry && recipe.geometry.meshes) || {};
    // WHICH ANCHOR THE SOURCE WAS SAVED ON, decided by the same test the geometry gating
    // already trusts: a mesh name that only matches once its anchor suffix is stripped came
    // from the other end. No slug list, so it is right whichever anchor the project exported.
    let crossSource = false;
    let bodyProbe = null;
    const pending = [];
    for (const [meshName, spec] of Object.entries(meshes)) {
      if (/eyelash/i.test(meshName)) continue;                       // LASH LAW
      const hit = lookupMesh(byName, meshName);
      if (!hit || !hit.mesh.geometry) continue;
      const dst = hit.mesh;
      if (hit.crossAnchor) crossSource = true;
      // A source from the other anchor contributes its HEAD; its body offsets are left alone
      // rather than dragging that anchor's build in behind the face. They are still RESOLVED
      // though — see stripBakedBuild: the body is the only mesh no editor tool moves, so it
      // is the only trustworthy answer to "how much of this recipe is the build slider".
      const skipInstall = hit.crossAnchor && !isHeadMesh(meshName);
      const count = dst.geometry.attributes.position.count;
      // An INDEX-keyed spec only means anything against the vertex order it was measured
      // on. A mismatch means this recipe predates a topology change — skip rather than
      // scatter offsets onto the wrong vertices.
      if (spec.key !== 'uv' && spec.vertexCount && spec.vertexCount !== count) {
        console.warn(`[gcc] preset "${id}": "${meshName}" was measured on ${spec.vertexCount}v, base has ${count}v — skipped`);
        continue;
      }
      const pos = new Float32Array(count * 3);
      const off = spec.offsets;
      // Resolve ONCE, at load, to plain base vertex indices — then a weight change is a
      // tight typed-array loop with no lookups.
      let idx;
      if (spec.key === 'uv' && spec.uvs) {
        const tol = (recipe.geometry && recipe.geometry.uvTolerance) || 1e-4;
        const uvAttr = dst.geometry.attributes.uv;
        if (!uvAttr) { console.warn(`[gcc] preset "${id}": "${meshName}" is UV-keyed but the base mesh has no UVs — skipped`); continue; }
        const uv = uvAttr.array;
        const grid = uvGrid(uv, count, tol);
        idx = new Int32Array(spec.movedCount);
        let missed = 0;
        for (let k = 0; k < spec.movedCount; k++) {
          const u = spec.uvs[k * 2], v = spec.uvs[k * 2 + 1];
          const cx = Math.floor(u / tol), cy = Math.floor(v / tol);
          let best = -1, bd = Infinity;
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const a = grid.get((cx + dx) + ',' + (cy + dy)); if (!a) continue;
            for (const i of a) { const d = Math.hypot(uv[i * 2] - u, uv[i * 2 + 1] - v); if (d < bd) { bd = d; best = i; } }
          }
          if (best < 0 || bd > tol) { idx[k] = -1; missed++; } else idx[k] = best;
        }
        if (missed) console.info(`[gcc] preset "${id}": "${meshName}" — ${missed}/${spec.movedCount} uv vertices unmatched`);
      } else {
        idx = spec.indices;
      }
      for (let k = 0; k < spec.movedCount; k++) {
        const t = idx[k];
        if (t < 0) continue;                       // unmatched uv
        const v = t * 3;
        if (v + 2 >= pos.length) continue;
        pos[v] = off[k * 3]; pos[v + 1] = off[k * 3 + 1]; pos[v + 2] = off[k * 3 + 2];
      }
      // Held, not appended: a legacy recipe's build has to come out of every mesh's offsets
      // together, and that needs all of them measured first.
      if (skipInstall) { if (!isHeadMesh(meshName)) bodyProbe = { mesh: dst, pos }; continue; }
      pending.push({ mesh: dst, pos });
    }
    const measured = ('build' in (recipe || {})) ? null : stripBakedBuild(id, pending, spectrumByMesh, bodyProbe);
    for (const e of pending) {
      const morphIndex = appendMorphTarget(THREE, e.mesh.geometry, { position: e.pos, normal: null });
      if (!routes.has(id)) { routes.set(id, []); names.push(id); }
      routes.get(id).push({ mesh: e.mesh, morphIndex });
    }
    // Texture crosses anchors for EVERY mesh — see the note on BLEND_FRAG.
    const tex = new Map();
    for (const [meshName, uri] of Object.entries((recipe && recipe.textures) || {})) {
      if (/eyelash/i.test(meshName)) continue;
      const hit = lookupMesh(byName, meshName);
      if (hit) tex.set(hit.mesh.name || meshName, uri);
    }
    if (tex.size) { atlases.set(id, tex); if (!names.includes(id)) names.push(id); }
    // THE BUILD THE SOURCE WAS SAVED AT, carried onto THIS project's body axis (0 = the base
    // this project ships, 1 = the other anchor). The recipe states it in its OWN anchor's
    // direction, so a source from the other end sits at 1 − t. Without it a saved character
    // could not be reproduced: `spawn` defaults body to 0, so a character authored at the far
    // end came back at the near one, and there is no single body value that is right for a
    // cast saved at several builds. Recipes written before 2026-09-04 carry no `build` — they
    // read as 0, which is what this code did for all of them, and those still have the build
    // hidden inside their offsets (character-editor/recipe-export.js says why). The fix for
    // one of those is the same as for any stale recipe: open it in the editor and save it once.
    if (names.includes(id)) {
      // A stated build is in the recipe's OWN anchor direction, so a far-anchor source is
      // 1 - t. A MEASURED one is already signed along this project's axis (+t near, -t far),
      // so the same far-anchor source reads -t and lands at 1 + t. Both end up on this axis.
      const t = (measured === null)
        ? (crossSource ? 1 - (Number(recipe && recipe.build) || 0) : (Number(recipe && recipe.build) || 0))
        : (crossSource ? 1 + measured : measured);
      const build = Math.max(0, Math.min(1, t));
      builds.set(id, build);
      // WHERE ITS HEAD STOOD. Same axis, same anchor flip. A recipe that does not say
      // (everything written before the head became its own control) means the head was
      // wherever the body was, which is exactly what one slider meant.
      const rawHead = recipe && typeof recipe.head === 'number' ? recipe.head : null;
      heads.set(id, rawHead == null ? build
        : Math.max(0, Math.min(1, crossSource ? 1 - rawHead : rawHead)));
    }
    // A source with TEXTURES BUT NO GEOMETRY is the silent failure mode of this whole
    // feature: it is listed, it is selectable, the log says "N source(s)" — and dialling it
    // up changes nothing but skin tone, so the character never becomes the person it names.
    // Every reason the geometry loop skips a mesh is already warned about individually, but
    // one line per mesh is easy to miss in a boot log, so say it once, plainly, per preset.
    if (!routes.has(id)) {
      console.warn(`[gcc] preset "${id}" contributes NO GEOMETRY — it will not change the face. ` +
        'Its recipe named no mesh this base has, or every mesh was skipped above (vertex-count ' +
        'mismatch means the recipe predates a change to the base). Re-publish it from /projects.html.');
    }
  }
  return { names, routes, atlases, builds, heads };
}
export { installPresetRecipes as _installPresetRecipes };

// ── BLEND TEXTURES — the other half of character blending ────────────────────
//
// Geometry alone gives a blended SHAPE wearing the base's skin, so a crowd of blends still
// reads as one person. The skin has to blend too, and blend-core does it as a weighted
// AVERAGE of the sources' baked atlases on the GPU.
//
// Two rules taken verbatim from blend-core's BLEND_FRAG, both of which were bugs once:
//   * ALWAYS an average, never a sum — a sum blows past white the moment two characters
//     are both dialled up.
//   * ALL WEIGHTS ZERO = the BASE, not source 0. Falling back to a source meant dialling
//     everything to zero still showed the first character's skin.
//
// TEXTURE CROSSES ANCHORS FOR EVERY MESH, unlike geometry: skin tone is one continuous bake
// across the neck seam, and gating the body's tone the way body GEOMETRY is gated left the
// head sliding to the source's tone while the body stayed put — a hard seam at the collarbone.
const BLEND_FRAG = `
  varying vec2 vUv;
  uniform sampler2D t0, t1, t2, t3, t4, t5;
  uniform sampler2D tBase;
  uniform float w0, w1, w2, w3, w4, w5;
  void main() {
    vec4 acc = vec4(0.0);
    float s = 0.0;
    acc += texture2D(t0, vUv) * w0; s += w0;
    acc += texture2D(t1, vUv) * w1; s += w1;
    acc += texture2D(t2, vUv) * w2; s += w2;
    acc += texture2D(t3, vUv) * w3; s += w3;
    acc += texture2D(t4, vUv) * w4; s += w4;
    acc += texture2D(t5, vUv) * w5; s += w5;
    gl_FragColor = s > 1e-5 ? acc / s : texture2D(tBase, vUv);
  }`;

class BlendTextures {
  constructor(THREE, renderer) {
    this.THREE = THREE; this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // SIX NAMED SAMPLERS, not an array. GLSL ES 1.0 forbids indexing a sampler array with a
    // non-constant expression, so `texture2D(tSrc[i], …)` in a loop fails to COMPILE — and a
    // material whose shader failed to compile renders BLACK. blend-core writes them out
    // explicitly for exactly this reason; copying its structure is the point.
    this.uni = {
      tBase: { value: null },
      t0: { value: null }, t1: { value: null }, t2: { value: null },
      t3: { value: null }, t4: { value: null }, t5: { value: null },
      w0: { value: 0 }, w1: { value: 0 }, w2: { value: 0 },
      w3: { value: 0 }, w4: { value: 0 }, w5: { value: 0 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uni,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: BLEND_FRAG,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat));
    this.targets = new Map();
  }
  /** Weighted average of `sources` over `baseTex`, into a target owned per mesh+character. */
  run(key, baseTex, sources, weights, size) {
    const THREE = this.THREE;
    let rt = this.targets.get(key);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(size, size, {
        colorSpace: THREE.SRGBColorSpace, depthBuffer: false, stencilBuffer: false,
      });
      this.targets.set(key, rt);
    }
    if (!this._blank) {
      // A null sampler renders black. All-zero weights must show the BASE, so when a mesh
      // has no base map of its own, fall back to white rather than to nothing.
      const d = new Uint8Array([255, 255, 255, 255]);
      this._blank = new THREE.DataTexture(d, 1, 1);
      this._blank.needsUpdate = true;
    }
    this.uni.tBase.value = baseTex || this._blank;
    for (let i = 0; i < 6; i++) {
      this.uni['t' + i].value = sources[i] || this.uni.tBase.value;
      this.uni['w' + i].value = sources[i] ? (weights[i] || 0) : 0;
    }
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prev);
    return rt.texture;
  }
  dispose() {
    this.mat.dispose();
    for (const rt of this.targets.values()) rt.dispose();
    this.targets.clear();
  }
}

// ── the rest pose ────────────────────────────────────────────────────────────
//
// The 16 cm height difference between the two anchors lives in the REST POSE, not in the
// vertices, so a morph weight alone gets you a taller body inside a shorter skeleton. This
// is the one piece of the blend that is per-character CPU and cannot be anything else: a
// morph target cannot move a bone. 86 nodes of TRS lerp per character per change of t —
// cheap, but real.
//
// NOT ONLY BONES. The mouth rig hangs under a plain Object3D whose own translation differs
// by 13.8 cm between the anchors; blending only the bones left every tooth 15.8 cm out of
// place at t=1 while all the skinned geometry measured exact. The blob's `nodes` list is
// every named node on a joint's parent chain — blend all of them, bone or not.
function captureRestA(THREE, nodes, headerNodes) {
  const clean = (n) => (THREE.PropertyBinding ? THREE.PropertyBinding.sanitizeNodeName(n) : n);
  const restA = new Map();
  let missed = 0;
  for (const rn of headerNodes) {
    // NAME SANITISATION IS MANDATORY. GLTFLoader delivers "Bone.001" as "Bone001"; the
    // builder writes the raw glTF name. Without this, ten mouth joints silently never
    // match and the teeth stop following the jaw.
    const key = clean(rn.name);
    const node = nodes.get(key);
    if (!node) { missed++; continue; }
    restA.set(key, { t: node.position.clone(), r: node.quaternion.clone(), s: node.scale.clone() });
  }
  if (missed) {
    console.warn(`[gcc] ${missed}/${headerNodes.length} rest-pose nodes are not on the base rig — ` +
      'that part of the body will not blend.');
  }
  return restA;
}

/**
 * Re-take the bind inverses of `skeletons` **in the character's own space** — the space
 * `root` defines — and NEVER in world space.
 *
 * WHY THIS EXISTS INSTEAD OF `Skeleton.calculateInverses()`. three's version stores
 * `inverse(bone.matrixWorld)`, so it captures whatever transform the GAME has on or above
 * the character at that instant: a stage group, a facing rotation, a turntable, a height
 * scale on the root. But the mesh's `bindMatrix` came from the GLB and is in CHARACTER
 * space (glTF's inverse bind matrices are relative to the scene root, and the base loads
 * into a detached scene at identity). Mixing the two spaces leaves every skinned vertex
 * rendering through a leftover `worldAtRender · inverse(worldAtRebind)`:
 *
 *   - a character under a static transform LOSES it on the first `setBody` — it snaps back
 *     to origin/unit scale, because `S · inverse(S)` is identity;
 *   - a game height slider (a scale on the root) then leaves a residual `S_now/S_rebind`,
 *     which does not commute with the bones' pose rotations, so an animated character
 *     shears — the stretched, wrongly-proportioned body both integrations reported;
 *   - and it is order-dependent, which is why "height, then build" broke while either one
 *     alone often looked fine.
 *
 * It survived every in-house test because the site's own character sits at the origin at
 * scale 1, where world space and character space are the same thing.
 *
 * Character space is `inverse(root.matrixWorld) · bone.matrixWorld`, which PRESERVES the
 * glTF convention rather than replacing it — meshes that ride the blend keep the file's
 * original inverses, and now the rebound ones stay in the same space as those. Any
 * transform above the character then cancels for free, whenever the game changes it,
 * because it multiplies `bone.matrixWorld` at render time and nothing else.
 *
 * A stale parent `matrixWorld` cancels too: both terms carry the same stale factor.
 *
 * Exported (underscored) so the numeric harness drives this exact code and never a copy of
 * it. Not part of the supported API.
 */
export function _rebindInRootSpace(THREE, root, skeletons) {
  const toChar = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  for (const sk of skeletons) {
    const inv = sk.boneInverses;
    for (let i = 0; i < sk.bones.length; i++) {
      const b = sk.bones[i];
      // Written in place into THIS character's own Matrix4s — `spawn()` deep-clones the
      // inverse array per character, and replacing the array would hand a crowd one bind.
      if (!inv[i]) inv[i] = new THREE.Matrix4();
      if (b) inv[i].copy(m.multiplyMatrices(toChar, b.matrixWorld)).invert();
      else inv[i].identity();
    }
    inv.length = sk.bones.length;
  }
}

// ── per-character material construction ──────────────────────────────────────
//
// Every character gets its OWN material instances (skin tone, detail mix, hair colour are
// per character) but they must NOT get their own compiled shader program: 50 characters
// with 50 unique program cache keys is 50 compiles and 50 state changes per frame.
//
// three calls `onBeforeCompile` once per MATERIAL (and stores that material's uniforms),
// but reuses the compiled PROGRAM for any material with the same cache key. So the key
// must describe the SHAPE of the injection — which slots are patched — and never a
// per-instance counter. Two materials sharing a key must produce identical source; ours
// do, because the key names every input to the patch.
function programKey(parts) { return 'gcc:' + parts.filter(Boolean).join('|'); }

// Patch ONE shader chunk so its texture read becomes a mix toward the other anchor's map.
// The chunk SOURCE is taken from three itself and the sampler call rewritten inside it,
// rather than hand-copying chunk bodies that change between three versions.
//
// At onBeforeCompile the fragment shader still holds `#include <chunk>` UNEXPANDED, so the
// DIRECTIVE is what must be replaced. Patching a line that lives inside a chunk body
// silently does nothing — that text is not in the source yet.
function patchChunk(THREE, shader, chunk, sampler, uniform) {
  const src = THREE.ShaderChunk[chunk];
  if (!src) return false;
  const re = () => new RegExp('texture2D\\(\\s*' + sampler + '\\s*,\\s*(\\w+)\\s*\\)', 'g');
  if (!re().test(src)) return false;
  const patched = src.replace(re(), `mix( texture2D( ${sampler}, $1 ), texture2D( ${uniform}, $1 ), gccDetailT )`);
  const before = shader.fragmentShader;
  shader.fragmentShader = before.replace(`#include <${chunk}>`, patched);
  return shader.fragmentShader !== before;
}

// glTF slot → the sampler in the standard shader, the chunk that reads it, and the uniform
// we add beside it.
//
// DETAIL IS SURFACE, NOT COLOUR (owner, 2026-08-02). There is deliberately NO `map` entry:
// the base-colour slot must never cross-fade, because crossing colour makes this slider
// fight every other owner of the skin's colour (an applied photo, the tone grade, the baked
// body tone) and every attempt to referee that fight moved the seam somewhere else instead
// of removing it. A slot present in the blob but missing here is simply skipped, so this
// one table is the whole gate.
const DETAIL_SLOTS = {
  normalMap:    { sampler: 'normalMap',    chunk: 'normal_fragment_maps',  uniform: 'gccDetailNormalMap' },
  roughnessMap: { sampler: 'roughnessMap', chunk: 'roughnessmap_fragment', uniform: 'gccDetailRoughnessMap' },
  metalnessMap: { sampler: 'metalnessMap', chunk: 'metalnessmap_fragment', uniform: 'gccDetailMetalnessMap' },
  aoMap:        { sampler: 'aoMap',        chunk: 'aomap_fragment',        uniform: 'gccDetailAoMap' },
};

/**
 * Build one character's material for a skin mesh: clones the template material (so tone and
 * uniforms are per character) while every TEXTURE stays shared by reference — one upload for
 * the whole crowd, which is the entire point.
 */
function makeSkinMaterial(THREE, template, detailTextures, scalp) {
  const mat = template.clone();
  // Material.clone() DROPS onBeforeCompile (three resets it to the default). Every injected
  // shader has to be re-attached on the clone — forgetting this is why a cloned material
  // renders as a plain standard material with no error at all.
  const slots = [];
  for (const [slot, tex] of Object.entries(detailTextures || {})) {
    const info = DETAIL_SLOTS[slot];
    if (!info || !mat[slot]) continue;      // slot not on this material → nothing to mix
    slots.push({ info, tex });
  }
  // THE SKIN TONE GRADE. Verbatim from the editor (character-editor/image_demo.js, the
  // melanin block in the live skin shader, which its own comment calls "identical math to
  // the export bake pass"). It is here rather than baked because a BLENDED character's tone
  // lives on the parent record: `ingestCharacter` bakes the grade into a single-source
  // character's exported atlas, so that case carries it for free, but a blend's sources each
  // bring their own skin and the parent's grade reaches nothing. Cander rendered markedly
  // darker than the editor for exactly that reason.
  //
  // Off by default (`uGccToneOn` 0), so a character that never sets a tone is byte-identical
  // to before. The math runs on diffuseColor in LINEAR space, which is the space the editor's
  // RT pass worked in — grading after the sRGB conversion gives a different, wrong result.
  const uniforms = { gccDetailT: { value: 0 } };
  for (const s of slots) uniforms[s.info.uniform] = { value: s.tex };
  uniforms.uGccToneOn = { value: 0 };
  uniforms.uGccMelanin = { value: 0.5 };
  uniforms.uGccExposure = { value: 1 };
  uniforms.uGccContrast = { value: 1 };
  uniforms.uGccSaturation = { value: 1 };
  uniforms.uGccWarmth = { value: 0 };
  if (scalp) {
    uniforms.gccScalpMask = { value: scalp.mask };
    uniforms.gccScalpColor = { value: new THREE.Color(0x000000) };
  }
  mat.userData.gccUniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let decl = '';
    if (slots.length) decl += 'uniform float gccDetailT;\n';
    for (const s of slots) decl += `uniform sampler2D ${s.info.uniform};\n`;
    if (scalp) decl += 'uniform sampler2D gccScalpMask;\nuniform vec3 gccScalpColor;\n';
    decl += 'uniform float uGccToneOn;\nuniform float uGccMelanin;\nuniform float uGccExposure;\n'
          + 'uniform float uGccContrast;\nuniform float uGccSaturation;\nuniform float uGccWarmth;\n';
    shader.fragmentShader = decl + shader.fragmentShader;
    for (const s of slots) {
      if (!patchChunk(THREE, shader, s.info.chunk, s.info.sampler, s.info.uniform)) {
        console.warn(`[gcc] could not patch <${s.info.chunk}> — ${s.info.sampler} will not cross-fade`);
      }
    }
    if (scalp) {
      // THE SCALP MASK IS A TEXTURE IN HEAD UV SPACE — never geometry, never a skullcap.
      // The `mix` is the whole thing: multiplying by the tint everywhere instead of
      // blending TOWARD it by the mask darkens the entire face (the "blackface" bug). At
      // mask = 0 the result must be EXACTLY the original skin.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         #ifdef USE_MAP
           float gccScalpM = clamp( texture2D( gccScalpMask, vMapUv ).r, 0.0, 1.0 );
           diffuseColor.rgb *= mix( vec3(1.0), gccScalpColor, gccScalpM );
         #endif`);
    }
    // THE TONE GRADE, LAST — after the map, the detail mix and the scalp tint, so it grades
    // the finished skin exactly as the editor's does. Anchored on <color_fragment> rather
    // than <map_fragment> so it is independent of whether the scalp patch above ran.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       if ( uGccToneOn > 0.5 ) {
         vec3 _gc = diffuseColor.rgb;
         float _gt  = ( uGccMelanin - 0.5 ) * 2.0;
         float _gte = _gt > 0.0 ? _gt * 2.5 : _gt;
         _gc *= vec3( pow( 0.65, _gte ), pow( 0.50, _gte ), pow( 0.38, _gte ) );
         _gc *= uGccExposure;
         _gc = ( _gc - 0.18 ) * uGccContrast + 0.18;
         float _glum = dot( _gc, vec3( 0.2126, 0.7152, 0.0722 ) );
         _gc = mix( vec3( _glum ), _gc, uGccSaturation );
         _gc.r *= ( 1.0 + uGccWarmth );
         _gc.b *= ( 1.0 - uGccWarmth );
         diffuseColor.rgb = max( _gc, vec3( 0.0 ) );
       }`);
  };
  mat.customProgramCacheKey = () => programKey([
    'skin',
    slots.map((s) => s.info.sampler).join('.'),
    scalp ? 'scalp' : '',
    'tone',
  ]);
  mat.needsUpdate = true;
  return mat;
}

// ── the hair shader ──────────────────────────────────────────────────────────
//
// Two passes, always. HAIR IS NEVER BLEND-ONLY (owner law):
//   pass 1  CUT   opaque, alpha-tested, depth-writing  → the hair is SOLID
//   pass 2  SOFT  blended, no depth write, low opacity → the strand edges fade
// The cut pass is what stops hair reading as glass; the soft pass only ever draws on top of
// it. Never `alphaToCoverage` together with a hard `alphaTest` — the clip runs first and
// throws away exactly the partial coverage A2C exists to resolve.
// THE HAIR SHADER IS OURS AND IT IS ALREADY PUBLISHED. This file used to carry a
// near-verbatim COPY of agent/integration/hair-shader.js — a second implementation of the
// opaque alpha-CUT pass, the anisotropic strand highlight and the soft pass. It rendered
// hair as flat brown blobs, and it would have drifted from the real one the first time a
// hair parameter was tuned. Owner law: delete the twin in the same change.
//
// So the module is IMPORTED, not reproduced. `createHairMaterials(THREE, source, opts)` and
// its DEFAULTS live there; this file only decides which style is loaded and where the cards
// are seated.
import { createHairMaterials, loadHairParams, loadHairAtlas, DEFAULTS as HAIR_DEFAULTS,
         HAIR_COLOR_STYLES, hairColorStyle, isMultiRoot } from '../agent/integration/hair-shader.js';
// The app's OWN record reader. An outfit save carries its body-hide mask in `.exact.bin`
// (`manifest.bodyHidden`), written when the outfit was saved — so the SDK reads the saved
// file directly. Nothing to extract, nothing to publish, no build step: an outfit that hides
// nothing simply has no bodyHidden. Importing the reader rather than re-deriving the layout
// is the same rule as the hair shader.
// The dependency-free record codec. NOT character-store.js: that imports auth.js and drags
// the whole account stack into the embedding game's page, where the chain fails to load.
// Flat path because the edge build flattens shared/ to the CDN root.
import { deserializeCharacter, idxList } from '../record-codec.js';


function buildHairBinding(hairMeshes, skinPos, scalpVerts) {
  // hash grid over the candidate skin vertices for fast nearest-vertex queries
  const cand = scalpVerts || null;
  const N = cand ? cand.length : skinPos.length / 3;
  const at = (i) => (cand ? cand[i] : i);
  const grid = new Map();
  const gk = (x, y, z) => Math.round(x / GRID_CELL) + ',' + Math.round(y / GRID_CELL) + ',' + Math.round(z / GRID_CELL);
  for (let i = 0; i < N; i++) {
    const v = at(i);
    const k = gk(skinPos[v * 3], skinPos[v * 3 + 1], skinPos[v * 3 + 2]);
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(v);
  }
  const kIdx = new Int32Array(CONFORM_K), kD2 = new Float64Array(CONFORM_K);
  const nearK = (px, py, pz) => {
    const cx = Math.round(px / GRID_CELL), cy = Math.round(py / GRID_CELL), cz = Math.round(pz / GRID_CELL);
    let n = 0;
    for (let r = 1; r <= 3 && n === 0; r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) for (let iy = cy - r; iy <= cy + r; iy++) for (let iz = cz - r; iz <= cz + r; iz++) {
        const cell = grid.get(ix + ',' + iy + ',' + iz); if (!cell) continue;
        for (const v of cell) {
          const dx = skinPos[v * 3] - px, dy = skinPos[v * 3 + 1] - py, dz = skinPos[v * 3 + 2] - pz;
          const d = dx * dx + dy * dy + dz * dz;
          if (n < CONFORM_K) {
            let j = n++; kIdx[j] = v; kD2[j] = d;
            while (j > 0 && kD2[j] < kD2[j - 1]) { const ti = kIdx[j]; kIdx[j] = kIdx[j - 1]; kIdx[j - 1] = ti; const td = kD2[j]; kD2[j] = kD2[j - 1]; kD2[j - 1] = td; j--; }
          } else if (d < kD2[CONFORM_K - 1]) {
            let j = CONFORM_K - 1; kIdx[j] = v; kD2[j] = d;
            while (j > 0 && kD2[j] < kD2[j - 1]) { const ti = kIdx[j]; kIdx[j] = kIdx[j - 1]; kIdx[j - 1] = ti; const td = kD2[j]; kD2[j] = kD2[j - 1]; kD2[j - 1] = td; j--; }
          }
        }
      }
    }
    return n;
  };

  const used = new Map();                 // skin vertex -> compact slot
  const slotOf = (v) => { let s = used.get(v); if (s === undefined) { s = used.size; used.set(v, s); } return s; };
  const perMesh = [];

  for (const hm of hairMeshes) {
    const attr = hm.geometry.attributes.position, ha = attr.array, hn = attr.count;
    const idx = hm.geometry.index ? hm.geometry.index.array : null;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(hn / 3);
    if (!triCount) { perMesh.push({ mesh: hm, cards: [] }); continue; }

    // cards = connected components, welding coincident verts first (a card's quads are
    // split in the GLB, so raw index connectivity alone tears one card into strips)
    const canon = new Int32Array(hn); const key2c = new Map();
    for (let i = 0; i < hn; i++) {
      const k = Math.round(ha[i * 3] * WELD_Q) + ',' + Math.round(ha[i * 3 + 1] * WELD_Q) + ',' + Math.round(ha[i * 3 + 2] * WELD_Q);
      let c = key2c.get(k); if (c === undefined) { c = i; key2c.set(k, c); } canon[i] = c;
    }
    const parent = new Int32Array(hn); for (let i = 0; i < hn; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let t = 0; t < triCount; t++) {
      const a = canon[idx ? idx[t * 3] : t * 3];
      const b = canon[idx ? idx[t * 3 + 1] : t * 3 + 1];
      const c = canon[idx ? idx[t * 3 + 2] : t * 3 + 2];
      uni(a, b); uni(b, c);
    }
    const comps = new Map();
    for (let i = 0; i < hn; i++) { const r = find(canon[i]); let arr = comps.get(r); if (!arr) { arr = []; comps.set(r, arr); } arr.push(i); }

    const cards = [];
    for (const verts of comps.values()) {
      // ROOT = the card vertex nearest the scalp — its authored point of contact. Hair
      // grows out of it by construction, so that is the vertex whose displacement the
      // whole card must inherit.
      const step = Math.max(1, Math.floor(verts.length / 60));
      let rootV = -1, rootD2 = Infinity;
      for (let k = 0; k < verts.length; k += step) {
        const vi = verts[k];
        if (!nearK(ha[vi * 3], ha[vi * 3 + 1], ha[vi * 3 + 2])) continue;
        if (kD2[0] < rootD2) { rootD2 = kD2[0]; rootV = kIdx[0]; }
      }
      if (rootV < 0) continue;

      let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
      for (const vi of verts) {
        const x = ha[vi * 3], y = ha[vi * 3 + 1], z = ha[vi * 3 + 2];
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
      }
      const len = Math.sqrt((bx1 - bx0) ** 2 + (by1 - by0) ** 2 + (bz1 - bz0) ** 2);
      const card = { verts: Int32Array.from(verts), root: slotOf(rootV), near: null, w: null, k: 0 };

      if (len >= CARD_SHORT) {
        // LONG card — per-vertex binding. Short cards deliberately get none: a sideburn
        // tuft must move as ONE rigid piece or it spreads into patchy strands.
        const nv = verts.length;
        const near = new Int32Array(nv * CONFORM_K).fill(-1);
        const w = new Float32Array(nv * CONFORM_K);
        for (let k = 0; k < nv; k++) {
          const vi = verts[k];
          const nf = nearK(ha[vi * 3], ha[vi * 3 + 1], ha[vi * 3 + 2]);
          if (!nf) continue;
          const f = fade(Math.sqrt(kD2[0]));      // overall influence, from the NEAREST hit
          if (f <= 0) continue;                   // >= D1 off the scalp: exactly rigid
          let usum = 0;
          for (let q = 0; q < nf; q++) usum += 1 / (Math.sqrt(kD2[q]) + 1e-4);
          for (let q = 0; q < nf; q++) {
            near[k * CONFORM_K + q] = slotOf(kIdx[q]);
            w[k * CONFORM_K + q] = f * (1 / (Math.sqrt(kD2[q]) + 1e-4)) / usum;
          }
        }
        card.near = near; card.w = w; card.k = CONFORM_K;
      }
      cards.push(card);
    }
    perMesh.push({ mesh: hm, cards });
  }

  // compact list of the skin vertices anything actually follows — the per-change work is
  // proportional to THIS, not to the 6162-vertex head
  const skinVerts = new Int32Array(used.size);
  for (const [v, s] of used) skinVerts[s] = v;
  return { perMesh, skinVerts };
}

// ── outfit piece pairing ─────────────────────────────────────────────────────
//
// The two ends are two independent saves written at different times. NEVER pair by
// traversal order: nothing guarantees they walk the same order, and one extra piece on one
// side shifts every index after it.
//
// VERTEX COUNT ALONE IS NOT AN IDENTITY either. A pair of sneakers is two mirrored meshes
// with the SAME count, so "first piece with a matching count" hands the left shoe the right
// shoe's delta and both fly off the feet the moment the slider leaves the end. Where several
// pieces share a count, WHERE THEY ARE settles it: both bakes stand the same character at the
// same origin, so a piece's own twin is millimetres away while the other shoe is a stance
// apart.
function centroidOf(geom) {
  const a = geom.attributes.position.array;
  let x = 0, y = 0, z = 0;
  const n = geom.attributes.position.count;
  for (let i = 0; i < n; i++) { x += a[i * 3]; y += a[i * 3 + 1]; z += a[i * 3 + 2]; }
  return [x / n, y / n, z / n];
}

// Centred per-vertex mean distance. A mirrored twin reads far worse than a true one, which
// is how the shoes-on-opposite-feet case is caught instead of silently mirroring on the
// slider.
function corrDistance(ga, gb) {
  const a = ga.attributes.position.array, b = gb.attributes.position.array;
  const n = ga.attributes.position.count;
  const ca = centroidOf(ga), cb = centroidOf(gb);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const dx = (a[i * 3] - ca[0]) - (b[i * 3] - cb[0]);
    const dy = (a[i * 3 + 1] - ca[1]) - (b[i * 3 + 1] - cb[1]);
    const dz = (a[i * 3 + 2] - ca[2]) - (b[i * 3 + 2] - cb[2]);
    s += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return s / n;
}

function pairOutfitBakes(A, B, strict) {
  const taken = new Set();
  const pairs = [];
  let chiralMiss = false;
  for (const a of A) {
    const want = a.geometry.attributes.position.count;
    const sameCount = B.filter((b) => !taken.has(b) && b.geometry.attributes.position.count === want);
    if (!sameCount.length) { if (strict) return null; continue; }
    let pick;
    if (sameCount.length === 1) {
      pick = sameCount[0];
    } else {
      const byName = sameCount.filter((b) => b.name === a.name);
      const pool = byName.length === 1 ? byName : sameCount;
      if (pool.length === 1) pick = pool[0];
      else {
        const ca = centroidOf(a.geometry);
        let best = Infinity;
        for (const b of pool) {
          const cb = centroidOf(b.geometry);
          const d = (ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2 + (ca[2] - cb[2]) ** 2;
          if (d < best) { best = d; pick = b; }
        }
        // chirality check: if the positional pick reads as a MIRROR while another
        // same-count piece corresponds cleanly, this is the shoes-swapped case
        const mine = corrDistance(a.geometry, pick.geometry);
        for (const b of pool) {
          if (b === pick) continue;
          if (corrDistance(a.geometry, b.geometry) < mine * 0.5) { chiralMiss = true; break; }
        }
      }
    }
    if (!pick) { if (strict) return null; continue; }
    if (chiralMiss && strict) return null;
    taken.add(pick);
    pairs.push({ src: a, other: pick });
  }
  if (strict && pairs.length !== A.length) return null;
  if (!pairs.length) return null;
  pairs.chiralMiss = chiralMiss;
  return pairs;
}

// ── per-character geometry that is mostly NOT per-character ──────────────────
//
// Hair and outfits are the two things whose POSITIONS are written per character (the conform
// and the two-fit lerp). Everything else about them — uv, index, skin index/weight — is
// identical for every wearer, so it is shared BY REFERENCE and uploaded once.
//
// `own` names the attributes this character owns outright. Nothing else may ever be disposed
// through this geometry: three's dispose handler frees the GPU buffer of EVERY attribute it
// finds, and those buffers belong to the other characters too.
function ownedGeometry(THREE, src, own) {
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(src.attributes)) {
    g.setAttribute(k, own.includes(k) ? new THREE.BufferAttribute(Float32Array.from(a.array), a.itemSize) : a);
  }
  if (src.index) g.setIndex(src.index);
  g.userData.__gccOwn = own;
  return g;
}

function disposeOwnedGeometry(geom) {
  const own = (geom.userData && geom.userData.__gccOwn) || [];
  for (const k of Object.keys(geom.attributes)) if (!own.includes(k)) geom.deleteAttribute(k);
  geom.setIndex(null);                    // the index came from the shared source
  geom.morphAttributes = {};
  geom.dispose();
}

// Downsample every image-backed texture on a root over maxDim, in place — for a consumer that
// asked for Creator.open({ maxTextureSize }) on a memory-starved device. Render targets (no
// .image) are left alone. Shared by reference across spawned instances, so capping the template
// caps the whole crowd once. flipY/colorSpace/wrap are unaffected by the pixel dimensions.
// PER-PART phone caps (owner): skin 1024 / normal 512 on face & body, teeth+mouth 256, eyes
// 256, hair 512 with its normal map DROPPED (not needed), tongue normal dropped. cap 0 = remove
// the map. Only runs for a consumer that asked (Creator.open({ lowMem })).
function _capFor(meshName, slot) {
  const n = (meshName || '').toLowerCase();
  const isNormal = slot === 'normalMap' || slot === 'bumpMap';
  if (/hair/.test(n))              return isNormal ? 0 : 512;
  if (/tongue/.test(n))            return isNormal ? 0 : 256;
  if (/teeth|tooth|mouth/.test(n)) return 256;
  if (/eye/.test(n))               return 256;
  return isNormal ? 512 : 1024;    // head/face + body skin
}
// Canvas downsample — iOS Safari cannot resize inside createImageBitmap (that shipped a BLACK
// face), so the resize is always a drawImage into a plain canvas here.
function _downsizeImg(img, maxDim) {
  const w = img.width, h = img.height;
  if (!w || !h || Math.max(w, h) <= maxDim) return img;
  const s = maxDim / Math.max(w, h);
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
  try { img.close && img.close(); } catch (_) {}
  return cv;
}
const _CAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap'];
function capBaseTextures(root) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!mat) continue;
      for (const k of _CAP_SLOTS) {
        const t = mat[k]; if (!t) continue;
        const cap = _capFor(o.name, k);
        if (cap === 0) { mat[k] = null; mat.needsUpdate = true; continue; }   // hair/tongue normal: gone
        if (seen.has(t)) continue; seen.add(t);
        const img = t.image; if (!img || !img.width || Math.max(img.width, img.height) <= cap) continue;
        t.image = _downsizeImg(img, cap); t.needsUpdate = true;
      }
    }
  });
}

// ── Creator ──────────────────────────────────────────────────────────────────

export class Creator {
  /**
   * Load a project: validate the key, pull the manifest, upload the shared geometry and
   * every morph target ONCE. Everything expensive happens here; `spawn()` is cheap.
   *
   * @param {object}  o
   * @param {string}  o.key       ggc_proj_… — origin-locked, read-only, spend permanently zero
   * @param {string} [o.token]    the SITE's own path instead of a key: a signed-in session's
   *                              access token, checked same-origin. A game does not use this.
   * @param {string}  o.assets    the CUSTOMER's asset base URL (their hosting, their bandwidth)
   * @param {string} [o.site]     where to validate the key. Defaults to production; set it only
   *                              for staging or a local integration test.
   * @param {object} [o.THREE]    the game's three.js namespace (peer; see resolveThree)
   * @param {object} [o.renderer] your WebGLRenderer — required to blend SKIN as well as shape
   * @param {Function} [o.GLTFLoader]
   * @param {object} [o.dracoLoader]  a configured DRACOLoader, for the optimized asset route
   * @param {object} [o.ktx2Loader]   a configured KTX2Loader, ditto
   */
  static async open(o = {}) {
    const THREE = await resolveThree(o);
    const GLTFLoader = await resolveGLTFLoader(o);
    if (!o.assets) {
      throw new Error('[gcc] Creator.open({ assets }) is required — the base URL of YOUR copy of ' +
        'the project assets. Assets are customer-hosted: we do not serve them per player.');
    }
    // A key identifies a customer's project; the SITE authorises its own tools with the user
    // who is already signed in — owner, 2026-08-08: "the validation happens with the logged in
    // user. the product key is not needed since the user is already logged in to use this tool
    // at all." So a token is optional too: with neither, the session cookie is what /api/me
    // reads, and `Creator.open({ assets })` is the whole call on one of our own pages.
    //
    // THE SERVER DECIDES IN EVERY CASE. Nothing here inspects `location` to decide whether a
    // page is allowed — that would be page-side JS gating itself, in a module the customer has
    // a copy of. The only thing chosen here is which failure MESSAGE fits: an integrator who
    // forgot their key must not be told to "sign in", and our own tool must not be told to buy
    // a project key.
    let project;
    if (o.key) {
      project = await validateKey(o.key, o.site);
    } else {
      try {
        project = await validateSession(o.token, o.site);
      } catch (e) {
        // Nothing was passed at all, and the session check did not produce a user — for ANY
        // reason. On a customer's origin `/api/me` is not their route, so this arrives as a
        // 404 (or their SPA's index.html, or a CORS failure) rather than a clean 401. Matching
        // only "not signed in" left that integrator reading "session check failed: HTTP 404",
        // which names our infrastructure and tells them nothing they can act on. Without
        // either credential the only actionable advice is the same however it failed.
        if (!o.token) {
          throw new Error('[gcc] Creator.open({ key }) is required — a project key from ' +
            'creategamecharacters.ai. (None was passed, and this page carries no signed-in ' +
            'session either; the keyless path is for our own tools on our own origin.)');
        }
        throw e;   // a token WAS passed: report why it was refused, verbatim
      }
    }
    const base = String(o.assets);

    // TODO(spec): the project manifest's shape is not specified in context/sdk/context.md.
    // Defined here as the minimum the runtime needs; if the site's project export settles on
    // a different shape, this reader is the only place that changes.
    //   { v:1,
    //     base:     { url },
    //     spectrum: { url, files:{ <nameInBlob>: <relativeUrl> } },
    //     face:     { url },                       // GLB of named identity morph targets
    //     head:     { mesh, scalpVertices },       // mesh name + optional scalp index list
    //     hair:     { <id>: { a, b, params, atlas, tangent, scalp:{ mask, darken } } },
    //     outfits:  { <id>: { a, b, hide } } }
    const manifest = await getJSON(joinUrl(base, o.manifest || 'manifest.json'));

    const loader = new GLTFLoader();
    if (o.dracoLoader) loader.setDRACOLoader(o.dracoLoader);
    if (o.ktx2Loader) loader.setKTX2Loader(o.ktx2Loader);
    if (loader.setMeshoptDecoder && o.meshoptDecoder) loader.setMeshoptDecoder(o.meshoptDecoder);

    const baseUrl = joinUrl(base, (manifest.base && manifest.base.url) || 'base.glb');
    const gltf = await loader.loadAsync(baseUrl);
    const template = gltf.scene;
    // Measure everything relative to the rig root, so "body space" is well defined however
    // the customer nests the character later. Mixing a GLB's authoring units (cm) with the
    // scene's metres, or comparing a bone-local position against a world one, is the single
    // most expensive class of bug in this pipeline.
    template.position.set(0, 0, 0); template.quaternion.identity(); template.scale.set(1, 1, 1);
    template.updateMatrixWorld(true);

    // The base GLB ships legacy overlay strips — eye_shadow / wetlayer / tearline — that
    // EVERY site consumer removes at load (the editor and the Animation Tool both do).
    // The SDK is a consumer of the same base and must too: without this, every spawned
    // character wears a white eye_shadow almond over the eye.
    {
      const dead = [];
      template.traverse((o) => { if (o.isMesh && /^(eye_shadow|wetlayer|tearline)$/i.test(o.name || '')) dead.push(o); });
      for (const d of dead) if (d.parent) d.parent.remove(d);
    }

    // ── ARKit expression names, captured BEFORE anything is appended ──
    // three.js builds morphTargetDictionary while parsing the glTF (from mesh.extras
    // .targetNames). Appending our own targets afterwards makes it rebuild the table from
    // INDICES, so "jawOpen" becomes "17" and every expression is unaddressable by name.
    // Snapshot the name→index map now; the indices stay valid because appends only ever go
    // on the end.
    const exprNames = new Map();
    template.traverse((o) => {
      if ((o.isMesh || o.isSkinnedMesh) && o.name && o.morphTargetDictionary) {
        exprNames.set(o.name, { ...o.morphTargetDictionary });
      }
    });

    // ── the spectrum, as ONE morph target per mesh ──
    const specUrl = joinUrl(base, (manifest.spectrum && manifest.spectrum.url) || 'spectrum.bin');
    let spec = null;
    try {
      const r = await fetch(specUrl);
      if (r.ok) spec = parseSpectrum(await r.arrayBuffer());
      else console.info('[gcc] no spectrum delta at ' + specUrl + ' — this project is a single-shape base.');
    } catch (e) {
      // A missing blob is legitimate (a base with no second anchor); a CORRUPT one is not.
      if (e && /spectrum blob/.test(e.message)) throw e;
      console.info('[gcc] spectrum delta unavailable:', e && e.message);
    }
    const spectrum = spec ? installSpectrumMorphs(THREE, template, spec) : { entries: [], headRigid: null };

    // ── the identity sliders: LISTED here, built into morph targets on first use ──
    //
    // A slider is a SPARSE set of moved vertices in the recipe and a DENSE full-length buffer
    // once it is a morph target — plus a slot in the geometry's packed morph texture, whose
    // cost every draw of that mesh pays whether the weight is zero or not. So a scene that
    // never touches a slider must not pay for it: the recipe is parsed and each slider is
    // listed by name, and `_ensureFaceSlider` builds one the first time it is written or
    // preloaded. The game decides WHEN — at a dialogue, on a scene load, per LOD tier.
    let face = { names: [], routes: new Map() };
    let facePlans = null;
    if (manifest.face && manifest.face.url) {
      const faceUrl = joinUrl(base, manifest.face.url);
      if (/\.json(\?|$)/i.test(manifest.face.url)) {
        // The published recipe format. This is what the site ships and what
        // fetch-assets downloads, so it is the normal path — not the fallback.
        const recipe = await getJSON(faceUrl);
        facePlans = new Map(Object.entries(recipe.sliders || {}));
        face = { names: [...facePlans.keys()], routes: new Map() };
      } else {
        // The GLB path hands us finished morph attributes rather than a sparse recipe, so
        // there is nothing to defer: they are already decoded in memory by then.
        const faceGltf = await loader.loadAsync(faceUrl);
        face = await installFaceMorphs(THREE, template, faceGltf);
        faceGltf.scene.traverse((x) => { if (x.geometry) x.geometry.dispose(); });
      }
    }

    // ── eye colours ──
    // The same albedos the editor's Eyes panel offers. One texture swap on the eye meshes'
    // own material — per character, because eye colour is per character.
    let eyeColors = [];
    if (manifest.eyes && manifest.eyes.index) {
      try {
        const idx = await getJSON(joinUrl(base, manifest.eyes.index));
        const dir = String(manifest.eyes.index).replace(/[^/]*$/, '');
        eyeColors = (idx.colors || []).map((e) => ({ ...e, url: joinUrl(base, joinUrl(dir, e.file)) }));
      } catch (e) { console.warn('[gcc] eye colours unreadable:', e && e.message); }
    }

    // ── the saved characters this project blends between: LISTED, fetched on first use ──
    //
    // A source costs a recipe fetch, a dense morph target per mesh AND a full skin atlas, so
    // this used to make `open()` download every source in the project before it returned — a
    // fifty-character library billed in full to a scene showing three. Now `open()` learns
    // their names and nothing else; `_ensurePreset` fetches one when a blend first weights it
    // or the game preloads it.
    let presets = { names: [], routes: new Map(), atlases: new Map(), builds: new Map(), heads: new Map() };
    let presetPlans = null;
    if (manifest.presets && Object.keys(manifest.presets).length) {
      presetPlans = new Map();
      for (const [id, e] of Object.entries(manifest.presets)) {
        const url = typeof e === 'string' ? e : (e && e.recipe);
        if (url) presetPlans.set(id, url);
      }
      presets = { names: [...presetPlans.keys()], routes: new Map(), atlases: new Map(), builds: new Map(), heads: new Map() };
      console.info(`[gcc] character blending: ${presets.names.length} source(s) available, loaded on use` +
        (presets.names.length ? ' — ' + presets.names.join(', ') : ''));
    }

    // Influence arrays must be resized for the targets we just appended BEFORE anything is
    // cloned — Mesh.copy() slices whatever length it finds.
    template.traverse((x) => { if (x.isMesh || x.isSkinnedMesh) x.updateMorphTargets?.(); });

    // ── the detail (skin surface) sidecar maps, uploaded once and shared ──
    // Colour is deliberately NOT among them (see DETAIL_SLOTS).
    const detailByMesh = new Map();
    const texCache = new Map();
    const fileMap = (manifest.spectrum && manifest.spectrum.files) || {};
    for (const e of spectrum.entries) {
      if (!e.texs) continue;
      const slots = {};
      for (const t of e.texs) {
        if (!DETAIL_SLOTS[t.slot]) continue;         // the gate: surface only, never colour
        // TODO(spec): the blob names its sidecars `spectrum_v5_<anchorA>_<anchorB>.<hash>.<ext>`,
        // which leaks the internal anchor slugs into customer-hosted filenames. The project
        // export should rename them and list the mapping in manifest.spectrum.files; until it
        // does, the raw name is used verbatim.
        const rel = fileMap[t.file] || ('spectrum/' + t.file);
        let tex = texCache.get(rel);
        if (!tex) {
          const like = e.mesh.material && e.mesh.material[t.slot];
          tex = new THREE.TextureLoader().load(joinUrl(base, rel));
          // Match the map it stands in for, or the mix samples it in the wrong space: a
          // colour map is sRGB, a normal/ORM map is raw data, and glTF textures are flipY:false.
          if (like) {
            tex.colorSpace = like.colorSpace; tex.flipY = like.flipY;
            tex.wrapS = like.wrapS; tex.wrapT = like.wrapT;
            tex.minFilter = like.minFilter; tex.magFilter = like.magFilter;
            tex.anisotropy = like.anisotropy;
          }
          texCache.set(rel, tex);
        }
        slots[t.slot] = tex;
      }
      if (Object.keys(slots).length) detailByMesh.set(e.mesh, slots);
    }

    // ── the head, for hair conform ──
    // Rest positions in BODY space. A SkinnedMesh at its bind pose renders at
    // matrixWorld · position, so pushing the rest through that matrix is what puts the head
    // and the hair in one space. Never inverse-transform the hair instead.
    const headName = (manifest.head && manifest.head.mesh) || null;
    let head = null;
    template.traverse((x) => {
      if (head || !(x.isMesh || x.isSkinnedMesh)) return;
      if (headName ? x.name === headName : /head/i.test(x.name || '')) head = x;
    });
    let headRest = null, headToBody = null;
    if (head) {
      head.updateWorldMatrix(true, false);
      const m = head.matrixWorld;
      const src = head.geometry.attributes.position.array;
      if (isIdentityMatrix(m)) headRest = src;
      else {
        headRest = new Float32Array(src.length);
        const v = new THREE.Vector3();
        for (let i = 0; i < src.length; i += 3) {
          v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m);
          headRest[i] = v.x; headRest[i + 1] = v.y; headRest[i + 2] = v.z;
        }
        headToBody = new THREE.Matrix3().setFromMatrix4(m);   // linear part, for DELTAS
      }
    }
    // TODO(spec): the scalp region is a UV pelt island on the site (ears, nostrils and lids
    // excluded — including the ears corrupts the wrap). No such index list is defined for the
    // SDK assets. Without `manifest.head.scalpVertices` the nearest-skin search can bind a
    // hair vertex near the temple to an EAR vertex, and that hair will then follow the ear.
    let scalpVerts = null;
    if (manifest.head && manifest.head.scalpVertices) {
      const list = await getJSON(joinUrl(base, manifest.head.scalpVertices));
      scalpVerts = Int32Array.from(list.vertices || list);
    } else if (head) {
      console.info('[gcc] no scalp vertex list in the manifest — hair conform binds against the whole head mesh (see TODO(spec) in v1.js).');
    }

    // ── the rest-pose table ──
    const nodesByName = new Map();
    template.traverse((x) => { if (x.name && !nodesByName.has(x.name)) nodesByName.set(x.name, x); });
    const restNodes = (spec && spec.header.nodes) || [];
    const restA = spec ? captureRestA(THREE, nodesByName, restNodes) : new Map();

    const c = new Creator();
    c._THREE = THREE;
    c._loader = loader;
    c._base = base;
    c._manifest = manifest;
    c.project = project;
    c._template = template;
    // LOW-MEMORY DEVICES (guarded — only when the consumer passes Creator.open({ maxTextureSize })).
    // Downsize the base's own maps IN PLACE before anything captures them: a 4K skin/normal map
    // is ~64 MB of GPU memory, 512 is 1/64th. Render targets have no .image so this skips them —
    // the blended skin is capped at the atlas decode (_loadAtlases) instead. No effect on any
    // consumer that does not ask for it.
    c._lowMem = !!o.lowMem;
    if (c._lowMem) capBaseTextures(template);
    c._templateNodes = [];
    template.traverse((x) => c._templateNodes.push(x));
    // template node -> its position in the traverse order. `Object3D.clone(true)` preserves
    // child order, so the same index on a character's node list is that node's clone. Every
    // "which of my meshes is this template mesh?" lookup goes through here — an indexOf scan
    // per face-slider write is O(nodes) on a path a UI drags at 60 fps.
    c._srcIndex = new Map();
    c._templateNodes.forEach((n, i) => c._srcIndex.set(n, i));
    c._spectrum = spectrum;
    c._restNodes = restNodes;
    c._restA = restA;
    c._face = face;
    c._presets = presets;
    c._eyes = eyeColors;
    c._exprNames = exprNames;
    // Everything the per-character texture composite needs, resolved once.
    c._byName = new Map();
    template.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.name) c._byName.set(o.name, o); });
    c._blendBaseMaps = new Map();
    for (const [n, m] of c._byName) {
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      if (mat && mat.map) c._blendBaseMaps.set(n, mat.map);
    }
    c._atlasTex = new Map();
    c._blendTex = null;
    c._atlasReady = Promise.resolve();
    c._facePlans = facePlans;
    c._presetPlans = presetPlans;
    c._presetLoading = new Map();          // id -> in-flight promise, so two blends load once
    c._presetFailed = new Set();           // never retried in a render loop
    c._renderer = o.renderer || null;
    if (presetPlans && presetPlans.size && !c._renderer) {
      console.warn('[gcc] Creator.open({ renderer }) is required to blend skin textures — pass your WebGLRenderer.');
    }
    c._detailByMesh = detailByMesh;
    c._head = head;
    c._headRest = headRest;
    c._headToBody = headToBody;
    c._scalpVerts = scalpVerts;
    c._hairCache = new Map();
    c._outfitCache = new Map();
    c._characters = new Set();
    // The template is a data source, never a rendered object. Keeping it out of the scene is
    // what guarantees a customer cannot accidentally mutate the shared geometry through it.
    return c;
  }

  constructor() { /* use Creator.open() */ }

  /** Every identity slider name this project ships, in declaration order. */
  get faceNames() { return this._face.names.slice(); }
  /** Hair ids available to this project. */
  get hairIds() { return Object.keys(this._manifest.hair || {}); }
  /** Outfit ids available to this project. */
  get outfitIds() { return Object.keys(this._manifest.outfits || {}); }
  /** Eye colours this project ships: [{ id, label, swatch }]. */
  get eyeColors() { return (this._eyes || []).map((e) => ({ id: e.id, label: e.label, swatch: e.swatch })); }
  /** Saved characters this project can blend between (the second blend). */
  get presetIds() { return (this._presets && this._presets.names || []).slice(); }
  /**
   * The BUILD a saved character was authored at, on this project's own body axis — the number
   * to pass to `setBody` to see that character the way it was saved. Sources are loaded on
   * use, so this is `null` until the source is resident: `await creator.preload({ presets: [id] })`
   * first, or read it after a `setBlend` that weights it has settled.
   *
   * A blend source carries the FACE and never the body, so this is a starting point and not a
   * constraint — the same face on any other build is a real character, which is the whole
   * point of the slider.
   */
  presetBuild(id) {
    const t = this._presets && this._presets.builds && this._presets.builds.get(id);
    return typeof t === 'number' ? t : null;
  }

  /**
   * Where that saved character's HEAD stood on the feminine-masculine axis. A character
   * spawned with a blend already lands here on its own; this is for a game that wants to
   * show the number, or to put a player's own head slider back where the character left it.
   * `null` until the source is resident.
   */
  presetHead(id) {
    const P = this._presets;
    if (!P || !P.heads) return null;
    const t = P.heads.has(id) ? P.heads.get(id) : (P.builds && P.builds.get(id));
    return typeof t === 'number' ? t : null;
  }

  /**
   * The body axis as a plain per-vertex vector, per template mesh: the spectrum morph target
   * IS (the other anchor − this base), which is what a legacy recipe's baked-in build has to
   * be measured against. Built on demand and cached; empty on a single-anchor project, where
   * there is no axis and nothing to separate.
   */
  _spectrumByMesh() {
    if (this.__specByMesh) return this.__specByMesh;
    const m = new Map();
    for (const e of (this._spectrum && this._spectrum.entries) || []) {
      const mp = e.mesh && e.mesh.geometry && e.mesh.geometry.morphAttributes
        && e.mesh.geometry.morphAttributes.position;
      const a = mp && mp[e.morphIndex] && mp[e.morphIndex].array;
      if (a) m.set(e.mesh, a);
    }
    return (this.__specByMesh = m);
  }
  /**
   * Hair colour styles: the swatches the product ships, plus anything this project adds under
   * `manifest.hairColors`. A project's entry overrides a shipped one of the same name.
   */
  get hairColorStyles() {
    return Object.keys({ ...HAIR_COLOR_STYLES, ...((this._manifest && this._manifest.hairColors) || {}) });
  }

  /**
   * Make one character. Returns immediately with a usable object; hair and outfit (which
   * need their own fetches) resolve asynchronously — `await c.ready` if you need them
   * present before the first frame.
   */
  spawn(recipe = {}) {
    const ch = new Character(this, recipe);
    this._characters.add(ch);
    return ch;
  }

  // ── RESIDENCY: what is in memory right now, and who decides ─────────────────
  //
  // Everything this project offers is LISTED at open() and loaded on first use: identity
  // sliders, blend sources and their skin atlases, hair, outfits. Nothing that a scene does
  // not touch is ever built. On top of that the game gets explicit control, because only the
  // game knows WHEN — a dialogue about to start, a scene boundary, a crowd it has decided is
  // too heavy. `preload()` warms; `unload()` releases; `resident()` reports.
  //
  // WHY THIS MATTERS MORE THAN IT LOOKS: three packs a mesh's morph targets into one texture
  // per GEOMETRY, and the vertex shader walks every resident target on every draw of that
  // mesh — a target whose influence is zero still costs. So residency, not the weight, is
  // what makes a background character cheap, and it is shared: releasing a slider releases it
  // for every character on that geometry.

  /**
   * Warm anything this project lists, before it is needed. Await it at a loading screen or a
   * scene boundary so the first frame that uses it does not hitch.
   *
   *   await creator.preload({ presets: ['Ember', 'Tesh'], face: ['jawWidth'], hair: ['Quiff'] });
   *
   * Unknown names are reported and skipped rather than thrown: a preload is an optimisation,
   * and it must never be the thing that takes a game down.
   */
  async preload({ face = [], presets = [], hair = [], outfits = [] } = {}) {
    const jobs = [];
    for (const n of face) if (!this._ensureFaceSlider(n)) console.warn(`[gcc] preload: no identity slider "${n}"`);
    for (const id of presets) jobs.push(this._ensurePreset(id));
    for (const id of hair) jobs.push(this._hairStyle(id).catch((e) => console.warn('[gcc] preload:', e.message)));
    for (const id of outfits) jobs.push(this._outfit(id).catch((e) => console.warn('[gcc] preload:', e.message)));
    await Promise.all(jobs);
    return this;
  }

  /**
   * Release what a scene has stopped needing. Morph slots are freed for reuse (never spliced —
   * see `appendMorphTarget`) and the influence they were carrying is zeroed on every live
   * character, so nobody keeps wearing a source that is no longer loaded. Loading it again
   * later is supported and simply re-fetches.
   */
  unload({ face = [], presets = [], hair = [], outfits = [] } = {}) {
    for (const name of face) {
      const routes = this._face.routes.get(name);
      if (!routes) continue;
      for (const r of routes) this._releaseSlot(r.mesh, r.morphIndex);
      this._face.routes.delete(name);
    }
    for (const id of presets) {
      const routes = this._presets.routes.get(id);
      if (routes) for (const r of routes) this._releaseSlot(r.mesh, r.morphIndex);
      this._presets.routes.delete(id);
      const byMesh = this._presets.atlases.get(id);
      if (byMesh) for (const meshName of byMesh.keys()) {
        const key = id + '|' + meshName;
        const t = this._atlasTex.get(key);
        if (t) { t.dispose(); this._atlasTex.delete(key); }
      }
      this._presets.atlases.delete(id);
      this._presets.builds.delete(id);   // reported as "not loaded" again, which is the truth
      this._presets.heads.delete(id);
      this._presetLoading.delete(id);
      // Anyone still weighting it must stop, or the next source into that slot inherits it.
      for (const ch of this._characters) if (ch._blend && ch._blend[id]) { delete ch._blend[id]; ch.setBlend(ch._blend); }
    }
    for (const id of hair) this._hairCache.delete(id);
    for (const id of outfits) this._outfitCache.delete(id);
    return this;
  }

  /** What is loaded right now — for a game driving its own LOD or budget policy. */
  resident() {
    return {
      face: [...this._face.routes.keys()],
      presets: [...this._presets.routes.keys()],
      hair: [...this._hairCache.keys()],
      outfits: [...this._outfitCache.keys()],
      morphSlots: this._morphSlotCount(),
    };
  }

  _morphSlotCount() {
    const seen = new Set();
    let used = 0, free = 0;
    for (const n of this._templateNodes) {
      if (!(n.isMesh || n.isSkinnedMesh) || seen.has(n.geometry)) continue;
      seen.add(n.geometry);
      const all = (n.geometry.morphAttributes.position || []).length;
      const f = (n.geometry.userData.__gccFreeSlots || []).length;
      used += all - f; free += f;
    }
    return { used, free };
  }

  // Keep every live character's influence array exactly as long as the geometry's target list.
  // three reads one per target on every draw; a short array is undefined weights, i.e. NaN
  // vertices. The template's own array is grown too — `spawn()` clones it.
  _syncInfluences(srcMesh) {
    const n = ((srcMesh.geometry.morphAttributes.position) || []).length;
    const grow = (m) => {
      if (!m) return;
      if (!m.morphTargetInfluences) m.morphTargetInfluences = [];
      while (m.morphTargetInfluences.length < n) m.morphTargetInfluences.push(0);
    };
    grow(srcMesh);
    for (const ch of this._characters) grow(ch._mine(srcMesh));
  }

  _releaseSlot(srcMesh, slot) {
    if (!freeMorphSlot(this._THREE, srcMesh.geometry, slot)) return;
    const clear = (m) => { if (m && m.morphTargetInfluences) m.morphTargetInfluences[slot] = 0; };
    clear(srcMesh);
    for (const ch of this._characters) clear(ch._mine(srcMesh));
  }

  /**
   * Build one identity slider's morph target, if it is not already resident. Synchronous: the
   * recipe is already in memory from open(); what is deferred is the DENSE buffer and the
   * morph-texture slot, which is the part that costs.
   */
  _ensureFaceSlider(name) {
    if (this._face.routes.has(name)) return true;
    const def = this._facePlans && this._facePlans.get(name);
    if (!def) return false;
    // The installer takes a whole recipe; handing it one slider installs exactly one.
    const r = installFaceRecipe(this._THREE, this._template, { sliders: { [name]: def } });
    for (const [k, routes] of r.routes) {
      this._face.routes.set(k, routes);
      for (const rt of routes) this._syncInfluences(rt.mesh);
    }
    return this._face.routes.has(name);
  }

  /** Fetch and install one blend source — its morph targets and its skin atlases. */
  _ensurePreset(id) {
    if (this._presets.routes.has(id) || this._presetFailed.has(id)) return Promise.resolve();
    if (this._presetLoading.has(id)) return this._presetLoading.get(id);
    const url = this._presetPlans && this._presetPlans.get(id);
    if (!url) { console.warn(`[gcc] unknown blend source "${id}". This project ships: ${this.presetIds.join(', ') || '(none)'}`); return Promise.resolve(); }
    const THREE = this._THREE;
    const p = (async () => {
      let recipe;
      try { recipe = await getJSON(joinUrl(this._base, url)); }
      catch (e) { this._presetFailed.add(id); console.warn(`[gcc] preset "${id}" recipe unreadable:`, e && e.message); return; }
      const r = installPresetRecipes(THREE, this._template, { [id]: recipe }, this._spectrumByMesh());
      for (const [k, t] of (r.builds || new Map())) this._presets.builds.set(k, t);
      for (const [k, t] of (r.heads || new Map())) this._presets.heads.set(k, t);
      for (const [k, routes] of r.routes) {
        this._presets.routes.set(k, routes);
        for (const rt of routes) this._syncInfluences(rt.mesh);
      }
      for (const [k, byMesh] of (r.atlases || new Map())) {
        this._presets.atlases.set(k, byMesh);
        await this._loadAtlases(k, byMesh);
      }
      if (!r.routes.has(id)) {
        console.info(`[gcc] blend source "${id}" is skin-only — it tints, it does not move the face.`);
      }
    })();
    this._presetLoading.set(id, p);
    return p;
  }

  /** Decode one source's skin atlases. Shared by every character that blends it. */
  async _loadAtlases(id, byMesh) {
    const THREE = this._THREE;
    if (!this._blendTex && this._renderer) this._blendTex = new BlendTextures(THREE, this._renderer);
    const pending = [];
    for (const [meshName, uri] of byMesh) {
      const key = id + '|' + meshName;
      if (this._atlasTex.has(key)) continue;
      // DECODE BEFORE COMPOSITING. The blend pass renders into a render target, so it bakes
      // whatever the texture held AT THAT MOMENT — fire it mid-decode and it bakes BLACK, and
      // nothing re-renders until a slider moves. blend-core carries the same note because it
      // shipped that bug once. createImageBitmap decodes off the main thread and settles
      // reliably for multi-MB data URIs, which is what these atlases are; Image.decode()
      // stalls on those outside the DOM.
      const t = new THREE.Texture();
      t.colorSpace = THREE.SRGBColorSpace;   // GPU decodes on sample, so the average is linear
      t.flipY = false;                       // recipe atlases are already in glTF row order
      this._atlasTex.set(key, t);
      // On a low-memory phone the skin atlas is downsampled to its part cap after decode (a
      // canvas, NOT createImageBitmap's resize — that is unsupported on iOS and shipped a black
      // face). The render target is sized from srcs[0].image.width, so capping the atlas caps it too.
      const cap = this._lowMem ? _capFor(meshName, 'map') : 0;
      pending.push(
        // joinUrl now owns this policy (it allows data:/blob: and refuses absolute URLs).
        // Wrapped so a refusal surfaces as a rejection the catch below handles, rather than
        // throwing synchronously out of the loop and failing the whole character.
        Promise.resolve().then(() => fetch(joinUrl(this._base, uri)))
          .then((r) => r.blob()).then(createImageBitmap)
          .then((bmp) => { t.image = cap ? _downsizeImg(bmp, cap) : bmp; t.needsUpdate = true; })
          .catch((e) => console.warn('[gcc] blend texture skipped:', id, meshName, e && e.message))
      );
    }
    this._atlasReady = Promise.all(pending);
    await this._atlasReady;
  }

  // ── internal: shared hair style data, loaded once per style ──
  async _hairStyle(id) {
    if (this._hairCache.has(id)) return this._hairCache.get(id);
    const entry = (this._manifest.hair || {})[id];
    if (!entry) throw new Error(`[gcc] unknown hair id "${id}". This project ships: ${this.hairIds.join(', ') || '(none)'}`);
    const p = (async () => {
      const THREE = this._THREE;
      // BOTH SEATED BAKES. A style fitted at both ends is a per-vertex lerp of two finished
      // bakes and nothing else — a runtime re-fit is what tore the hair apart and made it
      // worse on every drag.
      const [ga, gb] = await Promise.all([
        this._loader.loadAsync(joinUrl(this._base, entry.a)),
        entry.b ? this._loader.loadAsync(joinUrl(this._base, entry.b)) : Promise.resolve(null),
      ]);
      const rootA = ga.scene;
      rootA.updateMatrixWorld(true);
      // Bake the world transform into the geometry and reset transforms to identity. The
      // hair GLB is authored in centimetres (its root carries a ~0.01 scale); the body is in
      // metres. Without this the conform adds metre-scale skin displacements to cm-scale hair
      // positions — 100× too small — and the nearest-skin search compares cm against m, which
      // is a garbage mapping, so the hair never actually follows the head.
      const baked = new Set();
      rootA.traverse((x) => {
        if (x.isSkinnedMesh) {
          // A skinned card set is positioned by its bindMatrix, not by its node transform.
          if (!isIdentityMatrix(x.bindMatrix)) {
            console.warn(`[gcc] hair "${id}": skinned mesh "${x.name}" has a non-identity bind matrix; ` +
              'its conform is computed in bind space and will be offset. Re-export the style with an identity bind.');
          }
          return;
        }
        if (x.isMesh && x.geometry && !baked.has(x.geometry)) {
          x.geometry.applyMatrix4(x.matrixWorld);
          baked.add(x.geometry);
        }
      });
      rootA.position.set(0, 0, 0); rootA.scale.set(1, 1, 1); rootA.quaternion.identity();
      rootA.traverse((x) => { if (x.isMesh || x.isSkinnedMesh) { x.position.set(0, 0, 0); x.scale.set(1, 1, 1); x.quaternion.identity(); } });
      rootA.updateMatrixWorld(true);

      const meshes = [];
      rootA.traverse((x) => { if ((x.isMesh || x.isSkinnedMesh) && !/^UCX_/i.test(x.name || '')) meshes.push(x); });

      // dpos = the OTHER end's bake minus this one, per vertex. That difference IS the hair's
      // share of the body slider; measuring it against anything else folds a runtime fit into
      // it and drags the hair off the head.
      const deltas = new Map();
      if (gb) {
        const other = [];
        gb.scene.updateMatrixWorld(true);
        gb.scene.traverse((x) => {
          if (!(x.isMesh || x.isSkinnedMesh) || /^UCX_/i.test(x.name || '')) return;
          if (!x.isSkinnedMesh && x.geometry) x.geometry.applyMatrix4(x.matrixWorld);
          other.push(x);
        });
        const unpaired = [];
        const taken = new Set();
        meshes.forEach((m, i) => {
          const want = m.geometry.attributes.position.count;
          const pick = other.find((b) => !taken.has(b) && b.name === m.name && b.geometry.attributes.position.count === want)
            || other.find((b) => !taken.has(b) && b.geometry.attributes.position.count === want)
            || ((other[i] && !taken.has(other[i]) && other[i].geometry.attributes.position.count === want) ? other[i] : null);
          if (!pick) { unpaired.push(m.name || '#' + i); return; }
          taken.add(pick);
          const a = m.geometry.attributes.position.array, b = pick.geometry.attributes.position.array;
          const d = new Float32Array(a.length);
          for (let k = 0; k < d.length; k++) d[k] = b[k] - a[k];
          deltas.set(m, d);
        });
        if (unpaired.length) {
          console.warn(`[gcc] hair "${id}": ${unpaired.length} card mesh(es) have no counterpart in the ` +
            `other end's bake and hold their own shape across the body slider — ${unpaired.join(', ')}`);
        }
        gb.scene.traverse((x) => { if (x.geometry) x.geometry.dispose(); });
      }

      // Bind the cards ONCE, against the anchor rest — shared by every character wearing
      // this style. The binding is topological; only the displacements are per character.
      const binding = this._headRest ? buildHairBinding(meshes, this._headRest, this._scalpVerts) : null;

      // shader params + atlas, per style, shared
      // The style's authored params and its strand-coverage ATLAS both come from the style
      // folder's mh_materials.json, and the module that renders hair already knows how to
      // read them. Guessing the path here (and only when a manifest happened to declare
      // `params`) meant no atlas was ever bound — the cards drew as flat untextured slabs.
      const styleDir = entry.a.replace(/[^/]*$/, '');
      const styleUrl = joinUrl(this._base, styleDir).replace(/\/$/, '');
      let params = {}, textures = {};
      try { ({ params, textures } = await loadHairParams(styleUrl)); }
      catch (e) { console.warn('[gcc] hair "' + id + '": no mh_materials.json — no strand atlas, so it will render as flat cards.'); }
      const loadData = (rel) => {
        if (!rel) return null;
        const tex = new THREE.TextureLoader().load(joinUrl(this._base, joinUrl(styleDir, rel)));
        tex.flipY = false;                                     // glTF UV convention
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.NoColorSpace;                   // the atlas is DATA, not colour
        return tex;
      };
      const atlas = loadHairAtlas(THREE, styleUrl, { params, textures });
      const tangent = loadData(entry.tangent || textures.tangent);
      let scalp = null;
      if (entry.scalp && entry.scalp.mask) {
        const mask = new THREE.TextureLoader().load(joinUrl(this._base, joinUrl(styleDir, entry.scalp.mask)));
        mask.flipY = false;
        mask.colorSpace = THREE.NoColorSpace;
        scalp = { mask, darken: typeof entry.scalp.darken === 'number' ? entry.scalp.darken : 0.55 };
      }

      const opts = {
        atlas, tangent,
        alphaChannel: params.alpha_channel || HAIR_DEFAULTS.alphaChannel,
        density: typeof params.hair_density === 'number' ? params.hair_density : HAIR_DEFAULTS.density,
        // The INNER core's clip, against raw coverage. `cut_threshold` is its older name.
        innerThreshold: typeof params.inner_alpha_threshold === 'number' ? params.inner_alpha_threshold
                      : typeof params.cut_threshold === 'number' ? params.cut_threshold
                      : HAIR_DEFAULTS.innerThreshold,
        roughness: typeof params.roughness === 'number' ? params.roughness : HAIR_DEFAULTS.roughness,
        roughnessFloor: typeof params.hair_roughness_floor === 'number' ? params.hair_roughness_floor : HAIR_DEFAULTS.roughnessFloor,
        roughnessSeedAmp: typeof params.hair_roughness_seed_amp === 'number' ? params.hair_roughness_seed_amp : HAIR_DEFAULTS.roughnessSeedAmp,
        rootDarkening: typeof params.root_darkening === 'number' ? params.root_darkening : HAIR_DEFAULTS.rootDarkening,
        seedVariation: typeof params.seed_variation === 'number' ? params.seed_variation : HAIR_DEFAULTS.seedVariation,
        // The style's own root mode/colour. A colour swatch (setHairColor) overrides these.
        rootMode: params.root_mode || HAIR_DEFAULTS.rootMode,
        rootColor: params.root_color || HAIR_DEFAULTS.rootColor,
        rootStrength: typeof params.root_strength === 'number' ? params.root_strength : HAIR_DEFAULTS.rootStrength,
      };
      return { id, root: rootA, meshes, deltas, binding, opts, scalp, defaultColor: params.base_color || HAIR_DEFAULTS.color };
    })();
    this._hairCache.set(id, p);
    return p;
  }

  // ── internal: shared outfit data, loaded once per outfit ──
  async _outfit(id) {
    if (this._outfitCache.has(id)) return this._outfitCache.get(id);
    const entry = (this._manifest.outfits || {})[id];
    if (!entry) throw new Error(`[gcc] unknown outfit id "${id}". This project ships: ${this.outfitIds.join(', ') || '(none)'}`);
    const p = (async () => {
      // The wear blob is ALREADY skinned and ALREADY fitted — the factory baked it at
      // outfit-save time. Wearing does not fit, wrap or tuck anything.
      const [ga, gb] = await Promise.all([
        this._loader.loadAsync(joinUrl(this._base, entry.a)),
        entry.b ? this._loader.loadAsync(joinUrl(this._base, entry.b)) : Promise.resolve(null),
      ]);
      const A = [];
      ga.scene.traverse((x) => { if (x.isMesh || x.isSkinnedMesh) A.push(x); });
      // NO COPY OF THE FIRST FIT. The A-fit already lives in the geometry, and the second fit
      // is carried as a DELTA that becomes a morph target the first time this outfit is worn
      // (see setOutfit). Nothing here is per character.
      const pieces = A.map((m) => ({ src: m, dpos: null, dnrm: null }));
      if (gb) {
        const B = [];
        gb.scene.traverse((x) => { if (x.isMesh || x.isSkinnedMesh) B.push(x); });
        // A clean full pairing wins outright; only if none pairs completely is the best
        // partial one used.
        let pairs = pairOutfitBakes(A, B, true) || pairOutfitBakes(A, B, false);
        if (pairs) {
          if (pairs.chiralMiss) {
            console.warn(`[gcc] outfit "${id}": the two bases fitted a mirrored pair (shoes) on OPPOSITE ` +
              'feet — they will mirror across the body slider. Only a re-save from the Clothing Factory ' +
              '(Flip L↔R on one base) can fix the data.');
          }
          for (const pr of pairs) {
            const e = pieces.find((x) => x.src === pr.src);
            if (!e) continue;
            const ap = pr.src.geometry.attributes.position.array;
            const ob = pr.other.geometry.attributes.position.array;
            e.dpos = new Float32Array(ap.length);
            for (let i = 0; i < e.dpos.length; i++) e.dpos[i] = ob[i] - ap[i];
            const an = pr.src.geometry.attributes.normal, on = pr.other.geometry.attributes.normal;
            if (an && on) {
              e.dnrm = new Float32Array(an.array.length);
              for (let i = 0; i < e.dnrm.length; i++) e.dnrm[i] = on.array[i] - an.array[i];
            }
            // THE FACE SET IS PER END, NOT JUST THE POSITIONS. The factory drops a garment's
            // hidden faces when it bakes each end's blob (a tucked shirt loses its tucked
            // half), so the two files disagree about which triangles EXIST. A morph can only
            // move vertices, so the shape blended while the cut stayed frozen at end A — the
            // other end's shirt wearing this end's tuck line. Same vertex count (that is how
            // the pieces paired), so B's index is valid here: keep it and swap with the slider.
            const ia = pr.src.geometry.getIndex(), ib = pr.other.geometry.getIndex();
            if (ia && ib && (ia.count !== ib.count || !ia.array.every((v, i) => v === ib.array[i]))) {
              e.idxB = Uint32Array.from(ib.array);
            }
          }
        } else {
          console.info(`[gcc] outfit "${id}" has no usable second fit — it holds one shape across the slider.`);
        }
        gb.scene.traverse((x) => { if (x.geometry) x.geometry.dispose(); });
      }
      // Body-hide lists: which BODY vertices this outfit covers.
      // TODO(spec): the site stores these in the outfit's saved snapshot, keyed by body mesh
      // name; no SDK-side file is specified. Read here as { "<meshName>": [vertexIndex, …] }
      // if the manifest points at one — otherwise nothing is hidden and the body may poke
      // through a tight garment.
      // The mask ships WITH the outfit: <stem>.exact.bin next to <stem>.glb. Derive the
      // path from the GLB so a project never has to declare it.
      //
      // ONE MASK PER END, LIKE THE GEOMETRY (owner, 2026-08-17). A garment is fitted twice —
      // once per anchor — and the two fits cover DIFFERENT skin: a feminine chest and a
      // masculine one are not hidden by the same vertices. Reading only `entry.a`'s mask meant
      // the body was cut for one end at every point on the slider, so skin poked through at
      // the other. Both are read here; `_applyBodyHide` picks per character. An outfit fitted
      // at one end only keeps that end's mask across the whole slider — a mask that exists is
      // always better than no mask.
      const readHide = async (glbPath) => {
        if (!glbPath) return null;
        try {
          const r = await fetch(joinUrl(this._base, String(glbPath).replace(/\.glb$/i, '.exact.bin')));
          if (!r.ok) return null;
          const rec = deserializeCharacter(await r.arrayBuffer());
          const list = (rec && rec.manifest && rec.manifest.bodyHidden) || rec.bodyHidden || [];
          const out = {};
          for (const e of list) {
            const verts = idxList(e && e.hidden);
            if (verts && verts.length) out[e.name] = verts;
          }
          return Object.keys(out).length ? out : null;
        } catch (e) { console.warn('[gcc] outfit "' + id + '" body-hide unreadable:', e && e.message); return null; }
      };
      let [hideA, hideB] = await Promise.all([readHide(entry.a), readHide(entry.b)]);
      if (!hideA && !hideB && entry.hide) {
        try { hideA = await getJSON(joinUrl(this._base, entry.hide)); } catch (_) { /* optional override */ }
      }
      if (hideA && !hideB) hideB = hideA;   // fitted at one end only → that mask holds everywhere
      if (hideB && !hideA) hideA = hideB;
      // the anchor slugs, so a mask made at the other end can be matched to THIS base's mesh
      // names (`GEO-body_mars` ↔ `GEO-body_venus`) — see normMeshName
      return { id, root: ga.scene, pieces, hideA, hideB, bases: entry.bases || [], _indexVariants: new Map() };
    })();
    this._outfitCache.set(id, p);
    return p;
  }

  dispose() {
    for (const ch of Array.from(this._characters)) ch.dispose();
    this._characters.clear();
    const seen = new Set();
    this._template.traverse((x) => {
      if (x.geometry && !seen.has(x.geometry)) { seen.add(x.geometry); x.geometry.dispose(); }
      const mats = Array.isArray(x.material) ? x.material : (x.material ? [x.material] : []);
      for (const m of mats) m.dispose?.();
    });
  }
}

// ── Character ────────────────────────────────────────────────────────────────

class Character {
  constructor(creator, recipe) {
    const THREE = creator._THREE;
    this._c = creator;
    this._THREE = THREE;

    // Clone the rig. `Object3D.clone(true)` SHARES geometry and material by reference and
    // slices morphTargetInfluences per clone — which is exactly the split we want. What it
    // does NOT do is rebuild the skeleton: SkinnedMesh.copy keeps the SOURCE skeleton, so
    // without the pass below every character would drive the same bones and the whole crowd
    // would move as one.
    const root = creator._template.clone(true);
    const dstNodes = [];
    root.traverse((x) => dstNodes.push(x));
    const srcNodes = creator._templateNodes;
    const nodeMap = new Map();
    for (let i = 0; i < srcNodes.length; i++) nodeMap.set(srcNodes[i], dstNodes[i]);

    // One cloned Skeleton per SOURCE skeleton, over the cloned bones. Keeping the partition
    // matters: each glTF skin is its own Skeleton object, and the rebind/ride rule below
    // depends on that being true.
    const skelMap = new Map();
    for (let i = 0; i < srcNodes.length; i++) {
      const s = srcNodes[i];
      if (!s.isSkinnedMesh || !s.skeleton) continue;
      let sk = skelMap.get(s.skeleton);
      if (!sk) {
        const bones = s.skeleton.bones.map((b) => nodeMap.get(b));
        if (bones.some((b) => !b)) throw new Error('[gcc] a skeleton bone is not in the cloned hierarchy — the base GLB has a skin whose joints live outside the scene.');
        sk = new THREE.Skeleton(bones, s.skeleton.boneInverses.map((m) => m.clone()));
        skelMap.set(s.skeleton, sk);
      }
      dstNodes[i].bind(sk, s.bindMatrix.clone());
    }

    // Per-character materials (tone, detail mix, scalp tint) over SHARED textures.
    this._materials = new Map();
    this._id = 'c' + (Character._seq = (Character._seq || 0) + 1);
    for (let i = 0; i < srcNodes.length; i++) {
      const s = srcNodes[i];
      if (!(s.isMesh || s.isSkinnedMesh) || Array.isArray(s.material) || !s.material) continue;
      dstNodes[i].material = makeSkinMaterial(THREE, s.material, creator._detailByMesh.get(s), null);
      // Carry the morph NAME table across. three.js only builds morphTargetDictionary while
      // parsing the glTF, so a cloned mesh has none — and without it the ARKit expressions
      // (jawOpen, the blinks, the visemes) are unaddressable by name even though the targets
      // are right there on the shared geometry.
      if (s.morphTargetDictionary) dstNodes[i].morphTargetDictionary = s.morphTargetDictionary;
      // Keep a handle by mesh NAME: the character-blend texture pass writes this
      // character's blended skin here, and writing to the shared template material
      // instead would repaint every character in the crowd.
      if (dstNodes[i].name) this._materials.set(dstNodes[i].name, dstNodes[i].material);
    }

    this.object3D = root;
    this._nodes = dstNodes;
    this._nodesByName = new Map();
    for (const n of dstNodes) if (n.name && !this._nodesByName.has(n.name)) this._nodesByName.set(n.name, n);
    this._skeletons = Array.from(skelMap.values());

    // Which meshes carry a spectrum delta, and which merely ride the skeleton.
    this._spectrumTargets = creator._spectrum.entries.map((e) => ({
      mesh: dstNodes[creator._srcIndex.get(e.mesh)],
      morphIndex: e.morphIndex,
      kind: e.kind || 'all',
    })).filter((e) => e.mesh);
    const blended = new Set(this._spectrumTargets.map((e) => e.mesh));
    // REBIND vs RIDE — getting this backwards is visible and has shipped before.
    //   REBIND (_rebindInRootSpace + update): a mesh WITH a delta. Its bind geometry now IS
    //     the blended shape, so inverse(the blended rest, in CHARACTER space) is the right
    //     bind inverse and the skinned result at rest equals the blended positions exactly.
    //   RIDE (update only, keep the ORIGINAL inverses): a mesh with NO delta — the overlays
    //     that exist on one anchor's rig only. Recomputing THEIR inverses pins them to their
    //     own unblended bind geometry, so they sit perfectly still while the body moves: that
    //     is "lashes floating in mid air", 15 cm below a head that walked off without them.
    //     Keeping the original inverses lets the bone delta carry them — own shape, blended
    //     skeleton, which is the best a mesh with no counterpart can do.
    // KEY OFF "HAS NO DELTA BLOCK", NEVER OFF A MESH-NAME LIST: which meshes are one-sided
    // depends on which anchor the project exported as the base, so a hard-coded name list is
    // right in one direction and wrong in the other.
    this._rebind = new Set();
    this._ride = new Set();
    for (const n of dstNodes) {
      if (!n.isSkinnedMesh || !n.skeleton) continue;
      (blended.has(n) ? this._rebind : this._ride).add(n.skeleton);
    }
    // Precedence: a skeleton shared by both kinds is REBOUND. A blended mesh has to land
    // exactly; an unblended one only has to follow.
    for (const sk of this._rebind) this._ride.delete(sk);

    // The lerped rest, kept so a later setBody knows which nodes were merely resting and
    // which the game had genuinely posed.
    this._restNow = new Map();
    for (const rn of creator._restNodes) {
      const key = THREE.PropertyBinding ? THREE.PropertyBinding.sanitizeNodeName(rn.name) : rn.name;
      const node = this._nodesByName.get(key);
      const A = creator._restA.get(key);
      if (node && A) {
        this._restNow.set(key, { node, A, B: rn, t: A.t.clone(), r: A.r.clone(), s: A.s.clone() });
        this._stampRest(node);
      }
    }

    this._body = 0;
    // The head runs on its own axis and FOLLOWS the body until something says otherwise,
    // so a game that never touches it behaves exactly as before. null means "follow".
    this._head = null;
    this._detail = 0;
    this._skinTone = null;
    this._face = new Map();
    this._hair = null;
    this._hairColor = null;
    this._outfit = null;
    this._disposed = false;
    this._pending = [];

    // Apply the recipe. Body first: hair and outfit both land on whatever `t` the body is at.
    if (typeof recipe.body === 'number') this.setBody(recipe.body);
    // AFTER the body, because setBody carries a following head with it.
    if (typeof recipe.head === 'number') this.setHead(recipe.head);
    if (recipe.face) for (const [k, v] of Object.entries(recipe.face)) this.setFace(k, v);
    if (recipe.blend) this.setBlend(recipe.blend);
    if (recipe.eyes) this.setEyeColor(recipe.eyes);
    if (recipe.skin && typeof recipe.skin.detail === 'number') this.setDetail(recipe.skin.detail);
    if (recipe.skin && recipe.skin.tone) this.setSkinTone(recipe.skin.tone);
    // `spawn()` is synchronous, so an asset that fails to load has nobody holding its promise.
    // Log it loudly and let `ready` still resolve: a bad hair id must not take the whole
    // character down, and an unhandled rejection in the game's console is not a diagnosis.
    const quiet = (p) => p.catch((e) => { console.error('[gcc]', (e && e.message) || e); return null; });
    const hairId = typeof recipe.hair === 'string' ? recipe.hair : (recipe.hair && recipe.hair.id);
    if (hairId) this._pending.push(quiet(this.setHair(hairId, recipe.hair && recipe.hair.color)));
    const outfitId = typeof recipe.outfit === 'string' ? recipe.outfit : (recipe.outfit && recipe.outfit.id);
    if (outfitId) this._pending.push(quiet(this.setOutfit(outfitId)));
  }

  /** Resolves once every asset this character asked for is mounted. */
  get ready() { return Promise.all(this._pending).then(() => this); }

  /** The clone of a template node. */
  _mine(srcNode) { const i = this._c._srcIndex.get(srcNode); return i === undefined ? null : this._nodes[i]; }

  /**
   * Re-point a garment's or a hair style's skinned mesh at THIS character's skeleton, so it
   * follows this character's poses and this character's blended rest. ONE function for both:
   * hair and outfits are the same job, and two copies of it is how they drift apart.
   *
   * Weights come from the asset — the factory's hand paint — and nothing is re-derived. But
   * the JOINT INDICES do not survive: they address the asset's own bone order, which is not
   * this rig's. They are remapped BY BONE NAME, once per asset (the remapped attribute is
   * cached on the shared source geometry, so the crowd pays for it once).
   *
   * Everything binds against `_skeletons[0]` and the name map is built from THAT skeleton
   * only — mixing bone orders from several skins would produce indices that address the wrong
   * joints on the skeleton they end up bound to.
   */
  // The skeleton that owns the hips — i.e. the body rig, not the mouth sub-rig. Falls back
  // to the one with the most bones, then to the first.
  _bodySkeleton() {
    if (this._bodySkelCache !== undefined) return this._bodySkelCache;
    const sk = this._skeletons || [];
    const norm = (n) => String(n).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    let pick = sk.find((s) => s.bones.some((b) => norm(b.name) === 'hips'));
    if (!pick) pick = sk.slice().sort((a, b) => b.bones.length - a.bones.length)[0];
    this._bodySkelCache = pick || null;
    return this._bodySkelCache;
  }

  // The skeleton that owns the hips — the body rig. Falls back to the largest, then the first.
  _bodySkeleton() {
    if (this._bodySkelCache !== undefined) return this._bodySkelCache;
    const sk = this._skeletons || [];
    const norm = (n) => String(n).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    let pick = sk.find((s) => s.bones.some((b) => norm(b.name) === 'hips'));
    if (!pick) pick = sk.slice().sort((a, b) => b.bones.length - a.bones.length)[0];
    this._bodySkelCache = pick || null;
    return this._bodySkelCache;
  }

  /**
   * Give an unskinned garment the BODY's weights, so it can never spawn rigid.
   *
   * An outfit saved before the factory's exporter shipped the skeleton is a static shell — and
   * there are real ones on disk. Parenting that to the character is the "outfit lost its
   * skinning" bug: it does not follow a single bone. The factory refuses to save one now, but
   * the SDK still has to load the ones that already exist, and the answer is the same backward
   * closest-point transfer the factory itself uses: each garment vertex takes the joints of the
   * nearest BODY vertex. Weights come from the body's own paint; nothing is invented.
   *
   * Written onto the SHARED geometry and cached there, so a crowd in the same outfit pays once.
   * Both sides are in the same bind space, which is what makes nearest-vertex meaningful.
   */
  _skinFromBody(geom, label) {
    if (geom.getAttribute('skinIndex')) return true;
    if (geom.userData.__gccBodySkin) return !!geom.getAttribute('skinIndex');
    geom.userData.__gccBodySkin = true;          // one attempt per geometry, success or not
    const THREE = this._THREE;
    const skel = this._bodySkeleton();
    let body = null;
    for (const n of this._c._templateNodes) {
      if (!n.isSkinnedMesh || !n.geometry || !n.geometry.getAttribute('skinIndex')) continue;
      if (!body || n.geometry.attributes.position.count > body.geometry.attributes.position.count) body = n;
    }
    if (!skel || !body) {
      console.warn(`[gcc] ${label}: no skinned body to take weights from — it will not follow the rig.`);
      return false;
    }
    // The body's indices address ITS skeleton; remap by bone NAME into the one we bind to.
    const bIdx = new Map();
    skel.bones.forEach((b, i) => { if (!bIdx.has(b.name)) bIdx.set(b.name, i); });
    const bBones = (body.skeleton && body.skeleton.bones) || skel.bones;
    const remap = bBones.map((b) => (bIdx.has(b.name) ? bIdx.get(b.name) : 0));

    const bp = body.geometry.attributes.position;
    const bsi = body.geometry.attributes.skinIndex, bsw = body.geometry.attributes.skinWeight;
    // A uniform grid keeps this linear instead of 13k x 9k — one pass, once per outfit.
    const cell = 0.03;
    const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    const grid = new Map();
    for (let i = 0; i < bp.count; i++) {
      const k = key(bp.getX(i), bp.getY(i), bp.getZ(i));
      let a = grid.get(k); if (!a) grid.set(k, a = []);
      a.push(i);
    }
    const gp = geom.attributes.position;
    const si = new Uint16Array(gp.count * 4), sw = new Float32Array(gp.count * 4);
    for (let v = 0; v < gp.count; v++) {
      const x = gp.getX(v), y = gp.getY(v), z = gp.getZ(v);
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let best = -1, bd = Infinity;
      for (let r = 1; r <= 6 && best < 0; r++) {            // widen until something is found
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
          if (r > 1 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;   // shell only
          const a = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!a) continue;
          for (const i of a) {
            const d = (bp.getX(i) - x) ** 2 + (bp.getY(i) - y) ** 2 + (bp.getZ(i) - z) ** 2;
            if (d < bd) { bd = d; best = i; }
          }
        }
      }
      if (best < 0) { si[v * 4] = 0; sw[v * 4] = 1; continue; }
      for (let c = 0; c < 4; c++) {
        si[v * 4 + c] = remap[bsi.getComponent(best, c)] || 0;
        sw[v * 4 + c] = bsw.getComponent(best, c);
      }
    }
    geom.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geom.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    console.warn(`[gcc] ${label}: the asset carries no skinning, so weights were transferred from the body. ` +
      'Re-save this outfit in the Clothing Factory to ship it skinned.');
    return true;
  }

  _bindSkinned(mesh, src, label) {
    const THREE = this._THREE;
    // THE BODY RIG, not "the first skeleton". A character carries more than one: the body's
    // 73-bone rig AND an 11-bone mouth sub-rig the teeth are on. `_skeletons[0]` is whichever
    // happened to be built first, and when that was the mouth rig the outfit bound to eleven
    // jaw bones — so it inherited the root and nothing else, and stood still while the body
    // walked. animationRig.md warns about precisely this ("never from one mesh's .skeleton").
    // The body rig is the one that owns the hips.
    const target = this._bodySkeleton();
    if (!target) { console.warn(`[gcc] ${label}: this base has no skeleton to bind to.`); return; }
    if (!this._boneIndex) {
      this._boneIndex = new Map();
      target.bones.forEach((b, i) => { if (!this._boneIndex.has(b.name)) this._boneIndex.set(b.name, i); });
    }
    const sg = src.geometry;
    if (!sg.userData.__gccRemapped && src.skeleton) {
      const si = sg.getAttribute('skinIndex');
      if (si) {
        const remapped = si.array.slice();
        let missing = 0;
        for (let i = 0; i < remapped.length; i++) {
          const bone = src.skeleton.bones[remapped[i]];
          const to = bone ? this._boneIndex.get(bone.name) : undefined;
          if (to === undefined) { missing++; remapped[i] = 0; } else remapped[i] = to;
        }
        if (missing) console.warn(`[gcc] ${label}: ${missing} skin indices name a joint this base does not have — pinned to the root.`);
        sg.setAttribute('skinIndex', new THREE.BufferAttribute(remapped, si.itemSize));
      }
      sg.userData.__gccRemapped = true;
    }
    const si = sg.getAttribute('skinIndex');
    if (si) mesh.geometry.setAttribute('skinIndex', si);
    // Keep the asset's own bind matrix (identity for anything authored under the scene root).
    // The character's skeleton already carries the inverses of the BLENDED rest, and the
    // asset's positions are lerped to the same t, so the two land together. Both sides are in
    // CHARACTER space — the asset's bind matrix comes from a GLB loaded at identity, and
    // `_rebindInRootSpace` keeps the body's inverses in that same space. Bind the body in
    // world space and hair and outfits inherit the same placement break.
    mesh.updateMatrixWorld(true);
    mesh.bind(target, src.bindMatrix ? src.bindMatrix.clone() : new THREE.Matrix4());
  }

  // ── the body spectrum: ONE morph weight, plus the rest pose ──
  /**
   * CHARACTER BLENDING — mix the project's saved characters into this face.
   * `weights` is { presetId: 0..1 }. Anything omitted goes to zero, so passing {} is the
   * bare base rather than "keep what was there": a blend is a complete statement of the
   * mix, exactly as the editor's panel is.
   *
   * All-zero is the BASE, never the first source — falling back to a source is a bug the
   * editor already had once (blend-core BLEND_FRAG carries the same note).
   */
  setBlend(weights) {
    // ONE ARGUMENT, AND IT IS AN OBJECT. `setBlend('Tesh', 1)` reads as plausible and is
    // silently a no-op: the string lands in `weights`, every w[id] is undefined, every
    // effective weight is 0, and the face never changes while the log still says the preset
    // loaded. An integrator lost an afternoon to exactly that. Say so instead.
    if (typeof weights === 'string') {
      console.warn(`[gcc] setBlend("${weights}", …) — setBlend takes ONE argument, a map of ` +
        `weights. Use setBlend({ "${weights}": 1 }). Passing a string sets every weight to 0, ` +
        'so the face does not move.');
      weights = { [weights]: arguments.length > 1 && Number(arguments[1]) ? Number(arguments[1]) : 1 };
    } else if (weights != null && typeof weights !== 'object') {
      console.warn('[gcc] setBlend expects a map like { Ember: 0.6, Tesh: 0.4 } — got ' + typeof weights);
      weights = {};
    }
    const w = weights || {};
    this._blend = { ...w };
    // A source that is weighted but not loaded yet is fetched now, and this same blend is
    // re-applied when it lands. `creator.preload({ presets })` avoids the pop-in; the token
    // makes the last blend win, exactly as setHair/setOutfit do.
    const pending = [];
    for (const id of Object.keys(w)) {
      if ((Number(w[id]) || 0) > 0 && !this._c._presets.routes.has(id) &&
          this._c._presetPlans && this._c._presetPlans.has(id)) pending.push(this._c._ensurePreset(id));
    }
    if (pending.length) {
      const seq = this._blendSeq = (this._blendSeq || 0) + 1;
      Promise.all(pending).then(() => {
        if (!this._disposed && seq === this._blendSeq) this.setBlend(this._blend);
      });
    }
    // NORMALISED BY DEFAULT, as the editor is: the weights are shares of one face, so two
    // sources at 1 each mean "half and half", not "both deltas stacked" — stacking pushes the
    // face past either parent and reads as a deformity. GEOMETRY may deliberately overshoot
    // with setNormalise(false); TEXTURES always normalise (the pass divides by the weight
    // sum), because an un-normalised texture average blows out to white.
    // Normalisation is a FLOAT, not a switch. 1 = the weights are shares of one face, so
    // two sources at 1 mean half and half. Above 1 pushes the mix PAST the parents — 1.5
    // still reads as a real face, which is why this is a dial and not a checkbox. Below 1
    // pulls back toward the base. Set 0 to stop normalising and let deltas stack raw.
    const k = this._normalise == null ? 1 : Number(this._normalise);
    const eff = {};
    let sum = 0;
    for (const id of this._c._presets.names) sum += Math.max(0, Number(w[id]) || 0);
    const scale = (k > 0 && sum > 1e-5) ? k / sum : 1;
    for (const id of this._c._presets.names) eff[id] = Math.max(0, Number(w[id]) || 0) * scale;
    this._blendEff = eff;
    // The head follows the blend unless the game has pinned it — see _blendHead.
    this._writeSpectrum();
    for (const [id, routes] of this._c._presets.routes) {
      const v = Math.max(0, Math.min(4, Number(this._blendEff[id]) || 0));
      for (const r of routes) {
        // `r.mesh` is the TEMPLATE mesh the morph was appended to. Writing its influences
        // moves nothing on screen and silently repaints nobody — every spawned character
        // has its OWN influence array. _mine() maps template → this instance, exactly as
        // setFace does. This is why "blending characters does absolutely nothing".
        const mesh = this._mine(r.mesh);
        if (mesh && mesh.morphTargetInfluences) mesh.morphTargetInfluences[r.morphIndex] = v;
      }
    }
    this._applyBlendTextures();
    // The blended face changes the skull, so the hair has to be re-seated on it — the same
    // reason setFace conforms. The seated bakes move too: the head may have just changed
    // which anchor it stands at.
    this._applyHairBody();
    this._conformHair();
    return this;
  }
  get blend() { return { ...(this._blend || {}) }; }
  /**
   * How strongly the mix is normalised. DEFAULT 1 — the weights are shares of one face, so
   * two sources at 1 give half and half. Push it ABOVE 1 to drive the mix past the parents:
   * 1.5 still lands on a believable face, which is why this is a dial rather than an on/off.
   * 0 stops normalising entirely and lets the deltas stack raw.
   */
  setNormalise(k) { this._normalise = Math.max(0, Number(k)); return this.setBlend(this._blend || {}); }
  get normalise() { return this._normalise == null ? 1 : this._normalise; }

  // Composite the sources' baked atlases into this character's own skin. Per character,
  // because the mix is per character — this is the one part of a blend that cannot be a
  // shared morph weight.
  _applyBlendTextures() {
    const c = this._c;
    const P = c._presets;
    if (!P || !P.atlases || !P.atlases.size || !c._blendTex) return;
    // Never composite before the atlases have decoded — that is what bakes black.
    c._atlasReady.then(() => this._compositeBlend());
    return this;
  }

  _compositeBlend() {
    const c = this._c;
    const P = c._presets;
    if (!P || !c._blendTex || this._disposed) return;
    const w = this._blend || {};
    const eff = this._blendEff || w;
    const active = P.names.filter((id) => (eff[id] || 0) > 0 && P.atlases.has(id));
    // Every mesh any source carries an atlas for — head, body, eyes, teeth. Driving this off
    // the SOURCES rather than off a snapshot taken at spawn is why the face blends and not
    // just the body: the head's material is rebuilt after spawn and a stored handle goes stale.
    const meshNames = new Set();
    for (const [, byMesh] of P.atlases) for (const n of byMesh.keys()) meshNames.add(n);

    for (const meshName of meshNames) {
      // An explicitly chosen eye colour OUTRANKS the blend source's baked eye pixels.
      // The preset atlas lands async after spawn, so without this it stomped the
      // setEyeColor texture back to the source's iris ("supposed to have blue eyes").
      if (this._eyeColor && /^eye[LR]$/i.test(meshName)) continue;
      const mesh = this._nodesByName && this._nodesByName.get(meshName);
      if (!mesh) continue;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!mat) continue;
      // The mesh's OWN map is the bare base skin — what all-weights-zero must show.
      if (!this._blendBase) this._blendBase = new Map();
      if (!this._blendBase.has(meshName) && mat.map) this._blendBase.set(meshName, mat.map);
      const base = this._blendBase.get(meshName) || null;

      if (!active.length) {
        if (base && mat.map !== base) { mat.map = base; mat.needsUpdate = true; }
        continue;
      }
      const srcs = [], ws = [];
      for (const id of active.slice(0, 6)) {
        const t = c._atlasTex.get(id + '|' + meshName);
        if (t && t.image) { srcs.push(t); ws.push(eff[id]); }
      }
      if (!srcs.length) continue;
      const size = (srcs[0].image && srcs[0].image.width) || (base && base.image && base.image.width) || 2048;
      const out = c._blendTex.run(this._id + '|' + meshName, base, srcs, ws, size);
      // The blended atlas is a BASE MAP, so it goes in the base map slot of the mesh's OWN
      // material. Never a clone: the editor learned that a clone renders while everything
      // else keeps writing to the original.
      mat.map = out;
      mat.needsUpdate = true;
    }
  }



  /**
   * The feminine↔masculine slider. `setBody(t, { rebase: true })` additionally FORGETS
   * the current pose: nothing an animator wrote survives, every joint stands up at the
   * new rest — `toRest()` folded into the same pass. Use it when the game pauses its
   * animator to change the body and wants a clean rig back.
   */
  setBody(t, opts) {
    t = Math.max(0, Math.min(1, Number(t) || 0));
    this._body = t;
    this._writeSpectrum();
    this._blendRestPose(t, !!(opts && opts.rebase));
    this._applyHairBody();
    this._applyOutfitBody();
    this._refreshBodyHide();   // the hide mask rides the slider too — see _hideSide
    this._conformHair();
    return this;
  }
  get body() { return this._body; }

  /**
   * THE HEAD'S OWN POINT ON THE FEMININE-MASCULINE AXIS, independent of the body.
   *
   * A saved character is the base plus an offset, so its face rides whatever head the base
   * is wearing: without this, dragging the body toward masculine grew masculine features on
   * a character saved as feminine. The head's travel between the anchors is 14.7 cm, but
   * 14.0 cm of that is only the skeleton being a different size -- that part stays on
   * `setBody`, so the head never leaves the neck -- and the 1.3 cm that is genuinely a
   * different head shape is what this moves.
   *
   * Pass null to put it back on the body, which is where it starts.
   */
  setHead(h) {
    this._head = h == null ? null : Math.max(0, Math.min(1, Number(h) || 0));
    this._writeSpectrum();
    this._applyHairBody();     // the seated bakes belong to the head, so they move with it
    this._conformHair();
    return this;
  }
  /** Where the head actually sits: pinned, else the blend's own anchor, else the body. */
  get head() {
    if (this._head != null) return this._head;
    const auto = this._blendHead();
    return auto == null ? this._body : auto;
  }
  /** True while the head is deciding for itself rather than being pinned by the game. */
  get headIsAuto() { return this._head == null; }

  /**
   * WHERE A BLENDED CHARACTER'S HEAD BELONGS: at the anchor it was saved on.
   *
   * A recipe is an offset on top of whatever head the base is wearing, so a character saved
   * as feminine only IS that character while the head underneath is the feminine head. Left
   * to follow the body it grew masculine features the moment the player touched the body
   * slider — the owner's report, 2026-09-04. So an unset head follows the BLEND when there
   * is one, and the body only when there is not, which is exactly the old behaviour for a
   * character that blends nothing.
   *
   * Weighted by the same normalised weights the geometry uses, so a mix of a feminine and a
   * masculine source lands between them rather than snapping to one.
   */
  _blendHead() {
    const P = this._c && this._c._presets;
    const eff = this._blendEff;
    if (!P || !P.heads || !eff) return null;
    let sum = 0, w = 0;
    for (const id of Object.keys(eff)) {
      const k = eff[id];
      if (!(k > 0)) continue;
      // Its HEAD, which is not necessarily its build — that is the whole point of the axis.
      const t = P.heads.has(id) ? P.heads.get(id) : P.builds.get(id);
      if (typeof t !== 'number') continue;
      sum += t * k; w += k;
    }
    return w > 0 ? sum / w : null;
  }

  // One writer for both axes. `rigid` + `shape` sum to the old single delta, so a head that
  // is following the body writes the same number to both and the result is bit-identical to
  // the single-target blend this replaced.
  _writeSpectrum() {
    const b = this._body;
    const auto = this._head == null ? this._blendHead() : null;
    const h = this._head != null ? this._head : (auto == null ? b : auto);
    for (const e of this._spectrumTargets) {
      const inf = e.mesh.morphTargetInfluences;
      if (inf) inf[e.morphIndex] = e.kind === 'shape' ? h : b;
    }
  }

  // The rest pose is the one part of the blend a morph weight cannot carry.
  _blendRestPose(t, rebase) {
    const THREE = this._THREE;
    if (!this._restNow.size) return;
    const qB = new THREE.Quaternion(), vB = new THREE.Vector3();

    // ANIMATION-SAFE. Re-taking the inverses reads the bones where they stand, so doing it
    // on a POSED character bakes that pose into the bind. Stand the rig at the new rest, take
    // the inverses, then put back only what was genuinely posed by something else — a node
    // still sitting exactly on the PREVIOUS rest was not posed, and belongs at the new one.
    // With `rebase` the pose is deliberately DROPPED instead: nothing is captured, nothing is
    // put back, the whole rig is left standing at the new rest.
    const posed = new Map();
    const EPS = 1e-6;
    for (const [key, e] of this._restNow) {
      const n = e.node;
      if (!rebase) {
        const wasResting =
          Math.abs(n.position.x - e.t.x) < EPS && Math.abs(n.position.y - e.t.y) < EPS && Math.abs(n.position.z - e.t.z) < EPS &&
          Math.abs(n.quaternion.x - e.r.x) < EPS && Math.abs(n.quaternion.y - e.r.y) < EPS &&
          Math.abs(n.quaternion.z - e.r.z) < EPS && Math.abs(n.quaternion.w - e.r.w) < EPS &&
          Math.abs(n.scale.x - e.s.x) < EPS && Math.abs(n.scale.y - e.s.y) < EPS && Math.abs(n.scale.z - e.s.z) < EPS;
        if (!wasResting) posed.set(key, { t: n.position.clone(), r: n.quaternion.clone(), s: n.scale.clone() });
      }
      // Recomputed from anchor A every time, never accumulated from the previous t — that is
      // what makes dragging the slider drift-free.
      n.position.copy(e.A.t).lerp(vB.set(e.B.t[0], e.B.t[1], e.B.t[2]), t);
      n.quaternion.copy(e.A.r).slerp(qB.set(e.B.r[0], e.B.r[1], e.B.r[2], e.B.r[3]), t);
      n.scale.copy(e.A.s).lerp(vB.set(e.B.s[0], e.B.s[1], e.B.s[2]), t);
      e.t.copy(n.position); e.r.copy(n.quaternion); e.s.copy(n.scale);
      this._stampRest(n);
    }
    this.object3D.updateMatrixWorld(true);
    // PLACEMENT-SAFE, and never `calculateInverses()` — see `_rebindInRootSpace`. The bind
    // is taken in the character's own space, so the game may park this character on a moving
    // platform, spin it, or scale it for height, before or after this call, and the blend is
    // unaffected. World space here is what broke both integrations.
    _rebindInRootSpace(THREE, this.object3D, this._rebind);

    if (posed.size) {
      for (const [key, p] of posed) {
        const n = this._restNow.get(key).node;
        n.position.copy(p.t); n.quaternion.copy(p.r); n.scale.copy(p.s);
      }
      this.object3D.updateMatrixWorld(true);
    }
    for (const sk of this._rebind) sk.update();
    for (const sk of this._ride) sk.update();

    // A SKINNED MESH IS NOT CULLED AGAINST ITS GEOMETRY'S SPHERE — three gives it its own,
    // computed over the bind pose AND the bones, and that is what the frustum test uses. Skip
    // this and a character's eyes vanish depending on where the camera happens to tilt.
    for (const n of this._nodes) if (n.isSkinnedMesh) { try { n.computeBoundingSphere(); } catch (_) {} }
  }

  // The CURRENT rest, published on the node itself as `userData.gccRestP/Q/S`, refreshed on
  // every `setBody`. This is the contract sdk/anim.js resets bones from each frame (with its
  // attach-time clone as the fallback for rigs that never stamp). An animator that resets to
  // a rest it captured at LOAD drives the skeleton at the old rest while the skin morph and
  // bind matrices sit at the new one — "the body slider breaks while our idle runs", hit
  // independently by two integrations on the same day.
  _stampRest(n) {
    const THREE = this._THREE, ud = n.userData;
    (ud.gccRestP || (ud.gccRestP = new THREE.Vector3())).copy(n.position);
    (ud.gccRestQ || (ud.gccRestQ = new THREE.Quaternion())).copy(n.quaternion);
    (ud.gccRestS || (ud.gccRestS = new THREE.Vector3())).copy(n.scale);
  }

  /**
   * Stand the skeleton back at its rest pose — the lerped rest for the current body `t`.
   * The public "forget the pose": animators write absolute bone transforms, so a game
   * that stops or detaches its animator had no supported way back to neutral short of
   * respawning. Pose only — morph weights, hair, outfit and materials are untouched, and
   * no bind inverses are recomputed (they already belong to this rest).
   */
  toRest() {
    if (!this._restNow.size) return this;
    for (const [, e] of this._restNow) {
      e.node.position.copy(e.t); e.node.quaternion.copy(e.r); e.node.scale.copy(e.s);
    }
    this.object3D.updateMatrixWorld(true);
    for (const sk of this._rebind) sk.update();
    for (const sk of this._ride) sk.update();
    for (const n of this._nodes) if (n.isSkinnedMesh) { try { n.computeBoundingSphere(); } catch (_) {} }
    return this;
  }

  // ── the identity sliders: also morph weights ──
  setFace(name, v) {
    // Built on first use. The recipe is already in memory; what is deferred is the dense
    // buffer and its morph slot, so a slider no character ever writes is never made.
    if (!this._c._face.routes.has(name)) this._c._ensureFaceSlider(name);
    const routes = this._c._face.routes.get(name);
    if (!routes) {
      console.warn(`[gcc] unknown face slider "${name}". This project ships: ${this._c.faceNames.join(', ') || '(none)'}`);
      return this;
    }
    v = Number(v) || 0;
    this._face.set(name, v);
    for (const r of routes) {
      const mesh = this._mine(r.mesh);
      if (mesh && mesh.morphTargetInfluences) mesh.morphTargetInfluences[r.morphIndex] = v;
    }
    // The hair is seated on the head; moving the head moves the hair.
    this._conformHair();
    return this;
  }
  getFace(name) { return this._face.get(name) || 0; }

  /**
   * Which skin surface the body wears underneath. 0 = the base's own maps, 1 = the other
   * anchor's. DELIBERATELY INDEPENDENT of body `t`: a masculine build with feminine surface
   * detail is a real character, and that variety is the point. One uniform write — no decode,
   * no re-upload, no work proportional to texture size.
   */
  setDetail(d) {
    d = Math.max(0, Math.min(1, Number(d) || 0));
    this._detail = d;
    for (const n of this._nodes) {
      const u = n.material && n.material.userData && n.material.userData.gccUniforms;
      if (u && u.gccDetailT) u.gccDetailT.value = d;
    }
    return this;
  }
  get detail() { return this._detail; }

  /**
   * The skin tone grade — the site's melanin sliders, same math, applied to the finished
   * skin: `{ melanin, exposure, contrast, saturation, warmth }`, all optional.
   *
   * `melanin` is 0..1 around a neutral 0.5; the others are multipliers (1 = unchanged) except
   * `warmth`, which is a signed ±shift. Pass `null` to turn the grade off entirely.
   *
   * WHEN YOU NEED THIS: a character exported through the site's own recipe ingest already has
   * its tone baked into the atlas, so leave it alone. A BLENDED character does not — the
   * sources each bring their own skin and the parent's grade lives on the parent record — so
   * a blend rendered without this comes out at the sources' tone, not the character's.
   */
  setSkinTone(tone) {
    this._skinTone = tone ? { ...tone } : null;
    const t = this._skinTone;
    for (const n of this._nodes) {
      const u = n.material && n.material.userData && n.material.userData.gccUniforms;
      if (!u || !u.uGccToneOn) continue;
      u.uGccToneOn.value = t ? 1 : 0;
      if (!t) continue;
      const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
      u.uGccMelanin.value = num(t.melanin, 0.5);
      u.uGccExposure.value = num(t.exposure, 1);
      u.uGccContrast.value = num(t.contrast, 1);
      u.uGccSaturation.value = num(t.saturation, 1);
      u.uGccWarmth.value = num(t.warmth, 0);
    }
    return this;
  }
  get skinTone() { return this._skinTone ? { ...this._skinTone } : null; }

  // ── hair ──
  async setHair(id, color) {
    // LAST CALL WINS, and the losers build nothing. "Any value can change on any frame" is the
    // product's selling point, so a player clicking down a hair list is the NORMAL case, not an
    // edge case: two calls in flight both pass the removal, and without this token both parent
    // a group — the scene keeps two heads of hair while `hair`/`toRecipe()` name whichever
    // finished last. Taken before the await and re-checked after every one.
    const seq = this._hairSeq = (this._hairSeq || 0) + 1;
    this._removeHair();
    if (!id) { this._applyScalpTint(null); return this; }
    const THREE = this._THREE;
    const style = await this._c._hairStyle(id);
    if (this._disposed || seq !== this._hairSeq) return this;

    // Hair geometry CANNOT be shared across characters — its positions are the one thing the
    // conform writes on the CPU, per character. Everything else is shared by reference, so
    // the extra cost is one position array per character, not a mesh.
    const group = new THREE.Group();
    group.name = 'GCC_HAIR_' + id;
    const parts = [];
    for (const src of style.meshes) {
      // Only `position` is per character — the conform writes it. Everything else is shared.
      const g = ownedGeometry(THREE, src.geometry, ['position']);
      const { outer, inner, blend, mode } = createHairMaterials(THREE, src.material, {
        ...style.opts,
        // The outer pass resolves its edges with ALPHA-TO-COVERAGE when the context has
        // MSAA — that is what makes a hairline soft rather than stair-stepped, and it is
        // how the site decides it too. Without the renderer the module assumes no MSAA and
        // takes the transparent fallback, which renders softer-edged than the editor.
        renderer: this._c._renderer,
        color: color || this._hairColor || style.defaultColor,
      });
      let mesh;
      if (src.isSkinnedMesh) {
        mesh = new THREE.SkinnedMesh(g, outer);
        group.add(mesh);
        this._bindSkinned(mesh, src, 'hair "' + id + '"');
      } else {
        mesh = new THREE.Mesh(g, outer);
        group.add(mesh);
      }
      mesh.name = src.name;
      // THREE PASSES, exactly as the site renders hair: the mesh carries the OUTER pass (the
      // hair itself), and the opaque INNER core and — in 'both' mode — the BLEND fringe ride
      // beside it as clones. Every clone shares the SAME BufferGeometry, so there is no extra
      // geometry or texture memory, and a SkinnedMesh clone keeps its skeleton and so deforms
      // exactly like the pass it sits on. Building only two of the three is what made the
      // SDK's hair read as harder and darker than the editor's.
      // The opaque core exists ONLY in the no-MSAA fallback, exactly as the editor builds it
      // (`if (!_useAlphaToCoverage)`). With A2C the outer pass is already opaque, and adding
      // the core anyway runs the root-darkening shader on two overlapping layers — visibly
      // darker roots than the editor, worst on blonde hair.
      let innerMesh = null;
      if (inner) {
        innerMesh = mesh.clone();         // Mesh.clone shares geometry; SkinnedMesh keeps its skeleton
        innerMesh.name = src.name + '__inner';
        innerMesh.material = inner;
        innerMesh.userData.hairPass = 'inner';
        group.add(innerMesh);
      }
      let blendMesh = null;
      if (blend) {
        blendMesh = mesh.clone();
        blendMesh.name = src.name + '__blend';
        blendMesh.material = blend;
        blendMesh.userData.hairPass = 'blend';
        blendMesh.visible = mode === 'both';
        group.add(blendMesh);
      }
      parts.push({
        src, mesh, soft: innerMesh, blend: blendMesh, attr: g.attributes.position,
        rest: new Float32Array(g.attributes.position.array),
        posA: src.geometry.attributes.position.array,
        dpos: style.deltas.get(src) || null,
      });
    }
    // HAIR IS SKINNED TO THE HEAD JOINT — every vertex weighted 1.0 to `Head`, bound to
    // the SAME body skeleton as everything else. That is how a rigid head accessory rides a
    // rig, and it is the same path the outfit takes (_bindSkinned), so there is one binding
    // mechanism here rather than two.
    //
    // The alternatives both failed: living in character space (what the site does) is enough
    // on a page where the head never animates, but leaves the hair behind the moment a joint
    // moves; parenting the group to the head BONE with a frozen matrix slid off the skull as
    // soon as the body slider re-based the rest pose. Skinning survives both, because the
    // skeleton is the thing both of them move.
    this.object3D.add(group);
    // WEIGHTS COME FROM THE SKIN, NOT FROM ONE JOINT. Pinning every hair vertex to `Head`
    // is only right for a crop: long hair falls past the shoulders, and a strand hanging by
    // the collarbone that is rigidly welded to the skull swings through the body the moment
    // the head turns. So each hair vertex takes the weights of the nearest SKIN vertex —
    // the same backward closest-point transfer the garments use. Hair over the cranium picks
    // up Head, hair down the back picks up neck and spine, and it blends across the join
    // because the skin's own weights already do.
    // WEIGHTS COME FROM THE SKIN, VIA THE CONFORM'S OWN BINDING. Pinning every hair vertex
    // to `Head` is only right for a crop: long hair falls past the shoulders, and a strand by
    // the collarbone welded to the skull swings through the body when the head turns.
    //
    // buildHairBinding already worked out, per CARD, which skin vertex it grows from. That
    // root is exactly the right place to take joint weights from — hair off the cranium gets
    // Head, hair down the back gets neck and spine, with whatever blend the skin itself has.
    // No second nearest-point search, and no new convention.
    const skel = this._bodySkeleton();
    const binding = style.binding;
    const srcHead = this._c._head;
    const sIdx = srcHead && srcHead.geometry.attributes.skinIndex;
    const sWgt = srcHead && srcHead.geometry.attributes.skinWeight;
    if (skel && binding && sIdx && sWgt) {
      // The head's skin indices point at the head mesh's own skeleton; remap by bone NAME
      // into the body rig we are binding to.
      const srcBones = (srcHead.skeleton && srcHead.skeleton.bones) || [];
      const remap = srcBones.map((bn) => Math.max(0, skel.bones.findIndex((x) => x.name === bn.name)));
      for (let pi = 0; pi < parts.length; pi++) {
        const p = parts[pi];
        const bind = binding.perMesh[pi];
        // ALL THREE passes get skinned, or the ones left behind stop following the head.
        for (const m of [p.mesh, p.soft, p.blend]) {
          if (!m || m.isSkinnedMesh) continue;
          const wasVisible = m.visible;
          const n = m.geometry.attributes.position.count;
          const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
          // default: everything on the head joint, then per-card roots refine it
          const headIdx = Math.max(0, skel.bones.findIndex((x) => /^head$/i.test(String(x.name).replace(/[^A-Za-z0-9]/g, ''))));
          for (let i = 0; i < n; i++) { si[i * 4] = headIdx; sw[i * 4] = 1; }
          if (bind) {
            for (const card of bind.cards) {
              const v = binding.skinVerts[card.root];
              if (v === undefined) continue;
              for (const vi of card.verts) {
                for (let c = 0; c < 4; c++) {
                  si[vi * 4 + c] = remap[sIdx.array[v * 4 + c]] || 0;
                  sw[vi * 4 + c] = sWgt.array[v * 4 + c];
                }
              }
            }
          }
          m.geometry.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
          m.geometry.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
          const sk = new THREE.SkinnedMesh(m.geometry, m.material);
          sk.name = m.name; sk.userData = m.userData;
          sk.frustumCulled = false;
          sk.visible = wasVisible;        // the fringe is hidden outside 'both' mode
          m.parent.add(sk); m.parent.remove(m);
          sk.bind(skel, new THREE.Matrix4());
          if (p.mesh === m) p.mesh = sk; else if (p.soft === m) p.soft = sk; else p.blend = sk;
        }
      }
    } else {
      console.warn('[gcc] hair could not take weights from the skin — it will not follow animation.');
    }
    this._hair = { id, style, group, parts, color: color || this._hairColor || style.defaultColor };
    this._hairColor = this._hair.color;
    this._applyScalpTint(style.scalp);
    this._applyBlendTextures();   // the scalp path rebuilds the head material — repaint the blend onto it
    this._applyHairBody();
    this._conformHair();
    return this;
  }
  get hair() { return this._hair ? this._hair.id : null; }

  /**
   * Eye colour, by id from `creator.eyeColors`. Swaps the iris albedo on THIS character's
   * eye materials — the eye meshes share geometry with everyone else, so the material is
   * what has to be per character.
   */
  setEyeColor(id) {
    const e = (this._c._eyes || []).find((x) => x.id === id);
    if (!e) { console.warn('[gcc] unknown eye colour "' + id + '". This project ships: ' + this._c.eyeColors.map((x) => x.id).join(', ')); return this; }
    const THREE = this._c._THREE;
    if (!this._eyeTexCache) this._eyeTexCache = this._c._eyeTexCache || (this._c._eyeTexCache = new Map());
    let tex = this._eyeTexCache.get(id);
    if (!tex) {
      tex = new THREE.TextureLoader().load(e.url);
      tex.flipY = false;                       // glTF UV convention, like every other map here
      tex.colorSpace = THREE.SRGBColorSpace;   // an iris albedo IS colour
      this._eyeTexCache.set(id, tex);
    }
    for (const n of this._nodes || []) {
      if (!n || !/^eye[LR]$/i.test(n.name || '')) continue;
      const mat = Array.isArray(n.material) ? n.material[0] : n.material;
      if (!mat) continue;
      mat.map = tex; mat.needsUpdate = true;
    }
    this._eyeColor = id;
    return this;
  }
  get eyeColor() { return this._eyeColor || null; }

  // Resolve the head joint by NAME across the whole tree — never from one mesh's
  // `.skeleton`, which can land on a sub-rig. glTF strips dots from names.
  _headBone() {
    if (this._headBoneCache !== undefined) return this._headBoneCache;
    let found = null;
    this.object3D.traverse((o) => {
      if (found || !o.isBone) return;
      if (/^head$/i.test(String(o.name).replace(/[^A-Za-z0-9]/g, ''))) found = o;
    });
    this._headBoneCache = found;
    return found;
  }

  /**
   * ARKit expressions — `jawOpen`, `eyeBlinkLeft`, the visemes, all 51. These ship ON the
   * base GLB, so they are addressed BY NAME through each mesh's own morphTargetDictionary
   * rather than by index: the spectrum delta, the 68 identity sliders and the character
   * blends all append targets after them, and an index captured before that would drift.
   *
   * Driven on EVERY mesh that has the name — the ARKit transfer puts morphs on the head, and
   * jaw-follow bakes same-named morphs onto the mouth interior, so setting only the head
   * parts the lips around static teeth.
   */
  setExpression(name, v) {
    v = Math.max(0, Math.min(1, Number(v) || 0));
    let hit = 0;
    const names = this._c._exprNames;
    for (const n of this._nodes || []) {
      const d = (names && names.get(n.name)) || n.morphTargetDictionary;
      if (!d || !(name in d) || !n.morphTargetInfluences) continue;
      n.morphTargetInfluences[d[name]] = v;
      hit++;
    }
    if (!hit) console.warn(`[gcc] no mesh has an expression called "${name}". This base ships: ${this.expressions.slice(0, 8).join(', ')}…`);
    else (this._expr || (this._expr = new Map())).set(name, v);
    return this;
  }
  getExpression(name) { return (this._expr && this._expr.get(name)) || 0; }
  /** Every expression name this base ships, deduped across meshes. */
  get expressions() {
    const out = new Set();
    const names = this._c._exprNames;
    for (const n of this._nodes || []) {
      const d = (names && names.get(n.name)) || n.morphTargetDictionary || {};
      for (const k of Object.keys(d)) if (!/^\d+$/.test(k)) out.add(k);   // never the index fallback
    }
    return [...out];
  }

  setHairColor(c) {
    this._hairColor = c;
    if (!this._hair) return this;
    this._hair.color = c;
    for (const p of this._hair.parts) {
      p.mesh.material.color.set(c);
      if (p.soft) p.soft.material.color.set(c);       // the core only exists without MSAA
      if (p.blend) p.blend.material.color.set(c);     // the fringe recolours with the rest
    }
    this._applyScalpTint(this._hair.style.scalp);
    return this;
  }

  /**
   * A whole hair COLOUR STYLE, not just a colour: `setHairStyle('Strawberry Blonde')`.
   *
   * A style carries the colour AND how the root behaves, because those only make sense
   * together. Two root modes:
   *   MONO-COLOR  one colour, the root end darkened by a scalar.
   *   MULTI-COLOR the root end has its OWN colour, running into the tip colour along the
   *               strand — blonde roots under dark tips, red roots under near-black, and so on.
   *
   * Names come from `creator.hairColorStyles` (the shipped swatches plus anything the project
   * adds). An object may be passed instead, in the same shape as a saved style.
   */
  setHairStyle(style) {
    const s = typeof style === 'string'
      ? hairColorStyle(style, (this._c._manifest && this._c._manifest.hairColors) || null)
      : style;
    if (!s) {
      console.warn(`[gcc] unknown hair colour style "${style}". This project ships: ` +
        this._c.hairColorStyles.join(', '));
      return this;
    }
    // Normalise both shapes: the swatch helper's camelCase and a raw saved style's snake_case.
    const pick = (a, b, d) => (s[a] !== undefined ? s[a] : (s[b] !== undefined ? s[b] : d));
    const color = pick('color', 'color', this._hairColor);
    const multi = isMultiRoot(pick('rootMode', 'root_mode', 'mono')) ? 1 : 0;
    const num = (a, b, d) => { const v = pick(a, b, d); return typeof v === 'number' ? v : d; };
    this._hairStyleName = typeof style === 'string' ? style : null;
    if (color) this.setHairColor(color);
    const write = (u, k, v) => { if (u && u[k] && v !== undefined) u[k].value = v; };
    const rootCol = pick('rootColor', 'root_color', null);
    for (const p of (this._hair ? this._hair.parts : [])) {
      for (const m of [p.mesh, p.soft, p.blend]) {
        const u = m && m.material && m.material.userData && m.material.userData.hairUniforms;
        if (!u) continue;
        write(u, 'uHairRootMode', multi);
        if (rootCol && u.uHairRootColor) u.uHairRootColor.value.set(rootCol);
        write(u, 'uHairRootStr', num('rootStrength', 'root_strength', 1));
        write(u, 'uHairRootDark', num('rootDarkening', 'root_darkening', 0));
        write(u, 'uHairDensity', num('density', 'hair_density', undefined));
        write(u, 'uHairRoughFlr', num('roughnessFloor', 'hair_roughness_floor', undefined));
        write(u, 'uHairSeedAmp', num('seedVariation', 'seed_variation', undefined));
        write(u, 'uHairRoughSeed', num('roughnessSeedAmp', 'hair_roughness_seed_amp', undefined));
      }
    }
    return this;
  }
  get hairStyle() { return this._hairStyleName || null; }

  _applyScalpTint(scalp) {
    const THREE = this._THREE;
    const head = this._c._head ? this._mine(this._c._head) : null;
    if (!head || !head.material) return;
    const want = !!(scalp && scalp.mask);
    const has = !!(head.material.userData.gccUniforms && head.material.userData.gccUniforms.gccScalpMask);
    if (want !== has) {
      // The patch set changed, so the program key changes with it — rebuild the material
      // rather than trying to bolt an injection onto a compiled one.
      const srcHead = this._c._head;
      head.material.dispose();
      head.material = makeSkinMaterial(THREE, srcHead.material, this._c._detailByMesh.get(srcHead), want ? scalp : null);
      head.material.userData.gccUniforms.gccDetailT.value = this._detail;
    }
    const u = head.material.userData.gccUniforms;
    if (want && u.gccScalpColor) {
      u.gccScalpColor.value.set(this._hairColor || '#000000').multiplyScalar(scalp.darken);
    }
  }

  // Rest = this end's bake + (other end's bake − this one) × t. The BAKES are the rest; the
  // conform layer is re-laid on top of it, never written into it. Recomputed from the bake
  // every time rather than accumulated, so dragging cannot drift.
  //
  // The site additionally measures a `dFit` — how far along the bake delta the runtime FIT
  // already sat — because on the site the hair is fitted at load and that fit's seat point is
  // ambiguous. There is no fit here: the bake IS the rest at each end, so the seat is 0 by
  // construction and measuring it would only introduce noise.
  _applyHairBody() {
    if (!this._hair) return;
    // THE HAIR IS SPLIT THE SAME WAY THE HEAD IS, for the same reason.
    //
    // Its two bakes are seated on the two ANCHOR HEADS, so what separates them is the whole
    // head delta: about 14 cm of the skeleton being a different size plus about 1 cm of the
    // head being a different shape. Lerping all of that by the BODY masculinised the hairline
    // while the face stayed feminine; lerping all of it by the HEAD left the hair floating
    // 14 cm off a skull that had walked away with the body. It is not one number's job.
    //
    // So the head joint's own travel rides the BODY, and whatever the bakes differ by beyond
    // it rides the HEAD. At head = body this is posA + dpos * t exactly, as it always was.
    const b = this._body;
    const h = this.head;
    const R = this._c._spectrum && this._c._spectrum.headRigid;
    for (const p of this._hair.parts) {
      if (!p.dpos) { p.rest.set(p.posA); continue; }
      if (!R || b === h) {
        for (let i = 0; i < p.rest.length; i++) p.rest[i] = p.posA[i] + p.dpos[i] * h;
        continue;
      }
      for (let i = 0; i < p.rest.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          const rigid = R[c];
          p.rest[i + c] = p.posA[i + c] + b * rigid + h * (p.dpos[i + c] - rigid);
        }
      }
    }
  }

  /**
   * Make the seated hair follow the head.
   *
   * The head's displacement is the sum of every ACTIVE morph target's delta at each bound
   * skin vertex — EXCLUDING the spectrum target, which the bake lerp above has already
   * accounted for. Including it would count the body slider twice and lift the hair off the
   * skull, which is exactly the shape of the site's 2026-07-28 regression.
   *
   * Then, per card: the root's displacement rigidly, plus (long cards only) the faded,
   * inverse-distance blended share of the field where each vertex actually lies. Identical
   * algebra to the site's fit and its Apply-time follow — one mechanism, not two.
   */
  _conformHair() {
    const hair = this._hair;
    if (!hair) return;
    const binding = hair.style.binding;
    const head = this._c._head;
    if (!binding || !head) {
      // No head geometry to follow: the hair still gets the body lerp, just no slider follow.
      for (const p of hair.parts) { p.attr.array.set(p.rest); p.attr.needsUpdate = true; }
      return;
    }
    const dstHead = this._mine(head);
    const infl = dstHead && dstHead.morphTargetInfluences;
    const morphs = head.geometry.morphAttributes && head.geometry.morphAttributes.position;
    const spectrumIdx = new Set(this._spectrumTargets.filter((e) => e.mesh === dstHead).map((e) => e.morphIndex));

    const V = binding.skinVerts;
    const disp = hair._disp && hair._disp.length === V.length * 3 ? hair._disp : (hair._disp = new Float32Array(V.length * 3));
    disp.fill(0);
    if (infl && morphs) {
      for (let m = 0; m < morphs.length; m++) {
        const w = infl[m];
        if (!w || Math.abs(w) < 1e-5) continue;      // an inactive target costs nothing
        if (spectrumIdx.has(m)) continue;            // already in the bake lerp — never twice
        const a = morphs[m].array;
        for (let i = 0; i < V.length; i++) {
          const v = V[i];
          disp[i * 3] += w * a[v * 3];
          disp[i * 3 + 1] += w * a[v * 3 + 1];
          disp[i * 3 + 2] += w * a[v * 3 + 2];
        }
      }
      // If the head sits under a non-identity transform, its deltas are in ITS space and the
      // hair is in body space. Rotate/scale them across — translation never applies to a delta.
      const M = this._c._headToBody;
      if (M) {
        const e = M.elements;
        for (let i = 0; i < V.length; i++) {
          const x = disp[i * 3], y = disp[i * 3 + 1], z = disp[i * 3 + 2];
          disp[i * 3] = e[0] * x + e[3] * y + e[6] * z;
          disp[i * 3 + 1] = e[1] * x + e[4] * y + e[7] * z;
          disp[i * 3 + 2] = e[2] * x + e[5] * y + e[8] * z;
        }
      }
    }

    for (let pi = 0; pi < hair.parts.length; pi++) {
      const p = hair.parts[pi];
      const bind = binding.perMesh[pi];
      const arr = p.attr.array, rest = p.rest;
      arr.set(rest);                                  // always rebuilt from rest, never nudged
      if (!bind) { p.attr.needsUpdate = true; continue; }
      for (const card of bind.cards) {
        const r = card.root;
        const dx = disp[r * 3], dy = disp[r * 3 + 1], dz = disp[r * 3 + 2];
        if (card.near) {
          const K = card.k;
          for (let k = 0; k < card.verts.length; k++) {
            const vi = card.verts[k];
            let ddx = dx, ddy = dy, ddz = dz;
            for (let q = 0; q < K; q++) {
              const b = card.near[k * K + q]; if (b < 0) continue;
              const w = card.w[k * K + q];
              ddx += w * (disp[b * 3] - dx);
              ddy += w * (disp[b * 3 + 1] - dy);
              ddz += w * (disp[b * 3 + 2] - dz);
            }
            arr[vi * 3] = rest[vi * 3] + ddx;
            arr[vi * 3 + 1] = rest[vi * 3 + 1] + ddy;
            arr[vi * 3 + 2] = rest[vi * 3 + 2] + ddz;
          }
          continue;
        }
        // SHORT card — the whole tuft rides its root rigidly. Per-vertex snapping warps card
        // shapes and spreads a clump into patchy strands.
        for (let k = 0; k < card.verts.length; k++) {
          const vi = card.verts[k];
          arr[vi * 3] = rest[vi * 3] + dx;
          arr[vi * 3 + 1] = rest[vi * 3 + 1] + dy;
          arr[vi * 3 + 2] = rest[vi * 3 + 2] + dz;
        }
      }
      p.attr.needsUpdate = true;
      p.mesh.geometry.computeBoundingSphere();
    }
  }

  _removeHair() {
    if (!this._hair) return;
    this.object3D.remove(this._hair.group);
    for (const p of this._hair.parts) {
      disposeOwnedGeometry(p.mesh.geometry);
      p.mesh.material.dispose();
      if (p.soft) p.soft.material.dispose();
      if (p.blend) p.blend.material.dispose();
    }
    this._hair = null;
  }

  // ── outfits ──
  async setOutfit(id) {
    // LAST CALL WINS — the same generation token as setHair, for the same reason. Dressing a
    // crowd means hundreds of these in flight at once; without it the losers stay parented,
    // undisposable, and the character wears two outfits at once.
    const seq = this._outfitSeq = (this._outfitSeq || 0) + 1;
    this._removeOutfit();
    if (!id) return this;
    const THREE = this._THREE;
    const of = await this._c._outfit(id);
    if (this._disposed || seq !== this._outfitSeq) return this;

    const group = new THREE.Group();
    group.name = 'GCC_OUTFIT_' + id;
    const parts = [];
    for (const piece of of.pieces) {
      const src = piece.src;
      // THE SECOND FIT IS A MORPH TARGET — installed ONCE per outfit, on the SHARED geometry.
      //
      // This used to be a per-character copy of `position` and `normal` that a CPU loop
      // re-lerped on every `setBody`. That is precisely the "50 characters = 50 meshes = dead"
      // trap law 2 exists to prevent, and at the real target — hundreds of dressed characters
      // — clothing was the dominant cost in the scene while the body, which does this right,
      // stayed flat. The two saved fits are base + one delta: the same shape of data as the
      // spectrum, so the same answer applies. Geometry, attributes and materials are now
      // shared by every wearer, and a character's whole contribution is one morph weight.
      //
      // Installed HERE rather than in the loader so a project that never wears an outfit never
      // pays for it, and so the first wearer's mesh already sees the target: three builds
      // `morphTargetInfluences` in the Mesh constructor, from the geometry as it stands.
      if (piece.morphIndex === undefined) {
        piece.morphIndex = piece.dpos
          ? appendMorphTarget(THREE, src.geometry, { position: piece.dpos, normal: piece.dnrm || null })
          : -1;
      }
      const g = src.geometry;
      // A GARMENT IS NEVER SPAWNED UNSKINNED. It used to fall through to a plain Mesh when the
      // asset carried no joints, which parents a rigid shell to the character: it does not
      // follow the rig, and it reads as the outfit "losing" its skinning even though the file
      // never had any. Wear blobs saved before the factory's exporter started shipping the
      // skeleton are exactly that shape, and there are real ones on disk.
      //
      // So if the piece has no weights, take them from the BODY — the same backward
      // closest-point transfer the factory does, and the same thing the hair path already does
      // for unskinned cards. Cached on the shared geometry, so a crowd pays for it once.
      let mesh;
      if (!(src.isSkinnedMesh && src.skeleton)) this._skinFromBody(g, 'outfit "' + id + '" piece "' + (src.name || '?') + '"');
      if ((src.isSkinnedMesh && src.skeleton) || g.getAttribute('skinIndex')) {
        mesh = new THREE.SkinnedMesh(g, src.material);
        mesh.frustumCulled = false;      // a garment's bounds follow the pose, not the bind
        group.add(mesh);
        if (src.isSkinnedMesh && src.skeleton) this._bindSkinned(mesh, src, 'outfit "' + id + '"');
        else mesh.bind(this._bodySkeleton(), new THREE.Matrix4());
      } else {
        mesh = new THREE.Mesh(g, src.material);
        group.add(mesh);
      }
      mesh.name = src.name;
      parts.push({ piece, mesh });
    }
    this.object3D.add(group);
    this._outfit = { id, of, group, parts, patched: [] };
    this._applyOutfitBody();
    this._applyBodyHide(of);
    return this;
  }
  get outfit() { return this._outfit ? this._outfit.id : null; }

  /**
   * The garment's place on the body slider: ONE morph weight per piece. NOTHING is re-fitted,
   * wrapped or tucked — the factory did that once, at save time, on the site.
   *
   * This is O(1) per piece, on shared geometry, so a slider drag costs the same whether one
   * character is wearing the outfit or three hundred are. It replaced a per-vertex CPU lerp
   * over per-character copies of `position` and `normal`.
   *
   * Two things the GPU now does that the CPU loop had to do by hand:
   *   - normals. The old loop re-normalised after lerping, because interpolated unit vectors
   *     drift short. three's morph runs before the normal is normalised in the shader, so the
   *     drift is corrected there, on every vertex, free.
   *   - bounds. The old loop recomputed the bounding sphere per character per move — a full
   *     vertex sweep, which is exactly the per-character cost this change exists to remove.
   *     three computes a SkinnedMesh's sphere lazily and caches it, so it is taken once per
   *     wearer instead. The two fits differ by centimetres, so it is not re-taken per move.
   */
  _applyOutfitBody() {
    if (!this._outfit) return;
    const THREE = this._THREE;
    const t = this._body;
    const cut = t < 0.5 ? 'a' : 'b';
    for (const p of this._outfit.parts) {
      const i = p.piece.morphIndex;
      if (i >= 0 && p.mesh.morphTargetInfluences) p.mesh.morphTargetInfluences[i] = t;
      // …and the garment's own FACE SET, which is baked per end (see the idxB capture in
      // _outfit). A per-END geometry variant, shared by every wearer on that side of the
      // slider — never an index write on the shared geometry, which would re-cut the whole
      // crowd whenever one character moved.
      if (!p.piece.idxB) continue;
      if (p.cut === cut) continue;
      p.cut = cut;
      if (cut === 'a') { p.mesh.geometry = p.piece.src.geometry; continue; }
      let vb = p.piece._cutB;
      if (!vb) {
        const g0 = p.piece.src.geometry, g = new THREE.BufferGeometry();
        for (const [k, a] of Object.entries(g0.attributes)) g.setAttribute(k, a);   // shared
        g.morphAttributes = g0.morphAttributes;                                     // shared
        g.morphTargetsRelative = g0.morphTargetsRelative;
        g.setIndex(new THREE.BufferAttribute(p.piece.idxB, 1));
        g.boundingSphere = g0.boundingSphere; g.boundingBox = g0.boundingBox;
        vb = p.piece._cutB = g;
      }
      p.mesh.geometry = vb;
    }
  }

  /**
   * Hide the skin under the clothes by DROPPING triangles from the index — reversible index
   * filtering only, never a shader change and never a position edit.
   *
   * KEYED BY MESH NAME, whichever mesh that is. An outfit's mask covers whatever skin the
   * factory hid under it, and on these bases the head is its own mesh from the collarbone up —
   * so a hood, a high collar or a helmet arrives here as a `GEO-head_*` entry beside the
   * `GEO-body_*` one and takes the identical path. Never special-case a mesh name here: the
   * moment this asks "is it the body?" a whole class of outfits starts showing skin.
   *
   * The index lives on the geometry and the geometry is SHARED, so the filtered index goes on
   * a per-OUTFIT geometry variant: same attribute objects by reference (one vertex upload for
   * the whole crowd, unchanged) with only its own index buffer. Two characters in the same
   * outfit share the variant, so the cost is per outfit, not per character.
   *
   * Honest cost: three keys the packed morph texture off the GEOMETRY, so a variant re-packs
   * the morph data once — per outfit, not per character, which is the reason this is not done
   * per character. It is cheap on the body and NOT cheap on the head: the head carries the
   * ARKit expression set, so an outfit that hides head skin pays one repack of all of it. Only
   * outfits that actually hide head verts pay it, and only once each.
   */
  // Which end's mask this character wears. The mask is per-VERTEX and a vertex is either
  // drawn or not, so the blend is the lerp thresholded at the midpoint: below 0.5 the
  // feminine fit's mask, at or above it the masculine one — the same rule the geometry
  // follows, resolved to the only two states a triangle has. Vertices the two masks
  // DISAGREE about sit under cloth at both ends by construction (the factory's mask stops
  // well inside the garment), so the changeover is covered.
  _hideSide() { return this._body < 0.5 ? 'a' : 'b'; }

  _applyBodyHide(of) {
    const THREE = this._THREE;
    const side = this._hideSide();
    const hide = side === 'a' ? of.hideA : of.hideB;
    if (!hide) return;
    if (this._outfit) this._outfit.hideSide = side;
    for (const [meshName, verts] of Object.entries(hide)) {
      // THE ANCHOR ID IS BAKED INTO THE MESH NAMES. The masculine fit's mask names
      // `GEO-body_mars`; the loaded base calls the same mesh `GEO-body_venus`. Matching the
      // raw name found nothing and hid nothing at that end of the slider — the exact bug the
      // per-end mask was added to fix. Fall back to the anchor-independent name, the same
      // pairing the spectrum builder uses.
      const norm = (n) => normMeshName(n, of.bases);
      const src = this._c._templateNodes.find((n) => (n.isMesh || n.isSkinnedMesh) && n.name === meshName)
               || this._c._templateNodes.find((n) => (n.isMesh || n.isSkinnedMesh) && norm(n.name) === norm(meshName));
      if (!src) continue;
      const mesh = this._mine(src);
      if (!mesh) continue;
      // variants are per END as well as per mesh — the two masks cut different triangles
      const vkey = meshName + '@' + side;
      let variant = of._indexVariants.get(vkey);
      if (!variant) {
        const g0 = src.geometry;
        const idx = g0.index;
        if (!idx) continue;
        const hidden = new Uint8Array(g0.attributes.position.count);
        for (const v of verts) if (v >= 0 && v < hidden.length) hidden[v] = 1;
        const keep = [];
        for (let i = 0; i < idx.count; i += 3) {
          // ANY hidden vertex drops the whole triangle — a triangle with one covered corner
          // is a sliver poking through the garment.
          const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
          if (hidden[a] || hidden[b] || hidden[c]) continue;
          keep.push(a, b, c);
        }
        const g = new THREE.BufferGeometry();
        for (const [k, a] of Object.entries(g0.attributes)) g.setAttribute(k, a);   // shared
        g.morphAttributes = g0.morphAttributes;                                     // shared
        g.morphTargetsRelative = g0.morphTargetsRelative;
        g.setIndex(keep);
        g.boundingSphere = g0.boundingSphere; g.boundingBox = g0.boundingBox;
        variant = g;
        of._indexVariants.set(vkey, variant);
      }
      // don't stack patches: re-applying on a slider move must record the mesh's ORIGINAL
      // geometry, not the variant this method installed a moment ago
      if (!this._outfit.patched.some((p) => p.mesh === mesh)) this._outfit.patched.push({ mesh, original: mesh.geometry });
      mesh.geometry = variant;
    }
  }
  // The slider crossed the midpoint → the other end's mask is the right cut now. Restoring
  // first keeps `patched` holding true originals, so taking the outfit off still puts the
  // body back whole. Costs nothing while the slider stays on one side of 0.5.
  _refreshBodyHide() {
    const o = this._outfit;
    if (!o || !o.of || (!o.of.hideA && !o.of.hideB)) return;
    if (o.hideSide === this._hideSide()) return;
    for (const p of o.patched) p.mesh.geometry = p.original;
    o.patched.length = 0;
    this._applyBodyHide(o.of);
  }

  _removeOutfit() {
    if (!this._outfit) return;
    for (const p of this._outfit.patched) p.mesh.geometry = p.original;   // exact restore
    this.object3D.remove(this._outfit.group);
    // NOTHING TO DISPOSE. A garment's geometry, its attributes, its morph target and its
    // materials all belong to the outfit — shared by every wearer and cached on the Creator.
    // Disposing here would undress the whole crowd and break the cache for the next wearer.
    // (It used to own a private copy of position/normal; that copy is gone.)
    this._outfit = null;
  }

  /**
   * The character, as a list of numbers. A few hundred bytes of JSON — THIS is "saving a
   * character". There is no mesh to store and there is deliberately no export/bake here.
   */
  toRecipe() {
    const face = {};
    for (const [k, v] of this._face) if (v) face[k] = +v.toFixed(4);
    return {
      v: 1,
      body: +this._body.toFixed(4),
      // Only when it has been taken off the body -- a recipe that never mentions the head
      // means "the head follows", which is what every recipe written before it existed says.
      ...(this._head == null ? {} : { head: +this._head.toFixed(4) }),
      face,
      skin: { detail: +this._detail.toFixed(4), ...(this._skinTone ? { tone: { ...this._skinTone } } : {}) },
      // The character blend is part of WHO this character is, so it has to survive a
      // save/load round trip like every other slider.
      blend: { ...(this._blend || {}) },
      eyes: this._eyeColor || null,
      hair: this._hair ? { id: this._hair.id, color: this._hair.color } : null,
      outfit: this._outfit ? { id: this._outfit.id } : null,
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._removeHair();
    this._removeOutfit();
    this.object3D.removeFromParent();
    // Geometry is SHARED with every other character — disposing it here would blank the
    // whole crowd. Only what this character owns goes.
    for (const n of this._nodes) {
      const mats = Array.isArray(n.material) ? n.material : (n.material ? [n.material] : []);
      for (const m of mats) if (m.userData && m.userData.gccUniforms) m.dispose();
    }
    this._c._characters.delete(this);
  }
}

export default Creator;

// ── open items, carried from context/sdk/context.md ──────────────────────────
//
// TODO(spec): EXPRESSION MORPHS ACROSS THE SPECTRUM. The site blends the 51 ARKit deltas on
// the CPU, because a smile on one anchor is a genuinely different displacement field from the
// other. That is a morph-of-morph and has no GPU equivalent: making the targets themselves a
// function of t would force per-character morphAttributes, i.e. per-character geometry, i.e.
// the exact 50-copies cost this design exists to avoid. This build ships the base anchor's
// expression targets unblended — a ~2–4 mm error on a fully-expressed face at t=1, against
// 158 mm for the identity delta, and only visible while that expression is dialled in. If it
// turns out to matter, the middle option is two fixed expression sets cross-faded by t, which
// doubles the target count but keeps geometry shared. Owner has this marked undecided.
//
// TODO(spec): SKIN TEXTURES DO NOT SHARE — identity partly lives in the map, and there is no
// per-character map here. The mitigation named in the design (mix both ends' maps in the
// shader plus a small per-character overlay) is half-built: the mix is implemented as
// setDetail(); the per-character overlay is not specced and is not implemented.
//
// TODO(spec): ANIMATION RETARGETING ACROSS THE SPECTRUM. Blending moves the bone REST pose, so
// a clip authored against one anchor carries that anchor's bone TRANSLATIONS. Rotation-only
// clips ride the blended rest correctly; a clip with translation tracks will overwrite the
// blend on the joints it drives. Not addressed here — the design does not say whether the SDK
// should own retargeting or whether clips are expected to be rotation-only.
//
// The optimized asset route EXISTS: sdk/optimize-assets.mjs (meshopt + KTX2, per-part texture
// caps — body 1024, face 2048/1024, eyes 512, teeth 256, hair 512). Its output needs
// `ktx2Loader` + `meshoptDecoder` passed to Creator.open, which this module wires into its
// GLTFLoader. No LOD chain yet — that part is still unspecced.
