// Slab fracture planning for "slice" rounds + the chipped-shard render geometry/material.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mulberry32 } from './util.js';

/**
 * Each cut-off slab breaks into a cols x rows grid of pieces whose total volume equals the slab.
 * Explicit recipe grid (R1: 6 columns aligned with the phase-A kerfs x 2 tiers) or a grid derived from the instance budget,
 * so every slab of the round leaves a full curtain of pieces (capacity = instance budget of the round).
 */
export function planSlabs(R, [W, H], capacity, nSlabs, rnd) {
  let cols, rows, aligned = false;
  if (R.cols && R.tiers) { cols = R.cols; rows = R.tiers; aligned = true; } else {
    const budget = Math.max(2, Math.floor((capacity * 0.95) / nSlabs));
    cols = Math.max(2, Math.round(Math.sqrt((budget * W) / H)));
    rows = Math.max(1, Math.floor(budget / cols));
  }
  const gold = R.index === 0
    ? { slab: Math.floor(rnd() * nSlabs), cell: Math.floor(rnd() * cols * rows) } // R1: one random bar is a gold ingot
    : { slab: nSlabs - 1, cell: (rows - 1) * cols + (cols >> 1) }; // later rounds: top of the very last slab
  return { cols, rows, aligned, nSlabs, gold };
}

/**
 * Pieces of slab j (zLo..zHi). Centres sit strictly in front of the blade plane: z = (zLo + zHi)/2 + 0.02, so the back face
 * clears the blade (half thickness 0.015). Fracture lines are slightly irregular (except columns aligned to real kerfs).
 * faces: [+x,+y,+z,-x,-y,-z] = 1 where the piece face is the block's outer skin, 0 = fresh internal fracture (magma).
 */
export function slabCells(plan, j, zLo, zHi, size, rnd, pal) {
  const [W, H, D] = size;
  const { cols, rows, nSlabs } = plan;
  const thick = zHi - zLo, zc = (zHi + zLo) / 2 + 0.02;
  const cw = W / cols, rh = H / rows;
  const xb = [-W / 2];
  for (let a = 1; a < cols; a++) xb.push(-W / 2 + a * cw + (plan.aligned ? 0 : (rnd() - 0.5) * 0.5 * cw));
  xb.push(W / 2);
  const out = [];
  for (let a = 0; a < cols; a++) {
    const yb = [0];
    for (let b = 1; b < rows; b++) yb.push(b * rh + (rnd() - 0.5) * (rows === 2 ? 0.18 : 0.6) * rh);
    yb.push(H);
    for (let b = 0; b < rows; b++) {
      const x0 = xb[a], x1 = xb[a + 1], y0 = yb[b], y1 = yb[b + 1];
      const x = (x0 + x1) / 2, y = (y0 + y1) / 2;
      const gold = j === plan.gold.slab && b * cols + a === plan.gold.cell;
      const nx = x / (W / 2), ny = (y - H / 2) / (H / 2), nz = (zc - 0.02) / (D / 2);
      const core = Math.max(0, 1 - Math.hypot(nx, ny, nz) / 1.5);
      const tint = 0.85 + 0.3 * rnd();
      const hgt = y / H;
      out.push({
        pos: [x, y + 0.004, zc],
        size: [(x1 - x0) * 0.94, (y1 - y0) * 0.94, thick * 0.94],
        color: gold ? new THREE.Color(pal.gold).getHex() : new THREE.Color(tint, tint, tint * 1.04).getHex(),
        gold,
        faces: [a === cols - 1, b === rows - 1, j === 0, a === 0, b === 0, j === nSlabs - 1].map(Number),
        heat: gold ? -1 : 0.55 + 0.45 * core,
        // light push away from the blade plane (+z), the top more than the base: the wall topples forward and spills
        vel: [x * 0.12 + (rnd() - 0.5) * 0.25, 0.15 * rnd(), 0.2 + 0.85 * hgt + 0.2 * rnd()],
        ang: [1.0 + 1.6 * hgt + rnd() * 0.8, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8],
      });
    }
  }
  return out;
}

/** Unit chipped shard: cube with irregular chamfered corners and slightly domed facets (convex hull, flat shading). */
export function makeShardGeometry(seed = 4) {
  const rnd = mulberry32(seed), pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const c = [0.06 + rnd() * 0.14, 0.06 + rnd() * 0.14, 0.06 + rnd() * 0.14];
    pts.push(new THREE.Vector3(sx * (0.5 - c[0]), sy * 0.5, sz * 0.5));
    pts.push(new THREE.Vector3(sx * 0.5, sy * (0.5 - c[1]), sz * 0.5));
    pts.push(new THREE.Vector3(sx * 0.5, sy * 0.5, sz * (0.5 - c[2])));
  }
  for (const ax of [0, 1, 2]) for (const s of [-1, 1]) for (let k = 0; k < 2; k++) {
    const p = [(rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6];
    p[ax] = s * (0.5 + rnd() * 0.025);
    pts.push(new THREE.Vector3(...p));
  }
  const g = new ConvexGeometry(pts);
  // box-projected UVs so the obsidian maps read on every facet
  const p = g.attributes.position, n = g.attributes.normal, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const [u, v] = ax >= ay && ax >= az ? [p.getZ(i), p.getY(i)] : ay >= az ? [p.getX(i), p.getZ(i)] : [p.getX(i), p.getY(i)];
    uv[i * 2] = u + 0.5; uv[i * 2 + 1] = v + 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Glassy shard material. Per instance: aOutP/aOutN flag which local faces are the block's outer skin (black obsidian);
 * every other face is a fresh internal fracture showing the same magma section as the block's cut face (cap textures):
 * dark cooling crust + a glowing crack network, hotter toward the face centre and for core pieces (aHeat).
 * aHeat < 0 marks the gold ingot (polished metal).
 */
export function makeShardMaterial(obs, cap, look = {}) {
  // defaults = obsidian look (identical shading to the original shader); other recipes override through SHARD_LOOKS
  const o = {
    metalness: 0.05, innerMetal: 0.05, innerRough: 0.6, innerEmi: [0.25, 1.1], normalScale: 0.5, clearcoat: 0.9,
    anomMetal: 1.0, anomRough: 0.22, anomEmi: 0.18, anomAlbedo: 1.0, anomCoat: null, ruby: null, rim: 0, rimColor: '#ffffff', sampLo: 0, sampHi: 1, key: 'obsidian', ...look,
  };
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: obs.map, normalMap: obs.normalMap, normalScale: new THREE.Vector2(o.normalScale, o.normalScale),
    roughnessMap: obs.roughnessMap, roughness: 1, metalness: o.metalness, clearcoat: o.clearcoat, clearcoatRoughness: 0.06, envMapIntensity: 1.5,
  });
  const uniforms = {
    uCapMap: { value: cap.map }, uCapEmi: { value: cap.emissive },
    uInnerMetal: { value: o.innerMetal }, uInnerRough: { value: o.innerRough }, uInnerEmi: { value: new THREE.Vector2(...o.innerEmi) },
    uAnomAlbedo: { value: o.anomAlbedo }, uAnomCoat: { value: o.anomCoat ?? o.clearcoat },
    uUseRuby: { value: o.ruby ? 1 : 0 }, uRubyMap: { value: o.ruby?.map ?? cap.map }, uRubyEmi: { value: o.ruby?.emissive ?? cap.emissive }, uRubyN: { value: o.ruby?.normal ?? cap.map }, uAnomMetal: { value: o.anomMetal }, uAnomRough: { value: o.anomRough }, uAnomEmi: { value: o.anomEmi },
    uRim: { value: o.rim }, uRimCol: { value: new THREE.Color(o.rimColor) }, uSamp: { value: new THREE.Vector2(o.sampLo, o.sampHi) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aOutP; attribute vec3 aOutN; attribute float aHeat;
varying vec3 vSP; varying vec3 vSN; varying vec3 vOutP; varying vec3 vOutN; varying float vHeat; varying vec2 vSeed; varying vec3 vSEx; varying vec3 vSEy; varying vec3 vSEz;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vSP = position; vSN = normal; vOutP = aOutP; vOutN = aOutN; vHeat = aHeat;
#ifdef USE_INSTANCING
vSeed = fract(sin(vec2(float(gl_InstanceID) * 12.9898, float(gl_InstanceID) * 78.233)) * 43758.5453);
#else
vSeed = vec2(0.0);
#endif
#ifdef USE_INSTANCING
mat3 sMV = mat3(modelViewMatrix * instanceMatrix);
#else
mat3 sMV = mat3(modelViewMatrix);
#endif
vSEx = normalize(sMV * vec3(1.0, 0.0, 0.0)); vSEy = normalize(sMV * vec3(0.0, 1.0, 0.0)); vSEz = normalize(sMV * vec3(0.0, 0.0, 1.0));`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uCapMap, uCapEmi;
uniform sampler2D uRubyMap, uRubyEmi, uRubyN; uniform float uUseRuby, uAnomCoat;
uniform float uAnomAlbedo, uInnerMetal, uInnerRough, uAnomMetal, uAnomRough, uAnomEmi, uRim; uniform vec2 uInnerEmi, uSamp; uniform vec3 uRimCol;
varying vec3 vSP; varying vec3 vSN; varying vec3 vOutP; varying vec3 vOutN; varying float vHeat; varying vec2 vSeed; varying vec3 vSEx; varying vec3 vSEy; varying vec3 vSEz;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
vec3 sa = abs(vSN);
float sOuter; vec2 sFc;
if (sa.x >= sa.y && sa.x >= sa.z) { sOuter = vSN.x > 0.0 ? vOutP.x : vOutN.x; sFc = vSP.zy; }
else if (sa.y >= sa.z) { sOuter = vSN.y > 0.0 ? vOutP.y : vOutN.y; sFc = vSP.xz; }
else { sOuter = vSN.z > 0.0 ? vOutP.z : vOutN.z; sFc = vSP.xy; }
float sGold = step(vHeat, -0.5);
float sInner = (1.0 - sOuter) * (1.0 - sGold);
float sC = clamp(1.0 - 2.0 * max(abs(sFc.x), abs(sFc.y)), 0.0, 1.0);
vec2 sUv = clamp(vec2(0.18, 0.18) + vSeed * 0.5 + (sFc + 0.5) * 0.32 + sN(sa), vec2(uSamp.x), vec2(uSamp.y));
vec3 sCapCol = texture2D(uCapMap, sUv).rgb;
vec3 sCapEmi = texture2D(uCapEmi, sUv).rgb;
diffuseColor.rgb = mix(diffuseColor.rgb, sCapCol, sInner);
float sRim = sInner * (1.0 - smoothstep(uRim * 0.55, uRim, 0.5 - max(abs(sFc.x), abs(sFc.y)))) * step(0.001, uRim);
diffuseColor.rgb = mix(diffuseColor.rgb, uRimCol, sRim);
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
diffuseColor.rgb = mix(diffuseColor.rgb, mix(vColor.rgb * uAnomAlbedo, texture2D(uRubyMap, sUv).rgb, uUseRuby), sGold);
#endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, uInnerRough, sInner);
roughnessFactor = mix(roughnessFactor, 0.26, sRim);
roughnessFactor = mix(roughnessFactor, uAnomRough, sGold);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, uInnerMetal, sInner);
metalnessFactor = mix(metalnessFactor, 0.96, sRim);
metalnessFactor = mix(metalnessFactor, uAnomMetal, sGold);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 sEu, sEv;
  if (sa.x >= sa.y && sa.x >= sa.z) { sEu = vSEz; sEv = vSEy; } else if (sa.y >= sa.z) { sEu = vSEx; sEv = vSEz; } else { sEu = vSEx; sEv = vSEy; }
  vec2 sRt = texture2D(uRubyN, sUv).xy * 2.0 - 1.0;
  normal = normalize(normal + sGold * uUseRuby * 0.9 * (sRt.x * sEu + sRt.y * sEv));
}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
material.clearcoat = mix(material.clearcoat, uAnomCoat, sGold);
#endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float heat = clamp(vHeat, 0.0, 1.0) * (0.55 + 0.45 * smoothstep(0.0, 0.7, sC));
  totalEmissiveRadiance += sInner * (1.0 - sRim) * sCapEmi * (uInnerEmi.x + uInnerEmi.y * heat);
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  totalEmissiveRadiance += sGold * mix(vColor.rgb, texture2D(uRubyEmi, sUv).rgb, uUseRuby) * uAnomEmi;
#endif
}`);
    // per-axis offset so the three face orientations of one piece show different parts of the section
    sh.fragmentShader = sh.fragmentShader.replace('uniform sampler2D uCapMap, uCapEmi;',
      'uniform sampler2D uCapMap, uCapEmi;\nvec2 sN(vec3 a) { return a.x >= a.y && a.x >= a.z ? vec2(0.11, 0.07) : a.y >= a.z ? vec2(0.05, 0.13) : vec2(0.0); }');
  };
  mat.customProgramCacheKey = () => 'shard-v4';
  return mat;
}

/**
 * Per-look overrides for makeShardMaterial (selected by recipe.object.material; obsidian = defaults).
 * gold-emerald: cast-gold skin (metal), glossy dielectric emerald fracture faces with a thin gold rim,
 * and the anomaly cube is a glowing ruby (instance colour = palette.gold).
 */
export const SHARD_LOOKS = {
  'gold-emerald': {
    key: 'gold-emerald', metalness: 0.96, innerMetal: 0.0, innerRough: 0.16, innerEmi: [0.18, 0.45], normalScale: 0.6, clearcoat: 0.35,
    anomMetal: 0.05, anomRough: 0.11, anomEmi: 0.7, anomAlbedo: 1.0, anomCoat: 1.0, rim: 0.05, rimColor: '#f4c430', sampLo: 0.12, sampHi: 0.88,
  },
};
