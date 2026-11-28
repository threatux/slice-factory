"""Watertight bmesh cutting + Bullet rigid-body setup + collision event export.

cut(obj, golds, plane_co, plane_no, mats, bevel) -> (half_neg, half_pos)
  * bmesh.ops.bisect_plane on two copies (clear_outer / clear_inner)
  * cap filled with triangle_fill (handles every coplanar loop: body, crown, seeds)
  * caps on CrystalGlass get StrawberryCore; caps on other parts keep their material
  * micro-chamfer (bmesh bevel) on the cut rim so the edge catches light
  * hidden gold seeds are joined into whichever half holds their centre

setup_rigid_bodies / simulate: ACTIVE convex hulls on a PASSIVE box board; events.json is
derived from the stepped Bullet trajectories (Blender exposes no contact callbacks).
"""
import json
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

from .util import select_only


# ------------------------------------------------------------------- cutting
def _islands(boundary):
    """Group boundary edges by connected mesh island (body, each seed, each leaf...).

    Parts are allowed to interpenetrate (seeds sit in pits, calyx overlaps the body), so their
    cut loops intersect in the plane; scanfill must see one island at a time.
    """
    vert_island = {}
    groups = []
    for e in boundary:
        if e.verts[0] in vert_island:
            continue
        gid = len(groups)
        stack = [e.verts[0]]
        vert_island[e.verts[0]] = gid
        while stack:
            v = stack.pop()
            for le in v.link_edges:
                w = le.other_vert(v)
                if w not in vert_island:
                    vert_island[w] = gid
                    stack.append(w)
        groups.append([])
    for e in boundary:
        groups[vert_island[e.verts[0]]].append(e)
    return groups


def _ordered_loop(edges):
    adj = {}
    for e in edges:
        a, b = e.verts
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    if any(len(n) != 2 for n in adj.values()):
        return None
    start = edges[0].verts[0]
    loop, prev, cur = [start], None, start
    while True:
        nxt = adj[cur][0] if adj[cur][0] is not prev else adj[cur][1]
        if nxt is start:
            break
        loop.append(nxt)
        prev, cur = cur, nxt
    return loop if len(loop) == len(adj) else None


def _cap(bm, cut_edges, plane_no, mat_map, proud):
    """Returns (cap faces, rim edges of the largest skin-glass island for the micro-bevel).

    proud: {material_index: offset} — islands of that material (opaque inclusions such as gold)
    get their cap pushed out along the cut normal so it sits in front of the glass cap.
    """
    boundary = [e for e in cut_edges if e.is_valid and e.is_boundary]
    caps, main_rim = [], []
    for edges in _islands(boundary):
        src = edges[0].link_faces[0].material_index
        ret = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges, normal=plane_no)
        faces = [f for f in ret["geom"] if isinstance(f, bmesh.types.BMFace)]
        if any(e.is_boundary for e in edges):
            # scanfill gave up (thin leaf sliver overlapping itself in projection):
            # drop the partial triangles and close the loop with one ordered n-gon
            bmesh.ops.delete(bm, geom=faces, context="FACES_ONLY")
            faces = []
            loop = _ordered_loop(edges)
            if loop:
                try:
                    faces = [bm.faces.new(loop)]
                except ValueError:
                    pass
        mi = mat_map.get(src, src)
        for f in faces:
            f.material_index = mi
            f.smooth = False
        if src in proud:
            verts = {v for f in faces for v in f.verts}
            for v in verts:
                v.co += plane_no * proud[src]
        caps += faces
        if src in mat_map and len(edges) > len(main_rim):
            main_rim = edges
    wire = [e for e in bm.edges if e.is_wire]  # interior edges of discarded partial fills
    if wire:
        bmesh.ops.delete(bm, geom=wire, context="EDGES")
    return [f for f in caps if f.is_valid], main_rim


def _half(src, plane_co, plane_no, keep_negative, mat_map, bevel, proud=None):
    ob = src.copy()
    ob.data = src.data.copy()
    ob.name = f"{src.name}_{'A' if keep_negative else 'B'}"
    src.users_collection[0].objects.link(ob)
    inv = ob.matrix_world.inverted()
    co = inv @ Vector(plane_co)
    no = (inv.to_3x3() @ Vector(plane_no)).normalized()

    bm = bmesh.new()
    bm.from_mesh(ob.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    res = bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=co, plane_no=no,
                                 clear_outer=keep_negative, clear_inner=not keep_negative)
    cut_edges = [g for g in res["geom_cut"] if isinstance(g, bmesh.types.BMEdge)]
    outward = no if keep_negative else -no
    out_proud = {k: v for k, v in (proud or {}).items()}
    cap_faces, rim = _cap(bm, cut_edges, outward, mat_map, out_proud)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if bevel > 0 and rim:
        rim = [e for e in rim if e.is_valid]
        bv = bmesh.ops.bevel(bm, geom=rim, offset=bevel, offset_type="OFFSET", segments=2, profile=0.5,
                             affect="EDGES", clamp_overlap=True)
        for f in bv["faces"]:
            f.smooth = True
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return ob, len(cap_faces)


def _origin_to_volume(ob):
    select_only(ob)
    with bpy.context.temp_override(active_object=ob, selected_editable_objects=[ob], object=ob):
        bpy.ops.object.origin_set(type="ORIGIN_CENTER_OF_VOLUME", center="MEDIAN")


def _count_material_faces(ob, mat):
    slots = [m.name for m in ob.data.materials]
    if mat.name not in slots:
        return 0
    i = slots.index(mat.name)
    return sum(1 for p in ob.data.polygons if p.material_index == i)


def cut(obj, plane_co, plane_no, mats, bevel, proud_gold=0.003):
    slots = [m.name for m in obj.data.materials]
    mat_map = {slots.index(mats["CrystalGlass"].name): slots.index(mats["StrawberryCore"].name)}
    proud = {}
    if mats["Gold24K"].name in slots:
        proud[slots.index(mats["Gold24K"].name)] = proud_gold
    a, caps_a = _half(obj, plane_co, plane_no, True, mat_map, bevel, proud)
    b, caps_b = _half(obj, plane_co, plane_no, False, mat_map, bevel, proud)
    gold_before = _count_material_faces(obj, mats["Gold24K"])
    revealed = [h.name for h in (a, b) if _count_material_faces(h, mats["Gold24K"]) > 0
                and _count_material_faces(h, mats["Gold24K"]) != gold_before]
    for ob in (a, b):
        _origin_to_volume(ob)
    obj.hide_render = obj.hide_viewport = True
    return a, b, {"cap_faces": [caps_a, caps_b], "gold_cut_in": revealed}


def pose_apart(halves, plane_no, gap, tilt_deg, pivot_mode="inner"):
    """Nudge halves off the cut plane and tilt them outward about their bottom contact.
    pivot_mode 'outer': tilt about the outer bottom edge (flat-bottomed solids: no board penetration at large tilt)."""
    n = Vector(plane_no).normalized()
    for ob, sign in zip(halves, (-1, 1)):
        d = n * sign
        if pivot_mode == "outer":
            mw = ob.matrix_world
            ext = max((mw @ v.co).dot(d) for v in ob.data.vertices)
            pivot = Vector((0, 0, 0)) + d * (ext + gap)
        else:
            pivot = Vector((0, 0, 0)) + d * gap
        axis = Vector((0, 0, 1)).cross(d).normalized()
        R = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(tilt_deg), 4, axis) @ Matrix.Translation(-pivot)
        lift = Matrix.Translation((0, 0, 0.004))  # start just above the board, no initial penetration
        ob.matrix_world = lift @ R @ Matrix.Translation(d * gap) @ ob.matrix_world


# ------------------------------------------------------------------- physics
def _rb_add(ob, kind):
    select_only(ob)
    with bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob]):
        bpy.ops.rigidbody.object_add(type=kind)
    return ob.rigid_body


def setup_rigid_bodies(scene, halves, board, cfg):
    if scene.rigidbody_world is None:
        with bpy.context.temp_override(scene=scene):
            bpy.ops.rigidbody.world_add()
    rbw = scene.rigidbody_world
    rbw.substeps_per_frame = cfg["substeps"]
    rbw.solver_iterations = cfg["iterations"]
    rbw.point_cache.frame_start = 1
    rbw.point_cache.frame_end = cfg["frames"]
    scene.use_gravity = True
    scene.gravity = (0, 0, cfg["gravity"])
    scene.frame_start, scene.frame_end = 1, cfg["frames"]

    rb = _rb_add(board, "PASSIVE")
    rb.collision_shape = "BOX"
    rb.friction = cfg["friction"]
    rb.restitution = cfg["restitution"]
    for ob in halves:
        rb = _rb_add(ob, "ACTIVE")
        rb.collision_shape = "CONVEX_HULL"
        rb.mass = 1.0
        rb.friction = cfg["friction"]
        rb.restitution = cfg["restitution"]
        rb.use_margin = True
        rb.collision_margin = cfg["margin"]
        rb.linear_damping, rb.angular_damping = cfg["damping"]
    return rbw


def _hull_points(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    ret = bmesh.ops.convex_hull(bm, input=bm.verts[:])
    pts = [v.co.copy() for v in ret["geom"] if isinstance(v, bmesh.types.BMVert)]
    bm.free()
    return pts


def simulate(scene, halves, board_top_z, events_path, fps):
    """Step the Bullet sim frame by frame (fills the point cache) and log impacts/settling."""
    hulls = {ob.name: _hull_points(ob) for ob in halves}
    prev = {}
    events = [{"type": "cut", "frame": 1, "time": 0.0, "objects": [o.name for o in halves]}]
    settled = set()
    still = {o.name: 0 for o in halves}
    last_hit = {o.name: -99 for o in halves}
    for f in range(scene.frame_start, scene.frame_end + 1):
        scene.frame_set(f)
        for ob in halves:
            mw = ob.matrix_world.copy()
            pos = mw.translation.copy()
            low = min((mw @ p).z for p in hulls[ob.name])
            if ob.name in prev:
                ppos, pvel = prev[ob.name]
                vel = (pos - ppos) * fps
                if (pvel.z < -0.4 and vel.z > pvel.z * 0.4 and low < board_top_z + 0.05
                        and f - last_hit[ob.name] >= 3):  # one contact = one event
                    last_hit[ob.name] = f
                    events.append({"type": "impact", "frame": f, "time": round((f - 1) / fps, 4),
                                   "object": ob.name, "surface": "MarbleBoard",
                                   "speed": round(pvel.length, 4), "normal_speed": round(-pvel.z, 4),
                                   "point": [round(pos.x, 4), round(pos.y, 4), round(low, 4)]})
                still[ob.name] = still[ob.name] + 1 if vel.length < 0.08 else 0
                if still[ob.name] == 3 and ob.name not in settled:
                    settled.add(ob.name)
                    events.append({"type": "settle", "frame": f, "time": round((f - 1) / fps, 4),
                                   "object": ob.name})
            else:
                vel = Vector((0, 0, 0))
            prev[ob.name] = (pos, vel)
    # freeze the stepped sim: an unbaked cache is invalidated by unrelated scene edits
    # (e.g. re-assigning render.fps) and would re-simulate from mid-timeline on frame_set
    rbw = scene.rigidbody_world
    with bpy.context.temp_override(scene=scene, point_cache=rbw.point_cache):
        bpy.ops.ptcache.bake_from_cache()
    with open(events_path, "w", encoding="utf-8") as fh:
        json.dump({"fps": fps, "frames": scene.frame_end, "events": events}, fh, indent=2)
    return events


# ------------------------------------------------------------------- multi-cut (v4 rounds)
def _signed_range(ob, co, no):
    import numpy as np
    n = len(ob.data.vertices)
    if n == 0:
        return 0.0, 0.0
    v = np.empty(n * 3, dtype=np.float64)
    ob.data.vertices.foreach_get("co", v)
    v = v.reshape(-1, 3)
    mw = np.array(ob.matrix_world)
    w = v @ mw[:3, :3].T + mw[:3, 3]
    d = (w - np.array(co)) @ np.array(no)
    return float(d.min()), float(d.max())


def cap_map(obj, mats):
    """{surface slot: cap slot}. Strawberry: CrystalGlass -> StrawberryCore. Other shapes publish
    mats['_cap_from'] (every surface material) and mats['_cap_to'] (their core style)."""
    slots = [m.name for m in obj.data.materials]
    if "_cap_from" in mats:
        to = slots.index(mats["_cap_to"].name)
        return {slots.index(m.name): to for m in mats["_cap_from"] if m.name in slots}
    return {slots.index(mats["CrystalGlass"].name): slots.index(mats["StrawberryCore"].name)}


def slice_planes(obj, planes, mats, bevel, min_size=0.06, name="Piece"):
    """Cut obj by every plane in order; each piece is re-capped watertight (StrawberryCore on glass).

    planes: [(co, no), ...] in world space. Returns pieces sorted by a stable key (deterministic order).
    The source object is left untouched (caller hides it).
    """
    mat_map = cap_map(obj, mats)
    work = obj.copy()
    work.data = obj.data.copy()
    obj.users_collection[0].objects.link(work)
    pieces = [work]
    for co, no in planes:
        nv = Vector(no).normalized()
        nxt = []
        for p in pieces:
            lo, hi = _signed_range(p, co, nv)
            if lo >= -1e-5 or hi <= 1e-5:  # plane misses this piece
                nxt.append(p)
                continue
            a, _ = _half(p, co, nv, True, mat_map, bevel)
            b, _ = _half(p, co, nv, False, mat_map, bevel)
            for h in (a, b):
                if len(h.data.polygons) > 0:
                    nxt.append(h)
                else:
                    bpy.data.objects.remove(h)
            bpy.data.objects.remove(p)
        pieces = nxt
    kept = []
    for p in pieces:
        d = max(p.dimensions)
        if d < min_size or len(p.data.vertices) < 30:
            bpy.data.objects.remove(p)
            continue
        kept.append(p)
    for p in kept:
        _origin_to_volume(p)
    kept.sort(key=lambda o: (round(o.location.z, 3), round(o.location.x, 3), round(o.location.y, 3)))
    for i, p in enumerate(kept):
        p.name = f"{name}{i:03d}"
        p.data.name = p.name
    return kept


def section_loops(mesh, co, no, min_len=6):
    """Ordered world-space loops where plane (co, no) crosses `mesh` (skin only) — for visible cut lines."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6,
                                 plane_co=Vector(co), plane_no=Vector(no).normalized())
    edges = [g for g in res["geom_cut"] if isinstance(g, bmesh.types.BMEdge)]
    adj = {}
    for e in edges:
        a, b = e.verts
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen, loops = set(), []
    for start in list(adj):
        if start in seen or len(adj[start]) != 2:
            continue
        loop, prev, cur = [start], None, start
        seen.add(start)
        while True:
            nb = [w for w in adj[cur] if w is not prev]
            if not nb or len(adj[cur]) != 2:
                break
            nxt = nb[0]
            if nxt is start or nxt in seen:
                break
            loop.append(nxt)
            seen.add(nxt)
            prev, cur = cur, nxt
        if len(loop) >= min_len:
            loops.append([v.co.copy() for v in loop])
    bm.free()
    return loops


# ------------------------------------------------------------------- deterministic sim + record
def _fresh_world(scene, cfg, n_frames):
    with bpy.context.temp_override(scene=scene):
        if scene.rigidbody_world is not None:
            bpy.ops.rigidbody.world_remove()
        bpy.ops.rigidbody.world_add()
    rbw = scene.rigidbody_world
    rbw.substeps_per_frame = cfg["substeps"]
    rbw.solver_iterations = cfg["iterations"]
    rbw.time_scale = 1.0
    rbw.use_split_impulse = False
    rbw.point_cache.frame_start = 1
    rbw.point_cache.frame_end = n_frames
    scene.use_gravity = True
    scene.gravity = (0, 0, cfg["gravity"])
    scene.frame_start, scene.frame_end = 1, n_frames
    return rbw


def simulate_record(scene, bodies, board, cfg, n_frames, force=None, shape="CONVEX_HULL"):
    """Run one isolated Bullet simulation and return per-body trajectories.

    Determinism: fresh RB world (cache reset), fixed substeps/iterations, bodies added in a stable
    order, sequential stepping from frame 1, cache baked right after. Returns
    {"loc": ndarray (B, F, 3), "quat": ndarray (B, F, 4), "impacts": [(frame, body_idx, intensity)]}.
    """
    import numpy as np
    sim_fps = cfg["sim_fps"]
    if scene.render.fps != sim_fps:
        scene.render.fps = sim_fps
    rbw = _fresh_world(scene, cfg, n_frames)
    scene.frame_set(1)

    rb = _rb_add(board, "PASSIVE")
    rb.collision_shape = "BOX"
    rb.friction = cfg["friction"]
    rb.restitution = cfg["restitution"]
    for ob in bodies:  # stable order (caller sorts)
        r = _rb_add(ob, "ACTIVE")
        r.collision_shape = shape
        r.mass = max(0.01, (ob.dimensions.x * ob.dimensions.y * ob.dimensions.z) ** 0.5)
        r.friction = cfg["friction"]
        r.restitution = cfg["restitution"]
        r.use_margin = True
        r.collision_margin = cfg["margin"]
        r.linear_damping, r.angular_damping = cfg["damping"]
        if cfg.get("deactivation"):  # settled bodies sleep (Bullet island deactivation, still deterministic)
            r.use_deactivation = True
            r.deactivate_linear_velocity = cfg["deactivation"][0]
            r.deactivate_angular_velocity = cfg["deactivation"][1]

    field = None
    if force:
        field = bpy.data.objects.new("BurstField", None)
        scene.collection.objects.link(field)
        field.location = force["center"]
        with bpy.context.temp_override(object=field, active_object=field):
            bpy.ops.object.forcefield_toggle()
        field.field.type = "FORCE"
        field.field.shape = "POINT"
        field.field.use_max_distance = True
        field.field.distance_max = force.get("radius", 2.0)
        field.field.falloff_type = "SPHERE"
        field.field.strength = force["strength"]  # switched off after force["frames"] sim frames

    with bpy.context.temp_override(scene=scene, point_cache=rbw.point_cache):
        bpy.ops.ptcache.free_bake_all()
    B = len(bodies)
    loc = np.zeros((B, n_frames, 3))
    quat = np.zeros((B, n_frames, 4))
    for f in range(1, n_frames + 1):
        if field is not None and f == 1 + force["frames"]:
            field.field.strength = 0.0
        scene.frame_set(f)
        for i, ob in enumerate(bodies):
            l, q, _ = ob.matrix_world.decompose()
            loc[i, f - 1] = l
            quat[i, f - 1] = (q.w, q.x, q.y, q.z)
    with bpy.context.temp_override(scene=scene, point_cache=rbw.point_cache):
        bpy.ops.ptcache.bake_from_cache()

    # impacts: a falling body whose downward speed is suddenly reduced (contact with board / pile)
    vel = np.diff(loc, axis=1) * sim_fps  # (B, F-1, 3)
    impacts = []
    cool = np.full(B, -99)
    for f in range(1, vel.shape[1]):
        vz0, vz1 = vel[:, f - 1, 2], vel[:, f, 2]
        hit = (vz0 < -0.35) & ((vz1 - vz0) > 0.45) & (f - cool >= 3)
        for i in np.nonzero(hit)[0]:
            cool[i] = f
            impacts.append((f + 1, int(i), float(min(1.0, -vz0[i] / 6.0))))

    if field is not None:
        bpy.data.objects.remove(field)
    with bpy.context.temp_override(scene=scene):
        bpy.ops.rigidbody.world_remove()
    return {"loc": loc, "quat": quat, "impacts": impacts}
