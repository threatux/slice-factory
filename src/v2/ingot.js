// v2 levitating ingot: reuses the v1 cast-gold shell (blockGeometry, makeGoldCast, 999.9 FINE GOLD decals) and adds
// X/Y/Z seam lines computed in the fragment shader from object-space position (no decal geometry -> no Z-fighting).
import * as THREE from 'three';
import { blockGeometry, addIngotDecals } from '../objects.js';
import { makeGoldCast, makeIngotDecals, makeVolcanicObsidian, makeEarth, makeCryoIce, makeRubiksFace, makeNeonPrismCap } from '../textures.js';
import { addRubiksSkin, rubiksUniforms } from '../slabs.js';
import { makeAtmosphere } from './earth.js';
import { makeUraniumRod } from '../textures.js';
import { cylinderTriangles, cylinderPieceGeometry } from './cylinder.js';

/**
 * Seams of axis a sit on the planes p_a = -S_a/2 + k S_a / n_a, k = 1..n_a-1. Seams k < lo are fully lit; lo <= k < hi are lit
 * only where the blade edge has already passed (x/z planes: blade falls along -y; y planes: blade travels along -z).
 * Line coverage is pixel-footprint antialiased (fwidth), width shrinks with grid density.
 */
function addSeams(mat, U, alphaSeams = false) { // alphaSeams: translucent layer (clouds) turns opaque on the seam lines
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSP;
uniform vec3 uSN, uSLo, uSHi, uSRev, uSFlash, uSW, uHalf;
uniform vec3 uSCol, uSCol2;
uniform float uSGlow, uSFl, uSAlpha;
float sCov(float w, float d, float fw) { return clamp((0.5 * max(w, fw) - d) / fw + 0.5, 0.0, 1.0) * min(1.0, w / fw); }
// returns (halo coverage, core coverage, newest core coverage)
vec3 seamAxis(float p, float hl, float n, float lo, float hi, float rev, float revC, float w) {
  if (n < 1.5 || hi < 1.5 && lo < 1.5) return vec3(0.0);
  float span = 2.0 * hl / n;
  float kf = (p + hl) / span;
  float k = floor(kf + 0.5);
  float d = abs(kf - k) * span;
  float fw = max(fwidth(p), 1e-5);
  float inR = step(0.5, k) * step(k, n - 0.5);
  float full = step(k, lo - 0.5);
  float cur = step(lo - 0.5, k) * step(k, hi - 0.5) * revC;
  float on = inR * max(full, cur);
  float core = sCov(w, d, fw);
  return vec3(on * sCov(w * 2.2, d, fw), on * core, inR * cur * core);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
vec3 sH = vec3(0.0);
float sNew = 0.0;
{
  float rxz = smoothstep(-0.006, 0.006, vSP.y - (uHalf.y - uSRev.x * 2.0 * uHalf.y));
  float rzz = smoothstep(-0.006, 0.006, vSP.y - (uHalf.y - uSRev.z * 2.0 * uHalf.y));
  float ryy = smoothstep(-0.006, 0.006, vSP.z - (uHalf.z - uSRev.y * 2.0 * uHalf.z));
  vec3 ax = seamAxis(vSP.x, uHalf.x, uSN.x, uSLo.x, uSHi.x, uSRev.x, rxz, uSW.x);
  vec3 ay = seamAxis(vSP.y, uHalf.y, uSN.y, uSLo.y, uSHi.y, uSRev.y, ryy, uSW.y);
  vec3 az = seamAxis(vSP.z, uHalf.z, uSN.z, uSLo.z, uSHi.z, uSRev.z, rzz, uSW.z);
  sH = vec3(max(ax.x, max(ay.x, az.x)), max(ax.y, max(ay.y, az.y)), 0.0) * uSAlpha;
  sNew = max(ax.z * uSFlash.x, max(ay.z * uSFlash.y, az.z * uSFlash.z)) * uSAlpha;
}
diffuseColor.rgb *= 1.0 - 0.8 * sH.x;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.6, sH.x);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += (uSCol2 * sH.x * 0.35 + uSCol * sH.y) * uSGlow + uSCol * sNew * uSFl;`);
    if (alphaSeams) sh.fragmentShader = sh.fragmentShader.replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a = max(diffuseColor.a, sH.x);');
  };
  mat.customProgramCacheKey = () => (alphaSeams ? 'seams-v2-alpha' : 'seams-v2');
}

/**
 * Sphere mode (recipe.object.shape === "sphere"): procedural Earth (radius R = size/2) + swirling cloud shell (1.015 R) +
 * Fresnel atmosphere. Same seam uniforms / API as the ingot: seams are the planes x|y|z = cut, drawn on the surface and on the
 * clouds (so they stay crisp), faded by seamState().alpha for the loop. Clouds + atmosphere vanish with the planet at impact.
 */
function createPlanet(recipe) {
  const cfg = recipe.object, pal = recipe.palette;
  const R = cfg.size[0] / 2;
  const seamCfg = { width: 0.024, glow: 2.4, flash: 5, ...(recipe.v2.seam ?? {}) };
  const [c1, c2] = pal.seam ?? ['#fff3c4', '#ff5e00'];
  const ice = cfg.surfaceStyle === 'cryo-ice'; // glacial ice skin (object.ice) instead of the Earth maps; Earth defaults untouched
  const ec = ice
    ? { bump: 1.2, crackGlow: 0.6, clearcoat: 1.0, clearcoatRoughness: 0.06, rim: '#38bdf8', rimStrength: 0.35, halo: false, ...(cfg.ice ?? {}) }
    : { lon: 0, seed: 7, land: 0.34, bump: 1.6, clouds: 0.85, atmosphere: '#4cc9f0', atmoStrength: 1, ...(cfg.earth ?? {}) };
  const earth = ice ? makeCryoIce(ec) : makeEarth(ec);
  const frame = new THREE.Group();
  const mat = ice ? new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: earth.map, roughnessMap: earth.roughnessMap, bumpMap: earth.bumpMap, bumpScale: ec.bump, roughness: 1, metalness: 0,
    clearcoat: ec.clearcoat, clearcoatRoughness: ec.clearcoatRoughness, envMapIntensity: ec.envMapIntensity ?? 1.0,
    emissive: 0xffffff, emissiveMap: earth.emissiveMap, emissiveIntensity: ec.crackGlow,
  }) : new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: earth.map, roughnessMap: earth.roughnessMap, bumpMap: earth.bumpMap, bumpScale: ec.bump, roughness: 1, metalness: 0,
    clearcoat: 0.0, envMapIntensity: 1.0,
  });
  const U = {
    uSN: { value: new THREE.Vector3(1, 1, 1) }, uSLo: { value: new THREE.Vector3(1, 1, 1) }, uSHi: { value: new THREE.Vector3(1, 1, 1) },
    uSRev: { value: new THREE.Vector3() }, uSFlash: { value: new THREE.Vector3() }, uSW: { value: new THREE.Vector3(0.02, 0.02, 0.02) },
    uHalf: { value: new THREE.Vector3(R, R, R) },
    uSCol: { value: new THREE.Color(c1) }, uSCol2: { value: new THREE.Color(c2) },
    uSGlow: { value: seamCfg.glow }, uSFl: { value: seamCfg.flash }, uSAlpha: { value: 1 },
  };
  addSeams(mat, U);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 192, 96), mat);
  mesh.castShadow = mesh.receiveShadow = true;
  if (ice || cfg.clouds === false) { // no cloud shell; cold Fresnel rim only (halo shell optional -> no soap-bubble ring)
    const atmo = makeAtmosphere(R, ec.rim ?? ec.atmosphere, ec.rimStrength ?? ec.atmoStrength);
    const extras = ec.halo ? [atmo.halo, atmo.limb] : [atmo.limb];
    frame.add(mesh, ...extras);
    return planetApi(frame, mesh, R, earth, extras, U, seamCfg);
  }
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, alphaMap: earth.clouds, transparent: true, opacity: ec.clouds, roughness: 0.9, metalness: 0, depthWrite: false,
  });
  addSeams(cloudMat, U, true);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.015, 160, 80), cloudMat);
  clouds.renderOrder = 1;
  const atmo = makeAtmosphere(R, ec.atmosphere, ec.atmoStrength);
  frame.add(mesh, clouds, atmo.halo, atmo.limb);
  const extras = [clouds, atmo.halo, atmo.limb];
  return {
    frame, mesh, size: [2 * R, 2 * R, 2 * R], earth,
    setPose(y, yaw) { frame.position.set(0, y, 0); frame.rotation.set(0, yaw, 0); frame.updateMatrixWorld(true); },
    setVisible(v) { mesh.visible = v; for (const e of extras) e.visible = v; },
    setSeams(s) {
      const [nx, ny, nz] = s.grid;
      U.uSN.value.set(nx, ny, nz);
      U.uSLo.value.set(s.axes[0].lo, s.axes[1].lo, s.axes[2].lo);
      U.uSHi.value.set(s.axes[0].hi, s.axes[1].hi, s.axes[2].hi);
      U.uSRev.value.set(s.axes[0].rev, s.axes[1].rev, s.axes[2].rev);
      U.uSFlash.value.set(s.axes[0].flash, s.axes[1].flash, s.axes[2].flash);
      const w = (n) => seamCfg.width / Math.sqrt(Math.max(1, n - 1)) + 0.0035;
      U.uSW.value.set(w(nx), w(ny), w(nz));
      const dens = Math.max(nx, ny, nz);
      U.uSGlow.value = seamCfg.glow * s.pulse * (dens > 10 ? 0.8 : 1);
      U.uSAlpha.value = s.alpha;
    },
  };
}

/** Planet API for the cloud-less sphere looks (identical behaviour to the Earth object above). */
function planetApi(frame, mesh, R, earth, extras, U, seamCfg, size = [2 * R, 2 * R, 2 * R]) {
  return {
    frame, mesh, size, earth,
    setPose(y, yaw) { frame.position.set(0, y, 0); frame.rotation.set(0, yaw, 0); frame.updateMatrixWorld(true); },
    setVisible(v) { mesh.visible = v; for (const e of extras) e.visible = v; },
    setSeams(s) {
      const [nx, ny, nz] = s.grid;
      U.uSN.value.set(nx, ny, nz);
      U.uSLo.value.set(s.axes[0].lo, s.axes[1].lo, s.axes[2].lo);
      U.uSHi.value.set(s.axes[0].hi, s.axes[1].hi, s.axes[2].hi);
      U.uSRev.value.set(s.axes[0].rev, s.axes[1].rev, s.axes[2].rev);
      U.uSFlash.value.set(s.axes[0].flash, s.axes[1].flash, s.axes[2].flash);
      const w = (n) => seamCfg.width / Math.sqrt(Math.max(1, n - 1)) + 0.0035;
      U.uSW.value.set(w(nx), w(ny), w(nz));
      const dens = Math.max(nx, ny, nz);
      U.uSGlow.value = seamCfg.glow * s.pulse * (dens > 10 ? 0.8 : 1);
      U.uSAlpha.value = s.alpha;
    },
  };
}

/**
 * Rubik's cube (recipe.object.surfaceStyle === "rubiks"): rounded W x H x D block (1:1:1 in the recipe) with the shared Rubik skin
 * (3x3 glossy ABS tiles per face, black grooves, bump bevels; slabs.js addRubiksSkin) + the usual seam pass. No stamp/decals.
 */
function createRubiks(recipe) {
  const cfg = recipe.object, pal = recipe.palette;
  const [W, H, D] = cfg.size;
  const seamCfg = { width: 0.024, glow: 2.4, flash: 5, ...(recipe.v2.seam ?? {}) };
  const [c1, c2] = pal.seam ?? ['#ffffff', pal.core];
  const frame = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.08, envMapIntensity: cfg.rubiks?.envMapIntensity ?? 1.0 });
  const U = {
    uSN: { value: new THREE.Vector3(1, 1, 1) }, uSLo: { value: new THREE.Vector3(1, 1, 1) }, uSHi: { value: new THREE.Vector3(1, 1, 1) },
    uSRev: { value: new THREE.Vector3() }, uSFlash: { value: new THREE.Vector3() }, uSW: { value: new THREE.Vector3(0.02, 0.02, 0.02) },
    uHalf: { value: new THREE.Vector3(W / 2, H / 2, D / 2) },
    uSCol: { value: new THREE.Color(c1) }, uSCol2: { value: new THREE.Color(c2) },
    uSGlow: { value: seamCfg.glow }, uSFl: { value: seamCfg.flash }, uSAlpha: { value: 1 },
  };
  addSeams(mat, U);
  addRubiksSkin(mat, rubiksUniforms([W, H, D], makeRubiksFace(), makeNeonPrismCap(pal), cfg.rubiks ?? {}));
  const mesh = new THREE.Mesh(blockGeometry(W, H, D, cfg.bevel ?? 0.025, 17, 0), mat);
  mesh.castShadow = mesh.receiveShadow = true;
  frame.add(mesh);
  return planetApi(frame, mesh, W / 2, null, [], U, seamCfg, [W, H, D]);
}

/**
 * Cylinder mode (recipe.object.shape === "cylinder", surfaceStyle "uranium-rod"): vertical fuel rod radius R, height H (size =
 * [2R, H, 2R]) built from the same closed triangle set that cylinder.js clips (identical skin UVs on the intact rod and on every
 * piece). Brushed titanium capsule (atlas map + ORM rough/metal + bump), cooling slots / lid ring glow through emissiveMap, the
 * usual seam pass (object-space planes, no decal geometry -> no Z-fighting).
 */
function createCylinder(recipe) {
  const cfg = recipe.object, pal = recipe.palette;
  const [W, H] = cfg.size, R = W / 2;
  const uc = { slotGlow: 1.4, bump: 1.0, clearcoat: 0.25, envMapIntensity: 1.0, ...(cfg.uranium ?? {}) };
  const seamCfg = { width: 0.024, glow: 2.4, flash: 5, ...(recipe.v2.seam ?? {}) };
  const [c1, c2] = pal.seam ?? ['#ffffff', pal.core];
  const rod = makeUraniumRod({ radius: R, height: H, ...uc });
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: rod.map, roughnessMap: rod.ormMap, metalnessMap: rod.ormMap, roughness: 1, metalness: 1,
    bumpMap: rod.bumpMap, bumpScale: uc.bump, clearcoat: uc.clearcoat, clearcoatRoughness: 0.3, envMapIntensity: uc.envMapIntensity,
    emissive: 0xffffff, emissiveMap: rod.emissiveMap, emissiveIntensity: uc.slotGlow,
  });
  const U = {
    uSN: { value: new THREE.Vector3(1, 1, 1) }, uSLo: { value: new THREE.Vector3(1, 1, 1) }, uSHi: { value: new THREE.Vector3(1, 1, 1) },
    uSRev: { value: new THREE.Vector3() }, uSFlash: { value: new THREE.Vector3() }, uSW: { value: new THREE.Vector3(0.02, 0.02, 0.02) },
    uHalf: { value: new THREE.Vector3(R, H / 2, R) },
    uSCol: { value: new THREE.Color(c1) }, uSCol2: { value: new THREE.Color(c2) },
    uSGlow: { value: seamCfg.glow }, uSFl: { value: seamCfg.flash }, uSAlpha: { value: 1 },
  };
  addSeams(mat, U);
  const geo = cylinderPieceGeometry(cylinderTriangles(R, H, cfg.segments ?? 192, cfg.rings ?? 25), R, H).geometry;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  const frame = new THREE.Group();
  frame.add(mesh);
  return planetApi(frame, mesh, R, null, [], U, seamCfg, [W, H, W]);
}

export function createIngot(recipe) {
  if (recipe.object.shape === 'cylinder') return createCylinder(recipe);
  if (recipe.object.shape === 'sphere') return createPlanet(recipe);
  if (recipe.object.surfaceStyle === 'rubiks') return createRubiks(recipe);
  const cfg = recipe.object, pal = recipe.palette;
  const [W, H, D] = cfg.size;
  const bevel = cfg.bevel ?? 0.045;
  const seamCfg = { width: 0.024, glow: 2.4, flash: 5, ...(recipe.v2.seam ?? {}) };
  const [c1, c2] = pal.seam ?? ['#c8fff4', pal.core];
  const frame = new THREE.Group(); // ingot pose (y + yaw); blades & sparks are expressed in this frame too
  // surfaceStyle: "gold" (default: cast gold + stamp) | "obsidian" (volcanic glass with smouldering fractures); engraving: false drops the stamp
  const volcanic = cfg.surfaceStyle === 'obsidian';
  const gc = volcanic ? makeVolcanicObsidian(pal) : makeGoldCast(pal);
  const dec = makeIngotDecals([W, H, D], { engrave: cfg.engraving ?? true });
  const mat = volcanic ? new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: gc.map, normalMap: gc.normalMap, normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: gc.roughnessMap, roughness: 1, metalness: 0.15, clearcoat: 0.65, clearcoatRoughness: 0.06,
    emissive: 0xffffff, emissiveMap: gc.emissiveMap, emissiveIntensity: cfg.smoulder ?? 1.0,
  }) : new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: gc.map, normalMap: gc.normalMap, normalScale: new THREE.Vector2(0.5, 0.5),
    roughnessMap: gc.roughnessMap, roughness: 1, metalness: 0.96, clearcoat: 0.35, clearcoatRoughness: 0.12,
  });
  const U = {
    uSN: { value: new THREE.Vector3(1, 1, 1) }, uSLo: { value: new THREE.Vector3(1, 1, 1) }, uSHi: { value: new THREE.Vector3(1, 1, 1) },
    uSRev: { value: new THREE.Vector3() }, uSFlash: { value: new THREE.Vector3() }, uSW: { value: new THREE.Vector3(0.02, 0.02, 0.02) },
    uHalf: { value: new THREE.Vector3(W / 2, H / 2, D / 2) },
    uSCol: { value: new THREE.Color(c1) }, uSCol2: { value: new THREE.Color(c2) },
    uSGlow: { value: seamCfg.glow }, uSFl: { value: seamCfg.flash }, uSAlpha: { value: 1 },
  };
  addSeams(mat, U);
  const decal = {
    uDTopN: { value: dec.top.normal }, uDTopM: { value: dec.top.mask }, uDSideN: { value: dec.side.normal }, uDSideM: { value: dec.side.mask },
    uDSize: { value: new THREE.Vector3(W, H, D) }, uDGlowCol: { value: new THREE.Color(pal.crackGlow ?? pal.core) }, uDGlow: { value: cfg.crackGlow ?? 0.45 }, uDStr: { value: 1.0 },
  };
  addIngotDecals(mat, decal);
  const mesh = new THREE.Mesh(blockGeometry(W, H, D, bevel, 17, cfg.flake ?? 0.006), mat);
  mesh.castShadow = mesh.receiveShadow = true;
  frame.add(mesh);

  return {
    frame, mesh, size: [W, H, D],
    setPose(y, yaw) { frame.position.set(0, y, 0); frame.rotation.set(0, yaw, 0); frame.updateMatrixWorld(true); },
    setVisible(v) { mesh.visible = v; },
    /** s = timeline.seamState(t) */
    setSeams(s) {
      const [nx, ny, nz] = s.grid;
      U.uSN.value.set(nx, ny, nz);
      U.uSLo.value.set(s.axes[0].lo, s.axes[1].lo, s.axes[2].lo);
      U.uSHi.value.set(s.axes[0].hi, s.axes[1].hi, s.axes[2].hi);
      U.uSRev.value.set(s.axes[0].rev, s.axes[1].rev, s.axes[2].rev);
      U.uSFlash.value.set(s.axes[0].flash, s.axes[1].flash, s.axes[2].flash);
      const w = (n) => seamCfg.width / Math.sqrt(Math.max(1, n - 1)) + 0.0035;
      U.uSW.value.set(w(nx), w(ny), w(nz));
      const dens = Math.max(nx, ny, nz);
      U.uSGlow.value = seamCfg.glow * s.pulse * (dens > 10 ? 0.8 : 1);
      U.uSAlpha.value = s.alpha;
    },
  };
}
