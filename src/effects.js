// Non-physical visual effects: crumb pyramid, glowing micro-particle stream, sweeper bar, gold-cube glow.
import * as THREE from 'three';
import { mulberry32, clamp01, smooth } from './util.js';
import { makeGlowTexture } from './textures.js';

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/** Procedurally growing mound of dark crumbs with glowing magma flecks (instanced, no physics). */
export function createPile({ count, pal, seed = 5, center = [0, 0, 1.55], radius = 0.78, height = 0.86 }) {
  const rnd = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const magmaCount = Math.round(count * 0.09), crumbCount = count - magmaCount;
  const crumbs = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3, flatShading: true }), crumbCount);
  const magmaMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const magma = new THREE.InstancedMesh(geo, magmaMat, magmaCount);
  crumbs.castShadow = crumbs.receiveShadow = true;
  crumbs.frustumCulled = magma.frustumCulled = false;
  const group = new THREE.Group();
  group.add(crumbs, magma);

  const items = [];
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const a = rnd() * 6.283, rho = Math.sqrt(rnd());
    const x = center[0] + Math.cos(a) * rho * radius, z = center[2] + Math.sin(a) * rho * radius * 0.95;
    const surf = height * (1 - rho);
    const y = surf * Math.pow(rnd(), 0.35) + 0.02;
    const isMagma = i >= crumbCount;
    const size = (isMagma ? 0.022 : 0.03) + rnd() * (isMagma ? 0.024 : 0.04);
    items.push({
      x, y, z, size, isMagma,
      sy: 0.7 + rnd() * 0.5, sz: 0.8 + rnd() * 0.5,
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6, rnd() * 6, rnd() * 6)),
      birth: clamp01(Math.max((y / height) * 0.85, rho * 0.55) + rnd() * 0.1),
    });
    const k = isMagma ? i - crumbCount : i;
    if (isMagma) magma.setColorAt(k, col.set(pal.magma).lerp(new THREE.Color('#ffd27a'), rnd() * 0.7));
    else crumbs.setColorAt(k, col.set(pal.crumb).multiplyScalar(0.55 + rnd() * 1.3));
  }
  const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const base = new THREE.Color(1, 1, 1);

  return {
    group,
    /** progress 0..1 of the pour, barX = sweeper position (null when idle). */
    update(progress, time, barX) {
      let ci = 0, mi = 0;
      for (const it of items) {
        const pop = smooth((progress - it.birth) / 0.05);
        const swept = barX !== null && it.x < barX + 0.1;
        const s = swept ? 0 : it.size * pop;
        m4.compose(p.set(it.x, it.y, it.z), it.q, sc.set(s, s * it.sy, s * it.sz));
        if (it.isMagma) magma.setMatrixAt(mi++, m4); else crumbs.setMatrixAt(ci++, m4);
      }
      crumbs.instanceMatrix.needsUpdate = magma.instanceMatrix.needsUpdate = true;
      if (crumbs.instanceColor) crumbs.instanceColor.needsUpdate = true;
      if (magma.instanceColor) magma.instanceColor.needsUpdate = true;
      magmaMat.color.copy(base).multiplyScalar(1.1 + 0.35 * Math.sin(time * 7));
      group.visible = progress > 0 && !(barX !== null && barX > 4);
    },
  };
}

/** Stateless (pure function of time) glowing micro-particles thrown from the cut toward the pile. */
export function createParticles({ count, pal, seed = 11 }) {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 3), colr = new Float32Array(count * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.07, map: makeGlowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  const life = Float32Array.from({ length: count }, () => 0.5 + rnd() * 0.55);
  const off = Float32Array.from({ length: count }, () => rnd());
  const tint = Array.from({ length: count }, () => rnd());
  const magma = new THREE.Color(pal.magma), hot = new THREE.Color('#ffd27a'), tool = new THREE.Color();
  const c = new THREE.Color();

  return {
    points: pts,
    /**
     * emitWindow: [t0, t1] during which particles are emitted; zAt(tEmit) -> knife z; intensity 0..1; toolColor: hex/string.
     */
    update(t, emitWindow, zAt, intensity, toolColor, topY) {
      tool.set(toolColor);
      for (let i = 0; i < count; i++) {
        const f = t / life[i] + off[i], k = Math.floor(f), tau = (f - k) * life[i];
        const tEmit = t - tau;
        const alive = i / count < intensity && tEmit >= emitWindow[0] && tEmit <= emitWindow[1];
        const seed = i * 17 + k * 131;
        const x = (hash(seed) - 0.5) * 1.3, vx = (hash(seed + 1) - 0.5) * 1.1;
        const vy = 1.4 + hash(seed + 2) * 1.9, vz = 1.1 + hash(seed + 3) * 1.3;
        const y = topY + 0.03 + vy * tau - 4.9 * tau * tau;
        if (!alive || y < 0.02) { pos[i * 3 + 1] = -20; continue; }
        pos[i * 3] = x + vx * tau;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = zAt(tEmit) + vz * tau;
        const fade = Math.pow(1 - tau / life[i], 0.6);
        c.copy(tint[i] < 0.55 ? magma : tint[i] < 0.8 ? hot : tool).multiplyScalar(fade * 1.4);
        colr[i * 3] = c.r; colr[i * 3 + 1] = c.g; colr[i * 3 + 2] = c.b;
      }
      geo.attributes.position.needsUpdate = geo.attributes.color.needsUpdate = true;
    },
  };
}

/** Thin wiper bar crossing the table to sweep everything away between rounds. */
export function createSweeper(pal) {
  const group = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 4.4), new THREE.MeshStandardMaterial({ color: 0x20232a, metalness: 0.8, roughness: 0.35 }));
  bar.position.y = 0.15;
  bar.castShadow = true;
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.012, 4.4), new THREE.MeshBasicMaterial({ color: pal.accent, toneMapped: false }));
  line.position.y = 0.012;
  group.add(bar, line);
  group.position.z = 0.4;
  group.visible = false;
  return {
    group,
    set(x) { group.visible = x !== null; if (x !== null) group.position.x = x; },
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
