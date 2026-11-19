import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const SUBSTEPS = 2;

export async function createPhysics({ maxCubes, scene, table }) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -16, z: 0 });
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.15, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(table[0] / 2, 0.15, table[1] / 2).setFriction(0.8).setRestitution(0.05), floor);

  const mesh = new THREE.InstancedMesh(
    new RoundedBoxGeometry(1, 1, 1, 2, 0.12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.2 }),
    maxCubes,
  );
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);

  const bodies = [];
  const sizes = [];
  let goldIdx = -1;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const col = new THREE.Color();

  return {
    get count() { return bodies.length; },
    /** cells: [{pos,size,color,vel,ang,gold}] -> spawned count (capped by maxCubes). */
    spawn(cells) {
      let n = 0;
      for (const c of cells) {
        if (bodies.length >= maxCubes) break;
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(c.pos[0], c.pos[1], c.pos[2])
            .setLinvel(c.vel[0], c.vel[1], c.vel[2])
            .setAngvel({ x: c.ang[0], y: c.ang[1], z: c.ang[2] })
            .setLinearDamping(0.1).setAngularDamping(0.5),
        );
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(c.size[0] / 2, c.size[1] / 2, c.size[2] / 2).setFriction(0.7).setRestitution(0.15).setDensity(1),
          body,
        );
        mesh.setColorAt(bodies.length, col.setHex(c.color));
        if (c.gold) goldIdx = bodies.length;
        bodies.push(body); sizes.push(c.size); n++;
      }
      mesh.count = bodies.length;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      return n;
    },
    /** Sweeper bar at x = barX pushes everything behind it off the table. */
    sweep(barX) {
      for (const b of bodies) {
        const t = b.translation();
        if (t.x < barX + 0.35) {
          const v = b.linvel();
          b.setLinvel({ x: Math.max(v.x, 12), y: Math.max(v.y, 0.8), z: v.z }, true);
        }
      }
    },
    /** Remove every body/collider from the Rapier world (prevents RAM growth across rounds). */
    clear() {
      for (const b of bodies) world.removeRigidBody(b);
      bodies.length = 0; sizes.length = 0; goldIdx = -1;
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
      for (let i = 0; i < bodies.length; i++) {
        const t = bodies[i].translation(), r = bodies[i].rotation(), sz = sizes[i];
        m4.compose(p.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), s.set(sz[0], sz[1], sz[2]));
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
