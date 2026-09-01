# SKATE PROJECT — working knowledge (local, never shipped)

## LAW ZERO — VERIFICATION (owner, 2026-08-19, after false "fixed" claims)

NEVER assume something is correct. NEVER claim fixed, verified, aligned, or done
unless BOTH of these are true:
1. `skate.sweepCheck` passes on EVERY key — the honest gate: BOTH feet vs the deck,
   whole take, no sampling holes. A gate that cannot fail is not a gate.
2. The rendered frames of start / pop / air / landing have been LOOKED AT, and what
   they show has been described truthfully — including anything wrong.
A failing result is reported as FAILING, with the numbers. Pretending is the one
unforgivable behavior in this project.

### Image-reading protocol (owner: "I have had it with agents pretending to look")

Only ANNOTATED renders count as looked-at: `__ctlSceneShot` draws the deck outline,
both foot markers, and each foot's measured lat/normal/along offsets INTO the image.
Reading an image = QUOTING its printed numbers and stating where each marker sits
relative to the deck outline — front foot and back foot named per the stance, never
from memory. Impressions without quoted overlay numbers are not observations. If the
overlay contradicts the render, that contradiction IS the finding.

The Animation Tool stays GENERIC. Everything skate lives here: `skate-solver.js`
(board/trick solving through `window.poseStudio` verbs), `yt-grab.py` (clip downloads),
and this file — the project's knowledge. An agent picking this project up reads THIS,
not chat history.

## STANCE LAW (owner, 2026-08-19 — the bug we kept hitting)

**Always clock the stance from the footage before any board solve: regular (left foot
forward) or goofy (right foot forward).** Board direction DERIVES FROM STANCE, never
from travel direction and never from the raw feet line:

- back foot = anatomical RIGHT for regular, LEFT for goofy
- nose direction = back foot → front foot along the deck, per sample (stance makes the
  feet-line sign unambiguous — no travel inference, no unwrap guessing; travel-based
  disambiguation coin-flips when the capture's root barely moves, and it is ACTIVELY
  WRONG for switch/nollie where travel does not tell you which end is the tail)
- which end POPS is a per-trick fact, separate from stance: tail for ollie/kickflip/
  impossible, NOSE for nollie tricks; switch = opposite stance, same rules
- the MODEL's kicktail axis is a constant of the GLB (our Meshy old-school deck: visual
  nose on −Z → `noseFlip: true` post-multiplies a half-turn; motion unaffected)

`skate.solveKickflip` / `solveImpossible` take `stance: 'regular' | 'goofy'` (required —
they refuse without it). Verify the pop end VISUALLY at the pop tag before showing
anyone anything: kicktail down at the strike, nose up toward travel.

## Review-sheet framing law (owner, same day)

A QA frame is unusable if the subject is tiny, cropped, or floating in void space.
`__ctlMocapSheet` (app, generic) content-fits its 3D panes to character+prop bounds.
If a sheet comes out with cut subjects or dead space, FIX THE INSTRUMENT FIRST — do
not read it, do not show it.

## The pipeline per clip (proven on kickflip, impossible, ollie)

1. `yt-grab.py <slug> <url>` → `_models/clips/<slug>.mp4` (bgutil PO-token provider
   auto-starts; DASH formats + ffmpeg merge — progressive format 18 is dead).
2. Probe the clip offline (fps, duration, slowmo structure, STANCE, camera). Cut
   normal-speed duplicate takes off the capture afterwards (`tlSelect`/`tlDeleteSel`
   — the take↔src map follows since studio v410).
3. `ps.loadVideo(...)` → `ps.mocapVideo()` (runs fine in a hidden tab).
4. Hand-tag events from frames BY EYE (action tags, source clock): the tag names the
   solver reads are `pop`, `flick` (board leaves / flick), `catch`, `land`; impossible
   uses `wrap` instead of `flick`. Judge board rotation by DECK FACE + wheel positions;
   catch = the foot TAKES the board (can be very low), not "rotation looks done".
5. Physics retime: flight span → real air time (ballistic; ~0.55s ollie, ~0.62s big
   flip), ride-in/out ~5× for slowmo footage. Then
   `groundTake({ride: 0.145, flights: [tag window]})` — 0.145 = deck-top ride height;
   forgetting `ride` stands the rider inside the board.
6. Board solve (this project): `solveKickflip` (kickflip: rolls 1; OLLIE: rolls 0 +
   `airGapBase/Peak ≈ 0` — board glued to soles), `solveImpossible` (end-over-end wrap
   orbiting the back foot). Board vertical always rides the CHARACTER's own feet —
   never an independent real-g parabola over a possibly-slow clock.
7. `feetRideFix` — IK clamp of feet into the deck rectangle from land through ride-out;
   tiny deltas only (it refuses big moves); `feetPass`-style absolute placement is
   REJECTED (overrides drift too far from capture).
8. Save `<trick> passN` (composed; set `timeline.duration` to content first or the
   disabled idle sequence pads the save), sheet at the tags, owner judges.

## Clip inventory facts

- kickflip2.mp4 (street, 24fps, 8.3s, ~20× slowmo): rider regular. Tags at src
  1.375/1.667/6.250/6.667. Passes: kickflip pass11 (owner-approved), pass12 broken.
- kickflip3.mp4 = THE IMPOSSIBLE (studio, 24fps, 19s; 0–1.79 is a NORMAL-SPEED
  duplicate take — cut it). Tags src 2.125/2.30(wrap)/16.00/17.83. impossible pass1/2.
- ollie.mp4 (30fps, 9.9s, all slowmo ~7.6×): tags src 2.967/3.133/5.2(level)/7.333.
  STANCE: verify from frames before re-solving.
- 16 clips total in `_models/clips/` — see `clips_inventory.png` in the scratchpad;
  the three `yt-*` shorts are all frontside tailslides. Tailslides + the 11ft bank
  need an OBSTACLE in the scene (ledge/bank prop + contact) — new extension class.

## Open items

- Ollie board direction bug (this session): travel-inference flipped the ends; fix =
  stance param, re-solve, re-verify pop end visually.
- Check impossible pass2's pop end for the same class of error.
- Ankle/flick authoring over capture (kickflip), roll-rate frame-match, semantic
  overlays on sheets (nose marker + travel arrow) still pending.
- freestyle-a (42s) and bs-tailslide-bigspin (32s) need trimming to single tricks.
