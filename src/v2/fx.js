// v2 particles. Everything is a pure function of time (records generated once from the timeline), so any frame can be
// reproduced exactly and the finale can be played backwards:
//  - sparks: cyan/white additive sparks sprayed along the cut plane while a blade edge is inside the ingot;
//  - crumbs: gold chips falling off the levitating ingot onto the table (hook, R3+ drizzle, R6 golden rain);
//  - dust: R6 avalanche of metallic powder (radial wave over the table) + its easeInCubic vortex rewind into the ingot;
//  - shock ring: flat additive ring on the table at heavy impacts.
import * as THREE from 'three';
import { pointCloud } from '../effects.js';
import { makeGlowTexture, makeGrainTexture } from '../textures.js';
import { clamp01 } from '../util.js';

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const easeOutCubic = (u) => 1 - Math.pow(1 - clamp01(u), 3);
const easeInCubic = (u) => u * u * u;
const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export function createFx({ recipe, profile, scene, tl }) {
  const pal = recipe.palette;
  const [W, H, D] = tl.size;
  const half = tl.half;
  const v3 = new THREE.Vector3(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const toWorld = (local, t) => { const P = tl.ingotPose(t); q.setFromAxisAngle(up, P.yaw); return v3.set(...local).applyQuaternion(q).add(new THREE.Vector3(0, P.y, 0)).toArray(); };
  const rotV = (v, t) => { q.setFromAxisAngle(up, tl.ingotPose(t).yaw); return v3.set(...v).applyQuaternion(q).toArray(); };

  // ---------------- records ----------------
  const sparks = [], crumbs = [];
  let seed = 1;
  const rnd = () => hash(seed++ * 0.6180339);
  /** Point on the blade edge line inside the ingot (local), biased to the faces where sparks are visible. */
  const edgePoint = (P, c, r) => {
    const s = rnd() < 0.7 ? 1 : rnd() * 2 - 1; // 70% on the camera-facing surface
    if (P.axis === 0) return { p: [c, half[1] - r * 2 * half[1], s * half[2]], n: [0, 0, Math.sign(s) || 1], dir: [0, -1, 0] };
    if (P.axis === 2) { const x = (rnd() < 0.6 ? 1 : rnd() * 2 - 1) * half[0]; return { p: [x, half[1] - r * 2 * half[1], c], n: [Math.sign(x) * 0.8, 0, 0.6], dir: [0, -1, 0] }; }
    if (P.axis === 1) return { p: [(rnd() * 2 - 1) * half[0], c, half[2] - r * 2 * half[2]], n: [1, 0, 0], dir: [0, 0, -1] };
    return { p: [(rnd() * 2 - 1) * half[0], half[1] - r * 2 * half[1], half[2]], n: [0, 0, 1], dir: [0, -1, 0] };
  };
  let inHook = false; // teaser particles are wiped by the whip-zoom so R1 starts on a perfectly clean table
  const emitPass = (P, perBlade, crumbN) => {
    const planes = P.planes.length ? P.planes : [0];
    for (const c of planes) for (let k = 0; k < perBlade; k++) {
      const tb = P.t0 + P.dur * (0.15 + 0.7 * rnd());
      const r = tl.passReveal(P, tb);
      if (r <= 0 || r >= 1) continue;
      const E = edgePoint(P, P.axis === 3 ? (rnd() - 0.5) * W : c, r);
      const sp = 1.2 + 2.6 * rnd();
      const v = [
        E.dir[0] * sp * 0.8 + E.n[0] * sp * 0.7 + (rnd() - 0.5) * 1.6,
        E.dir[1] * sp * 0.8 + E.n[1] * sp + 0.6 + rnd() * 1.4,
        E.dir[2] * sp * 0.8 + E.n[2] * sp * 0.7 + (rnd() - 0.5) * 1.2,
      ];
      sparks.push({ tb, p: toWorld(E.p, tb), v: rotV(v, tb), life: 0.28 + 0.3 * rnd(), size: 0.012 + 0.014 * rnd(), hot: rnd(), hook: inHook });
    }
    for (let k = 0; k < crumbN; k++) {
      const tb = P.t0 + P.dur * (0.3 + 0.7 * rnd());
      const E = edgePoint(P, P.planes[Math.floor(rnd() * planes.length)] ?? 0, 0.5 + 0.5 * rnd());
      crumbs.push({ tb, p: toWorld([E.p[0], -half[1] + 0.02, E.p[2]], tb), v: rotV([(rnd() - 0.5) * 1.2, -0.3 * rnd(), (rnd() - 0.2) * 1.1], tb), life: 2.2 + rnd(), size: 0.02 + 0.025 * rnd(), tint: rnd(), hook: inHook });
    }
  };
  // hook fans: dense sparks + first gold crumbs
  const hookCrumb = Math.round((tl.hook.crumbs ?? 90) / tl.hook.passes.length);
  inHook = true;
  tl.hook.passes.forEach((P) => emitPass(P, 14, hookCrumb));
  inHook = false;
  tl.rounds.forEach((R) => {
    const drizzle = Math.round(R.drizzle / Math.max(1, R.passes.length));
    R.passes.forEach((P) => emitPass(P, P.fan ? 9 : 40, drizzle));
    if (R.rain) { // golden rain of micro sparks/crumbs streaming off the hyper-cut ingot
      const [a, b, n] = R.rain;
      for (let k = 0; k < n; k++) {
        const tb = a + (b - a) * rnd();
        const lp = [(rnd() * 2 - 1) * half[0] * 0.95, -half[1] + 0.01, (rnd() * 2 - 1) * half[2] * 0.95];
        if (k % 3 === 0) sparks.push({ tb, p: toWorld(lp, tb), v: [(rnd() - 0.5) * 0.6, -0.4 - rnd(), (rnd() - 0.5) * 0.6], life: 0.5 + 0.4 * rnd(), size: 0.01 + 0.01 * rnd(), hot: 0.3 + 0.7 * rnd(), gold: true });
        else crumbs.push({ tb, p: toWorld(lp, tb), v: [(rnd() - 0.5) * 0.5, -0.2 * rnd(), (rnd() - 0.5) * 0.5], life: Math.max(0.6, R.dropStart + 0.25 - tb), size: 0.012 + 0.016 * rnd(), tint: rnd() });
      }
    }
  });

  // ---------------- buffers ----------------
  const pxScale = profile.height / (2 * Math.tan(THREE.MathUtils.degToRad(30)));
  const glow = pointCloud(sparks.length, THREE.AdditiveBlending, makeGlowTexture(), pxScale);
  const chips = pointCloud(crumbs.length, THREE.NormalBlending, makeGrainTexture(), pxScale);
  scene.add(glow.pts, chips.pts);
  const [sc0, sc1] = (pal.sparkColors ?? ['#38e8ff', '#e0fcff']).map((c) => new THREE.Color(c));
  const goldC = new THREE.Color(pal.shell), goldHi = new THREE.Color('#ffe9a8'), crumbC = new THREE.Color(pal.crumb);
  const col = new THREE.Color();
  const GS = 7, GC = tl.G * 0.45;

  // ---------------- R6 dust avalanche ----------------
  const R6 = tl.rounds.find((r) => r.dust);
  const fin = recipe.v2.finale;
  const ND = R6 ? profile.dustPoints ?? 10000 : 0;
  const dust = ND ? pointCloud(ND, THREE.NormalBlending, makeGrainTexture(), pxScale) : null;
  const dustGlint = ND ? pointCloud(Math.round(ND / 3), THREE.AdditiveBlending, makeGlowTexture(), pxScale) : null;
  if (dust) scene.add(dust.pts, dustGlint.pts);
  const dcols = (pal.dust ?? [[pal.shell, 1]]).map(([c, w]) => [new THREE.Color(c), w]);
  const dsum = dcols.reduce((s, [, w]) => s + w, 0);
  const D6 = [];
  for (let i = 0; i < ND; i++) {
    const h = (k) => hash(i * 7.31 + k * 1.913 + 0.5);
    const p0 = [(h(1) * 2 - 1) * half[0], h(2) * H, (h(3) * 2 - 1) * half[2]];
    const phi = Math.atan2(p0[2] + (h(4) - 0.5) * 0.6, p0[0] + (h(5) - 0.5) * 0.6) + (h(6) - 0.5) * 0.9;
    let rf = 0.6 + 2.7 * Math.pow(h(7), 0.8); // -25% reach vs the flat-carpet version
    const cx = Math.cos(phi), cz = Math.sin(phi);
    rf = Math.min(rf, 3.2 / Math.max(1e-3, Math.abs(cx)), 2.3 / Math.max(1e-3, Math.abs(cz)));
    let pick = h(8) * dsum, ci = 0;
    while (ci < dcols.length - 1 && pick > dcols[ci][1]) { pick -= dcols[ci][1]; ci++; }
    D6.push({
      p0, phi, rf, r0: Math.hypot(p0[0], p0[2]), Ti: 0.3 + 1.9 * (rf / 3.2) * (0.7 + 0.6 * h(9)), vy: 1.5 + 7 * h(10),
      swirl: (h(11) - 0.5) * 0.9, size: 0.013 + 0.026 * Math.pow(h(12), 2), col: dcols[ci][0], glint: h(13), hp: Math.pow(h(18), 0.8),
      tgt: [(h(14) * 2 - 1) * half[0] * 0.9, tl.Y0 + (h(15) * 2 - 1) * half[1] * 0.9, (h(16) * 2 - 1) * half[2] * 0.9], d: 0.3 * h(17),
    });
  }
  /** Avalanche position of grain g at tau after the R6 impact (pure). */
  const dustAt = (g, tau, out) => {
    const e = easeOutCubic(tau / g.Ti);
    const r = g.r0 + (g.rf - g.r0) * e, a = g.phi + g.swirl * (1 - e) * e * 2;
    const tg = (g.vy + Math.sqrt(g.vy * g.vy + 2 * tl.G * Math.max(0, g.p0[1] - g.size))) / tl.G;
    const tt = Math.min(tau, tg);
    out[0] = Math.cos(a) * r; out[2] = Math.sin(a) * r;
    const fl = 0.5 * Math.exp(-r * r / (2 * 1.25 * 1.25)) * g.hp; // dust heap thickens toward the centre
    out[1] = Math.max(g.size * 0.5 + fl, g.p0[1] + g.vy * tt - 0.5 * tl.G * tt * tt);
    return out;
  };

  // ---------------- shock ring ----------------
  const ringMat = new THREE.MeshBasicMaterial({ map: makeGlowTexture(), color: pal.core, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.0, 96), ringMat);
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.012; ring.renderOrder = 2;
  scene.add(ring);

  const tmp = [0, 0, 0], tmp2 = [0, 0, 0];
  const hkW0 = tl.hook.end, hkW1 = tl.hook.whipEnd;
  return {
    count: { sparks: sparks.length, crumbs: crumbs.length, dust: ND },
    update(t, camera) {
      const scale = profile.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      for (const pc of [glow, chips, dust, dustGlint]) if (pc) pc.pts.material.uniforms.uScale.value = scale;
      const hkFade = 1 - clamp01((t - hkW0) / (hkW1 - hkW0)); // hook particles dissolve over the whip-zoom
      // sparks
      sparks.forEach((s, i) => {
        const tau = t - s.tb;
        if (tau < 0 || tau > s.life || (s.hook && t >= hkW1)) { glow.col[i * 4 + 3] = 0; return; }
        const y = s.p[1] + s.v[1] * tau - 0.5 * GS * tau * tau;
        if (y < 0.004) { glow.col[i * 4 + 3] = 0; return; }
        glow.pos[i * 3] = s.p[0] + s.v[0] * tau; glow.pos[i * 3 + 1] = y; glow.pos[i * 3 + 2] = s.p[2] + s.v[2] * tau;
        const f = 1 - tau / s.life;
        if (s.gold) col.copy(goldC).lerp(goldHi, s.hot).multiplyScalar(1.6); else col.copy(sc0).lerp(sc1, s.hot).multiplyScalar(1.5);
        glow.col.set([col.r, col.g, col.b, f * f * (s.hook ? hkFade : 1)], i * 4);
        glow.size[i] = s.size * (0.6 + 0.4 * f);
      });
      glow.dirty();
      // crumbs (land and rest on the table, then fade)
      crumbs.forEach((c, i) => {
        const tau = t - c.tb;
        if (tau < 0 || tau > c.life || (c.hook && t >= hkW1)) { chips.col[i * 4 + 3] = 0; return; }
        const hgt = c.p[1] - c.size * 0.5;
        const tg = (c.v[1] + Math.sqrt(c.v[1] * c.v[1] + 2 * GC * Math.max(0, hgt))) / GC;
        const tt = Math.min(tau, tg);
        chips.pos[i * 3] = c.p[0] + c.v[0] * tt; chips.pos[i * 3 + 2] = c.p[2] + c.v[2] * tt;
        chips.pos[i * 3 + 1] = Math.max(c.size * 0.5, c.p[1] + c.v[1] * tt - 0.5 * GC * tt * tt);
        col.copy(crumbC).lerp(goldHi, 0.25 + 0.6 * c.tint).multiplyScalar(1.15);
        const a = Math.min(1, (c.life - tau) / 0.35) * (c.hook ? hkFade : 1);
        chips.col.set([col.r, col.g, col.b, a], i * 4);
        chips.size[i] = c.size;
      });
      chips.dirty();
      // dust
      if (dust) {
        const tImp = R6.impact, tRew = fin.rewind, tEnd = fin.converge;
        const on = t >= tImp && t < tEnd;
        let gi = 0;
        const gN = dustGlint.size.length;
        for (let i = 0; i < ND; i++) {
          const g = D6[i];
          if (!on) { dust.col[i * 4 + 3] = 0; continue; }
          let a = 1;
          if (t < tRew) dustAt(g, t - tImp, tmp);
          else {
            dustAt(g, tRew - tImp, tmp2);
            const u = clamp01((t - tRew) / (tEnd - tRew));
            const ui = clamp01((u - g.d) / (1 - g.d)), e = easeInOutCubic(ui);
            let x = tmp2[0] + (g.tgt[0] - tmp2[0]) * e, z = tmp2[2] + (g.tgt[2] - tmp2[2]) * e;
            const arc = Math.sin(Math.PI * e), ang = 2.6 * arc;
            const c = Math.cos(ang), s = Math.sin(ang);
            tmp[0] = x * c - z * s; tmp[2] = x * s + z * c;
            tmp[1] = tmp2[1] + (g.tgt[1] - tmp2[1]) * e + 0.5 * arc;
            a = 1 - smooth(0.8, 1, ui);
          }
          dust.pos[i * 3] = tmp[0]; dust.pos[i * 3 + 1] = tmp[1]; dust.pos[i * 3 + 2] = tmp[2];
          const tw = 0.75 + 0.5 * Math.pow(hash(i * 0.37 + Math.floor(t * 12) * 0.11), 3);
          dust.col.set([g.col.r * tw, g.col.g * tw, g.col.b * tw, a], i * 4);
          dust.size[i] = g.size;
          if (g.glint > 0.72 && gi < gN) { // metallic glints twinkling on top of the powder
            const sp = Math.pow(hash(i * 1.7 + Math.floor(t * 20) * 0.31), 6);
            dustGlint.pos.set([tmp[0], tmp[1] + 0.004, tmp[2]], gi * 3);
            dustGlint.col.set([1.4, 1.25, 0.8, sp * a], gi * 4);
            dustGlint.size[gi] = g.size * 2.4;
            gi++;
          }
        }
        for (; gi < gN; gi++) dustGlint.col[gi * 4 + 3] = 0;
        dust.dirty(); dustGlint.dirty();
      }
      // shock ring at heavy impacts
      ringMat.opacity = 0; ring.visible = false;
      for (const R of tl.rounds) {
        const tau = t - R.impact;
        if (R.tier < 3 || tau < 0 || tau > 0.7) continue;
        const s = 0.6 + (R.tier >= 4 ? 5.5 : 3.6) * easeOutCubic(tau / 0.7);
        ring.scale.set(s, s, 1); ring.visible = true;
        ringMat.opacity = 0.55 * (1 - tau / 0.7);
      }
    },
  };
}
