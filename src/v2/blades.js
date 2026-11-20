// v2 blades: the real damascus Santoku (single readable strokes R1-R3, with cyan motion trails) and a pool of translucent
// "ghost" Santoku blades with a hot blue edge (fans: hook, R4-R6). All placement is a pure function of the pass + time.
import * as THREE from 'three';
import { createKnife, bladeGeometry, edgeStripGeometry, GRIND } from '../objects.js';
import { makeEdgeGradient } from '../textures.js';
import { LAYOUT } from '../config.js';
import { clamp01 } from '../util.js';

/**
 * Blade pose in the ingot frame for pass P at stroke progress u (0..1):
 *  axis x: blade plane x = c, falls along -y (rotY -90°, handle to the back);  axis z: plane z = c, falls along -y;
 *  axis y: plane y = c, travels along -z (rotX +90°: spine toward the camera, edge leading);  diagonal: rotY -45°, falls along -y.
 * Edge coordinate e runs from +(ext + o) to -(ext + o): the edge crosses the whole ingot, matching timeline.passReveal().
 */
export function bladeLocal(P, c, u, half, o) {
  const ext = half[P.axis === 1 ? 2 : 1];
  const e = ext + o - u * 2 * (ext + o);
  if (P.axis === 0) return { pos: [c, e, 0], rot: [0, -Math.PI / 2, 0] };
  if (P.axis === 2) return { pos: [0, e, c], rot: [0, 0, 0] };
  if (P.axis === 1) return { pos: [0, c, e], rot: [Math.PI / 2, 0, 0] };
  return { pos: [c * 0.7071, e, -c * 0.7071], rot: [0, -Math.PI / 4, 0] };
}

export async function createBlades(recipe, scene) {
  const V = recipe.v2, gc = { color: '#38e8ff', edge: '#e0fcff', opacity: 0.22, stagger: 0.012, ...V.ghost };
  const kc = { tool: Object.keys(recipe.tools)[0], overshoot: 0.6, trail: 3, ...V.knife };
  const knife = await createKnife(recipe.tools, recipe.palette.accent);
  knife.setTool(kc.tool);
  knife.group.visible = false;
  knife.ghosts.forEach((g) => { g.visible = false; });

  // ghost pool
  const K = LAYOUT.knife;
  const { geo, profile: Pf } = bladeGeometry(K.length, K.height, K.thickness);
  const edgeGeo = edgeStripGeometry(Pf, K.thickness, K.height * GRIND * 0.9);
  const grad = makeEdgeGradient(2.2);
  const POOL = 16;
  const ghosts = [];
  for (let i = 0; i < POOL; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: gc.color, transparent: true, opacity: gc.opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    const edge = new THREE.Mesh(edgeGeo, new THREE.MeshBasicMaterial({
      map: grad, color: gc.edge, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    body.renderOrder = 6; edge.renderOrder = 7;
    g.add(body, edge);
    g.visible = false;
    ghosts.push({ g, body, edge });
  }
  const trailMats = knife.ghosts; // edge-only streaks from createKnife (cyan), reused as motion trails of the real knife

  const holder = new THREE.Group(); // attached to the ingot frame by the game
  holder.add(knife.group, ...ghosts.map((x) => x.g), ...trailMats);
  scene.add(knife.light);

  const place = (obj, L) => { obj.position.set(...L.pos); obj.rotation.set(...L.rot); };
  const tmp = new THREE.Vector3();

  return {
    holder, knife,
    /**
     * Shows every blade active at t. passes: all passes of the current context; tl: timeline (strokeU, half).
     * Returns { contact: 0..1, light: world-space position of the brightest edge, active: bool }.
     */
    update(t, passes, tl, frame) {
      let gi = 0, active = false, contact = 0;
      knife.group.visible = false;
      trailMats.forEach((m) => { m.visible = false; });
      for (const P of passes) {
        const pre = 0.02, post = 0.03;
        if (t < P.t0 - pre || t > P.t1 + post) continue;
        const u = tl.strokeU(P, t);
        const vis = t >= P.t0 && t <= P.t1;
        if (!P.fan) {
          if (!vis) continue;
          const L = bladeLocal(P, P.planes[0] ?? 0, u, tl.half, kc.overshoot);
          place(knife.group, L);
          knife.group.visible = true;
          active = true;
          // trails: past poses of the same stroke
          for (let k = 0; k < Math.min(kc.trail, trailMats.length); k++) {
            const tt = t - (k + 1) * 0.014;
            if (tt < P.t0) break;
            const m = trailMats[k];
            place(m, bladeLocal(P, P.planes[0] ?? 0, tl.strokeU(P, tt), tl.half, kc.overshoot));
            m.material.opacity = 0.5 * (1 - k / kc.trail);
            m.visible = true;
          }
          contact = Math.max(contact, tl.passReveal(P, t) > 0 && tl.passReveal(P, t) < 1 ? 1 : 0.4);
          knife.light.position.copy(frame.localToWorld(tmp.set(...L.pos)));
          continue;
        }
        P.planes.forEach((c, j) => {
          if (gi >= ghosts.length) return;
          const tj = t - j * gc.stagger;
          const uj = tl.strokeU(P, tj);
          if (tj < P.t0 || tj > P.t1) return;
          const G = ghosts[gi++];
          place(G.g, bladeLocal(P, c, uj, tl.half, kc.overshoot));
          const fade = Math.sin(Math.PI * clamp01((tj - P.t0) / P.dur));
          G.body.material.opacity = gc.opacity * (0.35 + 0.65 * fade);
          G.edge.material.opacity = 0.6 + 0.4 * fade;
          G.g.visible = true;
          active = true;
          if (j === Math.floor(P.planes.length / 2)) knife.light.position.copy(frame.localToWorld(tmp.set(...bladeLocal(P, c, uj, tl.half, kc.overshoot).pos)));
        });
        contact = Math.max(contact, 1);
      }
      for (; gi < ghosts.length; gi++) ghosts[gi].g.visible = false;
      knife.updateGlow(t, active ? 0.4 : 0, contact);
      if (!active) knife.light.intensity = 0;
      return { active, contact };
    },
  };
}
