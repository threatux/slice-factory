// Non-physical visual effects: growing gravel/dust cones, pour stream, cut sparks, sweeper bar (+ swept wave), gold-cube glow.
import * as THREE from 'three';
import { mulberry32, clamp01 } from './util.js';
import { makeGlowTexture, makeGravel, makeSand, makeGoldGravel, makeGoldDust } from './textures.js';

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const BAR_HALF = 0.03; // sweeper bar half thickness (x): front face = barX + BAR_HALF

/** Cone profile 0..1 (rounded apex, slightly concave angle-of-repose flanks), 0 beyond rho = 1. */
const coneF = (rho, a = 0.07) => Math.pow(clamp01(1 - (Math.sqrt(rho * rho + a * a) - a) / (Math.sqrt(1 + a * a) - a)), 1.18);
/** Dust heap profile: same flank, but the toe softly runs out into the table (softplus) instead of a hard circle. */
const dustF = (rho, a = 0.07) => {
  const c = (Math.sqrt(1 + a * a) - Math.sqrt(rho * rho + a * a)) / (Math.sqrt(1 + a * a) - a);
  const w = 0.055;
  return Math.pow(w * Math.log1p(Math.exp(c / w)), 1.16);
};

function coneGeometry(rings, segs, lump, seed) {
  const pos = [], uv = [], uv1 = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    const rho = (i / rings) ** 1.15;
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2, jj = j % segs;
      const n = lump ? (hash(seed + i * 913 + jj * 7) - 0.5) * lump * Math.sin(Math.PI * Math.min(1, rho * 1.1)) : 0;
      const r = Math.min(1.04, rho * (1 + n * 0.6));
      const y = coneF(rho) + n * 0.5 - (i === rings ? 0.012 : 0);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      pos.push(x, y, z); uv.push(x * 0.5 + 0.5, z * 0.5 + 0.5); uv1.push(j / segs, rho);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = i * (segs + 1) + j, b = a + segs + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const RHO_MAX = 1.4;
/** Organic dust heap: non-circular footprint, soft toe, vertex alpha fading the outer skirt into the table (alpha-hashed). */
function dustGeometry(rings, segs, seed) {
  const rnd = mulberry32(seed);
  const harm = [2, 3, 5, 7].map((k) => ({ k, p: rnd() * 6.283, a: (0.5 + rnd() * 0.5) / k }));
  const angN = (a) => harm.reduce((s, h) => s + h.a * Math.sin(h.k * a + h.p), 0);
  const pos = [], uv = [], col = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    const rho = RHO_MAX * (i / rings) ** 1.1;
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const lobe = 1 + 0.09 * angN(a) * clamp01((rho - 0.3) / 0.8);
      const r = rho * lobe;
      const y = dustF(rho) * (1 + 0.02 * (hash(seed + i * 31 + (j % segs) * 7) - 0.5) * clamp01(rho));
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      pos.push(x, y, z); uv.push(x * 0.5 + 0.5, z * 0.5 + 0.5);
      const t = clamp01((rho - 0.98) / (RHO_MAX - 0.98));
      col.push(1, 1, 1, 1 - t * t * (3 - 2 * t));
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = i * (segs + 1) + j, b = a + segs + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, lobe: (a) => 1 + 0.09 * angN(a) };
}

/** Points with per-particle size/colour/alpha (screen-size attenuated). */
function pointCloud(count, blending, map, pxScale) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 4), size = new Float32Array(count);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uScale: { value: pxScale } },
    vertexShader: `attribute vec4 aColor; attribute float aSize; varying vec4 vC; uniform float uScale;
      void main() { vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = max(1.0, aSize * uScale / -mv.z); if (aColor.a <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }`,
    fragmentShader: `uniform sampler2D uMap; varying vec4 vC;
      void main() { float a = texture2D(uMap, gl_PointCoord).a * vC.a; if (a < 0.01) discard; gl_FragColor = vec4(vC.rgb, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 3;
  const dirty = () => { geo.attributes.position.needsUpdate = geo.attributes.aColor.needsUpdate = geo.attributes.aSize.needsUpdate = true; };
  return { pts, pos, col, size, geo, dirty };
}

/**
 * Growing cone of crushed obsidian. kind "gravel": lumpy cone + chunky stones + rare embers (R4);
 * kind "sand": organic heap of fine glittering obsidian dust with a soft toe, scattered micro-grains around the base and
 * hundreds of tiny smouldering magma specks in its lower/middle part (R5). Lit warm by its own glow + a clean white top rim.
 * Volume ∝ progress, so scale ∝ progress^(1/3). The sweeper erases it with a clip plane (x >= bar front).
 */
export function createPile({ pal, kind = 'gravel', look = 'obsidian', center = [0.3, 0, 1.3], radius = 0.62, height = 0.72, chunks = 500, seed = 5, pxScale = 1000 }) {
  const G = look === 'gold-emerald'; // gold shavings (R4) / gold micro-dust with emerald specks (R5)
  const group = new THREE.Group();
  group.position.set(center[0], center[1], center[2]);
  const body = new THREE.Group();
  body.scale.set(radius, height, radius);
  group.add(body);
  const sweepPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 100); // keeps x >= -constant
  const clipped = [];
  let mat, emissiveMat = null, warm = null, warm2 = null, rimTop = null, specks = null, grainEmbers = null, lobe = () => 1;
  const profile = kind === 'sand' ? dustF : coneF;

  if (kind === 'sand') {
    const t = G ? makeGoldDust(pal) : makeSand();
    for (const m of [t.map, t.roughness, t.normalMap]) m.repeat.set(10, 10);
    mat = new THREE.MeshStandardMaterial({
      color: G ? new THREE.Color(0.55, 0.42, 0.18) : new THREE.Color(1.25, 1.25, 1.3), map: t.map, roughnessMap: t.roughness, roughness: 1, metalness: G ? 0.85 : 0.12,
      normalMap: t.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), envMapIntensity: 1.3, vertexColors: true, alphaHash: true,
    });
    const dg = dustGeometry(110, 220, seed);
    lobe = dg.lobe;
    const cone = new THREE.Mesh(dg.geo, mat);
    cone.castShadow = cone.receiveShadow = true;
    body.add(cone);
    clipped.push(mat);

    // micro-grains scattered around the toe (group space, isotropic), denser close to the heap
    const rnd = mulberry32(seed + 7), NG = 1100, NE = G ? 1100 : 90;
    const ggeo = new THREE.IcosahedronGeometry(1, 0);
    const gmat = new THREE.MeshPhysicalMaterial({ color: G ? 0xd9a82a : 0x34343c, roughness: G ? 0.3 : 0.25, metalness: G ? 0.9 : 0.1, clearcoat: G ? 0.2 : 1, clearcoatRoughness: 0.05, flatShading: true });
    const emat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const grains = new THREE.InstancedMesh(ggeo, gmat, NG);
    grainEmbers = new THREE.InstancedMesh(ggeo, emat, NE);
    grains.receiveShadow = true;
    const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
    const hot = new THREE.Color(G ? '#b9ffdf' : '#ffc46a'), magma = new THREE.Color(pal.magma); // gold: emerald crumbs glow toward mint
    for (let i = 0; i < NG + NE; i++) {
      const a = rnd() * Math.PI * 2, rho = 0.94 + Math.min(0.55, -Math.log(1 - rnd() * 0.97) * 0.15);
      const r = rho * lobe(a) * radius, s = (i < NG ? 0.0035 + rnd() * 0.0075 : G ? 0.005 + rnd() * 0.006 : 0.0025 + rnd() * 0.003);
      const y = profile(rho) * height + s * 0.4;
      qq.setFromEuler(e.set(rnd() * 6, rnd() * 6, rnd() * 6));
      m4.compose(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r), qq, new THREE.Vector3(s, s * (0.6 + rnd() * 0.5), s));
      if (i < NG) { grains.setMatrixAt(i, m4); grains.setColorAt(i, c.setScalar(0.6 + rnd() * 0.8)); }
      else { grainEmbers.setMatrixAt(i - NG, m4); grainEmbers.setColorAt(i - NG, c.copy(magma).lerp(hot, rnd() * 0.7)); }
    }
    group.add(grains, grainEmbers);
    clipped.push(gmat, emat);

    // surface sparkle: smouldering magma specks mixed into the lower & middle part + cold glints of glass dust, twinkling
    const NS = G ? 3000 : 760, glint = new THREE.Color(G ? '#fff0b8' : '#e8f0ff');
    specks = pointCloud(NS, THREE.AdditiveBlending, makeGlowTexture(), pxScale);
    specks.data = Array.from({ length: NS }, (_, i) => {
      const ember = i < NS * (G ? 0.6 : 0.6);
      const a = rnd() * Math.PI * 2, rho = ember ? 0.3 + 0.75 * Math.sqrt(rnd()) : 0.05 + 0.9 * Math.sqrt(rnd());
      const r = rho * lobe(a) * radius, y = profile(rho) * height + 0.005;
      const col = ember ? new THREE.Color(pal.magma).lerp(hot, rnd() * 0.8).multiplyScalar(G ? 1.6 + rnd() * 1.2 : 1.1 + rnd() * 0.9) : glint.clone().multiplyScalar(G ? 1.0 + rnd() * 0.9 : 0.7 + rnd() * 0.6);
      return { x: Math.cos(a) * r, y, z: Math.sin(a) * r, col, size: ember ? (G ? 0.016 + rnd() * 0.016 : 0.011 + rnd() * 0.013) : 0.008 + rnd() * 0.01, w: ember ? 1.5 + rnd() * 4 : (G ? 8 + rnd() * 22 : 6 + rnd() * 14), p: rnd() * 6.28, ember };
    });
    specks.data.forEach((d, i) => { specks.pos.set([d.x, d.y, d.z], i * 3); specks.size[i] = d.size; });
    group.add(specks.pts);

    // warm glow from the dust itself (low, front) + clean white lab rim from above/behind
    warm = new THREE.PointLight(G ? '#ffc94d' : pal.magma, 0, 1.3, 2); // diffuse warmth from inside the toe, no hot spot
    warm.position.set(radius * 0.15, 0.22, radius * 0.35);
    if (G) { // gold dust: second, emerald light from below-behind (gold/emerald under-glow)
      warm2 = new THREE.PointLight('#00e676', 0, 1.3, 2);
      warm2.position.set(-radius * 0.2, 0.16, radius * 0.1);
      group.add(warm2);
    }
    rimTop = new THREE.SpotLight(0xf3f6ff, 0, 7, 0.5, 0.65, 1.6);
    rimTop.position.set(-0.6, 2.9, -1.5);
    rimTop.target.position.set(0, height * 0.4, 0);
    group.add(warm, rimTop, rimTop.target);
  } else {
    const t = G ? makeGoldGravel(pal) : makeGravel(pal);
    for (const m of [t.map, t.roughness, t.normalMap, t.emissive, t.metal]) m?.repeat.set(2.2, 2.2);
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: t.map, roughnessMap: t.roughness, roughness: 1, metalness: G ? 1 : 0.2, metalnessMap: t.metal ?? null, normalMap: t.normalMap,
      normalScale: new THREE.Vector2(1.6, 1.6), emissive: 0xffffff, emissiveMap: t.emissive, emissiveIntensity: 1.3, flatShading: true,
    });
    emissiveMat = mat;
    const cone = new THREE.Mesh(coneGeometry(26, 64, 0.09, seed), mat);
    cone.castShadow = cone.receiveShadow = true;
    body.add(cone);
    clipped.push(mat);
  }

  // surface stones (gravel only): unit-cone coordinates, so they stay glued to the surface while the cone scales
  let emberMat = null;
  if (kind === 'gravel' && chunks > 0) {
    const rnd = mulberry32(seed + 1);
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const nE = Math.round(chunks * (G ? 0.2 : 0.06)), nS = chunks - nE;
    const smat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: G ? 0.28 : 0.3, metalness: G ? 0.92 : 0.15, clearcoat: G ? 0.2 : 0.7, flatShading: true });
    const stones = new THREE.InstancedMesh(geo, smat, nS);
    emberMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const embers = new THREE.InstancedMesh(geo, emberMat, nE);
    stones.castShadow = stones.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), col = new THREE.Color();
    for (let i = 0; i < chunks; i++) {
      const a = rnd() * Math.PI * 2, rho = Math.sqrt(rnd()) * 0.97;
      const isE = i >= nS, s = (isE ? 0.012 : 0.016) + rnd() * (isE ? 0.012 : 0.03);
      const x = Math.cos(a) * rho, z = Math.sin(a) * rho, y = coneF(rho) - 0.004;
      // stones live in body space (non-uniform scale), so pre-compensate to keep them roughly isotropic
      q.setFromEuler(e.set(rnd() * 6, rnd() * 6, rnd() * 6));
      m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s / radius, (s / height) * (0.6 + rnd() * 0.5), s / radius));
      if (isE) { embers.setMatrixAt(i - nS, m4); embers.setColorAt(i - nS, G ? col.set('#00e676').lerp(new THREE.Color('#b9ffdf'), rnd() * 0.55) : col.set(pal.magma).lerp(new THREE.Color('#ffd27a'), rnd() * 0.6)); }
      else { stones.setMatrixAt(i, m4); stones.setColorAt(i, G ? col.set(pal.shell).multiplyScalar(0.55 + rnd() * 0.7) : col.set(pal.crumb).multiplyScalar(0.5 + rnd() * 1.4)); }
    }
    body.add(stones, embers);
    clipped.push(smat, emberMat);
  }
  for (const m of clipped) { m.clippingPlanes = [sweepPlane]; m.clipShadows = true; }
  group.visible = false;
  let scale = 0;

  return {
    group, kind,
    /** progress 0..1 of the pour, barX = sweeper position (null when idle). */
    update(progress, time, barX) {
      const s = progress > 0 ? Math.cbrt(progress) : 0;
      scale = s;
      const front = barX === null ? -100 : barX + BAR_HALF;
      sweepPlane.constant = -front;
      group.visible = s > 0 && front < center[0] + radius * s * RHO_MAX * 1.2;
      if (!group.visible) return;
      group.scale.setScalar(s);
      const f = 0.9 + 0.1 * Math.sin(time * 6) + 0.05 * Math.sin(time * 17);
      if (emissiveMat) emissiveMat.emissiveIntensity = 1.2 * f;
      if (emberMat) emberMat.color.setScalar(1.1 + 0.35 * Math.sin(time * 7));
      if (warm) {
        const p = clamp01(progress), left = clamp01((center[0] + radius * s - front) / (2 * radius * Math.max(s, 1e-3)));
        warm.intensity = (G ? 0.6 : 0.8) * p * f * left;
        if (warm2) warm2.intensity = 2.6 * p * f * left;
        rimTop.intensity = (G ? 8 : 26) * p * left;
        grainEmbers.material.color.setScalar(1.0 + 0.4 * Math.sin(time * 5.3));
        specks.data.forEach((d, i) => {
          const tw = 0.55 + 0.45 * Math.sin(time * d.w + d.p);
          const gone = center[0] + d.x * s < front;
          specks.col.set([d.col.r, d.col.g, d.col.b, gone ? 0 : (d.ember ? 0.9 * tw : tw ** (G ? 4 : 6)) * clamp01(p * 3)], i * 4);
        });
        specks.dirty();
      }
    },
    /** world-space apex height for a given progress (stream target). */
    apex(progress) { return height * (progress > 0 ? Math.cbrt(progress) : 0); },
    /** current heap surface height (world) at world (x, z); 0 outside the footprint. */
    surfaceY(x, z) {
      if (scale <= 0) return 0;
      const dx = (x - center[0]) / (radius * scale), dz = (z - center[2]) / (radius * scale);
      const rho = Math.hypot(dx, dz) / lobe(Math.atan2(dz, dx));
      return rho > RHO_MAX ? 0 : height * scale * profile(rho);
    },
    get scale() { return scale; },
    center, radius, height,
  };
}

/**
 * Stateless (pure function of time) pour stream: grains leave the contact line of the knife edge and the cut face
 * and fly ballistically onto the growing cone apex. "gravel": chunky dark grit + embers; "sand": dense silky micro-dust.
 */
export function createStream({ count, pal, pxScale, seed = 11 }) {
  const rnd = mulberry32(seed);
  const dark = pointCloud(count, THREE.NormalBlending, makeGlowTexture(), pxScale);
  const glow = pointCloud(count, THREE.AdditiveBlending, makeGlowTexture(), pxScale);
  const group = new THREE.Group();
  group.add(dark.pts, glow.pts);
  const life = Float32Array.from({ length: count }, () => 0.32 + rnd() * 0.3);
  const off = Float32Array.from({ length: count }, () => rnd());
  const pg = pal.pourGlow ?? [pal.magma, '#ffd27a', '#fff2dc'];
  const magma = new THREE.Color(pg[0]), hot = new THREE.Color(pg[1]), white = new THREE.Color(pg[2]), crumb = new THREE.Color(pal.crumb), c = new THREE.Color();
  const G = 7.5;
  const hide = (cl, i) => { cl.col[i * 4 + 3] = 0; };

  return {
    group,
    /**
     * opts: { kind, emit:[t0,t1], zAt(t) = cut plane, hAt(t) = knife edge height, faceScale(t), size:[W,H], pile, progressAt(t), density 0..1 }
     */
    update(t, o) {
      const sand = o.kind === 'sand';
      const [W] = o.size;
      const nAct = Math.floor(count * o.density);
      for (let i = 0; i < count; i++) {
        const L = life[i] * (sand ? 1.15 : 1);
        const f = t / L + off[i], k = Math.floor(f), tau = (f - k) * L, tEmit = t - tau;
        if (i >= nAct || tEmit < o.emit[0] || tEmit > o.emit[1]) { hide(dark, i); hide(glow, i); continue; }
        const sd = i * 17 + k * 131;
        const fs = o.faceScale(tEmit);
        // emission point: on the contact line between the knife edge and the cut face, just in front of the blade
        const x0 = (hash(sd) - 0.5) * W * 0.96 * fs;
        const y0 = Math.max(0.015, o.hAt(tEmit)) + hash(sd + 1) * 0.035;
        const z0 = o.zAt(tEmit) + 0.01;
        // landing point: around the apex of the cone at landing time
        const prog = o.progressAt(tEmit + L), apexY = o.pile.apex(Math.max(prog, 0.02));
        const ang = hash(sd + 2) * 6.283, rr = Math.sqrt(hash(sd + 3)) * o.pile.radius * Math.cbrt(Math.max(prog, 0.02)) * (sand ? 0.25 : 0.4);
        const tx = o.pile.center[0] + Math.cos(ang) * rr, tz = o.pile.center[2] + Math.sin(ang) * rr;
        const ty = Math.max(0.01, apexY * (1 - rr / (o.pile.radius * Math.cbrt(Math.max(prog, 0.02)) + 1e-6)));
        const vx = (tx - x0) / L, vz = (tz - z0) / L, vy = (ty - y0 + 0.5 * G * L * L) / L;
        const u = tau / L;
        const px = x0 + vx * tau, py = y0 + vy * tau - 0.5 * G * tau * tau, pz = z0 + vz * tau;
        const fadeIn = clamp01(u / 0.08), fadeOut = clamp01((1 - u) / 0.12);
        const r = hash(sd + 4);
        const isGlow = sand ? r < 0.55 : r < 0.22;
        const cl = isGlow ? glow : dark, other = isGlow ? dark : glow;
        hide(other, i);
        cl.pos[i * 3] = px; cl.pos[i * 3 + 1] = py; cl.pos[i * 3 + 2] = pz;
        if (sand) {
          if (isGlow) { c.copy(r < 0.12 ? white : r < 0.3 ? hot : magma).multiplyScalar(0.85); cl.col[i * 4 + 3] = 0.5 * fadeIn * fadeOut; }
          else { c.copy(crumb).multiplyScalar(2.2); cl.col[i * 4 + 3] = 0.8 * fadeIn * fadeOut; }
          cl.size[i] = 0.011 + hash(sd + 5) * 0.011;
        } else if (isGlow) {
          c.copy(r < 0.1 ? hot : magma).multiplyScalar(1.2);
          cl.size[i] = 0.022 + hash(sd + 5) * 0.02;
          cl.col[i * 4 + 3] = 0.9 * fadeIn * fadeOut;
        } else {
          c.copy(crumb).multiplyScalar(1.6 + hash(sd + 6) * 1.6);
          cl.size[i] = 0.03 + hash(sd + 5) * 0.035;
          cl.col[i * 4 + 3] = 0.95 * fadeIn * fadeOut;
        }
        cl.col[i * 4] = c.r; cl.col[i * 4 + 1] = c.g; cl.col[i * 4 + 2] = c.b;
      }
      dark.dirty(); glow.dirty();
    },
    setVisible(v) { group.visible = v; },
  };
}

/** Short bursts of burning sparks + tiny dark chips at blade/stone contact points (deterministic: driven by the hit list). */
export function createSparks({ pal, pxScale, max = 120 }) {
  const per = 8, n = max * per;
  const glow = pointCloud(n, THREE.AdditiveBlending, makeGlowTexture(), pxScale);
  const chips = pointCloud(n, THREE.NormalBlending, makeGlowTexture(), pxScale);
  const group = new THREE.Group();
  group.add(glow.pts, chips.pts);
  const hits = [];
  const sc = pal.sparkColors ?? [pal.magma, '#ffd27a']; // recipe-driven spark palette (obsidian: orange/gold)
  const c = new THREE.Color(), crumb = new THREE.Color(pal.crumb), magma = new THREE.Color(sc[0]), hot = new THREE.Color(sc[1]);
  const LIFE = 0.4, G = 9;
  return {
    group,
    /** z: cut plane, xr: [x0, x1] extent of the contact, y: contact height, count 1..8, color: tool edge colour */
    hit(t, z, xr, y, count, color) {
      hits.push({ t, z, xr, y, count: Math.min(per, count), color: new THREE.Color(color), seed: hits.length * 7919 + 13 + Math.round(t * 977) });
      if (hits.length > max) hits.shift();
    },
    clear() { hits.length = 0; },
    update(t) {
      let w = 0;
      for (const h of hits) {
        const tau = t - h.t;
        if (tau < 0 || tau > LIFE) continue;
        for (let j = 0; j < per; j++, w++) {
          if (w >= n) break;
          const sd = h.seed + j * 31;
          if (j >= h.count) { glow.col[w * 4 + 3] = 0; chips.col[w * 4 + 3] = 0; continue; }
          const x0 = h.xr[0] + hash(sd) * (h.xr[1] - h.xr[0]);
          const vx = (hash(sd + 1) - 0.5) * 1.4, vy = 0.6 + hash(sd + 2) * 1.5, vz = 0.35 + hash(sd + 3) * 0.9;
          const y = h.y + 0.008 + vy * tau - 0.5 * G * tau * tau;
          const isChip = hash(sd + 4) < 0.35;
          const A = isChip ? chips : glow, B = isChip ? glow : chips;
          B.col[w * 4 + 3] = 0;
          if (y < 0.005) { A.col[w * 4 + 3] = 0; continue; }
          A.pos[w * 3] = x0 + vx * tau; A.pos[w * 3 + 1] = y; A.pos[w * 3 + 2] = h.z + 0.02 + vz * tau;
          const fade = 1 - tau / LIFE;
          if (isChip) { c.copy(crumb).multiplyScalar(2.4); A.size[w] = 0.012 + hash(sd + 5) * 0.01; A.col[w * 4 + 3] = 0.95 * Math.min(1, fade * 3); }
          else { c.copy(hash(sd + 6) < 0.4 ? h.color : hash(sd + 7) < 0.5 ? magma : hot).multiplyScalar(1.4); A.size[w] = 0.008 + hash(sd + 5) * 0.009; A.col[w * 4 + 3] = fade * fade; }
          A.col[w * 4] = c.r; A.col[w * 4 + 1] = c.g; A.col[w * 4 + 2] = c.b;
        }
      }
      for (; w < n; w++) { glow.col[w * 4 + 3] = 0; chips.col[w * 4 + 3] = 0; }
      glow.dirty(); chips.dirty();
    },
  };
}

/**
 * Wiper bar crossing the table between rounds (taller than any heap, so the clip plane on the heap is always hidden by it)
 * plus the wave of swept material rolling along its front face: particles are sampled inside the heap volume and join
 * the wave once the bar front passes their x (pure function of bar position/time).
 */
export function createSweeper(pal, pxScale = 1000) {
  const group = new THREE.Group();
  const barH = 0.86;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(BAR_HALF * 2, barH, 4.4), new THREE.MeshStandardMaterial({ color: 0x20232a, metalness: 0.8, roughness: 0.35 }));
  bar.position.y = barH / 2;
  bar.castShadow = true;
  const line = new THREE.Mesh(new THREE.BoxGeometry(BAR_HALF * 2 + 0.015, 0.012, 4.4), new THREE.MeshBasicMaterial({ color: pal.accent, toneMapped: false }));
  line.position.y = 0.012;
  const lip = new THREE.Mesh(new THREE.BoxGeometry(BAR_HALF * 2 + 0.015, 0.01, 4.4), new THREE.MeshBasicMaterial({ color: pal.accent, toneMapped: false }));
  lip.position.y = barH - 0.005;
  group.add(bar, line, lip);
  group.position.z = 0.4;
  group.visible = false;

  const NW = 1600;
  const rnd = mulberry32(71);
  const pts = Array.from({ length: NW }, () => ({ a: rnd() * Math.PI * 2, rho: Math.sqrt(rnd()), h: rnd(), j: rnd(), k: rnd(), g: rnd() }));
  const glowTex = makeGlowTexture();
  const dark = pointCloud(NW, THREE.NormalBlending, glowTex, pxScale);
  const glow = pointCloud(NW, THREE.AdditiveBlending, glowTex, pxScale);
  const wave = new THREE.Group();
  wave.add(dark.pts, glow.pts);
  wave.visible = false;
  const pg = pal.pourGlow ?? [pal.magma, '#ffd27a'];
  const crumb = new THREE.Color(pal.crumb), magma = new THREE.Color(pg[0]), hot = new THREE.Color(pg[1]);

  return {
    group, wave,
    /** x: bar centre (null = idle); heap: { pile, kind, t } for pour rounds (wave of swept material), else null. */
    set(x, heap = null) {
      group.visible = x !== null;
      if (x !== null) group.position.x = x;
      const pile = heap?.pile;
      wave.visible = !!(x !== null && pile && pile.scale > 0);
      if (!wave.visible) return;
      const front = x + BAR_HALF, s = pile.scale, R = pile.radius * s, Hh = pile.height * s, [cx, , cz] = pile.center;
      const sand = heap.kind === 'sand', t = heap.t;
      let taken = 0;
      for (const p of pts) if (cx + Math.cos(p.a) * p.rho * R < front) taken++;
      const amt = Math.sqrt(taken / NW);
      for (let i = 0; i < NW; i++) {
        const p = pts[i];
        const xi = cx + Math.cos(p.a) * p.rho * R, zi = cz + Math.sin(p.a) * p.rho * R;
        const isGlow = p.g < (sand ? 0.3 : 0.18);
        const A = isGlow ? glow : dark, B = isGlow ? dark : glow;
        B.col[i * 4 + 3] = 0;
        if (xi >= front) { A.col[i * 4 + 3] = 0; continue; }
        // the crest rides on the (not yet swept) heap surface right at the bar front, so it is never buried inside the heap
        const pushed = clamp01((front - xi) / (2.2 * R + 1e-4));
        const colH = Hh * (sand ? 1 : 0.9) * Math.max(0.05, 1 - p.rho * p.rho);
        const px = front + 0.012 + p.j * (0.03 + 0.14 * amt) * (1 - 0.4 * pushed);
        const pz = zi + (p.k - 0.5) * 0.06 * pushed;
        const tumble = 0.025 * Math.abs(Math.sin(t * (14 + 10 * p.k) + i));
        const ground = pile.surfaceY(px, pz);
        const py = ground + 0.006 + p.h * (0.05 + colH * 0.45 * amt) * (1 - 0.55 * pushed) + tumble * (1 - pushed * 0.5);
        A.pos[i * 3] = px; A.pos[i * 3 + 1] = py; A.pos[i * 3 + 2] = pz;
        let c;
        if (isGlow) { c = (p.k < 0.3 ? hot : magma); A.size[i] = sand ? 0.008 + p.j * 0.008 : 0.014 + p.j * 0.012; A.col[i * 4 + 3] = 0.85; }
        else { c = crumb; A.size[i] = sand ? 0.012 + p.k * 0.01 : 0.026 + p.k * 0.03; A.col[i * 4 + 3] = 0.95; }
        const m = isGlow ? 1.3 : (sand ? 2.6 : 2.4 + p.h * 1.6);
        A.col[i * 4] = c.r * m; A.col[i * 4 + 1] = c.g * m; A.col[i * 4 + 2] = c.b * m;
      }
      dark.dirty(); glow.dirty();
    },
  };
}

/** Additive halo that follows the gold easter-egg cube. */
export function createGoldGlow(pal) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(), color: pal.gold, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55, toneMapped: false,
  }));
  s.scale.setScalar(0.8);
  s.visible = false;
  return s;
}
