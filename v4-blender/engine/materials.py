"""Physically based Cycles node materials, fully driven by recipe["materials"].

build_all(recipe) -> dict of named bpy.types.Material:
  CrystalGlass, StrawberryCore, EmeraldLeaf, SeedGloss, Gold24K,
  DamascusBlade, SteelPolish, HandleWood, Marble, Cyclorama
"""
import bpy

from .util import hex_rgb, hex_rgba


# ---------------------------------------------------------------- node helpers
class Tree:
    def __init__(self, mat):
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.out = self.node("ShaderNodeOutputMaterial", x=900)

    def node(self, kind, x=0, y=0, **props):
        n = self.nt.nodes.new(kind)
        n.location = (x, y)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def math(self, op, a, b=None, x=0, y=0, clamp=False):
        n = self.node("ShaderNodeMath", x, y, operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        return n.outputs[0]

    def ramp(self, fac, stops, x=0, y=0):
        """stops: [(pos, rgba), ...] — used instead of MixRGB for colour blends."""
        n = self.node("ShaderNodeValToRGB", x, y)
        els = n.color_ramp.elements
        while len(els) > 1:
            els.remove(els[-1])
        els[0].position, els[0].color = stops[0]
        for pos, col in stops[1:]:
            e = els.new(pos)
            e.color = col
        self.link(fac, n.inputs["Fac"])
        return n.outputs["Color"]

    def map_range(self, v, a, b, c, d, x=0, y=0):
        n = self.node("ShaderNodeMapRange", x, y)
        self.link(v, n.inputs["Value"])
        for name, val in zip(("From Min", "From Max", "To Min", "To Max"), (a, b, c, d)):
            n.inputs[name].default_value = val
        return n.outputs["Result"]

    def principled(self, x=500, y=0, **inputs):
        p = self.node("ShaderNodeBsdfPrincipled", x, y)
        for k, v in inputs.items():
            sock = p.inputs[k]
            if isinstance(v, bpy.types.NodeSocket):
                self.link(v, sock)
            else:
                sock.default_value = v
        return p


def _new(name):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if mat.node_tree is None:  # pre-5.0 builds
        mat.use_nodes = True
    return mat


def _absorption(t, color, density, x=500, y=-350):
    va = t.node("ShaderNodeVolumeAbsorption", x, y)
    va.inputs["Color"].default_value = hex_rgba(color)
    va.inputs["Density"].default_value = density
    t.link(va.outputs[0], t.out.inputs["Volume"])
    return va


def _shadow_tint(t, surface, color, x=700, y=200):
    """Fast fake caustic: shadow rays see a coloured Transparent BSDF instead of refractive glass.

    Light reaching the marble through the glass is tinted (ruby / emerald) instead of blocked,
    so there are no black shadows under/inside glass without path-traced caustics.
    """
    lp = t.node("ShaderNodeLightPath", x - 200, y + 250)
    tr = t.node("ShaderNodeBsdfTransparent", x - 200, y - 150)
    tr.inputs["Color"].default_value = hex_rgba(color)
    mix = t.node("ShaderNodeMixShader", x, y)
    t.link(lp.outputs["Is Shadow Ray"], mix.inputs[0])
    t.link(surface, mix.inputs[1])
    t.link(tr.outputs[0], mix.inputs[2])
    t.out.location = (x + 250, y)
    t.link(mix.outputs[0], t.out.inputs["Surface"])
    return mix


def _homogeneous(mat):
    cy = getattr(mat, "cycles", None)
    if cy is not None and hasattr(cy, "homogeneous_volume"):
        cy.homogeneous_volume = True


# ---------------------------------------------------------------- materials
def crystal_glass(cfg):
    mat = _new("CrystalGlass")
    t = Tree(mat)
    p = t.principled(**{
        "Base Color": hex_rgba(cfg["base_tint"]),
        "Transmission Weight": 1.0,
        "IOR": cfg["ior"],
        "Roughness": cfg["roughness"],
        "Coat Weight": cfg["coat"],
        "Coat Roughness": 0.02,
    })
    _shadow_tint(t, p.outputs[0], cfg["shadow_tint"])
    _absorption(t, cfg["color"], cfg["absorption_density"])
    _homogeneous(mat)
    return mat


def shard_glass(cfg, name="ShardGlass"):
    """Small shards are too thin for volume absorption alone: tint the surface as well."""
    mat = _new(name)
    t = Tree(mat)
    p = t.principled(**{
        "Base Color": hex_rgba(cfg["shard_tint"]), "Transmission Weight": 1.0, "IOR": cfg["ior"],
        "Roughness": cfg["roughness"], "Coat Weight": cfg["coat"], "Coat Roughness": 0.02,
    })
    _shadow_tint(t, p.outputs[0], cfg["shadow_tint"])
    _absorption(t, cfg["color"], cfg["shard_density"])
    _homogeneous(mat)
    return mat


def strawberry_core(cfg, glass_cfg):
    """Cut face: clear pink crystal with milky radial rays and a pale central pith.

    Pattern is driven by the 'rest_pos' attribute (pre-cut object space) so it stays
    locked to the fruit after the halves get new origins.
    """
    mat = _new("StrawberryCore")
    t = Tree(mat)
    attr = t.node("ShaderNodeAttribute", -1400, 0, attribute_name="rest_pos")
    sep = t.node("ShaderNodeSeparateXYZ", -1200, 0)
    t.link(attr.outputs["Vector"], sep.inputs[0])
    r = t.math("SQRT", t.math("ADD", t.math("MULTIPLY", sep.outputs["X"], sep.outputs["X"], -1000, 150),
                              t.math("MULTIPLY", sep.outputs["Y"], sep.outputs["Y"], -1000, 50), -850, 100), None, -700, 100)
    # radial rays fan out from the axis toward the skin: angle in (r, z - zc) space
    zc = t.math("SUBTRACT", sep.outputs["Z"], 0.55, -1000, -100)
    comb = t.node("ShaderNodeCombineXYZ", -550, 0)
    t.link(r, comb.inputs["X"])
    t.link(zc, comb.inputs["Y"])
    noise = t.node("ShaderNodeTexNoise", -700, -250)
    noise.inputs["Scale"].default_value = 3.0
    noise.inputs["Detail"].default_value = 4.0
    t.link(attr.outputs["Vector"], noise.inputs["Vector"])
    warp = t.node("ShaderNodeVectorMath", -380, -50, operation="MULTIPLY_ADD")
    t.link(comb.outputs[0], warp.inputs[0])
    warp.inputs[1].default_value = (1.0, 1.0, 1.0)
    jitter = t.node("ShaderNodeVectorMath", -520, -250, operation="SCALE")
    t.link(noise.outputs["Color"], jitter.inputs[0])
    jitter.inputs["Scale"].default_value = 0.08
    t.link(jitter.outputs[0], warp.inputs[2])
    grad = t.node("ShaderNodeTexGradient", -200, 0, gradient_type="RADIAL")
    t.link(warp.outputs[0], grad.inputs["Vector"])
    ang = t.math("MULTIPLY", grad.outputs["Fac"], float(cfg["rays"]), -20, 0)
    wave = t.math("SINE", t.math("MULTIPLY", ang, 6.2831853, 120, 0), None, 260, 0)
    rays = t.math("POWER", t.math("ABSOLUTE", wave, None, 400, 0), cfg["ray_sharpness"], 540, 0)
    # rays fade near the skin, strongest mid-flesh; `ray_strength` keeps them a soft milky haze (no zebra)
    fade = t.map_range(r, 0.05, 0.62, 1.0, 0.25, 400, -150)
    rays = t.math("MULTIPLY", rays, fade, 680, -50, clamp=True)
    rays = t.math("MULTIPLY", rays, cfg.get("ray_strength", 1.0), 760, -50)
    pith = t.map_range(r, cfg["pith_radius"] * 0.4, cfg["pith_radius"], cfg.get("pith_strength", 0.75), 0.0, 400, -300)
    mask = t.math("MAXIMUM", rays, pith, 820, -150, clamp=True)
    # pale pink centre -> deeper ruby toward the skin
    edge = t.map_range(r, cfg.get("edge_from", 0.25), 0.62, 0.0, 1.0, 400, 400)
    tint = t.node("ShaderNodeMix", 700, 450, data_type="RGBA")
    t.link(edge, tint.inputs["Factor"])
    tint.inputs[6].default_value = hex_rgba(cfg["glass_tint"])
    tint.inputs[7].default_value = hex_rgba(cfg.get("edge_tint", cfg["glass_tint"]))

    glass = t.principled(x=1000, y=250, **{
        "Base Color": tint.outputs[2],
        "Transmission Weight": 1.0, "IOR": glass_cfg["ior"],
        "Roughness": 0.05, "Coat Weight": 1.0, "Coat Roughness": 0.03,
    })
    milk = t.principled(x=1000, y=-250, **{
        "Base Color": hex_rgba(cfg["milk"]),
        "Subsurface Weight": 1.0, "Subsurface Radius": (0.25, 0.12, 0.12), "Subsurface Scale": 0.08,
        "Transmission Weight": cfg.get("milk_transmission", 0.35), "Roughness": 0.18,
        "Coat Weight": 1.0, "Coat Roughness": 0.03,
    })
    mix = t.node("ShaderNodeMixShader", 1250, 0)
    t.link(mask, mix.inputs[0])
    t.link(glass.outputs[0], mix.inputs[1])
    t.link(milk.outputs[0], mix.inputs[2])
    _shadow_tint(t, mix.outputs[0], glass_cfg["shadow_tint"], 1500, 0)
    _absorption(t, glass_cfg["color"], cfg["absorption_density"], 1250, -400)
    _homogeneous(mat)
    return mat


def emerald_leaf(cfg):
    mat = _new("EmeraldLeaf")
    t = Tree(mat)
    p = t.principled(**{
        "Base Color": hex_rgba(cfg.get("base_tint", cfg["color"])),
        "Transmission Weight": 0.92, "IOR": 1.52,
        "Roughness": cfg["roughness"],
        "Subsurface Weight": cfg["subsurface"], "Subsurface Radius": (0.1, 0.4, 0.15), "Subsurface Scale": 0.05,
        "Coat Weight": 1.0, "Coat Roughness": 0.03,
    })
    _shadow_tint(t, p.outputs[0], cfg["shadow_tint"])
    _absorption(t, cfg["color"], cfg["absorption_density"])
    _homogeneous(mat)
    return mat


def seed_gloss(cfg):
    """Glossy amber-gold glass seeds (slot name kept as SeedGloss)."""
    mat = _new("SeedGloss")
    t = Tree(mat)
    p = t.principled(**{"Base Color": hex_rgba(cfg["color"]), "Roughness": cfg["roughness"],
                        "Transmission Weight": cfg.get("transmission", 1.0), "IOR": 1.55,
                        "Coat Weight": 1.0, "Coat Roughness": 0.02})
    _shadow_tint(t, p.outputs[0], cfg["color"])
    return mat


def gold_24k(cfg):
    """Saturated 24K gold: pure metal (Metallic 1, low roughness) plus a faint warm emission so the seed
    still reads as gold next to the white glass highlights on a phone screen."""
    mat = _new("Gold24K")
    t = Tree(mat)
    p = t.principled(**{"Base Color": hex_rgba(cfg["color"]), "Metallic": 1.0, "Roughness": cfg["roughness"],
                        "Specular Tint": hex_rgba(cfg["color"]),
                        "Emission Color": hex_rgba(cfg.get("emission_color", cfg["color"])),
                        "Emission Strength": cfg.get("emission", 0.0)})
    t.link(p.outputs[0], t.out.inputs["Surface"])
    return mat


def damascus_blade(cfg):
    """Wavy damascus layers (Wave distorted by Noise) + mirror edge from 'edge_mask'."""
    mat = _new("DamascusBlade")
    t = Tree(mat)
    tc = t.node("ShaderNodeTexCoord", -1300, 0)
    noise = t.node("ShaderNodeTexNoise", -1100, -150)
    noise.inputs["Scale"].default_value = cfg.get("noise_scale", 1.6)
    noise.inputs["Detail"].default_value = 6.0
    t.link(tc.outputs["Object"], noise.inputs["Vector"])
    warp = t.node("ShaderNodeVectorMath", -900, 0, operation="MULTIPLY_ADD")
    t.link(noise.outputs["Color"], warp.inputs[0])
    warp.inputs[1].default_value = (0.35, 0.35, 0.35)
    t.link(tc.outputs["Object"], warp.inputs[2])
    wave = t.node("ShaderNodeTexWave", -700, 0, wave_type="BANDS", bands_direction="DIAGONAL",
                  wave_profile="SIN")
    wave.inputs["Scale"].default_value = cfg["wave_scale"]
    wave.inputs["Distortion"].default_value = cfg.get("distortion", 7.0)
    wave.inputs["Detail"].default_value = 3.0
    wave.inputs["Detail Scale"].default_value = 1.5
    t.link(warp.outputs[0], wave.inputs["Vector"])
    layers = wave.outputs["Fac"]
    col = t.ramp(layers, [(0.35, hex_rgba(cfg["color"])), (0.62, hex_rgba(cfg["light"]))], -450, 150)
    r_lo, r_hi = cfg.get("roughness", [0.16, 0.32])
    rough_steel = t.map_range(layers, 0.3, 0.7, r_hi, r_lo, -450, -100)
    edge = t.node("ShaderNodeAttribute", -450, -300, attribute_name="edge_mask")
    rough = t.node("ShaderNodeMix", -200, -150, data_type="FLOAT")
    t.link(edge.outputs["Fac"], rough.inputs["Factor"])
    t.link(rough_steel, rough.inputs["A"])
    rough.inputs["B"].default_value = cfg["edge_roughness"]
    col_edge = t.ramp(edge.outputs["Fac"], [(0.0, (0, 0, 0, 1)), (1.0, (1, 1, 1, 1))], -200, 300)
    # brighten toward the polished edge: lerp(col, steel) via vector mix (lerp in a ramp-free way)
    lerp = t.node("ShaderNodeVectorMath", 0, 200, operation="MULTIPLY_ADD")
    diff = t.node("ShaderNodeVectorMath", -200, 450, operation="SUBTRACT")
    diff.inputs[0].default_value = (0.78, 0.8, 0.83)
    t.link(col, diff.inputs[1])
    t.link(diff.outputs[0], lerp.inputs[0])
    t.link(col_edge, lerp.inputs[1])
    t.link(col, lerp.inputs[2])
    bump = t.node("ShaderNodeBump", 0, -350)
    bump.inputs["Strength"].default_value = cfg.get("bump", 0.06)
    bump.inputs["Distance"].default_value = 0.002
    t.link(layers, bump.inputs["Height"])
    p = t.principled(x=300, **{"Base Color": lerp.outputs[0], "Metallic": 1.0, "Roughness": rough.outputs["Result"],
                               "Normal": bump.outputs["Normal"], "Anisotropic": 0.35})
    t.link(p.outputs[0], t.out.inputs["Surface"])
    return mat


def cut_line(cfg):
    """Fine glassy score line left on the skin by each knife pass: faint glow, semi-transparent."""
    mat = _new("CutLine")
    t = Tree(mat)
    p = t.principled(**{"Base Color": hex_rgba(cfg["color"]), "Roughness": 0.08, "Coat Weight": 1.0,
                        "Emission Color": hex_rgba(cfg["color"]), "Emission Strength": cfg["glow"],
                        "Alpha": cfg.get("alpha", 1.0)})
    t.link(p.outputs[0], t.out.inputs["Surface"])
    return mat


def steel_polish(cfg):
    mat = _new("SteelPolish")
    t = Tree(mat)
    p = t.principled(**{"Base Color": hex_rgba(cfg["color"]), "Metallic": 1.0, "Roughness": cfg["roughness"]})
    t.link(p.outputs[0], t.out.inputs["Surface"])
    return mat


def handle_wood(cfg):
    mat = _new("HandleWood")
    t = Tree(mat)
    tc = t.node("ShaderNodeTexCoord", -900, 0)
    mapping = t.node("ShaderNodeMapping", -700, 0)
    mapping.inputs["Scale"].default_value = (0.4, 3.0, 3.0)
    t.link(tc.outputs["Object"], mapping.inputs["Vector"])
    wave = t.node("ShaderNodeTexWave", -500, 0, wave_type="RINGS")
    wave.inputs["Scale"].default_value = 3.0
    wave.inputs["Distortion"].default_value = 6.0
    wave.inputs["Detail"].default_value = 4.0
    t.link(mapping.outputs[0], wave.inputs["Vector"])
    col = t.ramp(wave.outputs["Fac"], [(0.2, hex_rgba(cfg["color"])), (0.8, hex_rgba(cfg["grain"]))], -250, 0)
    p = t.principled(**{"Base Color": col, "Roughness": 0.35, "Coat Weight": 0.6, "Coat Roughness": 0.15})
    t.link(p.outputs[0], t.out.inputs["Surface"])
    return mat


def marble(cfg):
    """Light polished travertine/marble: distorted wave veins, travertine pores, roughness 0.15–0.32."""
    mat = _new("Marble")
    t = Tree(mat)
    tc = t.node("ShaderNodeTexCoord", -1400, 0)
    big = t.node("ShaderNodeTexNoise", -1200, -200)
    big.inputs["Scale"].default_value = 0.35
    big.inputs["Detail"].default_value = 8.0
    big.inputs["Roughness"].default_value = 0.6
    t.link(tc.outputs["Object"], big.inputs["Vector"])
    warp = t.node("ShaderNodeVectorMath", -1000, 0, operation="MULTIPLY_ADD")
    t.link(big.outputs["Color"], warp.inputs[0])
    warp.inputs[1].default_value = (2.6, 2.6, 2.6)
    t.link(tc.outputs["Object"], warp.inputs[2])
    veins = t.node("ShaderNodeTexWave", -800, 0, wave_type="BANDS", bands_direction="DIAGONAL")
    veins.inputs["Scale"].default_value = 0.22
    veins.inputs["Distortion"].default_value = 9.0
    veins.inputs["Detail"].default_value = 8.0
    veins.inputs["Detail Roughness"].default_value = 0.65
    t.link(warp.outputs[0], veins.inputs["Vector"])
    vein = t.ramp(veins.outputs["Fac"], [(0.0, (1, 1, 1, 1)), (0.025, (0, 0, 0, 1)), (0.975, (0, 0, 0, 1)),
                                         (1.0, (1, 1, 1, 1))], -560, 0)
    fine = t.node("ShaderNodeTexNoise", -800, -350)
    fine.inputs["Scale"].default_value = 6.0
    fine.inputs["Detail"].default_value = 10.0
    t.link(warp.outputs[0], fine.inputs["Vector"])
    cloud = t.math("MULTIPLY", fine.outputs["Fac"], 0.12, -560, -350)
    sep = t.node("ShaderNodeSeparateColor", -380, 0)
    t.link(vein, sep.inputs[0])
    vmask = t.math("ADD", sep.outputs[0], cloud, -200, 0, clamp=True)
    col = t.ramp(vmask, [(0.0, hex_rgba(cfg["base"])), (0.18, hex_rgba(cfg["base"])),
                         (1.0, hex_rgba(cfg["vein"]))], 0, 150)
    lo, hi = cfg["roughness"]
    rough = t.map_range(fine.outputs["Fac"], 0.35, 0.65, lo, hi, 0, -100)
    pores = t.node("ShaderNodeTexVoronoi", -380, -500)
    pores.inputs["Scale"].default_value = 18.0
    t.link(tc.outputs["Object"], pores.inputs["Vector"])
    pit = t.map_range(pores.outputs["Distance"], 0.0, 0.12, 0.0, 1.0, -150, -500)
    bump = t.node("ShaderNodeBump", 200, -400)
    bump.inputs["Strength"].default_value = 0.08
    bump.inputs["Distance"].default_value = 0.004
    t.link(pit, bump.inputs["Height"])
    p = t.principled(x=450, **{"Base Color": col, "Roughness": rough, "Normal": bump.outputs["Normal"],
                               "Subsurface Weight": 0.08, "Subsurface Radius": (0.5, 0.4, 0.3),
                               "Subsurface Scale": 0.05, "Specular IOR Level": 0.5})
    t.link(p.outputs[0], t.out.inputs["Surface"])
    return mat


def cyclorama(cfg):
    mat = _new("Cyclorama")
    t = Tree(mat)
    p = t.principled(**{"Base Color": hex_rgba(cfg["color"]), "Roughness": 0.75})
    t.link(p.outputs[0], t.out.inputs["Surface"])
    return mat


# ---------------------------------------------------------------- crystal rubik's cube (fruit.shape)
def jewel_tile(name, c, g):
    """One of the 6 jewel glass tile colours: saturated transmissive surface tint + mild volume absorption.
    Shadow rays see a Transparent BSDF of the same hue -> soft coloured light on the marble, no black shadow."""
    mat = _new(name)
    t = Tree(mat)
    # tint only where light ENTERS a tile: exits through the opposite (other-coloured) tiles stay clear glass,
    # otherwise ruby x sapphire filters multiply to black and the cube reads murky
    geo = t.node("ShaderNodeNewGeometry", -400, 300)
    tint = t.node("ShaderNodeMix", -200, 250, data_type="RGBA")
    t.link(geo.outputs["Backfacing"], tint.inputs["Factor"])
    tint.inputs[6].default_value = hex_rgba(c.get("base", c["hex"]))
    tint.inputs[7].default_value = hex_rgba(g.get("inner", "#ffffff"))
    p = t.principled(**{
        "Base Color": tint.outputs[2], "Transmission Weight": 1.0, "IOR": g["ior"],
        "Roughness": c.get("roughness", g["roughness"]), "Coat Weight": g["coat"], "Coat Roughness": 0.02,
    })
    _shadow_tint(t, p.outputs[0], c["shadow"])
    _absorption(t, c["hex"], g["absorption_density"] * c.get("density_k", 1.0))
    _homogeneous(mat)
    return mat


def obsidian_frame(cfg):
    """Dark smoky obsidian glass of the grooves / cube skeleton (shadow rays: smoky grey, never pitch black)."""
    mat = _new("ObsidianFrame")
    t = Tree(mat)
    p = t.principled(**{
        "Base Color": hex_rgba(cfg["base"]), "Transmission Weight": cfg["transmission"], "IOR": cfg["ior"],
        "Roughness": cfg["roughness"], "Coat Weight": 1.0, "Coat Roughness": 0.02,
    })
    _shadow_tint(t, p.outputs[0], cfg["shadow"])
    _absorption(t, cfg["hex"], cfg["absorption_density"])
    _homogeneous(mat)
    return mat


def rubiks_core(cfg, fruit):
    """crystal-rubiks-core cut face: clear smoky-quartz glass (Coat 1.0) with a soft glow of the nearest tile's
    colour toward the cube surface. Tile colours come from an 18x3 lookup texture (face*3+iu, iw) indexed by the
    pre-cut 'rest_pos', so the glow matches the exact scrambled tile above every cap edge. No stripes."""
    from .rubiks import tile_lookup_pixels
    mat = _new("RubiksCore")
    t = Tree(mat)
    img = bpy.data.images.get("RubiksTileLUT") or bpy.data.images.new("RubiksTileLUT", 18, 3, alpha=True,
                                                                         float_buffer=True)
    img.pixels = tile_lookup_pixels(fruit)
    S = fruit["size"]
    h, a = S / 2, S / 3
    zc = h + fruit["tile_dome"]
    attr = t.node("ShaderNodeAttribute", -1800, 0, attribute_name="rest_pos")
    sep = t.node("ShaderNodeSeparateXYZ", -1600, 0)
    t.link(attr.outputs["Vector"], sep.inputs[0])
    q = [sep.outputs["X"], sep.outputs["Y"], t.math("SUBTRACT", sep.outputs["Z"], zc, -1450, -100)]
    other = ((1, 2), (0, 2), (0, 1))
    wsum, edge, acc = None, None, None
    for ax in range(3):
        y = 600 - 450 * ax
        dist = t.math("SUBTRACT", h, t.math("ABSOLUTE", q[ax], None, -1300, y), -1150, y)
        mr = t.node("ShaderNodeMapRange", -1000, y, interpolation_type="SMOOTHSTEP")
        t.link(dist, mr.inputs["Value"])
        mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = 0.0, cfg["glow_falloff"]
        mr.inputs["To Min"].default_value, mr.inputs["To Max"].default_value = 1.0, 0.0
        wgt = mr.outputs["Result"]
        face = t.math("ADD", t.math("GREATER_THAN", q[ax], 0.0, -1150, y - 120), 2.0 * ax, -1000, y - 120)
        tu, tw = [t.math("MAXIMUM", t.math("MINIMUM", t.math("DIVIDE", t.math("ADD", q[o], h, -1300, y - 240 - 60 * k),
                                                                           a, -1150, y - 240 - 60 * k),
                                              2.999, -1000, y - 240 - 60 * k), 0.0, -850, y - 240 - 60 * k)
                  for k, o in enumerate(other[ax])]
        U = t.math("DIVIDE", t.math("ADD", t.math("MULTIPLY", face, 3.0, -850, y - 120), tu, -700, y - 120), 18.0,
                   -550, y - 120)
        V = t.math("DIVIDE", tw, 3.0, -700, y - 240)
        uv = t.node("ShaderNodeCombineXYZ", -400, y - 150)
        t.link(U, uv.inputs["X"])
        t.link(V, uv.inputs["Y"])
        tex = t.node("ShaderNodeTexImage", -250, y - 150, interpolation="Closest", extension="EXTEND")
        tex.image = img
        t.link(uv.outputs[0], tex.inputs["Vector"])
        sc = t.node("ShaderNodeVectorMath", -20, y, operation="SCALE")
        t.link(tex.outputs["Color"], sc.inputs[0])
        t.link(wgt, sc.inputs["Scale"])
        if acc is None:
            acc, wsum, edge = sc.outputs[0], wgt, wgt
        else:
            ad = t.node("ShaderNodeVectorMath", 120, y, operation="ADD")
            t.link(acc, ad.inputs[0])
            t.link(sc.outputs[0], ad.inputs[1])
            acc = ad.outputs[0]
            wsum = t.math("ADD", wsum, wgt, 120, y - 200)
            edge = t.math("MAXIMUM", edge, wgt, 120, y - 300)
    inv = t.math("DIVIDE", 1.0, t.math("MAXIMUM", wsum, 1e-3, 260, -400), 400, -400)
    avg = t.node("ShaderNodeVectorMath", 420, -150, operation="SCALE")
    t.link(acc, avg.inputs[0])
    t.link(inv, avg.inputs["Scale"])
    tint = t.node("ShaderNodeMix", 600, 200, data_type="RGBA")
    t.link(t.math("MULTIPLY", edge, cfg["glow_strength"], 450, 250), tint.inputs["Factor"])
    tint.inputs[6].default_value = hex_rgba(cfg["glass_tint"])
    t.link(avg.outputs[0], tint.inputs[7])
    p = t.principled(x=800, y=0, **{
        "Base Color": tint.outputs[2], "Transmission Weight": 1.0, "IOR": cfg["ior"],
        "Roughness": cfg["roughness"], "Coat Weight": cfg["coat"], "Coat Roughness": 0.02,
        "Emission Color": avg.outputs[0], "Emission Strength": t.math("MULTIPLY", edge, cfg["glow_emission"], 600, -300),
    })
    _shadow_tint(t, p.outputs[0], cfg["shadow"], 1100, 0)
    _absorption(t, cfg["absorption"], cfg["absorption_density"], 1100, -400)
    _homogeneous(mat)
    return mat


def build_rubiks(recipe):
    """Material set for fruit.shape == 'crystal-rubiks-cube' (coreStyle 'crystal-rubiks-core')."""
    m = recipe["materials"]
    s = recipe["studio"]
    fr = recipe["fruit"]
    g = m["tile_glass"]
    out = {
        "CutLine": cut_line(m["cut_line"]),
        "Gold24K": gold_24k(m["gold"]),
        "DamascusBlade": damascus_blade(m["damascus"]),
        "SteelPolish": steel_polish(m["steel"]),
        "HandleWood": handle_wood(m["handle"]),
        "Marble": marble(s["board"]),
        "Cyclorama": cyclorama(s["cyclorama"]),
        "ObsidianFrame": obsidian_frame(m["obsidian"]),
    }
    palette = []
    sh = m["shards"]
    for c in fr["palette"]:
        out[f"Tile_{c['name']}"] = jewel_tile(f"Tile_{c['name']}", c, g)
        sm = shard_glass({"shard_tint": c.get("shard", c["hex"]), "ior": g["ior"], "roughness": g["roughness"],
                          "coat": g["coat"], "shadow_tint": c["shadow"], "color": c["hex"],
                          "shard_density": sh["density"] * c.get("density_k", 1.0)}, f"Shard_{c['name']}")
        out[sm.name] = sm
        palette.append((sm, (1.0 - sh["obsidian"]) / len(fr["palette"]), "glass"))
    ob = m["obsidian"]
    so = shard_glass({"shard_tint": ob["shard"], "ior": ob["ior"], "roughness": ob["roughness"], "coat": 1.0,
                      "shadow_tint": ob["shadow"], "color": ob["hex"], "shard_density": ob["shard_density"]},
                     "Shard_obsidian")
    out[so.name] = so
    palette.append((so, sh["obsidian"], "obsidian"))
    if fr.get("coreStyle", "crystal-rubiks-core") != "crystal-rubiks-core":
        raise ValueError(f"unknown coreStyle {fr.get('coreStyle')}")
    out["RubiksCore"] = rubiks_core(m["core"], fr)
    # cutter / timeline hooks: every surface material caps to the core; R4-R5 shard palette
    out["_cap_from"] = [out[f"Tile_{c['name']}"] for c in fr["palette"]] + [out["ObsidianFrame"]]
    out["_cap_to"] = out["RubiksCore"]
    out["_shard_palette"] = palette
    return out


def build_all(recipe):
    if recipe.get("fruit", {}).get("shape") == "crystal-rubiks-cube":
        return build_rubiks(recipe)
    m = recipe["materials"]
    s = recipe["studio"]
    return {
        "CrystalGlass": crystal_glass(m["crystal_glass"]),
        "ShardGlass": shard_glass(m["crystal_glass"]),
        "ShardEmerald": shard_glass(m["emerald_shard"], "ShardEmerald"),
        "CutLine": cut_line(m["cut_line"]),
        "StrawberryCore": strawberry_core(m["core"], m["crystal_glass"]),
        "EmeraldLeaf": emerald_leaf(m["leaves"]),
        "SeedGloss": seed_gloss(m["seeds"]),
        "Gold24K": gold_24k(m["gold"]),
        "DamascusBlade": damascus_blade(m["damascus"]),
        "SteelPolish": steel_polish(m["steel"]),
        "HandleWood": handle_wood(m["handle"]),
        "Marble": marble(s["board"]),
        "Cyclorama": cyclorama(s["cyclorama"]),
    }
