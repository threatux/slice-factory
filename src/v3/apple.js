// v3 apple geometry (recipe.object.shape === "apple"), pure + deterministic, no CSG library.
//  - parametric closed apple: revolved profile (shoulders wider than the base, top + bottom dimples) times a 5-lobe factor
//    lobe(phi, y) that depends on height only, so the inside test is exact: p is inside iff (rho / lobe, y) lies inside the 2D
//    profile polygon (ray casting);
//  - clipAppleCell(): sequential Sutherland-Hodgman clipping of the closed surface by the 6 AABB planes of one grid cell.
//    Points carry their smooth normal (6 components) so clipped skin stays smoothly shaded; every plane that cuts the solid
//    gets a flat cap built from the chained cut edges (any section: non-convex dimple notches, several contours, rings) and
//    triangulated with earcut; cut points are interpolated in a canonical edge order, so shared edges match bit for bit;
//  - appleCellKeep(): exact (clipped volume) or cell-centre membership, shared by the timeline and the debris.
import * as THREE from 'three';

const EPS = 1e-7;
const PHI0 = 0.0123; // angular offset: no skin vertex lies exactly on the x = 0 / z = 0 cut planes
const POLE = [3.1e-4, 1.7e-4]; // pole vertices nudged off the axis planes the same way

const DEF = { radius: 0.6, squash: 0.92, shoulder: 0.08, taper: 0.1, dimpleTop: [0.35, 0.38], dimpleBottom: [0.2, 0.35], lobes: [0.028, 0.03], rings: 96, segments: 160 };

const cache = new Map();

/** Apple description for an object config (cached): profile polygon, bounding size, lobe, inside test, radius table. */
export function appleInfo(cfg = {}) {
  const c = { ...DEF, ...(cfg.apple ?? {}), radius: cfg.radius ?? DEF.radius };
  const key = JSON.stringify(c);
  if (cache.has(key)) return cache.get(key);
  const R = c.radius;
  const raw = (th) => {
    const co = Math.cos(th), si = Math.sin(th);
    const rho = R * si * (1 + c.shoulder * co) * (1 - c.taper * Math.max(0, -co) ** 2);
    const y = R * c.squash * co - R * c.dimpleTop[0] * Math.exp(-((th / c.dimpleTop[1]) ** 2)) + R * c.dimpleBottom[0] * Math.exp(-(((Math.PI - th) / c.dimpleBottom[1]) ** 2));
    return [rho, y];
  };
  // vertical centring: bounding box centred on the origin (timeline convention)
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i <= 2000; i++) { const [, y] = raw((Math.PI * i) / 2000); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
  const yc = (ymin + ymax) / 2, Hh = (ymax - ymin) / 2;
  const prof = (th) => { const [r, y] = raw(th); return [r, y - yc]; };
  const lobe = (phi, y) => 1 + (c.lobes[0] + c.lobes[1] * Math.max(0, -y / Hh)) * Math.cos(5 * phi);
  // 2D profile polygon (rho, y): axis top -> skin -> axis bottom, closed along the axis
  const poly = [];
  const NP = 720;
  for (let i = 0; i <= NP; i++) poly.push(prof((Math.PI * i) / NP));
  let rmax = 0;
  for (const [r, y] of poly) rmax = Math.max(rmax, r * (1 + c.lobes[0] + c.lobes[1] * Math.max(0, -y / Hh)));
  const inside2 = (r, y) => { // ray casting along +rho (polygon closed by the axis segment rho = 0)
    let inn = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ri, yi] = poly[i], [rj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && r < ((rj - ri) * (y - yi)) / (yj - yi) + ri) inn = !inn;
    }
    return inn;
  };
  const inside = (x, y, z) => inside2(Math.hypot(x, z) / lobe(Math.atan2(z, x), y), y);
  // surface distance along polar angle alpha (from +y) of the lobe-free profile: s(alpha), star-shaped from the origin
  const NA = 128, radTab = new Float32Array(NA + 1);
  for (let k = 0; k <= NA; k++) {
    const a = (Math.PI * k) / NA, dr = Math.sin(a), dy = Math.cos(a);
    let lo = 0, hi = 2 * Math.max(rmax, Hh);
    for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if (inside2(m * dr, m * dy)) lo = m; else hi = m; }
    radTab[k] = lo;
  }
  // dimple bands: horizontal cuts must stay below the top dimple floor / above the bottom one (single-contour sections)
  const topFloor = prof(0)[1], botFloor = prof(Math.PI)[1];
  const info = { cfg: c, R, Hh, W: 2 * rmax, size: [2 * rmax, 2 * Hh, 2 * rmax], prof, lobe, inside, inside2, radTab, safeY: [botFloor, topFloor], top: [0, topFloor, 0] };
  cache.set(key, info);
  return info;
}

/** Normalised radius of an apple-local point (0 centre, 1 skin): |(rho/lobe, y)| / s(alpha). */
export function appleRadius(A, x, y, z) {
  const rho = Math.hypot(x, z) / A.lobe(Math.atan2(z, x), y);
  const d = Math.hypot(rho, y);
  if (d < 1e-9) return 0;
  const f = (Math.acos(Math.max(-1, Math.min(1, y / d))) / Math.PI) * (A.radTab.length - 1);
  const i = Math.min(A.radTab.length - 2, Math.floor(f)), u = f - i;
  return d / (A.radTab[i] * (1 - u) + A.radTab[i + 1] * u);
}

/** Closed skin as non-indexed CCW-outward triangles; every point is [x, y, z, nx, ny, nz] (smooth vertex normal). */
export function appleTriangles(A) {
  const NT = A.cfg.rings, NP = A.cfg.segments;
  const V = [];
  const top = (() => { const [, y] = A.prof(0); return [POLE[0], y, POLE[1]]; })();
  const bot = (() => { const [, y] = A.prof(Math.PI); return [POLE[0], y, POLE[1]]; })();
  for (let i = 1; i < NT; i++) {
    const [r, y] = A.prof((Math.PI * i) / NT), row = [];
    for (let j = 0; j < NP; j++) {
      const phi = PHI0 + (2 * Math.PI * j) / NP, rr = r * A.lobe(phi, y);
      row.push([rr * Math.cos(phi), y, rr * Math.sin(phi)]);
    }
    V.push(row);
  }
  const faces = [];
  const at = (i, j) => V[i][((j % NP) + NP) % NP];
  for (let j = 0; j < NP; j++) faces.push([top, at(0, j + 1), at(0, j)]);
  for (let i = 0; i < NT - 2; i++) for (let j = 0; j < NP; j++) {
    faces.push([at(i, j), at(i, j + 1), at(i + 1, j)], [at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)]);
  }
  for (let j = 0; j < NP; j++) faces.push([at(NT - 2, j), at(NT - 2, j + 1), bot]);
  // area-weighted vertex normals on the shared point objects
  const N = new Map();
  const acc = (p, n) => { const o = N.get(p); if (o) { o[0] += n[0]; o[1] += n[1]; o[2] += n[2]; } else N.set(p, [...n]); };
  for (const [a, b, c] of faces) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    acc(a, n); acc(b, n); acc(c, n);
  }
  const P6 = new Map();
  const p6 = (p) => {
    let q = P6.get(p);
    if (!q) { const n = N.get(p), l = Math.hypot(...n) || 1; q = [p[0], p[1], p[2], n[0] / l, n[1] / l, n[2] / l]; P6.set(p, q); }
    return q;
  };
  return faces.map((f) => f.map(p6));
}

/** Canonical edge order: both faces sharing an edge interpolate it from the same endpoint -> bit-identical cut points. */
const less = (A, B) => (A[0] !== B[0] ? A[0] < B[0] : A[1] !== B[1] ? A[1] < B[1] : A[2] < B[2]);
const key = (p) => `${p[0]},${p[1]},${p[2]}`;

/**
 * Sutherland-Hodgman of one convex face (6-component points: position + normal, lerped) against n·p <= d.
 * Returns { out, seg }: seg = [Y, X] is the cap edge this face leaves on the plane (opposite to the face's own on-plane edge
 * X -> Y, so the cap comes out CCW seen from +n), or null.
 */
function clipFace(pts, n, d) {
  const out = [];
  let X = null, Y = null;
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    const A = pts[i], B = pts[(i + 1) % m];
    const da = n[0] * A[0] + n[1] * A[1] + n[2] * A[2] - d, db = n[0] * B[0] + n[1] * B[1] + n[2] * B[2] - d;
    const ina = da <= EPS, inb = db <= EPS;
    if (ina) out.push(A);
    if (ina !== inb) {
      const [P, Q, dp, dq] = less(A, B) ? [A, B, da, db] : [B, A, db, da];
      const t = dp / (dp - dq), C = new Array(P.length);
      for (let k = 0; k < P.length; k++) C[k] = P[k] + (Q[k] - P[k]) * t;
      for (const a of [0, 1, 2]) if (n[a]) C[a] = n[a] * d; // exactly on the plane
      out.push(C);
      if (ina) X = C; else Y = C;
    } else if (ina && inb && da >= -EPS && db >= -EPS) { X = A; Y = B; } // edge lying on the plane (degenerate touch)
  }
  return { out: out.length >= 3 ? out : null, seg: X && Y && key(X) !== key(Y) ? [Y, X] : null };
}

/**
 * Ear clipping of a simple CCW polygon that keeps EVERY vertex (earcut drops collinear points, which would leave T-junctions
 * where cut lines of two planes meet). An ear is a strictly convex vertex whose triangle contains no other vertex, not even on
 * its boundary; if none exists (numerically degenerate rest) the flattest vertex is clipped as a zero-area triangle.
 */
function earClip(P) {
  const idx = P.map((_, i) => i), out = [];
  const cr = (a, b, c) => (P[b].x - P[a].x) * (P[c].y - P[a].y) - (P[c].x - P[a].x) * (P[b].y - P[a].y);
  const inTri = (q, a, b, c) => {
    const e = -1e-12;
    return cr(a, b, q) >= e && cr(b, c, q) >= e && cr(c, a, q) >= e;
  };
  let start = 0;
  while (idx.length > 3) {
    const n = idx.length;
    let found = -1;
    for (let s = 0; s < n && found < 0; s++) {
      const k = (start + s) % n, a = idx[(k + n - 1) % n], b = idx[k], c = idx[(k + 1) % n];
      if (cr(a, b, c) <= 1e-14) continue;
      let ok = true;
      for (let m = 0; m < n && ok; m++) {
        const q = idx[m];
        if (q === a || q === b || q === c) continue;
        if ((P[q].x === P[a].x && P[q].y === P[a].y) || (P[q].x === P[c].x && P[q].y === P[c].y)) continue;
        if (inTri(q, a, b, c)) ok = false;
      }
      if (ok) found = k;
    }
    if (found < 0) { // degenerate remainder: clip the vertex with the largest turn (zero-area fill, topology stays closed)
      let best = 0, bv = -Infinity;
      for (let k = 0; k < n; k++) { const v = cr(idx[(k + n - 1) % n], idx[k], idx[(k + 1) % n]); if (v > bv) { bv = v; best = k; } }
      found = best;
    }
    out.push([idx[(found + n - 1) % n], idx[found], idx[(found + 1) % n]]);
    idx.splice(found, 1);
    start = Math.max(0, found - 1);
  }
  out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/**
 * Cap on plane n from the directed edges the clipped faces left on it: chain them into closed loops, classify outer loops
 * (CCW around +n) and holes (CW), triangulate with earClip(). Works for any section (non-star, several contours, rings).
 * Returns triangles [[A, B, C], ...] (3-component points shared with the faces -> exact edge matching), CCW around +n.
 */
function capTriangles(segs, n) {
  if (segs.length < 3) return [];
  const next = new Map();
  for (const [a, b] of segs) next.set(key(a), [a, b]);
  const N = new THREE.Vector3(...n), U = new THREE.Vector3(Math.abs(n[0]) < 0.9 ? 1 : 0, Math.abs(n[0]) < 0.9 ? 0 : 1, 0);
  U.addScaledVector(N, -U.dot(N)).normalize();
  const Wv = new THREE.Vector3().crossVectors(N, U);
  const uv = (p) => new THREE.Vector2(p[0] * U.x + p[1] * U.y + p[2] * U.z, p[0] * Wv.x + p[1] * Wv.y + p[2] * Wv.z);
  const used = new Set(), loops = [];
  for (const [a0] of segs) {
    const k0 = key(a0);
    if (used.has(k0)) continue;
    const loop = [];
    let k = k0, guard = 0;
    while (!used.has(k) && next.has(k) && guard++ < 1e6) { used.add(k); const [a, b] = next.get(k); loop.push(a); k = key(b); }
    if (k === k0 && loop.length >= 3) loops.push(loop);
  }
  const area = (L) => { let s = 0; for (let i = 0; i < L.length; i++) { const p = uv(L[i]), q = uv(L[(i + 1) % L.length]); s += p.x * q.y - q.x * p.y; } return s / 2; };
  const outers = [], holes = [];
  for (const L of loops) { const s = area(L); if (Math.abs(s) < 1e-10) continue; (s > 0 ? outers : holes).push(L); }
  const inPoly = (pt, L) => { let c = false; const P = L.map(uv); for (let i = 0, j = P.length - 1; i < P.length; j = i++) { if ((P[i].y > pt.y) !== (P[j].y > pt.y) && pt.x < ((P[j].x - P[i].x) * (pt.y - P[i].y)) / (P[j].y - P[i].y) + P[i].x) c = !c; } return c; };
  const tris = [];
  for (const O of outers) {
    const H = holes.filter((h) => inPoly(uv(h[0]), O));
    if (H.length) { // rings (not produced by the v3 recipes): earcut with holes
      const pts = [...O, ...H.flat()];
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(O.map(uv), H.map((h) => h.map(uv)))) {
        const a = uv(pts[i]), b = uv(pts[j]), c = uv(pts[k]);
        tris.push((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y) >= 0 ? [pts[i], pts[j], pts[k]] : [pts[i], pts[k], pts[j]]);
      }
    } else for (const [i, j, k] of earClip(O.map(uv))) tris.push([O[i], O[j], O[k]]);
  }
  return tris;
}

/**
 * Apple ∩ AABB [lo, hi]. Returns { tris: [{ p: [A,B,C], nrm: [nA,nB,nC] | null, cap, n }], volume, centroid } (apple-local).
 * Every face stays a triangle (caps are triangulated as soon as they are built), so each clipped face is convex and leaves at
 * most one edge on the next plane. x planes are processed first: skin triangles outside the cell's x slab are dropped up front.
 */
export function clipAppleCell(tris, A, lo, hi) {
  const ext = [A.size[0] / 2, A.size[1] / 2, A.size[2] / 2]; // apple: [W/2, Hh, W/2]; watermelon wedge: [W/2, Hh, T/2]
  let faces = [];
  for (const t of tris) {
    const xa = t[0][0], xb = t[1][0], xc = t[2][0];
    if (Math.min(xa, xb, xc) > hi[0] + EPS || Math.max(xa, xb, xc) < lo[0] - EPS) continue;
    let inside = true;
    for (let a = 0; a < 3 && inside; a++) {
      if (Math.min(t[0][a], t[1][a], t[2][a]) <= lo[a] + EPS || Math.max(t[0][a], t[1][a], t[2][a]) >= hi[a] - EPS) inside = false;
    }
    faces.push({ pts: t, cap: false, n: null, inside });
  }
  for (let a = 0; a < 3; a++) for (const side of [-1, 1]) {
    const n = [0, 0, 0]; n[a] = side;
    const d = side > 0 ? hi[a] : -lo[a];
    if (side > 0 ? hi[a] >= ext[a] - 1e-9 : lo[a] <= -ext[a] + 1e-9) continue;
    const next = [], segs = [];
    for (const f of faces) {
      if (f.inside) { next.push(f); continue; }
      const r = clipFace(f.pts, n, d);
      if (r.seg) segs.push(r.seg);
      if (!r.out) continue;
      if (r.out.length === 3) next.push({ pts: r.out, cap: f.cap, n: f.n, inside: false });
      else for (let i = 1; i + 1 < r.out.length; i++) next.push({ pts: [r.out[0], r.out[i], r.out[i + 1]], cap: f.cap, n: f.n, inside: false });
    }
    faces = next;
    for (const t of capTriangles(segs, n)) faces.push({ pts: t, cap: true, n, inside: false });
  }
  const out = [];
  let vol = 0; const cen = [0, 0, 0];
  for (const f of faces) {
    const [P0, P1, P2] = f.pts;
    const nrm = f.cap ? null : f.pts.map((q) => { const l = Math.hypot(q[3], q[4], q[5]) || 1; return [q[3] / l, q[4] / l, q[5] / l]; });
    out.push({ p: [P0.slice(0, 3), P1.slice(0, 3), P2.slice(0, 3)], nrm, cap: f.cap, n: f.n });
    const v = (P0[0] * (P1[1] * P2[2] - P1[2] * P2[1]) - P0[1] * (P1[0] * P2[2] - P1[2] * P2[0]) + P0[2] * (P1[0] * P2[1] - P1[1] * P2[0])) / 6;
    vol += v;
    for (let k = 0; k < 3; k++) cen[k] += (v * (P0[k] + P1[k] + P2[k])) / 4;
  }
  if (vol > 0) for (let k = 0; k < 3; k++) cen[k] /= vol;
  return { tris: out, volume: vol, centroid: cen };
}

/** Whole-apple triangles in the clipped-piece format (intact mesh uses the very same skin). */
export function wholeApple(tris) {
  return { tris: tris.map((t) => ({ p: t.map((q) => q.slice(0, 3)), nrm: t.map((q) => q.slice(3, 6)), cap: false, n: null })) };
}

/**
 * BufferGeometry of clipped apple triangles, positions relative to `pivot`. Attributes: position, normal (smooth skin normal,
 * plane normal on caps), aSph (apple-local position -> layered core shader), aCap (1 = flat cut face); hull points for colliders.
 */
export function applePieceGeometry(clip, pivot = [0, 0, 0]) {
  const T = clip.tris, n = T.length * 3;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), sph = new Float32Array(n * 3), cap = new Float32Array(n);
  const hull = new Map();
  let j = 0;
  for (const t of T) {
    t.p.forEach((q, k) => {
      pos.set([q[0] - pivot[0], q[1] - pivot[1], q[2] - pivot[2]], j * 3);
      sph.set(q, j * 3);
      nor.set(t.cap ? t.n : t.nrm[k], j * 3);
      cap[j] = t.cap ? 1 : 0;
      const key = `${Math.round(q[0] * 2e3)},${Math.round(q[1] * 2e3)},${Math.round(q[2] * 2e3)}`;
      if (!hull.has(key)) hull.set(key, [q[0] - pivot[0], q[1] - pivot[1], q[2] - pivot[2]]);
      j++;
    });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aSph', new THREE.BufferAttribute(sph, 3));
  g.setAttribute('aCap', new THREE.BufferAttribute(cap, 1));
  g.computeBoundingSphere();
  return { geometry: g, hull: [...hull.values()] };
}

const keepCache = new Map();
/**
 * Cells of an n_x x n_y x n_z grid over the apple's bounding box that hold a piece.
 * mode "volume": exact clipped volume >= minFrac of the cell (R1-R3; also returns the clips, cached per grid);
 * mode "center": cell centre inside the apple (micro rounds).
 */
export function appleCellKeep(A, grid, mode = 'center', minFrac = 0.03) {
  const key = `${A.key ?? ''}${A.W},${A.Hh},${grid.join('x')},${mode},${minFrac}`;
  if (keepCache.has(key)) return keepCache.get(key);
  const [nx, ny, nz] = grid, keep = new Uint8Array(nx * ny * nz), clips = mode === 'volume' ? [] : null;
  const [W, H, D] = A.size, cw = W / nx, ch = H / ny, cd = D / nz;
  const tris = mode === 'volume' ? (A.triangles ? A.triangles() : appleTriangles(A)) : null; // other v3 shapes bring their own closed skin
  let i = 0;
  for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++, i++) {
    const lo = [-W / 2 + a * cw, -H / 2 + b * ch, -D / 2 + c * cd], hi = [lo[0] + cw, lo[1] + ch, lo[2] + cd];
    if (mode === 'center') { keep[i] = A.inside(lo[0] + cw / 2, lo[1] + ch / 2, lo[2] + cd / 2) ? 1 : 0; continue; }
    const clip = clipAppleCell(tris, A, lo, hi);
    keep[i] = clip.volume >= minFrac * cw * ch * cd ? 1 : 0;
    clips.push(keep[i] ? { clip, lo, hi } : null);
  }
  const out = { keep, clips, count: keep.reduce((s, v) => s + v, 0) };
  keepCache.set(key, out);
  return out;
}
