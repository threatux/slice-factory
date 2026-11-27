"""Keyframe plumbing for Blender 5.x layered actions (slots + channelbags).

Everything that moves in the v4 timeline (knife, camera, focus, rigid-body pieces after baking) is
driven by plain F-curves, so the Vector pass and Vector Blur get exact sub-frame motion.
"""
import bpy
from bpy_extras import anim_utils


def _channelbag(obj):
    ad = obj.animation_data or obj.animation_data_create()
    if ad.action is None:
        act = bpy.data.actions.new(f"{obj.name}_act")
        ad.action = act
        ad.action_slot = act.slots.new(id_type="OBJECT", name=obj.name)
    return anim_utils.action_ensure_channelbag_for_slot(ad.action, ad.action_slot)


def _curve(cb, path, index, frames, values, interp):
    fc = cb.fcurves.find(path, index=index) or cb.fcurves.new(path, index=index)
    n = len(frames)
    fc.keyframe_points.clear()
    fc.keyframe_points.add(n)
    co = [0.0] * (2 * n)
    co[0::2] = frames
    co[1::2] = values
    fc.keyframe_points.foreach_set("co", co)
    fc.keyframe_points.foreach_set("interpolation", [interp] * n)
    fc.update()
    return fc


INTERP = {"CONSTANT": 0, "LINEAR": 1, "BEZIER": 2}


def key_transform(obj, frames, locs, quats=None, interp="LINEAR"):
    """frames: [f...] (may be fractional); locs: [(x,y,z)...]; quats: [(w,x,y,z)...] (sign-continuous)."""
    cb = _channelbag(obj)
    code = INTERP[interp]
    for i in range(3):
        _curve(cb, "location", i, frames, [p[i] for p in locs], code)
    if quats is not None:
        obj.rotation_mode = "QUATERNION"
        prev = None
        fixed = []
        for q in quats:  # keep hemisphere continuity so linear interpolation never flips
            q = list(q)
            if prev is not None and sum(a * b for a, b in zip(prev, q)) < 0:
                q = [-c for c in q]
            fixed.append(q)
            prev = q
        for i in range(4):
            _curve(cb, "rotation_quaternion", i, frames, [q[i] for q in fixed], code)


def key_value(obj, path, frames, values, index=0, interp="LINEAR"):
    cb = _channelbag(obj)
    _curve(cb, path, index, frames, values, INTERP[interp])
