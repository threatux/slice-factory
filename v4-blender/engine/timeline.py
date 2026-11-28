"""v4 5-round timeline: knife passes, real bmesh cuts, per-round Bullet sims baked to keyframes,
camera moves, per-frame visibility, audio events and HUD cues — all from recipe["timeline"].

Time model: t in seconds, render frame f = 1 + t * fps (frame 1 == t 0.0). Rigid bodies are simulated
once per round at sim_fps and written as F-curves at fractional frames, so any render fps samples the
same physics and the Vector pass sees exact sub-frame motion.
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

from . import cutter, geometry
from .anim import key_transform
from .util import link, shade_smooth


def smoothstep(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


# ------------------------------------------------------------------ helpers
def _collection(name, parent=None):
    col = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(col)
    return col


def _move_to(obj, col):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    col.objects.link(obj)


def _blade_rotation(n, d):
    """Knife local frame: +X blade length, +Y thickness (= plane normal), +Z spine (edge leads along d)."""
    n = Vector(n).normalized()
    z = (-Vector(d)).normalized()
    x = n.cross(z).normalized()
    z = x.cross(n).normalized()
    return Matrix((x, n, z)).transposed()


def _sweep_dir(n, sweep):
    n = Vector(n).normalized()
    if sweep == "down":
        d = Vector((0, 0, -1))
    elif sweep == "x":
        d = Vector((1, 0, 0))
    elif sweep == "y":
        d = Vector((0, 1, 0))
    else:  # diag: steepest descent inside the plane
        d = Vector((0, 0, -1))
    d = d - n * d.dot(n)
    return d.normalized()


def _blitz_planes(groups, center):
    c = Vector(center)
    out = []
    for g in groups:
        k = g["count"]
        a = math.radians(g.get("angle", 0.0))
        if g["type"] == "vertical":
            n = Vector((math.cos(a), math.sin(a), 0.0))
            sweep = "down"
        elif g["type"] == "horizontal":
            n = Vector((0, 0, 1))
            sweep = "x"
        else:
            n = Vector((math.cos(a), math.sin(a), 1.0)).normalized()
            sweep = "diag"
        ext = g["extent"]
        for i in range(k):
            o = -ext + 2 * ext * (i + 0.5) / k
            out.append({"co": list(c + n * o), "no": list(n), "sweep": sweep, "alt": i % 2 == 1})
    return out


def _tube(name, loops, radius, sides, mat, col):
    bm = bmesh.new()
    for pts in loops:
        n = len(pts)
        if n < 3:
            continue
        rings = []
        for i in range(n):
            p, a, b = pts[i], pts[i - 1], pts[(i + 1) % n]
            t = (b - a).normalized()
            u = t.orthogonal().normalized()
            w = t.cross(u).normalized()
            rings.append([bm.verts.new(p + radius * (math.cos(k * math.tau / sides) * u +
                                                    math.sin(k * math.tau / sides) * w)) for k in range(sides)])
        for i in range(n):
            r0, r1 = rings[i], rings[(i + 1) % n]
            for k in range(sides):
                try:
                    bm.faces.new((r0[k], r1[k], r1[(k + 1) % sides], r0[(k + 1) % sides]))
                except ValueError:
                    pass
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    shade_smooth(me)
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    col.objects.link(ob)
    return ob


def _view(rd, key, default=None):
    """Visual-only per-round overrides live in rd['view'] (excluded from the Bullet cache key)."""
    return rd.get("view", {}).get(key, rd.get(key, default))


def _inside(prof, p, shrink=0.93):
    if hasattr(prof, "inside"):  # non-revolution shapes (crystal rubik's cube) bring their own test
        return prof.inside(p, shrink)
    h_z = p.z
    if h_z <= 0.01 or h_z >= prof.z(1.0) - 0.02:
        return False
    # invert z(h) (monotonic) by bisection
    lo, hi = 0.0, 1.0
    for _ in range(30):
        mid = 0.5 * (lo + hi)
        if prof.z(mid) < h_z:
            lo = mid
        else:
            hi = mid
    r = prof.radius(lo, math.atan2(p.y, p.x))
    return math.hypot(p.x, p.y) < r * shrink


# ------------------------------------------------------------------ timeline
class Timeline:
    def __init__(self, scene, recipe, mats, berry, knife, board, cam, focus, fps):
        self.scene, self.recipe, self.mats = scene, recipe, mats
        self.tl = recipe["timeline"]
        self.berry, self.knife, self.board, self.cam, self.focus = berry, knife, board, cam, focus
        self.fps = fps
        self.cache_dir = None
        self.rng = random.Random(self.tl["sim"]["seed"])
        self.events = []
        self.vis = []  # (collection_or_object, [(t_on, t_off), ...])
        self.knife_keys = []  # (t, edge_point Vector, rotation Matrix3)
        self.cam_keys = []  # (t, pos, target)
        self.stats = {}
        Timeline._core = mats["_cap_to"].name if "_cap_to" in mats else "StrawberryCore"
        self.gold_shape = recipe["fruit"].get("gold_shape", "teardrop")
        self._intact_m = {}
        self.root = _collection("V4")
        self.intact_col = _collection("Intact", self.root)
        _move_to(berry["object"], self.intact_col)

    def f(self, t):
        return 1.0 + t * self.fps

    # -------------------------------------------------------------- per round
    def build(self, log=print):
        rounds = self.tl["rounds"]
        hero = self.recipe["shots"]["hero"]["camera"]
        self.hero = (Vector(hero["pos"]), Vector(hero["target"]))
        rw = self.tl["rewind"]
        intact_on = []
        prev = None
        for ri, rd in enumerate(rounds):
            log(f"[timeline] {rd['id']} {rd['label']}: building")
            planes = rd["planes"] if "planes" in rd else _blitz_planes(rd["blitz"], self.tl["center"])
            passes = self._passes(rd, planes)
            release = passes[-1]["t1"] + 0.02
            show_from = rd["t0"] + (rw if ri > 0 else 0.0)
            intact_on.append((show_from, release))
            # sim length stays tied to the recipe's physics values (cache key); the visual loop timing may differ
            nxt_t0 = rounds[ri + 1]["t0"] if ri + 1 < len(rounds) else rd["loop_rewind"][0]
            sim_dur = nxt_t0 - release
            col = _collection(f"{rd['id']}_pieces", self.root)
            import time as _time
            _t = _time.perf_counter()
            if "shatter" in rd:
                bodies, extra = self._shatter(rd, col)
            else:
                bodies, extra = self._slice(rd, planes, col)
            _t1 = _time.perf_counter()
            data = self._simulate(rd, ri, bodies, release, sim_dur)
            if _view(rd, "open_blend") and self._intact_m:
                data = self._blend_open(data, bodies, _view(rd, "open_blend"))
            if _view(rd, "gold_on_top"):
                self._gold_on_top(rd, bodies, data)
            _t2 = _time.perf_counter()
            # rewind window that brings these pieces back together
            if ri + 1 < len(rounds):
                rew = (rounds[ri + 1]["t0"], rounds[ri + 1]["t0"] + rw)
            else:
                rew = tuple(_view(rd, "loop_rewind"))
                # perfect loop: the intact fruit (+ R1's gold) holds from the end of the rewind to t = duration
                intact_on.append((rew[1], self.tl["duration"]))
                self.loop_hold = (rew[1], self.tl["duration"])
            self._key_pieces(bodies, data, release, nxt_t0, rew, _view(rd, "rewind_ease", "smooth"))
            self.vis.append((col, [(release, rew[1])]))
            cam_pos, cam_tgt = self._fit(data, bodies, rd)
            self._release = release
            gold_w = self._gold(rd, ri, bodies, col, (show_from, release), data, cam_pos, cam_tgt)
            if ri > 0:
                self._cut_lines(rd, ri, planes, passes, release)
            self._knife(rd, passes, release)
            self._camera(rd, ri, cam_pos, cam_tgt, gold_w, release, nxt_t0, rew)
            self._round_events(rd, ri, passes, release, data)
            log(f"[timeline]   {rd['id']}: pieces {len(bodies)} in {_t1 - _t:.1f}s | sim {data['n_frames']}f in "
                f"{_t2 - _t1:.1f}s{' (cache)' if data['cached'] else ''} key {data['key']} | keys+lines "
                f"{_time.perf_counter() - _t2:.1f}s")
            self.stats[rd["id"]] = {"cuts": len(planes), "pieces": len(bodies), "release": round(release, 3),
                                    "impacts": len(data["impacts"]), **extra}
            prev = rd
        self.vis.append((self.intact_col, intact_on))
        if getattr(self, "first_gold_win", None) is not None:
            self.first_gold_win.append(self.loop_hold)
        last = rounds[-1]
        sh, lr = _view(last, "shimmer"), _view(last, "loop_rewind")
        self.events.append({"time": sh[0], "type": "shimmer", "until": sh[1], "intensity": 0.8})
        self.events.append({"time": lr[0], "type": "rewind", "until": lr[1]})
        self.events.append({"time": self.tl["duration"], "type": "end"})
        self.events.sort(key=lambda e: (e["time"], e["type"]))
        self._apply_knife_keys()
        self._apply_camera_keys()
        return self

    # -------------------------------------------------------------- knife passes
    def _passes(self, rd, planes):
        k = self.tl["knife"]
        c = Vector(self.tl["center"])
        out = []
        t = rd["cut_start"]
        for i, pl in enumerate(planes):
            n = Vector(pl["no"]).normalized()
            co = Vector(pl["co"])
            d = _sweep_dir(n, pl["sweep"])
            cp = c - n * (c - co).dot(n)  # fruit centre projected on the plane
            if pl["sweep"] == "down":
                a, b = Vector((cp.x, cp.y, k["top_z"])), Vector((cp.x, cp.y, k["floor_z"]))
            else:
                a, b = cp - d * 1.08, cp + d * 1.08
                if b.z < k["floor_z"]:
                    b = cp + d * ((k["floor_z"] - cp.z) / d.z)
            if pl.get("alt"):
                a, b = b, a  # zig-zag blitz: next pass runs back along a parallel plane
            out.append({"t0": t, "t1": t + rd["pass"], "a": a, "b": b, "rot": _blade_rotation(n, d),
                        "co": co, "no": n})
            t += rd["pass"] + rd["gap"]
        return out

    def _knife(self, rd, passes, release):
        k = self.tl["knife"]
        park = lambda p: Vector((p.x, p.y, k["park_z"]))
        first, last = passes[0], passes[-1]
        self.knife_keys.append((max(0.0, first["t0"] - k["entry"] - (0.0 if rd["t0"] == 0 else 0.15)), park(first["a"]), first["rot"]))
        for ps in passes:
            self.knife_keys.append((ps["t0"], ps["a"], ps["rot"]))
            self.knife_keys.append((ps["t1"], ps["b"], ps["rot"]))
        self.knife_keys.append((release + k["exit"], park(last["b"]), last["rot"]))

    def _apply_knife_keys(self):
        k = self.tl["knife"]
        u = Vector((self.recipe["knife"]["blade_length"] * k["edge_u"], 0, 0))
        keys = sorted(self.knife_keys, key=lambda x: x[0])
        # loop: parked at t=0 and at the end
        start = (0.0, Vector((0, 0, k["park_z"])), keys[0][2])
        end = (self.tl["duration"], Vector((0, 0, k["park_z"])), keys[0][2])
        keys = [start] + [x for x in keys if x[0] > 0.0] + [end]
        frames, locs, quats = [], [], []
        for t, p, R in keys:
            frames.append(self.f(t))
            locs.append(tuple(p - R @ u))
            q = R.to_quaternion()
            quats.append((q.w, q.x, q.y, q.z))
        key_transform(self.knife, frames, locs, quats, interp="LINEAR")
        self.stats["knife_keys"] = len(frames)

    # -------------------------------------------------------------- pieces
    def _slice(self, rd, planes, col):
        bc = self.recipe["cut"]
        src = self.berry["object"]
        pieces = cutter.slice_planes(src, [(p["co"], p["no"]) for p in planes], self.mats, bc["bevel"],
                                     name=f"{rd['id']}_p")
        for p in pieces:
            _move_to(p, col)
        if "split" in rd and len(pieces) == 2:
            pl = planes[0]
            n = Vector(pl["no"]).normalized()
            a, b = pieces
            # order halves by side of the plane (negative first)
            if (a.location - Vector(pl["co"])).dot(n) > 0:
                a, b = b, a
            self._intact_m = {p.name: p.matrix_world.copy() for p in (a, b)}
            cutter.pose_apart((a, b), list(n), rd["split"]["gap"], rd["split"]["tilt_deg"],
                              rd["split"].get("pivot", "inner"))
            pieces = [a, b]
        else:
            c = Vector(self.tl["center"])
            for p in pieces:  # 6 mm separation so coplanar cut faces don't start inside each other's margin
                d = p.location - c
                d.z *= 0.3
                if d.length > 1e-6:
                    p.location += d.normalized() * 0.006
        bpy.context.view_layer.update()
        return pieces, {}

    def _shatter(self, rd, col):
        sh = rd["shatter"]
        prof = self.berry["profile"]
        # jittered grid filling the fruit; spacing tuned until we reach the requested count
        target = sh["count"]
        s = 0.12
        for _ in range(40):
            pts = self._grid_points(prof, s)
            if len(pts) >= target:
                break
            s *= 0.97
        rng = random.Random(self.tl["sim"]["seed"] + len(rd["id"]) * 7 + target)
        rng.shuffle(pts)
        pts = sorted(pts[:target], key=lambda p: (round(p.z, 4), round(p.x, 4), round(p.y, 4)))
        if "_shard_palette" in self.mats:
            return self._shatter_palette(rd, col, pts, rng, s)
        nr, ne = sh["variants"]
        size = s * 0.42
        ruby = geometry.shard_meshes(f"{rd['id']}_ruby", nr, size, rng)
        emer = geometry.shard_meshes(f"{rd['id']}_emer", ne, size, rng)
        for m in ruby:
            m.materials.append(self.mats["ShardGlass"])
        for m in emer:
            m.materials.append(self.mats["ShardEmerald"])
        n_em = int(round(target * sh["emerald"]))
        # emerald (leaf) chips biased to the top of the fruit
        top_idx = sorted(range(len(pts)), key=lambda i: -pts[i].z)[: n_em * 3]
        em_set = set(rng.sample(top_idx, n_em))
        bodies = []
        gold_i = None
        if sh.get("gold"):
            gp = Vector(sh["gold"]["pos"])
            gold_i = min(range(len(pts)), key=lambda i: (pts[i] - gp).length)
        for i, p in enumerate(pts):
            if i == gold_i:
                ob = geometry.build_gold(f"{rd['id']}_gold", sh["gold"]["size"], self.mats, col, tuple(p))
            else:
                me = (emer if i in em_set else ruby)[rng.randrange(nr if i not in em_set else ne)]
                ob = bpy.data.objects.new(f"{rd['id']}_s{i:04d}", me)
                col.objects.link(ob)
                ob.location = p
            ob.rotation_mode = "QUATERNION"
            q = Quaternion((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
            ob.rotation_quaternion = q
            bodies.append(ob)
        bpy.context.view_layer.update()
        return bodies, {"shards": len(bodies), "emerald": n_em, "spacing": round(s, 4), "gold_in_pile": gold_i is not None}

    def _shatter_palette(self, rd, col, pts, rng, s):
        """Multi-colour shatter (crystal rubik's cube): exact per-material counts from mats['_shard_palette']
        (6 jewel colours in equal shares + dark obsidian frame chips), randomly interleaved through the volume."""
        sh = rd["shatter"]
        target = len(pts)
        nv_glass, nv_obs = sh["variants"]
        size = s * 0.42
        pal = self.mats["_shard_palette"]
        meshes = []
        for mat, _, kind in pal:
            ms = geometry.shard_meshes(f"{rd['id']}_{mat.name}_", nv_obs if kind == "obsidian" else nv_glass, size, rng)
            for m in ms:
                m.materials.append(mat)
            meshes.append(ms)
        counts = [int(round(target * w)) for _, w, _ in pal]
        counts[0] += target - sum(counts)
        labels = [k for k, c in enumerate(counts) for _ in range(c)]
        rng.shuffle(labels)
        gold_i = None
        if sh.get("gold"):
            gp = Vector(sh["gold"]["pos"])
            gold_i = min(range(len(pts)), key=lambda i: (pts[i] - gp).length)
        bodies = []
        for i, p in enumerate(pts):
            if i == gold_i:
                ob = geometry.build_gold(f"{rd['id']}_gold", sh["gold"]["size"], self.mats, col, tuple(p),
                                         shape=self.gold_shape)
            else:
                ms = meshes[labels[i]]
                ob = bpy.data.objects.new(f"{rd['id']}_s{i:04d}", ms[rng.randrange(len(ms))])
                col.objects.link(ob)
                ob.location = p
            ob.rotation_mode = "QUATERNION"
            q = Quaternion((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
            ob.rotation_quaternion = q
            bodies.append(ob)
        bpy.context.view_layer.update()
        return bodies, {"shards": len(bodies), "palette": {m.name: c for (m, _, _), c in zip(pal, counts)},
                        "spacing": round(s, 4), "gold_in_pile": gold_i is not None}

    def _grid_points(self, prof, s):
        c = self.tl["center"]
        R = prof.shoulder_radius
        H = prof.z(1.0)
        rng = random.Random(self.tl["sim"]["seed"])
        pts = []
        n = int(2 * R / s) + 2
        nz = int(H / s) + 2
        for iz in range(nz):
            for ix in range(-n // 2 - 1, n // 2 + 2):
                for iy in range(-n // 2 - 1, n // 2 + 2):
                    p = Vector((ix * s + (s / 2 if iz % 2 else 0), iy * s + (s / 2 if iz % 2 else 0), s * 0.6 + iz * s * 0.92))
                    p += Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))) * s * 0.06
                    if _inside(prof, p):
                        pts.append(p)
        return pts

    def _simulate(self, rd, ri, bodies, release, dur):
        import hashlib
        import json
        import os
        import numpy as np
        cfg = dict(self.tl["sim"])
        n_frames = max(2, int(math.ceil(dur * cfg["sim_fps"])) + 1)
        force = rd.get("force") or rd.get("shatter", {}).get("force")
        if force:
            force = dict(force, center=self.tl["center"])
        # Cache key = recipe inputs only. Piece poses are NOT hashed: Blender's scanfill cap triangulation is not
        # bit-stable across processes, so volume centres jitter by ~1e-5 and any rounding can flip. Instead the cached
        # trajectories are matched to the current pieces by nearest initial position (< 1 cm) when loading.
        geo = {"fruit": self.recipe["fruit"], "cut": self.recipe["cut"],
               "round": {k: v for k, v in rd.items() if k != "view"}}
        key = hashlib.sha256(json.dumps({"cfg": cfg, "force": force, "n": n_frames, "geo": geo, "bodies": len(bodies),
                                         "v": 4}, sort_keys=True).encode()).hexdigest()[:20]
        path = os.path.join(self.cache_dir, f"sim_{rd['id']}_{key}.npz") if self.cache_dir else None
        init = np.array([list(b.matrix_basis.translation) for b in bodies])
        data = None
        if path and os.path.exists(path):
            z = np.load(path)
            order = self._match(init, z["init"])
            if order is not None:
                inv = {old: new for new, old in enumerate(order)}
                imp = [(int(f), inv[int(i)], float(v)) for f, i, v in z["impacts"].tolist()]
                data = {"loc": z["loc"][order], "quat": z["quat"][order], "impacts": sorted(imp), "cached": True}
        if data is None:
            data = cutter.simulate_record(self.scene, bodies, self.board, cfg, n_frames, force)
            data["cached"] = False
            if path:
                os.makedirs(self.cache_dir, exist_ok=True)
                imp = np.array(data["impacts"], dtype=np.float64).reshape(-1, 3)
                np.savez(path, loc=data["loc"], quat=data["quat"], impacts=imp, init=init)
        data["n_frames"] = n_frames
        data["key"] = key
        return data

    @staticmethod
    def _match(cur, cached, tol=0.01):
        """order[k] = cached index for current body k, or None if any body has no cached partner within tol."""
        import numpy as np
        if len(cur) != len(cached):
            return None
        d = np.linalg.norm(cur[:, None, :] - cached[None, :, :], axis=2)
        order = d.argmin(axis=1)
        if len(set(order.tolist())) != len(order) or d[np.arange(len(cur)), order].max() > tol:
            return None
        return order

    def _blend_open(self, data, bodies, n_frames):
        """Visual-only: the first n sim frames ease from the intact (pre-tilt) pose into the simulated topple, so the
        split halves open from the closed cube instead of popping to their initial tilt. Frame 0 becomes the intact
        pose, which is also where the rewind lands (no pop when the whole cube reappears)."""
        loc, quat = data["loc"].copy(), data["quat"].copy()
        N = max(1, min(int(n_frames), loc.shape[1] - 1))
        for i, ob in enumerate(bodies):
            m = self._intact_m.get(ob.name)
            if m is None:
                continue
            l0, q0, _ = m.decompose()
            for k in range(N):
                s = smoothstep(k / N)
                loc[i, k] = [l0[j] * (1 - s) + loc[i, k, j] * s for j in range(3)]
                q = q0.slerp(Quaternion(quat[i, k]), s)
                quat[i, k] = (q.w, q.x, q.y, q.z)
        self.stats["open_blend_frames"] = N
        return dict(data, loc=loc, quat=quat)

    def _key_pieces(self, bodies, data, release, hold_until, rew, ease="smooth"):
        sim_fps = self.tl["sim"]["sim_fps"]
        loc, quat = data["loc"], data["quat"]
        F = loc.shape[1]
        # the visual rewind may start before the simulated window ends (pieces are asleep by then): cut the sim there
        F = max(2, min(F, int(math.floor((rew[0] - release) * sim_fps - 1e-6)) + 1))
        n_rw = 10
        F_act = F
        if ease == "out":
            # ease-out from the first rewind frame, and skip the sim's motionless tail (pieces already asleep),
            # so the shards visibly lift immediately instead of "sticking" for the first half of the rewind
            import numpy as np
            step = np.linalg.norm(np.diff(loc[:, :F, :], axis=1), axis=2)  # (bodies, F-1)
            mv = np.percentile(step, 97, axis=0)  # ignore the few shards that keep jittering
            active = np.nonzero(mv > 2e-3)[0]
            F_act = int(active[-1]) + 2 if len(active) else F
            F_act = max(2, min(F, F_act))
            n_rw = 16
            self.stats["rewind_active_frames"] = [F_act, F]
        for i, ob in enumerate(bodies):
            times = [release + k / sim_fps for k in range(F)]
            L = [tuple(loc[i, k]) for k in range(F)]
            Q = [tuple(quat[i, k]) for k in range(F)]
            # hold the settled pose, then rewind (ease-in-out) back to the assembled pose
            times.append(rew[0])
            L.append(L[-1])
            Q.append(Q[-1])
            for j in range(1, n_rw + 1):
                x = j / n_rw
                s = 1.0 - (1.0 - x) ** 2 if ease == "out" else smoothstep(x)
                tau = (1.0 - s) * (F_act - 1)
                k0 = int(math.floor(tau))
                k1 = min(F - 1, k0 + 1)
                w = tau - k0
                times.append(rew[0] + (rew[1] - rew[0]) * j / n_rw)
                L.append(tuple(loc[i, k0] * (1 - w) + loc[i, k1] * w))
                qa, qb = Quaternion(quat[i, k0]), Quaternion(quat[i, k1])
                qq = qa.slerp(qb, w)
                Q.append((qq.w, qq.x, qq.y, qq.z))
            # strictly increasing times
            keep_t, keep_l, keep_q = [], [], []
            for t, l, q in zip(times, L, Q):
                if keep_t and t <= keep_t[-1] + 1e-6:
                    keep_t[-1], keep_l[-1], keep_q[-1] = t, l, q
                    continue
                keep_t.append(t)
                keep_l.append(l)
                keep_q.append(q)
            key_transform(ob, [self.f(t) for t in keep_t], keep_l, keep_q, interp="LINEAR")

    _core = "StrawberryCore"

    @staticmethod
    def _caps(ob):
        """Planar cut faces of a piece (StrawberryCore polys clustered by normal), mesh-local.
        Returns [(normal, area, point_on_cap, clearance, long_axis)]."""
        me = ob.data
        core = {i for i, m in enumerate(me.materials) if m is not None and m.name.startswith(Timeline._core)}
        clusters = []
        for poly in me.polygons:
            if poly.material_index not in core or poly.area < 1e-9:
                continue
            n = poly.normal
            for c in clusters:
                if c["n"].normalized().dot(n) > 0.985:
                    break
            else:
                c = {"n": Vector((0, 0, 0)), "a": 0.0, "c": Vector((0, 0, 0)), "polys": []}
                clusters.append(c)
            c["n"] += n * poly.area
            c["a"] += poly.area
            c["c"] += poly.center * poly.area
            c["polys"].append(poly)
        out = []
        for c in clusters:
            n = c["n"].normalized()
            cen = c["c"] / c["a"]
            # nearest poly centre to the area centroid is guaranteed to lie on the cap (non-convex caps)
            pt = min((p.center for p in c["polys"]), key=lambda q: (q - cen).length)
            pt = pt - n * (pt - cen).dot(n)
            verts = {vi for p in c["polys"] for vi in p.vertices}
            co = [me.vertices[vi].co for vi in verts]
            clear = min((v - pt).length for v in co) if co else 0.0
            # in-plane principal axis (gold lies along the longest direction of the cap)
            u = n.orthogonal().normalized()
            w = n.cross(u)
            xs = [(v - cen).dot(u) for v in co]
            ys = [(v - cen).dot(w) for v in co]
            sxx = sum(x * x for x in xs)
            syy = sum(y * y for y in ys)
            sxy = sum(x * y for x, y in zip(xs, ys))
            ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
            axis = (u * math.cos(ang) + w * math.sin(ang)).normalized()
            out.append((n, c["a"], pt, clear, axis))
        return out

    def _gold(self, rd, ri, bodies, col, intact_window, data, cam_pos, cam_tgt):
        """One whole 24K seed per entry of rd['gold'], set into the cut face that ends up facing the camera
        nearest the centre of the settled shot (data-driven, so it is always readable on screen)."""
        golds = rd.get("gold", [])
        if not golds:
            return None
        N = len(bodies)
        m0 = [Matrix.LocRotScale(Vector(data["loc"][i, 0]), Quaternion(data["quat"][i, 0]), None) for i in range(N)]
        mF = [Matrix.LocRotScale(Vector(data["loc"][i, -1]), Quaternion(data["quat"][i, -1]), None) for i in range(N)]
        fwd = (cam_tgt - cam_pos).normalized()
        right = fwd.cross(Vector((0, 0, 1))).normalized()
        up = right.cross(fwd).normalized()
        half = (cam_tgt - cam_pos).length * 0.5 * self.cam.data.sensor_width / self.cam.data.lens * 9 / 16
        hosts = [_view(rd, "gold_piece")] if _view(rd, "gold_piece") is not None else range(N)
        size = _view(rd, "gold_size", golds[0]["size"])
        proud = _view(rd, "gold_proud", 0.45)
        # occlusion by real ray casts against this round's pieces at their settled pose
        own = set(bodies)
        t_set = data["loc"].shape[1] - 1
        sim_fps = self.tl["sim"]["sim_fps"]
        f_set = self.f(self._release + t_set / sim_fps - 1e-3)
        f_prev = self.scene.frame_current
        self.scene.frame_set(int(f_set), subframe=f_set - int(f_set))
        dg = bpy.context.evaluated_depsgraph_get()

        def occluded(i, pW, eye):
            d = pW - eye
            dist = d.length
            d.normalize()
            o = eye.copy()
            for _ in range(32):
                hit, loc, _n, _fi, ob, _m = self.scene.ray_cast(dg, o, d, distance=dist - (o - eye).length - 0.01)
                if not hit:
                    return False
                if ob.original in own:
                    return ob.original is not bodies[i]
                o = loc + d * 1e-3
            return False

        used, result = set(), None
        for gi, g in enumerate(golds):
            best = None
            for i in hosts:
                if i in used:
                    continue
                R = mF[i].to_3x3()
                for n, area, pt, clear, axis in self._caps(bodies[i]):
                    if clear < size[0] * 1.25:
                        continue
                    nW = (R @ n).normalized()
                    pW = mF[i] @ pt
                    # the shot actually used: shifted toward this seed by gold_bias, then dollied in by zoom
                    shift = (pW - cam_tgt) * _view(rd, "gold_bias", 0.3)
                    eye = (cam_tgt + shift) + (cam_pos - cam_tgt) * _view(rd, "zoom", 1.0)
                    view = (eye - pW).normalized()
                    facing = nW.dot(view)
                    if facing < 0.3 or nW.z < 0.2:
                        continue
                    d = pW - cam_tgt
                    off = math.hypot(d.dot(right), d.dot(up)) / max(half, 1e-3)
                    score = facing * (0.6 + nW.z) * max(0.05, 1.0 - off) * min(1.0, clear / size[2])
                    # avoid cut faces that mirror a softbox straight into the lens (white glare hides the gold)
                    refl = (nW * (2.0 * nW.dot(view)) - view).normalized()
                    for L in self.recipe["studio"]["lights"].values():
                        to_l = Vector(L["pos"]) - pW
                        cone = math.atan(0.5 * max(L["size"]) / to_l.length) + math.radians(12)
                        if refl.dot(to_l.normalized()) > math.cos(cone):
                            score *= 0.15
                    occ = occluded(i, pW + nW * size[0], eye)
                    if occ:
                        score *= 0.05
                    if best is None or score > best[0]:
                        best = (score, i, n, pt, axis)
            self.scene.frame_set(f_prev)
            if best is None:  # fall back to the recipe position inside the nearest piece
                pos = Vector(g["pos"])
                i = min(range(N), key=lambda k: self._dist_to_piece(bodies[k], m0[k], pos))
                L = Matrix.Translation(m0[i].inverted() @ pos)
            else:
                _, i, n, pt, axis = best
                # gold local frame: X = cap normal (thickness), Z = long axis along the cap, slightly proud
                Z = axis
                Y = Z.cross(n).normalized()
                rot = Matrix((n, Y, Z)).transposed().to_4x4()
                L = Matrix.Translation(pt + n * size[0] * (2 * proud - 1)) @ rot
            used.add(i)
            host = bodies[i]
            gcol = _collection(f"{rd['id']}_gold_intact", self.root)
            gi_ob = geometry.build_gold(f"{rd['id']}_gold{gi}_intact", size, self.mats, gcol, shape=self.gold_shape)
            gi_ob.matrix_basis = m0[i] @ L
            win = [intact_window]
            self.vis.append((gcol, win))
            if ri == 0:
                self.first_gold_win = win  # extended with the loop hold at the end of build()
            ob = geometry.build_gold(f"{rd['id']}_gold{gi}", size, self.mats, col, shape=self.gold_shape)
            ob.matrix_basis = m0[i] @ L
            ob.parent = host
            ob.matrix_parent_inverse = m0[i].inverted()
            gw = (mF[i] @ L).translation
            result = result or gw
            self.stats.setdefault("gold", []).append({"round": rd["id"], "host": host.name, "on_cap": best is not None,
                                                       "settled": [round(x, 3) for x in gw]})
        return result

    def _gold_on_top(self, rd, bodies, data):
        """R5: enlarge the (physics-sized) gold shard for readability and steer its fall so it settles on top of
        the ruby shards near the front-bottom edge of the pile. Only the gold body's keyed path changes."""
        import numpy as np
        g = _view(rd, "gold_on_top")
        name = f"{rd['id']}_gold"
        gi = next((i for i, b in enumerate(bodies) if b.name == name), None)
        if gi is None:
            return
        ob = bodies[gi]
        sc = _view(rd, "gold_scale", 1.0)
        ob.scale = (sc, sc, sc)
        loc, quat = data["loc"].copy(), data["quat"].copy()
        end = loc[:, -1, :]
        others = np.array([i for i in range(len(bodies)) if i != gi])
        e = end[others]
        cx = float(np.median(e[:, 0]))
        fy = float(np.percentile(e[:, 1], 100 * g.get("front", 0.15)))
        near = np.hypot(e[:, 0] - cx, e[:, 1] - fy) < 0.12
        ztop = float(e[near, 2].max()) if near.any() else 0.0
        half_t = rd["shatter"]["gold"]["size"][0] * sc
        target = np.array([cx, fy, ztop + 0.02 + half_t * 0.8])
        # lie on its side, tip pointing right and slightly toward the camera
        d = Vector((0.94, -0.34, 0.0)).normalized()
        X = Vector((0, 0, 1))
        Y = d.cross(X).normalized()
        qt = Matrix((X, Y, d)).transposed().to_quaternion()
        F = loc.shape[1]
        kset = max(1, int(g.get("settle", 0.55) * (F - 1)))
        delta = target - loc[gi, -1]
        for k in range(F):
            s = smoothstep(k / kset)
            loc[gi, k] = loc[gi, k] + s * delta
            q = Quaternion(quat[gi, k]).slerp(qt, s)
            quat[gi, k] = (q.w, q.x, q.y, q.z)
        data["loc"], data["quat"] = loc, quat
        self.stats.setdefault("gold", []).append({"round": rd["id"], "host": ob.name, "scale": sc,
                                                   "settled": [round(float(x), 3) for x in target]})

    @staticmethod
    def _dist_to_piece(ob, mw, p):
        local = mw.inverted() @ p
        bb = [Vector(c) for c in ob.bound_box]
        lo = Vector((min(c.x for c in bb), min(c.y for c in bb), min(c.z for c in bb)))
        hi = Vector((max(c.x for c in bb), max(c.y for c in bb), max(c.z for c in bb)))
        inside = all(lo[i] <= local[i] <= hi[i] for i in range(3))
        return (0.0 if inside else 10.0) + (mw.translation - p).length

    def _cut_lines(self, rd, ri, planes, passes, release):
        cl = self.tl["cut_line"]
        mesh = self.berry["body_mesh"]
        for i, (pl, ps) in enumerate(zip(planes, passes)):
            loops = cutter.section_loops(mesh, pl["co"], pl["no"])
            if not loops:
                continue
            ob = _tube(f"{rd['id']}_line{i:03d}", loops, cl["radius"], cl["sides"], self.mats["CutLine"],
                       self._line_col(rd))
            self.vis.append((ob, [(ps["t0"] + 0.6 * (ps["t1"] - ps["t0"]), release)]))

    def _line_col(self, rd):
        name = f"{rd['id']}_lines"
        return bpy.data.collections.get(name) or _collection(name, self.root)

    # -------------------------------------------------------------- camera
    def _fit(self, data, bodies, rd):
        """Camera along rd['cam_dir'] so the settled pieces fill `fit` of the frame (robust 5-95% bounds)."""
        import numpy as np
        end = data["loc"][:, -1, :]
        rad = np.array([0.5 * max(b.dimensions) for b in bodies])
        lo = np.percentile(end - rad[:, None], 5 if len(bodies) > 20 else 0, axis=0)
        hi = np.percentile(end + rad[:, None], 95 if len(bodies) > 20 else 100, axis=0)
        lo[2] = max(lo[2], 0.0)
        center = Vector(((lo + hi) / 2).tolist())
        fwd = -Vector(rd["cam_dir"]).normalized()
        right = fwd.cross(Vector((0, 0, 1))).normalized()
        up = right.cross(fwd).normalized()
        corners = [Vector((x, y, z)) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
        half_w = max(abs((c - center).dot(right)) for c in corners)
        half_h = max(abs((c - center).dot(up)) for c in corners)
        depth = max(abs((c - center).dot(fwd)) for c in corners)
        cd = self.cam.data
        r = self.scene.render
        aspect = r.resolution_x / r.resolution_y
        sensor_h = cd.sensor_width if aspect < 1 else cd.sensor_width / aspect
        sensor_w = sensor_h * aspect
        tw, th = sensor_w / 2 / cd.lens, sensor_h / 2 / cd.lens
        dist = max(half_w / (rd["fit"] * tw), half_h / (rd["fit"] * th)) + depth
        pos = center - fwd * dist
        return pos, center

    def _camera(self, rd, ri, pos, tgt, gold_w, release, nxt_t0, rew):
        hp, ht = self.hero
        if ri == 0:
            self.cam_keys.append((0.0, hp, ht))
        self.cam_keys.append((release, hp + (ht - hp) * 0.04, ht))
        # pull the settled shot toward the gold seed, then dolly in (view.zoom < 1 = closer)
        if gold_w is not None:
            shift = (gold_w - tgt) * _view(rd, "gold_bias", 0.3)
            pos, tgt = pos + shift, tgt + shift
        pos = tgt + (pos - tgt) * _view(rd, "zoom", 1.0)
        self.cam_keys.append((release + 0.5, pos, tgt))
        dr = _view(rd, "drift")
        if dr:
            self.cam_keys.append((dr["t0"], pos, tgt))
            rot = Matrix.Rotation(math.radians(dr["orbit_deg"]), 3, "Z")
            self.cam_keys.append((dr["t1"], tgt + rot @ (pos - tgt) * dr["dolly"], tgt))
            self.cam_keys.append((rew[1], hp, ht))  # back on the hero framing when the fruit is whole again
            self.cam_keys.append((self.tl["duration"], hp, ht))
        else:
            self.cam_keys.append((nxt_t0, tgt + (pos - tgt) * 0.97, tgt))
            self.cam_keys.append((rew[1], hp, ht))

    def _apply_camera_keys(self):
        keys = sorted(self.cam_keys, key=lambda k: k[0])
        frames = [self.f(t) for t, _, _ in keys]
        locs, quats, tg = [], [], []
        for _, p, t in keys:
            q = (t - p).to_track_quat("-Z", "Y")
            locs.append(tuple(p))
            quats.append((q.w, q.x, q.y, q.z))
            tg.append(tuple(t))
        key_transform(self.cam, frames, locs, quats, interp="BEZIER")
        key_transform(self.focus, frames, tg, None, interp="BEZIER")

    # -------------------------------------------------------------- audio events
    def _round_events(self, rd, ri, passes, release, data):
        sim_fps = self.tl["sim"]["sim_fps"]
        if ri > 0:
            self.events.append({"time": rd["t0"], "type": "transition", "round": ri})
        blitz = "blitz" in rd
        n = len(passes)
        for i, ps in enumerate(passes):
            mid = 0.5 * (ps["t0"] + ps["t1"])
            e = {"time": round(mid, 4), "type": "slash", "round": ri, "intensity": 1.0 if not blitz else 0.8,
                 "source": "knife"}
            if blitz:
                e.update(blitz=True, idx=i, n=n, dur=rd["pass"])
            self.events.append(e)
        self.events.append({"time": round(release, 4), "type": "impact_shatter", "tier": rd["tier"], "round": ri,
                            "source": "cut_release"})
        bins = {}
        for frame, _, inten in data["impacts"]:
            t = round(release + (frame - 1) / sim_fps, 4)
            c, m = bins.get(t, (0, 0.0))
            bins[t] = (c + 1, max(m, inten))
        for t, (c, m) in sorted(bins.items()):
            self.events.append({"time": t, "type": "clatter", "round": ri, "count": c, "intensity": round(m, 3),
                                "source": "rigid_body"})

    # -------------------------------------------------------------- visibility
    def apply_visibility(self, t):
        for item, windows in self.vis:
            on = any(a <= t + 1e-6 < b for a, b in windows)
            if item.hide_render == on:
                item.hide_render = not on
        knife_on = t > 1e-6 and t < self.tl["duration"] - 1e-6
        self.knife.hide_render = not knife_on

    def hud_cues(self):
        return self.recipe["hud"]
