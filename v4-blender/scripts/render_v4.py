#!/usr/bin/env python3
"""v4 render pipeline wrapper (host side).

  python3 v4-blender/scripts/render_v4.py --recipe v4-blender/config/recipes/crystal-strawberry-v4.json \
      --profile draft --out v4-blender/output/strawberry-v4-draft.mp4

1. warns if the Mac is not on AC power (pmset -g batt)
2. runs Blender headless inside `caffeinate -dims` (no sleep while rendering), streaming
   `[frame X/N | elapsed | ETA]` progress
3. HUD overlays (Pillow, scripts/hud_v4.py) at the output resolution
4. audio from the real cut / Rigid Body events with scripts/build-audio.py (recipe audio profile)
5. FFmpeg: optional lanczos upscale + HUD overlay + AAC 192k -> H.264 yuv420p .mp4

Uses only relative/POSIX paths built with os.path; re-executes itself under v4-blender/.venv if Pillow
is missing from the current interpreter.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
V4 = os.path.dirname(HERE)
REPO = os.path.dirname(V4)
VENV_PY = os.path.join(V4, ".venv", "bin", "python")
BLENDER = os.environ.get("BLENDER", "/Applications/Blender.app/Contents/MacOS/Blender")

try:
    import PIL  # noqa: F401
except ImportError:
    if os.path.exists(VENV_PY) and os.path.realpath(sys.prefix) != os.path.realpath(os.path.join(V4, ".venv")):
        os.execv(VENV_PY, [VENV_PY, os.path.abspath(__file__), *sys.argv[1:]])
    sys.exit("Pillow missing: python3 -m venv v4-blender/.venv && v4-blender/.venv/bin/pip install pillow")

sys.path.insert(0, HERE)
import hud_v4  # noqa: E402


def fmt(sec):
    sec = int(max(0, sec))
    return f"{sec // 3600:d}:{sec % 3600 // 60:02d}:{sec % 60:02d}" if sec >= 3600 else f"{sec // 60:02d}:{sec % 60:02d}"


def power_check():
    try:
        out = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=10).stdout
    except Exception as e:  # non-macOS or pmset missing
        print(f"[power] pmset unavailable ({e}); skipping check")
        return None
    on_ac = "AC Power" in out
    m = re.search(r"(\d+)%", out)
    pct = m.group(1) + "%" if m else "?"
    if on_ac:
        print(f"[power] AC Power ({pct})")
    else:
        print("!" * 72)
        print(f"[power] WARNING: Mac is on BATTERY ({pct}). The GPU throttles and the Mac may hibernate;")
        print("[power] connect the charger for reliable render times.")
        print("!" * 72)
    return on_ac


def _blender_cmd(args, work, extra):
    import shutil
    guard = ["caffeinate", "-dims"] if shutil.which("caffeinate") else []  # macOS: no sleep while rendering
    cmd = guard + [BLENDER, "--background", "--factory-startup", "--python", os.path.join(HERE, "blender_v4.py"), "--",
                   "--recipe", os.path.abspath(args.recipe), "--profile", args.profile, "--out-dir", work]
    if args.no_sim_cache:
        cmd.append("--no-sim-cache")
    return cmd + extra


def _stream(cmd, state):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        tail = (tail + [line])[-30:]
        if line.startswith("V4FRAME"):
            _, fr, n, sec = line.split()
            state["done"] += 1
            state["n"] = int(n)
            now = time.time()
            if state["first"] is None:
                state["first"] = now - float(sec)
            rate = (now - state["first"]) / state["done"]
            left = state["n"] - state["have"] - state["done"]
            print(f"[frame {int(fr)}/{state['n']} | elapsed {fmt(now - state['t0'])} | ETA {fmt(rate * left)}"
                  f" | {float(sec):.1f}s/frame]", flush=True)
        elif (line.startswith("[v4]") or line.startswith("[timeline]")) and not state.get("quiet"):
            print(line, flush=True)
    return proc.wait(), tail


def run_blender(args, work):
    """Render in chunks (one Blender process each) with resume: a long Metal session can die mid-sequence
    (SIGTRAP seen at ~frame 50); each chunk rebuilds the scene from the baked sims in a few seconds."""
    state = {"t0": time.time(), "first": None, "done": 0, "have": 0, "n": 0}
    if args.snap:
        extra = ["--snap", args.snap] + (["--snap-names", args.snap_names] if args.snap_names else [])
        rc, tail = _stream(_blender_cmd(args, work, extra), state)
        if rc != 0:
            print("\n".join(tail))
            sys.exit(f"Blender failed with exit code {rc}")
        return time.time() - state["t0"], 0.0
    # 1) build + events/timeline.json only (also tells us the frame count)
    rc, tail = _stream(_blender_cmd(args, work, ["--sim-only"]), state)
    if rc != 0:
        print("\n".join(tail))
        sys.exit(f"Blender failed with exit code {rc}")
    with open(os.path.join(work, "timeline.json"), encoding="utf-8") as fh:
        n = json.load(fh)["frames"]
    fdir = os.path.join(work, "frames")
    have = lambda f: os.path.exists(os.path.join(fdir, f"{f:05d}.png"))
    state.update(n=n, have=sum(1 for f in range(1, n + 1) if have(f)), quiet=True)
    if state["have"]:
        print(f"[resume] {state['have']} frames already on disk")
    chunk = args.chunk
    crashes = 0
    while True:
        missing = [f for f in range(1, n + 1) if not have(f)]
        if not missing:
            break
        start = missing[0]
        end = min(n, start + chunk - 1)
        rc, tail = _stream(_blender_cmd(args, work, ["--start", str(start), "--end", str(end)]), state)
        if rc != 0:
            crashes += 1
            print(f"[blender] chunk {start}-{end} exited with {rc} (crash {crashes}); resuming from the first missing frame")
            if crashes > args.max_crashes:
                print("\n".join(tail))
                sys.exit("too many Blender crashes")
    state["crashes"] = crashes
    return time.time() - state["t0"], (time.time() - state["first"]) if state["first"] else 0.0, crashes


def build_audio(work, meta):
    au = meta.get("audio", {})
    wav = os.path.join(work, "audio.wav")
    cmd = [sys.executable, os.path.join(REPO, "scripts", "build-audio.py"), os.path.join(work, "events.json"), wav,
           "--audio-profile", au.get("profile", "slizzy_juicy_glass"), "--seed", str(au.get("seed", 7)),
           "--duration", str(meta["duration"])]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        print(out.stdout, out.stderr)
        sys.exit("build-audio failed")
    print("\n".join("[audio] " + l for l in out.stdout.strip().splitlines()))
    m = re.search(r"peak (-?[\d.]+) dBFS, clipped (\d+)", out.stdout)
    return wav, (float(m.group(1)) if m else None), (int(m.group(2)) if m else None)


def silence_tail(wav, window=0.5):
    """Max level (dBFS) of the last `window` seconds — guards against dead air at the loop point."""
    import math
    import struct
    import wave
    with wave.open(wav) as w:
        n = w.getnframes()
        k = int(window * w.getframerate())
        w.setpos(max(0, n - k))
        data = w.readframes(k)
    vals = struct.unpack("<%dh" % (len(data) // 2), data)
    pk = max((abs(v) for v in vals), default=0) / 32767.0
    return 20 * math.log10(max(pk, 1e-9))


def encode(work, meta, wav, out_mp4):
    fps = meta["fps"]
    W, H = meta["output_resolution"]
    frames = os.path.join(work, "frames", "%05d.png")
    hud = os.path.join(work, "hud", "%05d.png")
    scale = f"scale={W}:{H}:flags=lanczos" if meta["resolution"] != [W, H] else "null"
    fc = f"[0:v]{scale}[b];[b][1:v]overlay=0:0:format=auto,format=yuv420p[v]"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-start_number", "1", "-i", frames,
           "-framerate", str(fps), "-start_number", "1", "-i", hud, "-i", wav, "-filter_complex", fc,
           "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
           "-r", str(fps), "-c:a", "aac", "-b:a", "192k", "-t", str(meta["duration"]), "-movflags", "+faststart", out_mp4]
    os.makedirs(os.path.dirname(os.path.abspath(out_mp4)), exist_ok=True)
    subprocess.run(cmd, check=True)
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                            "stream=codec_name,width,height,pix_fmt,r_frame_rate,bit_rate,sample_rate:format=duration",
                            "-of", "json", out_mp4], capture_output=True, text=True)
    return json.loads(probe.stdout)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recipe", default=os.path.join(V4, "config", "recipes", "crystal-strawberry-v4.json"))
    ap.add_argument("--profile", default="draft", choices=["draft", "prod-fast", "prod-native"])
    ap.add_argument("--out", default=None, help="output .mp4")
    ap.add_argument("--work", default=None, help="work dir (frames, hud, events, audio)")
    ap.add_argument("--snap", default=None, help="render only these times (s) as stills into --work")
    ap.add_argument("--snap-names", default=None)
    ap.add_argument("--no-sim-cache", action="store_true")
    ap.add_argument("--skip-render", action="store_true", help="reuse frames already in --work")
    ap.add_argument("--chunk", type=int, default=50, help="frames per Blender process")
    ap.add_argument("--max-crashes", type=int, default=3)
    args = ap.parse_args()

    rid = os.path.splitext(os.path.basename(args.recipe))[0]
    work = os.path.abspath(args.work or os.path.join(V4, "output", f"work_{rid}_{args.profile}"))
    os.makedirs(work, exist_ok=True)
    print(f"[v4] recipe {rid} | profile {args.profile} | work {os.path.relpath(work, REPO)}")
    on_ac = power_check()

    render_s = frames_s = 0.0
    crashes = 0
    if not args.skip_render:
        res = run_blender(args, work)
        render_s, frames_s = res[0], res[1]
        crashes = res[2] if len(res) > 2 else 0
    if args.snap:
        print(f"[v4] snapshots done in {fmt(render_s)} -> {os.path.relpath(work, REPO)}")
        return
    with open(os.path.join(work, "timeline.json"), encoding="utf-8") as fh:
        meta = json.load(fh)

    t = time.time()
    W, H = meta["output_resolution"]
    hud_v4.render_overlays(meta["hud"], W, H, meta["fps"], meta["frames"], os.path.join(work, "hud"), meta["duration"])
    hud_s = time.time() - t
    print(f"[hud] {meta['frames']} overlays {W}x{H} in {hud_s:.1f}s")

    wav, peak, clipped = build_audio(work, meta)
    tail_db = silence_tail(wav)
    out = os.path.abspath(args.out or os.path.join(V4, "output", f"{rid}-{args.profile}.mp4"))
    t = time.time()
    probe = encode(work, meta, wav, out)
    enc_s = time.time() - t
    report = {"profile": args.profile, "on_ac_power": on_ac, "blender_crashes_recovered": crashes,
              "render_total_s": round(render_s, 1),
              "frames_s": round(frames_s, 1), "sec_per_frame": round(frames_s / max(1, meta["frames"]), 2),
              "hud_s": round(hud_s, 1), "encode_s": round(enc_s, 1), "audio_peak_dbfs": peak,
              "audio_clipped": clipped, "audio_tail_peak_dbfs": round(tail_db, 1), "events_sha": meta["events_sha"],
              "rounds": meta["rounds"], "mp4": os.path.relpath(out, REPO), "ffprobe": probe}
    with open(os.path.join(work, "render_report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    print("=" * 72)
    print(f"[v4] {os.path.relpath(out, REPO)}")
    print(f"[v4] render {fmt(render_s)} (frames {fmt(frames_s)}, {report['sec_per_frame']}s/frame) | hud {hud_s:.0f}s"
          f" | encode {enc_s:.0f}s")
    print(f"[v4] audio peak {peak} dBFS, clipped {clipped}, last 0.5 s peak {tail_db:.1f} dBFS | events {meta['events_sha']}")
    print("=" * 72)


if __name__ == "__main__":
    main()
