"""Blender-side v4 renderer (run inside Blender; normally launched by scripts/render_v4.py).

  Blender --background --factory-startup --python v4-blender/scripts/blender_v4.py -- \
      --recipe PATH --profile draft --out-dir DIR [--snap 0.0,0.15,4.6,18.5] [--sim-only]

Writes DIR/events.json (build-audio format: cuts + real Rigid Body impacts), DIR/timeline.json
(rounds, stats, HUD cues, fps, frame count) and DIR/frames/%05d.png (or DIR/snap_*.png).
Progress lines for the wrapper:  V4FRAME <i> <N> <seconds>
"""
import argparse
import hashlib
import json
import os
import sys
import time

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from engine import geometry, materials, metal_setup, post, studio  # noqa: E402
from engine.timeline import Timeline  # noqa: E402
from engine.util import ensure_dir, load_json  # noqa: E402


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="blender_v4")
    ap.add_argument("--recipe", default=os.path.join(ROOT, "config", "recipes", "crystal-strawberry-v4.json"))
    ap.add_argument("--profile", default="draft")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--snap", default=None, help="comma list of times (s) to render as stills instead of the sequence")
    ap.add_argument("--snap-names", default=None)
    ap.add_argument("--sim-only", action="store_true")
    ap.add_argument("--no-sim-cache", action="store_true", help="always re-run Bullet (determinism checks)")
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--end", type=int, default=None)
    return ap.parse_args(argv)


def main():
    a = parse()
    t_all = time.perf_counter()
    recipe = load_json(a.recipe)
    profiles = load_json(os.path.join(ROOT, "config", "cycles-profiles.json"))
    prof = dict(profiles[a.profile])
    out = ensure_dir(os.path.abspath(a.out_dir))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    info = metal_setup.configure(scene, profiles, prof)
    metal_setup.set_shadow_caustics(profiles.get("shadow_caustics_mnee", False))
    fps = prof["fps"]
    print(f"[v4] Blender {bpy.app.version_string} | {info['backend']} {', '.join(info['gpus'])} | device {info['device']}"
          f" | profile {a.profile} {prof['resolution'][0]}x{prof['resolution'][1]} @ {fps} fps, {prof['samples']} spp",
          flush=True)

    mats = materials.build_all(recipe)
    st = studio.build(recipe, mats)
    shape = recipe["fruit"].get("shape", "crystal-strawberry")
    if shape == "crystal-rubiks-cube":
        from engine import rubiks
        berry = rubiks.build_cube(recipe, mats)
        print(f"[v4] crystal-rubiks-cube: {berry['verts']} verts, {berry['tiles']} tiles, scramble seed "
              f"{berry['scramble_seed']} (score {berry['scramble_score']}), colours {berry['colour_counts']}", flush=True)
    else:
        berry = geometry.build_strawberry(recipe, mats, join_gold=False)
    knife = geometry.build_knife(recipe, mats)
    mb = profiles.get("motion_blur", {"mode": "vector"})
    if mb["mode"] == "vector":
        post.setup_vector_blur(scene, recipe["camera"]["shutter"], mb.get("samples", 32))

    t0 = time.perf_counter()
    tl = Timeline(scene, recipe, mats, berry, knife, st["board"], st["camera"], st["focus"], fps)
    if not a.no_sim_cache:
        # baked Bullet trajectories: Blender's Bullet is repeatable inside one process but not bit-exact
        # across processes (pair ordering depends on memory addresses), so the bake is the source of truth
        tl.cache_dir = os.path.join(ROOT, "cache")
    tl.build(log=lambda m: print(m, flush=True))
    print(f"[v4] timeline built in {time.perf_counter() - t0:.1f}s", flush=True)

    # restore render fps (sims run at sim_fps) without touching anything else
    if scene.render.fps != fps:
        scene.render.fps = fps
    duration = recipe["timeline"]["duration"]
    n_frames = int(round(duration * fps))
    scene.frame_start, scene.frame_end = 1, n_frames

    events = tl.events
    with open(os.path.join(out, "events.json"), "w", encoding="utf-8") as fh:
        json.dump(events, fh, indent=1, ensure_ascii=False)
    digest = hashlib.sha256(json.dumps(events, sort_keys=True).encode()).hexdigest()[:16]
    meta = {"profile": a.profile, "fps": fps, "frames": n_frames, "duration": duration,
            "resolution": prof["resolution"], "output_resolution": prof.get("output_resolution", prof["resolution"]),
            "upscale": prof.get("upscale"), "rounds": tl.stats, "hud": tl.hud_cues(),
            "audio": recipe.get("audio", {}), "events_sha": digest, "blender": bpy.app.version_string,
            "gpu": info["gpus"], "device": info["device"]}
    with open(os.path.join(out, "timeline.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)
    n_imp = sum(1 for e in events if e["type"] == "clatter")
    print(f"[v4] events {len(events)} (clatter bins {n_imp}) sha {digest}", flush=True)
    for k, v in tl.stats.items():
        print(f"[v4]   {k}: {v}", flush=True)
    if a.sim_only:
        return

    if a.snap:
        times = [float(x) for x in a.snap.split(",")]
        names = a.snap_names.split(",") if a.snap_names else [f"snap_{t:06.2f}" for t in times]
        for t, name in zip(times, names):
            f = 1.0 + t * fps
            scene.frame_set(int(f), subframe=f - int(f))
            tl.apply_visibility(t)
            scene.render.filepath = os.path.join(out, f"{name}.png")
            t1 = time.perf_counter()
            bpy.ops.render.render(write_still=True)
            print(f"[v4] snap {name} t={t:.2f}s  {time.perf_counter() - t1:.1f}s", flush=True)
        return

    # Persistent data + objects appearing/disappearing per frame (collection hide_render) crashes Cycles/Metal
    # mid-sequence (SIGSEGV/SIGTRAP after 8-40 frames). Rebuild the scene each frame instead.
    scene.render.use_persistent_data = bool(prof.get("persistent_data", False))
    fdir = ensure_dir(os.path.join(out, "frames"))
    end = min(a.end or n_frames, n_frames)
    for fr in range(a.start, end + 1):
        path = os.path.join(fdir, f"{fr:05d}.png")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            continue  # resume support
        t = (fr - 1) / fps
        scene.frame_set(fr)
        tl.apply_visibility(t)
        scene.render.filepath = path
        t1 = time.perf_counter()
        bpy.ops.render.render(write_still=True)
        print(f"V4FRAME {fr} {n_frames} {time.perf_counter() - t1:.3f}", flush=True)
    print(f"[v4] done in {time.perf_counter() - t_all:.1f}s", flush=True)


if __name__ == "__main__":
    main()
