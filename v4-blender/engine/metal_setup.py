"""Cycles + Apple Silicon Metal GPU configuration.

configure(scene, profiles, quality) forces GPU-only rendering on METAL and applies
bounce limits, caustics, OIDN denoising (albedo+normal) and AgX colour management.
Raises if no Metal GPU is present, so a render can never silently fall back to CPU.
"""
import bpy


def enable_metal():
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.refresh_devices()
    gpus, cpus = [], []
    for dev in prefs.devices:
        is_gpu = dev.type == "METAL"
        dev.use = is_gpu  # CPU explicitly disabled for rendering
        (gpus if is_gpu else cpus).append(dev.name)
    if not gpus:
        raise RuntimeError("No Metal GPU device found — refusing to render on CPU.")
    return {"backend": prefs.compute_device_type, "gpus": gpus, "disabled": cpus}


def apply_quality(scene, quality):
    cy = scene.cycles
    scene.render.resolution_x, scene.render.resolution_y = quality["resolution"]
    scene.render.resolution_percentage = quality.get("percentage", 100)
    if scene.render.fps != quality["fps"]:  # assigning fps (even unchanged) resets rigid-body caches
        scene.render.fps = quality["fps"]
    cy.samples = quality["samples"]
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = quality["adaptive_threshold"]
    cy.adaptive_min_samples = quality["adaptive_min_samples"]
    if "transmission_bounces" in quality:
        cy.transmission_bounces = quality["transmission_bounces"]


def _set_look(view, wanted):
    # Blender 5.x names looks per view ("AgX - Punchy"); older builds use "Punchy".
    for name in (f"{view.view_transform} - {wanted}", wanted):
        try:
            view.look = name
            return name
        except TypeError:
            continue
    return view.look


def configure(scene, profiles, quality):
    scene.render.engine = "CYCLES"
    info = enable_metal()
    cy = scene.cycles
    cy.device = "GPU"

    b = profiles["bounces"]
    cy.max_bounces = b["max_bounces"]
    cy.diffuse_bounces = b["diffuse_bounces"]
    cy.glossy_bounces = b["glossy_bounces"]
    cy.transmission_bounces = b["transmission_bounces"]
    cy.transparent_max_bounces = b["transparent_max_bounces"]
    cy.volume_bounces = b["volume_bounces"]
    # path-traced caustics are the dominant cost; glass shaders fake the coloured glow
    # on shadow rays instead (materials._shadow_tint)
    cy.caustics_reflective = profiles.get("caustics_reflective", False)
    cy.caustics_refractive = profiles.get("caustics_refractive", False)
    cy.blur_glossy = profiles["filter_glossy"]
    cy.sample_clamp_direct = 0.0
    cy.sample_clamp_indirect = profiles["clamp_indirect"]

    cy.use_denoising = True
    cy.denoiser = "OPENIMAGEDENOISE"
    cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    cy.denoising_prefilter = "ACCURATE"
    if hasattr(cy, "denoising_use_gpu"):
        cy.denoising_use_gpu = True

    apply_quality(scene, quality)
    scene.render.use_persistent_data = True
    scene.render.film_transparent = False

    view = scene.view_settings
    scene.display_settings.display_device = "sRGB"
    view.view_transform = profiles["view_transform"]
    info["look"] = _set_look(view, profiles["look"])
    info["view_transform"] = view.view_transform

    img = scene.render.image_settings
    img.file_format = "PNG"
    img.color_mode = "RGB"
    img.color_depth = "8"
    info["device"] = cy.device
    info["denoiser"] = cy.denoiser
    return info


def set_shadow_caustics(enabled):
    """MNEE shadow caustics (Cycles caster/receiver/light flags). Costly: ~-46% frame time when off.
    Path-traced caustics (caustics_reflective/refractive) are unaffected."""
    n = 0
    for ob in bpy.data.objects:
        cy = getattr(ob, "cycles", None)
        if cy is not None and hasattr(cy, "is_caustics_caster"):
            cy.is_caustics_caster = enabled and cy.is_caustics_caster
            cy.is_caustics_receiver = enabled and cy.is_caustics_receiver
    for light in bpy.data.lights:
        cy = getattr(light, "cycles", None)
        if cy is not None and hasattr(cy, "is_caustics_light"):
            if cy.is_caustics_light:
                n += 1
            cy.is_caustics_light = enabled and cy.is_caustics_light
    return n
