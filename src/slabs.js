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
    anomMetal: 1.0, anomRough: 0.22, anomEmi: 0.18, anomAlbedo: 1.0, anomCoat: null, ruby: null, rim: 0, rimColor: '#ffffff', sampLo: 0, sampHi: 1, seedFit: 0, key: 'obsidian', ...look,
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
    uRim: { value: o.rim }, uRimCol: { value: new THREE.Color(o.rimColor) }, uSamp: { value: new THREE.Vector2(o.sampLo, o.sampHi) }, uFit: { value: o.seedFit },
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
uniform float uAnomAlbedo, uInnerMetal, uInnerRough, uAnomMetal, uAnomRough, uAnomEmi, uRim; uniform vec2 uInnerEmi, uSamp; uniform float uFit; uniform vec3 uRimCol;
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
// uFit: per-instance window offset scaled so the whole face window stays inside [uSamp.x, uSamp.y] (no clamp streaks)
vec2 sBase = uFit > 0.5 ? vec2(uSamp.x) + vSeed * (uSamp.y - uSamp.x - 0.45) : vec2(0.18, 0.18) + vSeed * 0.5;
vec2 sUv = clamp(sBase + (sFc + 0.5) * 0.32 + sN(sa), vec2(uSamp.x), vec2(uSamp.y));
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
  // volcanic obsidian skin (glossy black glass) + molten magma fracture faces; the anomaly is a separate mesh (debris.js)
  'obsidian-magma': {
    key: 'obsidian-magma', metalness: 0.15, innerMetal: 0.0, innerRough: 0.55, innerEmi: [0.7, 0.9], normalScale: 0.9, clearcoat: 0.65,
    rim: 0, sampLo: 0.1, sampHi: 0.9, seedFit: 1,
  },
};

/**
 * Rubik's Cube skin (recipe.object.surfaceStyle = "rubiks"), shared by the intact cube (ingot.js) and its pieces (debris.js).
 * The 3x3 sticker grid is sampled with INGOT-SPACE face UVs: P = aHome + position * uRCell (pieces: home cell centre + unit
 * piece scaled by the cell size; intact cube: home 0, cell 1), so every cut piece shows exactly its own sub-window of the grid
 * (no duplicated 3x3 per piece, no stretched halves). Face colour by the outward axis: +x, -x, +y, -y, +z, -z.
 * Per-instance (pieces): aOutP/aOutN = 1 on faces that are the cube's outer skin, 0 = fresh cut (neon-prism core);
 * uRMini = 1 (micro rounds): outer faces become whole mini tiles in the instance colour with a thin black plastic border.
 * opts.anchor: shader chunk after which the albedo is replaced (ingot: map_fragment, so the seam pass still darkens it;
 * instanced pieces: color_fragment, so the instance colour is not multiplied in twice).
 */
export function addRubiksSkin(mat, U, { instanced = false, anchor = '#include <map_fragment>' } = {}) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
${instanced ? 'attribute vec3 aOutP; attribute vec3 aOutN; attribute vec3 aHome; attribute float aHeat;' : ''}
varying vec3 vRP; varying vec3 vRN; varying vec3 vROutP; varying vec3 vROutN; varying vec3 vRHome; varying float vRHeat; varying vec2 vRSeed;
varying vec3 vREx; varying vec3 vREy; varying vec3 vREz;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRP = position; vRN = normal;
${instanced ? `vROutP = aOutP; vROutN = aOutN; vRHome = aHome; vRHeat = aHeat;
vRSeed = fract(sin(vec2(float(gl_InstanceID) * 12.9898, float(gl_InstanceID) * 78.233)) * 43758.5453);
mat3 rMV = mat3(modelViewMatrix * instanceMatrix);` : `vROutP = vec3(1.0); vROutN = vec3(1.0); vRHome = vec3(0.0); vRHeat = 0.0; vRSeed = vec2(0.0);
mat3 rMV = mat3(modelViewMatrix);`}
vREx = normalize(rMV * vec3(1.0, 0.0, 0.0)); vREy = normalize(rMV * vec3(0.0, 1.0, 0.0)); vREz = normalize(rMV * vec3(0.0, 0.0, 1.0));`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRP; varying vec3 vRN; varying vec3 vROutP; varying vec3 vROutN; varying vec3 vRHome; varying float vRHeat; varying vec2 vRSeed;
varying vec3 vREx; varying vec3 vREy; varying vec3 vREz;
uniform sampler2D uRFace, uRCap, uRCapEmi;
uniform vec3 uRCol[6]; uniform vec3 uRGroove, uRSize, uRCell;
uniform float uRMini, uRBump, uRTexel, uRRim, uRInnerRough, uRInnerMetal, uRInnerCoat;
uniform vec2 uRRough, uRCoat, uRInnerEmi, uRSamp;
vec2 rAxOff(vec3 a) { return a.x >= a.y && a.x >= a.z ? vec2(0.37, 0.11) : a.y >= a.z ? vec2(0.08, 0.53) : vec2(0.0); }`)
      .replace(anchor, `${anchor}
vec3 rA = abs(vRN);
vec3 rP = vRHome + vRP * uRCell;
float rOut; vec2 rFc, rUv, rS; vec3 rCol, rTu, rTv;
if (rA.x >= rA.y && rA.x >= rA.z) {
  bool rPos = vRN.x > 0.0; rOut = rPos ? vROutP.x : vROutN.x; rFc = vRP.zy; rCol = rPos ? uRCol[0] : uRCol[1];
  rUv = vec2(rP.z / uRSize.z, rP.y / uRSize.y) + 0.5; rS = uRSize.zy; rTu = vREz; rTv = vREy;
} else if (rA.y >= rA.z) {
  bool rPos = vRN.y > 0.0; rOut = rPos ? vROutP.y : vROutN.y; rFc = vRP.xz; rCol = rPos ? uRCol[2] : uRCol[3];
  rUv = vec2(rP.x / uRSize.x, rP.z / uRSize.z) + 0.5; rS = uRSize.xz; rTu = vREx; rTv = vREz;
} else {
  bool rPos = vRN.z > 0.0; rOut = rPos ? vROutP.z : vROutN.z; rFc = vRP.xy; rCol = rPos ? uRCol[4] : uRCol[5];
  rUv = vec2(rP.x / uRSize.x, rP.y / uRSize.y) + 0.5; rS = uRSize.xy; rTu = vREx; rTv = vREy;
}
float rM; vec2 rB = vec2(0.0);
if (uRMini > 0.5) { // micro piece: the whole face is one tile in the instance colour, thin black plastic border
  float rr = max(abs(rFc.x), abs(rFc.y)), rfw = max(fwidth(rr), 1e-4);
  rM = 1.0 - smoothstep(0.5 - uRRim - rfw, 0.5 - uRRim + rfw, rr);
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  rCol = vColor.rgb;
#endif
} else {
  vec2 rUvc = clamp(rUv, 0.0, 1.0);
  rM = texture2D(uRFace, rUvc).r;
  rB = vec2(texture2D(uRFace, rUvc + vec2(uRTexel, 0.0)).g - texture2D(uRFace, rUvc - vec2(uRTexel, 0.0)).g,
            texture2D(uRFace, rUvc + vec2(0.0, uRTexel)).g - texture2D(uRFace, rUvc - vec2(0.0, uRTexel)).g) * uRBump * rOut;
}
float rIn = 1.0 - rOut;
vec2 rCapUv = uRMini > 0.5 ? vec2(uRSamp.x) + vRSeed * (uRSamp.y - uRSamp.x - 0.22) + (rFc + 0.5) * 0.22 + rAxOff(rA)
                           : vec2(0.04) + rUv * 0.92 + rAxOff(rA);
vec3 rCapE = texture2D(uRCapEmi, rCapUv).rgb;
diffuseColor.rgb = mix(mix(uRGroove, rCol, rM), texture2D(uRCap, rCapUv).rgb, rIn);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(mix(uRRough.y, uRRough.x, rM), uRInnerRough, rIn);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, uRInnerMetal, rIn);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize(normal - rB.x * rTu - rB.y * rTv);`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
material.clearcoat = mix(mix(uRCoat.y, uRCoat.x, rM), uRInnerCoat, rIn);
#endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += rIn * rCapE * (uRInnerEmi.x + uRInnerEmi.y * clamp(vRHeat, 0.0, 1.0));`);
  };
  mat.customProgramCacheKey = () => prevKey() + (instanced ? '+rubiks-skin-inst-v1' : '+rubiks-skin-v1');
}

/** Uniforms of the Rubik skin (cfg = recipe.object.rubiks overrides, face = makeRubiksFace(), cap = makeNeonPrismCap()). */
export function rubiksUniforms(size, face, cap, cfg = {}) {
  const c = {
    colors: ['#0051ba', '#009e49', '#f2f2f5', '#ffd000', '#d90429', '#ff6b00'], groove: '#0b0c10', tileRough: 0.14, grooveRough: 0.45,
    tileCoat: 0.9, grooveCoat: 0.25, bump: 2.2, rim: 0.09, innerRough: 0.42, innerMetal: 0.0, innerCoat: 0.3, innerEmi: [0.35, 0.9], ...cfg,
  };
  return {
    uRFace: { value: face.map }, uRCap: { value: cap.map }, uRCapEmi: { value: cap.emissive },
    uRCol: { value: c.colors.map((h) => new THREE.Color(h)) }, uRGroove: { value: new THREE.Color(c.groove) },
    uRSize: { value: new THREE.Vector3(...size) }, uRCell: { value: new THREE.Vector3(1, 1, 1) },
    uRMini: { value: 0 }, uRBump: { value: c.bump }, uRTexel: { value: 1.5 / face.size }, uRRim: { value: c.rim },
    uRRough: { value: new THREE.Vector2(c.tileRough, c.grooveRough) }, uRCoat: { value: new THREE.Vector2(c.tileCoat, c.grooveCoat) },
    uRInnerRough: { value: c.innerRough }, uRInnerMetal: { value: c.innerMetal }, uRInnerCoat: { value: c.innerCoat }, uRInnerEmi: { value: new THREE.Vector2(...c.innerEmi) },
    uRSamp: { value: new THREE.Vector2(0.05, 0.95) },
  };
}

/** Instanced piece material for the Rubik's cube (R1-R6). userData.rubiks = uniforms (debris sets uRCell / uRMini per round). */
export function makeRubiksShardMaterial(size, face, cap, cfg = {}) {
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.08, envMapIntensity: cfg.envMapIntensity ?? 1.0 });
  const U = rubiksUniforms(size, face, cap, cfg);
  addRubiksSkin(mat, U, { instanced: true, anchor: '#include <color_fragment>' });
  mat.userData.rubiks = U;
  return mat;
}
