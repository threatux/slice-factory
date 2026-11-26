// v3 Crystal Glass Apple materials + small props. Only used by engineVersion 3 (src/v3/*).
//  - crystal shell: MeshPhysicalMaterial transmission glass (ruby attenuation), same material family on the intact apple
//    (+ laser-glass seam lines) and on the R1-R3 clipped pieces, whose flat cut faces (aCap) switch to the opaque layered core;
//  - core layers (coreStyle "crystal-apple-core", apple-local p): ruby skin r > 0.88, rose-quartz / champagne crystal flesh with
//    radial facets + micro cracks, liquid-gold 5-point star lying in the x = 0 plane (the R1 cut) with obsidian seeds;
//  - shard material for the R4-R5 InstancedMesh gems (no transmission: env-lit faceted crystal + Fresnel glint);
//  - stem (crystal bronze), emerald glass leaf, glowing star core inside the intact apple, faceted emerald easter egg.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mulberry32 } from '../util.js';

const glsl3 = (c) => { const k = new THREE.Color(c); return `vec3(${k.r.toFixed(4)}, ${k.g.toFixed(4)}, ${k.b.toFixed(4)})`; };
const f = (x) => x.toFixed(5);

export const APPLE_LAYERS = {
  // flesh: champagne (core side) -> rose quartz (skin side), saturated so ACES keeps the tint
  skin: ['#8a001f', '#ff1744'], flesh: ['#ffe2c4', '#ff9ab8'], gold: ['#ffb703', '#fff3b0'], goldRim: '#b86e00', seed: '#0b0a12',
  skinR: 0.88, star: { r: 0.3, inner: 0.45, depth: 0.17, y: 0.0 },
};
const L = APPLE_LAYERS;

/** GLSL: apple radius (lobe-free profile table) + layered core evaluation at apple-local p. */
function coreGLSL(A) {
  const st = L.star;
  return `
uniform sampler2D uProfTex; // apple profile radius table s(alpha), ${A.radTab.length} texels (texelFetch: no filtering needed)
float acH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float acN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(acH(i), acH(i + vec3(1, 0, 0)), f.x), mix(acH(i + vec3(0, 1, 0)), acH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(acH(i + vec3(0, 0, 1)), acH(i + vec3(1, 0, 1)), f.x), mix(acH(i + vec3(0, 1, 1)), acH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float acF(vec3 p) { return 0.5 * acN(p) + 0.25 * acN(p * 2.03) + 0.125 * acN(p * 4.07); }
float appleR(vec3 p) {
  float phi = atan(p.z, p.x);
  float lob = 1.0 + (${f(A.cfg.lobes[0])} + ${f(A.cfg.lobes[1])} * max(0.0, -p.y / ${f(A.Hh)})) * cos(5.0 * phi);
  float rho = length(p.xz) / lob, d = length(vec2(rho, p.y));
  float fi = acos(clamp(p.y / max(d, 1e-6), -1.0, 1.0)) / 3.14159265 * ${f(A.radTab.length - 1)};
  int i = int(min(floor(fi), ${f(A.radTab.length - 2)}));
  float s0 = texelFetch(uProfTex, ivec2(i, 0), 0).r, s1 = texelFetch(uProfTex, ivec2(i + 1, 0), 0).r;
  return d / max(mix(s0, s1, fi - float(i)), 1e-3);
}
// iq's exact 5-point star SDF (points up), r = outer radius, rf = inner / outer
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
// star body: 2D star in the (z, y) plane, tapering like a cut gem away from x = 0 (full star on the R1 cut faces)
float starSD(vec3 p) { return sdStar5(vec2(p.z, p.y - ${f(st.y)}), ${f(st.r)}, ${f(st.inner)}) + ${f(st.r * 0.36)} * abs(p.x) / ${f(st.depth)}; }
float seedSD(vec3 p) {
  float d = 1e3;
  for (int k = 0; k < 5; k++) {
    float a = 1.5707963 + 0.6283185 + float(k) * 1.2566371; // between the rays
    vec2 dir = vec2(cos(a), sin(a)), q = vec2(p.z, p.y - ${f(st.y)});
    vec2 lq = vec2(dot(q, dir) - ${f(st.r * 0.34)}, dot(q, vec2(-dir.y, dir.x)));
    lq.x *= lq.x > 0.0 ? 0.9 : 1.25; // teardrop: pointed toward the centre
    float e = length(vec3(lq.x / ${f(st.r * 0.15)}, lq.y / ${f(st.r * 0.075)}, p.x / ${f(st.depth * 0.45)})) - 1.0;
    d = min(d, e);
  }
  return d;
}
void appleLayer(vec3 p, float glow, out vec3 alb, out vec3 emi, out float rough) {
  float r = appleR(p);
  float n = acF(p * 9.0);
  // flesh: champagne -> rose quartz, radial crystal facets (direction cells) + thin bright micro cracks
  vec3 dir = normalize(p + vec3(1e-5));
  float facet = acH(floor(dir * 7.0 + 0.5) + 3.1);
  float crk = smoothstep(0.955, 0.995, 1.0 - abs(2.0 * acF(p * 6.5 + vec3(n * 1.3)) - 1.0));
  vec3 fl = mix(${glsl3(L.flesh[0])}, ${glsl3(L.flesh[1])}, smoothstep(0.3, 0.8, r) * (0.75 + 0.25 * n));
  vec3 fAlb = fl * (0.3 + 0.16 * facet) * (1.0 - 0.15 * crk);
  vec3 fEmi = fl * (0.03 + 0.09 * (1.0 - r) + 0.04 * facet) + vec3(1.0, 0.93, 0.86) * crk * 0.2;
  // skin band: ruby glass, brighter toward the inner edge, thin warm cambium line at the boundary
  float ts = smoothstep(${f(L.skinR)}, 1.0, r);
  vec3 sAlb = mix(${glsl3(L.skin[1])}, ${glsl3(L.skin[0])}, ts) * (0.8 + 0.25 * n);
  float camb = 1.0 - smoothstep(0.0, 0.012, abs(r - ${f(L.skinR)}));
  float wS = smoothstep(${f(L.skinR - 0.006)}, ${f(L.skinR + 0.006)}, r);
  alb = mix(fAlb, sAlb, wS);
  emi = mix(fEmi, ${glsl3(L.skin[1])} * 0.12, wS) + ${glsl3(L.gold[1])} * camb * 0.6;
  rough = mix(0.16 + 0.1 * n, 0.06, wS);
  // liquid-gold star core (+ dark rim line) and obsidian seeds
  float sd = starSD(p);
  float wG = 1.0 - smoothstep(-0.003, 0.003, sd);
  float rim = (1.0 - smoothstep(0.004, 0.012, abs(sd + 0.006))) * wG;
  float gt = clamp(-sd / ${f(L.star.r * 0.3)}, 0.0, 1.0);
  vec3 gc = mix(${glsl3(L.gold[0])}, ${glsl3(L.gold[1])}, gt * gt * (0.75 + 0.25 * n));
  alb = mix(alb, mix(gc * 0.55, ${glsl3(L.goldRim)} * 0.35, rim), wG);
  emi = mix(emi, gc * (0.55 + 0.75 * gt * gt) * (1.0 - 0.75 * rim), wG);
  rough = mix(rough, 0.22, wG);
  float wSeed = 1.0 - smoothstep(-0.04, 0.04, seedSD(p));
  alb = mix(alb, ${glsl3(L.seed)}, wSeed);
  emi = mix(emi, vec3(0.03, 0.015, 0.05), wSeed);
  rough = mix(rough, 0.05, wSeed);
  emi *= glow;
}`;
}

const profCache = new WeakMap();
/** Profile radius table as a 1-row float texture (shared per apple description). */
function profileTexture(A) {
  if (profCache.has(A)) return profCache.get(A);
  const t = new THREE.DataTexture(new Float32Array(A.radTab), A.radTab.length, 1, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  profCache.set(A, t);
  return t;
}

/** Same layering in JS (micro-piece colours of R4-R5): returns 'skin' | 'flesh' | 'gold' | 'seed'. */
export function appleLayerJS(A, radius, x, y, z) {
  const st = L.star;
  const sd = sdStar5JS(z, y - st.y, st.r, st.inner) + (st.r * 0.36 * Math.abs(x)) / st.depth;
  if (sd < 0) {
    for (let k = 0; k < 5; k++) {
      const a = Math.PI / 2 + Math.PI / 5 + (k * 2 * Math.PI) / 5, dx = Math.cos(a), dy = Math.sin(a);
      const lx = z * dx + (y - st.y) * dy - st.r * 0.34, ly = -z * dy + (y - st.y) * dx;
      if (Math.hypot(lx / (st.r * 0.15), ly / (st.r * 0.075), x / (st.depth * 0.45)) < 1) return 'seed';
    }
    return 'gold';
  }
  return radius > L.skinR ? 'skin' : 'flesh';
}
function sdStar5JS(px, py, r, rf) {
  const k1 = [0.809016994375, -0.587785252292], k2 = [-k1[0], k1[1]];
  let x = Math.abs(px), y = py;
  let d = Math.max(k1[0] * x + k1[1] * y, 0); x -= 2 * d * k1[0]; y -= 2 * d * k1[1];
  d = Math.max(k2[0] * x + k2[1] * y, 0); x -= 2 * d * k2[0]; y -= 2 * d * k2[1];
  x = Math.abs(x); y -= r;
  const ba = [rf * -k1[1] - 0, rf * k1[0] - 1];
  const h = Math.min(r, Math.max(0, (x * ba[0] + y * ba[1]) / (ba[0] * ba[0] + ba[1] * ba[1])));
  return Math.hypot(x - ba[0] * h, y - ba[1] * h) * Math.sign(y * ba[0] - x * ba[1]);
}

/** Crystal glass shell (transmission). o = recipe.object.glass overrides. */
function glassParams(o = {}) {
  return {
    color: o.color ?? '#d0102e', transmission: o.transmission ?? 0.72, ior: o.ior ?? 1.52, thickness: o.thickness ?? 1.4,
    roughness: o.roughness ?? 0.05, metalness: 0, clearcoat: o.clearcoat ?? 1.0, clearcoatRoughness: 0.03, envMapIntensity: o.envMapIntensity ?? 1.8,
    attenuationColor: new THREE.Color(o.attenuationColor ?? '#8a001f'), attenuationDistance: o.attenuationDistance ?? 0.9,
    specularIntensity: 1, specularColor: new THREE.Color('#ffffff'),
  };
}

/** R1-R3 piece material: crystal glass skin, opaque layered core on aCap faces (transmission switched off there). */
export function makeApplePieceMaterial(A, o = {}) {
  const mat = new THREE.MeshPhysicalMaterial(glassParams(o));
  const U = { uProfTex: { value: profileTexture(A) }, uAGlow: { value: o.coreGlow ?? 1 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSph; attribute float aCap; varying vec3 vASph; varying float vACap;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvASph = aSph; vACap = aCap;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uAGlow; varying vec3 vASph; varying float vACap;\n${coreGLSL(A)}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec3 aAlb = vec3(0.0), aEmi = vec3(0.0); float aRough = 0.2;
float aCapW = step(0.5, vACap);
if (aCapW > 0.5) appleLayer(vASph, uAGlow, aAlb, aEmi, aRough);
diffuseColor.rgb = mix(diffuseColor.rgb, aAlb, aCapW);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, aRough, aCapW);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = mix(totalEmissiveRadiance, aEmi, aCapW);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.clearcoat *= 1.0 - 0.75 * aCapW;')
      .replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment.replace('material.transmission = transmission;', 'material.transmission = transmission * (1.0 - aCapW);'));
  };
  mat.customProgramCacheKey = () => 'apple-piece-v3';
  return mat;
}

/** Laser-glass seam GLSL (object-space planes), shared by the v3 shells (apple, watermelon). */
export const SEAM_HEAD_GLSL = `#include <common>
varying vec3 vSP;
uniform vec3 uSN, uSLo, uSHi, uSRev, uSFlash, uSW, uHalf, uSCol, uSCol2, uSDir;
uniform float uSGlow, uSFl, uSAlpha, uSYX;
// reveal front of a stroke: dir +1 sweeps from +half down to -half, dir -1 (backhand) from -half up
float sRv(float v, float hl, float rev, float dir) { float f = dir > 0.0 ? hl - rev * 2.0 * hl : -hl + rev * 2.0 * hl; return smoothstep(-0.006, 0.006, dir * (v - f)); }
float sCov(float w, float d, float fw) { return clamp((0.5 * max(w, fw) - d) / fw + 0.5, 0.0, 1.0) * min(1.0, w / fw); }
vec3 seamAxis(float p, float hl, float n, float lo, float hi, float revC, float w) {
  if (n < 1.5 || hi < 1.5 && lo < 1.5) return vec3(0.0);
  float span = 2.0 * hl / n, kf = (p + hl) / span, k = floor(kf + 0.5), d = abs(kf - k) * span, fw = max(fwidth(p), 1e-5);
  float inR = step(0.5, k) * step(k, n - 0.5), full = step(k, lo - 0.5), cur = step(lo - 0.5, k) * step(k, hi - 0.5) * revC;
  float on = inR * max(full, cur), core = sCov(w, d, fw);
  return vec3(on * sCov(w * 3.0, d, fw), on * core, inR * cur * core);
}`;
export const SEAM_BODY_GLSL = `#include <emissivemap_fragment>
{
  float rxz = sRv(vSP.y, uHalf.y, uSRev.x, uSDir.x);
  float rzz = sRv(vSP.y, uHalf.y, uSRev.z, uSDir.z);
  float ryy = sRv(mix(vSP.z, vSP.x, uSYX), uHalf.z, uSRev.y, uSDir.y);
  vec3 ax = seamAxis(vSP.x, uHalf.x, uSN.x, uSLo.x, uSHi.x, rxz, uSW.x);
  vec3 ay = seamAxis(vSP.y, uHalf.y, uSN.y, uSLo.y, uSHi.y, ryy, uSW.y);
  vec3 az = seamAxis(vSP.z, uHalf.z, uSN.z, uSLo.z, uSHi.z, rzz, uSW.z);
  float halo = max(ax.x, max(ay.x, az.x)) * uSAlpha, core = max(ax.y, max(ay.y, az.y)) * uSAlpha;
  float nw = max(ax.z * uSFlash.x, max(ay.z * uSFlash.y, az.z * uSFlash.z)) * uSAlpha;
  totalEmissiveRadiance += (uSCol2 * halo * 0.25 + uSCol * core) * uSGlow + uSCol2 * nw * uSFl;
}`;

/**
 * Intact apple: crystal glass + laser-glass seam lines (object-space planes like v2, but thin and density-faded so even the
 * 100-cut grid leaves the glass readable; the newest seam flashes gold from the inside).
 */
export function makeAppleShellMaterial(A, o = {}, U) {
  const mat = new THREE.MeshPhysicalMaterial(glassParams(o));
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', SEAM_HEAD_GLSL)
      .replace('#include <emissivemap_fragment>', SEAM_BODY_GLSL);
  };
  mat.customProgramCacheKey = () => 'apple-shell-v3';
  return mat;
}

/** R4-R5 shard gem material: faceted, env-lit crystal (no transmission), instance colour = gem colour, aHeat = glow. */
export function makeShardMaterial(o = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.04, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.02, ior: 1.8, specularIntensity: 1,
    specularColor: new THREE.Color('#ffffff'), envMapIntensity: o.envMapIntensity ?? 2.6, flatShading: true,
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHeat; varying float vGHeat;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGHeat = aHeat;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGHeat;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float fr = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.0);
  totalEmissiveRadiance += vColor.rgb * (vGHeat + ${f(o.fresnel ?? 0.55)} * fr);
}`);
  };
  mat.customProgramCacheKey = () => 'apple-shard-v3';
  return mat;
}

/** Unit-box gem shard (convex hull of jittered corners + face bumps), flat facets. */
export function shardGeometry(seed = 5) {
  const rnd = mulberry32(seed), pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const k = 0.32 + 0.16 * rnd();
    pts.push(new THREE.Vector3(sx * (0.5 - (sx > 0 ? 0 : k * rnd())), sy * (0.5 - k * rnd()), sz * (0.5 - k * rnd() * 0.6)));
  }
  for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
    const p = [(rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4]; p[a] = s * 0.5;
    pts.push(new THREE.Vector3(...p));
  }
  return new ConvexGeometry(pts);
}

/** Faceted emerald brilliant (lathe, 10 facets, flat shaded) with per-facet gradient (easter egg). */
export function emeraldGeometry(r, [cLo, cMid, cHi]) {
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const pts = [[0, -1.05 * r], [0.98 * r, 0.02 * r], [1.0 * r, 0.1 * r], [0.74 * r, 0.42 * r], [0.46 * r, 0.54 * r], [0, 0.54 * r]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 10).toNonIndexed();
  const p = g.attributes.position, col = new Float32Array(p.count * 3), a = new THREE.Color(cLo), b = new THREE.Color(cMid), c = new THREE.Color(cHi), o = new THREE.Color();
  const Ld = new THREE.Vector3(-0.4, 0.8, 0.45).normalize(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let fi = 0; fi < p.count; fi += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(p, fi + k);
    n.crossVectors(e1.subVectors(v[1], v[0]), e2.subVectors(v[2], v[0])).normalize();
    const yN = ((v[0].y + v[1].y + v[2].y) / 3 + 1.05 * r) / (1.59 * r);
    const t = Math.min(1, Math.max(0, 0.5 * (n.dot(Ld) * 0.5 + 0.5) + 0.35 * hash(fi * 0.37 + 2) + 0.3 * yN * yN - 0.05));
    if (t < 0.5) o.copy(a).lerp(b, t / 0.5); else o.copy(b).lerp(c, Math.pow((t - 0.5) / 0.5, 2));
    for (let k = 0; k < 3; k++) col.set([o.r, o.g, o.b], (fi + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Stem + leaf (apple-local coordinates). The stem base sits inside the (+x, +y, +z) cell of every R1-R3 grid, so it always
 * leaves with the top piece. Returns { group, base }.
 */
export function makeStemLeaf(A, o = {}) {
  const yf = A.top[1];
  const base = [0.04, yf - 0.03, 0.035];
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(...base), new THREE.Vector3(0.045, yf + 0.07, 0.035), new THREE.Vector3(0.065, yf + 0.17, 0.03), new THREE.Vector3(0.11, yf + 0.25, 0.025),
  ]);
  const TS = 40, RS = 10, r0 = o.stemRadius ?? 0.021;
  const tube = new THREE.TubeGeometry(curve, TS, r0, RS, false);
  const pos = tube.attributes.position, P = new THREE.Vector3(), V = new THREE.Vector3();
  for (let i = 0; i <= TS; i++) {
    curve.getPointAt(i / TS, P);
    const k = 1.15 - 0.45 * (i / TS);
    for (let j = 0; j <= RS; j++) { const id = i * (RS + 1) + j; V.fromBufferAttribute(pos, id).sub(P).multiplyScalar(k).add(P); pos.setXYZ(id, V.x, V.y, V.z); }
  }
  tube.computeVertexNormals();
  const stem = new THREE.Mesh(tube, new THREE.MeshPhysicalMaterial({
    color: o.stemColor ?? '#8c5a2b', metalness: 0.55, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.6,
    emissive: '#3a1c05', emissiveIntensity: 0.25,
  }));
  stem.castShadow = true;
  // leaf: outline shape, bent (droop along its length + V fold along the midrib), emerald glass
  const Ll = o.leafLength ?? 0.44, Lw = o.leafWidth ?? 0.17;
  const sh = new THREE.Shape();
  sh.moveTo(0, 0);
  sh.bezierCurveTo(Ll * 0.25, Lw * 0.62, Ll * 0.7, Lw * 0.55, Ll, 0);
  sh.bezierCurveTo(Ll * 0.7, -Lw * 0.55, Ll * 0.25, -Lw * 0.62, 0, 0);
  const lg = new THREE.ShapeGeometry(sh, 28);
  const lp = lg.attributes.position, col = new Float32Array(lp.count * 3), cA = new THREE.Color('#00e676'), cB = new THREE.Color('#00792f'), cc = new THREE.Color();
  for (let i = 0; i < lp.count; i++) {
    const x = lp.getX(i), y = lp.getY(i);
    lp.setZ(i, -0.3 * (x / Ll) ** 2 * Ll + 0.32 * Math.abs(y));
    cc.copy(cA).lerp(cB, Math.min(1, Math.abs(y) / (Lw * 0.5)) * 0.8 + 0.2 * (x / Ll));
    col.set([cc.r, cc.g, cc.b], i * 3);
  }
  lg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  lg.computeVertexNormals();
  const leaf = new THREE.Mesh(lg, new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, transmission: 0.55, roughness: 0.1, ior: 1.5, thickness: 0.06, attenuationColor: new THREE.Color('#007a35'),
    attenuationDistance: 0.3, clearcoat: 1, clearcoatRoughness: 0.04, side: THREE.DoubleSide, envMapIntensity: 1.6, emissive: '#00401c', emissiveIntensity: 0.5,
  }));
  leaf.castShadow = true;
  const tip = curve.getPointAt(0.62);
  leaf.position.copy(tip);
  leaf.rotation.set(0.35, o.leafYaw ?? 2.45, 0.42, 'YXZ'); // leaf swings toward the back-left, tip drooping: clear of the HUD badge
  const group = new THREE.Group();
  group.add(stem, leaf);
  return { group, base, stem, leaf };
}

/** Glowing gold star core + obsidian seeds inside the intact apple (seen through the transmission glass). */
export function makeInnerCore(o = {}) {
  const st = L.star, g = new THREE.Group();
  const shape = new THREE.Shape();
  for (let k = 0; k < 10; k++) {
    const a = Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? st.r * st.inner * 0.95 : st.r * 0.97;
    const x = Math.cos(a) * r, y = Math.sin(a) * r + st.y;
    if (k) shape.lineTo(x, y); else shape.moveTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.01, bevelEnabled: true, bevelThickness: st.depth * 0.8, bevelSize: st.r * 0.12, bevelOffset: -st.r * 0.12, bevelSegments: 1 });
  geo.translate(0, 0, -0.005);
  geo.rotateY(Math.PI / 2); // star in the (z, y) plane, extruded along x
  const star = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: L.gold[0], metalness: 0.6, roughness: 0.25, emissive: L.gold[0], emissiveIntensity: o.innerGlow ?? 1.6, flatShading: true,
  }));
  g.add(star);
  const seedMat = new THREE.MeshPhysicalMaterial({ color: L.seed, roughness: 0.06, clearcoat: 1, metalness: 0.2 });
  for (let k = 0; k < 5; k++) {
    const a = Math.PI / 2 + Math.PI / 5 + (k * 2 * Math.PI) / 5;
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), seedMat);
    s.scale.set(st.depth * 0.42, st.r * 0.15, st.r * 0.075);
    s.position.set(0, st.y + Math.sin(a) * st.r * 0.34, Math.cos(a) * st.r * 0.34);
    s.rotation.x = -(a - Math.PI / 2);
    g.add(s);
  }
  return g;
}
