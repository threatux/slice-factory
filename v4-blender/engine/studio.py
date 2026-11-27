"""'bright-marble' macro studio: bevelled marble board, seamless warm cyclorama,
3-point Area softbox rig (key / fill / rim), warm world, and an 85mm physical camera."""
import math

import bmesh
import bpy
from mathutils import Vector

from .util import aim, hex_rgb, link, mesh_object, shade_smooth


def build_board(cfg, mat):
    sx, sy, sz = cfg["size"]
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts[:])
    bmesh.ops.bevel(bm, geom=bm.edges[:], offset=cfg["bevel"], offset_type="OFFSET", segments=4,
                    profile=0.5, affect="EDGES", clamp_overlap=True)
    me = bpy.data.meshes.new("MarbleBoard")
    bm.to_mesh(me)
    bm.free()
    shade_smooth(me)
    board = mesh_object("MarbleBoard", me, [mat])
    board.location.z = -sz / 2  # mesh centred on origin (Bullet BOX shape is origin-centred); top at z = 0
    cy = getattr(board, "cycles", None)
    for t in (board, cy):
        if t is not None and hasattr(t, "is_caustics_receiver"):
            t.is_caustics_receiver = True
    return board


def build_cyclorama(cfg, mat):
    """Floor -> quarter-circle sweep -> back wall, extruded along X. No black voids anywhere."""
    R, fz, by = cfg["radius"], cfg["floor_z"], cfg["back_y"]
    prof = [(y, fz) for y in (-40.0, -20.0, -5.0, 0.0, by - R)]
    for i in range(1, 17):
        a = i / 16 * math.pi / 2
        prof.append((by - R + R * math.sin(a), fz + R - R * math.cos(a)))
    prof += [(by, fz + R + 10), (by, fz + R + 40)]
    bm = bmesh.new()
    left = [bm.verts.new((-60, y, z)) for y, z in prof]
    right = [bm.verts.new((60, y, z)) for y, z in prof]
    for i in range(len(prof) - 1):
        bm.faces.new((left[i], right[i], right[i + 1], left[i + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new("Cyclorama")
    bm.to_mesh(me)
    bm.free()
    shade_smooth(me)
    # make sure normals face the set (toward -Y / +Z)
    if me.polygons[0].normal.z < 0:
        for p in me.polygons:
            p.flip()
    return mesh_object("Cyclorama", me, [mat])


def build_world(cfg):
    world = bpy.data.worlds.new("StudioWorld")
    bpy.context.scene.world = world
    nt = world.node_tree
    bg = nt.nodes.get("Background") or nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (*hex_rgb(cfg["color"]), 1.0)
    bg.inputs["Strength"].default_value = cfg["strength"]
    out = nt.nodes.get("World Output") or nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    return world


def build_lights(cfg, target=(0, 0, 0.7)):
    lights = {}
    for name, lc in cfg.items():
        ld = bpy.data.lights.new(f"{name.title()}Light", "AREA")
        ld.shape = "RECTANGLE"
        ld.size, ld.size_y = lc["size"]
        ld.energy = lc["power"]
        ld.color = hex_rgb(lc["color"])
        if lc.get("caustics"):
            cy = getattr(ld, "cycles", None)
            for t in (ld, cy):
                if t is not None and hasattr(t, "is_caustics_light"):
                    t.is_caustics_light = True
        ob = link(bpy.data.objects.new(f"{name.title()}Light", ld))
        ob.location = lc["pos"]
        aim(ob, target)
        lights[name] = ob
    return lights


def build_camera(cfg):
    cd = bpy.data.cameras.new("MacroCam")
    cd.lens = cfg["lens"]
    cd.sensor_width = cfg["sensor"]
    cd.sensor_fit = "AUTO"
    cd.dof.use_dof = True
    cd.dof.aperture_fstop = cfg["fstop"]
    cd.dof.aperture_blades = 9
    cam = link(bpy.data.objects.new("MacroCam", cd))
    focus = link(bpy.data.objects.new("FocusTarget", None))
    cd.dof.focus_object = focus
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = cfg["shutter"]
    return cam, focus


def frame_shot(cam, focus, pos, target, focus_point=None):
    cam.location = Vector(pos)
    aim(cam, target)
    focus.location = Vector(focus_point or target)


def frame_objects(cam, focus, objs, direction_from, fit=1.3):
    """Aim along the recipe's camera direction and back off until the objects' world bbox fits."""
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    radius = (hi - lo).length / 2
    cd = cam.data
    sensor_short = cd.sensor_width * min(1.0, bpy.context.scene.render.resolution_x / bpy.context.scene.render.resolution_y)
    half_fov = math.atan(sensor_short / 2 / cd.lens)
    dist = radius * fit / math.tan(half_fov)
    d = Vector(direction_from).normalized()
    frame_shot(cam, focus, center + d * dist, center)
    return center, dist


def build(recipe, mats):
    st = recipe["studio"]
    board = build_board(st["board"], mats["Marble"])
    cyclo = build_cyclorama(st["cyclorama"], mats["Cyclorama"])
    world = build_world(st["world"])
    lights = build_lights(st["lights"])
    cam, focus = build_camera(recipe["camera"])
    bpy.context.scene.view_settings.exposure = st.get("exposure", 0.0)
    return {"board": board, "cyclorama": cyclo, "world": world, "lights": lights, "camera": cam, "focus": focus}
