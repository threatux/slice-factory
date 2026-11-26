// v3.1 watermelon wedge geometry (recipe.object.shape === "watermelon-wedge"), pure + deterministic.
//  - the wedge is a rounded slab: a circular sector (apex up, rind arc down, half-angle alpha) whose corners are filleted (rc)
//    and whose rim is rounded (b), extruded along z (thickness ~38% of the width). Exact SDF:
//      d2 = sdPie(apex - p.xy) - rc,  sd = |max((d2, |z| - h), 0)| + min(max(d2, |z| - h), 0) - b,   h = T/2 - b;
//  - wedgeTriangles(): closed, watertight surface in the clipper format (6-component points: position + analytic normal),
//    rim rows Q + b (cos phi N, sin phi), both flat faces fanned from their centroid (convex outline: no T-junctions);
//  - layers by distance rho from the apex (= melon centre): rind (outer band of the arc), white pith, ruby flesh; seeds are
//    explicit teardrop ellipsoids (12 obsidian + 3 gold), shared by the cap shader, the inner meshes and the shard colouring.
// The info object plugs into the apple clipper (clipAppleCell / appleCellKeep / applePieceGeometry) unchanged.
import { mulberry32 } from '../util.js';

const DEF = { radius: 1.15, halfAngle: 38, thickness: 0.38, round: 0.06, fillet: 0.055, rind: 0.09, pith: 0.065,
  arcSeg: 128, filletSeg: 10, apexSeg: 16, rimSeg: 6, seeds: 12, seedSeed: 41 };
const JIT = [1.71e-4, 1.13e-4, 1.37e-4]; // no vertex lies exactly on an axis cut plane (symmetric shape)

const cache = new Map();

/** Wedge description (cached): sizes, SDF / inside test, layer + seed tables, radius for the debris kinematics. */
export function wedgeInfo(cfg = {}) {
  const c = { ...DEF, ...(cfg.wedge ?? {}), radius: cfg.radius ?? DEF.radius };
  const key = 'melon:' + JSON.stringify(c);
  if (cache.has(key)) return cache.get(key);
  const al = (c.halfAngle * Math.PI) / 180, sa = Math.sin(al), ca = Math.cos(al);
  const Rw = c.radius, b = c.round, rc = c.fillet, R0 = Rw - rc - b;
  const W = 2 * (R0 * sa + rc + b), H = R0 + 2 * (rc + b), T = c.thickness * W, h = T / 2 - b;
  const apexY = H / 2 - rc - b;
  const sdPie = (px, py) => { // iq: sector opening along +y from the origin, aperture (sa, ca), radius R0
    px = Math.abs(px);
    const l = Math.hypot(px, py) - R0;
    const d = Math.min(R0, Math.max(0, px * sa + py * ca));
    const m = Math.hypot(px - sa * d, py - ca * d);
    return Math.max(l, m * Math.sign(ca * px - sa * py));
  };
  const sd = (x, y, z) => {
    const d2 = sdPie(x, apexY - y) - rc, dz = Math.abs(z) - h;
    return Math.hypot(Math.max(d2, 0), Math.max(dz, 0)) + Math.min(Math.max(d2, dz), 0) - b;
  };
  const inside = (x, y, z) => sd(x, y, z) < 0;
  const rho = (x, y) => Math.hypot(x, y - apexY);
  const rindIn = Rw - c.rind, pithIn = rindIn - c.pith;

  // seeds: teardrops pointing at the apex (melon centre), [x, y, z, L, Wd, Th, gold]
  const rnd = mulberry32(c.seedSeed);
  const seeds = [];
  const put = (r, th, z, gold, dir = null) => {
    const x = r * Math.sin(th), y = apexY - r * Math.cos(th);
    const s = gold ? [0.078, 0.044, 0.042] : [0.05, 0.03, 0.024]; // gold ~1.5x the obsidian seeds
    seeds.push({ p: [x, y, z], dir: dir ?? [-Math.sin(th), Math.cos(th)], L: s[0], Wd: s[1], Th: s[2], gold });
  };
  // one gold seed per round (round k shows gold k only, see melon-materials uGoldK). Each centre sits a few mm inside ONE piece next to a
  // single cut plane (clear of every other plane of its round), so it reads as one seed: #0 left of the R1 cut x = 0; #1 just under the
  // R2 y = 0 cut (lies along x so the up-facing face shows a teardrop); #2 on the R3 z = -T/4 face (R3 only, camera-facing +z).
  const gold = [
    [-0.012, apexY - 0.5 * Rw, 0.05],
    [-0.2, -0.006, 0.12, [1, 0]],
    [-0.24, 0.13, -T / 4 - 0.006],
  ];
  for (const [x, y, z, dir] of gold) {
    const r = rho(x, y), th = Math.atan2(x, apexY - y);
    put(r, th, z, true, dir);
  }
  // obsidian seeds: two staggered arcs in the flesh band, alternating front / back layers, a few right on the x = 0 cut
  const nS = c.seeds;
  for (let i = 0; i < nS; i++) {
    const row = i % 2, k = Math.floor(i / 2), m = Math.ceil(nS / 2);
    const u = (k + 0.5) / m, th = (-0.78 + 1.56 * u) * al + (rnd() - 0.5) * 0.06 + (row ? 0.09 : -0.05);
    const r = (row ? 0.71 : 0.6) * Rw + (rnd() - 0.5) * 0.05 * Rw;
    const z = (row ? 1 : -1) * T * (0.13 + 0.1 * rnd());
    put(r, th, z, false);
  }
  const seedSD = (x, y, z, S) => {
    const qx = x - S.p[0], qy = y - S.p[1], qz = z - S.p[2];
    let u = qx * S.dir[0] + qy * S.dir[1];
    const v = -qx * S.dir[1] + qy * S.dir[0];
    u *= u > 0 ? 1.25 : 0.9; // teardrop: pointed toward the apex
    return Math.hypot(u / S.L, v / S.Wd, qz / S.Th) - 1;
  };
  /** Layer of a wedge-local point: 'rind' | 'pith' | 'flesh' | 'seed' | 'gold'. */
  const layer = (x, y, z) => {
    for (const S of seeds) if (seedSD(x, y, z, S) < 0) return S.gold ? 'gold' : 'seed';
    const r = rho(x, y);
    return r > rindIn ? 'rind' : r > pithIn ? 'pith' : 'flesh';
  };
  const info = {
    kind: 'watermelon', key, cfg: c, Rw, R0, rc, b, h, T, al, apexY, rindIn, pithIn,
    W, Hh: H / 2, size: [W, H, T], inside, sd, rho, seeds, seedSD, layer,
    radius: (x, y, z) => Math.min(1.2, rho(x, y) / Rw + 0.15 * Math.abs(z) / (T / 2)),
  };
  info.triangles = () => wedgeTriangles(info);
  cache.set(key, info);
  return info;
}

/** Core outline Q (sector dilated by rc), CCW seen from +z, with unit outward normals. */
function outline(A) {
  const { al, R0, rc, apexY, cfg: c } = A, sa = Math.sin(al), ca = Math.cos(al);
  const Q = [];
  const push = (x, y, nx, ny) => Q.push({ x, y, n: [nx, ny] });
  for (let i = 0; i < c.arcSeg; i++) { // bottom rind arc, left -> right
    const th = -al + (2 * al * i) / c.arcSeg, nx = Math.sin(th), ny = -Math.cos(th);
    push((R0 + rc) * nx, apexY + (R0 + rc) * ny, nx, ny);
  }
  const fil = (cx, cy, a0, a1, n) => { for (let i = 0; i < n; i++) { const a = a0 + ((a1 - a0) * i) / n; push(cx + rc * Math.cos(a), cy + rc * Math.sin(a), Math.cos(a), Math.sin(a)); } };
  const CR = [R0 * sa, apexY - R0 * ca], CL = [-R0 * sa, apexY - R0 * ca];
  fil(CR[0], CR[1], al - Math.PI / 2, al, c.filletSeg); // right rind corner
  push(CR[0] + rc * ca, CR[1] + rc * sa, ca, sa); // right flat side (straight: endpoints only, no collinear points)
  fil(0, apexY, al, Math.PI - al, c.apexSeg); // apex
  push(-rc * ca, apexY + rc * sa, -ca, sa); // left flat side
  fil(CL[0], CL[1], Math.PI - al, 1.5 * Math.PI - al, c.filletSeg); // left rind corner
  return Q;
}

/** Closed CCW-outward triangles; every point is [x, y, z, nx, ny, nz] (analytic normal, shared point objects). */
export function wedgeTriangles(A) {
  const Q = outline(A), n = Q.length, K = A.cfg.rimSeg, b = A.b, h = A.h;
  const rows = [];
  const mk = (q, phi, zc) => {
    const co = Math.cos(phi), si = Math.sin(phi);
    return [q.x + b * co * q.n[0] + JIT[0], q.y + b * co * q.n[1] + JIT[1], zc + b * si + JIT[2], co * q.n[0], co * q.n[1], si];
  };
  for (let k = 0; k <= K; k++) { const phi = -Math.PI / 2 + (Math.PI / 2) * (k / K); rows.push(Q.map((q) => mk(q, phi, -h))); }
  for (let k = 0; k <= K; k++) { const phi = (Math.PI / 2) * (k / K); rows.push(Q.map((q) => mk(q, phi, h))); }
  const faces = [];
  for (let r = 0; r + 1 < rows.length; r++) {
    const A0 = rows[r], A1 = rows[r + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // outline CCW from +z, rows go -z -> +z: (A0[i], A0[j], A1[i]) faces outward
      faces.push([A0[i], A0[j], A1[i]], [A0[j], A1[j], A1[i]]);
    }
  }
  const fan = (row, sign) => {
    let cx = 0, cy = 0;
    for (const p of row) { cx += p[0]; cy += p[1]; }
    const C = [cx / n, cy / n, row[0][2], 0, 0, sign];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push(sign > 0 ? [C, row[i], row[j]] : [C, row[j], row[i]]);
    }
  };
  // flat faces: their rim rows carry exactly the face normal (phi = +-pi/2), so the points are shared as-is
  fan(rows[rows.length - 1], 1);
  fan(rows[0], -1);
  // sanity: orientation (outward) of a rim face
  const [a, bb, cc] = faces[0];
  const ux = bb[0] - a[0], uy = bb[1] - a[1], uz = bb[2] - a[2], vx = cc[0] - a[0], vy = cc[1] - a[1], vz = cc[2] - a[2];
  const gn = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  if (gn[0] * a[3] + gn[1] * a[4] + gn[2] * a[5] < 0) for (const f of faces) f.reverse();
  return faces;
}
