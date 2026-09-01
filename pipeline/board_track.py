#!/usr/bin/env python
"""board_track.py - 6-DOF skateboard pose from footage (the owner's recipe, end to end).

  1. SAM2 masks (produced in-app; per-frame stats exported to kf2_measure.json)
     give the board's center/axis/length at a clean reference frame.
  2. TAPIR (tapnet, offline BootsTAPIR-v2, the repo's own demo usage verbatim) tracks
     rigid MACRO landmarks seeded on that axis - nose, tail, truck clusters, rails.
     (Bolts are ~2 px at TAPIR's 256x256 processing size - untrackable; macro points
     carry the same PnP math.)
  3. OpenCV solvePnPRansac against a real deck template (0.82 m board) + the app's
     focal convention (443.4 at 512-square) -> per-frame rotation/translation, metric.

Outputs _scratch/shots/<name>_board6dof.json: per source-frame {t, pos, quat, err}.
The Animation Tool imports it through the take<->source time map.

  python tools/board_track.py --video _models/clips/kickflip2.mp4 \
      --measure _scratch/shots/kf2_measure.json [--limit 0] [--out kf2]
"""
import argparse, json, math, os, sys
import numpy as np
import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# the model store lives in the MAIN checkout; worktrees reach it via the _models junction
MODELS = os.path.join(ROOT, '_models') if os.path.isdir(os.path.join(ROOT, '_models')) \
    else 'C:/Users/smorc/Desktop/faceScn/_models'
sys.path.insert(0, os.path.join(MODELS, 'tapnet'))

import torch
import torch.nn.functional as F
from tapnet.torch import tapir_model

ap = argparse.ArgumentParser()
ap.add_argument('--video', required=True)
ap.add_argument('--measure', required=True)
ap.add_argument('--out', default='board')
ap.add_argument('--limit', type=int, default=0, help='frames cap (0 = all) - timing probes')
ap.add_argument('--fps', type=float, default=30.0)
args = ap.parse_args()

# ---- 1. measurement series (SAM2 stats from the app) -> PIECEWISE seeds ------------
# Seeding once and tracking through a FLIP drifts (measured: reproj 3.4px climbing to
# 30px across two seconds — the board's visible face rotates away and points slide).
# The SAM2 series measures center/axis/length at EVERY frame, so queries re-seed per
# SEGMENT and drift is bounded by half a segment length.
meas = json.load(open(args.measure))
board = meas['board']
if not board:
    sys.exit('no board measurements in ' + args.measure)

# ---- NOSE IDENTITY IS CONTINUOUS (owner: "tail and nose never change place in a
# kickflip. nose will always be in front"). A mask's principal axis is directionless
# (mod 180) and letting each frame re-decide which end is the nose swapped them wildly.
# Disambiguate the WHOLE series once: axis direction must continue frame to frame,
# initialized nose-forward from the board's own travel direction during roll-in.
board.sort(key=lambda b: b['t'])
# travel direction over the first ~10 measured frames
n0 = min(10, len(board) - 1)
tvx = board[n0]['cx'] - board[0]['cx']
tvy = board[n0]['cy'] - board[0]['cy']
prev_dir = None
for b in board:
    d = np.array([math.cos(b['angle']), math.sin(b['angle'])])
    if prev_dir is None:
        if d[0] * tvx + d[1] * tvy < 0:
            d = -d                                   # nose leads the travel
    elif float(np.dot(d, prev_dir)) < 0:
        d = -d                                       # continue, never flip
    b['dir'] = [float(d[0]), float(d[1])]
    prev_dir = d

TEMPLATE = [                     # board local: +Z length toward nose, +Y up, meters
    ('nose',   +0.94, 0.00, ( 0.000, 0.010,  0.385)),
    ('tail',   -0.94, 0.00, ( 0.000, 0.010, -0.385)),
    ('truckF', +0.58, 0.55, ( 0.000, -0.045,  0.250)),
    ('truckB', -0.58, 0.55, ( 0.000, -0.045, -0.250)),
    ('midF',   +0.45, -0.40, ( 0.000, 0.005,  0.190)),
    ('midB',   -0.45, -0.40, ( 0.000, 0.005, -0.190)),
    ('cENT',    0.00, 0.00, ( 0.000, 0.000,  0.000)),
    ('cLOW',    0.00, 0.60, ( 0.000, -0.050, 0.000)),
]
OBJ = np.array([q[3] for q in TEMPLATE], dtype=np.float64)

def seeds_from(b):
    ux, uy = b['dir']                                # the CONTINUOUS nose-forward axis
    px_, py_ = -uy, ux
    C = np.array([b['cx'], b['cy']])
    L = b['lenPx'] / 2.0
    W = max(b['widPx'] / 2.0, L * 0.12)
    return [C + np.array([ux, uy]) * (a * L) + np.array([px_, py_]) * (w * W)
            for (_, a, w, _) in TEMPLATE]

# ---- video frames (times on the container's OWN clock — assuming 30 on a 24fps file
# put every solved pose 25% off the take's source map) ----
cap = cv2.VideoCapture(args.video)
native_fps = cap.get(cv2.CAP_PROP_FPS) or args.fps
frames = []
while True:
    ok, fr = cap.read()
    if not ok: break
    frames.append(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
    if args.limit and len(frames) >= args.limit: break
cap.release()
frames = np.stack(frames)
NF, VH, VW = frames.shape[0], frames.shape[1], frames.shape[2]
print('frames:', NF, VW, 'x', VH, '@', native_fps, 'fps')
args.fps = native_fps

# ---- 2. TAPIR piecewise (demo usage per segment; drift bounded by re-seeding) ------
RS = 256
SEG = 24
small = np.stack([cv2.resize(f, (RS, RS)) for f in frames])

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
model = tapir_model.TAPIR(pyramid_level=1)
model.load_state_dict(torch.load(os.path.join(MODELS, 'tapnet', 'bootstapir_checkpoint_v2.pt'),
                                 map_location=device))
model = model.to(device).eval()

def preprocess_frames(t):
    t = t.float(); return t / 255 * 2 - 1
def postprocess_occlusions(occ, exp):
    return (1 - torch.sigmoid(occ)) * (1 - torch.sigmoid(exp)) > 0.5

NP_ = len(TEMPLATE)
tracks = np.zeros((NP_, NF, 2), dtype=np.float32)
vis = np.zeros((NP_, NF), dtype=bool)
for s0 in range(0, NF, SEG):
    s1 = min(NF, s0 + SEG)
    tm = (s0 + s1) / 2 / args.fps
    b = min(board, key=lambda x: abs(x['t'] - tm))
    ref_i = min(range(s0, s1), key=lambda i: abs(i / args.fps - b['t']))
    seeds = seeds_from(b)
    qp = np.zeros((NP_, 3), dtype=np.float32)
    for i, pt in enumerate(seeds):
        qp[i] = [ref_i - s0, pt[1] * RS / VH, pt[0] * RS / VW]
    with torch.no_grad():
        ft = preprocess_frames(torch.tensor(small[s0:s1]))[None].to(device)
        qt = torch.tensor(qp).float()[None].to(device)
        out = model(ft, qt)
        tr = out['tracks'][0].cpu().numpy()
        vi = postprocess_occlusions(out['occlusion'][0], out['expected_dist'][0]).cpu().numpy()
    tracks[:, s0:s1, 0] = tr[..., 0] * VW / RS
    tracks[:, s0:s1, 1] = tr[..., 1] * VH / RS
    vis[:, s0:s1] = vi
    print('segment %d-%d seeded at f%d (t=%.2f) vis %.2f' % (s0, s1, ref_i, b['t'], float(vi.mean())))
print('tracked: overall vis ratio', float(vis.mean()))
# per-frame expected nose direction (for PnP solution gating)
def expected_dir(t):
    b = min(board, key=lambda x: abs(x['t'] - t))
    return b['dir']

# ---- 3. planar PnP per frame ----
# The template is PLANAR by construction (x=0: only along-length and up-down are
# seedable from a side view). EPnP+RANSAC on that degenerates and rejected 167/200
# frames; IPPE is the planar-specific solver. It returns TWO mirror solutions — the
# ambiguity of a plane — disambiguated here by temporal continuity (nearest rotation
# to the previous frame; first frame takes the lower-error one).
S = max(VW, VH)
fpx = 443.4 * (S / 512.0)                                    # the app's focal convention
K = np.array([[fpx, 0, VW / 2.0], [0, fpx, VH / 2.0], [0, 0, 1]], dtype=np.float64)
OBJ_PLANAR = OBJ[:, [2, 1]]                                  # (z,y) plane coords
OBJ3 = np.concatenate([OBJ_PLANAR, np.zeros((len(OBJ), 1))], axis=1)  # planar Z=0 frame
def rel_angle(R1, R2):
    d = R1.T @ R2
    return math.acos(max(-1.0, min(1.0, (np.trace(d) - 1) / 2)))
res = []
prev_R = None
for f in range(NF):
    pts2d = tracks[:, f, :]
    ok_mask = vis[:, f]
    if ok_mask.sum() >= 4:
        o = OBJ3[ok_mask]; p = pts2d[ok_mask].astype(np.float64)
        try:
            okp, rvecs, tvecs, errs_ = cv2.solvePnPGeneric(
                o, p, K, None, flags=cv2.SOLVEPNP_IPPE)
            if okp and len(rvecs):
                # gates: in FRONT of the camera, and the projected tail→nose direction
                # must agree with the series' continuous nose axis (nose never swaps)
                NT = np.array([[-0.385, 0.010, 0.0], [0.385, 0.010, 0.0]])   # tail, nose (planar frame)
                exp_d = expected_dir(f / args.fps)
                cands = []
                for rv, tv in zip(rvecs, tvecs):
                    if float(tv[2]) <= 0.5:
                        continue
                    pr, _ = cv2.projectPoints(NT, rv, tv, K, None)
                    dvec = pr[1, 0] - pr[0, 0]
                    nn = np.linalg.norm(dvec)
                    if nn < 1e-6 or (dvec[0] * exp_d[0] + dvec[1] * exp_d[1]) / nn < 0.0:
                        continue
                    proj, _ = cv2.projectPoints(o, rv, tv, K, None)
                    e = float(np.linalg.norm(proj[:, 0, :] - p, axis=1).mean())
                    Rm_, _ = cv2.Rodrigues(rv)
                    cands.append((e, rv, tv, Rm_))
                if not cands:
                    res.append({'i': f, 't': round(f / args.fps, 3), 'ok': False, 'nvis': int(ok_mask.sum())})
                    continue
                cands.sort(key=lambda c: c[0] + (rel_angle(prev_R, c[3]) * 20 if prev_R is not None else 0))
                err, rvec, tvec, _R = cands[0]
                rvec, tvec = cv2.solvePnPRefineLM(o, p, K, None, rvec, tvec)
                proj, _ = cv2.projectPoints(o, rvec, tvec, K, None)
                err = float(np.linalg.norm(proj[:, 0, :] - p, axis=1).mean())
                Rp, _ = cv2.Rodrigues(rvec)
                prev_R = Rp
                # planar frame -> board local frame (+Z length, +Y up, right-handed):
                # planar e1 = board ez, e2 = board ey, e3 = -board ex
                M = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]]).T
                Rm = Rp @ M
                tr = Rm[0, 0] + Rm[1, 1] + Rm[2, 2]
                if tr > 0:
                    s = math.sqrt(tr + 1) * 2
                    q = [(Rm[2, 1] - Rm[1, 2]) / s, (Rm[0, 2] - Rm[2, 0]) / s, (Rm[1, 0] - Rm[0, 1]) / s, s / 4]
                else:
                    i = int(np.argmax([Rm[0, 0], Rm[1, 1], Rm[2, 2]]))
                    j, k = (i + 1) % 3, (i + 2) % 3
                    s = math.sqrt(max(1e-9, 1 + Rm[i, i] - Rm[j, j] - Rm[k, k])) * 2
                    q = [0, 0, 0, 0]
                    q[i] = s / 4
                    q[3] = (Rm[k, j] - Rm[j, k]) / s
                    q[j] = (Rm[j, i] + Rm[i, j]) / s
                    q[k] = (Rm[k, i] + Rm[i, k]) / s
                res.append({'i': f, 't': round(f / args.fps, 3), 'ok': bool(err <= 14.0),
                            'pos': [round(float(v), 4) for v in tvec[:, 0]],
                            'quat': [round(float(v), 5) for v in q],
                            'err': round(err, 2), 'nvis': int(ok_mask.sum())})
                continue
        except cv2.error:
            pass
    res.append({'i': f, 't': round(f / args.fps, 3), 'ok': False, 'nvis': int(ok_mask.sum())})

good = [r for r in res if r['ok']]
outp = os.path.join(ROOT, '_scratch', 'shots', args.out + '_board6dof.json')
os.makedirs(os.path.dirname(outp), exist_ok=True)
json.dump({'video': os.path.basename(args.video), 'fps': args.fps, 'f': fpx,
           'template': {n: t3 for (n, _, _, t3) in TEMPLATE},
           'segFrames': SEG, 'frames': res}, open(outp, 'w'))
errs = [r['err'] for r in good]
print('solved %d/%d frames, reproj err median %.1fpx' %
      (len(good), NF, float(np.median(errs)) if errs else -1))
print('->', outp)
