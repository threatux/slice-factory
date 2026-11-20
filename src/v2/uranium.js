// Cylinder-mode (Nuclear Fuel Rod U-235) materials. Only used when recipe.object.shape === "cylinder" and
// coreStyle === "uranium-core":
//  - makeUraniumPieceMaterial(): R1-R3 clipped pieces: titanium capsule skin (atlas uv) outside, layered fuel rod on aCap faces;
//  - makeUraniumGrainMaterial(): R4-R6 InstancedMesh micro pieces: shell pieces sample the capsule skin (titanium, hazard
//    stripes, markings) at their projected surface point, inner pieces evaluate the same layers as the R1-R3 cut faces.
// Layers (r = |p.xz| / R, h = |y| / (H/2)): steel/titanium shell r > 0.84 or h > 0.86; graphite moderator 0.50-0.84 with green
// decay cracks; crystalline uranium plasma 0.20-0.50 (cellular, capped emission); white-hot fuel pin r <= 0.20.
import * as THREE from 'three';
import { URANIUM_ATLAS as A } from '../textures.js';

export const U_LAYERS = {
  shell: '#374151', graphite: '#0a120c', cracks: ['#00e676', '#76ff03'], uranium: ['#39ff14', '#b2ff59'], pin: ['#ecfccb', '#ffffff'],
  bounds: [0.84, 0.5, 0.2], lid: 0.86,
};
const L = U_LAYERS;
const glsl3 = (c) => { const k = new THREE.Color(c); return `vec3(${k.r.toFixed(4)}, ${k.g.toFixed(4)}, ${k.b.toFixed(4)})`; };
const f = (x) => x.toFixed(4);

const URANIUM_GLSL = `
float uH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float uN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(uH(i), uH(i + vec3(1, 0, 0)), f.x), mix(uH(i + vec3(0, 1, 0)), uH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(uH(i + vec3(0, 0, 1)), uH(i + vec3(1, 0, 1)), f.x), mix(uH(i + vec3(0, 1, 1)), uH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float uF(vec3 p) { return 0.5 * uN(p) + 0.25 * uN(p * 2.03) + 0.125 * uN(p * 4.07) + 0.0625 * uN(p * 8.1); }
vec3 uH3(vec3 p) { return vec3(uH(p), uH(p + 17.3), uH(p + 41.9)); }
// cellular (F1, F2) -> crystal grains of the uranium zone
vec2 uCellN(vec3 x) {
  vec3 i = floor(x), fr = fract(x); float d1 = 8.0, d2 = 8.0;
  for (int a = -1; a <= 1; a++) for (int b = -1; b <= 1; b++) for (int c = -1; c <= 1; c++) {
    vec3 g = vec3(float(a), float(b), float(c)), o = uH3(i + g) * 0.85 + 0.075;
    float d = length(g + o - fr);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(d1, d2);
}
void uraniumLayer(vec3 p, float R, float Hh, float glow, out vec3 alb, out vec3 emi, out float rough, out float metal) {
  vec3 q = vec3(p.x / R, p.y / Hh, p.z / R);
  float n = uF(q * 6.0);
  float r = length(q.xz) + (n - 0.5) * 0.025;
  float h = abs(q.y);
  // steel / titanium shell (machined: lathe rings + brushing)
  float ring = 0.5 + 0.5 * sin(r * 90.0 + n * 2.0);
  vec3 sAlb = ${glsl3(L.shell)} * (0.85 + 0.2 * ring + 0.15 * (uN(q * 14.0) - 0.5));
  // graphite moderator: dark, grainy, thin branching decay cracks (few, low frequency -> no aliasing)
  float c1 = 1.0 - abs(2.0 * uF(q * 2.4 + vec3(n * 1.2)) - 1.0);
  float c2 = 1.0 - abs(2.0 * uF(q * 5.2 + vec3(n * 1.6) + 3.7) - 1.0);
  float crk = max(smoothstep(0.93, 0.985, c1), smoothstep(0.95, 0.99, c2) * 0.6);
  float tg = clamp((${f(L.bounds[0])} - r) / ${f(L.bounds[0] - L.bounds[1])}, 0.0, 1.0);
  vec3 cc = mix(${glsl3(L.cracks[0])}, ${glsl3(L.cracks[1])}, tg);
  vec3 gAlb = mix(${glsl3(L.graphite)} * (0.8 + 0.5 * uF(q * 7.0)), cc * 0.35, crk);
  vec3 gEmi = cc * crk * 0.7;
  // uranium: crystalline cells, saturated green with dark grain borders (structure stays readable, no white blow-out)
  vec3 cq = q * 4.6 + vec3(0.0, n * 0.6, 0.0);
  vec2 cl = uCellN(cq);
  float edge = smoothstep(0.03, 0.16, cl.y - cl.x), cellv = uH(floor(cq) + 0.37);
  float tu = clamp((${f(L.bounds[1])} - r) / ${f(L.bounds[1] - L.bounds[2])}, 0.0, 1.0);
  vec3 uc = mix(${glsl3(L.uranium[0])}, ${glsl3(L.uranium[1])}, clamp(0.3 * tu + 0.5 * cellv + 0.3 * cl.x, 0.0, 1.0));
  float facet = 0.75 + 0.25 * smoothstep(0.0, 0.6, cl.x);
  vec3 uAlb = uc * (0.1 + 0.18 * edge), uEmi = uc * edge * (0.16 + 0.24 * cellv) * facet;
  // fuel pin: yellow-green-white, embossed relief
  float pn = uF(q * 9.0);
  vec3 pc = mix(${glsl3(L.pin[0])}, ${glsl3(L.pin[1])}, smoothstep(${f(L.bounds[2])}, 0.0, r) * (0.6 + 0.4 * pn));
  vec3 pAlb = pc * (0.3 + 0.2 * pn), pEmi = pc * (0.24 + 0.24 * pn);
  float wS = max(smoothstep(${f(L.bounds[0] - 0.01)}, ${f(L.bounds[0] + 0.01)}, r), smoothstep(${f(L.lid - 0.01)}, ${f(L.lid + 0.01)}, h));
  float wU = smoothstep(${f(L.bounds[1] + 0.012)}, ${f(L.bounds[1] - 0.012)}, r);
  float wP = smoothstep(${f(L.bounds[2] + 0.01)}, ${f(L.bounds[2] - 0.01)}, r);
  alb = mix(mix(mix(gAlb, uAlb, wU), pAlb, wP), sAlb, wS);
  emi = mix(mix(mix(gEmi, uEmi, wU), pEmi, wP), vec3(0.0), wS) * glow;
  rough = mix(mix(mix(mix(0.82, 0.5, crk), 0.34, wU), 0.4, wP), 0.3 + 0.12 * ring, wS);
  metal = wS * 0.85;
}
// atlas uv of the nearest skin point of the rod (wall or lid), same layout as cylinder.js cylUV()
vec2 uSkinUV(vec3 p, float R, float Hh) {
  float rr = length(p.xz);
  if (Hh - abs(p.y) < R - rr) {
    vec2 c = p.y > 0.0 ? vec2(${f(A.caps[0][0])}, ${f(A.caps[0][1])}) : vec2(${f(A.caps[1][0])}, ${f(A.caps[1][1])});
    vec2 px = c + vec2(p.x, p.y > 0.0 ? p.z : -p.z) / R * ${f(A.capR)};
    return vec2(px.x / ${f(A.W)}, 1.0 - px.y / ${f(A.H)});
  }
  float u = 0.5 + atan(p.x, p.z) / 6.2831853;
  float py = clamp((Hh - p.y) / (2.0 * Hh), 0.0, 1.0) * ${f(A.side)};
  return vec2(u, 1.0 - py / ${f(A.H)});
}`;

/** R1-R3 piece material: capsule skin (atlas uv) outside, fuel-rod layers on aCap faces (aSph = cylinder-local position). */
export function makeUraniumPieceMaterial(rod, R, H, o = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: rod.map, roughnessMap: rod.ormMap, metalnessMap: rod.ormMap, roughness: 1, metalness: 1,
    bumpMap: rod.bumpMap, bumpScale: o.bump ?? 1.0, clearcoat: o.clearcoat ?? 0.25, clearcoatRoughness: 0.3, envMapIntensity: o.envMapIntensity ?? 1.0,
    emissive: 0xffffff, emissiveMap: rod.emissiveMap, emissiveIntensity: o.slotGlow ?? 1.4,
  });
  const U = { uER: { value: R }, uEH: { value: H / 2 }, uEGlow: { value: o.coreGlow ?? 1 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSph; attribute float aCap; varying vec3 vESph; varying float vECap;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvESph = aSph; vECap = aCap;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uER, uEH, uEGlow; varying vec3 vESph; varying float vECap;\n${URANIUM_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
vec3 eAlb, eEmi; float eRough, eMetal;
uraniumLayer(vESph, uER, uEH, uEGlow, eAlb, eEmi, eRough, eMetal);
float eCap = step(0.5, vECap);
diffuseColor.rgb = mix(diffuseColor.rgb, eAlb, eCap);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, eRough, eCap);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, eMetal, eCap);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = mix(totalEmissiveRadiance, eEmi, eCap);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.clearcoat *= 1.0 - eCap;');
  };
  mat.customProgramCacheKey = () => 'uranium-piece-v1';
  return mat;
}

/**
 * R4-R6 micro pieces (InstancedMesh, aOutP = home cell centre, uCell = cell size): shell pieces show the capsule skin at their
 * projected surface point (titanium, hazard stripes, trefoil / marking chips, slot glow), inner pieces the fuel layers.
 * Instance colour = brightness jitter, aHeat = emission jitter.
 */
export function makeUraniumGrainMaterial(rod, R, H, o = {}) {
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.0, clearcoat: 0.2, clearcoatRoughness: 0.3, envMapIntensity: o.envMapIntensity ?? 1.0 });
  const U = {
    uER: { value: R }, uEH: { value: H / 2 }, uEGlow: { value: o.coreGlow ?? 1 }, uCell: { value: 0.1 }, uSlot: { value: o.slotGlow ?? 1.4 },
    uSkin: { value: rod.map }, uOrm: { value: rod.ormMap }, uSkinE: { value: rod.emissiveMap },
  };
  mat.userData.uniforms = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHeat; attribute vec3 aOutP; uniform float uCell; varying float vGHeat; varying vec3 vGP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGHeat = aHeat; vGP = aOutP + position * uCell;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uER, uEH, uEGlow, uSlot; uniform sampler2D uSkin, uOrm, uSkinE; varying float vGHeat; varying vec3 vGP;
${URANIUM_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec3 gAlb, gEmi; float gRough, gMetal;
uraniumLayer(vGP, uER, uEH, uEGlow, gAlb, gEmi, gRough, gMetal);
float gShell = max(step(${f(L.bounds[0])}, length(vGP.xz) / uER), step(${f(L.lid)}, abs(vGP.y) / uEH));
vec2 gUV = uSkinUV(vGP, uER, uEH);
vec3 sOrm = texture2D(uOrm, gUV).rgb;
gAlb = mix(gAlb, texture2D(uSkin, gUV).rgb, gShell);
gEmi = mix(gEmi, texture2D(uSkinE, gUV).rgb * uSlot, gShell);
gRough = mix(gRough, sOrm.g, gShell);
gMetal = mix(gMetal, sOrm.b, gShell);
diffuseColor.rgb = gAlb * diffuseColor.rgb;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmi * vGHeat;');
  };
  mat.customProgramCacheKey = () => 'uranium-grain-v1';
  return mat;
}

/** Micro piece look: brightness jitter (instance colour) + emission jitter (aHeat); the colour itself comes from the shader. */
export function uraniumGrainLook(rf, hash, out) {
  const k = 0.88 + 0.24 * hash;
  out.color.setRGB(k, k, k);
  out.heat = rf > L.bounds[0] ? 1.0 : 0.8 + 0.4 * hash;
  return out;
}
