"""Small shared helpers: colour conversion, object plumbing, camera aiming."""
import json
import os

import bpy
from mathutils import Vector


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(hex_str):
    """'#ff1744' -> linear (r, g, b)."""
    h = hex_str.lstrip("#")
    return tuple(_srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


def hex_rgba(hex_str, alpha=1.0):
    return (*hex_rgb(hex_str), alpha)


def link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def mesh_object(name, mesh, materials=(), collection=None):
    obj = bpy.data.objects.new(name, mesh)
    for m in materials:
        obj.data.materials.append(m)
    return link(obj, collection)


def select_only(*objs):
    vl = bpy.context.view_layer
    for o in vl.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    vl.objects.active = objs[0]


def join(objs, name):
    """Join objects into objs[0] (material slots merged by Blender)."""
    select_only(*objs)
    with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=list(objs)):
        bpy.ops.object.join()
    objs[0].name = name
    objs[0].data.name = name
    return objs[0]


def shade_smooth(mesh, smooth=True):
    for p in mesh.polygons:
        p.use_smooth = smooth


def aim(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path
