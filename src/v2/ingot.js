// v2 levitating ingot: reuses the v1 cast-gold shell (blockGeometry, makeGoldCast, 999.9 FINE GOLD decals) and adds
// X/Y/Z seam lines computed in the fragment shader from object-space position (no decal geometry -> no Z-fighting).
import * as THREE from 'three';
import { blockGeometry, addIngotDecals } from '../objects.js';
import { makeGoldCast, makeIngotDecals } from '../textures.js';

/**
 * Seams of axis a sit on the planes p_a = -S_a/2 + k S_a / n_a, k = 1..n_a-1. Seams k < lo are fully lit; lo <= k < hi are lit
 * only where the blade edge has already passed (x/z planes: blade falls along -y; y planes: blade travels along -z).
 * Line coverage is pixel-footprint antialiased (fwidth), width shrinks with grid density.
 */
function addSeams(mat, U) {
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
  };
  mat.customProgramCacheKey = () => 'seams-v2';
}

export function createIngot(recipe) {
  const cfg = recipe.object, pal = recipe.palette;
  const [W, H, D] = cfg.size;
  const bevel = cfg.bevel ?? 0.045;
  const seamCfg = { width: 0.024, glow: 2.4, flash: 5, ...(recipe.v2.seam ?? {}) };
  const [c1, c2] = pal.seam ?? ['#c8fff4', pal.core];
  const frame = new THREE.Group(); // ingot pose (y + yaw); blades & sparks are expressed in this frame too
  const gc = makeGoldCast(pal), dec = makeIngotDecals([W, H, D]);
  const mat = new THREE.MeshPhysicalMaterial({
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
    uDSize: { value: new THREE.Vector3(W, H, D) }, uDGlowCol: { value: new THREE.Color(pal.core) }, uDGlow: { value: 0.45 }, uDStr: { value: 1.0 },
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
