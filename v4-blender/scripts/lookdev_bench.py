"""v4 LookDev + Metal benchmark.

Usage (from repo root):
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
      --python v4-blender/scripts/lookdev_bench.py -- [options]

Options:
  --recipe PATH        recipe JSON (default: config/recipes/crystal-strawberry-v4.json)
  --shots LIST         comma list of hero,blade,split,shards (default: all)
  --percentage N       resolution percentage for quick iteration (default 100)
  --samples N          override lookdev still samples
  --no-bench           skip the 10-frame draft/prod speed benchmark
  --bench-frames N     frames per benchmark config (default 10)
"""
import argparse
import json
import os
import re
import resource
import sys
import time

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from engine import cutter, geometry, materials, metal_setup, post, studio  # noqa: E402
from engine.util import ensure_dir, load_json  # noqa: E402

OUT = os.path.join(ROOT, "output", "lookdev")


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="lookdev_bench")
    ap.add_argument("--recipe", default=os.path.join(ROOT, "config", "recipes", "crystal-strawberry-v4.json"))
    ap.add_argument("--shots", default="hero,blade,split,shards")
    ap.add_argument("--percentage", type=int, default=100)
    ap.add_argument("--samples", type=int, default=None)
    ap.add_argument("--no-bench", action="store_true")
    ap.add_argument("--bench-frames", type=int, default=10)
    return ap.parse_args(argv)


# ------------------------------------------------------------------ render stats
class MemProbe:
    """Captures Cycles 'Mem:' figures from render_stats (device + host scene memory)."""

    def __init__(self):
        self.peak = 0.0
        bpy.app.handlers.render_stats.append(self._on_stats)

    def _on_stats(self, stats, *_):
        m = re.search(r"Mem:\s*([\d.]+)([MG])", str(stats))
        if m:
            v = float(m.group(1)) * (1024 if m.group(2) == "G" else 1)
            self.peak = max(self.peak, v)

    def reset(self):
        p, self.peak = self.peak, 0.0
        return p


def rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)  # bytes on macOS


def render(scene, path, mem):
    scene.render.filepath = path
    mem.reset()
    t0 = time.perf_counter()
    bpy.ops.render.render(write_still=True)
    dt = time.perf_counter() - t0
    peak = mem.reset()
    print(f"[render] {os.path.basename(path)}  {dt:6.2f}s  mem {peak:.0f}MB  samples {scene.cycles.samples}",
          flush=True)
    return {"file": os.path.relpath(path, ROOT), "seconds": round(dt, 2), "mem_mb": round(peak),
            "samples": scene.cycles.samples}


def place_knife(knife, recipe, edge_z):
    Lb = recipe["knife"]["blade_length"]
    knife.rotation_euler = (0, 0, -1.5707963)
    knife.location = (0.0, Lb * 0.3, edge_z)


def main():
    args = parse_args()
    shots = set(filter(None, args.shots.split(",")))
    recipe = load_json(args.recipe)
    profiles = load_json(os.path.join(ROOT, "config", "cycles-profiles.json"))
    ensure_dir(OUT)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    look_q = dict(profiles["lookdev"], percentage=args.percentage)
    if args.samples:
        look_q["samples"] = args.samples
    info = metal_setup.configure(scene, profiles, look_q)
    print("=" * 72)
    print(f"Blender {bpy.app.version_string}  |  Cycles backend: {info['backend']}  |  device: {info['device']}")
    for g in info["gpus"]:
        print(f"  GPU (enabled):  {g}")
    for c in info["disabled"]:
        print(f"  CPU (disabled): {c}")
    print(f"  denoiser {info['denoiser']}  |  view {info['view_transform']} / {info['look']}")
    print("=" * 72, flush=True)

    t_build = time.perf_counter()
    mats = materials.build_all(recipe)
    st = studio.build(recipe, mats)
    berry = geometry.build_strawberry(recipe, mats)
    knife = geometry.build_knife(recipe, mats)
    knife.hide_render = True
    mnee = profiles.get("shadow_caustics_mnee", True)
    metal_setup.set_shadow_caustics(mnee)
    report_mnee = mnee
    print(f"[build] scene built in {time.perf_counter() - t_build:.2f}s  "
          f"(strawberry verts {len(berry['object'].data.vertices)}, seeds {berry['seed_count']})", flush=True)

    mb = profiles.get("motion_blur", {"mode": "3d"})
    if mb["mode"] == "vector":
        post.setup_vector_blur(scene, recipe["camera"]["shutter"], mb.get("samples", 32))
    print(f"[config] motion blur: {mb['mode']} (shutter {recipe['camera']['shutter']})  |  "
          f"path caustics: {'ON' if scene.cycles.caustics_refractive else 'OFF'}", flush=True)

    mem = MemProbe()
    report = {"blender": bpy.app.version_string, "device": info, "shadow_caustics_mnee": report_mnee,
              "path_caustics": bool(scene.cycles.caustics_refractive),
              "motion_blur": profiles.get("motion_blur", {"mode": "3d"})["mode"],
              "stills": {}, "bench": {}}
    print(f"[config] MNEE shadow caustics: {'ON' if report_mnee else 'OFF'}", flush=True)
    cam, focus = st["camera"], st["focus"]
    shot = recipe["shots"]

    if "hero" in shots:
        c = shot["hero"]["camera"]
        studio.frame_shot(cam, focus, c["pos"], c["target"])
        report["stills"]["hero"] = render(scene, os.path.join(OUT, "01_hero.png"), mem)

    if "blade" in shots:
        c = shot["blade"]["camera"]
        place_knife(knife, recipe, shot["blade"]["knife_edge_z"])
        knife.hide_render = False
        studio.frame_shot(cam, focus, c["pos"], c["target"])
        report["stills"]["blade"] = render(scene, os.path.join(OUT, "02_blade.png"), mem)
        knife.hide_render = True

    need_sim = "split" in shots or not args.no_bench
    halves = None
    if need_sim:
        cc = recipe["cut"]
        t0 = time.perf_counter()
        a, b, cut_info = cutter.cut(berry["object"], cc["plane_co"], cc["plane_no"], mats, cc["bevel"])
        halves = (a, b)
        cutter.pose_apart(halves, cc["plane_no"], cc["gap"], cc["tilt_deg"])
        ph = recipe["physics"]
        cutter.setup_rigid_bodies(scene, halves, st["board"], ph)
        events = cutter.simulate(scene, halves, 0.0, os.path.join(OUT, "events.json"), profiles["lookdev"]["fps"])
        n_imp = sum(1 for e in events if e["type"] == "impact")
        print(f"[cut+sim] {time.perf_counter() - t0:.2f}s  caps {cut_info['cap_faces']}  "
              f"24K gold cross-section on {cut_info['gold_cut_in']}  impacts {n_imp}  -> events.json", flush=True)
        report["cut"] = cut_info
        report["events"] = len(events)

    def frame_split():
        c = shot["split"]["camera"]
        if c["target"] == "auto":
            studio.frame_objects(cam, focus, halves, c["pos"], c.get("fit", 1.3))
        else:
            studio.frame_shot(cam, focus, c["pos"], c["target"])

    if "split" in shots:
        scene.frame_set(shot["split"]["frame"])
        frame_split()
        report["stills"]["split"] = render(scene, os.path.join(OUT, "03_split_physics.png"), mem)

    if not args.no_bench:
        bdir = ensure_dir(os.path.join(OUT, "bench"))
        bc = recipe["bench"]
        f_end = bc["frames"][1]
        frames = list(range(f_end - args.bench_frames + 1, f_end + 1))
        for name in bc["configs"]:
            q = dict(profiles[name], percentage=args.percentage)
            samples = q["samples"]
            metal_setup.apply_quality(scene, q)
            # warm-up: GPU clocks + kernel specialisation settle before timing
            for w in range(bc.get("warmup_frames", 1)):
                scene.frame_set(frames[0] - 1 - w)
                frame_split()
                render(scene, os.path.join(bdir, f"{name}_warmup{w}.png"), mem)
            rows = []
            for f in frames:
                scene.frame_set(f)
                frame_split()
                rows.append(render(scene, os.path.join(bdir, f"{name}_{f:04d}.png"), mem))
            secs = [r["seconds"] for r in rows]
            spf = sum(secs) / len(secs)  # warm-up already excluded
            report["bench"][name] = {
                "samples": samples, "adaptive_threshold": q["adaptive_threshold"], "frames": len(rows),
                "first_frame_s": secs[0], "min_s": min(secs), "max_s": max(secs),
                "sec_per_frame": round(spf, 2), "mean_all_s": round(sum(secs) / len(secs), 2),
                "projected_600f_min": round(spf * bc["project_frames"] / 60, 1),
                "peak_mem_mb": max(r["mem_mb"] for r in rows),
            }
        metal_setup.apply_quality(scene, look_q)

    if "shards" in shots:
        if halves:
            for h in halves:
                h.hide_render = True
        berry["object"].hide_render = True
        geometry.build_shard_pile(recipe, mats)
        c = shot["shards"]["camera"]
        studio.frame_shot(cam, focus, c["pos"], c["target"])
        report["stills"]["shards"] = render(scene, os.path.join(OUT, "04_shards_test.png"), mem)
        report["stills"]["shards"]["instances"] = recipe["shards"]["count"]

    prev_path = os.path.join(OUT, "report.json")
    if os.path.exists(prev_path):  # keep stills from an earlier run when only re-benchmarking
        with open(prev_path, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
        for k, v in prev.get("stills", {}).items():
            report["stills"].setdefault(k, v)
        if not report["bench"]:
            report["bench"] = prev.get("bench", {})
    report["process_peak_rss_mb"] = round(rss_mb())
    with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)

    print("\n" + "=" * 72)
    print(f"Blender {report['blender']}  |  GPU: {', '.join(info['gpus'])}  |  Cycles device: {info['device']}")
    for k, v in report["stills"].items():
        print(f"  still {k:<7} {v['seconds']:7.2f}s  {v['mem_mb']:>6} MB  -> {v['file']}")
    if report["bench"]:
        print(f"\n  {'profile':<8}{'samples':>8}{'sec/frame':>11}{'min-max':>14}{'600f (20s@30)':>15}{'peak mem':>10}")
        for k, v in report["bench"].items():
            rng = f"{v.get('min_s', 0):.1f}-{v.get('max_s', 0):.1f}"
            print(f"  {k:<8}{v['samples']:>8}{v['sec_per_frame']:>11.2f}{rng:>14}"
                  f"{v['projected_600f_min']:>12.1f} min{v['peak_mem_mb']:>7} MB")
    print(f"\n  process peak RSS: {report['process_peak_rss_mb']} MB")
    print("=" * 72, flush=True)


if __name__ == "__main__":
    main()
