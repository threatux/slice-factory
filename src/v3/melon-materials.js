// v3.1 Crystal Glass Watermelon materials (shape "watermelon-wedge" only; the apple materials are untouched).
//  - one layered MeshPhysicalMaterial for the intact wedge (+ laser-glass seams) and the R1-R3 clipped pieces. Layers are a
//    function of the wedge-local position (aSph): emerald striped rind -> milky crystal pith -> translucent ruby-pink flesh glass.
//    Original surfaces stay glass (transmission per layer); flat cut faces (aCap) switch to the opaque juicy core with obsidian
//    seeds and 3 glowing 24K gold seeds (exact same teardrop SDFs as watermelon.js);
//  - inner seed meshes inside the intact wedge (read through the glass on frame 0; the gold ones stay hidden);
//  - gold seed nugget (R5 hero shard) and the shard palette for the R4-R5 InstancedMesh.
import * as THREE from 'three';
import { SEAM_HEAD_GLSL, SEAM_BODY_GLSL } from './materials.js';

export const MELON = {
  rind: ['#0b6e2e', '#29b853'], rindDeep: '#7fd98a', pith: '#f2f7ec', flesh: ['#ff1f4b', '#ff4d6d'],
  seed: '#08080b', gold: ['#f5b800', '#ffd000'], goldDeep: '#b87800',
};

const g3 = (c) => { const k = new THREE.Color(c); return `vec3(${k.r.toFixed(4)}, ${k.g.toFixed(4)}, ${k.b.toFixed(4)})`; };
const f = (x) => Number(x).toFixed(5);

function seedUniforms(A) {
  return {
    uSeedP: { value: A.seeds.map((S) => new THREE.Vector4(S.p[0], S.p[1], S.p[2], S.gold ? 1 : 0)) },
    uSeedS: { value: A.seeds.map((S) => new THREE.Vector4(S.L, S.Wd, S.Th, 0)) },
    uSeedD: { value: A.seeds.map((S) => new THREE.Vector2(S.dir[0], S.dir[1])) },
  };
}

/** GLSL: wedge layers at wedge-local p. cap = 1 on flat cut faces (opaque juicy core), 0 on the glass skin. */
function melonGLSL(A, o) {
  const N = A.seeds.length;
  return `
uniform vec4 uSeedP[${N}]; uniform vec4 uSeedS[${N}]; uniform vec2 uSeedD[${N}];
uniform float uMGlow; uniform float uGoldK; varying vec3 vMN;
float mH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float mN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(mH(i), mH(i + vec3(1, 0, 0)), f.x), mix(mH(i + vec3(0, 1, 0)), mH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(mH(i + vec3(0, 0, 1)), mH(i + vec3(1, 0, 1)), f.x), mix(mH(i + vec3(0, 1, 1)), mH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float mF(vec3 p) { return 0.5 * mN(p) + 0.25 * mN(p * 2.03) + 0.125 * mN(p * 4.07); }
float seedField(vec3 p, vec3 nrm, out float gold) {
  float d = 1e3; gold = 0.0;
  for (int k = 0; k < ${N}; k++) {
    // one gold seed per round (uGoldK), painted only on the cut face of the piece that holds the seed centre
    if (uSeedP[k].w > 0.5 && (abs(float(k) - uGoldK) > 0.5 || dot(nrm, uSeedP[k].xyz - p) > 0.0)) continue;
    vec3 q = p - uSeedP[k].xyz; vec2 dr = uSeedD[k];
    float u = dot(q.xy, dr), v = dot(q.xy, vec2(-dr.y, dr.x));
    u *= u > 0.0 ? 1.25 : 0.9;
    float e = length(vec3(u / uSeedS[k].x, v / uSeedS[k].y, q.z / uSeedS[k].z)) - 1.0;
    if (e < d) { d = e; gold = uSeedP[k].w; }
  }
  return d;
}
void melonLayer(vec3 p, float cap, out vec3 alb, out vec3 emi, out float rough, out float trans, out float metal, out float coat) {
  float rho = length(vec2(p.x, p.y - ${f(A.apexY)}));
  float th = atan(p.x, ${f(A.apexY)} - p.y);
  float n = mF(p * 9.0);
  // ---- flesh: deep ruby heart (apex = melon centre) -> brighter watermelon pink toward the pith, crystal micro-facets
  float tF = clamp(rho / ${f(A.pithIn)}, 0.0, 1.0);
  vec3 fl = mix(${g3(MELON.flesh[0])}, ${g3(MELON.flesh[1])}, smoothstep(0.25, 1.0, tF));
  // juicy crystal pulp: fine sparkling grains (no blocky facets, no white cracks), slightly brighter juice streaks
  float pulp = mN(p * 46.0), streak = mF(vec3(th * 14.0, rho * 6.0, p.z * 3.0));
  float spark = smoothstep(0.82, 0.97, mN(p * 95.0 + 3.1));
  vec3 fAlbGlass = fl;
  vec3 fAlbCap = fl * (0.8 + 0.12 * pulp + 0.1 * streak);
  vec3 fEmiCap = fl * (${f(o.capGlow ?? 0.2)} + 0.06 * streak) + vec3(1.0, 0.75, 0.8) * spark * 0.1;
  // ---- rind: jagged dark / light stripes running across the band, lighter green deeper in the rind, thin pith line
  float depth = clamp((${f(A.Rw)} - rho) / ${f(A.cfg.rind)}, 0.0, 1.0);
  float sc = th * ${f(o.stripes ?? 10.0)} + 0.35 * sin(p.z * 16.0 + th * 5.0) + 0.6 * (mF(vec3(th * 6.0, p.z * 9.0, 1.7)) - 0.5);
  float stripe = smoothstep(0.38, 0.5, abs(fract(sc) - 0.5) * 2.0);
  vec3 rS = mix(${g3(MELON.rind[0])}, ${g3(MELON.rind[1])}, stripe) * (0.85 + 0.3 * n);
  vec3 rAlb = mix(rS, ${g3(MELON.rindDeep)}, smoothstep(0.45, 1.0, depth) * (0.5 + 0.5 * cap));
  // ---- pith: milky crystal
  vec3 pAlb = ${g3(MELON.pith)} * (0.92 + 0.08 * n);
  float wR = smoothstep(${f(A.rindIn - 0.004)}, ${f(A.rindIn + 0.004)}, rho);
  float wP = smoothstep(${f(A.pithIn - 0.004)}, ${f(A.pithIn + 0.004)}, rho) * (1.0 - wR);
  float wFl = 1.0 - wR - wP;
  alb = fAlbGlass * wFl + pAlb * wP + rAlb * wR;
  emi = (fl * ${f(o.skinGlow ?? 0.05)}) * wFl + vec3(0.06, 0.07, 0.06) * wP + ${g3(MELON.rind[1])} * 0.03 * wR;
  rough = 0.04 * wFl + 0.3 * wP + 0.08 * wR;
  trans = 1.0 * wFl + ${f(o.pithTrans ?? 0.18)} * wP + ${f(o.rindTrans ?? 0.12)} * wR;
  metal = 0.0; coat = 1.0;
  if (cap > 0.5) {
    alb = fAlbCap * wFl + pAlb * 0.85 * wP + rAlb * wR;
    emi = fEmiCap * wFl + vec3(0.1, 0.11, 0.1) * wP + ${g3(MELON.rind[1])} * 0.05 * wR;
    rough = (0.12 + 0.12 * n) * wFl + 0.32 * wP + 0.1 * wR;
    trans = 0.0; coat = 0.35;
    // obsidian + gold seeds on the cut
    float gold; float sd = seedField(p, normalize(vMN), gold);
    float wS = 1.0 - smoothstep(-0.05, 0.05, sd);
    float rim = 1.0 - smoothstep(0.0, 0.25, abs(sd + 0.12));
    vec3 gc = mix(${g3(MELON.gold[0])}, ${g3(MELON.gold[1])}, clamp(-sd * 1.2, 0.0, 1.0) * (0.6 + 0.4 * n));
    vec3 sAlb = mix(${g3(MELON.seed)}, mix(gc, ${g3(MELON.goldDeep)}, rim * 0.5), gold);
    vec3 sEmi = mix(vec3(0.004, 0.004, 0.006), gc * ${f(o.goldGlow ?? 0.5)} * (0.8 + 0.3 * clamp(-sd * 2.0, 0.0, 1.0)), gold);
    alb = mix(alb, sAlb, wS);
    emi = mix(emi, sEmi, wS);
    rough = mix(rough, mix(0.05, 0.16, gold), wS);
    metal = wS * gold * 1.0;
    coat = mix(coat, 1.0 - gold, wS);
  }
  emi *= uMGlow;
}`;
}

function glassParams(o = {}) {
  return {
    color: '#ffffff', transmission: o.transmission ?? 0.82, ior: o.ior ?? 1.45, thickness: o.thickness ?? 0.35,
    roughness: 0.05, metalness: 0, clearcoat: o.clearcoat ?? 1.0, clearcoatRoughness: 0.03, envMapIntensity: o.envMapIntensity ?? 1.4,
    attenuationColor: new THREE.Color(o.attenuationColor ?? '#ff3a5c'), attenuationDistance: o.attenuationDistance ?? 0.7,
    specularIntensity: 1, specularColor: new THREE.Color('#ffffff'),
  };
}

/**
 * Layered watermelon glass. seamU: laser-glass seam uniforms (intact wedge) or null (pieces). Geometry from
 * applePieceGeometry(): aSph = wedge-local position, aCap = 1 on flat cut faces.
 */
export function makeMelonMaterial(A, o = {}, seamU = null) {
  const mat = new THREE.MeshPhysicalMaterial(glassParams(o));
  const U = { ...seedUniforms(A), uMGlow: { value: o.glow ?? 1 }, uGoldK: { value: 0 } };
  mat.userData.setRound = (k) => { U.uGoldK.value = k; };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, seamU ?? {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSph; attribute float aCap; varying vec3 vMSph; varying float vMCap; varying vec3 vMN;' + (seamU ? '\nvarying vec3 vSP;' : ''))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMSph = aSph; vMCap = aCap; vMN = normal;' + (seamU ? '\nvSP = position;' : ''));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', (seamU ? SEAM_HEAD_GLSL : '#include <common>') + `\nvarying vec3 vMSph; varying float vMCap;\n${melonGLSL(A, o)}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec3 mAlb, mEmi; float mRough, mTrans, mMetal, mCoat;
melonLayer(vMSph, step(0.5, vMCap), mAlb, mEmi, mRough, mTrans, mMetal, mCoat);
diffuseColor.rgb = mAlb;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mMetal;')
      .replace('#include <emissivemap_fragment>', (seamU ? SEAM_BODY_GLSL : '#include <emissivemap_fragment>') + '\ntotalEmissiveRadiance += mEmi;')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.clearcoat *= mCoat;')
      .replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment.replace('material.transmission = transmission;', 'material.transmission = transmission * mTrans;'));
  };
  mat.customProgramCacheKey = () => (seamU ? 'melon-shell-v31' : 'melon-piece-v31');
  return mat;
}

/** Teardrop seed geometry matching the SDF of watermelon.js (unit sizes; +x = toward the apex). */
export function seedGeometry(seg = 24) {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.65));
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i); p.setX(i, x / (x > 0 ? 1.25 : 0.9)); }
  g.computeVertexNormals();
  return g;
}

/** Seeds inside the intact wedge (seen through the glass). Gold seeds stay hidden unless o.goldInside. */
export function makeMelonSeeds(A, o = {}) {
  const grp = new THREE.Group(), geo = seedGeometry();
  const black = new THREE.MeshPhysicalMaterial({ color: MELON.seed, roughness: 0.06, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.5 });
  const gold = new THREE.MeshPhysicalMaterial({ color: MELON.gold[0], metalness: 0.9, roughness: 0.2, emissive: MELON.gold[0], emissiveIntensity: 0.8 });
  for (const S of A.seeds) {
    if (S.gold && !o.goldInside) continue;
    const m = new THREE.Mesh(geo, S.gold ? gold : black);
    m.scale.set(S.L * 0.96, S.Wd * 0.96, S.Th * 0.96);
    m.position.set(...S.p);
    m.rotation.z = Math.atan2(S.dir[1], S.dir[0]);
    grp.add(m);
  }
  return grp;
}

/** R5 hero: polished 24K gold seed nugget (lies in the front of the final pile). */
export function makeGoldNugget(ep) {
  const geo = seedGeometry(32);
  geo.scale(ep.size, ep.size * 0.5, ep.size * 0.4); // slender watermelon-seed teardrop
  geo.rotateX(Math.PI / 2); // lies flat: thickness along y
  return new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
    color: ep.color ?? MELON.gold[0], metalness: 1.0, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 2.4,
    emissive: ep.emissive ?? '#ffb300', emissiveIntensity: ep.emissiveIntensity ?? 0.9,
  }));
}
