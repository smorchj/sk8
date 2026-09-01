# sk8 — Norwegian farm skate demo

A Skate-style web skate game built on **real mocap tricks solved from skate
footage**. Part one of a wackier whole: sweet skate physics first, the farm,
the story and the world come next.

Everything here — the mechanics, the trick animations, the video→trick
pipeline — is open source (MIT). The riders are living characters from
[creategamecharacters.ai](https://creategamecharacters.ai) and carry that
platform's licensing (see [Characters](#characters)).

## What's in the sauce

- **Physics owns the root.** The scene root is the board's ground frame
  (contact point + nose yaw) — never the hips. Every mocap clip is re-rooted
  at load: the board's ground path is extracted, frozen from `pop` to `land`,
  and hips/board are expressed relative to it. Physics carries the world; the
  capture plays inside it.
- **Real tricks.** Ollie, kickflip, heelflip, 360 flip, impossible — mocapped
  from real footage, with `pop`/`flick`/`catch`/`land` event tags driving the
  physics sync. Pop height comes from wind-up × per-trick skill, and the clip
  rate-fits the airtime.
- **Stance is measured, not assumed.** Each clip's stance (regular/goofy) is
  detected by FK-ing the feet against the board's nose axis, then mirrored to
  the player's stance. Flick controls mirror with stance. Old-school
  single-kick deck: no nollies — ride switch for fakie ollies.
- **Skate-style flick-it input.** Click/touch-hold to wind up (board stays
  down, feet stay planted — enforced by IK), flick up to ollie, side-flicks
  for kick/heel, tall oval = impossible, wide oval = 360 flip. Steer in the
  air for 180s/360s — the whole root spins.
- **Landing invariant.** From touchdown until the ride pose has fully taken
  over, both feet are IK-planted onto the deck in board space. Feet do not
  leave the board. Ever.
- **Push that reads.** The composed multi-stroke push loops while held, rooted
  on the standing foot (the contact truth), with a rigid board that can only
  move in the riding direction. Each stroke is a real burst of acceleration.

## Run it

```bash
node serve.mjs
```

Open http://127.0.0.1:5101 — the port matters: the character SDK's project
key is origin-locked.

Keys: `A/D` steer (in the air: spin) · `W` push (hold for strokes) · `S`
brake · hold `SPACE`/click = wind up, release/flick = trick · `K/H/I/T`
direct tricks · `Q/E` revert · `B` verification markers · `C` freecam ·
`X` slow-mo · `R` reset.

Rider ▸ opens the in-game character creator: presets, hair, body, the Bunad
and farmer outfits, **your stance**, and per-trick skill levels.

## Characters

Riders are spawned at runtime by the
[creategamecharacters.ai](https://creategamecharacters.ai) embedded SDK —
nothing baked, a character is a recipe. The character assets (basemeshes,
outfits, hair) are **not in this repo** and are **not MIT**: they carry the
platform's [licensing](https://creategamecharacters.com/agent/integration/licensing.md).

To run with your own project:

1. Create a project at creategamecharacters.ai, note its id, mint a
   **read key** (`ggc_read_…`) at `/profile.html` and a **publishable key**
   (`ggc_proj_…`) with your origins allowlisted.
2. Fetch your project bundle (build-time, one-shot):
   ```bash
   node tools/fetch-assets.mjs --project <your-project-id> --key <ggc_read_...> --out assets/creator
   ```
3. Put your publishable key in `js/creator.js`.

*Powered by creategamecharacters.com.*

## The trick pipeline

`pipeline/` is how tricks are made from found footage: `yt-grab.py` pulls the
clip, the mocap tool lifts the skater, events are hand-tagged by eye
(`pop`/`flick`/`catch`/`land`), `skate-solver.js` solves the board against the
feet (stance first — read `pipeline/SKATE.md`, especially LAW ZERO), and the
result exports as a JSON clip + tags that this game consumes directly. More
tricks = more clips in `assets/anims/`.

## License

MIT for the code, the trick animations, the skateboard model and the
pipeline — see [LICENSE](LICENSE). Character assets excluded (see above).
