"""Crystal Glass Rubik's Cube (recipe fruit.shape = "crystal-rubiks-cube").

One watertight mesh (no 27 separate cubies): a non-uniform grid on the 6 faces of a cube, displaced so every
face carries a physically carved 3x3 relief — 54 slightly domed glass tiles separated by deep rounded grooves.
The groove floor is a cube of half-size h - depth (the dark obsidian frame); tiles rise depth + dome above it.
Displacing in-plane coordinates by the same scale on every face keeps shared edge/corner vertices identical,
so the surface never folds and stays closed (bmesh bisect + scanfill caps work exactly as on the strawberry).

The 54 tile colours come from a real scramble (random face turns of a solved cube, deterministic seed search
that maximises colour contrast on the three faces the hero camera sees).
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

from .geometry import _caustic_caster, _store_rest_pos
from .util import mesh_object, shade_smooth

AXES = ((1, 2), (0, 2), (0, 1))  # in-plane axes (u, w) of the faces normal to x, y, z


# ------------------------------------------------------------------ shape helper for the shatter grid
class CubeProfile:
    """Duck-types the bits of geometry.Profile the timeline needs (shoulder_radius, z(1), inside)."""

    def __init__(self, cfg, zc):
        self.S = cfg["size"]
        self.h = self.S / 2
        self.zc = zc
        self.yaw = math.radians(cfg["yaw_deg"])
        self.Ri = Matrix.Rotation(-self.yaw, 3, "Z")

    @property
    def shoulder_radius(self):
        return self.h * math.sqrt(2.0)

    def z(self, h):
        return self.zc + self.h if h >= 1.0 else self.S * h

    def inside(self, p, shrink=0.93):
        q = self.Ri @ (Vector(p) - Vector((0, 0, self.zc)))
        return max(abs(q.x), abs(q.y), abs(q.z)) < self.h * shrink and p.z > 0.01


# ------------------------------------------------------------------ scramble
def _rot(v, axis, q):
    u, w = (axis + 1) % 3, (axis + 2) % 3
    v = list(v)
    for _ in range(q % 4):
        v[u], v[w] = -v[w], v[u]
    return tuple(v)


def scramble(cfg):
    """{(axis, sign, iu, iw): colour index} for the 54 tiles (iu/iw in -1..1 along AXES[axis])."""
    sc = cfg["scramble"]
    solved = sc["solved"]  # colour index per face in order +X -X +Y -Y +Z -Z
    front = [tuple(f) for f in sc["front_faces"]]

    def build(seed):
        st = []
        for ax in range(3):
            u, w = AXES[ax]
            for s in (1, -1):
                col = solved[2 * ax + (0 if s > 0 else 1)]
                for a in (-1, 0, 1):
                    for b in (-1, 0, 1):
                        c = [0, 0, 0]
                        c[ax], c[u], c[w] = s, a, b
                        n = [0, 0, 0]
                        n[ax] = s
                        st.append((tuple(c), tuple(n), col))
        rng = random.Random(seed)
        last = None
        for _ in range(sc["moves"]):
            ax = rng.randrange(3)
            while ax == last:
                ax = rng.randrange(3)
            last = ax
            layer = rng.choice((-1, 0, 1))
            q = rng.choice((1, 2, 3))
            st = [(_rot(c, ax, q), _rot(n, ax, q), col) if c[ax] == layer else (c, n, col) for c, n, col in st]
        tiles = {}
        for c, n, col in st:
            ax = next(i for i in range(3) if n[i] != 0)
            u, w = AXES[ax]
            tiles[(ax, n[ax], c[u], c[w])] = col
        return tiles

    def score(tiles):
        sc_ = 0.0
        for ax, s in front:
            u, w = AXES[ax]
            g = {(a, b): tiles[(ax, s, a, b)] for a in (-1, 0, 1) for b in (-1, 0, 1)}
            sc_ += 4.0 * len(set(g.values()))
            for (a, b), col in g.items():
                for da, db in ((1, 0), (0, 1)):
                    nb = g.get((a + da, b + db))
                    if nb is not None and nb == col:
                        sc_ -= 3.0
        # across the visible cube edges: stickers of the same cubie on two front faces
        for i, (ax1, s1) in enumerate(front):
            for ax2, s2 in front[i + 1:]:
                for t in (-1, 0, 1):
                    c = [0, 0, 0]
                    c[ax1], c[ax2] = s1, s2
                    k = 3 - ax1 - ax2
                    c[k] = t
                    a1 = tiles[(ax1, s1, c[AXES[ax1][0]], c[AXES[ax1][1]])]
                    a2 = tiles[(ax2, s2, c[AXES[ax2][0]], c[AXES[ax2][1]])]
                    if a1 == a2:
                        sc_ -= 2.0
        return sc_

    lo, hi = sc["seed_search"]
    best = max(range(lo, hi), key=lambda sd: (score(build(sd)), -sd))
    return build(best), best, score(build(best))


# ------------------------------------------------------------------ mesh
def _lines(cfg):
    S = cfg["size"]
    h, a = S / 2, S / 3
    w = cfg["groove"]["width"]
    half = a / 2
    loc = [e * w for e in (0.0, 0.18, 0.36, 0.5, 0.66, 0.82, 1.0, 1.3) if e * w < half * 0.8]
    start = loc[-1]
    n_in = cfg.get("tile_steps", 4)
    loc += [start + (half - start) * i / n_in for i in range(1, n_in + 1)]
    tile = loc + [a - x for x in reversed(loc[:-1])]
    out = []
    for k in range(3):
        for x in tile:
            v = -h + k * a + x
            if not out or v > out[-1] + 1e-9:
                out.append(v)
    out[0], out[-1] = -h, h
    return out


def _edge_dist(x, h, a):
    t = (x + h) % a
    return min(t, a - t), t


def _height(u, w, cfg):
    S = cfg["size"]
    h, a = S / 2, S / 3
    g = cfg["groove"]
    gw, d, dome = g["width"], g["depth"], cfg["tile_dome"]

    def groove(e):
        return 0.5 * (1.0 + math.cos(math.pi * e / gw)) if e < gw else 0.0

    eu, tu = _edge_dist(u, h, a)
    ew, tw = _edge_dist(w, h, a)
    if abs(abs(u) - h) < 1e-7:
        eu, tu = 0.0, 0.0
    if abs(abs(w) - h) < 1e-7:
        ew, tw = 0.0, 0.0
    gg = 1.0 - (1.0 - groove(eu)) * (1.0 - groove(ew))
    cu = max(0.0, 1.0 - (2.0 * tu / a - 1.0) ** 2)
    cw = max(0.0, 1.0 - (2.0 * tw / a - 1.0) ** 2)
    return (d + dome * cu * cw) * (1.0 - gg), min(eu, ew)


def build_cube(recipe, mats, collection=None):
    cfg = recipe["fruit"]
    S = cfg["size"]
    h, a = S / 2, S / 3
    d = cfg["groove"]["depth"]
    zc = h + cfg["tile_dome"]  # dome tips of the bottom tiles rest on z = 0
    tiles, seed, score = scramble(cfg)
    lines = _lines(cfg)
    n = len(lines)

    bm = bmesh.new()
    vmap = {}

    def vert(p):
        k = tuple(int(round(c * 1e6)) for c in p)
        v = vmap.get(k)
        if v is None:
            v = bm.verts.new(p)
            vmap[k] = v
        return v

    thr = cfg["groove"]["width"] * cfg["groove"].get("frame_from", 0.5)
    for ax in range(3):
        u, w = AXES[ax]
        for s in (-1, 1):
            grid = []
            for i in range(n):
                row = []
                for j in range(n):
                    p = [0.0, 0.0, 0.0]
                    p[ax], p[u], p[w] = s * h, lines[i], lines[j]
                    row.append(vert(p))
                grid.append(row)
            for i in range(n - 1):
                for j in range(n - 1):
                    f = bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
                    cu = 0.5 * (lines[i] + lines[i + 1])
                    cw = 0.5 * (lines[j] + lines[j + 1])
                    _, e = _height(cu, cw, cfg)
                    if e < thr:
                        f.material_index = 6  # obsidian frame / grooves
                    else:
                        iu = min(2, max(0, int((cu + h) // a))) - 1
                        iw = min(2, max(0, int((cw + h) // a))) - 1
                        f.material_index = tiles[(ax, s, iu, iw)]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    k = (h - d) / h
    for v in bm.verts:
        o = v.co.copy()
        p = o * k
        for ax in range(3):
            if abs(abs(o[ax]) - h) < 1e-7:
                u, w = AXES[ax]
                hg, _ = _height(o[u], o[w], cfg)
                p[ax] += math.copysign(hg, o[ax])
        p.z += zc
        v.co = p
    bm.normal_update()
    me = bpy.data.meshes.new("RubiksCube")
    bm.to_mesh(me)
    bm.free()
    shade_smooth(me)

    slots = [mats[f"Tile_{c['name']}"] for c in cfg["palette"]] + [mats["ObsidianFrame"], mats["RubiksCore"]]
    ob = mesh_object("RubiksCube", me, slots, collection)
    ob.rotation_euler = (0.0, 0.0, math.radians(cfg["yaw_deg"]))
    _store_rest_pos(ob)
    _caustic_caster(ob)
    bpy.context.view_layer.update()

    ref = me.copy()  # world-space surface for the cut score lines
    ref.name = "RubiksCubeRef"
    ref.transform(ob.matrix_world)
    counts = [0] * 6
    for col in tiles.values():
        counts[col] += 1
    return {"object": ob, "profile": CubeProfile(cfg, zc), "body_mesh": ref, "seed_count": 0, "gold_count": 0,
            "tiles": len(tiles), "scramble_seed": seed, "scramble_score": score, "colour_counts": counts,
            "verts": len(me.vertices)}


def tile_lookup_pixels(cfg):
    """18x3 RGBA texture: x = face*3 + (iu+1), y = iw+1 (face = 2*axis + (sign > 0)); used by the core shader."""
    from .util import hex_rgb
    tiles, _, _ = scramble(cfg)
    pal = [hex_rgb(c["hex"]) for c in cfg["palette"]]
    px = [0.0] * (18 * 3 * 4)
    for (ax, s, iu, iw), col in tiles.items():
        f = 2 * ax + (1 if s > 0 else 0)
        x, y = f * 3 + iu + 1, iw + 1
        i = (y * 18 + x) * 4
        px[i:i + 4] = [*pal[col], 1.0]
    return px
