// LOCAL AGENT SCRIPT — skate-specific solving. NOT app code, NEVER shipped, NEVER
// uploads anything (owner boundary, 2026-08-18: the Animation Tool stays a GENERALIZED
// editor; sport/trick knowledge is the agent's, injected locally through public verbs).
//
// v2 — TAG-DRIVEN (owner, 2026-08-18): the hand-tagged action tags on the take
// (pop / flick / catch / land, tagged from the footage by eye and corrected by the
// owner) are AUTHORITATIVE. Detected flight windows are only the fallback when a
// take carries no tags. Event semantics on this rider's kickflip (kickflip2.mp4):
//   pop   — tail STRIKES the ground (f33 1.375s src)
//   flick — front foot leaves the nose; roll starts; board fully airborne (f40 1.667s)
//   catch — BACK FOOT takes the board, rotation dead, can be very low (f150 6.250s)
//   land  — front wheels touch (f160 6.667s)
// Usage: eval in the Pose Studio page (local dev), then:
//   skate.solveKickflip(idx)   — board keys phased by the tags; emits mocap.trick
//   skate.clearBoard(idx)      — root lift so feet clear the flipping board (flick..catch)
//   skate.flightWindow(idx)    — measurement-series fallback window (no tags)
// Everything below uses ONLY window.poseStudio verbs + the exposed timeline/anim.

window.skate = (() => {
  const ps = window.poseStudio;

  const srcToTake = (L, s) => {
    const m = L.clip.mocap?.src;
    if (!m || m.length < 2) return s;
    if (s <= m[0][1]) return m[0][0];
    if (s >= m[m.length - 1][1]) return m[m.length - 1][0];
    let i = 1; while (m[i][1] < s) i++;
    const a = m[i - 1], b = m[i], f = (s - a[1]) / ((b[1] - a[1]) || 1);
    return a[0] + (b[0] - a[0]) * f;
  };

  // the four event times from the take's action tags (take clock); null if absent
  const tagTimes = (idx) => {
    const tags = ps.actionTags(idx);
    const at = (nm) => tags.find((g) => g.name === nm)?.t;
    const ev = { pop: at('pop'), flick: at('flick'), catch: at('catch'), land: at('land') };
    return (ev.pop != null && ev.flick != null && ev.catch != null && ev.land != null) ? ev : null;
  };

  const flightWindow = (idx = ps.timeline.layers.length - 1) => {
    const L = ps.timeline.layers[idx];
    const mc = L?.clip?.mocap;
    const det = mc?.det?.length ? mc.det : (mc?.board || []);
    if (!mc || det.length < 9) return null;
    const cys = det.map((k) => k.cy).sort((a, b) => a - b);
    const base = cys[Math.floor(cys.length * 0.8)];
    const thresh = Math.max(18, 0.12 * (base - cys[0]));
    const up = det.filter((k) => k.cy < base - thresh);
    if (up.length < 3) return null;
    const lag = 0.10;
    return { t0: +srcToTake(L, up[0].t - lag).toFixed(3),
             t1: +srcToTake(L, up[up.length - 1].t + 0.06).toFixed(3) };
  };

  const qMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const qAxis = (x, y, z, ang) => { const s = Math.sin(ang / 2); return [x * s, y * s, z * s, Math.cos(ang / 2)]; };

  // kickflip board from the TAGS. Phases:
  //   [pop-tilt, pop]   nose-up tilt grows, tail drops to the ground (strike at pop)
  //   [pop, flick]      tail-pivot launch: pitch to max, board leaves the ground
  //   [flick, catch]    airborne: xz linear to the landing point, y on an arc matched
  //                     to the TAKE's own clock (g from analyzeTake's flight fit — the
  //                     board must share the character's implied gravity, not real-time
  //                     9.81 over a slowmo clock), ONE full roll about the long axis,
  //                     pitch decays to slightly nose-down at the catch
  //   [catch, land]     caught: griptape up, pitch settles level, descends to wheels-down
  //   elsewhere         flat under mid-feet, yaw from the feet line (nose = travel)
  // airGapBase/airGapPeak: board-to-sole distance through the flight. A kickflip floats
  // the board BELOW the flicked feet (base 5cm, peak 25cm mid-roll); an OLLIE is the
  // same solve with rolls:0 and the board GLUED to the soles (base+peak ≈ 0).
  const solveKickflip = (idx = ps.timeline.layers.length - 1,
                         { stance = null, rolls = 1, boardHalf = 0.07, popPitch = 0.85, catchPitch = -0.09,
                           airGapBase = 0.05, airGapPeak = 0.20, noseFlip = true, straight = true, headingDeg = null } = {}) => {
    const tl = ps.timeline;
    const L = tl.layers[idx];
    const tag = 'skateboard';
    if (!L || !(L.clip.hips && L.clip.hips.length)) return null;
    if (stance !== 'regular' && stance !== 'goofy')
      return { error: "stance is REQUIRED ('regular'|'goofy') — clock it from the footage (STANCE LAW, SKATE.md)" };
    const ev = tagTimes(idx);
    if (!ev) return { error: 'no pop/flick/catch/land tags on this layer — tag them first' };

    const samples = [];
    for (const hk of L.clip.hips) {
      ps.seek(hk[0]); window.__ctlPoseStep?.(8);
      const flp = ps.anim.cpos('FootL'), frp = ps.anim.cpos('FootR');
      samples.push({ t: hk[0], flp: { x: flp.x, y: flp.y, z: flp.z }, frp: { x: frp.x, y: frp.y, z: frp.z } });
    }
    const near = (t) => samples.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));

    // STANCE LAW (owner): board direction derives from the STANCE, never from travel
    // and never from a sign-ambiguous feet line. Regular = left foot forward, so nose
    // direction = LEFT foot minus RIGHT foot; goofy is the mirror. Per sample, no
    // unwrap ambiguity left to guess; feet-together frames hold the previous heading.
    const frontKey = stance === 'regular' ? 'flp' : 'frp';
    const backKey0 = stance === 'regular' ? 'frp' : 'flp';
    let prev = null;
    for (const s of samples) {
      const dx = s[frontKey].x - s[backKey0].x, dz = s[frontKey].z - s[backKey0].z;
      s.yaw = Math.hypot(dx, dz) > 0.12 ? Math.atan2(dx, dz) : (prev ?? 0);
      prev = s.yaw;
    }
    const sP = near(ev.pop);
    // THE LINE'S HEADING IS THE RIDER'S OWN TRAVEL PATH (owner: 'rider is going
    // perfectly in the direction of the red arrow — fix the board'). The captured
    // feet-line yaw is noisy and lied twice; the hips path is the truth for a rolling
    // straight-line trick. Nose = travel for regular riding (switch flips this later).
    // Fallback for a true standstill: circular mean of the ride-in stance heading.
    const H0 = L.clip.hips;
    const hdx = H0[H0.length - 1][1] - H0[0][1], hdz = H0[H0.length - 1][3] - H0[0][3];
    let yawP;
    if (headingDeg != null) {
      yawP = headingDeg * Math.PI / 180;   // explicit heading — the owner's line wins over every estimate
    } else if (Math.hypot(hdx, hdz) > 0.4) {
      yawP = Math.atan2(hdx, hdz);
    } else {
      const rideS = samples.filter((s2) => s2.t < ev.pop - 0.25);
      let sy = 0, cy = 0;
      for (const s2 of (rideS.length >= 5 ? rideS : samples)) { sy += Math.sin(s2.yaw); cy += Math.cos(s2.yaw); }
      yawP = Math.atan2(sy, cy);
    }
    // STRAIGHT-LINE LAW (owner): an ollie is pop→flick and nothing else — one heading,
    // one line; every board position projects onto the line through the tail.
    if (straight) for (const s2 of samples) s2.yaw = yawP;
    // THIS BOARD MODEL'S visual nose points −Z (old-school deck, definite kicktail —
    // owner: nose and tail are NOT interchangeable). A constant half-turn about the
    // board's OWN up axis, post-multiplied, swaps the visual ends without touching the
    // world pitch/roll/pivot. noseFlip:false for a model whose +Z is the nose.
    const MF = noseFlip ? qAxis(0, 1, 0, Math.PI) : null;
    const finish = (q) => (MF ? qMul(q, MF) : q);

    const midP = { x: (sP.flp.x + sP.frp.x) / 2, z: (sP.flp.z + sP.frp.z) / 2 };
    // the tail is UNDER THE BACK FOOT — the STANCE names it, no projection guessing
    const backP = sP[backKey0];
    const tail = { x: backP.x - Math.sin(yawP) * 0.065, y: boardHalf, z: backP.z - Math.cos(yawP) * 0.065 };  // tip behind the foot: back foot rides the TAIL POCKET
    const lineProj = (x, z) => {
      if (!straight) return { x, z };
      const d = (x - tail.x) * Math.sin(yawP) + (z - tail.z) * Math.cos(yawP);
      return { x: tail.x + Math.sin(yawP) * d, z: tail.z + Math.cos(yawP) * d };
    };
    const tiltDur = Math.max(0.03, 0.6 * (ev.flick - ev.pop));   // tilt onset before the strike
    const strikePitch = 0.55;                                     // deck angle AT the strike (video: ~32deg)
    // board center when the nose-up pitch is th, pivoting on the tail
    const pivotAt = (th) => ({ x: tail.x + Math.sin(yawP) * 0.385 * Math.cos(th),
                               y: tail.y + 0.385 * Math.sin(th),
                               z: tail.z + Math.cos(yawP) * 0.385 * Math.cos(th) });
    const p0 = pivotAt(popPitch);                                 // launch state at flick
    const sL = near(ev.land);
    const P1 = { x: (sL.flp.x + sL.frp.x) / 2, y: boardHalf, z: (sL.flp.z + sL.frp.z) / 2 };
    const Tair = Math.max(1e-3, ev.land - ev.flick);
    const vxz = { x: (P1.x - p0.x) / Tair, z: (P1.z - p0.z) / Tair };
    // VERTICAL: the CHARACTER is the clock and the reference — the board rides just
    // below the feet through the flip (video truth: air between them, board tracking
    // the rider), meets them at the catch, wheels-down at the land. No independent
    // physics arc on a take clock (a real-g parabola over a slowmo span flew the board
    // 1.6m over the rider). Blend from the pivot's end into the follow curve.
    const footMinAt = (s) => Math.min(s.flp.y, s.frp.y) - 0.10;   // sole
    const yOf = (s) => {
      const t = s.t;
      const fm = footMinAt(s);
      let y;
      if (t < ev.catch) {
        const uC = (t - ev.flick) / Math.max(1e-3, ev.catch - ev.flick);
        const gap = airGapBase + airGapPeak * Math.sin(Math.PI * Math.min(1, uC));
        y = fm - gap;
        const uB = Math.min(1, (t - ev.flick) / (0.25 * Math.max(1e-3, ev.catch - ev.flick)));
        y = p0.y * (1 - uB) + y * uB;                              // ease out of the pivot
      } else {
        const uL = (t - ev.catch) / Math.max(1e-3, ev.land - ev.catch);
        y = (fm - 0.045) * (1 - uL) + boardHalf * uL;              // glued under the soles, down to wheels
      }
      return Math.max(boardHalf, y);
    };

    const keys = [];
    for (const s of samples) {
      const t = s.t;
      // STANCE SETUP LAW (owner): riding, the BACK FOOT is on the tail pocket and the
      // front foot ~mid-board — the board sits FORWARD of the stance, never centered
      // under it. (A nollie setup mirrors this onto the nose — future anchor option.)
      const bf = s[backKey0];
      const ctr = lineProj(bf.x + Math.sin(s.yaw) * 0.32, bf.z + Math.cos(s.yaw) * 0.32);
      const qY = finish(qAxis(0, 1, 0, s.yaw));              // the continuous series — never snaps
      if (t < ev.pop - tiltDur || t > ev.land + 0.02) {
        keys.push([+t.toFixed(3), +ctr.x.toFixed(5), boardHalf, +ctr.z.toFixed(5), ...qY.map((v) => +v.toFixed(5))]);
      } else if (t < ev.pop) {
        // tilt: nose rises toward the strike angle, wheels still down (tail sinking)
        const u = (t - (ev.pop - tiltDur)) / tiltDur;
        const th = strikePitch * u * u;
        const c = pivotAt(th);
        const q = finish(qMul(qAxis(0, 1, 0, yawP), qAxis(1, 0, 0, -th)));
        keys.push([+t.toFixed(3), +c.x.toFixed(5), +c.y.toFixed(5), +c.z.toFixed(5), ...q.map((v) => +v.toFixed(5))]);
      } else if (t < ev.flick) {
        // pop → flick: tail-pivot launch, strike angle → max pitch
        const u = (t - ev.pop) / (ev.flick - ev.pop);
        const th = strikePitch + (popPitch - strikePitch) * u;
        const c = pivotAt(th);
        const q = finish(qMul(qAxis(0, 1, 0, yawP), qAxis(1, 0, 0, -th)));
        keys.push([+t.toFixed(3), +c.x.toFixed(5), +c.y.toFixed(5), +c.z.toFixed(5), ...q.map((v) => +v.toFixed(5))]);
      } else if (airGapPeak < 0.05) {
        // GLUED FLIGHT (ollie family — owner: "deck stays attached to BOTH feet"):
        // the deck IS a function of the two feet. Pitch = the back-sole → front-sole
        // line; the deck's top surface passes through the soles; xz anchored so the
        // back sole rides the tail pocket. The capture's own feet carry the attitude —
        // no synthetic pitch profile, nothing to detach. Blend out of the pivot's end
        // state over the first slice of flight so the handoff cannot step.
        const bS = { x: s[backKey0].x, y: s[backKey0].y - 0.10, z: s[backKey0].z };
        const fS = { x: s[frontKey].x, y: s[frontKey].y - 0.10, z: s[frontKey].z };
        const dxz = Math.max(0.15, Math.hypot(fS.x - bS.x, fS.z - bS.z));
        let th = Math.atan2(fS.y - bS.y, dxz);                 // nose-up positive
        th = Math.max(-0.25, Math.min(1.1, th));
        const cw0 = lineProj((bS.x + fS.x) / 2 + Math.sin(s.yaw) * 0.06, (bS.z + fS.z) / 2 + Math.cos(s.yaw) * 0.06);
        const cxw = cw0.x, czw = cw0.z;
        const cyw = Math.max(boardHalf, (bS.y + fS.y) / 2 - 0.085);  // deck a touch lower: the low foot must never read under the face
        const uB = Math.min(1, (t - ev.flick) / Math.max(1e-3, 0.05 * (ev.land - ev.flick)));  // snap to feet-derived — a long blend mixed two deck poses and sank the soles
        const pv = pivotAt(popPitch);
        const px = pv.x * (1 - uB) + cxw * uB, py = pv.y * (1 - uB) + cyw * uB, pz = pv.z * (1 - uB) + czw * uB;
        const thB = popPitch * (1 - uB) + th * uB;
        const q = finish(qMul(qAxis(0, 1, 0, s.yaw), qAxis(1, 0, 0, -thB)));
        keys.push([+t.toFixed(3), +px.toFixed(5), +py.toFixed(5), +pz.toFixed(5), ...q.map((v) => +v.toFixed(5))]);
      } else {
        // airborne (flick → land), FREE flight (flip tricks). Roll only until the
        // CATCH; pitch: max → catchPitch at the catch → level at land. Yaw frozen.
        const tau = t - ev.flick;
        const px = p0.x + vxz.x * tau;
        const pz = p0.z + vxz.z * tau;
        const py = yOf(s);
        const uC = Math.min(1, tau / Math.max(1e-3, ev.catch - ev.flick));
        const roll = rolls * 2 * Math.PI * uC;                       // full turn exactly at catch
        let th;
        if (t < ev.catch) th = popPitch * Math.pow(1 - uC, 1.4) + catchPitch * uC;
        else th = catchPitch * (1 - (t - ev.catch) / Math.max(1e-3, ev.land - ev.catch));
        const q = finish(qMul(qMul(qAxis(0, 1, 0, yawP), qAxis(1, 0, 0, -th)), qAxis(0, 0, 1, roll)));
        keys.push([+t.toFixed(3), +px.toFixed(5), +py.toFixed(5), +pz.toFixed(5), ...q.map((v) => +v.toFixed(5))]);
      }
    }
    (L.clip.props ??= {})[tag] = keys;
    L.clip.mocap.trick = {
      type: 'kickflip', clock: 'take',
      pop: { t: ev.pop, strikePitchDeg: +(strikePitch * 57.3).toFixed(0) },
      flick: { t: ev.flick, axis: 'long', rolls, maxPitchDeg: +(popPitch * 57.3).toFixed(0),
               omegaDegS: +(rolls * 360 / Math.max(1e-3, ev.catch - ev.flick)).toFixed(0) },
      catch: { t: ev.catch }, land: { t: ev.land, pos: [P1.x, boardHalf, P1.z].map((v) => +v.toFixed(3)) },
    };
    ps.seek(tl.t);
    return { keys: keys.length, ev, trick: L.clip.mocap.trick };
  };

  // FEET CLEAR THE FLIPPING BOARD — only while it flips (flick → catch); at the catch
  // the feet are SUPPOSED to touch it. Root lift per hips key, smoothed.
  const clearBoard = (idx = ps.timeline.layers.length - 1, { gap = 0.06, tag = 'skateboard' } = {}) => {
    const L = ps.timeline.layers[idx];
    const ev = tagTimes(idx);
    const track = (L.clip.props || {})[tag];
    if (!L || !ev || !track?.length) return null;
    const boardAt = (t) => {
      let i = 1; while (i < track.length && track[i][0] < t) i++;
      const a = track[Math.max(0, i - 1)], b = track[Math.min(track.length - 1, i)];
      const f = (t - a[0]) / ((b[0] - a[0]) || 1);
      return a[2] + (b[2] - a[2]) * Math.min(1, Math.max(0, f)) + 0.07;   // center→deck top
    };
    const H = L.clip.hips;
    const lifts = new Array(H.length).fill(0);
    // clearance is a MID-FLIP rule: at the flick the back foot is legitimately BELOW
    // the steep board (video: it just dropped off the tail), and at the catch the feet
    // meet the deck. Only the middle of the roll demands air under the soles.
    const w0 = ev.flick + 0.25 * (ev.catch - ev.flick), w1 = ev.catch - 0.05 * (ev.catch - ev.flick);
    for (let i = 0; i < H.length; i++) {
      const t = H[i][0];
      if (t < w0 || t > w1) continue;
      ps.seek(t);
      const footMin = Math.min(ps.anim.cpos('FootL').y, ps.anim.cpos('FootR').y) - 0.10; // sole
      lifts[i] = Math.max(0, boardAt(t) + gap - footMin);
    }
    for (let pass = 0; pass < 2; pass++)
      for (let i = 1; i < lifts.length - 1; i++)
        lifts[i] = Math.max(lifts[i], (lifts[i - 1] + lifts[i + 1]) / 2 * 0.9);
    // SANITY CAP: a lift beyond ~25cm means the SOLVE is wrong (a 1.57m root chase
    // shipped once) — bail loudly instead of wrecking the root motion.
    const maxNeeded = Math.max(...lifts);
    if (maxNeeded > 0.25) { ps.seek(ps.timeline.t); return { error: 'lift ' + maxNeeded.toFixed(2) + 'm — solve is wrong, refusing' }; }
    let applied = 0, maxL = 0;
    for (let i = 0; i < H.length; i++) if (lifts[i] > 0.002) {
      H[i][2] = +(H[i][2] + lifts[i]).toFixed(5);
      applied++; maxL = Math.max(maxL, lifts[i]);
    }
    ps.seek(ps.timeline.t);
    return { applied, maxLift: +maxL.toFixed(3) };
  };

  // FEET ON THE DECK (owner: "understand the 3D board and where the foot actually
  // should be on it… u are allowed to use IK in correctional layers"). The solved board
  // track IS the contact truth: at each key moment in the CONTACT windows, read the
  // board's 6-DOF pose, compute each foot's point ON the deck top in board-local
  // coordinates (stance measured from a flat-riding base frame; the front foot slides
  // to the nose through the pop — the flick), place the ankles by IK on an OVERRIDE
  // layer masked to Legs, orient the feet with the deck, key it. Flight stays capture.
  const feetPass = async (idx = ps.timeline.layers.length - 1,
                          { solePad = 0.10, deckTop = 0.075, tag = 'skateboard', baseT = 0.60 } = {}) => {
    const L = ps.timeline.layers[idx];
    const ev = tagTimes(idx);
    const track = L?.clip.props?.[tag];
    if (!L || !ev || !track?.length) return { error: 'need tags + a solved board track' };
    // pump the pose evaluation directly — rAF is SUSPENDED in background tabs (app law:
    // "DRIVE THE POSE HERE, do not rely on the animation loop"); __ctlPoseStep settles
    // the eased quantities exactly like the capture dump does
    const raf2 = () => { window.__ctlPoseStep?.(8); return Promise.resolve(); };
    const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
    const rot = (q, v) => {                                  // rotate vec by quat
      const [x, y, z, w] = q, [vx, vy, vz] = v;
      const ux = 2 * (y * vz - z * vy), uy = 2 * (z * vx - x * vz), uz = 2 * (x * vy - y * vx);
      return [vx + w * ux + (y * uz - z * uy), vy + w * uy + (z * ux - x * uz), vz + w * uz + (x * uy - y * ux)];
    };
    const boardAt = (t) => {                                 // nearest key (30fps dense)
      let i = 0; while (i < track.length - 1 && track[i + 1][0] <= t) i++;
      const k = (i < track.length - 1 && Math.abs(track[i + 1][0] - t) < Math.abs(track[i][0] - t)) ? track[i + 1] : track[i];
      return { p: [k[1], k[2], k[3]], q: [k[4], k[5], k[6], k[7]] };
    };
    const bones = ps.anim.rig.bones;
    const wq = (n) => { const b = bones.get(n); const q = b.getWorldQuaternion(new b.quaternion.constructor()); return [q.x, q.y, q.z, q.w]; };
    const wp = (n) => { const p = ps.anim.cpos(n); return [p.x, p.y, p.z]; };
    // base frame: each foot's board-local stance (lateral x, along z) + deck-relative quat
    ps.seek(baseT); await raf2();
    const b0 = boardAt(baseT);
    const base = {};
    for (const f of ['L', 'R']) {
      const local = rot(qConj(b0.q), [wp('Foot' + f)[0] - b0.p[0], 0, wp('Foot' + f)[2] - b0.p[2]]);
      base[f] = { x: local[0], z: local[2], rel: qMul(qConj(b0.q), wq('Foot' + f)) };
    }
    // back foot = the one trailing the ground-roll TRAVEL at the pop (hips displacement)
    const hipAt = (t) => L.clip.hips.reduce((a, k) => (Math.abs(k[0] - t) < Math.abs(a[0] - t) ? k : a));
    const h1 = hipAt(ev.pop), h0 = hipAt(ev.pop - 0.5);
    const tv = [h1[1] - h0[1], h1[3] - h0[3]];               // world xz travel
    ps.seek(ev.pop); await raf2();
    const pL = wp('FootL'), pR = wp('FootR');
    const backF = (pL[0] * tv[0] + pL[2] * tv[1]) < (pR[0] * tv[0] + pR[2] * tv[1]) ? 'L' : 'R';
    const frontF = backF === 'L' ? 'R' : 'L';
    // the correction layer: OVERRIDE masked to Legs — keys are absolute leg poses
    ps.addLayer('Feet IK');
    const fi = ps.timeline.selIdx;
    ps.setLayer(fi, { mode: 'override', maskName: 'Legs' });
    const keyAt = async (t, place) => {                      // place: null = seam key (as-below)
      ps.seek(t); await raf2();
      if (place) {
        const b = boardAt(t);
        for (const [f, zLocal] of place) {
          const off = rot(b.q, [base[f].x, deckTop + solePad, zLocal]);   // deck point + ankle height, board frame
          ps.ikTarget('foot' + f, b.p[0] + off[0], b.p[1] + off[1], b.p[2] + off[2]);
          const q = qMul(b.q, base[f].rel);                  // foot rides the deck's rotation
          ps.ikRotate('foot' + f, q[0], q[1], q[2], q[3]);
        }
        await raf2();
      }
      ps.keyPose();
      if (place) ps.ikClear();
    };
    // The track quats carry the MODEL's axis (its visual nose may be −z): the measured
    // base stance says which local sign is the TAIL side — the back foot sits on it.
    // Deriving ends from that sign makes the placement convention-proof.
    const zB = base[backF].z, zF = base[frontF].z;
    const tailSign = Math.sign(zB) || 1;
    const zTail = tailSign * 0.345, zNose = -tailSign * 0.30;
    const tilt0 = ev.pop - Math.max(0.03, 0.6 * (ev.flick - ev.pop));
    // window 1 — tilt→POP ONLY (owner: "from the pop to the flick the leg is strange —
    // too far forward"): IK places feet while they are truly PLANTED — both at their
    // own stance spots on the tilting deck, back foot on the tail at the strike. The
    // slide-and-flick after the pop belongs to the CAPTURE's leg (the flick exits off
    // the SIDE rail, never rides to the nose tip) — the override blends back to it by
    // the flick seam. IK must never drive motion the rider's own capture already has.
    await keyAt(tilt0 - 0.04, null);
    await keyAt(tilt0, [[backF, tailSign * Math.max(Math.abs(zB), 0.30)], [frontF, zF]]);
    await keyAt(ev.pop, [[backF, zTail], [frontF, zF]]);
    await keyAt(ev.flick, null);                             // seam: capture owns the flick
    // window 2 — catch→ride-out: both feet on their stance points on the deck
    await keyAt(ev.catch - 0.04, null);
    await keyAt(ev.catch, [[backF, zB], [frontF, zF]]);
    await keyAt(ev.land, [[backF, zB], [frontF, zF]]);
    await keyAt(ev.land + 0.22, [[backF, zB], [frontF, zF]]);
    await keyAt(ev.land + 0.30, null);
    ps.ikClear();
    return { layer: fi, backF, frontF, stance: { zB: +zB.toFixed(3), zF: +zF.toFixed(3) } };
  };

  // THE IMPOSSIBLE (tags: pop / wrap / catch / land — no flick: the back foot scoops
  // and the board wraps VERTICALLY around it, end-over-end, nose going up-and-over;
  // owner law: different rotation axis, same continuity — the kicktail identity never
  // changes). Board model: tail-pivot tilt into the strike, launch to a steep pitch,
  // then the WRAP phase: pitch runs on to a full turn (griptape up again exactly at
  // the catch) while the board's center ORBITS THE BACK FOOT (the capture's own foot
  // path carries the ballistic arc); catch→land glued under the soles; flat elsewhere.
  const solveImpossible = (idx = ps.timeline.layers.length - 1,
                           { stance = null, boardHalf = 0.07, strikePitch = 0.55, launchPitch = 1.15,
                             wrapR = 0.13, noseFlip = true } = {}) => {
    const tl = ps.timeline;
    const L = tl.layers[idx];
    const tag = 'skateboard';
    if (!L || !(L.clip.hips && L.clip.hips.length)) return null;
    const tags = ps.actionTags(idx);
    const at = (nm) => tags.find((g) => g.name === nm)?.t;
    const ev = { pop: at('pop'), wrap: at('wrap'), catch: at('catch'), land: at('land') };
    if (Object.values(ev).some((v) => v == null)) return { error: 'need pop/wrap/catch/land tags' };
    if (stance !== 'regular' && stance !== 'goofy')
      return { error: "stance is REQUIRED ('regular'|'goofy') — STANCE LAW, SKATE.md" };

    const samples = [];
    for (const hk of L.clip.hips) {
      ps.seek(hk[0]); window.__ctlPoseStep?.(8);
      const flp = ps.anim.cpos('FootL'), frp = ps.anim.cpos('FootR');
      samples.push({ t: hk[0], flp: { x: flp.x, y: flp.y, z: flp.z }, frp: { x: frp.x, y: frp.y, z: frp.z } });
    }
    const near = (t) => samples.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    const frontKey = stance === 'regular' ? 'flp' : 'frp';
    const backKeyS = stance === 'regular' ? 'frp' : 'flp';
    let prev = null;
    for (const s of samples) {
      const dx = s[frontKey].x - s[backKeyS].x, dz = s[frontKey].z - s[backKeyS].z;
      s.yaw = Math.hypot(dx, dz) > 0.12 ? Math.atan2(dx, dz) : (prev ?? 0);
      prev = s.yaw;
    }
    const sP = near(ev.pop);
    const yawP = sP.yaw;
    const MF = noseFlip ? qAxis(0, 1, 0, Math.PI) : null;
    const finish = (q) => (MF ? qMul(q, MF) : q);
    // back foot = the STANCE back foot; its per-sample position drives the wrap orbit
    const backKey = backKeyS;
    const backP0 = sP[backKey];
    const tail = { x: backP0.x - Math.sin(yawP) * 0.065, y: boardHalf, z: backP0.z - Math.cos(yawP) * 0.065 };  // tail POCKET under the back foot
    const pivotAt = (th) => ({ x: tail.x + Math.sin(yawP) * 0.385 * Math.cos(th),
                               y: tail.y + 0.385 * Math.sin(th),
                               z: tail.z + Math.cos(yawP) * 0.385 * Math.cos(th) });
    const tiltDur = Math.max(0.03, 0.8 * (ev.wrap - ev.pop));
    // wrap-orbit phase offset: the pivot's end center must be continuous into the orbit
    const pEnd = pivotAt(launchPitch);
    const fW = near(ev.wrap)[backKey];
    const rel = { t: (pEnd.x - fW.x) * Math.sin(yawP) + (pEnd.z - fW.z) * Math.cos(yawP), y: pEnd.y - fW.y };
    const phi0 = Math.atan2(rel.y, rel.t);                   // angle of (board center − foot), travel-plane
    const r0 = Math.min(wrapR + 0.08, Math.hypot(rel.t, rel.y));
    const footMinAt = (s) => Math.min(s.flp.y, s.frp.y) - 0.10;

    const keys = [];
    for (const s of samples) {
      const t = s.t;
      const bf2 = s[backKeyS];
      const ctr = { x: bf2.x + Math.sin(s.yaw) * 0.32, z: bf2.z + Math.cos(s.yaw) * 0.32 };  // STANCE SETUP LAW
      const qY = finish(qAxis(0, 1, 0, s.yaw));
      if (t < ev.pop - tiltDur || t > ev.land + 0.02) {
        keys.push([+t.toFixed(3), +ctr.x.toFixed(5), boardHalf, +ctr.z.toFixed(5), ...qY.map((v) => +v.toFixed(5))]);
      } else if (t < ev.pop) {
        const u = (t - (ev.pop - tiltDur)) / tiltDur;
        const th = strikePitch * u * u;
        const c = pivotAt(th);
        const q = finish(qMul(qAxis(0, 1, 0, yawP), qAxis(1, 0, 0, -th)));
        keys.push([+t.toFixed(3), +c.x.toFixed(5), +c.y.toFixed(5), +c.z.toFixed(5), ...q.map((v) => +v.toFixed(5))]);
      } else if (t < ev.wrap) {
        const u = (t - ev.pop) / (ev.wrap - ev.pop);
        const th = strikePitch + (launchPitch - strikePitch) * u;
        const c = pivotAt(th);
        const q = finish(qMul(qAxis(0, 1, 0, yawP), qAxis(1, 0, 0, -th)));
        keys.push([+t.toFixed(3), +c.x.toFixed(5), +c.y.toFixed(5), +c.z.toFixed(5), ...q.map((v) => +v.toFixed(5))]);
      } else if (t < ev.catch) {
        // THE WRAP: pitch launch→2π (griptape up at the catch); center orbits the back
        // foot in the travel plane, radius easing from the pivot handoff to wrapR
        const u = (t - ev.wrap) / Math.max(1e-3, ev.catch - ev.wrap);
        const th = launchPitch + (2 * Math.PI - launchPitch) * u;
        const f = s[backKey];
        const r = r0 + (wrapR - r0) * Math.min(1, u * 3);
        const ang = phi0 + (th - launchPitch);               // orbit advances with the pitch
        const c = { x: f.x + Math.sin(yawP) * Math.cos(ang) * r,
                    y: Math.max(boardHalf, f.y + Math.sin(ang) * r),
                    z: f.z + Math.cos(yawP) * Math.cos(ang) * r };
        const q = finish(qMul(qAxis(0, 1, 0, yawP), qAxis(1, 0, 0, -th)));
        keys.push([+t.toFixed(3), +c.x.toFixed(5), +c.y.toFixed(5), +c.z.toFixed(5), ...q.map((v) => +v.toFixed(5))]);
      } else {
        // caught: glued under the soles, settling level, wheels-down at the land
        const uL = Math.min(1, (t - ev.catch) / Math.max(1e-3, ev.land - ev.catch));
        const fm = footMinAt(s);
        const py = Math.max(boardHalf, (fm - 0.045) * (1 - uL) + boardHalf * uL);
        const th = -0.08 * (1 - uL);
        const q = finish(qMul(qAxis(0, 1, 0, yawP), qAxis(1, 0, 0, -th)));
        keys.push([+t.toFixed(3), +ctr.x.toFixed(5), +py.toFixed(5), +ctr.z.toFixed(5), ...q.map((v) => +v.toFixed(5))]);
      }
    }
    (L.clip.props ??= {})[tag] = keys;
    L.clip.mocap.trick = {
      type: 'impossible', clock: 'take',
      pop: { t: ev.pop, strikePitchDeg: +(strikePitch * 57.3).toFixed(0) },
      wrap: { t: ev.wrap, axis: 'lateral', turns: 1,
              omegaDegS: +((2 * Math.PI - launchPitch) * 57.3 / Math.max(1e-3, ev.catch - ev.wrap)).toFixed(0) },
      catch: { t: ev.catch }, land: { t: ev.land },
    };
    ps.seek(tl.t);
    return { keys: keys.length, ev, backFoot: backKey === 'flp' ? 'L' : 'R', trick: L.clip.mocap.trick };
  };

  // RIDE-OUT FEET (owner, on the impossible: "some feet slipping off the board at the
  // end… use IK to correct the feet SLIGHTLY — no huge corrections, feet on the board
  // properly after we land"). The anti-lesson of the failed feet pass, applied: stay
  // CLOSE TO CAPTURE. Each key reads the capture's own foot at that frame, CLAMPS it
  // into the deck rectangle (a back foot hanging past the tail comes back aboard),
  // snaps the sole to the deck top, and keys it — dense keys so interpolation stays
  // capture-shaped, a hard cap skips any foot needing more than `maxFix`.
  const feetRideFix = async (idx = ps.timeline.layers.length - 1,
                             { solePad = 0.10, deckTop = 0.075, tag = 'skateboard',
                               maxFix = 0.12, step = 0.09, t0 = null, t1 = null, layerName = 'Ride feet' } = {}) => {
    const L = ps.timeline.layers[idx];
    const tags = ps.actionTags(idx);
    const land = tags.find((g) => g.name === 'land')?.t;
    const track = L?.clip.props?.[tag];
    if (!L || (t0 == null && land == null) || !track?.length) return { error: 'need a land tag (or explicit window) + board track' };
    const wStart = t0 != null ? t0 : land;
    const end = t1 != null ? t1 : L.clip.hips[L.clip.hips.length - 1][0];
    const qc = (q) => [-q[0], -q[1], -q[2], q[3]];
    const rot = (q, v) => { const [x, y, z, w] = q, [vx, vy, vz] = v;
      const ux = 2 * (y * vz - z * vy), uy = 2 * (z * vx - x * vz), uz = 2 * (x * vy - y * vx);
      return [vx + w * ux + (y * uz - z * uy), vy + w * uy + (z * ux - x * uz), vz + w * uz + (x * uy - y * ux)]; };
    const bAt = (t) => { let i = 0; while (i < track.length - 1 && track[i + 1][0] <= t) i++;
      const k = (i < track.length - 1 && Math.abs(track[i + 1][0] - t) < Math.abs(track[i][0] - t)) ? track[i + 1] : track[i];
      return { p: [k[1], k[2], k[3]], q: [k[4], k[5], k[6], k[7]] }; };
    ps.addLayer(layerName);
    const fi = ps.timeline.selIdx;
    ps.setLayer(fi, { mode: 'override', maskName: 'Legs' });
    const stepPose = () => window.__ctlPoseStep?.(6);
    const report = [];
    const keyAt = async (t, place) => {
      ps.seek(t); stepPose();
      if (place) {
        const b = bAt(t);
        let used = 0;
        for (const f of ['L', 'R']) {
          const p = ps.anim.cpos('Foot' + f);
          const lo = rot(qc(b.q), [p.x - b.p[0], p.y - b.p[1], p.z - b.p[2]]);
          // LATERAL ONLY (owner's 'depth' = the blue axis = the board's lateral):
          // pull the foot SIDEWAYS onto the deck line; along-deck and deck-normal
          // stay exactly as captured. One axis, nothing else.
          const cl = [Math.max(-0.05, Math.min(0.05, lo[0])), lo[1], lo[2]];
          const w = rot(b.q, cl);
          const target = [b.p[0] + w[0], b.p[1] + w[1], b.p[2] + w[2]];
          const d = Math.hypot(target[0] - p.x, target[1] - p.y, target[2] - p.z);
          if (d > maxFix) { report.push({ t, f, skipped: +d.toFixed(3) }); continue; }
          ps.ikTarget('foot' + f, target[0], target[1], target[2]);
          used++; report.push({ t: +t.toFixed(2), f, d: +d.toFixed(3) });
        }
        if (used) { stepPose(); }
      }
      ps.keyPose();
      if (place) ps.ikClear();
    };
    await keyAt(wStart - 0.06, null);                        // seam: blend in from capture
    for (let t = wStart; t < end - 0.03; t += step) await keyAt(t, true);
    await keyAt(end - 0.02, true);
    if (t1 != null) await keyAt(end + 0.04, null);           // seam out for a mid-take window
    ps.ikClear();
    ps.seek(ps.timeline.t);
    const ds = report.filter((r) => r.d != null).map((r) => r.d);
    return { layer: fi, keys: report.length, maxDelta: Math.max(...ds), report: report.slice(0, 8) };
  };



  // STANDSTILL PIN (owner: 'feet should be attached to board… by using feet as root
  // position' + 'only jump up'). A standstill trick has NO horizontal root motion:
  // the root's xz pins to its planted-ride mean for the ENTIRE take — the jump (y)
  // is the only translation left. The feet then sit over the fixed board because the
  // ride pose already had them there. No IK anywhere.
  const pinRootStandstill = (idx = ps.timeline.layers.length - 1, { rideEnd = null } = {}) => {
    const L = ps.timeline.layers[idx];
    const ev = tagTimes(idx);
    if (!L?.clip.hips?.length) return { error: 'no hips' };
    const H = L.clip.hips;
    const cut = rideEnd != null ? rideEnd : (ev ? ev.pop - 0.2 : H[H.length - 1][0] * 0.4);
    const ride = H.filter((k) => k[0] < cut);
    const use = ride.length >= 4 ? ride : H;
    let mx = 0, mz = 0;
    for (const k of use) { mx += k[1]; mz += k[3]; }
    mx /= use.length; mz /= use.length;
    let maxSh = 0;
    for (const k of H) {
      maxSh = Math.max(maxSh, Math.hypot(k[1] - mx, k[3] - mz));
      k[1] = +mx.toFixed(5); k[3] = +mz.toFixed(5);
    }
    ps.seek(ps.timeline.t);
    return { keys: H.length, pinned: [+mx.toFixed(3), +mz.toFixed(3)], maxRemoved: +maxSh.toFixed(3) };
  };
  // ROOT FOLLOWS BOARD (owner, 2026-08-19: 'ur big mistake is having root at hips
  // instead of feet. feet follow board, root should follow. no need for big IK.').
  // For a STANDSTILL trick the board is FIXED in space during contact: anchor = the
  // mean back-foot spot of the planted ride, heading = the ride-mean stance line.
  // Per frame the ROOT translates so the captured feet land on that board — the leg
  // pose is never touched. Contact locks exactly; flight interpolates the offset
  // takeoff→landing (the groundTake pattern, horizontal). Kills capture depth-wobble.
  const rootFollowBoard = async (idx = ps.timeline.layers.length - 1, { stance = null } = {}) => {
    const L = ps.timeline.layers[idx];
    const ev = tagTimes(idx);
    if (!L || !ev) return { error: 'need a layer with pop/flick/catch/land tags' };
    if (stance !== 'regular' && stance !== 'goofy') return { error: 'stance REQUIRED' };
    const H = L.clip.hips;
    const backKey = stance === 'regular' ? 'frp' : 'flp';
    const frontKey = stance === 'regular' ? 'flp' : 'frp';
    const smp = [];
    for (const hk of H) {
      ps.seek(hk[0]); window.__ctlPoseStep?.(8);
      const flp = ps.anim.cpos('FootL'), frp = ps.anim.cpos('FootR');
      smp.push({ t: hk[0], flp: { x: flp.x, z: flp.z }, frp: { x: frp.x, z: frp.z } });
    }
    let prev = null;
    for (const s2 of smp) {
      const dx = s2[frontKey].x - s2[backKey].x, dz = s2[frontKey].z - s2[backKey].z;
      s2.yaw = Math.hypot(dx, dz) > 0.12 ? Math.atan2(dx, dz) : (prev ?? 0);
      prev = s2.yaw;
    }
    const ride = smp.filter((s2) => s2.t < ev.pop - 0.2);
    const post = smp.filter((s2) => s2.t > ev.land + 0.08);
    const use = ride.length >= 4 ? ride : smp;
    let sy = 0, cy = 0, ax = 0, az = 0;
    for (const s2 of use) { sy += Math.sin(s2.yaw); cy += Math.cos(s2.yaw); ax += s2[backKey].x; az += s2[backKey].z; }
    const yawL = Math.atan2(sy, cy);
    const A = { x: ax / use.length, z: az / use.length };
    // landing anchor: keep the capture's ALONG-LINE landing spot, kill the lateral part
    let A2 = A;
    if (post.length >= 3) {
      let px = 0, pz = 0;
      for (const s2 of post) { px += s2[backKey].x; pz += s2[backKey].z; }
      px /= post.length; pz /= post.length;
      const lon = (px - A.x) * Math.sin(yawL) + (pz - A.z) * Math.cos(yawL);
      A2 = { x: A.x + Math.sin(yawL) * lon, z: A.z + Math.cos(yawL) * lon };
    }
    // THE ROOT IS AT THE FEET FOR THE WHOLE TAKE (owner: 'if root were at feet then
    // feet would stay centered and hips would go back'). Every frame — flight
    // included — the root shift puts the BACK FOOT on the anchor; the hips inherit
    // the counter-motion. Only the anchor itself blends A→A2 across the flight.
    const sh = smp.map((s2) => {
      let ax2, az2;
      if (s2.t <= ev.flick) { ax2 = A.x; az2 = A.z; }
      else if (s2.t >= ev.land) { ax2 = A2.x; az2 = A2.z; }
      else { const f = (s2.t - ev.flick) / Math.max(1e-3, ev.land - ev.flick);
             ax2 = A.x + (A2.x - A.x) * f; az2 = A.z + (A2.z - A.z) * f; }
      return { t: s2.t, x: ax2 - s2[backKey].x, z: az2 - s2[backKey].z };
    });
    for (let pass = 0; pass < 2; pass++)
      for (let i = 1; i < sh.length - 1; i++) {
        sh[i].x = sh[i - 1].x * 0.25 + sh[i].x * 0.5 + sh[i + 1].x * 0.25;
        sh[i].z = sh[i - 1].z * 0.25 + sh[i].z * 0.5 + sh[i + 1].z * 0.25;
      }
    let maxSh = 0;
    for (let i = 0; i < H.length; i++) {
      maxSh = Math.max(maxSh, Math.hypot(sh[i].x, sh[i].z));
      H[i][1] = +(H[i][1] + sh[i].x).toFixed(5);
      H[i][3] = +(H[i][3] + sh[i].z).toFixed(5);
    }
    ps.seek(ps.timeline.t);
    return { keys: H.length, maxShift: +maxSh.toFixed(3), yawDeg: +(yawL * 57.3).toFixed(1) };
  };
  // ROOT STRAIGHTENER (owner: standstill ollie, but the rider wanders in DEPTH —
  // monocular root noise). Fit the principal line through the hips path, project every
  // hips key onto it, keep only keepLat of the lateral component. Vertical untouched.
  const straightenRoot = (idx = ps.timeline.layers.length - 1, { keepLat = 0.2 } = {}) => {
    const L = ps.timeline.layers[idx];
    const H = L?.clip.hips;
    if (!H?.length) return { error: 'no hips keys' };
    let mx = 0, mz = 0;
    for (const k of H) { mx += k[1]; mz += k[3]; }
    mx /= H.length; mz /= H.length;
    let sxx = 0, szz = 0, sxz = 0;
    for (const k of H) { const dx = k[1] - mx, dz = k[3] - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const dx = Math.cos(ang), dz = Math.sin(ang);
    let maxShift = 0;
    for (const k of H) {
      const rx = k[1] - mx, rz = k[3] - mz;
      const lon = rx * dx + rz * dz, lat = -rx * dz + rz * dx;
      const nx = mx + dx * lon - dz * lat * keepLat, nz = mz + dz * lon + dx * lat * keepLat;
      maxShift = Math.max(maxShift, Math.hypot(nx - k[1], nz - k[3]));
      k[1] = +nx.toFixed(5); k[3] = +nz.toFixed(5);
    }
    ps.seek(ps.timeline.t);
    return { keys: H.length, maxShift: +maxShift.toFixed(3) };
  };


  // THE GATE (owner, after t=0 shipped broken): EVERY hips key measured — rider-to-
  // board distance, back-foot lateral vs the deck line, soles vs floor. Any violation
  // fails the take. Nothing is saved or shown unless this passes. No sampling holes.
  const sweepCheck = (idx = ps.timeline.layers.length - 1, { tag = 'skateboard' } = {}) => {
    const L = ps.timeline.layers[idx];
    const track = L?.clip.props?.[tag];
    if (!L || !track?.length) return { error: 'no board track' };
    const qc = (q) => [-q[0], -q[1], -q[2], q[3]];
    const rotv = (q, v) => { const [x, y, z, w] = q, [vx, vy, vz] = v;
      const ux = 2 * (y * vz - z * vy), uy = 2 * (z * vx - x * vz), uz = 2 * (x * vy - y * vx);
      return [vx + w * ux + (y * uz - z * uy), vy + w * uy + (z * ux - x * uz), vz + w * uz + (x * uy - y * ux)]; };
    const bAt = (t) => { let i = 0; while (i < track.length - 1 && track[i + 1][0] <= t) i++; return track[i]; };
    const bad = [];
    let maxLat = 0, maxDist = 0, minSole = Infinity;
    for (const hk of L.clip.hips) {
      const t = hk[0];
      ps.seek(t); window.__ctlPoseStep?.(8);
      // measure the FOOT CENTER (ankle + 6cm toe-ward), not the ankle joint — a foot
      // centered on the deck has its ankle legitimately heel-ward of the centerline
      const toeC = (f) => {
        const b2 = ps.anim.rig.bones.get(f);
        const q2 = b2.getWorldQuaternion(new b2.quaternion.constructor());
        const p2 = ps.anim.cpos(f);
        const tv = { x: 2 * (q2.x * q2.y + q2.w * q2.z) * 0 , y: 0, z: 0 };
        // toe dir = bone +Y in world, horizontal
        const ty = { x: 2 * (q2.x * q2.y - q2.w * q2.z), y: 1 - 2 * (q2.x * q2.x + q2.z * q2.z), z: 2 * (q2.y * q2.z + q2.w * q2.x) };
        const n = Math.hypot(ty.x, ty.z) || 1;
        return { x: p2.x + (ty.x / n) * 0.06, y: p2.y, z: p2.z + (ty.z / n) * 0.06 };
      };
      const fl = toeC('FootL'), fr = toeC('FootR');
      const k = bAt(t);
      const q = [k[4], k[5], k[6], k[7]];
      const latOf = (p) => Math.abs(rotv(qc(q), [p.x - k[1], 0, p.z - k[3]])[0]);
      const lat = Math.max(latOf(fl), latOf(fr));   // BOTH feet ride the deck — always
      // deck-normal penetration: soles must never sink into the deck face (found at the
      // pop strike: keys lagged the tilting deck by 6cm and the old gate was blind to it)
      const normOf = (p) => rotv(qc(q), [p.x - k[1], p.y - k[2], p.z - k[3]])[1] - 0.075 - 0.10;
      const pen = Math.min(normOf(fl), normOf(fr));
      const mid = { x: (fl.x + fr.x) / 2, z: (fl.z + fr.z) / 2 };
      const dist = Math.hypot(mid.x - k[1], mid.z - k[3]);
      const sole = Math.min(fl.y, fr.y) - 0.10;
      maxLat = Math.max(maxLat, lat); maxDist = Math.max(maxDist, dist); minSole = Math.min(minSole, sole);
      if (lat > 0.12 || dist > 0.45 || sole < -0.02 || pen < -0.04)
        bad.push({ t: +t.toFixed(2), lat: +lat.toFixed(2), dist: +dist.toFixed(2), sole: +sole.toFixed(2), pen: +pen.toFixed(2) });
    }
    ps.seek(0);
    return { pass: bad.length === 0, keys: L.clip.hips.length,
             maxLat: +maxLat.toFixed(3), maxMidFeetToBoard: +maxDist.toFixed(3), minSole: +minSole.toFixed(3),
             violations: bad.slice(0, 10), violationCount: bad.length };
  };
  return { flightWindow, tagTimes, solveKickflip, solveImpossible, clearBoard, feetPass, feetRideFix, straightenRoot, rootFollowBoard, pinRootStandstill, sweepCheck, srcToTake };
})();
'skate solver v3 (tag-driven + feet placement) loaded'
