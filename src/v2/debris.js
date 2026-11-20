// v2 debris: the shattered ingot. One "set" per round, spawned 1:1 from the ingot cells at the impact pose.
//  - physics "rapier": real rigid bodies (R1-R3, <= 64 pieces) in a private Rapier world (gravity = timeline G);
//  - physics "analytic": deterministic per-piece integrator (ballistics, exact box-vs-table contact, bounce, Coulomb friction,
//    face-down settling) for 512 .. 15k+ InstancedMesh pieces;
//  - gather(): pieces fly back into their home cells (between rounds: reassembly; finale: easeInCubic + vortex rewind).
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { makeShardMaterial, SHARD_LOOKS, makeRubiksShardMaterial } from '../slabs.js';
import { makeGoldCast, makeEmeraldCap, makeRubyCap, makeVolcanicObsidian, makeMagmaCap } from '../textures.js';
import { LAYOUT } from '../config.js';
import { makeEarth, makeCryoIce, makeRubiksFace, makeNeonPrismCap } from '../textures.js';
import { sphereTriangles, sphereCellKeep, clipSphereCell, pieceGeometry } from './sphere.js';
import { makeLayeredPieceMaterial, makeEarthGrainMaterial, grainLook, grainLookState, crystalGeometry,
  makeCryoPieceMaterial, makeCryoGrainMaterial, cryoGrainLook } from './earth.js';
import { mulberry32, clamp01 } from '../util.js';

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const easeInCubic = (u) => u * u * u;
const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const GAP = 0.985; // visual + collider shrink so neighbouring cells never start interpenetrating

/** Chipped unit block (convex hull) with corner chips of size `chip` (fraction of the unit edge). */
function chunkGeometry(seed, chip) {
  const rnd = mulberry32(seed), pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const c = [chip * (0.5 + rnd()), chip * (0.5 + rnd()), chip * (0.5 + rnd())];
    pts.push(new THREE.Vector3(sx * (0.5 - c[0]), sy * 0.5, sz * 0.5));
    pts.push(new THREE.Vector3(sx * 0.5, sy * (0.5 - c[1]), sz * 0.5));
    pts.push(new THREE.Vector3(sx * 0.5, sy * 0.5, sz * (0.5 - c[2])));
  }
  const g = new ConvexGeometry(pts);
  const p = g.attributes.position, n = g.attributes.normal, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const [u, v] = ax >= ay && ax >= az ? [p.getZ(i), p.getY(i)] : ay >= az ? [p.getX(i), p.getZ(i)] : [p.getX(i), p.getY(i)];
    uv[i * 2] = u + 0.5; uv[i * 2 + 1] = v + 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function instanced(geo, mat, cap, shadows) {
  geo.setAttribute('aOutP', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3));
  geo.setAttribute('aOutN', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3));
  geo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
  if (mat.userData.rubiks) geo.setAttribute('aHome', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3)); // Rubik: home cell centre (ingot space)
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = shadows; mesh.receiveShadow = true;
  return mesh;
}

/** Brilliant-cut diamond (lathe, 10 facets, flat shaded): tall pavilion, wide table; per-vertex gradient bottom -> girdle -> table. */
function diamondGeometry(r, [cLo, cMid, cHi]) { // per-FACET colour: dark sapphire in shade, cyan faces, ice highlights on the upper facets facing the key light
  const pts = [[0, -1.05 * r], [0.98 * r, 0.02 * r], [1.0 * r, 0.1 * r], [0.74 * r, 0.42 * r], [0.46 * r, 0.54 * r], [0, 0.54 * r]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 10).toNonIndexed();
  const p = g.attributes.position, col = new Float32Array(p.count * 3), a = new THREE.Color(cLo), b = new THREE.Color(cMid), c = new THREE.Color(cHi), o = new THREE.Color();
  const L = new THREE.Vector3(-0.4, 0.8, 0.45).normalize(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let f = 0; f < p.count; f += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(p, f + k);
    n.crossVectors(e1.subVectors(v[1], v[0]), e2.subVectors(v[2], v[0])).normalize();
    const yc = (v[0].y + v[1].y + v[2].y) / 3, yN = (yc + 1.05 * r) / (1.59 * r);
    const t = Math.min(1, Math.max(0, 0.5 * (n.dot(L) * 0.5 + 0.5) + 0.35 * hash(f * 0.37 + 2) + 0.3 * yN * yN - 0.05));
    if (t < 0.5) o.copy(a).lerp(b, t / 0.5); else o.copy(b).lerp(c, Math.pow((t - 0.5) / 0.5, 2));
    for (let k = 0; k < 3; k++) col.set([o.r, o.g, o.b], (f + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Brilliant-cut ruby (lathe, 8 facets, flat shaded), height along +y, girdle radius r. */
function rubyGeometry(r) {
  const pts = [[0, -0.95 * r], [r, 0], [0.92 * r, 0.12 * r], [0.58 * r, 0.42 * r], [0, 0.42 * r]].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 8);
  return g.toNonIndexed();
}

export async function createDebris({ recipe, profile, scene, G }) {
  await RAPIER.init();
  const pal = recipe.palette;
  const [W, H, D] = recipe.object.size;
  const volcanic = recipe.object.surfaceStyle === 'obsidian'; // volcanic glass shell + molten magma fracture faces (default: gold + emerald)
  const sph = recipe.object.shape === 'sphere'; // Planet Earth: clipped ball pieces (R1-R3) + radius-coloured micro pieces (R4-R6)
  const cryo = sph && recipe.object.coreStyle === 'cryo-plasma'; // Cryo Ice: glacial skin + cryo-plasma layers (Earth defaults otherwise)
  const rubik = !sph && recipe.object.surfaceStyle === 'rubiks'; // Rubik's cube: sticker skin with ingot-space sub-UVs + neon-prism core
  const rcfg = { microShell: 0.2, ...(recipe.object.rubiks ?? {}) };
  const rFaceCols = (rcfg.colors ?? ['#0051ba', '#009e49', '#f2f2f5', '#ffd000', '#d90429', '#ff6b00']).map((c) => new THREE.Color(c));
  const rounds = recipe.v2.rounds;
  let big = null, chunks, grains, chunkCap, grainMat = null;
  if (sph) {
    const gm = (grainMat = cryo ? makeCryoGrainMaterial(W / 2, recipe.object.coreGlow ?? 1) : makeEarthGrainMaterial(W / 2, recipe.object.coreGlow ?? 1));
    chunkCap = Math.max(64, ...rounds.filter((r) => (r.tier ?? 1) < 4).map((r) => sphereCellKeep(r.grid, W / 2, 'center').reduce((a, v) => a + v, 0)));
    chunks = instanced(chunkGeometry(9, 0.09), gm, chunkCap, true);
    grains = instanced(new THREE.BoxGeometry(1, 1, 1), gm, profile.maxShards ?? 8000, true);
    scene.add(chunks, grains);
  } else {
    const mat = rubik ? makeRubiksShardMaterial([W, H, D], makeRubiksFace(), makeNeonPrismCap(pal), rcfg)
      : volcanic
      ? makeShardMaterial(makeVolcanicObsidian(pal), makeMagmaCap(pal, W / H), SHARD_LOOKS['obsidian-magma'])
      : makeShardMaterial(makeGoldCast(pal), makeEmeraldCap(pal, W / H), { ...SHARD_LOOKS['gold-emerald'], ruby: makeRubyCap(pal, W / H) });
    chunkCap = Math.max(64, ...rounds.filter((r) => (r.tier ?? 1) < 4).map((r) => r.grid[0] * r.grid[1] * r.grid[2]));
    big = instanced(chunkGeometry(4, 0.045), mat, 64, true);
    chunks = instanced(chunkGeometry(9, 0.09), mat, chunkCap, true);
    grains = instanced(new THREE.BoxGeometry(1, 1, 1), mat, profile.maxShards ?? 8000, true);
    scene.add(big, chunks, grains);
  }
  // sphere mode: shared Earth maps (cached, same as the intact planet), piece material, lazily clipped piece sets per round
  const SR = W / 2;
  const iceCfg = { bump: 1.2, crackGlow: 0.6, ...(recipe.object.ice ?? {}) };
  const earth = !sph ? null : cryo ? makeCryoIce(iceCfg) : makeEarth({ lon: 0, seed: 7, land: 0.34, ...(recipe.object.earth ?? {}) });
  const pieceMat = !sph ? null : cryo ? makeCryoPieceMaterial(earth, SR, recipe.object.coreGlow ?? 1, iceCfg) : makeLayeredPieceMaterial(earth, SR, recipe.object.coreGlow ?? 1);
  const lookFn = cryo ? cryoGrainLook : grainLook;
  const sphereTris = sph ? sphereTriangles(SR, recipe.object.detail ?? 20) : null;
  const pieceCache = new Map();
  const pieceGroup = new THREE.Group();
  if (sph) scene.add(pieceGroup);
  /** Clipped pieces of a round grid (cached): [{ mesh, hull (Float32Array, cell-local, shrunk by GAP), home }]. */
  const spherePieces = (grid) => {
    const key = grid.join('x');
    if (pieceCache.has(key)) return pieceCache.get(key);
    const [nx, ny, nz] = grid, keep = sphereCellKeep(grid, SR, 'volume');
    const cw = W / nx, ch = H / ny, cd = D / nz, out = [];
    let i = 0;
    for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++, i++) {
      if (!keep[i]) continue;
      const lo = [-W / 2 + a * cw, -H / 2 + b * ch, -D / 2 + c * cd], hi = [lo[0] + cw, lo[1] + ch, lo[2] + cd];
      const home = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const clip = clipSphereCell(sphereTris, SR, lo, hi);
      const pg = pieceGeometry(clip, home);
      const mesh = new THREE.Mesh(pg.geometry, pieceMat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.visible = false;
      pieceGroup.add(mesh);
      const hull = new Float32Array(pg.hull.length * 3);
      pg.hull.forEach((q, k) => hull.set([q[0] * GAP, q[1] * GAP, q[2] * GAP], k * 3));
      out.push({ mesh, hull, home, centroid: clip.centroid });
    }
    pieceCache.set(key, out);
    return out;
  };
  const gls = sph ? grainLookState() : null;

  // anomaly gem (palette.ruby, name kept for recipe compatibility): ruby by default; shape "diamond" + gradient = faceted ice diamond
  const rp = { size: 0.2, color: '#8a001c', emissive: '#4a000f', emissiveIntensity: 0.27, shape: 'ruby', roughness: 0.08, clearcoat: 1.0, ior: 1.76,
    metalness: 0.1, envMapIntensity: 0.85, light: null, lightIntensity: 0.7, lightGather: 1.2, gradient: null, ...(pal.ruby ?? {}) };
  const diamond = rp.shape === 'diamond', crystal = rp.shape === 'crystal'; // crystal: faceted alien anomaly (sphere recipes)
  const ruby = new THREE.Mesh(crystal ? crystalGeometry(rp.size, rp.gradient) : diamond ? diamondGeometry(rp.size, rp.gradient) : rubyGeometry(rp.size), new THREE.MeshPhysicalMaterial({
    color: diamond || crystal ? 0xffffff : rp.color, vertexColors: diamond || crystal, roughness: rp.roughness, metalness: rp.metalness, clearcoat: rp.clearcoat, clearcoatRoughness: 0.02, ior: rp.ior, specularIntensity: 1,
    specularColor: new THREE.Color('#ffffff'), emissive: rp.emissive, emissiveIntensity: rp.emissiveIntensity, envMapIntensity: rp.envMapIntensity, flatShading: true,
  }));
  ruby.castShadow = true; ruby.visible = false;
  const rubyLight = new THREE.PointLight(rp.light ?? rp.color, 0, 1.4, 2);
  scene.add(ruby, rubyLight);

  const [TX, TZ] = LAYOUT.table.size;
  const LIM_X = TX / 2 - 0.15, LIM_Z = TZ / 2 - 0.15;
  const m4 = new THREE.Matrix4(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), va = new THREE.Vector3(), vs = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let set = null;
  let world = null;
  const clatter = []; // { t, v } ground impacts (audio)

  /** Pieces of round R: home cells (ingot-local centres), sizes, skin flags. */
  /** Sphere mode set: R1-R3 = clipped ball pieces (own meshes), R4-R6 = micro pieces of the cells whose centre is inside the ball. */
  function buildSphereSet(R, pose, t) {
    const [nx, ny, nz] = R.grid;
    const cw = W / nx, ch = H / ny, cd = D / nz;
    let cells, mesh = null, pieces = null;
    if (R.physics === 'rapier') {
      pieces = spherePieces(R.grid);
      cells = pieces.map((p) => p.home);
    } else {
      const keep = sphereCellKeep(R.grid, SR, 'center');
      cells = [];
      let i = 0;
      for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++, i++) {
        if (keep[i]) cells.push([-W / 2 + (a + 0.5) * cw, -H / 2 + (b + 0.5) * ch, -D / 2 + (c + 0.5) * cd]);
      }
      mesh = R.tier < 4 && cells.length <= chunkCap ? chunks : grains;
    }
    const n = cells.length;
    const S = {
      R, mesh, n, t0: t, mode: R.physics, home: new Float32Array(n * 3), half: new Float32Array(n * 3),
      pos: new Float32Array(n * 3), quat: new Float32Array(n * 4), vel: new Float32Array(n * 3), ang: new Float32Array(n * 3),
      rest: new Uint8Array(n), bodies: null, gather: null, framePos: [0, pose.y, 0], yaw: pose.yaw, ruby: null,
      pieces, hulls: pieces ? pieces.map((p) => p.hull) : null,
    };
    for (let i = 0; i < n; i++) {
      S.home.set(cells[i], i * 3);
      S.half.set([(cw * GAP) / 2, (ch * GAP) / 2, (cd * GAP) / 2], i * 3);
    }
    if (mesh) {
      const aHeat = mesh.geometry.attributes.aHeat, aHome = mesh.geometry.attributes.aOutP; // aOutP = home cell centre in sphere mode
      grainMat.userData.uniforms.uCell.value = cw;
      for (let i = 0; i < n; i++) {
        const [x, y, z] = cells[i];
        aHome.setXYZ(i, x, y, z);
        const L = lookFn(Math.hypot(x, y, z) / SR, earth.sample(x, y, z), hash(i * 2.71 + R.index * 5), gls);
        mesh.setColorAt(i, L.color.multiplyScalar(0.9 + 0.2 * hash(i * 3.1 + 7)));
        aHeat.setX(i, L.heat);
      }
      aHeat.needsUpdate = aHome.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      mesh.count = n;
    } else for (const p of pieces) p.mesh.visible = true;
    qa.setFromAxisAngle(up, pose.yaw);
    for (let j = 0; j < n; j++) {
      va.fromArray(S.home, j * 3).applyQuaternion(qa).add(vs.set(0, pose.y, 0));
      va.toArray(S.pos, j * 3);
      qa.toArray(S.quat, j * 4);
    }
    return S;
  }

  /**
   * Rubik pieces: aHome = home cell centre (exact sticker sub-UVs on R1-R3), uRCell / uRMini per round. Micro rounds (tier >= 3):
   * pieces within the outer microShell (fraction of the half-extent, >= 1 layer) become whole mini tiles in the colour of their
   * nearest cube face (all faces skin, black border in the shader); the rest are pure neon-prism core (no skin faces).
   */
  function rubikCells(S, mesh, [nx, ny, nz], cell) {
    const U = mesh.material.userData.rubiks, mini = S.R.tier >= 3;
    U.uRCell.value.set(...cell);
    U.uRMini.value = mini ? 1 : 0;
    const aHome = mesh.geometry.attributes.aHome, aOutP = mesh.geometry.attributes.aOutP, aOutN = mesh.geometry.attributes.aOutN;
    const col = new THREE.Color(), dims = [nx, ny, nz];
    let i = 0;
    for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++, i++) {
      aHome.setXYZ(i, S.home[i * 3], S.home[i * 3 + 1], S.home[i * 3 + 2]);
      if (!mini) { mesh.setColorAt(i, col.setRGB(1, 1, 1)); continue; }
      // distance (in layers) to each face: +x, -x, +y, -y, +z, -z
      const dist = [nx - 1 - a, a, ny - 1 - b, b, nz - 1 - c, c];
      let best = 0;
      for (let f = 1; f < 6; f++) if (dist[f] < dist[best] || (dist[f] === dist[best] && hash(i * 0.91 + f * 3.3) > 0.5)) best = f;
      const layers = Math.max(1, Math.round(rcfg.microShell * dims[best >> 1] * 0.5));
      if (dist[best] < layers) {
        aOutP.setXYZ(i, 1, 1, 1); aOutN.setXYZ(i, 1, 1, 1);
        const k = 0.94 + 0.12 * hash(i * 3.1 + 7);
        mesh.setColorAt(i, col.copy(rFaceCols[best]).multiplyScalar(k));
      } else {
        aOutP.setXYZ(i, 0, 0, 0); aOutN.setXYZ(i, 0, 0, 0);
        mesh.setColorAt(i, col.setRGB(1, 1, 1));
      }
    }
    aHome.needsUpdate = true;
  }

  function buildSet(R, pose, t) {
    if (sph) return buildSphereSet(R, pose, t);
    const [nx, ny, nz] = R.grid, n = nx * ny * nz;
    const mesh = n <= 8 ? big : R.tier < 4 && n <= chunkCap ? chunks : grains;
    const cw = W / nx, ch = H / ny, cd = D / nz;
    const S = {
      R, mesh, n, t0: t, mode: R.physics, home: new Float32Array(n * 3), half: new Float32Array(n * 3),
      pos: new Float32Array(n * 3), quat: new Float32Array(n * 4), vel: new Float32Array(n * 3), ang: new Float32Array(n * 3),
      rest: new Uint8Array(n), bodies: null, gather: null, framePos: [0, pose.y, 0], yaw: pose.yaw, ruby: null,
    };
    const aOutP = mesh.geometry.attributes.aOutP, aOutN = mesh.geometry.attributes.aOutN, aHeat = mesh.geometry.attributes.aHeat;
    const col = new THREE.Color();
    const emeraldFrac = pal.crystal?.emerald ?? 0.4;
    let i = 0;
    for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++, i++) {
      const lx = -W / 2 + (a + 0.5) * cw, ly = -H / 2 + (b + 0.5) * ch, lz = -D / 2 + (c + 0.5) * cd;
      S.home.set([lx, ly, lz], i * 3);
      S.half.set([(cw * GAP) / 2, (ch * GAP) / 2, (cd * GAP) / 2], i * 3);
      let f = [a === nx - 1, b === ny - 1, c === nz - 1, a === 0, b === 0, c === 0].map(Number);
      if (R.tier >= 3 && !f.some(Boolean)) { // inner micro pieces: mix of gold nuggets and pure emerald crystals
        const g = hash(i * 1.37 + R.index * 11) > emeraldFrac ? 1 : 0;
        f = [g, g, g, g, g, g];
      }
      aOutP.setXYZ(i, f[0], f[1], f[2]); aOutN.setXYZ(i, f[3], f[4], f[5]);
      const core = 1 - Math.min(1, Math.hypot(lx / (W / 2), ly / (H / 2), lz / (D / 2)) / 1.6);
      aHeat.setX(i, 0.45 + 0.55 * core);
      const k = 0.9 + 0.2 * hash(i * 3.1 + 7);
      mesh.setColorAt(i, col.setRGB(k, k, k));
    }
    if (rubik) rubikCells(S, mesh, [nx, ny, nz], [cw, ch, cd]);
    aOutP.needsUpdate = aOutN.needsUpdate = aHeat.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.count = n;
    // world pose of every cell at the impact pose: centre (0, H/2, 0) + yaw
    qa.setFromAxisAngle(up, pose.yaw);
    for (let j = 0; j < n; j++) {
      va.fromArray(S.home, j * 3).applyQuaternion(qa).add(vs.set(0, pose.y, 0));
      va.toArray(S.pos, j * 3);
      qa.toArray(S.quat, j * 4);
    }
    return S;
  }

  function spawnRapier(S, pose) {
    world = new RAPIER.World({ x: 0, y: -G, z: 0 });
    const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.15, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(TX / 2, 0.15, TZ / 2).setFriction(0.75).setRestitution(0.1), floor);
    const R = S.R, rnd = mulberry32(911 + R.index * 77);
    S.bodies = [];
    for (let i = 0; i < S.n; i++) {
      const [hx, hy, hz] = S.home.subarray(i * 3, i * 3 + 3);
      let v, w;
      if (S.n === 2 && S.pieces) { // sphere R1: hemispheres hop apart and roll ~100 deg onto their domes -> cut faces up, tilted to the camera
        const s = Math.sign(hx), k = R.split ?? {};
        v = [s * R.pop * (k.out ?? 0.45), R.pop * (k.up ?? 1.25), k.fwd ?? 0.3];
        w = [k.tilt ?? 1.6, 0, -s * R.pop * (k.spin ?? 4.4)];
      } else if (S.n === 2) { // R1: the two halves topple outward, cut faces (emerald) rolling up toward the camera
        const s = Math.sign(hx);
        v = [s * R.pop * 1.1, R.pop * 1.6, 0.25];
        w = [0, 0, -s * R.pop * 5.2];
      } else {
        const dx = hx + (rnd() - 0.5) * 0.2, dz = hz + (rnd() - 0.5) * 0.2, l = Math.hypot(dx, dz) || 1;
        const yN = (hy + H / 2) / H;
        const s = R.pop * (0.75 + 0.5 * rnd());
        v = [(dx / l) * s, R.pop * (0.6 + 0.9 * yN) * (0.8 + 0.4 * rnd()), (dz / l) * s + 0.35];
        w = [(rnd() - 0.5) * R.pop * 3, (rnd() - 0.5) * R.pop * 2, (rnd() - 0.5) * R.pop * 3];
      }
      qa.fromArray(S.quat, i * 4);
      const tr = S.pos.subarray(i * 3, i * 3 + 3);
      const vw = va.set(...v).applyAxisAngle(up, pose.yaw);
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(tr[0], tr[1], tr[2])
        .setRotation({ x: qa.x, y: qa.y, z: qa.z, w: qa.w }).setLinvel(vw.x, vw.y, vw.z).setAngvel({ x: w[0], y: w[1], z: w[2] })
        .setLinearDamping(S.pieces ? (R.damping?.[0] ?? 0.3) : 0.05).setAngularDamping(S.pieces ? (R.damping?.[1] ?? 1.4) : 0.35)); // round pieces: extra damping (no rolling off the table)
      const cdesc = (S.hulls && RAPIER.ColliderDesc.convexHull(S.hulls[i])) || RAPIER.ColliderDesc.cuboid(S.half[i * 3], S.half[i * 3 + 1], S.half[i * 3 + 2]);
      world.createCollider(cdesc.setFriction(S.pieces && S.n === 2 ? (R.split?.friction ?? 0.7) : 0.7).setRestitution(0.15).setDensity(1), body);
      S.bodies.push(body);
      S.vel[i * 3 + 1] = vw.y;
    }
  }

  function spawnAnalytic(S, pose) {
    const R = S.R;
    S.pf = new Float32Array(S.n); // per-piece stacking factor on the central heap (R.pile)
    for (let i = 0; i < S.n; i++) S.pf[i] = Math.pow(hash(i * 4.9 + 21), 0.7);
    for (let i = 0; i < S.n; i++) {
      const hx = S.home[i * 3], hy = S.home[i * 3 + 1], hz = S.home[i * 3 + 2];
      const r1 = hash(i * 1.1 + R.index), r2 = hash(i * 2.3 + 5), r3 = hash(i * 3.7 + 9), r4 = hash(i * 5.3 + 13);
      let ang = Math.atan2(hz + (r1 - 0.5) * 0.5, hx + (r2 - 0.5) * 0.5) + (r3 - 0.5) * 0.7;
      if (rubik && rcfg.scatter) ang += (hash(i * 6.1 + 17 + R.index) - 0.5) * 2 * Math.PI * rcfg.scatter; // Rubik: mix the six face colours in the heap
      const radial = Math.min(1, Math.hypot(hx / (W / 2), hz / (D / 2)) / 1.41);
      const yN = (hy + H / 2) / H;
      const s = R.spread * (0.12 + 0.88 * Math.pow(r4, R.pile ? 1.5 : 0.85)) * (0.55 + 0.45 * radial) * (sph ? 0.4 + 0.8 * Math.min(1, Math.hypot(hx, hy, hz) / SR) : 1); // sphere: crust flies wider, the core stays central
      const vw = va.set(Math.cos(ang) * s, (1.2 + 5.5 * r2) * (0.4 + yN), Math.sin(ang) * s * 0.85 + 0.35 * s * 0.2).applyAxisAngle(up, pose.yaw);
      S.vel.set([vw.x, vw.y, vw.z], i * 3);
      const wm = 8 + 18 * r1;
      S.ang.set([(r2 - 0.5) * wm, (r3 - 0.5) * wm * 0.6, (r4 - 0.5) * wm], i * 3);
    }
  }

  /** Lowest point offset of an oriented box: sum_j |R_yj| h_j (exact). */
  const vExt = (q, hx, hy, hz) => {
    const { x, y, z, w } = q;
    const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
    return Math.abs(r10) * hx + Math.abs(r11) * hy + Math.abs(r12) * hz;
  };
  const dq = new THREE.Quaternion(), qt = new THREE.Quaternion(), ax = new THREE.Vector3();

  function stepAnalytic(S, dt, t) {
    const sub = 2, h = dt / sub, mu = 0.55, e = 0.32;
    const { pos, vel, ang, quat, half, rest } = S;
    const pk = S.R.pile;
    for (let i = 0; i < S.n; i++) {
      if (rest[i]) continue;
      const i3 = i * 3, i4 = i * 4;
      qa.fromArray(quat, i4);
      for (let s = 0; s < sub; s++) {
        vel[i3 + 1] -= G * h;
        pos[i3] += vel[i3] * h; pos[i3 + 1] += vel[i3 + 1] * h; pos[i3 + 2] += vel[i3 + 2] * h;
        // orientation
        const wx = ang[i3], wy = ang[i3 + 1], wz = ang[i3 + 2], wl = Math.hypot(wx, wy, wz);
        if (wl > 1e-4) { dq.setFromAxisAngle(ax.set(wx / wl, wy / wl, wz / wl), wl * h); qa.premultiply(dq); }
        const ext = vExt(qa, half[i3], half[i3 + 1], half[i3 + 2]);
        const fl = pk ? pk.h * S.pf[i] * Math.exp(-(pos[i3] * pos[i3] + pos[i3 + 2] * pos[i3 + 2]) / (2 * pk.sigma * pk.sigma)) : 0;
        if (pos[i3 + 1] - ext <= fl) {
          pos[i3 + 1] = ext + fl;
          if (vel[i3 + 1] < -1.4) {
            clatter.push(-vel[i3 + 1]);
            vel[i3 + 1] = -vel[i3 + 1] * e;
            vel[i3] *= 0.82; vel[i3 + 2] *= 0.82;
            ang[i3] *= 0.6; ang[i3 + 1] *= 0.8; ang[i3 + 2] *= 0.6;
          } else {
            vel[i3 + 1] = 0;
            const hs = Math.hypot(vel[i3], vel[i3 + 2]), dv = mu * G * h;
            const k = hs > dv ? (hs - dv) / hs : 0;
            vel[i3] *= k; vel[i3 + 2] *= k;
            const damp = Math.max(0, 1 - 9 * h);
            ang[i3] *= damp; ang[i3 + 1] *= damp; ang[i3 + 2] *= damp;
            // settle face-down: rotate the local axis closest to world up onto it
            const { x, y, z, w } = qa;
            const ups = [[2 * (x * y + w * z), 0], [1 - 2 * (x * x + z * z), 1], [2 * (y * z - w * x), 2]];
            let best = ups[0];
            for (const u of ups) if (Math.abs(u[0]) > Math.abs(best[0])) best = u;
            const la = [0, 0, 0]; la[best[1]] = Math.sign(best[0]) || 1;
            va.set(...la).applyQuaternion(qa);
            qt.setFromUnitVectors(va, up);
            dq.identity().slerp(qt, Math.min(1, 14 * h));
            qa.premultiply(dq);
            pos[i3 + 1] = vExt(qa, half[i3], half[i3 + 1], half[i3 + 2]) + fl;
            if (hs < 0.02 && qt.w > 0.99999) { rest[i] = 1; vel[i3] = vel[i3 + 2] = 0; }
          }
        }
        if (Math.abs(pos[i3]) > LIM_X) { pos[i3] = Math.sign(pos[i3]) * LIM_X; vel[i3] *= -0.25; }
        if (Math.abs(pos[i3 + 2]) > LIM_Z) { pos[i3 + 2] = Math.sign(pos[i3 + 2]) * LIM_Z; vel[i3 + 2] *= -0.25; }
      }
      qa.normalize().toArray(quat, i4);
    }
  }

  function stepRapier(S, dt) {
    world.timestep = dt / 2;
    world.step(); world.step();
    for (let i = 0; i < S.n; i++) {
      const b = S.bodies[i], tr = b.translation(), r = b.rotation(), v = b.linvel();
      S.pos.set([tr.x, tr.y, tr.z], i * 3);
      S.quat.set([r.x, r.y, r.z, r.w], i * 4);
      const pv = S.vel[i * 3 + 1];
      if (pv < -1.4 && v.y > pv + 1.2) clatter.push(-pv);
      S.vel[i * 3 + 1] = v.y;
    }
  }

  // ---- ruby: rolls out of the core toward the camera (pure function of time since impact) ----
  function rubyPose(S, t) {
    const tau = t - S.t0, T = 0.95, L = 1.75;
    const u = clamp01(tau / T), s = L * (1 - (1 - u) * (1 - u));
    const dir = [0.38, 0.925];
    const hop = 0.32 * Math.sin(Math.PI * clamp01(tau / 0.28)) * (tau < 0.28 ? 1 : 0);
    const p = [dir[0] * s, (rp.restY ?? rp.size * 0.95) + hop, dir[1] * s];
    const roll = s / rp.size;
    qa.setFromAxisAngle(ax.set(dir[1], 0, -dir[0]), roll);
    qb.setFromAxisAngle(ax.set(1, 0, 0), Math.PI / 2 - 0.35); // rests tilted on a pavilion facet
    return { p, q: qa.clone().multiply(qb) };
  }

  function writeMatrices(S) {
    if (S.pieces) { // sphere R1-R3: one mesh per clipped piece
      S.pieces.forEach((p, i) => { p.mesh.position.fromArray(S.pos, i * 3); p.mesh.quaternion.fromArray(S.quat, i * 4); });
      return;
    }
    for (let i = 0; i < S.n; i++) {
      m4.compose(va.fromArray(S.pos, i * 3), qa.fromArray(S.quat, i * 4), vs.set(S.half[i * 3] * 2, S.half[i * 3 + 1] * 2, S.half[i * 3 + 2] * 2));
      S.mesh.setMatrixAt(i, m4);
    }
    S.mesh.instanceMatrix.needsUpdate = true;
  }

  function clearSet() {
    if (!set) return;
    if (set.pieces) set.pieces.forEach((p) => { p.mesh.visible = false; }); else set.mesh.count = 0;
    if (world) { world.free(); world = null; }
    ruby.visible = false; rubyLight.intensity = 0;
    set = null;
  }

  return {
    get active() { return !!set; },
    get round() { return set ? set.R.index : -1; },
    /** Spawns round R at the impact pose (centre y = H/2). */
    spawn(R, pose, t) {
      clearSet();
      set = buildSet(R, pose, t);
      if (R.physics === 'rapier') spawnRapier(set, pose); else spawnAnalytic(set, pose);
      if (R.ruby) { set.ruby = true; ruby.visible = true; }
      writeMatrices(set);
    },
    /** Starts flying every piece back into its cell of the ingot at `target` pose ({y, yaw}) over [t0, t1]. */
    gather(t0, t1, target, kind) {
      if (!set) return;
      set.gather = { t0, t1, kind, p0: set.pos.slice(), q0: set.quat.slice(), target, rubyP0: set.ruby ? ruby.position.toArray() : null, rubyQ0: ruby.quaternion.clone() };
      if (world) { world.free(); world = null; set.bodies = null; }
    },
    step(dt, t) {
      if (!set) return;
      const S = set;
      if (S.gather) {
        const g = S.gather, u = clamp01((t - g.t0) / (g.t1 - g.t0));
        const rew = g.kind === 'rewind';
        qb.setFromAxisAngle(up, g.target.yaw);
        for (let i = 0; i < S.n; i++) {
          const d = (rew ? 0.28 : 0.18) * hash(i * 0.73 + 3);
          const ui = clamp01((u - d) / (1 - d));
          const e = easeInOutCubic(ui); // rewind: accelerates into the centre, then settles with zero velocity (no snap at the end)
          va.fromArray(S.home, i * 3).applyQuaternion(qb); va.y += g.target.y; // home (world)
          const x0 = g.p0[i * 3], y0 = g.p0[i * 3 + 1], z0 = g.p0[i * 3 + 2];
          let x = x0 + (va.x - x0) * e, y = y0 + (va.y - y0) * e, z = z0 + (va.z - z0) * e;
          const arc = Math.sin(Math.PI * e);
          if (rew) { // vortex around the vertical axis through the ingot
            const a = 2.4 * arc * (0.6 + 0.4 * hash(i + 0.5));
            const c = Math.cos(a), s = Math.sin(a);
            const rx = x * c - z * s, rz = x * s + z * c;
            x = rx; z = rz; y += 0.35 * arc;
          } else y += 0.4 * arc * hash(i * 1.9);
          S.pos[i * 3] = x; S.pos[i * 3 + 1] = y; S.pos[i * 3 + 2] = z;
          qa.fromArray(g.q0, i * 4).slerp(qb, e).toArray(S.quat, i * 4);
        }
        if (S.ruby && g.rubyP0) {
          const e = easeInOutCubic(u);
          ruby.position.set(g.rubyP0[0] * (1 - e), g.rubyP0[1] + (g.target.y - g.rubyP0[1]) * e, g.rubyP0[2] * (1 - e));
          rubyLight.intensity = rp.lightGather * (1 - e);
        }
        writeMatrices(S);
        return;
      }
      if (S.mode === 'rapier') { if (world) stepRapier(S, dt); } else stepAnalytic(S, dt, t);
      if (S.ruby) {
        const r = rubyPose(S, t);
        qa.setFromAxisAngle(up, S.yaw);
        ruby.position.set(...r.p).applyQuaternion(qa);
        ruby.quaternion.copy(r.q);
        rubyLight.position.copy(ruby.position).add(va.set(0.1, 0.35, 0.25));
        rubyLight.intensity = rp.lightIntensity;
      }
      writeMatrices(S);
    },
    /** True once a gather has fully converged (pieces exactly in their cells). */
    gathered(t) { return !!(set && set.gather && t >= set.gather.t1); },
    clear: clearSet,
    /** Ground impacts since last call (for clatter audio). */
    drainClatter() { const a = clatter.slice(); clatter.length = 0; return a; },
    count: () => (set ? set.n : 0),
  };
}
