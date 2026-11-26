// v3 blades (engineVersion 3): a forged chrome-damascus chef knife for single strokes (hook, R1-R3) and a pool of ultra-thin
// mirror razor plates for fans (R4-R5). Real geometry with a ground bevel, mirror metal that catches the softboxes; the only
// light effect is a hair-thin cold streak on the very edge (+ short edge trails). Placement is a pure function of pass + t
// (v2 bladeLocal(), so blades stay exactly synced with the seam reveal of timeline.passReveal()).
import * as THREE from 'three';
import { bladeGeometry, edgeStripGeometry, GRIND } from '../objects.js';
import { makeDamascus, makeEdgeGradient } from '../textures.js';
import { bladeLocal } from '../v2/blades.js';
import { clamp01 } from '../util.js';

export function createBladesV3(recipe, knifeLight) {
  const V = recipe.v2, kc = { overshoot: 0.25, trail: 3, edge: '#dff3ff', streak: 0.85, ...V.knife };
  const rc = { stagger: 0.012, height: 0.2, thickness: 0.006, edge: '#e8f6ff', streak: 0.9, ...(recipe.v3.razor ?? {}) };
  const BL = kc.length ?? 1.9, BH = kc.height ?? 0.44, T = kc.thickness ?? 0.026;

  // ---- chef knife ----
  const { geo, profile: P } = bladeGeometry(BL, BH, T);
  const dam = makeDamascus(GRIND);
  const chrome = new THREE.MeshPhysicalMaterial({
    color: kc.color ?? '#eef1f5', metalness: kc.metalness ?? 0.96, roughness: kc.roughness ?? 0.08,
    emissive: kc.emissive ?? '#000000', emissiveIntensity: kc.emissiveIntensity ?? 0, bumpMap: dam.bump, bumpScale: kc.damascus ?? 0.22,
    clearcoat: 0.5, clearcoatRoughness: 0.04, envMapIntensity: kc.envMapIntensity ?? 1.9, side: THREE.DoubleSide,
  });
  if (kc.bevel) { // v3.1 dark forged steel: the ground cutting bevel (uv.y < GRIND) is a separately polished bright mirror edge
    const bev = new THREE.Color(kc.bevel);
    chrome.onBeforeCompile = (sh) => {
      sh.uniforms.uBevel = { value: bev };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vBvV;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvBvV = uv.y;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uBevel; varying float vBvV;')
        .replace('#include <color_fragment>', `#include <color_fragment>
float bvW = 1.0 - smoothstep(${(GRIND * 0.92).toFixed(4)}, ${(GRIND * 1.02).toFixed(4)}, vBvV);
diffuseColor.rgb = mix(diffuseColor.rgb, uBevel, bvW);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, ${(kc.bevelRoughness ?? 0.04).toFixed(3)}, bvW);`)
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 1.0, bvW);');
    };
    chrome.customProgramCacheKey = () => 'knife-bevel-v31';
  }
  const knife = new THREE.Group();
  const blade = new THREE.Mesh(geo, chrome);
  blade.castShadow = true;
  const resin = new THREE.MeshPhysicalMaterial({ color: '#15161b', roughness: 0.28, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08 });
  const steel = new THREE.MeshPhysicalMaterial({ color: '#d9dde3', metalness: 1, roughness: 0.12, envMapIntensity: 1.6 });
  const th = THREE.MathUtils.degToRad(7);
  const handle = new THREE.Group();
  const bol = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.07, 0.08, 20), steel);
  bol.rotation.z = Math.PI / 2; bol.position.x = 0.04; bol.scale.set(1, 1, 0.72);
  const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.066, 0.5, 6, 20), resin);
  grip.rotation.z = Math.PI / 2; grip.position.x = 0.36; grip.scale.set(1, 1, 0.74);
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 12), steel);
  pin.rotation.x = Math.PI / 2; pin.position.x = 0.3;
  handle.add(bol, grip, pin);
  handle.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  handle.position.set(P.x0 + 0.01, P.spine(P.x0) - 0.09, 0);
  handle.rotation.set(0, Math.PI, th);
  const edgeMap = makeEdgeGradient(3.2);
  const edgeGeo = edgeStripGeometry(P, T, BH * GRIND * 0.38);
  const edgeMat = new THREE.MeshBasicMaterial({ map: edgeMap, color: kc.edge, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const edge = new THREE.Mesh(edgeGeo, edgeMat);
  edge.renderOrder = 5;
  knife.add(blade, handle, edge);
  knife.visible = false;
  const trails = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(edgeGeo, new THREE.MeshBasicMaterial({ map: edgeMap, color: kc.edge, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    m.visible = false; m.renderOrder = 4;
    trails.push(m);
  }

  // ---- razor plates (fans) ----
  const rz = bladeGeometry(BL, rc.height, rc.thickness);
  const rzEdge = edgeStripGeometry(rz.profile, rc.thickness, rc.height * 0.22);
  const mirror = new THREE.MeshPhysicalMaterial({ color: '#f4f6f9', metalness: 1, roughness: 0.04, envMapIntensity: 2.2, clearcoat: 0.4, side: THREE.DoubleSide });
  const POOL = 16, plates = [];
  for (let i = 0; i < POOL; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(rz.geo, mirror);
    const streak = new THREE.Mesh(rzEdge, new THREE.MeshBasicMaterial({ map: edgeMap, color: rc.edge, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    streak.renderOrder = 6;
    g.add(body, streak);
    g.visible = false;
    plates.push({ g, streak });
  }

  // ---- single-blitz (R4-R5): ONE chef knife + swept-surface motion ribbon + entry sparks ----
  const bc = { history: 0.07, steps: 8, samples: 12, sparks: 7, sparkLife: 0.13, sparkSpeed: 3.4, gold: '#ffc233', steel: '#cfe6ff', ...(recipe.v3.blitz ?? {}) };
  const LINES = [0, 0.3 * BH, 0.62 * BH]; // edge line + two inner lines of the blade body swept through the last `history` seconds
  const RK = bc.steps, RM = bc.samples, RV = (RK + 1) * LINES.length * (RM + 1);
  const NB = bc.blend === 'normal'; // v3.1 bright studio: opaque-ish dark gold / steel smear (additive light vanishes on a light set)
  const CS = NB ? 4 : 3;
  const rPos = new Float32Array(RV * 3), rCol = new Float32Array(RV * CS);
  const rGeo = new THREE.BufferGeometry();
  rGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3).setUsage(THREE.DynamicDrawUsage));
  rGeo.setAttribute('color', new THREE.BufferAttribute(rCol, CS).setUsage(THREE.DynamicDrawUsage));
  const rIdx = [];
  const vi = (l, k, m) => (l * (RK + 1) + k) * (RM + 1) + m;
  for (let l = 0; l < LINES.length; l++) for (let k = 0; k < RK; k++) for (let m = 0; m < RM; m++) {
    const a = vi(l, k, m), b = vi(l, k + 1, m), c = vi(l, k, m + 1), d = vi(l, k + 1, m + 1);
    rIdx.push(a, b, c, c, b, d);
  }
  rGeo.setIndex(rIdx);
  const ribbon = new THREE.Mesh(rGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: NB ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  ribbon.frustumCulled = false; ribbon.renderOrder = 7; ribbon.visible = false;
  const SPN = 96, spPos = new Float32Array(SPN * 3), spCol = new Float32Array(SPN * 3);
  const spGeo = new THREE.BufferGeometry();
  spGeo.setAttribute('position', new THREE.BufferAttribute(spPos, 3).setUsage(THREE.DynamicDrawUsage));
  spGeo.setAttribute('color', new THREE.BufferAttribute(spCol, 3).setUsage(THREE.DynamicDrawUsage));
  const dot = document.createElement('canvas'); dot.width = dot.height = 32;
  { const cx = dot.getContext('2d'), g = cx.createRadialGradient(16, 16, 0, 16, 16, 16); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)'); cx.fillStyle = g; cx.fillRect(0, 0, 32, 32); }
  const dotTex = new THREE.CanvasTexture(dot);
  const sparks = new THREE.Points(spGeo, new THREE.PointsMaterial({ size: 0.05, map: dotTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, sizeAttenuation: true }));
  sparks.frustumCulled = false; sparks.renderOrder = 8; sparks.visible = false;
  const cGold = new THREE.Color(bc.gold), cSteel = new THREE.Color(bc.steel), cHot = new THREE.Color(bc.hot ?? '#fff4d0');

  const holder = new THREE.Group();
  holder.add(knife, ...trails, ...plates.map((p) => p.g), ribbon, sparks);

  // ---- blitz pose: a pure function of (pass, stroke progress); passes alternate direction (dir), blade angle (tilt) and plane drift ----
  const V3 = THREE.Vector3, Mx = new THREE.Matrix4(), Qa = new THREE.Quaternion();
  const NRM = { 0: [-1, 0, 0], 1: [0, 1, 0], 2: [0, 0, 1] };
  const blitzPose = (Pp, s, half, o) => {
    const dir = Pp.dir ?? 1, ax = Pp.axis;
    const ext = ax === 1 ? half[0] : half[1], span = 2 * (ext + o);
    const e = dir > 0 ? ext + o - s * span : -(ext + o) + s * span;
    const pl = Pp.planes, c0 = pl.length ? pl[0] : 0, c1 = pl.length ? pl[pl.length - 1] : 0;
    const w = (Pp.idx ?? 0) % 2 === 0 ? s : 1 - s, c = ax === 3 ? 0 : c0 + (c1 - c0) * w; // the blade drifts across the plane range it reveals
    let N, F, pos;
    if (ax === 0) { N = new V3(-1, 0, 0); F = new V3(0, -dir, 0); pos = new V3(c, e, 0); }
    else if (ax === 2) { N = new V3(0, 0, 1); F = new V3(0, -dir, 0); pos = new V3(0, e, c); }
    else if (ax === 1) { N = new V3(0, 1, 0); F = new V3(-dir, 0, 0); pos = new V3(e, c, 0); }
    else { N = new V3((Pp.diag ?? 1) > 0 ? -Math.SQRT1_2 : Math.SQRT1_2, 0, Math.SQRT1_2); F = new V3(0, -dir, 0); pos = new V3(0, e, 0); }
    F.applyQuaternion(Qa.setFromAxisAngle(N, THREE.MathUtils.degToRad(Pp.tilt ?? 0)));
    const X = new V3().crossVectors(F.clone().negate(), N);
    const q = new THREE.Quaternion().setFromRotationMatrix(Mx.makeBasis(X, F.clone().negate(), N));
    return { pos, q };
  };
  const smooth = (u) => u * u * (3 - 2 * u);
  /** The single knife at time t over the blitz passes (stroke -> blended transit to the next stroke's start pose). null outside the burst. */
  const blitzAt = (passes, t, tl) => {
    const first = passes[0], last = passes[passes.length - 1];
    if (t < first.t0 - 0.03 || t > last.t1 + 0.03) return null;
    const at = (Pp, s) => blitzPose(Pp, s, tl.half, kc.overshoot);
    if (t < first.t0) return { ...at(first, 0), pass: first, inside: false };
    if (t >= last.t1) return { ...at(last, 1), pass: last, inside: false };
    for (let i = 0; i < passes.length; i++) {
      const Pp = passes[i];
      if (t >= Pp.t0 && t <= Pp.t1) return { ...at(Pp, tl.strokeU(Pp, t)), pass: Pp, inside: true };
      const nx = passes[i + 1];
      if (nx && t > Pp.t1 && t < nx.t0) {
        const A = at(Pp, 1), B = at(nx, 0), k = smooth((t - Pp.t1) / (nx.t0 - Pp.t1));
        return { pos: A.pos.clone().lerp(B.pos, k), q: A.q.clone().slerp(B.q, k), pass: nx, inside: false };
      }
    }
    return null;
  };
  const bladePt = (pose, x, yy, out) => out.set(x, yy, 0).applyQuaternion(pose.q).add(pose.pos);
  const Pf = P; // knife blade profile
  const hash = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  const tmpA = new V3(), tmpB = new V3();

  const updateRibbon = (passes, t, tl, now) => {
    const posA = ribbon.geometry.attributes.position, colA = ribbon.geometry.attributes.color;
    const poses = [];
    for (let k = 0; k <= RK; k++) poses.push(blitzAt(passes, t - (k * bc.history) / RK, tl));
    const fast = now.inside ? 1 : 0.4;
    for (let l = 0; l < LINES.length; l++) for (let k = 0; k <= RK; k++) {
      const ps = poses[k] ?? poses.find(Boolean) ?? now;
      const age = k / RK, fade = (1 - age) ** 3 * fast;
      const base = l === 0 ? cGold : cSteel, inten = NB ? (bc.alpha ?? [0.85, 0.32, 0.16])[l] : l === 0 ? 0.8 : l === 1 ? 0.1 : 0.035;
      for (let m = 0; m <= RM; m++) {
        const xx = Pf.x0 + (m / RM) * (Pf.x1 - Pf.x0);
        bladePt(ps, xx, Pf.edge(xx) + LINES[l], tmpA);
        const j = vi(l, k, m) * 3;
        posA.array[j] = tmpA.x; posA.array[j + 1] = tmpA.y; posA.array[j + 2] = tmpA.z;
        if (NB) {
          const prof = Math.sin(Math.PI * Math.min(1, Math.max(0, (m / RM) * 0.92 + 0.04)));
          const a = fade * inten * (0.35 + 0.65 * prof), jc = vi(l, k, m) * 4;
          const cc = l === 0 ? tmpB.set(cHot.r, cHot.g, cHot.b).lerp(new V3(cGold.r, cGold.g, cGold.b), Math.min(1, age * 2.5)) : tmpB.set(base.r, base.g, base.b);
          colA.array[jc] = cc.x; colA.array[jc + 1] = cc.y; colA.array[jc + 2] = cc.z; colA.array[jc + 3] = a;
          continue;
        }
        const prof = Math.sin(Math.PI * Math.min(1, Math.max(0, (m / RM) * 0.92 + 0.04))); // soft ends along the blade
        // head of the streak is bright steel-white; the thin edge line carries the gold spark, cooling toward the tail
        const g = fade * inten * (0.35 + 0.65 * prof);
        const cc = l === 0 ? tmpB.set(cHot.r, cHot.g, cHot.b).lerp(new V3(cGold.r, cGold.g, cGold.b), age) : tmpB.set(base.r, base.g, base.b);
        colA.array[j] = cc.x * g; colA.array[j + 1] = cc.y * g; colA.array[j + 2] = cc.z * g;
      }
    }
    posA.needsUpdate = true; colA.needsUpdate = true;
  };

  const updateSparks = (passes, t, tl) => {
    const posA = sparks.geometry.attributes.position, colA = sparks.geometry.attributes.color;
    let n = 0;
    const o = kc.overshoot;
    for (const Pp of passes) {
      if (!Pp.blitz) continue;
      if (t < Pp.t0 || t > Pp.t1 + bc.sparkLife + 0.01) continue;
      const ext = Pp.axis === 1 ? tl.half[0] : tl.half[1], ue = o / (2 * (ext + o));
      const inv = (u) => Math.acos(1 - 2 * u) / Math.PI; // invert the ease-in-out stroke
      for (const [ev, uu, cnt] of [[0, ue, bc.sparks], [1, 1 - ue, Math.ceil(bc.sparks * 0.6)]]) {
        const te = Pp.t0 + Pp.dur * inv(uu), age = t - te;
        if (age < 0 || age > bc.sparkLife) continue;
        const pose = blitzPose(Pp, uu, tl.half, o);
        for (let i = 0; i < cnt && n < SPN; i++, n++) {
          const hx = hash(Pp.idx * 7.3 + ev, i), hy = hash(Pp.idx * 3.1 + ev + 5, i + 9), hz = hash(Pp.idx + ev * 2.7, i * 1.7 + 3);
          tmpA.set((hx - 0.5) * 1.1, 0, 0).applyQuaternion(pose.q).add(pose.pos);
          const sp = bc.sparkSpeed * (0.45 + 0.9 * hy), a = 1 - age / bc.sparkLife;
          const dirv = tmpB.set(hx - 0.5, 0.35 + 0.65 * hy, hz - 0.5).normalize();
          posA.array[n * 3] = tmpA.x + dirv.x * sp * age;
          posA.array[n * 3 + 1] = tmpA.y + dirv.y * sp * age - 4.5 * age * age;
          posA.array[n * 3 + 2] = tmpA.z + dirv.z * sp * age;
          const g = a * a * (ev === 0 ? 1.0 : 0.7), gold = hash(i, Pp.idx) > 0.55;
          const c = gold ? cGold : cHot;
          colA.array[n * 3] = c.r * g; colA.array[n * 3 + 1] = c.g * g; colA.array[n * 3 + 2] = c.b * g;
        }
      }
    }
    for (let i = n; i < SPN; i++) { colA.array[i * 3] = colA.array[i * 3 + 1] = colA.array[i * 3 + 2] = 0; posA.array[i * 3] = posA.array[i * 3 + 1] = posA.array[i * 3 + 2] = 0; }
    posA.needsUpdate = true; colA.needsUpdate = true;
    sparks.visible = n > 0;
  };

  const place = (obj, Lp) => { obj.position.set(...Lp.pos); obj.rotation.set(...Lp.rot); };
  const tmp = new THREE.Vector3();

  return {
    holder,
    update(t, passes, tl, frame) {
      let gi = 0, active = false, contact = 0;
      knife.visible = false;
      trails.forEach((m) => { m.visible = false; });
      ribbon.visible = false; sparks.visible = false;
      const bl = passes.filter((q) => q.blitz);
      if (bl.length) { // R4/R5 single-blitz: exactly ONE knife in frame, no plates
        for (; gi < plates.length; gi++) plates[gi].g.visible = false;
        const now = blitzAt(bl, t, tl);
        if (!now) { knifeLight.intensity = 0; return { active: false, contact: 0 }; }
        knife.position.copy(now.pos); knife.quaternion.copy(now.q);
        knife.visible = true;
        edgeMat.opacity = kc.streak * (now.inside ? 1 : 0.5);
        updateRibbon(bl, t, tl, now);
        ribbon.visible = true;
        updateSparks(bl, t, tl);
        knifeLight.position.copy(frame.localToWorld(tmp.copy(now.pos)));
        knifeLight.intensity = (kc.lightIntensity ?? 2.2) * (now.inside ? 1 : 0.4);
        return { active: true, contact: now.inside ? 1 : 0.3 };
      }
      for (const Pp of passes) {
        if (t < Pp.t0 - 0.02 || t > Pp.t1 + 0.03) continue;
        const u = tl.strokeU(Pp, t);
        if (!Pp.fan) {
          if (t < Pp.t0 || t > Pp.t1) continue;
          const Lp = bladeLocal(Pp, Pp.planes[0] ?? 0, u, tl.half, kc.overshoot);
          place(knife, Lp);
          knife.visible = true; active = true;
          const rev = tl.passReveal(Pp, t), inside = rev > 0 && rev < 1;
          edgeMat.opacity = kc.streak * (inside ? 1 : 0.35);
          for (let k = 0; k < Math.min(kc.trail, trails.length); k++) {
            const tt = t - (k + 1) * 0.012;
            if (tt < Pp.t0) break;
            place(trails[k], bladeLocal(Pp, Pp.planes[0] ?? 0, tl.strokeU(Pp, tt), tl.half, kc.overshoot));
            trails[k].material.opacity = 0.45 * kc.streak * (1 - k / kc.trail) * (inside ? 1 : 0.4);
            trails[k].visible = true;
          }
          contact = Math.max(contact, inside ? 1 : 0.3);
          knifeLight.position.copy(frame.localToWorld(tmp.set(...Lp.pos)));
          continue;
        }
        Pp.planes.forEach((c, j) => {
          if (gi >= plates.length) return;
          const tj = t - j * rc.stagger;
          if (tj < Pp.t0 || tj > Pp.t1) return;
          const Gp = plates[gi++];
          const Lp = bladeLocal(Pp, c, tl.strokeU(Pp, tj), tl.half, kc.overshoot);
          place(Gp.g, Lp);
          const s = Math.sin(Math.PI * clamp01((tj - Pp.t0) / Pp.dur));
          Gp.streak.material.opacity = rc.streak * s * s;
          Gp.g.visible = true; active = true;
          if (j === Math.floor(Pp.planes.length / 2)) knifeLight.position.copy(frame.localToWorld(tmp.set(...Lp.pos)));
        });
        contact = Math.max(contact, 1);
      }
      for (; gi < plates.length; gi++) plates[gi].g.visible = false;
      knifeLight.intensity = active ? (kc.lightIntensity ?? 2.2) * (0.3 + 0.7 * contact) : 0;
      return { active, contact };
    },
  };
}
