"""Post: compositor-side motion blur (Vector Blur) instead of Cycles 3D motion blur.

3D motion blur makes Cycles trace motion steps for every moving object; a Vector pass +
compositor Vector Blur gives the same shutter streak for near-zero render cost.
Blender 5.x API: scene.compositing_node_group + Group Output (no Composite node).
"""
import bpy


def setup_vector_blur(scene, shutter=0.35, samples=32):
    scene.render.use_motion_blur = False
    vl = scene.view_layers[0]
    vl.use_pass_vector = True
    vl.use_pass_z = True

    ng = bpy.data.node_groups.new("SliceFactoryComp", "CompositorNodeTree")
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    rl = ng.nodes.new("CompositorNodeRLayers")
    rl.scene = scene
    rl.layer = vl.name
    vb = ng.nodes.new("CompositorNodeVecBlur")
    vb.inputs["Samples"].default_value = samples
    vb.inputs["Shutter"].default_value = shutter
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(rl.outputs["Image"], vb.inputs["Image"])
    ng.links.new(rl.outputs["Vector"], vb.inputs["Speed"])
    ng.links.new(rl.outputs["Depth"], vb.inputs["Depth"])
    ng.links.new(vb.outputs["Image"], out.inputs[0])

    scene.compositing_node_group = ng
    if hasattr(scene, "use_nodes"):
        scene.use_nodes = True
    scene.render.use_compositing = True
    return ng
