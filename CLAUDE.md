# sk8 — skate mechanics (open source)

Skate-style (EA Skate feel) web skate game. THIS REPO = the mechanics demo
only (physics, tricks, controls, pipeline) with SKATE-THEMED clothing; the
wacky Norwegian-farm story game is the larger project it feeds (not here).
Characters/animations come from creategamecharacters.ai (the owner's own site).

## LAW ZERO (inherited from Desktop/skateboard-demo/SKATE.md)

Never claim fixed/verified/done without looking at the rendered result and
describing truthfully what it shows, including anything wrong. Failing results
are reported as FAILING, with numbers.

NOTE (owner, 2026-09-01): SKATE.md itself was written by an agent, NOT by the
owner — it is reference, not truth. If it contradicts measured data or the
owner's word, it is wrong. Verify board nose/tail per clip from the data
(tail = the end that strikes low at pop) and from renders — on this old-school
"rocket" deck the kicktail is obvious to the eye.

Board convention: baked clips normalize the board track so quat +Z = physical
nose in EVERY clip (clips.js does this; the raw tracks differ per clip). The
mesh's visual nose is on -Z → one rotY(π) inner flip in main.js, nothing else.

## Hard rules

- NEVER read `C:\Users\smorc\Documents\sk8opia` (old Grok game; owner forbids it).
- Root is NEVER the hips. The scene root is the physics ground frame (board
  contact point + nose yaw). Character hips/bones and the board are driven in
  that frame's local space. During wind-up the board stays put and feet stay on
  the board; hips move freely.
- Old-school deck, no nose: no nollies. Riding switch/fakie pops the tail =
  fakie ollie (same clips, travel reversed relative to nose).
- Stance: regular = left foot forward, goofy = right foot forward. Player picks
  stance in the character creator. Clips are auto-stance-detected via foot FK
  and mirrored to the player's stance. Flick mapping mirrors with stance
  (goofy: flick right = kickflip, flick left = heelflip; regular: inverted).

## Source assets (do not move/rename these)

- Clips + board: `C:\Users\smorc\Desktop\skateboard-demo\Skate animations\`
  (game copies live in `assets/anims/`, board in `assets/skateboard.glb`).
  Trick pipeline doc: `C:\Users\smorc\Desktop\skateboard-demo\SKATE.md`.
- Clip JSON: `{name, clip:{fps, duration, tracks:{Bone:[[t,x,y,z,w]…]},
  hips:[[t,x,y,z]…], props:{skateboard:[[t,px,py,pz,qx,qy,qz,qw]…]},
  tags:[[t,"pop"|"flick"|"wrap"|"catch"|"land"]…]}}`.
  Track quats are BIND-RELATIVE deltas (bone.quaternion = bind * delta).
  Hips track is a world-space position. Board track: motion nose = +Z resolved
  per clip by feet FK (mesh visual nose is −Z: display-only flip).
- Board GLB bbox: x ±0.139, y ±0.07 (origin mid-height, ground at −0.07),
  z ±0.41. Deck-top ride height ≈ 0.145.

## creategamecharacters.ai

- SDK: `https://creategamecharacters.ai/sdk/v1.js`, docs at
  `/agent/integration/sdk.md`, asset fetcher `/sdk/fetch-assets.mjs`.
- Project: "sk8opia farm demo" id `4bc9710e-e034-42d7-8ea0-93c931606134`
  (Bunad + farmer outfits, presets Steve/Cander/Ember/Liu/Charles/Peble/
  Willow/Heiring/Kari/Maple). Allowed origins: http://localhost:5101,
  http://127.0.0.1:5101, https://smorchj.github.io → dev server MUST be
  port 5101.
- Publishable key (browser, origin-locked, public by design): in `js/creator.js`.
- READ key: NEVER stored in any file — the owner passes it on the command line
  when running tools/fetch-assets.mjs. Local save folder the fetcher discovers:
  `C:\Users\smorc\Desktop\Clothes`.
- Attribution "Powered by creategamecharacters.com" must stay visible.

## Run

`node serve.mjs` → http://127.0.0.1:5101 (no build step, importmap CDN three).
