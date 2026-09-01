// creator.js — the in-game character creator, built on creategamecharacters.ai's
// embedded SDK (self-hosted copy in assets/creator/sdk/v1.js; assets fetched at
// build time with tools/fetch-assets.mjs). The game owns every pixel of this UI;
// the SDK owns the character. Stance (regular/goofy) lives HERE because the
// owner wants riders to pick it in the character creator — it is part of who
// your skater is, and the whole animation/input pipeline mirrors around it.

const PROJECT_KEY = 'ggc_proj_8jmuxeXblEF5oa59vumsjBDqbR7C3Xvz-1vrhFv-mDM';
const ASSETS = 'assets/creator-min/';   // plain-optimized bundle (tools/optimize-plain.mjs)
const SAVE_KEY = 'sk8rider';

const HAIR_COLORS = ['#151210', '#3b2a1d', '#6b4a2b', '#a97f4f', '#d9b380', '#b03030', '#888c92'];

// This repo is the MECHANICS demo — skate-themed clothing only (owner,
// 2026-09-01). The period outfits belong to the story game, not here.
const OUTFIT_ALLOW = /crop-top|casual|prison/i;

const pretty = (id) => String(id).replace(/^((mars|venus)__)/, '').replace(/_/g, ' ');

export class RiderCreator {
  constructor(opts) {
    this.o = opts;      // {THREE, GLTFLoader, renderer, ktx2Loader, meshoptDecoder,
                        //  getStance, setStance, onCharacter, onDone}
    this.panel = document.getElementById('creatorPanel');
    this.creator = null;
    this.char = null;
    this.state = { preset: null, hair: null, outfit: null, body: 0.5, hairColor: '#3b2a1d' };
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (saved) this.state = { ...this.state, ...saved };
    } catch { /* fresh rider */ }
  }

  _save() { localStorage.setItem(SAVE_KEY, JSON.stringify(this.state)); }

  async _ensureSDK() {
    if (this.creator) return this.creator;
    const { Creator } = await import('../assets/creator/sdk/v1.js');
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

  // spawn (or respawn) the character from this.state and hand it to the game
  async _apply() {
    const cr = await this._ensureSDK();
    const outfits = cr.outfitIds.filter(o => OUTFIT_ALLOW.test(o));
    if (!this.state.preset && cr.presetIds.length) this.state.preset = cr.presetIds[0];
    if (!this.state.hair && cr.hairIds.length) this.state.hair = cr.hairIds[0];
    if (this.state.outfit && !OUTFIT_ALLOW.test(this.state.outfit)) this.state.outfit = null;
    if (!this.state.outfit && outfits.length) {
      this.state.outfit = outfits.find(o => /casual/i.test(o)) || outfits[0];
    }
    if (!this.char) {
      this.char = cr.spawn({ body: this.state.body });
      await this.o.onCharacter(this.char.object3D, this.char);   // game wiring (rig, clip bake) must finish
    }
    const c = this.char;
    c.setBody(this.state.body);
    if (this.state.preset) c.setBlend({ [this.state.preset]: 1 });
    if (this.state.hair) c.setHair(this.state.hair);
    c.setHairColor(this.state.hairColor);
    if (this.state.outfit) c.setOutfit(this.state.outfit);
    this._save();
  }

  // try to restore a saved rider silently at boot (no panel)
  async restore() {
    if (!localStorage.getItem(SAVE_KEY)) return false;
    try {
      await this._apply();
      this.o.onDone?.();
      return true;
    } catch (e) {
      console.warn('[creator] restore failed, keeping fallback rider:', e.message);
      return false;
    }
  }

  async open() {
    this.panel.classList.add('open');
    this.panel.innerHTML = `<button id="creatorClose">✕</button>
      <h3>Loading creator…</h3>
      <div class="note">validating project key + fetching character assets</div>`;
    this.panel.querySelector('#creatorClose').onclick = () => this.close();
    try {
      await this._apply();
      this._render();
    } catch (e) {
      this.panel.innerHTML = `<button id="creatorClose">✕</button>
        <h3>Creator unavailable</h3>
        <div class="note">${e.message}</div>
        <div class="note">The dev server must run on http://127.0.0.1:5101 (project origin lock).</div>`;
      this.panel.querySelector('#creatorClose').onclick = () => this.close();
    }
  }

  close() {
    this.panel.classList.remove('open');
    this.o.onDone?.();
  }

  _render() {
    const cr = this.creator;
    const st = this.state;
    const stance = this.o.getStance();
    const rows = [];

    rows.push(`<button id="creatorClose">✕</button>`);
    rows.push(`<h3>Stance</h3><div class="row" data-group="stance">
      <button data-v="regular" class="${stance === 'regular' ? 'active' : ''}">Regular (left foot front)</button>
      <button data-v="goofy" class="${stance === 'goofy' ? 'active' : ''}">Goofy (right foot front)</button>
    </div>
    <div class="note">Flick controls mirror with your stance. Old-school board: no nollies — ride switch for fakie ollies.</div>`);

    rows.push(`<h3>Rider</h3><div class="row" data-group="preset">${cr.presetIds.map(p =>
      `<button data-v="${p}" class="${st.preset === p ? 'active' : ''}">${pretty(p)}</button>`).join('')}</div>`);

    rows.push(`<h3>Body</h3><input type="range" id="bodyRange" min="0" max="1" step="0.01" value="${st.body}">`);

    rows.push(`<h3>Hair</h3><div class="row" data-group="hair">${cr.hairIds.map(h =>
      `<button data-v="${h}" class="${st.hair === h ? 'active' : ''}">${pretty(h)}</button>`).join('')}</div>`);

    rows.push(`<div class="row" data-group="hairColor" style="margin-top:6px">${HAIR_COLORS.map(c =>
      `<button data-v="${c}" title="${c}" style="width:26px;height:26px;background:${c};${st.hairColor === c ? 'outline:2px solid #3d6dff;' : ''}"></button>`).join('')}</div>`);

    rows.push(`<h3>Outfit</h3><div class="row" data-group="outfit">${cr.outfitIds.filter(o => OUTFIT_ALLOW.test(o)).map(o =>
      `<button data-v="${o}" class="${st.outfit === o ? 'active' : ''}">${pretty(o)}</button>`).join('')}</div>`);

    if (this.o.getSkills) {
      const skills = this.o.getSkills();
      const label = { ollie: 'Ollie', kickflip: 'Kickflip', heelflip: 'Heelflip', treflip: '360 Flip', impossible: 'Impossible' };
      rows.push(`<h3>Skills</h3><div class="note" style="margin-bottom:6px">Level = pop height (and landing odds, later)</div>` +
        Object.keys(label).map(t =>
          `<div class="row" data-group="skill" data-trick="${t}" style="align-items:center;margin-bottom:4px">
            <span style="width:76px;color:#aab2c0">${label[t]}</span>
            ${[1, 2, 3, 4, 5].map(l =>
              `<button data-v="${l}" style="width:30px" class="${(skills[t] || 1) === l ? 'active' : ''}">${l}</button>`).join('')}
          </div>`).join(''));
    }

    rows.push(`<button class="big" id="creatorDone" style="margin-top:16px">Skate ▸</button>`);
    rows.push(`<div class="credit">Powered by creategamecharacters.com</div>`);
    this.panel.innerHTML = rows.join('');

    this.panel.querySelector('#creatorClose').onclick = () => this.close();
    this.panel.querySelector('#creatorDone').onclick = () => this.close();
    this.panel.querySelector('#bodyRange').oninput = (e) => {
      this.state.body = +e.target.value;
      this.char?.setBody(this.state.body);
      this._save();
    };
    for (const group of this.panel.querySelectorAll('[data-group]')) {
      const g = group.dataset.group;
      group.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const v = b.dataset.v;
        if (g === 'stance') {
          this.o.setStance(v);
        } else if (g === 'skill') {
          this.o.setSkill?.(group.dataset.trick, +v);
        } else {
          this.state[g] = v;
          try { await this._apply(); } catch (err) { console.warn('[creator]', err); }
        }
        this._render();
      });
    }
  }
}
