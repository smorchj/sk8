// editor.js — the in-game map editor (owner, 2026-09-02: "let me create the
// map. let me place every asset"). Press M: the game pauses, the camera is
// free, a panel lists the assets. Click a prop to select it, drag it over the
// ground, Q/E rotate (Shift = 90°), [ ] scale, Delete removes, the + buttons
// add. Everything is saved to localStorage the moment it changes; "Copy JSON"
// puts the layout on the clipboard for js/park.js DEFAULT_LAYOUT.

import * as THREE from 'three';
import { MODELS, DEFAULT_LAYOUT, saveLayout } from './park.js';
import { heightAt } from './terrain.js';

export class MapEditor {
  constructor({ renderer, camera, controls, park, physics, input, setPaused, onChange }) {
    Object.assign(this, { renderer, camera, controls, park, physics, input, setPaused, onChange });
    this.on = false;
    this.selected = null;
    this.ray = new THREE.Raycaster();
    this.drag = null;
    this.box = new THREE.Box3Helper(new THREE.Box3(), 0x3d6dff);
    this.box.visible = false;
    park.group.add(this.box);
    this.panel = this._panel();
    const el = renderer.domElement;
    el.addEventListener('pointerdown', e => this._down(e));
    el.addEventListener('pointermove', e => this._move(e));
    el.addEventListener('pointerup', e => this._up(e));
    addEventListener('keydown', e => this._key(e));
  }

  toggle(force) {
    const on = force ?? !this.on;
    if (on === this.on) return;
    this.on = on;
    this.input.disabled = on;
    this.setPaused(on);
    this.controls.enabled = on;
    this.panel.style.display = on ? 'block' : 'none';
    if (on) {
      // look at the park from above the rider
      const p = this.physics.pos;
      this.camera.position.set(p.x + 10, p.y + 12, p.z - 14);
      this.controls.target.set(p.x, p.y, p.z);
      this.controls.update();
    } else {
      this._select(null);
      this.park.rebuild();
      this._save();
    }
    this._refresh();
  }

  // ── panel ────────────────────────────────────────────────────────────────
  _panel() {
    const d = document.createElement('div');
    d.id = 'mapEditor';
    d.style.cssText = 'position:fixed;top:12px;right:12px;width:260px;max-height:92vh;overflow:auto;background:rgba(18,20,26,.92);color:#e6e9ef;font:13px/1.45 system-ui,sans-serif;padding:12px 14px;border-radius:10px;z-index:30;display:none;box-shadow:0 8px 30px rgba(0,0,0,.4)';
    d.innerHTML = `
      <div style="font-weight:700;font-size:15px;margin-bottom:6px">Map editor <span style="float:right;font-weight:400;color:#8a93a3">M closes</span></div>
      <div style="color:#aab2c0;margin-bottom:8px">click = select · drag = move · Q/E rotate (Shift 90°) · [ ] scale · − / + sink / raise (Shift 20 cm) · Del removes</div>
      <div id="edAdd" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px"></div>
      <div id="edSel" style="border-top:1px solid #333a48;padding-top:8px;min-height:24px;color:#aab2c0">nothing selected</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:10px">
        <button data-act="copy">Copy JSON</button>
        <button data-act="reset">Reset to default</button>
      </div>
      <div id="edMsg" style="color:#8fd3a0;margin-top:6px;min-height:16px"></div>`;
    document.body.appendChild(d);
    const add = d.querySelector('#edAdd');
    for (const [key, spec] of Object.entries(MODELS)) {
      const b = document.createElement('button');
      b.textContent = '+ ' + spec.label;
      b.onclick = () => this._add(key);
      add.appendChild(b);
    }
    d.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'copy') this._copy();
      if (act === 'reset') { this.park.setLayout(DEFAULT_LAYOUT.map(p => ({ ...p }))); this._select(null); this._save(); }
      if (act === 'rot') this._rotate(+b.dataset.v);
      if (act === 'scale') this._scale(+b.dataset.v);
      if (act === 'sink') this._sink(+b.dataset.v);
      if (act === 'variant') this._variant();
      if (act === 'del') this._delete();
    });
    for (const b of d.querySelectorAll('button')) this._styleBtn(b);
    return d;
  }
  _styleBtn(b) {
    b.style.cssText = 'background:#2a3040;color:#e6e9ef;border:1px solid #3a4256;border-radius:6px;padding:4px 8px;font:12px system-ui,sans-serif;cursor:pointer';
  }
  _refresh() {
    const sel = this.panel.querySelector('#edSel');
    const rec = this.selected?.userData.park;
    if (!rec) { sel.innerHTML = '<span style="color:#aab2c0">nothing selected</span>'; return; }
    sel.innerHTML = `<div style="color:#fff;font-weight:600">${MODELS[rec.model].label}${rec.variant ? ' · v' + rec.variant : ''}</div>
      <div>x ${rec.x.toFixed(2)} z ${rec.z.toFixed(2)} · rot ${Math.round(rec.rot || 0)}° · scale ${(rec.scale).toFixed(2)} · sink ${(rec.sink || 0).toFixed(2)} m</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
        <button data-act="rot" data-v="-15">⟲ 15°</button><button data-act="rot" data-v="15">⟳ 15°</button>
        <button data-act="rot" data-v="-90">⟲ 90°</button><button data-act="rot" data-v="90">⟳ 90°</button>
        <button data-act="scale" data-v="-0.1">smaller</button><button data-act="scale" data-v="0.1">bigger</button>
        <button data-act="sink" data-v="0.05">sink 5 cm</button><button data-act="sink" data-v="-0.05">raise 5 cm</button>
        ${MODELS[rec.model].qp ? '<button data-act="variant">next graffiti</button>' : ''}
        <button data-act="del" style="color:#ff9a9a">delete</button>
      </div>`;
    for (const b of sel.querySelectorAll('button')) this._styleBtn(b);
  }
  _msg(t) { this.panel.querySelector('#edMsg').textContent = t; setTimeout(() => { if (this.panel.querySelector('#edMsg').textContent === t) this.panel.querySelector('#edMsg').textContent = ''; }, 2500); }

  // ── edits ────────────────────────────────────────────────────────────────
  _add(model) {
    const spec = MODELS[model];
    const t = this.controls.target;
    const rec = { model, x: +t.x.toFixed(2), z: +t.z.toFixed(2), rot: 0, scale: spec.scale, sink: spec.sink || 0 };
    if (spec.qp) rec.variant = 1 + Math.floor(Math.random() * spec.variants);
    const obj = this.park.placeProp(rec);
    this._select(obj);
    this._changed();
  }
  _delete() {
    if (!this.selected) return;
    this.park.removeProp(this.selected);
    this._select(null);
    this._changed();
  }
  _rotate(deg) {
    const rec = this.selected?.userData.park;
    if (!rec) return;
    rec.rot = ((rec.rot || 0) + deg + 360) % 360;
    this.park.placeProp(rec);
    this._changed();
  }
  _scale(d) {
    const rec = this.selected?.userData.park;
    if (!rec) return;
    rec.scale = +Math.max(0.3, Math.min(12, rec.scale + d)).toFixed(2);
    this.park.placeProp(rec);
    this._changed();
  }
  // vertical offset: how far the prop is pushed into the ground (owner,
  // 2026-09-03: the halfpipe's base needed to go further down and there was
  // no way). Positive = lower. Saved with the layout like everything else.
  _sink(d) {
    const rec = this.selected?.userData.park;
    if (!rec) return;
    rec.sink = +Math.max(-3, Math.min(3, (rec.sink || 0) + d)).toFixed(2);
    this.park.placeProp(rec);
    this._changed();
  }
  _variant() {
    const rec = this.selected?.userData.park;
    if (!rec || !MODELS[rec.model].qp) return;
    rec.variant = (rec.variant % MODELS[rec.model].variants) + 1;
    this.park.placeProp(rec);
    this._changed();
  }
  _changed() {
    this._save();
    this._refresh();
    this._frame();
  }
  _save() {
    saveLayout(this.park.getLayout());
    this.onChange?.();
  }
  _copy() {
    const json = JSON.stringify(this.park.getLayout(), null, 1);
    navigator.clipboard?.writeText(json).then(() => this._msg('layout JSON copied'), () => this._msg('clipboard blocked — see console'));
    console.log('[sk8] layout JSON:\n' + json);
  }
  _select(obj) {
    this.selected = obj;
    this.box.visible = !!obj;
    this._frame();
    this._refresh();
  }
  _frame() {
    if (!this.selected) return;
    this.selected.updateWorldMatrix(true, true);
    this.box.box.setFromObject(this.selected);
  }

  // ── mouse ────────────────────────────────────────────────────────────────
  _ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  _pick(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const hits = this.ray.intersectObjects(this.park.props, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.park) o = o.parent;
      if (o) return o;
    }
    return null;
  }
  _groundPoint(e, y) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(plane, p) ? p : null;
  }
  _down(e) {
    if (!this.on || e.button !== 0) return;
    const obj = this._pick(e);
    this._select(obj);
    if (obj) {
      const rec = obj.userData.park;
      const gp = this._groundPoint(e, heightAt(rec.x, rec.z));
      this.drag = { obj, off: gp ? new THREE.Vector3(rec.x - gp.x, 0, rec.z - gp.z) : new THREE.Vector3(), y: heightAt(rec.x, rec.z) };
      this.controls.enabled = false;
    }
  }
  _move(e) {
    if (!this.on || !this.drag) return;
    const gp = this._groundPoint(e, this.drag.y);
    if (!gp) return;
    const rec = this.drag.obj.userData.park;
    rec.x = +(gp.x + this.drag.off.x).toFixed(2);
    rec.z = +(gp.z + this.drag.off.z).toFixed(2);
    this.park.placeProp(rec);
    this._frame();
    this._refresh();
  }
  _up() {
    if (!this.on) return;
    if (this.drag) { this.drag = null; this.controls.enabled = true; this._changed(); }
  }
  _key(e) {
    if (e.key.toLowerCase() === 'm' && !e.repeat) { this.toggle(); return; }
    if (!this.on) return;
    const k = e.key.toLowerCase();
    if (k === 'q') this._rotate(e.shiftKey ? -90 : -15);
    if (k === 'e') this._rotate(e.shiftKey ? 90 : 15);
    if (k === '[') this._scale(-0.1);
    if (k === ']') this._scale(0.1);
    const step = e.shiftKey ? 0.2 : 0.05;
    if (k === '-' || k === 'pagedown') this._sink(step);        // lower
    if (k === '+' || k === '=' || k === 'pageup') this._sink(-step);   // raise
    if (k === 'delete' || k === 'backspace') this._delete();
    if (k === 'escape') this._select(null);
  }
}
