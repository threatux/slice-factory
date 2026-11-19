import * as THREE from 'three';
import {
  makeObsidian, makeCap, makeDamascus, makeEdgeMask, makeCarbon, makeGlowTexture, makeEdgeGradient,
} from './textures.js';
import { LAYOUT } from './config.js';
import { clamp01, mulberry32 } from './util.js';

async function loadGlb(cfg) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(cfg.url);
  const root = gltf.scene;
  if (cfg.scale) root.scale.setScalar(cfg.scale);
  if (cfg.rotation) root.rotation.set(...cfg.rotation);
  root.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return root;
}

/**
 * Kerf lines computed in the fragment shader from the block's local z (no canvas painting, no coplanar decals):
 * cut k sits at z = -D/2 + (k+1)·D/N. Width and glow fall with 1/sqrt(total cuts) and are pixel-footprint antialiased.
 * The newest kerf only exists above the descending knife edge (uKerfCutY = edge height above the table, 0 = cut through).
 */
function addKerfs(mat, uniforms) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vKLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvKLocal = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vKLocal;
uniform float uKerfN, uKerfCount, uKerfW, uKerfGlow, uHalfD, uHalfH, uKerfFlash, uKerfCutY;
uniform vec3 uKerfColor;
float kerfCov(float w, float d, float fw) { return clamp((0.5 * max(w, fw) - d) / fw + 0.5, 0.0, 1.0) * min(1.0, w / fw); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
float kSlit = 0.0, kCore = 0.0, kNew = 0.0;
if (uKerfCount > 0.5) {
  float span = 2.0 * uHalfD / uKerfN;
  float kz = (vKLocal.z + uHalfD) / span - 1.0;
  float k = floor(kz + 0.5);
  float d = abs(kz - k) * span;
  float fw = max(fwidth(vKLocal.z), 1e-5);
  float newest = step(uKerfCount - 1.5, k);
  float reach = smoothstep(uKerfCutY - 0.004, uKerfCutY + 0.004, vKLocal.y + uHalfH);
  float on = step(-0.5, k) * step(k, uKerfCount - 0.5) * mix(1.0, reach, newest);
  kSlit = on * kerfCov(uKerfW * 2.4, d, fw);
  kCore = on * kerfCov(uKerfW * 0.7, d, fw);
  kNew = kCore * newest;
}
diffuseColor.rgb *= 1.0 - 0.85 * kSlit;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += uKerfColor * (kCore * uKerfGlow + kNew * uKerfFlash);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.85, kSlit);');
  };
  mat.customProgramCacheKey = () => 'kerf-v3';
}

/**
 * Chamfered, lightly flaked block: every face is a dense grid mapped onto a rounded box (radius r); the flat interior
 * gets shallow planar flake facets (≤ amp, inward only, fading to 0 before the bevel so the cut cap still fits).
 * UVs: box projection in world units (1 tile = 1.5 units) with per-face offsets so the fracture network never repeats on adjacent faces.
 */
function blockGeometry(W, H, D, r, seed = 17) {
  const half = [W / 2, H / 2, D / 2];
  const rnd = mulberry32(seed);
  const FACES = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const ax = (vec) => vec.findIndex((c) => c !== 0);
  const samples = (h) => {
    const a = [], nb = 5, ni = Math.max(8, Math.round((2 * (h - r)) / 0.03));
    for (let i = 0; i < nb; i++) a.push(-h + (r * i) / nb);
    for (let i = 0; i <= ni; i++) a.push(-(h - r) + (2 * (h - r) * i) / ni);
    for (let i = nb - 1; i >= 0; i--) a.push(h - (r * i) / nb);
    return a;
  };
  const amp = 0.006, fadeW = 0.07;
  const pos = [], nrm = [], uv = [], idx = [], fixedN = [];
  const q = [0, 0, 0], inner = [0, 0, 0];
  FACES.forEach((F) => {
    const a = ax(F.n), b = ax(F.u), c = ax(F.v), s = F.n[a], su = F.u[b], sv = F.v[c];
    const us = samples(half[b]), vs = samples(half[c]);
    const cells = Array.from({ length: 11 }, () => ({
      x: (rnd() - 0.5) * 2 * half[b], y: (rnd() - 0.5) * 2 * half[c], gx: (rnd() - 0.5) * 0.09, gy: (rnd() - 0.5) * 0.09, o: 0.3 + rnd() * 0.5,
    }));
    const offU = rnd() * 7, offV = rnd() * 7;
    const base = pos.length / 3;
    for (const v of vs) for (const u of us) {
      q[a] = s * half[a]; q[b] = su * u; q[c] = sv * v;
      for (let k = 0; k < 3; k++) inner[k] = Math.max(-(half[k] - r), Math.min(half[k] - r, q[k]));
      let nx = q[0] - inner[0], ny = q[1] - inner[1], nz = q[2] - inner[2];
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const p = [inner[0] + nx * r, inner[1] + ny * r, inner[2] + nz * r];
      // flake facets in the flat interior
      const du = half[b] - r - Math.abs(u), dv = half[c] - r - Math.abs(v);
      const w = Math.min(1, Math.max(0, Math.min(du, dv) / fadeW));
      if (w > 0) {
        let best = 1e9, cl = cells[0];
        for (const C of cells) { const d = (u - C.x) ** 2 + (v - C.y) ** 2; if (d < best) { best = d; cl = C; } }
        const dsp = -amp * Math.min(1, Math.max(0, cl.o + (cl.gx * (u - cl.x) + cl.gy * (v - cl.y)) / 0.05));
        p[a] += s * dsp * w * w * (3 - 2 * w);
      }
      pos.push(...p);
      nrm.push(nx, ny, nz);
      fixedN.push(w === 0);
      uv.push((u + offU) / 1.5, (v + offV) / 1.5);
    }
    const nu = us.length;
    for (let j = 0; j < vs.length - 1; j++) for (let i = 0; i < nu - 1; i++) {
      const A = base + j * nu + i, B = A + 1, C = A + nu, E = C + 1;
      idx.push(A, B, E, A, E, C);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // exact bevel normals (continuous across face seams); computed normals only where the flakes displace the surface
  const N = g.attributes.normal;
  fixedN.forEach((f, i) => { if (f) N.setXYZ(i, nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]); });
  return g;
}

/** Rounded-rectangle cap geometry (matches the bevelled block cross-section), UV 0..1 over W x H. */
function capGeometry(W, H, r) {
  const s = new THREE.Shape(), x0 = -W / 2, x1 = W / 2, y0 = -H / 2, y1 = H / 2;
  s.moveTo(x0 + r, y0); s.lineTo(x1 - r, y0); s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r); s.quadraticCurveTo(x1, y1, x1 - r, y1); s.lineTo(x0 + r, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - r); s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const g = new THREE.ShapeGeometry(s, 6);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) - x0) / W, (p.getY(i) - y0) / H);
  return g;
}

export const CLIP_OFF = 100; // clip constant far outside the block (any rotation): no clipping, no cap

/**
 * Sliceable block. Cuts happen along world Z (the knife travels front/back); the block is turned 90° between phases.
 * `type: "procedural"` builds the chamfered obsidian block, `type: "glb"` loads recipe.object.glb (size still defines the slicing volume).
 */
export async function createBlock(cfg, pal) {
  const [W, H, D] = cfg.size;
  const bevel = cfg.bevel ?? 0.045;
  const group = new THREE.Group();
  const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), CLIP_OFF); // keeps z <= constant
  const clipMats = [];
  const kerf = {
    uKerfN: { value: 2 }, uKerfCount: { value: 0 }, uKerfW: { value: 0.01 }, uKerfGlow: { value: 0 },
    uHalfD: { value: D / 2 }, uHalfH: { value: H / 2 }, uKerfFlash: { value: 0 }, uKerfCutY: { value: 0 },
    uKerfColor: { value: new THREE.Color(pal.core) },
  };
  let kerfTotal = 1, shellMat = null;

  if (cfg.type === 'glb') {
    const root = await loadGlb(cfg.glb);
    root.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach((m) => clipMats.push(m)); });
    group.add(root);
  } else {
    const obs = makeObsidian(pal);
    const rel = cfg.relief ?? 1;
    shellMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, map: obs.map, normalMap: obs.normalMap, normalScale: new THREE.Vector2(0.85, 0.85).multiplyScalar(rel),
      roughnessMap: obs.roughnessMap, roughness: 1, metalness: 0,
      clearcoat: 0.95, clearcoatRoughness: 0.035, clearcoatNormalMap: obs.normalMap, clearcoatNormalScale: new THREE.Vector2(0.45, 0.45).multiplyScalar(rel),
      ior: 1.49, specularIntensity: 1, specularColor: new THREE.Color(0xbfcdf0), envMapIntensity: 1.7,
      emissive: 0xffffff, emissiveMap: obs.emissiveMap, emissiveIntensity: 1,
    });
    addKerfs(shellMat, kerf);
    const mesh = new THREE.Mesh(blockGeometry(W, H, D, bevel), shellMat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    clipMats.push(shellMat);
  }
  for (const m of clipMats) { m.clippingPlanes = [clip]; m.clipShadows = true; }

  // Cross-section cap: rounded face just in front of the clipping plane. No shadow receiving (prevents acne/grid on the face).
  const capTex = makeCap(pal, W / H);
  const capMat = new THREE.MeshStandardMaterial({
    map: capTex.map, roughnessMap: capTex.roughness, roughness: 1, metalness: 0.05,
    emissive: 0xffffff, emissiveMap: capTex.emissive, emissiveIntensity: 1.2,
  });
  const cap = new THREE.Mesh(capGeometry(W, H, bevel), capMat);
  cap.visible = false;
  const glowTex = makeGlowTexture();
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: pal.core, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.2, toneMapped: false,
  }));
  coreGlow.visible = false;
  const capGroup = new THREE.Group();
  capGroup.add(cap, coreGlow);
  const coreLight = new THREE.PointLight(pal.core, 0, 3.4, 2);
  capGroup.add(coreLight);
  let depthHeat = 1;

  return {
    group, capGroup, coreLight, size: [W, H, D],
    get clipZ() { return clip.constant; },
    setClip(z) {
      clip.constant = z;
      const open = z < D / 2 - 0.004 && z > -D / 2 + 0.004;
      cap.visible = coreGlow.visible = open;
      if (!open) return;
      cap.position.set(0, H / 2, z + 0.002);
      // inside the rounded end-bevels the cross-section is slightly smaller
      const e = Math.min(D / 2 - z, z + D / 2), inset = e < bevel ? bevel - Math.sqrt(Math.max(0, bevel * bevel - (bevel - e) ** 2)) : 0;
      cap.scale.set((W - 2 * inset) / W, (H - 2 * inset) / H, 1);
      coreGlow.position.set(0, H / 2, z + 0.05);
      coreLight.position.set(0.2, H / 2 + 0.1, z + 0.5);
      const d = z / (D / 2);
      depthHeat = Math.sqrt(Math.max(0.2, 1 - d * d));
      coreGlow.scale.setScalar(W * 0.8 * depthHeat);
    },
    /**
     * Phase-A kerfs: count = kerfs visible (the newest may be partial), n = total phase-A cuts of the round,
     * cutY = height above the table the newest kerf reaches down to (0 = cut through), flash = newest-kerf glow boost.
     */
    setKerf(count, n, cutY, flash, color) {
      kerfTotal = Math.max(1, n);
      kerf.uKerfN.value = n + 1;
      kerf.uKerfCount.value = count;
      kerf.uKerfW.value = 0.03 / Math.sqrt(kerfTotal);
      kerf.uKerfCutY.value = cutY;
      kerf.uKerfFlash.value = flash / Math.sqrt(kerfTotal) ** 0.5;
      if (color) kerf.uKerfColor.value.set(color);
    },
    setHeat(h, t) {
      const flick = 0.94 + 0.06 * Math.sin(t * 9) + 0.03 * Math.sin(t * 23);
      capMat.emissiveIntensity = (0.8 + 1.4 * h) * flick * (0.7 + 0.3 * depthHeat);
      coreGlow.material.opacity = (0.1 + 0.18 * h) * flick;
      coreLight.intensity = cap.visible ? (1.5 + 6 * h) * flick : 0;
      kerf.uKerfGlow.value = (2.6 / Math.sqrt(kerfTotal)) * flick;
      // fracture cores barely smoulder: slow breathing, independent of cutting
      if (shellMat) shellMat.emissiveIntensity = (0.7 + 0.5 * h) * (0.7 + 0.3 * Math.sin(t * 2.1)) * flick;
    },
    reset() {
      kerf.uKerfCount.value = 0; kerf.uKerfCutY.value = 0; kerf.uKerfFlash.value = 0; kerfTotal = 1;
      group.rotation.set(0, 0, 0);
      group.position.set(0, 0, 0);
      group.scale.set(1, 1, 1);
      capGroup.position.set(0, 0, 0);
      capGroup.scale.set(1, 1, 1);
      group.visible = true;
      this.setClip(CLIP_OFF);
    },
    hide() { group.visible = false; cap.visible = coreGlow.visible = false; coreLight.intensity = 0; },
  };
}

// ---- knife ------------------------------------------------------------------------------------
const GRIND = 0.115; // fraction of blade height taken by the cutting bevel (this band glows on hot tools)

/** Santoku profile. x: heel -> tip, edge on y = 0 (flat across the block), sheep's-foot spine dropping to the tip. */
function bladeProfile(BL, BH) {
  const x0 = -BL / 2, x1 = BL / 2, xs = x1 - 0.34, xb = x1 - 0.66, tipY = 0.075;
  const edge = (x) => (x <= xs ? 0 : tipY * Math.pow((x - xs) / (x1 - xs), 2.3));
  const spine = (x) => {
    if (x <= xb) return BH + 0.01 * (1 - (x - x0) / (xb - x0)); // spine very slightly rises toward the heel
    const t = (x - xb) / (x1 - xb);
    return BH - (BH - tipY) * Math.pow(1 - Math.sqrt(Math.max(0, 1 - t * t)), 0.8);
  };
  return { x0, x1, edge, spine };
}

/**
 * Blade as a parametric solid: flat hollow-free body + separate ground bevel patch (crisp grind line),
 * distal taper toward the tip, chamfered spine. UV: u along the blade, v edge (0) -> spine (1).
 */
function bladeGeometry(BL, BH, T) {
  const P = bladeProfile(BL, BH);
  const NU = 72;
  const us = Array.from({ length: NU + 1 }, (_, i) => i / NU);
  const half = (u, v) => {
    const taper = 1 - 0.6 * Math.max(0, (u - 0.45) / 0.55) ** 1.5;
    let h;
    if (v <= GRIND) h = 0.0007 + (0.4 * T - 0.0007) * (v / GRIND);
    else if (v < 0.86) h = 0.4 * T + 0.1 * T * ((v - GRIND) / (0.86 - GRIND));
    else h = 0.5 * T - 0.16 * T * ((v - 0.86) / 0.14) ** 2;
    return h * taper;
  };
  const pos = [], uv = [], idx = [];
  const pt = (u, v, side) => {
    const x = P.x0 + u * BL, e = P.edge(x), s = Math.max(e + 1e-4, P.spine(x));
    return [x, e + (s - e) * v, side * half(u, v)];
  };
  const patch = (vs, side) => {
    const base = pos.length / 3;
    for (const u of us) for (const v of vs) { pos.push(...pt(u, v, side)); uv.push(u, v); }
    const nv = vs.length;
    for (let i = 0; i < us.length - 1; i++) for (let j = 0; j < nv - 1; j++) {
      const a = base + i * nv + j, b = a + nv, c = a + 1, d = b + 1;
      if (side > 0) idx.push(a, b, c, c, b, d); else idx.push(a, c, b, c, d, b);
    }
  };
  const grindV = [0, 0.03, 0.065, 0.095, GRIND];
  const bodyV = [GRIND, 0.2, 0.35, 0.5, 0.65, 0.78, 0.86, 0.92, 0.97, 1];
  for (const side of [1, -1]) { patch(grindV, side); patch(bodyV, side); }
  // closures: spine strip, apex strip, heel cap
  const strip = (fn, n, flip) => {
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) { const [a, b, ua, va] = fn(i / n); pos.push(...a, ...b); uv.push(ua, va, ua, va); }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
  };
  strip((t) => { const u = us[Math.round(t * NU)]; return [pt(u, 1, 1), pt(u, 1, -1), u, 1]; }, NU, false);
  strip((t) => { const u = us[Math.round(t * NU)]; return [pt(u, 0, 1), pt(u, 0, -1), u, 0]; }, NU, true);
  const heelV = [...grindV, ...bodyV.slice(1)];
  strip((t) => { const v = heelV[Math.round(t * (heelV.length - 1))]; return [pt(0, v, 1), pt(0, v, -1), 0, v]; }, heelV.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, profile: P };
}

/** Additive glow strip hugging the (curved) cutting edge on both faces. */
function edgeStripGeometry(P, T, height) {
  const pos = [], uv = [], idx = [], N = 60;
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const x = P.x0 + (i / N) * (P.x1 - P.x0), e = P.edge(x), z = side * (0.42 * T + 0.002);
      pos.push(x, e - 0.004, z, x, e + height, z); uv.push(i / N, 1, i / N, 0); // canvas v=0 (top of gradient) is hottest
    }
    for (let i = 0; i < N; i++) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Octagonal prism/frustum along +X starting at x = 0 (flat-shaded), scaled oval in Z. */
function octa(len, r0, r1, zScale) {
  const g = new THREE.CylinderGeometry(r1, r0, len, 8, 1);
  g.rotateY(Math.PI / 8);
  g.rotateZ(-Math.PI / 2); // +Y -> +X  (r0 at x=0 side, r1 at far end)
  g.translate(len / 2, 0, 0);
  g.scale(1, 1, zScale);
  return g;
}

/**
 * Fixed-size Santoku (never scaled to the object): edge on y=0, blade along X, handle continues the spine line
 * toward -X with a 6–8° upward tilt. Tool look is applied through setTool().
 */
export async function createKnife(tools, accent) {
  const K = LAYOUT.knife;
  const BL = K.length, BH = K.height, T = K.thickness, th = (K.handleTiltDeg * Math.PI) / 180;
  const group = new THREE.Group();
  const { geo, profile: P } = bladeGeometry(BL, BH, T);

  const dam = makeDamascus(GRIND);
  const edgeMask = makeEdgeMask(GRIND * 0.95);
  const bladeMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: dam.map, roughnessMap: dam.rough, roughness: 1, bumpMap: dam.bump, bumpScale: 0.6,
    metalness: 0.95, envMapIntensity: 1.6, clearcoat: 0.3, clearcoatRoughness: 0.2,
    emissive: 0x000000, emissiveMap: edgeMask, emissiveIntensity: 0, side: THREE.DoubleSide,
  });
  const blade = new THREE.Mesh(geo, bladeMat);
  blade.castShadow = true;

  // Handle assembly along the tilted axis (from the heel, slightly below the spine line).
  const steel = new THREE.MeshStandardMaterial({ color: 0xb8bec8, metalness: 1, roughness: 0.22, envMapIntensity: 1.4, flatShading: true });
  const carbon = makeCarbon();
  carbon.map.repeat.set(3, 1);
  const gripMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: carbon.map, roughness: 0.4, metalness: 0.2, clearcoat: 0.6, clearcoatRoughness: 0.25, flatShading: true,
  });
  const handleGroup = new THREE.Group();
  const neckLen = 0.05, bolsterLen = 0.085, gripLen = 0.6, capLen = 0.03;
  const r = BH * 0.18;
  // neck: tapered steel transition (bevelled extrusion) from the blade heel into the bolster
  const neck = new THREE.Shape();
  neck.moveTo(0, -r * 1.25); neck.lineTo(neckLen, -r * 1.05); neck.lineTo(neckLen, r * 1.05); neck.lineTo(0, r * 1.35); neck.closePath();
  const neckGeo = new THREE.ExtrudeGeometry(neck, { depth: T * 0.9, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2 });
  neckGeo.translate(0, 0, -T * 0.45);
  const neckM = new THREE.Mesh(neckGeo, steel);
  const bolster = new THREE.Mesh(octa(bolsterLen, r * 1.18, r * 1.1, 0.78), steel);
  bolster.position.x = neckLen;
  const grip = new THREE.Mesh(octa(gripLen, r * 1.0, r * 1.12, 0.74), gripMat);
  grip.position.x = neckLen + bolsterLen;
  const butt = new THREE.Mesh(octa(capLen, r * 1.12, r * 0.95, 0.74), steel);
  butt.position.x = neckLen + bolsterLen + gripLen;
  handleGroup.add(neckM, bolster, grip, butt);
  handleGroup.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  // handle axis points toward -X, tilted up by th; anchored at the heel just below the spine
  const anchorY = P.spine(P.x0) - r * 1.25;
  handleGroup.position.set(P.x0 + 0.012, anchorY, 0);
  handleGroup.rotation.set(0, Math.PI, th); // local +X -> (-cos th, sin th): toward -X, tilted up
  const hLen = neckLen + bolsterLen + gripLen + capLen;
  group.add(blade, handleGroup);

  // Light additive edge glow (no post-processing bloom) — narrow band only.
  const edgeMat = new THREE.MeshBasicMaterial({
    map: makeEdgeGradient(2.6), color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0.5, side: THREE.DoubleSide,
  });
  const edgeGeo = edgeStripGeometry(P, T, BH * GRIND * 0.75);
  const edge = new THREE.Mesh(edgeGeo, edgeMat);
  edge.renderOrder = 5;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(), color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.4, toneMapped: false,
  }));
  halo.position.set(0, 0.015, 0.06);
  halo.renderOrder = 6;
  group.add(edge, halo);

  const light = new THREE.PointLight(0xffffff, 0, 1.15, 2); // short reach: lights the cut face, not the pile/table

  // Motion-blur ghosts (glowing edge only), positioned by the game from past poses.
  const ghosts = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(edgeGeo, new THREE.MeshBasicMaterial({ // edge streaks only: no translucent blade sheets
      map: edgeMat.map, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    }));
    m.visible = false; m.renderOrder = 4;
    ghosts.push(m);
  }

  let cur = tools[Object.keys(tools)[0]], hot = false;
  return {
    group, light, ghosts, bladeLength: BL,
    setTool(name) {
      const t = tools[name];
      if (!t) throw new Error(`Unknown tool "${name}"`);
      cur = t;
      hot = new THREE.Color(t.emissive).getHex() !== 0;
      // Dark polished damascus for every tool; steel is a shade lighter. Hot tools glow only on the ground bevel.
      bladeMat.color.set(hot ? 0x6f747d : 0xa9afb8);
      bladeMat.emissive.set(t.emissive);
      bladeMat.emissiveIntensity = hot ? Math.max(2.4, t.emissiveIntensity * 2.6) : 0;
      edgeMat.color.set(t.edge); halo.material.color.set(t.edge);
      light.color.set(t.light);
      ghosts.forEach((g, i) => { g.material.color.set(t.edge); g.visible = i < (t.ghosts ?? 0); });
    },
    /** boost: 0..1 flash right after a tool switch; t: seconds. */
    updateGlow(t, boost, contact) {
      const flick = 0.9 + 0.1 * Math.sin(t * 31) + 0.05 * Math.sin(t * 57);
      const g = cur.edgeGlow * (1 + boost * 1.5);
      edgeMat.opacity = clamp01((hot ? 0.55 : 0.18) * g * flick);
      halo.material.opacity = clamp01((0.12 + 0.25 * g) * flick * (0.45 + 0.55 * contact)) * (hot ? 1 : 0.5);
      halo.scale.setScalar(0.45 + 0.4 * g);
      light.intensity = cur.lightIntensity * flick * (0.4 + 0.6 * contact) * (1 + boost);
    },
    ghostOpacity: () => Math.min(0.6, (cur.ghostOpacity ?? 0.1) * 4),
    ghostCount: () => cur.ghosts ?? 0,
    topPoints: () => [ // knife silhouette extremes (local) for HUD-safety projection
      [P.x0 - Math.cos(th) * hLen, anchorY + Math.sin(th) * hLen + r * 1.2, 0],
      [P.x0, P.spine(P.x0), 0], [P.x1 - 0.66, BH, 0],
    ],
  };
}
