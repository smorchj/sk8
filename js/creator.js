// creator.js — the front door: you build your skater before you skate.
//
// Built on creategamecharacters.ai's embedded SDK (self-hosted copy in
// assets/creator-min/sdk/v1.js; assets fetched with tools/fetch-assets.mjs).
// The game owns every pixel of this UI; the SDK owns the character. Stance
// (regular/goofy) and the bag of tricks live HERE because they are part of who
// your skater is — the whole animation/input pipeline mirrors around stance.
//
// The rider stands in the park while you work; the camera is yours (drag to
// spin, scroll to zoom) and it closes in on the face by itself for the tabs
// that change it. The crew's portraits are shot in-game on the rider itself,
// hair off, behind a curtain: a preset's skin is composited by the SDK one
// frame after setBlend (measured: shot in the same task it still wears the
// previous skin), so each one gets its frame with the view covered. The face
// direction comes from the eyes — a skater stands sideways on the board, so
// the root's forward is 84° off the face.
//
// Since the 2026-09-04 SDK the FACE is its own axis (setHead): Build moves the
// body and leaves the face alone, and a blended rider places its own head at
// the anchor it was saved on — which is what makes Steve, Cander, Charles and
// Heiring (saved on the mars base while this project ships venus) look like
// themselves again.

const PROJECT_KEY = 'ggc_proj_8jmuxeXblEF5oa59vumsjBDqbR7C3Xvz-1vrhFv-mDM';
const ASSETS = 'assets/creator-min/';   // plain-optimized bundle (tools/optimize-plain.mjs)
const SAVE_KEY = 'sk8rider';
const PORTRAIT_KEY = 'sk8portraits.v4';
const PORTRAIT_LAYER = 1;               // the rider and the lights alone, for the portrait camera

const HAIR_COLORS = [
  ['#151210', 'black'], ['#3b2a1d', 'dark brown'], ['#6b4a2b', 'brown'], ['#a97f4f', 'light brown'],
  ['#d9b380', 'blonde'], ['#e8dcc4', 'bleach'], ['#b03030', 'red'], ['#888c92', 'grey'],
  ['#ff2e88', 'pink'], ['#2fd7c9', 'teal'], ['#7b4dff', 'violet'], ['#c8ff2e', 'acid'],
];

// This repo is the MECHANICS demo — skate-themed clothing only (owner,
// 2026-09-01). The period outfits belong to the story game, not here.
const OUTFIT_ALLOW = /crop-top|casual|prison/i;

// the 68 identity sliders, grouped the way a face is read
const FACE_GROUPS = [
  ['Head', /^(head|backSkull|topHead|face(Width|Height|Depth|Angle)|forehead)/],
  ['Brow', /^brow/],
  ['Eyes', /^eye/],
  ['Nose', /^(nose|septum)/],
  ['Mouth', /^(mouth|lip|upperLip|lowerLip)/],
  ['Cheeks', /^cheek/],
  ['Chin & jaw', /^(chin|jaw)/],
];
const TRICKS = { ollie: 'Ollie', kickflip: 'Kickflip', heelflip: 'Heelflip', treflip: '360 Flip', impossible: 'Impossible', indy: 'Indy grab' };
const FACE_TABS = new Set(['rider', 'face', 'hair', 'eyes']);

const pretty = (id) => String(id).replace(/^((mars|venus)__)/, '').replace(/_/g, ' ');
const words = (id) => String(id).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/W$/, ' width').toLowerCase();
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nextFrame = () => new Promise(res => requestAnimationFrame(() => res()));

// Where a face is and which way it looks.
//
// The skeleton's own +Z is the front — every bone from Hips to Head shares it
// (measured 2026-09-04 by sweeping a camera round the head and scoring image
// contrast: a face has eye sockets and a mouth, the back of a skull is smooth).
// The eye MESHES cannot be used for this: THREE.Box3.setFromObject on a skinned
// mesh returns its BIND box, which does not follow the posed head, so reading
// them aimed the portrait camera at the neck.
//
// bone 'Head' tracks the head (right for framing a face); 'Hips' is the stable
// body facing (right for squaring the rider, which must not chase the idle's
// slow look-around).
export function faceOf(obj, THREE, bone = 'Head') {
  const b = obj.getObjectByName(bone) || obj.getObjectByName('Head');
  const head = obj.getObjectByName('Head') || b;
  if (!b) {
    const p = obj.getWorldPosition(new THREE.Vector3()); p.y += 1.5;
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()));
    return { target: p, forward: f.setY(0).normalize() };
  }
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()));
  forward.y = 0; forward.normalize();
  const target = head.getWorldPosition(new THREE.Vector3());
  target.y += 0.06;                  // the head bone sits low in the skull; the face is above it
  return { target, forward };
}

export class RiderCreator {
  constructor(opts) {
    this.o = opts;      // {THREE, GLTFLoader, renderer, scene, ktx2Loader, meshoptDecoder,
                        //  getStance, setStance, getSkills, setSkill, onCharacter, onDone,
                        //  onOpen(front), onClose(), frame('body'|'face'), music()}
    this.root = document.getElementById('creator');
    this.creator = null;
    this.char = null;
    this.open_ = false;
    this.tab = 'rider';
    // head = the FACE axis, separate from body since the 2026-09-04 SDK. null
    // means "follow the rider as saved", which is what every recipe wants until
    // the player moves the slider.
    this.state = { name: '', preset: null, head: null, hair: null, outfit: null, body: 0.5, hairColor: '#3b2a1d', eyes: null, face: {} };
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (saved) {
        this.state = { ...this.state, ...saved, face: saved.face || {} };
        if (!this.state.preset && saved.blend) {           // a blend from the short-lived mix UI: keep its heaviest
          this.state.preset = Object.entries(saved.blend).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        }
        delete this.state.blend; delete this.state.normalise;
      }
    } catch { /* fresh rider */ }
    try { this.portraits = JSON.parse(localStorage.getItem(PORTRAIT_KEY) || '{}'); } catch { this.portraits = {}; }
    for (const k of ['sk8portraits.v1', 'sk8portraits.v2', 'sk8portraits.v3']) localStorage.removeItem(k);
    this._keys = (e) => this._onKey(e);
  }

  _save() { localStorage.setItem(SAVE_KEY, JSON.stringify(this.state)); }

  async _ensureSDK() {
    if (this.creator) return this.creator;
    const { Creator } = await import('../assets/creator-min/sdk/v1.js');
    this.creator = await Creator.open({
      key: PROJECT_KEY,
      assets: ASSETS,
      THREE: this.o.THREE,
      GLTFLoader: this.o.GLTFLoader,
      renderer: this.o.renderer,
      ktx2Loader: this.o.ktx2Loader,
      meshoptDecoder: this.o.meshoptDecoder,
    });
    return this.creator;
  }

  get outfits() { return this.creator.outfitIds.filter(o => OUTFIT_ALLOW.test(o)); }

  // spawn (or respawn) the character from this.state and hand it to the game
  async _apply() {
    const cr = await this._ensureSDK();
    const st = this.state;
    if (!cr.presetIds.includes(st.preset)) st.preset = cr.presetIds[0];
    if (!st.hair && cr.hairIds.length) st.hair = cr.hairIds[0];
    if (st.outfit && !OUTFIT_ALLOW.test(st.outfit)) st.outfit = null;
    if (!st.outfit && this.outfits.length) st.outfit = this.outfits.find(o => /casual/i.test(o)) || this.outfits[0];
    if (!this.char) {
      this.char = cr.spawn({ body: st.body });
      await this.o.onCharacter(this.char.object3D, this.char);   // game wiring (rig, clip bake) must finish
    }
    const c = this.char;
    c.setBody(st.body);
    c.setBlend({ [st.preset]: 1 });
    c.setHead?.(st.head ?? null);              // the face rides its own axis; null = as the rider was saved
    for (const [k, v] of Object.entries(st.face)) c.setFace(k, v);
    c.setHair(st.hair);
    c.setHairColor(st.hairColor);
    if (st.eyes) c.setEyeColor(st.eyes);
    if (st.outfit) c.setOutfit(st.outfit);
    this._save();
  }

  // try to restore a saved rider silently at boot (no panel)
  async restore() {
    if (!localStorage.getItem(SAVE_KEY)) return false;
    try { await this._apply(); this.o.onDone?.(); return true; }
    catch (e) { console.warn('[creator] restore failed, keeping fallback rider:', e.message); return false; }
  }

  // ── open / close ──────────────────────────────────────────────────────────
  // front = the boot screen: no way out but SKATE
  async open({ front = false } = {}) {
    if (this.open_) return;
    this.open_ = true;
    this.front = front;
    this.root.classList.add('open');
    this.root.classList.toggle('front', front);
    this.root.innerHTML = `<div class="cr-loading"><div class="cr-word">SK8</div><div>loading the creator…</div></div>`;
    this.o.onOpen?.(front);
    document.addEventListener('keydown', this._keys, true);
    try {
      await this._apply();
      this._shell();
      this._show(this.tab);
      this._portraits();                          // the crew's faces, if any are missing
    } catch (e) {
      this.root.innerHTML = `<div class="cr-loading"><div class="cr-word">SK8</div>
        <div class="cr-err">Creator unavailable — ${esc(e.message)}</div>
        <div class="cr-note">The dev server must run on http://127.0.0.1:5101 (project origin lock).</div></div>`;
    }
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    this.root.classList.remove('open', 'front');
    document.removeEventListener('keydown', this._keys, true);
    this._save();
    this.o.onClose?.();
    this.o.onDone?.();
  }

  _onKey(e) {
    if (!this.open_) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { if (e.key === 'Escape') e.target.blur(); return; }
    const k = e.key.toLowerCase();
    if (e.key === 'Enter') { e.preventDefault(); this.close(); return; }
    if (e.key === 'Escape' && !this.front) { this.close(); return; }
    if (k === 'm' || k === 'c' || k === 'x' || k === 'r' || k === 'b') e.stopImmediatePropagation();   // the game's toggles stay out of the menu
  }

  // ── the shell: hero, tab rail, panel, the big button ──────────────────────
  _shell() {
    const tabs = [
      ['rider', 'Rider', '01'], ['face', 'Face', '02'], ['hair', 'Hair', '03'], ['eyes', 'Eyes', '04'],
      ['fit', 'Fit', '05'], ['stance', 'Stance', '06'], ['tricks', 'Tricks', '07'],
    ];
    this.root.innerHTML = `
      <div class="cr-hero"><div class="cr-word">SK8</div><div class="cr-sub">build your skater</div></div>
      <nav class="cr-tabs">${tabs.map(([id, label, n]) =>
        `<button data-tab="${id}"><i>${n}</i><b>${label}</b></button>`).join('')}</nav>
      <section class="cr-panel"><div class="cr-body"></div></section>
      <div class="cr-hint">drag to spin · scroll to zoom</div>
      ${this.front ? '' : '<button class="cr-x" title="back to skating (Esc)">✕</button>'}
      <button class="cr-go"><span>Skate</span><small>${this.front ? 'Enter' : 'Enter · Esc'}</small></button>
      <div class="cr-credit">Powered by creategamecharacters.com</div>
      <div class="cr-curtain"><div class="cr-word">SK8</div><div>shooting the crew…</div></div>`;
    this.root.querySelector('.cr-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (b) this._show(b.dataset.tab);
    });
    this.root.querySelector('.cr-go').onclick = () => this.close();
    this.root.querySelector('.cr-x')?.addEventListener('click', () => this.close());
  }

  _show(tab) {
    this.tab = tab;
    for (const b of this.root.querySelectorAll('.cr-tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    this.o.frame?.(FACE_TABS.has(tab) ? 'face' : 'body');
    const body = this.root.querySelector('.cr-body');
    body.innerHTML = this['_' + tab]();
    this._wire(body, tab);
  }

  // ── the tabs ──────────────────────────────────────────────────────────────
  _rider() {
    const cr = this.creator, st = this.state;
    return `<h2>Who's riding</h2>
      <label class="cr-name"><span>Name</span><input id="crName" maxlength="18" placeholder="your skater" value="${esc(st.name)}"></label>
      <div class="cr-grid presets" data-group="preset">${cr.presetIds.map(p => {
        const img = this.portraits[this._pkey(p)];
        return `<button data-v="${p}" class="${st.preset === p ? 'active' : ''}">
          <span class="pic">${img ? `<img src="${img}" alt="">` : '<span class="wait"></span>'}</span><span class="lbl">${esc(p)}</span></button>`;
      }).join('')}</div>
      <label class="cr-slider"><span>Build</span><input type="range" id="crBody" min="0" max="1" step="0.01" value="${st.body}"><em><b>slight</b><b>heavy</b></em></label>
      <label class="cr-slider"><span>Face</span><input type="range" id="crHead" min="0" max="1" step="0.01" value="${st.head ?? this.char?.head ?? 0.5}"><em><b>softer</b><b>stronger</b></em>${st.head == null ? '' : '<button class="cr-ghost tiny" id="crHeadFollow">as saved</button>'}</label>`;
  }

  _face() {
    const cr = this.creator, st = this.state;
    const g = this._faceGroup || FACE_GROUPS[0][0];
    const names = cr.faceNames.filter(n => FACE_GROUPS.find(x => x[0] === g)[1].test(n));
    const touched = Object.keys(st.face).filter(k => st.face[k]).length;
    return `<h2>Face</h2>
      <div class="cr-chips" data-group="faceGroup">${FACE_GROUPS.map(([id]) =>
        `<button data-v="${id}" class="${g === id ? 'active' : ''}">${id}</button>`).join('')}</div>
      <div class="cr-sliders">${names.map(n => `
        <label class="cr-slider mini"><span>${words(n)}</span>
          <input type="range" data-face="${n}" min="-1" max="1" step="0.02" value="${st.face[n] || 0}"></label>`).join('')}</div>
      <div class="cr-row"><button class="cr-ghost" id="crFaceReset" ${touched ? '' : 'disabled'}>reset face${touched ? ` (${touched})` : ''}</button></div>`;
  }

  _hair() {
    const cr = this.creator, st = this.state;
    return `<h2>Hair</h2>
      <div class="cr-grid hair" data-group="hair">${cr.hairIds.map(h =>
        `<button data-v="${h}" class="${st.hair === h ? 'active' : ''}"><span class="pic"><img src="${ASSETS}hair/${h}/thumb.jpg" alt=""></span><span class="lbl">${esc(words(h))}</span></button>`).join('')}</div>
      <div class="cr-swatches" data-group="hairColor">${HAIR_COLORS.map(([c, n]) =>
        `<button data-v="${c}" title="${n}" style="--c:${c}" class="${st.hairColor === c ? 'active' : ''}"></button>`).join('')}</div>`;
  }

  _eyes() {
    const cr = this.creator, st = this.state;
    return `<h2>Eyes</h2>
      <div class="cr-swatches big" data-group="eyes">${cr.eyeColors.map(e =>
        `<button data-v="${e.id}" title="${esc(e.label)}" style="--c:${e.swatch}" class="${st.eyes === e.id ? 'active' : ''}"><img src="${ASSETS}eyes/${e.id}.jpg" alt=""><span>${esc(e.label)}</span></button>`).join('')}</div>`;
  }

  _fit() {
    const st = this.state;
    return `<h2>Fit</h2>
      <div class="cr-list" data-group="outfit">${this.outfits.map(o =>
        `<button data-v="${esc(o)}" class="${st.outfit === o ? 'active' : ''}">${esc(pretty(o))}</button>`).join('')}</div>`;
  }

  _stance() {
    const s = this.o.getStance();
    return `<h2>Stance</h2>
      <div class="cr-stance" data-group="stance">
        <button data-v="regular" class="${s === 'regular' ? 'active' : ''}"><b>Regular</b><span>left foot forward</span></button>
        <button data-v="goofy" class="${s === 'goofy' ? 'active' : ''}"><b>Goofy</b><span>right foot forward</span></button>
      </div>
      <div class="cr-note">Flicks mirror with your stance. Old-school board, no nose — ride switch for fakie ollies.</div>`;
  }

  _tricks() {
    const skills = this.o.getSkills?.() || {};
    return `<h2>Bag of tricks</h2>
      <div class="cr-note">Level is pop height — and landing odds, later.</div>
      <div class="cr-skills">${Object.entries(TRICKS).map(([t, label]) =>
        `<div class="cr-skill" data-group="skill" data-trick="${t}"><span>${label}</span>${[1, 2, 3, 4, 5].map(l =>
          `<button data-v="${l}" class="${(skills[t] || 1) >= l ? 'on' : ''}"></button>`).join('')}</div>`).join('')}</div>`;
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  _wire(body, tab) {
    body.querySelector('#crName')?.addEventListener('input', (e) => { this.state.name = e.target.value.trim(); this._save(); });
    body.querySelector('#crBody')?.addEventListener('input', (e) => {
      this.state.body = +e.target.value; this.char?.setBody(this.state.body); this._save();
    });
    // Build no longer touches the face (2026-09-04 SDK), so it no longer
    // invalidates the portraits. The Face axis is the one that moves a rider.
    body.querySelector('#crHead')?.addEventListener('input', (e) => {
      this.state.head = +e.target.value; this.char?.setHead?.(this.state.head); this._save();
    });
    body.querySelector('#crHeadFollow')?.addEventListener('click', () => {
      this.state.head = null; this.char?.setHead?.(null); this._save(); this._show('rider');
    });
    for (const r of body.querySelectorAll('input[data-face]')) {
      r.addEventListener('input', (e) => {
        const v = +e.target.value;
        if (Math.abs(v) < 0.011) delete this.state.face[e.target.dataset.face]; else this.state.face[e.target.dataset.face] = v;
        this.char?.setFace(e.target.dataset.face, v);
        this._save();
      });
    }
    body.querySelector('#crFaceReset')?.addEventListener('click', () => {
      for (const k of Object.keys(this.state.face)) this.char?.setFace(k, 0);
      this.state.face = {}; this._save(); this._show('face');
    });
    for (const group of body.querySelectorAll('[data-group]')) {
      const g = group.dataset.group;
      group.addEventListener('click', async (e) => {
        const b = e.target.closest('button'); if (!b || b.disabled) return;
        const v = b.dataset.v;
        if (g === 'stance') this.o.setStance(v);
        else if (g === 'skill') this.o.setSkill?.(group.dataset.trick, +v);
        else if (g === 'faceGroup') this._faceGroup = v;
        else {
          this.state[g] = v;
          try { await this._apply(); } catch (err) { console.warn('[creator]', err); }
        }
        this._show(tab);
      });
    }
  }

  // ── the crew's portraits, shot on the rider itself ────────────────────────
  // Behind the curtain: hair off, each preset blended in and given ONE frame
  // for the SDK to composite its skin, then rendered to a small target through
  // a camera on the eye line that sees only the rider's layer. Keyed by preset
  // and build (the build reshapes the face).
  _pkey(p) { return p; }

  async _portraits() {
    const cr = this.creator, ch = this.char, THREE = this.o.THREE, r = this.o.renderer, scene = this.o.scene;
    const todo = cr.presetIds.filter(p => !this.portraits[this._pkey(p)]);
    if (!todo.length || this._shooting || !scene) return;
    this._shooting = true;
    const curtain = this.root.querySelector('.cr-curtain');
    curtain?.classList.add('down');
    const obj = ch.object3D;
    const st = this.state, touched = Object.entries(st.face);
    const bg = scene.background, fog = scene.fog;
    const W = 144, H = 176;
    const rt = new THREE.WebGLRenderTarget(W, H), px = new Uint8Array(W * H * 4);
    const cam = new THREE.PerspectiveCamera(26, W / H, 0.05, 10); cam.layers.set(PORTRAIT_LAYER);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
    try {
      await cr.preload({ presets: todo });
      if (!this.open_) return;
      obj.traverse(o => { if (o.isMesh) o.layers.enable(PORTRAIT_LAYER); });
      scene.traverse(o => { if (o.isLight) o.layers.enable(PORTRAIT_LAYER); });
      ch.setHair(null);
      ch.setHead?.(null);                       // each face as its own rider was saved, not at the player's setting
      for (const [k] of touched) ch.setFace(k, 0);
      for (const p of todo) {
        if (!this.open_) break;
        ch.setBlend({ [p]: 1 });
        await nextFrame();                                  // the skin lands on the next frame (measured)
        obj.updateWorldMatrix(true, true);
        const { target, forward } = faceOf(obj, THREE);
        cam.position.copy(target).addScaledVector(forward, 0.6); cam.position.y += 0.02;
        cam.lookAt(target);
        scene.background = new THREE.Color(0x1a1c22); scene.fog = null;
        const prevRT = r.getRenderTarget();
        r.setRenderTarget(rt); r.render(scene, cam); r.readRenderTargetPixels(rt, 0, 0, W, H, px); r.setRenderTarget(prevRT);
        scene.background = bg; scene.fog = fog;
        for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);   // GL is bottom-up
        ctx.putImageData(img, 0, 0);
        this.portraits[this._pkey(p)] = cv.toDataURL('image/jpeg', 0.82);
      }
      try { localStorage.setItem(PORTRAIT_KEY, JSON.stringify(this.portraits)); } catch { /* storage full: reshot next time */ }
    } finally {
      // everything back — the rider as the player left it
      scene.background = bg; scene.fog = fog;
      ch.setBlend({ [st.preset]: 1 });
      ch.setHead?.(st.head ?? null);
      for (const [k, v] of touched) ch.setFace(k, v);
      ch.setHair(st.hair); ch.setHairColor(st.hairColor);
      rt.dispose();
      cr.unload({ presets: todo.filter(p => p !== st.preset) });
      await nextFrame();                                    // the player's own skin is back before the curtain lifts
      curtain?.classList.remove('down');
      this._shooting = false;
      if (this.open_ && this.tab === 'rider') this._show('rider');
    }
  }
}
