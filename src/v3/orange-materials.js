// v3.2 Crystal Glass Orange materials (shape "crystal-orange" only; the apple / watermelon materials are untouched).
//  - surfaceStyle "crystal-orange": one MeshPhysicalMaterial for the intact orange (+ laser-glass seams) and the R1-R3 clipped
//    pieces. The skin is translucent tangerine glass (#ff5a00 -> #ff9500) with a procedural citrus-zest micro relief: Worley
//    oil-gland pores perturb the BASE normal (bump) and the roughness, while the clearcoat keeps the smooth geometric normal,
//    so the pores read as glass under a glossy lacquer;
//  - coreStyle "crystal-orange-core" (flat cut faces, aCap = 1, orange-local p): peel r > 0.87 (#ff5a00), white albedo ring
//    0.80 < r <= 0.87 (#fff6e8), 10 radial pulp segments (#ff7b00 -> #ffb703, juice-vesicle grains + sparkle) split by milky
//    membranes that meet at a white core rA <= 0.13. The star is evaluated around the cut-face normal (atan2 in the cut plane),
//    each axis weighted by n^2 so a tilted face blends smoothly; one electric-cyan crystal per round (uCrysK) is inlaid on the
//    cut face of the single piece that holds its centre;
//  - stem (dark bronze) + calyx + 2 emerald glass leaves, R5 hero crystal (small faceted #00e5ff prism, no point light).
import * as THREE from 'three';
import { SEAM_HEAD_GLSL, SEAM_BODY_GLSL } from './materials.js';
import { ORANGE_LAYERS } from './orange.js';

export const ORANGE = {
  peel: ['#ff5a00', '#ff9500'], albedo: '#fff6e8', pulp: ['#ff7b00', '#ffb703'], membrane: '#fff6e8',
  leaf: ['#00a843', '#12d660'], stem: '#4a2f17', crystal: ['#006a85', '#00e5ff', '#c9fbff'],
};

const g3 = (c) => { const k = new THREE.Color(c); return `vec3(${k.r.toFixed(4)}, ${k.g.toFixed(4)}, ${k.b.toFixed(4)})`; };
const f = (x) => Number(x).toFixed(5);

const profCache = new WeakMap();
/** Profile radius table s(alpha) of the (lobe-free) orange as a 1-row float texture. */
function profileTexture(A) {
  if (profCache.has(A)) return profCache.get(A);
  const t = new THREE.DataTexture(new Float32Array(A.radTab), A.radTab.length, 1, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  profCache.set(A, t);
  return t;
}

/** GLSL: orange radius, peel pores, layered core + crystals at orange-local p. */
function orangeGLSL(A, o) {
  const L = ORANGE_LAYERS, N = A.crystals.length, R = A.ocfg.radius;
  return `
uniform sampler2D uOProfTex; uniform vec4 uCrysP[${N}]; uniform vec3 uCrysS[${N}]; uniform float uCrysK; uniform float uOGlow;
centroid varying vec3 vOSph; centroid varying float vOCap; centroid varying vec3 vON; // centroid: MSAA never extrapolates needle caps
float oCrysW = 0.0; // crystal inlay weight of this fragment (specular is cut there)
float oH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float oN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(oH(i), oH(i + vec3(1, 0, 0)), f.x), mix(oH(i + vec3(0, 1, 0)), oH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(oH(i + vec3(0, 0, 1)), oH(i + vec3(1, 0, 1)), f.x), mix(oH(i + vec3(0, 1, 1)), oH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float oF(vec3 p) { return 0.5 * oN(p) + 0.25 * oN(p * 2.03) + 0.125 * oN(p * 4.07); }
// Worley F1: distance to the nearest jittered oil gland (citrus zest pores)
float oPore(vec3 p) {
  vec3 i = floor(p), fr = fract(p); float d = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 c = g + vec3(oH(i + g), oH(i + g + 17.3), oH(i + g + 41.7)) * 0.8 + 0.1;
    d = min(d, length(c - fr));
  }
  return d;
}
float orangeR(vec3 p) {
  float d = length(p);
  float fi = acos(clamp(p.y / max(d, 1e-6), -1.0, 1.0)) / 3.14159265 * ${f(A.radTab.length - 1)};
  int i = int(min(floor(fi), ${f(A.radTab.length - 2)}));
  float s0 = texelFetch(uOProfTex, ivec2(i, 0), 0).r, s1 = texelFetch(uOProfTex, ivec2(i + 1, 0), 0).r;
  return d / max(mix(s0, s1, fi - float(i)), 1e-3);
}
// 10-segment citrus star in a cut plane: q = in-plane coordinates around the axis that pierces the plane
void oStar(vec2 q, out vec3 alb, out vec3 emi, out float rough) {
  float rho = length(q), rA = rho / ${f(R)};
  float th = atan(q.y, q.x) - ${f(L.phase)};
  float seg = th * ${f(L.segments)} / 6.2831853;
  float id = floor(seg), fs = seg - id, dSeg = min(fs, 1.0 - fs);
  float arc = dSeg * 6.2831853 / ${f(L.segments)} * rho;           // distance to the nearest membrane line
  float wM = 0.0055 + 0.006 * rA;                                  // membranes thicken slightly toward the albedo
  float memb = 1.0 - smoothstep(wM, wM + 0.0035, arc);
  float core = 1.0 - smoothstep(${f(L.core - 0.01)}, ${f(L.core + 0.01)}, rA);
  float edge = smoothstep(wM, wM + 0.045, arc);                    // pulp sinks toward the membranes (depth)
  // juice vesicles: Worley cells stretched along the radius (teardrop sacs ~2.5:1), one lattice per segment;
  // sac centres glow amber, the thin sac walls sink to deep tangerine, a few sacs catch a tiny crystal glint
  float tang = (fs - 0.5) * rho * ${f((2 * Math.PI) / L.segments)};
  vec3 vq = vec3(rho * ${f(o.sacRadial ?? 15)}, tang * ${f(o.sacTangent ?? 38)}, id * 3.71);
  float F1 = oPore(vq), sac = smoothstep(0.12, 0.5, F1), ves = oN(vq * 0.5 + 2.3);
  float spark = (1.0 - smoothstep(0.03, 0.09, F1)) * step(0.82, oH(floor(vq) + 5.3));
  vec3 pc = mix(${g3(ORANGE.pulp[0])}, ${g3(ORANGE.pulp[1])}, clamp(0.08 + 0.42 * (1.0 - sac) * (1.0 - 0.45 * rA) + 0.12 * ves, 0.0, 1.0));
  vec3 pAlb = pc * (1.0 - 0.3 * sac) * mix(0.72, 1.0, edge);
  vec3 pEmi = pc * (${f(o.capGlow ?? 0.26)} * (1.0 - 0.45 * sac) * mix(0.6, 1.0, edge)) + vec3(1.0, 0.88, 0.62) * spark * 0.22;
  float vb = 1.0 - sac;
  vec3 wAlb = ${g3(ORANGE.membrane)} * (0.9 + 0.1 * ves);
  float w = max(memb, core);
  alb = mix(pAlb, wAlb, w);
  emi = mix(pEmi, vec3(0.07, 0.065, 0.06), w);
  rough = mix(0.1 + 0.12 * (1.0 - vb), 0.38, w);
}
// electric-cyan crystal inlaid in the cut face (one per round: uCrysK), elongated octahedron, faceted shading
float oCrystal(vec3 p, vec3 nrm, out vec3 cAlb, out vec3 cEmi) {
  float wsum = 0.0; cAlb = vec3(0.0); cEmi = vec3(0.0);
  for (int k = 0; k < ${N}; k++) {
    if (abs(float(k) - uCrysK) > 0.5 || dot(nrm, uCrysP[k].xyz - p) > 0.0) continue;
    vec3 q = (p - uCrysP[k].xyz) / uCrysS[k];
    float d = abs(q.x) + abs(q.y) + abs(q.z) - 1.0;
    float w = 1.0 - smoothstep(-0.06, 0.0, d);
    if (d > 0.16) continue;
    vec3 fn = normalize(sign(q + 1e-5) / uCrysS[k]);
    float sh = clamp(0.5 + 0.5 * dot(fn, normalize(vec3(-0.35, 0.8, 0.5))) + 0.18 * (oH(sign(q + 1e-5) + 3.1) - 0.5), 0.0, 1.0);
    float ridge = 1.0 - smoothstep(0.0, 0.07, min(abs(q.x), min(abs(q.y), abs(q.z))));
    float rim = 1.0 - smoothstep(0.0, 0.1, -d);
    vec3 c = mix(${g3(ORANGE.crystal[0])}, ${g3(ORANGE.crystal[1])}, sh);
    c = mix(c, ${g3(ORANGE.crystal[2])}, 0.28 * max(ridge, rim) * (0.4 + 0.6 * sh));
    cAlb = c * 0.2;
    cEmi = ${g3(ORANGE.crystal[1])} * ${f(o.crystalGlow ?? 0.32)} * (0.55 + 0.45 * sh) + ${g3(ORANGE.crystal[1])} * 0.18 * max(ridge, rim);
    // ACES (AP1 crosstalk + RRT) bleeds red into saturated cyan: a small negative red term keeps it electric #00e5ff on screen
    cEmi += vec3(-${f(o.crystalRedCut ?? 0.3)}, 0.0, 0.02) * (0.6 + 0.4 * sh);
    // dark inlay groove right outside the crystal outline: the cyan reads against the bright pulp without any glow spill
    float groove = (1.0 - smoothstep(0.0, 0.16, d)) * step(0.0, d);
    cAlb = mix(cAlb, vec3(0.03, 0.05, 0.06), groove); cEmi *= 1.0 - groove;
    wsum = max(w, groove * 0.85);
  }
  return wsum;
}
void orangeLayer(vec3 p, float cap, vec3 nrm, out vec3 alb, out vec3 emi, out float rough, out float trans, out float coat) {
  float r = orangeR(p);
  float n = oF(p * 9.0);
  // ---- skin: tangerine glass, warmer toward the poles, pores = slightly deeper orange
  float pore = smoothstep(0.08, 0.36, oPore(p * ${f(o.poreFreq ?? 46)}));
  vec3 skin = mix(${g3(ORANGE.peel[1])}, ${g3(ORANGE.peel[0])}, clamp(0.35 + 0.5 * n + 0.25 * abs(p.y) / ${f(A.Hh)}, 0.0, 1.0));
  alb = skin * (0.86 + 0.14 * pore);
  emi = skin * ${f(o.skinGlow ?? 0.1)};
  rough = ${f(o.roughness ?? 0.08)} + 0.1 * (1.0 - pore);
  trans = 1.0; coat = 1.0;
  if (cap > 0.5) {
    trans = 0.0; coat = ${f(o.capCoat ?? 0.55)};
    vec3 a2 = nrm * nrm; vec3 sAlb = vec3(0.0), sEmi = vec3(0.0); float sR = 0.0, ws = 0.0;
    vec3 ta; vec3 te; float tr;
    if (a2.x > 0.02) { oStar(p.zy, ta, te, tr); sAlb += ta * a2.x; sEmi += te * a2.x; sR += tr * a2.x; ws += a2.x; }
    if (a2.y > 0.02) { oStar(p.xz, ta, te, tr); sAlb += ta * a2.y; sEmi += te * a2.y; sR += tr * a2.y; ws += a2.y; }
    if (a2.z > 0.02) { oStar(p.xy, ta, te, tr); sAlb += ta * a2.z; sEmi += te * a2.z; sR += tr * a2.z; ws += a2.z; }
    sAlb /= ws; sEmi /= ws; sR /= ws;
    // white albedo ring + saturated peel band with oil glands
    float wP = smoothstep(${f(L.peel - 0.006)}, ${f(L.peel + 0.006)}, r);
    float wA = smoothstep(${f(L.albedo - 0.006)}, ${f(L.albedo + 0.006)}, r) * (1.0 - wP);
    float gl = smoothstep(0.55, 0.85, oN(p * 70.0));
    vec3 aAlb = ${g3(ORANGE.albedo)} * (0.88 + 0.12 * n);
    vec3 pAlb = ${g3(ORANGE.peel[0])} * (0.85 + 0.2 * gl);
    alb = sAlb * (1.0 - wP - wA) + aAlb * wA + pAlb * wP;
    emi = sEmi * (1.0 - wP - wA) + vec3(0.08, 0.075, 0.07) * wA + ${g3(ORANGE.peel[0])} * ${f(o.peelGlow ?? 0.14)} * wP;
    rough = sR * (1.0 - wP - wA) + 0.45 * wA + 0.16 * wP;
    vec3 cAlb, cEmi; float wC = oCrystal(p, nrm, cAlb, cEmi);
    oCrysW = wC;
    if (wC > 0.0) { alb = mix(alb, cAlb, wC); emi = mix(emi, cEmi, wC); rough = mix(rough, 0.22, wC); coat = mix(coat, 0.15, wC); } // matte-ish facets: env sheen would wash the cyan out
  }
  emi *= uOGlow;
}`;
}

function glassParams(o = {}) {
  return {
    color: '#ffffff', transmission: o.transmission ?? 0.5, ior: o.ior ?? 1.5, thickness: o.thickness ?? 0.8,
    roughness: o.roughness ?? 0.08, metalness: 0, clearcoat: o.clearcoat ?? 1.0, clearcoatRoughness: 0.03, envMapIntensity: o.envMapIntensity ?? 1.3,
    attenuationColor: new THREE.Color(o.attenuationColor ?? '#ff6a00'), attenuationDistance: o.attenuationDistance ?? 0.6,
    specularIntensity: 1, specularColor: new THREE.Color('#ffffff'),
  };
}

/**
 * Crystal orange glass. seamU: laser-glass seam uniforms (intact orange) or null (pieces). Geometry from applePieceGeometry():
 * aSph = orange-local position, aCap = 1 on flat cut faces, normal = smooth skin normal / cut-plane normal.
 */
export function makeOrangeMaterial(A, o = {}, seamU = null) {
  const mat = new THREE.MeshPhysicalMaterial(glassParams(o));
  const U = {
    uOProfTex: { value: profileTexture(A) }, uOGlow: { value: o.glow ?? 1 }, uCrysK: { value: -1 },
    uCrysP: { value: A.crystals.map((C) => new THREE.Vector4(...C.p, 1)) }, uCrysS: { value: A.crystals.map((C) => new THREE.Vector3(...C.s)) },
  };
  mat.userData.setRound = (k) => { U.uCrysK.value = k; };
  const bump = o.poreBump ?? 0.0009;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, seamU ?? {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSph; attribute float aCap; centroid varying vec3 vOSph; centroid varying float vOCap; centroid varying vec3 vON;' + (seamU ? '\nvarying vec3 vSP;' : ''))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOSph = aSph; vOCap = aCap; vON = normal;' + (seamU ? '\nvSP = position;' : ''));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', (seamU ? SEAM_HEAD_GLSL : '#include <common>') + `\n${orangeGLSL(A, o)}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec3 oAlb, oEmi; float oRough, oTrans, oCoat;
float oCapW = step(0.5, vOCap);
orangeLayer(vOSph, oCapW, normalize(vON), oAlb, oEmi, oRough, oTrans, oCoat);
diffuseColor.rgb = oAlb;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = oRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (oCapW < 0.5) { // citrus zest relief on the glass skin only (base normal; the clearcoat keeps nonPerturbedNormal)
  float oh = ${f(bump)} * smoothstep(0.08, 0.36, oPore(vOSph * ${f(o.poreFreq ?? 46)})) + ${f(bump * 0.35)} * oN(vOSph * 140.0);
  vec3 sX = dFdx(-vViewPosition), sY = dFdy(-vViewPosition);
  vec3 r1 = cross(sY, normal), r2 = cross(normal, sX);
  float det = dot(sX, r1) * faceDirection;
  vec3 grad = sign(det) * (dFdx(oh) * r1 + dFdy(oh) * r2);
  normal = normalize(abs(det) * normal - grad);
}`)
      .replace('#include <emissivemap_fragment>', (seamU ? SEAM_BODY_GLSL : '#include <emissivemap_fragment>') + '\ntotalEmissiveRadiance += oEmi;')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.clearcoat *= oCoat;\nmaterial.specularColor *= 1.0 - 0.85 * oCrysW; material.specularF90 *= 1.0 - 0.85 * oCrysW;')
      .replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment.replace('material.transmission = transmission;', 'material.transmission = transmission * oTrans;'));
  };
  mat.customProgramCacheKey = () => (seamU ? 'orange-shell-v32' : 'orange-piece-v32');
  return mat;
}

/** Citrus leaf: pointed oval outline, droop along its length + V fold along the midrib, emerald glass with a lighter midrib. */
function leafGeometry(Ll, Lw) {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0);
  sh.bezierCurveTo(Ll * 0.2, Lw * 0.6, Ll * 0.72, Lw * 0.58, Ll, 0);
  sh.bezierCurveTo(Ll * 0.72, -Lw * 0.58, Ll * 0.2, -Lw * 0.6, 0, 0);
  const g = new THREE.ShapeGeometry(sh, 32);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const cA = new THREE.Color(ORANGE.leaf[1]), cB = new THREE.Color(ORANGE.leaf[0]), cM = new THREE.Color('#8dffb8'), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setZ(i, -0.26 * (x / Ll) ** 2 * Ll + 0.3 * Math.abs(y));
    c.copy(cA).lerp(cB, Math.min(1, Math.abs(y) / (Lw * 0.45)) * 0.75 + 0.25 * (x / Ll));
    c.lerp(cM, 0.35 * Math.max(0, 1 - Math.abs(y) / (Lw * 0.06)));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Short dark-bronze stem + calyx + 2 emerald glass leaves (orange-local). The stem base lies inside the (+x, +y, +z) cell of
 * every R1-R3 grid, so stem and leaves always leave with that top piece. Returns { group, base }.
 */
export function makeOrangeStem(A, o = {}) {
  const yf = A.top[1];
  const base = [0.03, yf - 0.025, 0.028];
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(...base), new THREE.Vector3(0.032, yf + 0.03, 0.028), new THREE.Vector3(0.04, yf + 0.075, 0.026), new THREE.Vector3(0.055, yf + 0.11, 0.024),
  ]);
  const TS = 24, RS = 10, r0 = o.stemRadius ?? 0.019;
  const tube = new THREE.TubeGeometry(curve, TS, r0, RS, false);
  const pos = tube.attributes.position, P = new THREE.Vector3(), V = new THREE.Vector3();
  for (let i = 0; i <= TS; i++) {
    curve.getPointAt(i / TS, P);
    const k = 1.1 - 0.3 * (i / TS);
    for (let j = 0; j <= RS; j++) { const id = i * (RS + 1) + j; V.fromBufferAttribute(pos, id).sub(P).multiplyScalar(k).add(P); pos.setXYZ(id, V.x, V.y, V.z); }
  }
  tube.computeVertexNormals();
  const bronze = new THREE.MeshPhysicalMaterial({
    color: o.stemColor ?? ORANGE.stem, metalness: 0.55, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.4,
    emissive: '#1c0f04', emissiveIntensity: 0.2,
  });
  const stem = new THREE.Mesh(tube, bronze);
  stem.castShadow = true;
  // calyx: small 5-point star button where the stem meets the peel
  const cs = new THREE.Shape();
  for (let k = 0; k < 10; k++) {
    const a = (k * Math.PI) / 5, r = k % 2 ? 0.024 : 0.05;
    if (k) cs.lineTo(r * Math.cos(a), r * Math.sin(a)); else cs.moveTo(r, 0);
  }
  cs.closePath();
  const cg = new THREE.ExtrudeGeometry(cs, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2 });
  cg.rotateX(-Math.PI / 2);
  const calyx = new THREE.Mesh(cg, new THREE.MeshPhysicalMaterial({ color: '#2f5a12', metalness: 0.2, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.2 }));
  calyx.position.set(base[0], yf - 0.012, base[2]);
  calyx.castShadow = true;
  const leafMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, transmission: o.leafTransmission ?? 0.35, roughness: 0.07, ior: 1.5, thickness: 0.05,
    attenuationColor: new THREE.Color('#00a843'), attenuationDistance: 0.3, clearcoat: 1, clearcoatRoughness: 0.03,
    side: THREE.DoubleSide, envMapIntensity: 1.7, emissive: '#00501f', emissiveIntensity: 0.35,
  });
  const group = new THREE.Group();
  group.add(stem, calyx);
  const tip = curve.getPointAt(0.7);
  const leaves = (o.leaves ?? [{ length: 0.42, width: 0.18, yaw: 2.5, pitch: 0.3, roll: 0.38 }, { length: 0.34, width: 0.15, yaw: 0.35, pitch: 0.42, roll: -0.3 }]);
  for (const lf of leaves) {
    const leaf = new THREE.Mesh(leafGeometry(lf.length, lf.width), leafMat);
    leaf.castShadow = true;
    leaf.position.copy(tip);
    leaf.rotation.set(lf.pitch, lf.yaw, lf.roll, 'YXZ');
    group.add(leaf);
  }
  return { group, base };
}

/** R5 hero: small faceted electric-cyan ice crystal (hexagonal bipyramid prism lying flat), realistic shard scale. */
export function makeBlueCrystal(ep) {
  const r = ep.size, Lh = r * (ep.length ?? 1.7);
  const pts = [[0, -Lh], [r, -Lh * 0.45], [r, Lh * 0.45], [0, Lh]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 6).toNonIndexed();
  g.rotateZ(Math.PI / 2); // lies along x
  g.rotateX(Math.PI / 6); // a flat facet faces down
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const a = new THREE.Color(ORANGE.crystal[0]), b = new THREE.Color(ORANGE.crystal[1]), c = new THREE.Color(ORANGE.crystal[2]), o = new THREE.Color();
  const Ld = new THREE.Vector3(-0.35, 0.85, 0.45).normalize(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let fi = 0; fi < p.count; fi += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(p, fi + k);
    n.crossVectors(e1.subVectors(v[1], v[0]), e2.subVectors(v[2], v[0])).normalize();
    const t = Math.min(1, Math.max(0, 0.55 * (n.dot(Ld) * 0.5 + 0.5) + 0.3 * hash(fi * 0.37 + 5) + 0.1));
    if (t < 0.6) o.copy(a).lerp(b, t / 0.6); else o.copy(b).lerp(c, ((t - 0.6) / 0.4) ** 2 * 0.8);
    for (let k = 0; k < 3; k++) col.set([o.r, o.g, o.b], (fi + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const emissive = new THREE.Color(ep.emissive ?? ORANGE.crystal[1]);
  emissive.r -= ep.redCut ?? 0.6; // ACES pre-compensation (see oCrystal): keeps the small hero crystal electric cyan, not baby blue
  return new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.06, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.03, ior: 2.0, specularIntensity: 0.6,
    emissive, emissiveIntensity: ep.emissiveIntensity ?? 0.35, envMapIntensity: 1.4, flatShading: true,
  }));
}
