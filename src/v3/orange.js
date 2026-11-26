// v3.2 Crystal Glass Orange geometry (recipe.object.shape === "crystal-orange"), pure + deterministic.
//  - the orange is the v3 apple surface of revolution with apple-only features switched off: no shoulder, no taper, no lobes,
//    vertical squash ~0.9 (oblate citrus) and two shallow, narrow pole dimples (stem + navel). The info object is a copy of
//    appleInfo() with its own cache key + triangles(), so the watertight clipper (clipAppleCell / appleCellKeep /
//    applePieceGeometry) runs unchanged and the apple / watermelon recipes are untouched;
//  - layers (normalised radius r, 0 centre .. 1 skin): peel r > 0.87, white albedo 0.80 < r <= 0.87, 10 radial pulp segments
//    with white membranes around a white core column (rA <= 0.13); the JS layer() mirrors the cap shader for the shard colours;
//  - 3 hidden electric-cyan crystals, one per round R1..R3: each centre sits a few mm inside ONE piece next to a single cut
//    plane of its round and clear of every other plane, so exactly one cut face shows exactly one crystal.
import { appleInfo, appleTriangles, appleRadius } from './apple.js';

export const ORANGE_DEF = { radius: 0.66, squash: 0.9, dimpleTop: [0.05, 0.2], dimpleBottom: [0.035, 0.22], rings: 96, segments: 160 };
export const ORANGE_LAYERS = { peel: 0.87, albedo: 0.8, core: 0.13, segments: 10, phase: 0.31 };

const cache = new Map();

/** Orange description (cached): apple-clipper compatible info + layers + crystals. */
export function orangeInfo(cfg = {}) {
  const c = { ...ORANGE_DEF, ...(cfg.orange ?? {}), radius: cfg.radius ?? ORANGE_DEF.radius };
  const key = 'orange:' + JSON.stringify(c) + JSON.stringify(cfg.crystals ?? null);
  if (cache.has(key)) return cache.get(key);
  const base = appleInfo({
    radius: c.radius,
    apple: { squash: c.squash, shoulder: 0, taper: 0, dimpleTop: c.dimpleTop, dimpleBottom: c.dimpleBottom, lobes: [0, 0], rings: c.rings, segments: c.segments },
  });
  const A = { ...base, kind: 'orange', key, ocfg: c };
  const Rr = c.radius, Hh = base.Hh, W = base.W;
  const L = ORANGE_LAYERS;
  const TWO_PI = 2 * Math.PI;

  // crystals [x, y, z] + half extents of the elongated octahedron [sx, sy, sz] (orange-local), one per round
  //  #0 R1 (cut x = 0): just left of the cut, on the camera side of the -x half's cut face, near a segment edge;
  //  #1 R2 (cuts x = 0, y = 0, z = 0): just under y = 0 (up-facing cut face of a lower front piece), clear of x = 0 / z = 0;
  //  #2 R3 (cuts at +-W/4, 0 on x / z, +-Hh/2, 0 on y): just under the y = -Hh/2 plane, on the top cut face of a bottom-layer
  //     piece (that piece settles face-up in the deterministic R3 simulation; checked by snapshot).
  // The -x half tips cut-face-up toward -x (its +y rim goes left), so crystal #0 sits on the y < 0 side: toward frame centre.
  const q4 = W / 4, h4 = Hh / 2;
  const a0 = L.phase + (-1.22 * TWO_PI) / L.segments; // front-lower segment, close to its membrane
  A.crystals = [
    { p: [-0.008, 0.52 * Rr * Math.sin(a0), 0.52 * Rr * Math.cos(a0)], s: [0.03, 0.085, 0.065] }, // x-axis star: (z, y) = (cos, sin)
    { p: [-0.29, -0.009, 0.24], s: [0.075, 0.03, 0.06] },
    { p: [-q4 / 2, -h4 - 0.006, q4 / 2], s: [0.1, 0.03, 0.11] },
  ];
  (cfg.crystals ?? []).forEach((C, k) => { if (C) A.crystals[k] = { p: C.p, s: C.s ?? A.crystals[k].s }; }); // recipe.object.crystals overrides (per round)
  for (const C of A.crystals) if (!base.inside(...C.p)) throw new Error('orange crystal outside the fruit');

  let tris = null;
  A.triangles = () => (tris ??= appleTriangles(A));
  A.fixClip = fanCaps;
  A.radius = (x, y, z) => appleRadius(base, x, y, z);
  /** Star pattern around the x axis (shards): distance from the axis / R, angle. */
  const star = (x, y, z) => {
    const rA = Math.hypot(z, y) / Rr;
    const th = Math.atan2(y, z) - L.phase;
    const seg = (((th * L.segments) / TWO_PI) % 1 + 1) % 1;
    const arc = (Math.min(seg, 1 - seg) * TWO_PI / L.segments) * Math.hypot(z, y);
    return { rA, arc };
  };
  /** Layer of an orange-local point: 'peel' | 'albedo' | 'core' | 'membrane' | 'pulp'. */
  A.layer = (x, y, z, memW = 0.02) => {
    const r = A.radius(x, y, z);
    if (r > L.peel) return 'peel';
    if (r > L.albedo) return 'albedo';
    const s = star(x, y, z);
    if (s.rA <= L.core) return 'core';
    if (s.arc < memW) return 'membrane';
    return 'pulp';
  };
  A.W = W;
  cache.set(key, A);
  return A;
}

/**
 * Cap re-triangulation (orange only, via A.fixClip in appleCellKeep): the generic ear clipper links the two shallow pole dimples
 * of a near-symmetric citrus section with a pole-to-pole diagonal and fans needle slivers off the dense, near-collinear dimple
 * floor points; the GPU then leaves a dotted 1 px crack across the cut face. Every orange cut section is star-shaped from its
 * centroid, so each cap is rebuilt as a fan around one interior vertex: the outline (shared with the skin) is kept exactly, no
 * sliver spans the face. Caps that are not a single star-shaped loop are left as they were.
 */
function fanCaps(clip) {
  const byPlane = new Map(), out = [];
  for (const t of clip.tris) {
    if (!t.cap) { out.push(t); continue; }
    const k = t.n.join(',');
    if (!byPlane.has(k)) byPlane.set(k, []);
    byPlane.get(k).push(t);
  }
  const pk = (p) => `${p[0]},${p[1]},${p[2]}`;
  for (const list of byPlane.values()) {
    const n = list[0].n;
    const E = new Map();
    for (const t of list) for (let i = 0; i < 3; i++) { const a = t.p[i], b = t.p[(i + 1) % 3]; E.set(pk(a) + '|' + pk(b), [a, b]); }
    const next = new Map();
    for (const [a, b] of E.values()) if (!E.has(pk(b) + '|' + pk(a))) next.set(pk(a), [a, b]);
    // single boundary loop?
    const loop = [];
    const k0 = next.keys().next().value;
    let k = k0, guard = 0;
    while (k !== undefined && guard++ <= next.size) { const e = next.get(k); if (!e) break; loop.push(e); k = pk(e[1]); if (k === k0) break; }
    if (k !== k0 || loop.length !== next.size || loop.length < 3) { out.push(...list); continue; }
    // area-weighted centroid of the cap
    let ar = 0; const c = [0, 0, 0];
    for (const { p: [a, b, d] } of list) {
      const w = Math.hypot((b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]), (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]), (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]));
      ar += w; for (let j = 0; j < 3; j++) c[j] += (w * (a[j] + b[j] + d[j])) / 3;
    }
    if (ar <= 0) { out.push(...list); continue; }
    for (let j = 0; j < 3; j++) c[j] /= ar;
    for (let j = 0; j < 3; j++) if (n[j]) c[j] = loop[0][0][j]; // exactly on the plane
    const star = loop.every(([a, b]) => {
      const ux = a[0] - c[0], uy = a[1] - c[1], uz = a[2] - c[2], vx = b[0] - c[0], vy = b[1] - c[1], vz = b[2] - c[2];
      return (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] >= -1e-12;
    });
    if (!star) { out.push(...list); continue; }
    for (const [a, b] of loop) out.push({ p: [c, a, b], nrm: null, cap: true, n });
  }
  return { ...clip, tris: out };
}
