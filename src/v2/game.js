// v2.0 engine orchestrator (Slizzy style): Levitate -> X/Y/Z slash with glowing seams -> tension pause -> drop ->
// 1:1 shatter on impact -> instant reassembly into the next round ... -> BONUS avalanche -> vortex rewind into frame 0.
// Deterministic: the only state advanced per step is the debris simulation (Rapier / analytic integrator, fixed dt);
// everything else (ingot pose, seams, blades, particles, camera, HUD) is evaluated from t.
import * as THREE from 'three';
import { createScene } from '../scene.js';
import { buildTimelineV2 } from './timeline.js';
import { createIngot } from './ingot.js';
import { createBlades } from './blades.js';
import { createDebris } from './debris.js';
import { createFx } from './fx.js';
import { createCameraRig } from './camera.js';
import { createHudV2 } from './hud.js';

export async function createGameV2(profile, recipe) {
  if (recipe.object.shape === 'sphere') { // ball of radius r: every module sees its bounding cube (H/2 = r -> centre lands on y = r)
    const r = recipe.object.radius;
    recipe = { ...recipe, object: { ...recipe.object, size: [2 * r, 2 * r, 2 * r] } };
  }
  const pal = recipe.palette;
  const tl = buildTimelineV2(recipe, profile);
  const { rounds, duration } = tl;
  const fin = recipe.v2.finale;
  const [, H] = tl.size;

  const { renderer, scene, camera, knifeLight } = createScene(profile, pal, recipe.scene);
  knifeLight.intensity = 0;
  const ingot = createIngot(recipe);
  scene.add(ingot.frame);
  const blades = await createBlades(recipe, scene);
  ingot.frame.add(blades.holder);
  const debris = await createDebris({ recipe, profile, scene, G: tl.G });
  const fx = createFx({ recipe, profile, scene, tl });
  const rig = createCameraRig(recipe, tl);
  const hud = createHudV2(profile, recipe, tl);
  const burst = new THREE.PointLight(pal.core, 0, 4.5, 2); // emerald core flash at the moment of shattering
  burst.position.set(0, 0.8, 0.4);
  scene.add(burst);

  const S = { t: 0, spawned: new Set(), gathered: new Set(), rewound: false };
  const runtimeEvents = [];

  const update = (t, dt) => {
    const pose = tl.ingotPose(t);
    ingot.setPose(pose.y, pose.yaw);
    const r = tl.roundAt(t);
    let ingotVisible = true, justSpawned = false;

    if (t >= fin.rewind) {
      if (!S.rewound) { S.rewound = true; debris.gather(fin.rewind, fin.converge, tl.ingotPose(fin.converge), 'rewind'); }
      ingotVisible = t >= fin.converge;
    } else if (r >= 0) {
      const R = rounds[r];
      if (r > 0 && !S.gathered.has(r)) { S.gathered.add(r); debris.gather(R.start, R.reasmEnd, tl.ingotPose(R.reasmEnd), 'reasm'); }
      ingotVisible = t >= R.reasmEnd && t < R.impact;
      if (t >= R.impact && !S.spawned.has(r)) {
        S.spawned.add(r);
        debris.spawn(R, tl.ingotPose(R.impact), R.impact); // exact impact pose: centre y = H/2, same yaw -> 1:1 cell swap
        justSpawned = true;
        if (t - R.impact > 1e-6) debris.step(t - R.impact, t);
      }
    }
    if (debris.gathered(t)) debris.clear(); // converged into the cells: the whole ingot takes over this very frame
    else if (debris.active && !justSpawned) debris.step(dt, t);
    ingot.setVisible(ingotVisible);

    ingot.setSeams(tl.seamState(t));
    const passes = t < rounds[0].start ? tl.hook.passes : r >= 0 ? rounds[r].passes : [];
    blades.update(t, ingotVisible ? passes : [], tl, ingot.frame);
    fx.update(t, camera);
    rig.apply(camera, t);
    hud.update(t);

    let b = 0;
    for (const R of rounds) { const tau = t - R.impact; if (tau >= 0 && tau < 0.6) b = Math.max(b, (2 + 3 * R.tier) * Math.exp(-tau / 0.16)); }
    burst.intensity = b;

    const cl = debris.drainClatter();
    if (cl.length) runtimeEvents.push({ time: t, type: 'clatter', round: r, count: cl.length, intensity: Math.min(1, Math.max(...cl) / 12) });
  };

  const render = () => renderer.render(scene, camera);
  update(0, 0);
  render();

  return {
    step(dt) {
      S.t += dt;
      update(S.t, dt);
      render();
    },
    isDone: () => S.t >= duration - 1e-6,
    getEvents: () => [...tl.events, ...runtimeEvents].sort((a, b) => a.time - b.time).map((e) => ({ ...e, time: +e.time.toFixed(4), intensity: +(e.intensity ?? 0).toFixed(3) })),
    info: () => ({
      width: profile.width, height: profile.height, fps: profile.fps, duration, knifeRaise: 0, engine: 'v2',
      rounds: rounds.length, events: tl.events.length, grids: rounds.map((R) => R.grid.join('x')), particles: fx.count,
    }),
    probe: () => ({ t: +S.t.toFixed(3), round: tl.roundAt(S.t), pieces: debris.count(), ingot: ingot.mesh.visible, y: +ingot.frame.position.y.toFixed(4) }),
  };
}
