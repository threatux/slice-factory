// Sphere-mode computational geometry (recipe.object.shape === "sphere"), pure + deterministic, no CSG library:
//  - sphereCellKeep(): which grid cells of the bounding cube actually hold a piece of the ball (shared by timeline + debris);
//  - clipSphereCell(): convex-polyhedron clipping of a subdivided ball by the 6 AABB planes of one cell (Sutherland-Hodgman per
//    face); every plane that cuts the solid gets a watertight flat cap (contour points sorted by angle around their centroid,
//    fan triangulation with the outward plane normal), so pieces are closed convex shells (no holes, no inverted faces).
import * as THREE from 'three';

const EPS = 1e-7;

/** Outer surface of the ball: non-indexed icosphere triangles, slightly rotated so no vertex lies exactly on an axis plane. */
export function sphereTriangles(R, detail = 20) {
  const g = new THREE.IcosahedronGeometry(R, detail);
  g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.0137, 0.0291, 0.0073)));
  const p = g.attributes.position, tris = [];
  for (let i = 0; i < p.count; i += 3) tris.push([0, 1, 2].map((k) => [p.getX(i + k), p.getY(i + k), p.getZ(i + k)]));
  g.dispose();
  return tris;
}

/**
 * Cells of an n_x x n_y x n_z grid over the cube [-R, R]^3 that are kept in sphere mode.
 * mode "center": cell centre inside the ball (micro pieces, R4-R6);
 * mode "volume": >= minFrac of the cell volume inside the ball (8^3 sub-samples; R1-R3 drops the almost empty corner chips).
 */
export function sphereCellKeep(grid, R, mode = 'center', minFrac = 0.04) {
  const [nx, ny, nz] = grid, keep = new Uint8Array(nx * ny * nz);
  const cw = (2 * R) / nx, ch = (2 * R) / ny, cd = (2 * R) / nz, S = 8;
  let i = 0;
  for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++, i++) {
    const x0 = -R + a * cw, y0 = -R + b * ch, z0 = -R + c * cd;
    if (mode === 'center') { keep[i] = Math.hypot(x0 + cw / 2, y0 + ch / 2, z0 + cd / 2) <= R ? 1 : 0; continue; }
    let inside = 0;
    for (let u = 0; u < S; u++) for (let v = 0; v < S; v++) for (let w = 0; w < S; w++) {
      if (Math.hypot(x0 + ((u + 0.5) * cw) / S, y0 + ((v + 0.5) * ch) / S, z0 + ((w + 0.5) * cd) / S) <= R) inside++;
    }
    keep[i] = inside / (S * S * S) >= minFrac ? 1 : 0;
  }
  return keep;
}

/** Sutherland-Hodgman: clips polygon pts (array of [x,y,z]) to n·p <= d. Returns { out, hits } (hits = points on the plane). */
export function clipPoly(pts, n, d) {
  const out = [], hits = [];
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    const A = pts[i], B = pts[(i + 1) % m];
    const da = n[0] * A[0] + n[1] * A[1] + n[2] * A[2] - d, db = n[0] * B[0] + n[1] * B[1] + n[2] * B[2] - d;
    const ina = da <= EPS, inb = db <= EPS;
    if (ina) { out.push(A); if (da >= -EPS) hits.push(A); }
    if (ina !== inb) {
      const t = da / (da - db);
      const P = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
      out.push(P); hits.push(P);
    }
  }
  return { out: out.length >= 3 ? out : null, hits };
}

/** Convex cap polygon on plane (n, d) from its contour points: dedupe, sort by angle around the centroid (CCW seen from +n). */
export function capPolygon(points, n) {
  const seen = new Map(), uniq = [];
  for (const p of points) {
    const k = `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)},${Math.round(p[2] * 1e6)}`;
    if (!seen.has(k)) { seen.set(k, 1); uniq.push(p); }
  }
  if (uniq.length < 3) return null;
  const c = [0, 0, 0];
  for (const p of uniq) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= uniq.length; c[1] /= uniq.length; c[2] /= uniq.length;
  const N = new THREE.Vector3(...n), U = new THREE.Vector3(Math.abs(n[0]) < 0.9 ? 1 : 0, Math.abs(n[0]) < 0.9 ? 0 : 1, 0);
  U.addScaledVector(N, -U.dot(N)).normalize();
  const V = new THREE.Vector3().crossVectors(N, U); // (U, V, N) right-handed -> increasing angle = CCW around +n
  const ang = uniq.map((p) => {
    const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2];
    return { p, a: Math.atan2(dx * V.x + dy * V.y + dz * V.z, dx * U.x + dy * U.y + dz * U.z) };
  });
  ang.sort((A, B) => A.a - B.a);
  // area check (degenerate tangent touches produce no cap)
  let area = 0;
  for (let i = 0; i < ang.length; i++) {
    const A = ang[i].p, B = ang[(i + 1) % ang.length].p;
    const ax = A[0] - c[0], ay = A[1] - c[1], az = A[2] - c[2], bx = B[0] - c[0], by = B[1] - c[1], bz = B[2] - c[2];
    area += 0.5 * ((ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2]);
  }
  if (area < 1e-6) return null;
  return { pts: ang.map((x) => x.p), c };
}

/**
 * Ball (centre 0, radius R, given surface triangles) ∩ AABB [lo, hi]. Planes are processed in order (x-lo, x-hi, y-lo, ...):
 * every face of the current convex solid (sphere triangles + earlier caps) is clipped, and the points it leaves on the plane
 * form the new cap. Returns { tris: [{ p: [A,B,C], cap: bool, n: [nx,ny,nz] | null }], volume, centroid } (sphere-local coords).
 */
export function clipSphereCell(tris, R, lo, hi) {
  // quick accept: triangles strictly inside the box never cross a plane. Nothing is rejected up front: the solid must stay the
  // whole ball until each plane cuts it, otherwise caps would miss their interior corners (sequential convex clipping).
  let faces = [];
  for (const t of tris) {
    let inside = true;
    for (let a = 0; a < 3 && inside; a++) {
      if (Math.min(t[0][a], t[1][a], t[2][a]) <= lo[a] + EPS || Math.max(t[0][a], t[1][a], t[2][a]) >= hi[a] - EPS) inside = false;
    }
    faces.push({ pts: t, cap: false, n: null, inside });
  }
  for (let a = 0; a < 3; a++) for (const side of [-1, 1]) {
    const n = [0, 0, 0]; n[a] = side;
    const d = side > 0 ? hi[a] : -lo[a];
    if (side > 0 ? hi[a] >= R - 1e-9 : lo[a] <= -R + 1e-9) continue; // plane outside the ball: nothing to cut
    const next = [], hits = [];
    for (const f of faces) {
      if (f.inside) { next.push(f); continue; }
      const r = clipPoly(f.pts, n, d);
      for (const h of r.hits) hits.push(h);
      if (r.out) next.push({ pts: r.out, cap: f.cap, n: f.n, inside: false });
    }
    faces = next;
    const cap = capPolygon(hits, n);
    if (cap) faces.push({ pts: cap.pts, cap: true, n, inside: false });
  }
  // triangulate (fans: sphere polygons around vertex 0, caps around their centroid) + volume / centroid (divergence theorem)
  const out = [];
  let vol = 0; const cen = [0, 0, 0];
  const push = (A, B, C, f) => {
    out.push({ p: [A, B, C], cap: f.cap, n: f.n });
    const v = (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    vol += v;
    for (let k = 0; k < 3; k++) cen[k] += (v * (A[k] + B[k] + C[k])) / 4;
  };
  for (const f of faces) {
    if (f.cap) {
      const c = [0, 0, 0];
      for (const q of f.pts) { c[0] += q[0] / f.pts.length; c[1] += q[1] / f.pts.length; c[2] += q[2] / f.pts.length; }
      for (let i = 0; i < f.pts.length; i++) push(c, f.pts[i], f.pts[(i + 1) % f.pts.length], f);
    }
    else for (let i = 1; i + 1 < f.pts.length; i++) push(f.pts[0], f.pts[i], f.pts[i + 1], f);
  }
  if (vol > 0) for (let k = 0; k < 3; k++) cen[k] /= vol;
  return { tris: out, volume: vol, centroid: cen };
}

/** Equirectangular uv of a direction, matching THREE.SphereGeometry (x = -cos φ sin θ, y = cos θ, z = sin φ sin θ). */
export function sphereUV(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  let phi = Math.atan2(z, -x);
  if (phi < 0) phi += 2 * Math.PI;
  return [phi / (2 * Math.PI), 1 - Math.acos(Math.max(-1, Math.min(1, y / l))) / Math.PI];
}

/**
 * Piece geometry of a clipped cell, positions relative to `pivot` (cell centre). Attributes: position, normal (smooth radial
 * on the outer skin, flat plane normal on caps), uv (equirect, wrap-fixed per triangle; 0 on caps), aSph (sphere-local
 * position -> radial layers in the shader), aCap (1 = flat cut face). Also returns hull points (cell-local) for the collider.
 */
export function pieceGeometry(clip, pivot) {
  const T = clip.tris, n = T.length * 3;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), sph = new Float32Array(n * 3), cap = new Float32Array(n);
  const hull = new Map();
  let j = 0;
  for (const t of T) {
    const uvs = t.cap ? null : t.p.map((q) => sphereUV(q[0], q[1], q[2]));
    if (uvs) { // dateline wrap + pole u fix
      const us = uvs.map((x) => x[0]);
      if (Math.max(...us) - Math.min(...us) > 0.5) uvs.forEach((x) => { if (x[0] < 0.5) x[0] += 1; });
      const poleish = uvs.map((x, k) => Math.hypot(t.p[k][0], t.p[k][2]) < 1e-4);
      if (poleish.some(Boolean)) { const ok = uvs.filter((_, k) => !poleish[k]); const um = ok.reduce((s, x) => s + x[0], 0) / Math.max(1, ok.length); uvs.forEach((x, k) => { if (poleish[k]) x[0] = um; }); }
    }
    t.p.forEach((q, k) => {
      pos.set([q[0] - pivot[0], q[1] - pivot[1], q[2] - pivot[2]], j * 3);
      sph.set(q, j * 3);
      if (t.cap) nor.set(t.n, j * 3);
      else { const l = Math.hypot(q[0], q[1], q[2]) || 1; nor.set([q[0] / l, q[1] / l, q[2] / l], j * 3); }
      if (uvs) uv.set(uvs[k], j * 2);
      cap[j] = t.cap ? 1 : 0;
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
