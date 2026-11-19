import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const SUBSTEPS = 2;

/**
 * Rigid pieces: at most `maxCubes` dynamic bodies (profile budget), up to `maxInstances` rendered pieces.
 * When the dynamic budget is full, the oldest (long settled) bodies are frozen into fixed colliders: they keep
 * supporting the heap and stay in the InstancedMesh, but cost no simulation / matrix updates until the sweeper wakes them.
 */
export async function createPhysics({ maxCubes, maxInstances = maxCubes, scene, table, geometry, material }) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -16, z: 0 });
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.15, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(table[0] / 2, 0.15, table[1] / 2).setFriction(0.8).setRestitution(0.05), floor);

  const cap = Math.max(maxCubes, maxInstances);
  const geo = geometry ?? new RoundedBoxGeometry(1, 1, 1, 2, 0.12);
  const aOutP = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  const aOutN = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  const aHeat = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  geo.setAttribute('aOutP', aOutP); geo.setAttribute('aOutN', aOutN); geo.setAttribute('aHeat', aHeat);
  const mesh = new THREE.InstancedMesh(
    geo, material ?? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.2 }), cap,
  );
  mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // allocate instanceColor up front (stable shader variant)
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);

  const bodies = [], sizes = [];
  let active = []; // indices of dynamic bodies, oldest first
  const frozen = [];
  let goldIdx = -1;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const col = new THREE.Color();
  const writeMatrix = (i) => {
    const t = bodies[i].translation(), r = bodies[i].rotation(), sz = sizes[i];
    m4.compose(p.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), s.set(sz[0], sz[1], sz[2]));
    mesh.setMatrixAt(i, m4);
  };
  const freezeOldest = () => {
    const i = active.shift();
    const b = bodies[i];
    b.setLinvel({ x: 0, y: 0, z: 0 }, false); b.setAngvel({ x: 0, y: 0, z: 0 }, false);
    b.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    frozen[i] = true;
    writeMatrix(i);
  };

  return {
    get count() { return bodies.length; },
    capacity: cap,
    /** cells: [{pos,size,color,vel,ang,gold,faces?,heat?}] -> spawned count (capped by the instance budget). */
    spawn(cells) {
      let n = 0;
      for (const c of cells) {
        if (bodies.length >= cap) break;
        while (active.length >= maxCubes) freezeOldest();
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(c.pos[0], c.pos[1], c.pos[2])
            .setLinvel(c.vel[0], c.vel[1], c.vel[2])
            .setAngvel({ x: c.ang[0], y: c.ang[1], z: c.ang[2] })
            .setLinearDamping(0.1).setAngularDamping(0.5),
        );
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(c.size[0] / 2, c.size[1] / 2, c.size[2] / 2).setFriction(0.7).setRestitution(0.12).setDensity(1),
          body,
        );
        const i = bodies.length;
        mesh.setColorAt(i, col.setHex(c.color));
        const f = c.faces ?? [1, 1, 1, 1, 1, 1];
        aOutP.setXYZ(i, f[0], f[1], f[2]); aOutN.setXYZ(i, f[3], f[4], f[5]);
        aHeat.setX(i, c.heat ?? 0);
        if (c.gold) goldIdx = i;
        bodies.push(body); sizes.push(c.size); frozen.push(false); active.push(i);
        writeMatrix(i);
        n++;
      }
      mesh.count = bodies.length;
      if (n) {
        mesh.instanceColor.needsUpdate = aOutP.needsUpdate = aOutN.needsUpdate = aHeat.needsUpdate = true;
        mesh.instanceMatrix.needsUpdate = true;
      }
      return n;
    },
    /** Sweeper bar at x = barX pushes everything behind it off the table (frozen pieces are woken up). */
    sweep(barX) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i], t = b.translation();
        if (t.x >= barX + 0.35) continue;
        if (frozen[i]) { b.setBodyType(RAPIER.RigidBodyType.Dynamic, true); frozen[i] = false; active.push(i); }
        const v = b.linvel();
        b.setLinvel({ x: Math.max(v.x, 12), y: Math.max(v.y, 0.8), z: v.z }, true);
      }
    },
    /** Remove every body/collider from the Rapier world (prevents RAM growth across rounds). */
    clear() {
      for (const b of bodies) world.removeRigidBody(b);
      bodies.length = 0; sizes.length = 0; frozen.length = 0; active = []; goldIdx = -1;
      mesh.count = 0;
    },
    goldPosition(out) {
      if (goldIdx < 0 || !bodies[goldIdx]) return false;
      const t = bodies[goldIdx].translation();
      out.set(t.x, t.y, t.z);
      return true;
    },
    step(dt) {
      world.timestep = dt / SUBSTEPS;
      for (let i = 0; i < SUBSTEPS; i++) world.step();
      for (const i of active) writeMatrix(i);
      if (active.length) mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
