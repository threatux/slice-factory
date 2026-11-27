"""Procedural geometry: crystal strawberry (body + seed pits + seeds + crown + stem),
24K gold hidden seeds, damascus chef knife, and an instanced glass-shard pile.

The fruit stands on z = 0 (top of the marble board), axis = +Z.
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector, kdtree

from .util import mesh_object, join, shade_smooth

GOLDEN_ANGLE = math.pi * (3.0 - math.sqrt(5.0))


# ======================================================================= profile
class Profile:
    """Surface of revolution r = R(h), z = H*h (h: 0 tip -> 1 top), lifted so the tip flat sits on z=0."""

    def __init__(self, fr):
        self.H = fr["height"]
        self.Rm = fr["max_radius"]
        self.a = fr["taper_exp"]
        self.k = fr["shoulder_exp"]
        self.s = fr["shoulder_soft"]
        self.flat = fr["tip_flat"]
        lob = fr["lobes"]
        self.lobe_n, self.lobe_amp, self.lobe_twist = lob["count"], lob["amp"], lob["twist"]
        self.norm = 1.0 / max(self._raw(i / 400.0) for i in range(401))

    def _raw(self, h):
        h = min(max(h, 0.0), 1.0)
        return (h ** self.a) * max(0.0, 1.0 - h ** self.k) ** self.s

    def radius(self, h, theta=0.0):
        lobe = 1.0 + self.lobe_amp * math.cos(self.lobe_n * theta + self.lobe_twist * h * math.tau)
        return self.Rm * self.norm * self._raw(h) * lobe

    def z(self, h):
        return max(self.H * h, self.H * self.flat) - self.H * self.flat

    def point(self, h, theta):
        r = self.radius(h, theta)
        return Vector((r * math.cos(theta), r * math.sin(theta), self.z(h)))

    def frame(self, h, theta):
        """(point, outward normal, tangent toward the top)."""
        e = 1e-3
        p = self.point(h, theta)
        dh = (self.point(min(h + e, 1), theta) - self.point(max(h - e, 0), theta)).normalized()
        dt = (self.point(h, theta + e) - self.point(h, theta - e)).normalized()
        n = dt.cross(dh).normalized()
        if n.dot(Vector((p.x, p.y, 0))) < 0:
            n = -n
        return p, n, dh

    def top_height(self, rho):
        """Height of the upper (shoulder->top) surface at radial distance rho, or None past the shoulder."""
        hs = [0.74 + i * (0.26 / 200) for i in range(201)]
        for h in hs:
            if self.radius(h) <= rho:
                return self.z(h)
        return self.z(1.0)

    @property
    def shoulder_radius(self):
        return max(self.radius(i / 200.0) for i in range(201))


# ======================================================================= strawberry
def _sample_seeds(prof, cfg):
    lo, hi = cfg["band"]
    n = cfg["count"]
    rng = random.Random(cfg["rng"])
    # inverse CDF over surface area so seeds are evenly spaced on the skin
    steps = 600
    hs = [lo + (hi - lo) * i / steps for i in range(steps + 1)]
    w = []
    for i in range(steps):
        h0, h1 = hs[i], hs[i + 1]
        ds = (prof.point(h1, 0) - prof.point(h0, 0)).length
        w.append(prof.radius(0.5 * (h0 + h1)) * ds)
    total = sum(w)
    cdf, acc = [], 0.0
    for x in w:
        acc += x / total
        cdf.append(acc)
    seeds = []
    j = 0
    for i in range(n):
        u = (i + 0.5) / n
        while j < steps - 1 and cdf[j] < u:
            j += 1
        h = hs[j] + rng.uniform(-0.25, 0.25) * (hs[1] - hs[0])
        theta = i * GOLDEN_ANGLE + rng.uniform(-0.08, 0.08)
        seeds.append(prof.frame(h, theta))
    return seeds


def _body(prof, fr, seeds):
    u_seg, v_seg = fr["segments"]
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u_seg, v_segments=v_seg, radius=1.0)
    for v in bm.verts:
        x, y, z = v.co
        h = math.acos(max(-1.0, min(1.0, -z))) / math.pi
        theta = math.atan2(y, x)
        v.co = prof.point(h, theta)
    bm.normal_update()

    sc = fr["seeds"]
    tree = kdtree.KDTree(len(seeds))
    for i, (p, _, _) in enumerate(seeds):
        tree.insert(p, i)
    tree.balance()
    R, depth = sc["pit_radius"], sc["pit_depth"]
    for v in bm.verts:
        for co, idx, d in tree.find_range(v.co, R):
            fall = (1.0 - (d / R) ** 2) ** 2
            v.co -= seeds[idx][1] * depth * fall
    bm.normal_update()
    me = bpy.data.meshes.new("StrawberryBody")
    bm.to_mesh(me)
    bm.free()
    shade_smooth(me)
    return me


def _ellipsoid(bm, matrix, seg=(12, 8)):
    ret = bmesh.ops.create_uvsphere(bm, u_segments=seg[0], v_segments=seg[1], radius=1.0)
    bmesh.ops.transform(bm, matrix=matrix, verts=ret["verts"])


def _seeds_mesh(seeds, sc):
    """Small teardrop seeds (tip toward the berry tip), sunk flush with the original skin."""
    bm = bmesh.new()
    sn = sc["width"] * 0.55  # half-extent along the skin normal
    for p, n, t in seeds:
        side = t.cross(n).normalized()
        m = Matrix((
            (n.x * sn, side.x * sc["width"], t.x * sc["length"] * 0.5, 0),
            (n.y * sn, side.y * sc["width"], t.y * sc["length"] * 0.5, 0),
            (n.z * sn, side.z * sc["width"], t.z * sc["length"] * 0.5, 0),
            (0, 0, 0, 1)))
        # flush: the seed's outer surface sits exactly on the un-pitted skin
        m.translation = p - n * sn * sc.get("flush_depth", 1.0)
        ret = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=1.0)
        for v in ret["verts"]:
            if v.co.z < 0:  # teardrop: taper toward local -Z (= toward the berry tip)
                k = 1.0 + 0.62 * v.co.z
                v.co.x *= k
                v.co.y *= k
        bmesh.ops.transform(bm, matrix=m, verts=ret["verts"])
    me = bpy.data.meshes.new("StrawberrySeeds")
    bm.to_mesh(me)
    bm.free()
    shade_smooth(me)
    return me


def _leaf(bm, prof, cr, angle, scale, rng):
    L, W = cr["length"] * scale, cr["width"] * scale
    nu, nv = 28, 10
    z_top = prof.z(1.0)
    verts = []
    for i in range(nu + 1):
        u = i / nu
        w = W * math.sin(math.pi * min(u, 0.999) ** 0.8) ** 0.85 + 0.025 * (1 - u)
        row = []
        for j in range(nv + 1):
            v = -1.0 + 2.0 * j / nv
            # leaves root inside the calyx hub, off-axis, so a cut never slices 7 degenerate bases
            x, y = cr.get("root_offset", 0.06) + L * u, v * w
            rho = math.hypot(x, y)
            z = z_top + 0.06 * u - cr["droop"] * L * u * u + 0.12 * (v * v) * w + cr["curl"] * u ** 4
            surf = prof.top_height(rho) if rho < prof.shoulder_radius else None
            if surf is not None:
                z = max(z, surf + cr["clearance"] + 0.02 * (1 - u))
            co = Matrix.Rotation(angle, 3, "Z") @ Vector((x, y, z))
            row.append(bm.verts.new(co))
        verts.append(row)
    faces = []
    for i in range(nu):
        for j in range(nv):
            faces.append(bm.faces.new((verts[i][j], verts[i + 1][j], verts[i + 1][j + 1], verts[i][j + 1])))
    return faces


def _crown_mesh(prof, cr):
    rng = random.Random(cr["rng"])
    bm = bmesh.new()
    n = cr["leaves"]
    for k in range(n):
        lb = bmesh.new()
        _leaf(lb, prof, cr, k * math.tau / n + rng.uniform(-0.12, 0.12), rng.uniform(0.85, 1.12), rng)
        bmesh.ops.smooth_vert(lb, verts=lb.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        bmesh.ops.solidify(lb, geom=lb.faces[:], thickness=cr["thickness"])
        tmp = bpy.data.meshes.new("_leaf")
        lb.to_mesh(tmp)
        lb.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    # calyx hub
    hub = Matrix.Diagonal((0.11, 0.11, 0.05, 1.0))
    hub.translation = (0, 0, prof.z(1.0) + cr["clearance"] + 0.02)
    _ellipsoid(bm, hub, (32, 16))
    # stem: tapered, bent cylinder
    st = cr["stem"]
    ret = bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=st["radius"], radius2=st["radius"] * 0.75,
                                depth=st["length"])
    for v in ret["verts"]:
        t = (v.co.z + st["length"] / 2) / st["length"]
        v.co.x += st["bend"] * t * t
        v.co.z += prof.z(1.0) + st["length"] / 2 + cr["clearance"] + 0.02
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new("StrawberryCrown")
    bm.to_mesh(me)
    bm.free()
    shade_smooth(me)
    return me


def _store_rest_pos(obj):
    me = obj.data
    attr = me.attributes.get("rest_pos") or me.attributes.new("rest_pos", "FLOAT_VECTOR", "POINT")
    co = [0.0] * (len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    attr.data.foreach_set("vector", co)


def build_gold(name, size, mats, collection=None, location=(0, 0, 0), rotation=(0, 0, 0)):
    """24K gold teardrop seed (tip toward +Z)."""
    bm = bmesh.new()
    _ellipsoid(bm, Matrix.Diagonal((*size, 1.0)), (24, 16))
    for v in bm.verts:
        if v.co.z > 0:
            k = 1.0 - 0.5 * (v.co.z / size[2])
            v.co.x *= k
            v.co.y *= k
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    shade_smooth(me)
    ob = mesh_object(name, me, [mats["Gold24K"]], collection)
    ob.location = location
    ob.rotation_euler = rotation
    return ob


def build_strawberry(recipe, mats, collection=None, join_gold=True):
    """join_gold=True (lookdev): gold seeds are fused into the fruit mesh so a cut shows a gold cross-section.
    join_gold=False (v4 timeline): fruit only; per-round gold seeds are separate objects (never sliced)."""
    fr = recipe["fruit"]
    prof = Profile(fr)
    seeds = _sample_seeds(prof, fr["seeds"])
    body_me = _body(prof, fr, seeds)
    body_copy = body_me.copy()  # clean skin-only mesh: source for the visible cut lines
    body_copy.name = "StrawberryBodyRef"
    body = mesh_object("Strawberry", body_me, [mats["CrystalGlass"], mats["StrawberryCore"]], collection)
    seed_obj = mesh_object("Seeds", _seeds_mesh(seeds, fr["seeds"]), [mats["SeedGloss"]], collection)
    crown = mesh_object("Crown", _crown_mesh(prof, fr["crown"]), [mats["EmeraldLeaf"]], collection)
    golds = []
    if join_gold:
        for i, g in enumerate(fr["gold_seeds"]):
            golds.append(build_gold(f"GoldSeed{i}", g["size"], mats, collection, g["pos"],
                                    (0, 0, 0) if g.get("reveal") else (0.3 * i, 0.5, 0.7 * i)))
    berry = join([body, seed_obj, crown, *golds], "Strawberry")
    _store_rest_pos(berry)
    _caustic_caster(berry)
    return {"object": berry, "profile": prof, "seed_count": len(seeds), "gold_count": len(golds),
            "body_mesh": body_copy}


def _caustic_caster(ob):
    cy = getattr(ob, "cycles", None)
    for target in (ob, cy):
        if target is not None and hasattr(target, "is_caustics_caster"):
            target.is_caustics_caster = True


# ======================================================================= knife
def build_knife(recipe, mats, collection=None):
    """Chef knife along +X (heel at x=0, tip at +X), edge at z=0, spine up, handle toward -X.

    Blade carries a per-vertex 'edge_mask' (1 on the primary edge bevel) for the DamascusBlade shader.
    """
    k = recipe["knife"]
    Lb, Hb, ts = k["blade_length"], k["blade_height"], k["spine_thickness"] / 2
    nx, ns = k["segments"]
    bev = k["edge_bevel"]
    bm = bmesh.new()
    mask_layer = bm.verts.layers.float.new("edge_mask")

    def top(u):
        return Hb - Hb * 0.3 * max(0.0, (u - 0.6) / 0.4) ** 1.6

    def bottom(u):
        return Hb * 0.7 * max(0.0, (u - 0.42) / 0.58) ** 2.2

    rings = []
    for i in range(nx + 1):
        u = i / nx
        x = Lb * u
        z0, z1 = bottom(u), top(u)
        taper = 1.0 - 0.8 * u
        prof = []
        for j in range(ns + 1):
            s = j / ns  # 0 edge -> 1 spine
            if s < bev:
                t = 0.0012 + (0.35 * ts * taper - 0.0012) * (s / bev)
            else:
                t = 0.35 * ts * taper + (ts * taper - 0.35 * ts * taper) * ((s - bev) / (1 - bev))
            prof.append((z0 + (z1 - z0) * s, t, 1.0 if s <= bev + 1e-6 else 0.0))
        ring = []
        for z, t, m in prof:
            v = bm.verts.new((x, t, z))
            v[mask_layer] = m
            ring.append(v)
        for z, t, m in reversed(prof[1:-1]):
            v = bm.verts.new((x, -t, z))
            v[mask_layer] = m
            ring.append(v)
        rings.append(ring)
    n = len(rings[0])
    for i in range(nx):
        a, b = rings[i], rings[i + 1]
        for j in range(n):
            bm.faces.new((a[j], b[j], b[(j + 1) % n], a[(j + 1) % n]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    blade_me = bpy.data.meshes.new("KnifeBlade")
    bm.to_mesh(blade_me)
    bm.free()
    shade_smooth(blade_me)
    blade = mesh_object("Knife", blade_me, [mats["DamascusBlade"]], collection)

    # bolster + ergonomic handle: superellipse loft
    def loft(name, x0, x1, ry_fn, rz_fn, zc, mat, nx=40, nr=32, e=2.6):
        bm = bmesh.new()
        rings = []
        for i in range(nx + 1):
            t = i / nx
            x = x0 + (x1 - x0) * t
            ry, rz = ry_fn(t), rz_fn(t)
            ring = []
            for j in range(nr):
                a = j / nr * math.tau
                c, s = math.cos(a), math.sin(a)
                y = ry * math.copysign(abs(c) ** (2 / e), c)
                z = rz * math.copysign(abs(s) ** (2 / e), s)
                ring.append(bm.verts.new((x, y, zc(t) + z)))
            rings.append(ring)
        for i in range(nx):
            for j in range(nr):
                bm.faces.new((rings[i][j], rings[i + 1][j], rings[i + 1][(j + 1) % nr], rings[i][(j + 1) % nr]))
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        shade_smooth(me)
        return mesh_object(name, me, [mat], collection)

    Lh = k["handle_length"]
    zc_b = Hb * 0.78
    bolster = loft("Bolster", -0.22, 0.04, lambda t: ts * 1.6 + 0.03 * math.sin(math.pi * t),
                   lambda t: Hb * 0.2 + Hb * 0.12 * t, lambda t: zc_b + 0.05 * t, mats["SteelPolish"], 8)
    handle = loft("Handle", -0.22 - Lh, -0.2,
                  lambda t: 0.1 + 0.035 * math.sin(math.pi * t) + 0.03 * (1 - t) ** 6,
                  lambda t: 0.18 + 0.04 * math.sin(math.pi * (0.2 + 0.8 * t)) + 0.05 * (1 - t) ** 6,
                  lambda t: zc_b - 0.05 * (1 - t) ** 2, mats["HandleWood"])
    parts = [blade, bolster, handle]
    for rx in (0.45, 1.1, 1.75):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=0.035, radius2=0.035, depth=0.28,
                              matrix=Matrix.Translation((-0.2 - rx, 0, zc_b)) @ Matrix.Rotation(math.pi / 2, 4, "X"))
        me = bpy.data.meshes.new("Rivet")
        bm.to_mesh(me)
        bm.free()
        shade_smooth(me)
        parts.append(mesh_object("Rivet", me, [mats["SteelPolish"]], collection))
    knife = join(parts, "Knife")
    return knife


# ======================================================================= shards
def build_shard_pile(recipe, mats, collection=None):
    """~2k glass shards instanced via Geometry Nodes on a point mound sitting on the board."""
    cfg = recipe["shards"]
    rng = random.Random(cfg["rng"])
    variants = bpy.data.collections.new("ShardVariants")  # intentionally not linked to the scene
    for vi in range(cfg["variants"]):
        bm = bmesh.new()
        pts = []
        for _ in range(14):
            d = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
            pts.append(bm.verts.new((d.x * 1.0, d.y * 0.62, d.z * 0.28)))
        bmesh.ops.convex_hull(bm, input=pts)
        bmesh.ops.scale(bm, vec=(cfg["size"],) * 3, verts=bm.verts[:])
        me = bpy.data.meshes.new(f"Shard{vi}")
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(f"Shard{vi}", me)
        ob.data.materials.append(mats["ShardGlass"])
        variants.objects.link(ob)

    # deterministic point cloud: a mound + a scatter skirt
    me = bpy.data.meshes.new("ShardPoints")
    R, Hm = cfg["mound_radius"], cfg["mound_height"]
    co = []
    for i in range(cfg["count"]):
        r = R * math.sqrt(rng.random()) * (1.35 if i % 7 == 0 else 1.0)
        a = rng.random() * math.tau
        surf = Hm * math.exp(-(r / (0.55 * R)) ** 2)
        z = 0.02 + rng.random() * max(0.0, surf - 0.02)  # fill the mound volume (no hollow ring)
        co.append((r * math.cos(a), r * math.sin(a), z))
    me.from_pydata(co, [], [])
    pile = mesh_object("ShardPile", me, [], collection)

    ng = bpy.data.node_groups.new("ShardScatter", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N, L = ng.nodes, ng.links
    gi, go = N.new("NodeGroupInput"), N.new("NodeGroupOutput")
    iop = N.new("GeometryNodeInstanceOnPoints")
    ci = N.new("GeometryNodeCollectionInfo")
    ci.transform_space = "ORIGINAL"
    ci.inputs["Collection"].default_value = variants
    ci.inputs["Separate Children"].default_value = True
    ci.inputs["Reset Children"].default_value = True

    def rnd(dtype, lo, hi, seed):
        n = N.new("FunctionNodeRandomValue")
        n.data_type = dtype
        stype = {"INT": "INT", "FLOAT": "VALUE", "FLOAT_VECTOR": "VECTOR"}[dtype]
        mins = [s for s in n.inputs if s.name == "Min" and s.type == stype]
        maxs = [s for s in n.inputs if s.name == "Max" and s.type == stype]
        mins[0].default_value, maxs[0].default_value = lo, hi
        n.inputs["Seed"].default_value = seed
        return [s for s in n.outputs if s.type == stype][0]

    L.new(gi.outputs[0], iop.inputs["Points"])
    L.new(ci.outputs[0], iop.inputs["Instance"])
    iop.inputs["Pick Instance"].default_value = True
    L.new(rnd("INT", 0, cfg["variants"] - 1, 1), iop.inputs["Instance Index"])
    L.new(rnd("FLOAT_VECTOR", (0, 0, 0), (math.tau,) * 3, 2), iop.inputs["Rotation"])
    L.new(rnd("FLOAT", 0.55, 1.35, 3), iop.inputs["Scale"])
    L.new(iop.outputs[0], go.inputs[0])
    mod = pile.modifiers.new("ShardScatter", "NODES")
    mod.node_group = ng
    return pile


def shard_meshes(prefix, count, size, rng, flat=(1.0, 0.62, 0.32)):
    """Irregular convex glass chips (convex hull of random points), radius <= size."""
    out = []
    for vi in range(count):
        bm = bmesh.new()
        pts = []
        for _ in range(14):
            d = Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1))).normalized()
            pts.append(bm.verts.new((d.x * flat[0], d.y * flat[1], d.z * flat[2])))
        bmesh.ops.convex_hull(bm, input=pts)
        bmesh.ops.scale(bm, vec=(size,) * 3, verts=bm.verts[:])
        me = bpy.data.meshes.new(f"{prefix}{vi}")
        bm.to_mesh(me)
        bm.free()
        out.append(me)
    return out
