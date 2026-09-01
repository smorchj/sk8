# SKATE PROJECT TOOL (local, never shipped): download YouTube clips into _models/clips/.
#
# The recipe that actually works against YouTube's 2026 SABR/PO-token wall:
#   1. The bgutil PO-token provider must be RUNNING:
#        node C:/Users/smorc/Desktop/faceScn/_models/bgutil-pot/server/build/main.js
#      (listens on 127.0.0.1:4416; the yt-dlp plugin finds it automatically)
#   2. yt-dlp with: node as JS runtime + remote EJS components (signature solving),
#      DASH format selection (NEVER progressive format 18 — its URLs 403), and an
#      ffmpeg merge (imageio-ffmpeg's binary).
#
# Usage:
#   python yt-grab.py <slug> <url> [<slug> <url> ...]
#   -> _models/clips/<slug>.mp4
#
# Everything downloads at <=1080p which is plenty for ROMP capture (it eats 512px).

import subprocess, os, sys, urllib.request

PY = r"C:/Users/smorc/Desktop/faceScn/_models/mocap-venv/Scripts/python.exe"
CLIPS = r"C:/Users/smorc/Desktop/faceScn/_models/clips"
FF = r"C:/Users/smorc/Desktop/faceScn/_models/mocap-venv/lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe"
POT_SERVER = r"C:/Users/smorc/Desktop/faceScn/_models/bgutil-pot/server/build/main.js"


def provider_up():
    try:
        urllib.request.urlopen("http://127.0.0.1:4416/ping", timeout=3)
        return True
    except Exception:
        return False


def ensure_provider():
    if provider_up():
        return None
    p = subprocess.Popen(["node", POT_SERVER], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import time
    for _ in range(20):
        time.sleep(0.5)
        if provider_up():
            return p
    raise SystemExit("PO-token provider would not start (node " + POT_SERVER + ")")


def grab(slug, url):
    out = os.path.join(CLIPS, slug + ".mp4")
    if os.path.exists(out):
        return slug, "exists", os.path.getsize(out) // 1024
    r = subprocess.run([PY, "-m", "yt_dlp",
                        "--js-runtimes", "node", "--remote-components", "ejs:github",
                        "--ffmpeg-location", FF,
                        "-f", "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]"
                              "/bestvideo[height<=1080]+bestaudio",
                        "--merge-output-format", "mp4", "--no-playlist",
                        "-o", out, url], capture_output=True, text=True, timeout=300)
    ok = os.path.exists(out)
    return slug, "ok" if ok else "FAIL", os.path.getsize(out) // 1024 if ok else (r.stderr or "")[-140:]


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or len(args) % 2:
        raise SystemExit("usage: yt-grab.py <slug> <url> [...]")
    ensure_provider()
    for i in range(0, len(args), 2):
        print(*grab(args[i], args[i + 1]))
