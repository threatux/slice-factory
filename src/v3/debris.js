// v3 debris: the shattered crystal apple. One set per round, spawned 1:1 from the apple cells at the impact pose.
//  - physics "rapier" (R1-R3): watertight clipped apple pieces (apple.js), crystal glass skin + layered core caps, real convex
//    rigid bodies in a private Rapier world; the stem + leaf ride on the piece that owns the stem base;
//  - physics "analytic" (R4-R5): deterministic per-piece integrator (same maths as v2) for 1.8k .. 16k gem-shard instances,
//    coloured by the apple layer of their home cell (ruby skin / rose quartz / gold star / obsidian seeds / ~2.5% emerald leaf);
//  - gather(): reassembly between rounds and the finale's magnetic vortex rewind;
//  - emerald easter egg (rounds with "ruby": true) rolling out of the core toward the camera.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { appleTriangles, appleCellKeep, applePieceGeometry, appleRadius } from './apple.js';
import { makeApplePieceMaterial, makeShardMaterial, shardGeometry, emeraldGeometry, appleLayerJS } from './materials.js';
import { mulberry32, clamp01 } from '../util.js';

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const GAP = 0.985;

export async function createDebrisV3({ recipe, profile, scene, G, A, stemLeaf }) {
  await RAPIER.init();
  const [W, H, D] = A.size;
  const pal = recipe.palette, oc = recipe.object;
  const rounds = recipe.v2.rounds;
  const pieceMat = makeApplePieceMaterial(A, { ...(oc.glass ?? {}), coreGlow: oc.coreGlow ?? 1 });
  const shardMat = makeShardMaterial(oc.shards ?? {});
  const cap = profile.maxShards ?? 8000;
  const sgeo = shardGeometry(oc.shardSeed ?? 5);
  sgeo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
  const grains = new THREE.InstancedMesh(sgeo, shardMat, cap);
  grains.setColorAt(0, new THREE.Color(1, 1, 1));
  grains.count = 0; grains.frustumCulled = false; grains.castShadow = true; grains.receiveShadow = true;
  scene.add(grains);
  const pieceGroup = new THREE.Group();
  scene.add(pieceGroup);

  // stem / leaf: detached from the intact apple at spawn time and parented to the owning piece
  const stem = stemLeaf.group;
  const pieceCache = new Map();
  const applePieces = (grid) => {
    const key = grid.join('x');
    if (pieceCache.has(key)) return pieceCache.get(key);
    const K = appleCellKeep(A, grid, 'volume');
    const out = [];
    const [nx, ny, nz] = grid, cw = W / nx, ch = H / ny, cd = D / nz;
    let i = 0;
    for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++, i++) {
      if (!K.keep[i]) continue;
      const lo = [-W / 2 + a * cw, -H / 2 + b * ch, -D / 2 + c * cd], hi = [lo[0] + cw, lo[1] + ch, lo[2] + cd];
      const home = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const pg = applePieceGeometry(K.clips[i].clip, home);
      const mesh = new THREE.Mesh(pg.geometry, pieceMat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.visible = false;
      pieceGroup.add(mesh);
      const hull = new Float32Array(pg.hull.length * 3);
      pg.hull.forEach((q, k) => hull.set([q[0] * GAP, q[1] * GAP, q[2] * GAP], k * 3));
      const sb = stemLeaf.base, ownsStem = sb[0] >= lo[0] && sb[0] < hi[0] && sb[1] >= lo[1] && sb[1] < hi[1] && sb[2] >= lo[2] && sb[2] < hi[2];
      out.push({ mesh, hull, home, ownsStem });
    }
    pieceCache.set(key, out);
    return out;
  };

  // emerald easter egg
  const ep = { size: 0.11, restY: 0.075, gradient: ['#003d1f', '#00c853', '#7dffb8'], emissive: '#00c853', emissiveIntensity: 0.45, light: '#00ff88', lightIntensity: 0.9, ...(pal.gem ?? {}) };
  const gem = new THREE.Mesh(emeraldGeometry(ep.size, ep.gradient), new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.05, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02, ior: 2.0, specularIntensity: 1,
    emissive: ep.emissive, emissiveIntensity: ep.emissiveIntensity, envMapIntensity: 1.6, flatShading: true,
  }));
  gem.castShadow = true; gem.visible = false;
  const gemLight = new THREE.PointLight(ep.light, 0, 1.2, 2);
  scene.add(gem, gemLight);

  const TX = 9, TZ = 6.4, LIM_X = TX / 2 - 0.15, LIM_Z = TZ / 2 - 0.15;
  const m4 = new THREE.Matrix4(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), va = new THREE.Vector3(), vs = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3(), dq = new THREE.Quaternion(), qt = new THREE.Quaternion();
  let set = null, world = null;
  const clatter = [];
  const col = new THREE.Color();
  const look = {
    skin: [new THREE.Color(pal.shardSkin?.[0] ?? '#b80028'), new THREE.Color(pal.shardSkin?.[1] ?? '#ff1744'), 0.0],
    flesh: [new THREE.Color(pal.shardFlesh?.[0] ?? '#ff8fab').multiplyScalar(0.4), new THREE.Color(pal.shardFlesh?.[1] ?? '#ffd1dc').multiplyScalar(0.4), 0.02], // rose quartz / clear glass: dark body, facets + Fresnel sparkle
    gold: [new THREE.Color(pal.shardGold?.[0] ?? '#ffb703'), new THREE.Color(pal.shardGold?.[1] ?? '#fff3b0'), 0.75],
    seed: [new THREE.Color('#0b0a12'), new THREE.Color('#2a2238'), 0.0],
    leaf: [new THREE.Color('#00c853'), new THREE.Color('#00ff88'), 0.25],
  };
  const leafFrac = oc.leafShards ?? 0.025;

  function buildSet(R, pose, t) {
    const [nx, ny, nz] = R.grid, cw = W / nx, ch = H / ny, cd = D / nz;
    let cells, pieces = null;
    if (R.physics === 'rapier') { pieces = applePieces(R.grid); cells = pieces.map((p) => p.home); } else {
      const keep = appleCellKeep(A, R.grid, 'center').keep;
      cells = [];
      let i = 0;
      for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++, i++) if (keep[i]) cells.push([-W / 2 + (a + 0.5) * cw, -H / 2 + (b + 0.5) * ch, -D / 2 + (c + 0.5) * cd]);
    }
    const n = cells.length;
    const S = {
      R, n, t0: t, mode: R.physics, home: new Float32Array(n * 3), half: new Float32Array(n * 3), pos: new Float32Array(n * 3), quat: new Float32Array(n * 4),
      vel: new Float32Array(n * 3), ang: new Float32Array(n * 3), rest: new Uint8Array(n), bodies: null, gather: null, yaw: pose.yaw, gem: false,
      pieces, hulls: pieces ? pieces.map((p) => p.hull) : null,
    };
    for (let i = 0; i < n; i++) { S.home.set(cells[i], i * 3); S.half.set([(cw * GAP) / 2, (ch * GAP) / 2, (cd * GAP) / 2], i * 3); }
    if (pieces) {
      for (const p of pieces) {
        p.mesh.visible = true;
        if (p.ownsStem) { p.mesh.add(stem); stem.position.set(-p.home[0], -p.home[1], -p.home[2]); stem.rotation.set(0, 0, 0); stem.visible = true; }
      }
    } else {
      const aHeat = sgeo.attributes.aHeat;
      for (let i = 0; i < n; i++) {
        const [x, y, z] = cells[i];
        const h = hash(i * 2.71 + R.index * 5);
        let kind = appleLayerJS(A, appleRadius(A, x, y, z), x, y, z);
        if (kind === 'skin' && y > H * 0.18 && hash(i * 5.17 + 3) < leafFrac * 6) kind = 'leaf'; // emerald leaf shards on the shoulders
        const [c0, c1, heat] = look[kind];
        grains.setColorAt(i, col.copy(c0).lerp(c1, h).multiplyScalar(0.92 + 0.16 * hash(i * 3.1 + 7)));
        aHeat.setX(i, heat * (0.7 + 0.6 * hash(i * 1.3 + 2)));
      }
      aHeat.needsUpdate = true;
      grains.instanceColor.needsUpdate = true;
      grains.count = n;
    }
    qa.setFromAxisAngle(up, pose.yaw);
    for (let j = 0; j < n; j++) { va.fromArray(S.home, j * 3).applyQuaternion(qa).add(vs.set(0, pose.y, 0)); va.toArray(S.pos, j * 3); qa.toArray(S.quat, j * 4); }
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
      if (S.n === 2) { // R1: halves hop apart and roll open like a book: cut faces (gold star) turn up toward the camera
        const s = Math.sign(hx), k = R.split ?? {};
        v = [s * R.pop * (k.out ?? 0.55), R.pop * (k.up ?? 0.9), k.fwd ?? 0.25];
        w = [k.tilt ?? 0.4, 0, -s * R.pop * (k.spin ?? 3.6)];
      } else {
        const dx = hx + (rnd() - 0.5) * 0.2, dz = hz + (rnd() - 0.5) * 0.2, l = Math.hypot(dx, dz) || 1;
        const yN = (hy + H / 2) / H, s = R.pop * (0.75 + 0.5 * rnd());
        v = [(dx / l) * s, R.pop * (0.6 + 0.9 * yN) * (0.8 + 0.4 * rnd()), (dz / l) * s + 0.35];
        w = [(rnd() - 0.5) * R.pop * 3, (rnd() - 0.5) * R.pop * 2, (rnd() - 0.5) * R.pop * 3];
      }
      qa.fromArray(S.quat, i * 4);
      const tr = S.pos.subarray(i * 3, i * 3 + 3);
      const vw = va.set(...v).applyAxisAngle(up, pose.yaw);
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(tr[0], tr[1], tr[2])
        .setRotation({ x: qa.x, y: qa.y, z: qa.z, w: qa.w }).setLinvel(vw.x, vw.y, vw.z).setAngvel({ x: w[0], y: w[1], z: w[2] })
        .setLinearDamping(R.damping?.[0] ?? 0.3).setAngularDamping(R.damping?.[1] ?? 1.4));
      const cdesc = RAPIER.ColliderDesc.convexHull(S.hulls[i]) || RAPIER.ColliderDesc.cuboid(S.half[i * 3], S.half[i * 3 + 1], S.half[i * 3 + 2]);
      world.createCollider(cdesc.setFriction(S.n === 2 ? (R.split?.friction ?? 0.7) : 0.7).setRestitution(0.15).setDensity(1), body);
      S.bodies.push(body);
      S.vel[i * 3 + 1] = vw.y;
    }
  }

  function spawnAnalytic(S, pose) {
    const R = S.R;
    S.pf = new Float32Array(S.n);
    for (let i = 0; i < S.n; i++) S.pf[i] = Math.pow(hash(i * 4.9 + 21), 0.7);
    for (let i = 0; i < S.n; i++) {
      const hx = S.home[i * 3], hy = S.home[i * 3 + 1], hz = S.home[i * 3 + 2];
      const r1 = hash(i * 1.1 + R.index), r2 = hash(i * 2.3 + 5), r3 = hash(i * 3.7 + 9), r4 = hash(i * 5.3 + 13);
      const ang = Math.atan2(hz + (r1 - 0.5) * 0.5, hx + (r2 - 0.5) * 0.5) + (r3 - 0.5) * 0.7;
      const radial = Math.min(1, Math.hypot(hx / (W / 2), hz / (D / 2)) / 1.41), yN = (hy + H / 2) / H;
      const s = R.spread * (0.12 + 0.88 * Math.pow(r4, R.pile ? 1.5 : 0.85)) * (0.55 + 0.45 * radial) * (0.4 + 0.8 * Math.min(1, appleRadius(A, hx, hy, hz)));
      const vw = va.set(Math.cos(ang) * s, (1.2 + 5.5 * r2) * (0.4 + yN), Math.sin(ang) * s * 0.85 + 0.07 * s).applyAxisAngle(up, pose.yaw);
      S.vel.set([vw.x, vw.y, vw.z], i * 3);
      const wm = 8 + 18 * r1;
      S.ang.set([(r2 - 0.5) * wm, (r3 - 0.5) * wm * 0.6, (r4 - 0.5) * wm], i * 3);
    }
  }

  const vExt = (q, hx, hy, hz) => {
    const { x, y, z, w } = q;
    return Math.abs(2 * (x * y + w * z)) * hx + Math.abs(1 - 2 * (x * x + z * z)) * hy + Math.abs(2 * (y * z - w * x)) * hz;
  };
  function stepAnalytic(S, dt) {
    const sub = 2, h = dt / sub, mu = 0.55, e = 0.32;
    const { pos, vel, ang, quat, half, rest } = S, pk = S.R.pile;
    for (let i = 0; i < S.n; i++) {
      if (rest[i]) continue;
      const i3 = i * 3, i4 = i * 4;
      qa.fromArray(quat, i4);
      for (let s = 0; s < sub; s++) {
        vel[i3 + 1] -= G * h;
        pos[i3] += vel[i3] * h; pos[i3 + 1] += vel[i3 + 1] * h; pos[i3 + 2] += vel[i3 + 2] * h;
        const wx = ang[i3], wy = ang[i3 + 1], wz = ang[i3 + 2], wl = Math.hypot(wx, wy, wz);
        if (wl > 1e-4) { dq.setFromAxisAngle(ax.set(wx / wl, wy / wl, wz / wl), wl * h); qa.premultiply(dq); }
        const ext = vExt(qa, half[i3], half[i3 + 1], half[i3 + 2]);
        const fl = pk ? pk.h * S.pf[i] * Math.exp(-(pos[i3] * pos[i3] + pos[i3 + 2] * pos[i3 + 2]) / (2 * pk.sigma * pk.sigma)) : 0;
        if (pos[i3 + 1] - ext <= fl) {
          pos[i3 + 1] = ext + fl;
          if (vel[i3 + 1] < -1.4) {
            clatter.push(-vel[i3 + 1]);
            vel[i3 + 1] = -vel[i3 + 1] * e; vel[i3] *= 0.82; vel[i3 + 2] *= 0.82;
            ang[i3] *= 0.6; ang[i3 + 1] *= 0.8; ang[i3 + 2] *= 0.6;
          } else {
            vel[i3 + 1] = 0;
            const hs = Math.hypot(vel[i3], vel[i3 + 2]), dv = mu * G * h, k = hs > dv ? (hs - dv) / hs : 0;
            vel[i3] *= k; vel[i3 + 2] *= k;
            const damp = Math.max(0, 1 - 9 * h);
            ang[i3] *= damp; ang[i3 + 1] *= damp; ang[i3 + 2] *= damp;
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

  function gemPose(S, t) { // rolls out of the core toward the camera (pure function of time since impact)
    const tau = t - S.t0, T = 0.95, Ls = ep.roll ?? 1.5;
    const u = clamp01(tau / T), s = Ls * (1 - (1 - u) * (1 - u));
    const dir = ep.dir ?? [0.42, 0.9];
    const hop = 0.28 * Math.sin(Math.PI * clamp01(tau / 0.28)) * (tau < 0.28 ? 1 : 0);
    qa.setFromAxisAngle(ax.set(dir[1], 0, -dir[0]), s / ep.size);
    qb.setFromAxisAngle(ax.set(1, 0, 0), Math.PI / 2 - 0.35);
    return { p: [dir[0] * s, ep.restY + hop, dir[1] * s], q: qa.clone().multiply(qb) };
  }

  function writeMatrices(S) {
    if (S.pieces) { S.pieces.forEach((p, i) => { p.mesh.position.fromArray(S.pos, i * 3); p.mesh.quaternion.fromArray(S.quat, i * 4); }); return; }
    for (let i = 0; i < S.n; i++) {
      m4.compose(va.fromArray(S.pos, i * 3), qa.fromArray(S.quat, i * 4), vs.set(S.half[i * 3] * 2, S.half[i * 3 + 1] * 2, S.half[i * 3 + 2] * 2));
      grains.setMatrixAt(i, m4);
    }
    grains.instanceMatrix.needsUpdate = true;
  }

  function clearSet() {
    if (!set) return;
    if (set.pieces) set.pieces.forEach((p) => { p.mesh.visible = false; }); else grains.count = 0;
    if (world) { world.free(); world = null; }
    gem.visible = false; gemLight.intensity = 0;
    set = null;
  }

  return {
    get active() { return !!set; },
    spawn(R, pose, t) {
      clearSet();
      set = buildSet(R, pose, t);
      if (R.physics === 'rapier') spawnRapier(set, pose); else spawnAnalytic(set, pose);
      if (R.ruby) { set.gem = true; gem.visible = true; }
      writeMatrices(set);
    },
    gather(t0, t1, target, kind) {
      if (!set) return;
      set.gather = { t0, t1, kind, p0: set.pos.slice(), q0: set.quat.slice(), target, gemP0: set.gem ? gem.position.toArray() : null };
      if (world) { world.free(); world = null; set.bodies = null; }
    },
    step(dt, t) {
      if (!set) return;
      const S = set;
      if (S.gather) {
        const g = S.gather, u = clamp01((t - g.t0) / (g.t1 - g.t0)), rew = g.kind === 'rewind';
        qb.setFromAxisAngle(up, g.target.yaw);
        for (let i = 0; i < S.n; i++) {
          const d = (rew ? 0.28 : 0.18) * hash(i * 0.73 + 3), e = easeInOutCubic(clamp01((u - d) / (1 - d)));
          va.fromArray(S.home, i * 3).applyQuaternion(qb); va.y += g.target.y;
          const x0 = g.p0[i * 3], y0 = g.p0[i * 3 + 1], z0 = g.p0[i * 3 + 2];
          let x = x0 + (va.x - x0) * e, y = y0 + (va.y - y0) * e, z = z0 + (va.z - z0) * e;
          const arc = Math.sin(Math.PI * e);
          if (rew) { const a = 2.4 * arc * (0.6 + 0.4 * hash(i + 0.5)), c = Math.cos(a), s = Math.sin(a); const rx = x * c - z * s, rz = x * s + z * c; x = rx; z = rz; y += 0.35 * arc; }
          else y += 0.4 * arc * hash(i * 1.9);
          S.pos[i * 3] = x; S.pos[i * 3 + 1] = y; S.pos[i * 3 + 2] = z;
          qa.fromArray(g.q0, i * 4).slerp(qb, e).toArray(S.quat, i * 4);
        }
        if (S.gem && g.gemP0) {
          const e = easeInOutCubic(u);
          gem.position.set(g.gemP0[0] * (1 - e), g.gemP0[1] + (g.target.y - g.gemP0[1]) * e, g.gemP0[2] * (1 - e));
          gem.scale.setScalar(Math.max(0.001, 1 - e));
          gemLight.intensity = ep.lightIntensity * (1 - e);
        }
        writeMatrices(S);
        return;
      }
      if (S.mode === 'rapier') { if (world) stepRapier(S, dt); } else stepAnalytic(S, dt);
      if (S.gem) {
        const r = gemPose(S, t);
        qa.setFromAxisAngle(up, S.yaw);
        gem.position.set(...r.p).applyQuaternion(qa);
        gem.quaternion.copy(r.q); gem.scale.setScalar(1);
        gemLight.position.copy(gem.position).add(va.set(0.08, 0.3, 0.22));
        gemLight.intensity = ep.lightIntensity;
      }
      writeMatrices(S);
    },
    gathered(t) { return !!(set && set.gather && t >= set.gather.t1); },
    clear: clearSet,
    drainClatter() { const a = clatter.slice(); clatter.length = 0; return a; },
    count: () => (set ? set.n : 0),
    /** Does the current set carry the stem (R1-R3 pieces)? */
    holdsStem: () => !!(set && set.pieces && set.pieces.some((p) => p.ownsStem)),
  };
}
