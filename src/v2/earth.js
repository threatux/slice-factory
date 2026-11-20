// Sphere-mode (Planet Earth) materials. Only used when recipe.object.shape === "sphere".
//  - makeEarthSurface(): intact planet skin (equirect albedo + roughness + bump);
//  - makeLayeredPieceMaterial(): R1-R3 pieces: Earth skin outside, concentric interior on every flat cut face
//    (r = |p| / R: crust 0.90-1.00, molten mantle 0.48-0.90 with convection veins, liquid outer core 0.24-0.48, white-hot inner core);
//  - makeEarthGrainMaterial(): R4-R6 InstancedMesh micro pieces (instance colour = layer colour, aHeat = emission);
//  - makeAtmosphere(): soft Fresnel limb + back-side halo (no soap-bubble edge);
//  - crystalGeometry(): faceted alien crystal (per-facet gradient, flat shaded).
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mulberry32 } from '../util.js';

export const LAYERS = {
  crust: '#3a322d', mantle: ['#7a1200', '#e83f00', '#ff7b00'], outer: ['#ffaa00', '#ffe66d'], inner: ['#fff4b8', '#ffffff'],
  bounds: [0.9, 0.48, 0.24],
};

const glsl3 = (c) => { const k = new THREE.Color(c); return `vec3(${k.r.toFixed(4)}, ${k.g.toFixed(4)}, ${k.b.toFixed(4)})`; };

/** GLSL: value noise + earthLayer(p, R) -> albedo / emissive / roughness of the planet interior at sphere-local p. */
const LAYER_GLSL = `
float eH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float eN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(eH(i), eH(i + vec3(1, 0, 0)), f.x), mix(eH(i + vec3(0, 1, 0)), eH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(eH(i + vec3(0, 0, 1)), eH(i + vec3(1, 0, 1)), f.x), mix(eH(i + vec3(0, 1, 1)), eH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float eF(vec3 p) { return 0.5 * eN(p) + 0.25 * eN(p * 2.03) + 0.125 * eN(p * 4.07) + 0.0625 * eN(p * 8.1); }
void earthLayer(vec3 p, float R, float glow, out vec3 alb, out vec3 emi, out float rough) {
  vec3 q = p / R;
  float n = eF(q * 7.0);
  float r = length(q) + (n - 0.5) * 0.035;
  // convection veins (ridged noise, warped) + fine cracks
  float v1 = 1.0 - abs(2.0 * eF(q * 4.5 + vec3(n * 1.7)) - 1.0);
  float vein = smoothstep(0.82, 0.97, v1);
  float crk = smoothstep(0.9, 0.99, 1.0 - abs(2.0 * eN(q * 26.0 + vec3(n * 3.0)) - 1.0));
  vec3 crust = ${glsl3(LAYERS.crust)} * (0.75 + 0.5 * eN(q * 40.0));
  float tm = clamp((0.9 - r) / 0.42, 0.0, 1.0);
  vec3 mant = mix(${glsl3(LAYERS.mantle[0])}, ${glsl3(LAYERS.mantle[1])}, smoothstep(0.0, 0.55, tm));
  mant = mix(mant, ${glsl3(LAYERS.mantle[2])}, smoothstep(0.55, 1.0, tm));
  float to = clamp((0.48 - r) / 0.24, 0.0, 1.0);
  vec3 oc = mix(${glsl3(LAYERS.outer[0])}, ${glsl3(LAYERS.outer[1])}, smoothstep(0.0, 1.0, to));
  vec3 ic = mix(${glsl3(LAYERS.inner[0])}, ${glsl3(LAYERS.inner[1])}, smoothstep(0.24, 0.0, r));
  float wC = smoothstep(0.885, 0.905, r);          // crust above
  float wO = smoothstep(0.49, 0.47, r);            // outer core below
  float wI = smoothstep(0.25, 0.23, r);            // inner core below
  // mantle: dark crusted rock between glowing convection veins (no flat orange slab)
  float mk = 0.35 + 0.65 * smoothstep(0.25, 0.75, n);
  vec3 mAlb = mant * 0.22, mEmi = mant * (0.55 * mk + 1.5 * vein) + ${glsl3(LAYERS.mantle[2])} * crk * 0.9;
  vec3 oAlb = oc * 0.35, oEmi = oc * (0.8 + 0.3 * n) * (0.8 + 0.35 * vein);
  vec3 iAlb = ic * 0.4, iEmi = ic * (1.15 + 0.2 * n);
  alb = mix(mix(mix(mAlb, oAlb, wO), iAlb, wI), crust, wC);
  emi = mix(mix(mix(mEmi, oEmi, wO), iEmi, wI), crust * 0.0 + ${glsl3(LAYERS.mantle[1])} * crk * 0.35 * smoothstep(0.93, 0.9, r), wC) * glow;
  rough = mix(mix(0.62, 0.45, wO), 0.92, wC);
}`;

/** R1-R3 piece material: Earth skin (uv) on the outside, layered interior on aCap faces (aSph = sphere-local position). */
export function makeLayeredPieceMaterial(earth, R, glow = 1) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: earth.map, roughnessMap: earth.roughnessMap, bumpMap: earth.bumpMap, bumpScale: 1.6, roughness: 1, metalness: 0,
    clearcoat: 0.0, envMapIntensity: 1.0,
  });
  const U = { uER: { value: R }, uEGlow: { value: glow } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSph; attribute float aCap; varying vec3 vESph; varying float vECap;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvESph = aSph; vECap = aCap;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uER, uEGlow; varying vec3 vESph; varying float vECap;\n${LAYER_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
vec3 eAlb, eEmi; float eRough;
earthLayer(vESph, uER, uEGlow, eAlb, eEmi, eRough);
float eCap = step(0.5, vECap);
diffuseColor.rgb = mix(diffuseColor.rgb, eAlb, eCap);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, eRough, eCap);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += eEmi * eCap;');
  };
  mat.customProgramCacheKey = () => 'earth-piece-v1';
  return mat;
}

/**
 * R4-R6 micro pieces. Interior pieces (aHeat > 0) evaluate the same layered interior as the R1-R3 cut faces at their true
 * sphere-local position (aOutP = home cell centre, uCell = cell size) -> mantle chunks carry glowing veins, core chunks burn gold.
 * Crust pieces (aHeat <= 0) keep the sampled surface colour (instance colour) with fine rock noise; aHeat < 0 = glossy ocean.
 */
export function makeEarthGrainMaterial(R, glow = 1) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.0, envMapIntensity: 1.1 });
  const U = { uER: { value: R }, uEGlow: { value: glow }, uCell: { value: 0.1 } };
  mat.userData.uniforms = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHeat; attribute vec3 aOutP; uniform float uCell; varying float vGHeat; varying vec3 vGP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGHeat = aHeat; vGP = aOutP + position * uCell;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uER, uEGlow; varying float vGHeat; varying vec3 vGP;\n${LAYER_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec3 gAlb, gEmi; float gRough;
earthLayer(vGP, uER, uEGlow, gAlb, gEmi, gRough);
float gIn = step(0.01, vGHeat);
diffuseColor.rgb = mix(diffuseColor.rgb * (0.82 + 0.36 * eN(vGP / uER * 60.0)), gAlb, gIn);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(roughnessFactor, 0.22, step(vGHeat, -0.5)), gRough, gIn);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmi * gIn;');
  };
  mat.customProgramCacheKey = () => 'earth-grain-v2';
  return mat;
}

/**
 * Colour + heat of a micro piece from its home radius (fraction of R) and the surface sample above it.
 * aHeat < 0 marks glossy ocean crust (roughness 0.22).
 */
export function grainLook(rf, surf, hash, out) {
  const c = out.color;
  if (rf > LAYERS.bounds[0] - 0.04) { // crust: blue-green surface with white cloud glints
    c.setRGB(surf.rgb[0] / 255, surf.rgb[1] / 255, surf.rgb[2] / 255, THREE.SRGBColorSpace);
    const cl = surf.cloud * 0.75 * (hash > 0.35 ? 1 : 0.3);
    c.lerp(out.white, cl);
    const ocean = surf.rgb[2] > surf.rgb[1] && surf.rgb[2] > surf.rgb[0] * 1.3;
    out.heat = ocean && cl < 0.3 ? -1 : 0;
    return out;
  }
  if (rf > LAYERS.bounds[1]) { // mantle
    const t = (LAYERS.bounds[0] - rf) / (LAYERS.bounds[0] - LAYERS.bounds[1]);
    c.copy(out.m0).lerp(out.m1, Math.min(1, t * 1.6)).lerp(out.m2, Math.max(0, t * 1.6 - 0.6) * 0.8);
    out.heat = hash > 0.45 ? 0.5 + 0.45 * t : 0.1 + 0.2 * t; // glowing lava chunks between dark cooling rock
    return out;
  }
  if (rf > LAYERS.bounds[2]) { c.copy(out.o0).lerp(out.o1, (LAYERS.bounds[1] - rf) / (LAYERS.bounds[1] - LAYERS.bounds[2])); out.heat = 0.8 + 0.25 * hash; return out; }
  c.copy(out.i0).lerp(out.i1, 1 - rf / LAYERS.bounds[2]); out.heat = 1.05 + 0.25 * hash;
  return out;
}
export function grainLookState() {
  const C = (x) => new THREE.Color(x);
  return { color: new THREE.Color(), heat: 0, white: C('#f4f8ff'), m0: C(LAYERS.mantle[0]), m1: C(LAYERS.mantle[1]), m2: C(LAYERS.mantle[2]),
    o0: C(LAYERS.outer[0]), o1: C(LAYERS.outer[1]), i0: C(LAYERS.inner[0]), i1: C(LAYERS.inner[1]) };
}

/** Thin limb glow on the planet (front shell) + soft outer halo (back shell). Both fade to exactly 0 at their own silhouette. */
export function makeAtmosphere(R, color = '#4cc9f0', strength = 1) {
  const col = new THREE.Color(color);
  const mk = (side, frag) => new THREE.ShaderMaterial({
    uniforms: { uCol: { value: col }, uK: { value: strength } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side, toneMapped: false,
    vertexShader: `varying vec3 vN; varying vec3 vV;
void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uCol; uniform float uK; varying vec3 vN; varying vec3 vV;
void main() { float d = dot(normalize(vN), normalize(vV)); ${frag} gl_FragColor = vec4(uCol * a * uK, 1.0); }`,
  });
  // limb: Fresnel on a shell just above the clouds, faded out before the shell's own edge (d -> 0) to avoid a hard ring
  const limb = new THREE.Mesh(new THREE.SphereGeometry(R * 1.022, 128, 64), mk(THREE.FrontSide,
    'float f = 1.0 - clamp(d, 0.0, 1.0); float a = pow(f, 3.2) * smoothstep(0.0, 0.22, d) * 0.85;'));
  // halo: back faces of a wider shell, 0 at its silhouette, strongest where it meets the planet limb
  const Rh = 1.075, dl = Math.sqrt(1 - 1 / (Rh * Rh));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(R * Rh, 128, 64), mk(THREE.BackSide,
    `float u = clamp(-d / ${dl.toFixed(4)}, 0.0, 1.0); float a = pow(u, 2.4) * 0.55;`));
  limb.renderOrder = 3; halo.renderOrder = 2;
  return { limb, halo };
}

/** Faceted alien crystal: irregular hexagonal bipyramid (convex hull), per-facet gradient lo -> mid -> hi, flat shaded. */
export function crystalGeometry(r, [cLo, cMid, cHi, cSpark]) {
  const rnd = mulberry32(4242), pts = [];
  pts.push(new THREE.Vector3(0.03 * r, 1.75 * r, 0), new THREE.Vector3(-0.02 * r, -1.25 * r, 0.02 * r));
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
    const ru = 0.52 * r * (0.88 + 0.24 * rnd()), rl = 0.6 * r * (0.88 + 0.24 * rnd());
    pts.push(new THREE.Vector3(Math.cos(a) * ru, (0.62 + 0.1 * rnd()) * r, Math.sin(a) * ru));
    pts.push(new THREE.Vector3(Math.cos(a + 0.12) * rl, (-0.38 - 0.1 * rnd()) * r, Math.sin(a + 0.12) * rl));
  }
  const g = new ConvexGeometry(pts);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const a = new THREE.Color(cLo), b = new THREE.Color(cMid), c = new THREE.Color(cHi), s = new THREE.Color(cSpark ?? cHi), o = new THREE.Color();
  const L = new THREE.Vector3(-0.4, 0.8, 0.45).normalize(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), v = [0, 1, 2].map(() => new THREE.Vector3());
  for (let f = 0; f < p.count; f += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(p, f + k);
    n.crossVectors(e1.subVectors(v[1], v[0]), e2.subVectors(v[2], v[0])).normalize();
    const yN = ((v[0].y + v[1].y + v[2].y) / 3 + 1.25 * r) / (3 * r);
    const t = Math.min(1, Math.max(0, 0.55 * (n.dot(L) * 0.5 + 0.5) + 0.3 * rnd() + 0.25 * yN - 0.05));
    if (t < 0.45) o.copy(a).lerp(b, t / 0.45); else if (t < 0.85) o.copy(b).lerp(c, (t - 0.45) / 0.4); else o.copy(c).lerp(s, (t - 0.85) / 0.15);
    for (let k = 0; k < 3; k++) col.set([o.r, o.g, o.b], (f + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
