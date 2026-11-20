// Cylinder-mode computational geometry (recipe.object.shape === "cylinder"), pure + deterministic, no CSG library.
// Same approach as sphere.js: a closed, subdivided convex solid (side wall + top/bottom lids) is clipped by the 6 AABB planes
// of one grid cell (Sutherland-Hodgman per face); every plane that cuts the solid gets a watertight flat cap (contour sorted
// around its centroid, fan-triangulated with the outward plane normal). Faces keep their source kind (side / top / bottom / cut)
// so the outer skin gets its exact analytic cylinder UV after clipping (markings are split by the cut, never stretched).
import * as THREE from 'three';
import { clipPoly, capPolygon } from './sphere.js';
import { URANIUM_ATLAS as A } from '../textures.js';

const EPS = 1e-7;
const K_SIDE = 0, K_TOP = 1, K_BOT = 2, K_CUT = 3;
const PHI0 = 0.0123; // angular offset: no side vertex lies exactly on an axis plane

/**
 * Analytic atlas UV of a skin point (kind = side | top | bottom). Side: u = 0.5 at +z (camera side at t = 0), seam at -z;
 * v spans the upper 2/3 of the atlas (canvas rows 0..side). Lids: two discs in the bottom strip of the atlas.
 */
export function cylUV(kind, x, y, z, R, H) {
  if (kind === K_SIDE) {
    let u = 0.5 + Math.atan2(x, z) / (2 * Math.PI);
    u -= Math.floor(u);
    const py = ((H / 2 - y) / H) * A.side;
    return [u, 1 - py / A.H];
  }
  const [cx, cy] = A.caps[kind === K_TOP ? 0 : 1];
  const px = cx + (x / R) * A.capR, py = cy + ((kind === K_TOP ? z : -z) / R) * A.capR;
  return [px / A.W, 1 - py / A.H];
}

/** Closed cylinder (axis y, centre 0) as non-indexed CCW-outward triangles [{ p: [A,B,C], kind }]. */
export function cylinderTriangles(R, H, seg = 128, rings = 25) {
  const tris = [];
  const P = (k, y) => { const a = PHI0 + (k / seg) * 2 * Math.PI; return [R * Math.sin(a), y, R * Math.cos(a)]; };
  for (let k = 0; k < seg; k++) for (let j = 0; j < rings; j++) {
    const y0 = -H / 2 + (j / rings) * H, y1 = -H / 2 + ((j + 1) / rings) * H;
    const a0 = P(k, y0), b0 = P(k + 1, y0), a1 = P(k, y1), b1 = P(k + 1, y1);
    // outward: angle increases from +z toward +x (sin, cos) -> CCW seen from outside is a0, b0, b1
    tris.push({ p: [a0, b0, b1], kind: K_SIDE }, { p: [a0, b1, a1], kind: K_SIDE });
  }
  // lids: fan around a slightly off-axis centre (never exactly on the x = 0 / z = 0 cut planes)
  const ct = [3.1e-4, H / 2, 1.7e-4], cb = [3.1e-4, -H / 2, 1.7e-4];
  for (let k = 0; k < seg; k++) {
    const a = P(k, H / 2), b = P(k + 1, H / 2), c = P(k, -H / 2), d = P(k + 1, -H / 2);
    tris.push({ p: [ct, a, b], kind: K_TOP }, { p: [cb, d, c], kind: K_BOT });
  }
  return tris;
}

/**
 * Cells of an n_x x n_y x n_z grid over the box [-R, R] x [-H/2, H/2] x [-R, R] kept in cylinder mode (only x/z matter).
 * mode "center": cell centre inside the disc (micro pieces); "volume": >= minFrac of the cell's x/z footprint inside the disc.
 */
export function cylinderCellKeep(grid, R, mode = 'center', minFrac = 0.04) {
  const [nx, ny, nz] = grid, keep = new Uint8Array(nx * ny * nz);
  const cw = (2 * R) / nx, cd = (2 * R) / nz, S = 16;
  const col = new Uint8Array(nx * nz);
  for (let a = 0; a < nx; a++) for (let c = 0; c < nz; c++) {
    const x0 = -R + a * cw, z0 = -R + c * cd;
    if (mode === 'center') { col[a * nz + c] = Math.hypot(x0 + cw / 2, z0 + cd / 2) <= R ? 1 : 0; continue; }
    let inside = 0;
    for (let u = 0; u < S; u++) for (let w = 0; w < S; w++) if (Math.hypot(x0 + ((u + 0.5) * cw) / S, z0 + ((w + 0.5) * cd) / S) <= R) inside++;
    col[a * nz + c] = inside / (S * S) >= minFrac ? 1 : 0;
  }
  let i = 0;
  for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++, i++) keep[i] = col[a * nz + c];
  return keep;
}

/**
 * Cylinder ∩ AABB [lo, hi] by sequential convex clipping (x-lo, x-hi, y-lo, ...). Planes outside the solid are skipped.
 * Returns { tris: [{ p, kind, n }], volume, centroid } (cylinder-local coords; n = plane normal on cut caps).
 */
export function clipCylinderCell(tris, R, H, lo, hi) {
  const ext = [R, H / 2, R];
  let faces = [];
  for (const t of tris) {
    let inside = true;
    for (let a = 0; a < 3 && inside; a++) {
      if (Math.min(t.p[0][a], t.p[1][a], t.p[2][a]) <= lo[a] + EPS || Math.max(t.p[0][a], t.p[1][a], t.p[2][a]) >= hi[a] - EPS) inside = false;
    }
    faces.push({ pts: t.p, kind: t.kind, n: null, inside });
  }
  for (let a = 0; a < 3; a++) for (const side of [-1, 1]) {
    const n = [0, 0, 0]; n[a] = side;
    const d = side > 0 ? hi[a] : -lo[a];
    if (side > 0 ? hi[a] >= ext[a] - 1e-9 : lo[a] <= -ext[a] + 1e-9) continue;
    const next = [], hits = [];
    for (const f of faces) {
      if (f.inside) { next.push(f); continue; }
      const r = clipPoly(f.pts, n, d);
      for (const h of r.hits) hits.push(h);
      if (r.out) next.push({ pts: r.out, kind: f.kind, n: f.n, inside: false });
    }
    faces = next;
    const cap = capPolygon(hits, n);
    if (cap) faces.push({ pts: cap.pts, kind: K_CUT, n, inside: false });
  }
  const out = [];
  let vol = 0; const cen = [0, 0, 0];
  const push = (P0, P1, P2, f) => {
    out.push({ p: [P0, P1, P2], kind: f.kind, n: f.n });
    const v = (P0[0] * (P1[1] * P2[2] - P1[2] * P2[1]) - P0[1] * (P1[0] * P2[2] - P1[2] * P2[0]) + P0[2] * (P1[0] * P2[1] - P1[1] * P2[0])) / 6;
    vol += v;
    for (let k = 0; k < 3; k++) cen[k] += (v * (P0[k] + P1[k] + P2[k])) / 4;
  };
  for (const f of faces) {
    if (f.kind === K_CUT) {
      const c = [0, 0, 0];
      for (const q of f.pts) { c[0] += q[0] / f.pts.length; c[1] += q[1] / f.pts.length; c[2] += q[2] / f.pts.length; }
      for (let i = 0; i < f.pts.length; i++) push(c, f.pts[i], f.pts[(i + 1) % f.pts.length], f);
    } else for (let i = 1; i + 1 < f.pts.length; i++) push(f.pts[0], f.pts[i], f.pts[i + 1], f);
  }
  if (vol > 0) for (let k = 0; k < 3; k++) cen[k] /= vol;
  return { tris: out, volume: vol, centroid: cen };
}

/**
 * BufferGeometry of cylinder triangles (clipped piece or the whole rod), positions relative to `pivot`. Attributes: position,
 * normal (radial on the wall, ±y on the lids, plane normal on cuts), uv (atlas, side wrap fixed per triangle; 0 on cuts),
 * aSph (cylinder-local position -> radial layers), aCap (1 = flat cut face). Also returns hull points for the collider.
 */
export function cylinderPieceGeometry(tris, R, H, pivot = [0, 0, 0]) {
  const n = tris.length * 3;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), sph = new Float32Array(n * 3), cap = new Float32Array(n);
  const hull = new Map();
  let j = 0;
  for (const t of tris) {
    const cut = t.kind === K_CUT;
    const uvs = cut ? null : t.p.map((q) => cylUV(t.kind, q[0], q[1], q[2], R, H));
    if (uvs && t.kind === K_SIDE) {
      const us = uvs.map((x) => x[0]);
      if (Math.max(...us) - Math.min(...us) > 0.5) uvs.forEach((x) => { if (x[0] < 0.5) x[0] += 1; });
    }
    t.p.forEach((q, k) => {
      pos.set([q[0] - pivot[0], q[1] - pivot[1], q[2] - pivot[2]], j * 3);
      sph.set(q, j * 3);
      if (cut) nor.set(t.n, j * 3);
      else if (t.kind === K_TOP) nor.set([0, 1, 0], j * 3);
      else if (t.kind === K_BOT) nor.set([0, -1, 0], j * 3);
      else { const l = Math.hypot(q[0], q[2]) || 1; nor.set([q[0] / l, 0, q[2] / l], j * 3); }
      if (uvs) uv.set(uvs[k], j * 2);
      cap[j] = cut ? 1 : 0;
      const key = `${Math.round(q[0] * 2e3)},${Math.round(q[1] * 2e3)},${Math.round(q[2] * 2e3)}`;
      if (!hull.has(key)) hull.set(key, [q[0] - pivot[0], q[1] - pivot[1], q[2] - pivot[2]]);
      j++;
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aSph', new THREE.BufferAttribute(sph, 3));
  g.setAttribute('aCap', new THREE.BufferAttribute(cap, 1));
  g.computeBoundingSphere();
  return { geometry: g, hull: [...hull.values()] };
}
