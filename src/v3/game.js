// v3.0 engine orchestrator (recipe.engineVersion === 3): Crystal Glass Apple. Reuses the v2 schedule (timeline), HUD and
// particles; everything visual is v3: studio + post chain, crystal apple (watertight clipper), chrome blades, gem debris,
// pixel-space camera kinetics. The apple rests on the podium; each round lifts it, slices it in the air and slams it down.
// Deterministic: only the debris simulation carries state (fixed dt); everything else is evaluated from t.
import * as THREE from 'three';
import { buildTimelineV2 } from '../v2/timeline.js';
import { createHudV2 } from '../v2/hud.js';
import { createFx } from '../v2/fx.js';
import { createStudio } from './studio.js';
import { appleInfo, appleTriangles, appleCellKeep, applePieceGeometry, wholeApple } from './apple.js';
import { makeAppleShellMaterial, makeStemLeaf, makeInnerCore } from './materials.js';
import { createBladesV3 } from './blades.js';
import { createDebrisV3 } from './debris.js';
import { createCameraRigV3 } from './camera.js';

/** recipe.v3 carries the v2 schedule schema (+ studio / razor / kinetics); round "lift" = height above the resting pose. */
function normalise(recipe, A) {
  const V = recipe.v3, Hh = A.Hh;
  return {
    ...recipe,
    object: { ...recipe.object, size: A.size },
    v2: {
      ...V,
      levitateY: Hh,
      rounds: V.rounds.map((r) => (r.lift !== undefined ? { ...r, levitateY: Hh + r.lift } : r)),
      bob: { amp: 0, cycles: 1, yaw: 0, yawCycles: 1, ...(V.bob ?? {}) },
    },
  };
}

function createApple(recipe, A) {
  const pal = recipe.palette, oc = recipe.object;
  const seamCfg = { width: 0.008, glow: 1.6, flash: 6, ...(recipe.v2.seam ?? {}) };
  const [c1, c2] = pal.seam ?? ['#fff3b0', '#ffb703'];
  const U = {
    uSN: { value: new THREE.Vector3(1, 1, 1) }, uSLo: { value: new THREE.Vector3(1, 1, 1) }, uSHi: { value: new THREE.Vector3(1, 1, 1) },
    uSRev: { value: new THREE.Vector3() }, uSFlash: { value: new THREE.Vector3() }, uSW: { value: new THREE.Vector3(0.01, 0.01, 0.01) },
    uHalf: { value: new THREE.Vector3(A.W / 2, A.Hh, A.W / 2) }, uSCol: { value: new THREE.Color(c1) }, uSCol2: { value: new THREE.Color(c2) },
    uSGlow: { value: seamCfg.glow }, uSFl: { value: seamCfg.flash }, uSAlpha: { value: 1 },
    uSDir: { value: new THREE.Vector3(1, 1, 1) }, uSYX: { value: 0 },
  };
  const mat = makeAppleShellMaterial(A, oc.glass ?? {}, U);
  const geo = applePieceGeometry(wholeApple(appleTriangles(A))).geometry;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  const core = makeInnerCore(oc);
  const stemLeaf = makeStemLeaf(A, oc.stem ?? {});
  const frame = new THREE.Group();
  frame.add(mesh, core, stemLeaf.group);
  return {
    frame, mesh, stemLeaf,
    setPose(y, yaw) { frame.position.set(0, y, 0); frame.rotation.set(0, yaw, 0); frame.updateMatrixWorld(true); },
    setVisible(v) { mesh.visible = v; core.visible = v; },
    reclaimStem() { if (stemLeaf.group.parent !== frame) { frame.add(stemLeaf.group); stemLeaf.group.position.set(0, 0, 0); stemLeaf.group.rotation.set(0, 0, 0); } },
    setSeams(s) {
      const [nx, ny, nz] = s.grid;
      U.uSN.value.set(nx, ny, nz);
      U.uSLo.value.set(s.axes[0].lo, s.axes[1].lo, s.axes[2].lo);
      U.uSHi.value.set(s.axes[0].hi, s.axes[1].hi, s.axes[2].hi);
      U.uSRev.value.set(s.axes[0].rev, s.axes[1].rev, s.axes[2].rev);
      U.uSFlash.value.set(s.axes[0].flash, s.axes[1].flash, s.axes[2].flash);
      const w = (n) => seamCfg.width / Math.max(1, n - 1) + 0.0009; // hair-thin laser-glass micro cracks
      U.uSW.value.set(w(nx), w(ny), w(nz));
      // laser-glass micro cracks: brightness falls ~1/(seams per axis) so the 36- and 100-cut grids never become a glowing cage
      const dens = Math.max(1, Math.max(nx, ny, nz) - 1), k = Math.min(1, Math.max(0.045, 1.4 / dens));
      U.uSGlow.value = seamCfg.glow * s.pulse * k;
      U.uSFl.value = seamCfg.flash * Math.min(1, Math.max(0.06, 1.2 / dens));
      U.uSAlpha.value = s.alpha;
      U.uSDir.value.set(s.axes[0].dir, s.axes[1].dir, s.axes[2].dir);
      U.uSYX.value = s.axes[1].alongX;
    },
  };
}

export async function createGameV3(profile, recipe0) {
  const A = appleInfo(recipe0.object);
  const recipe = normalise(recipe0, A);
  const pal = recipe.palette;
  const cellCount = (g, physics) => appleCellKeep(A, g, physics === 'rapier' ? 'volume' : 'center').count;
  const tl = buildTimelineV2(recipe, profile, { cellCount });
  const { rounds, duration } = tl;
  const fin = recipe.v2.finale;

  const st = createStudio(profile, recipe);
  const { scene, camera, knifeLight, blob } = st;
  const hold = recipe.v2.hold, sideBase = st.side.position.clone(), rimBase = st.rim.position.clone();
  const apple = createApple(recipe, A);
  scene.add(apple.frame);
  const blades = createBladesV3(recipe, knifeLight);
  apple.frame.add(blades.holder);
  const debris = await createDebrisV3({ recipe, profile, scene, G: tl.G, A, stemLeaf: apple.stemLeaf });
  const fx = createFx({ recipe: { ...recipe, object: { ...recipe.object, shape: 'sphere' } }, profile, scene, tl });
  const rig = createCameraRigV3(recipe, tl, profile);
  const hud = createHudV2(profile, recipe, tl);
  const finEl = document.getElementById('v2-final'); // two-line finale (bait + CTA)
  if (finEl && fin.text.includes('\n')) {
    finEl.innerHTML = fin.text.split('\n').map((l) => `<span style="display:block">${l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</span>`).join('');
    finEl.style.lineHeight = '1.18';
  }

  const S = { t: 0, spawned: new Set(), gathered: new Set(), rewound: false };
  const runtimeEvents = [];
  const blobBase = A.W * (recipe.v3.studio?.blobScale ?? 1.55);

  const update = (t, dt) => {
    const pose = tl.ingotPose(t);
    apple.setPose(pose.y, pose.yaw);
    const r = tl.roundAt(t);
    let visible = true, justSpawned = false;
    if (t >= fin.rewind) {
      if (!S.rewound) { S.rewound = true; debris.gather(fin.rewind, fin.converge, tl.ingotPose(fin.converge), 'rewind'); }
      visible = t >= fin.converge;
    } else if (r >= 0) {
      const R = rounds[r];
      if (r > 0 && !S.gathered.has(r)) { S.gathered.add(r); debris.gather(R.start, R.reasmEnd, tl.ingotPose(R.reasmEnd), 'reasm'); }
      visible = t >= R.reasmEnd && t < R.impact;
      if (t >= R.impact && !S.spawned.has(r)) {
        S.spawned.add(r);
        debris.spawn(R, tl.ingotPose(R.impact), R.impact);
        justSpawned = true;
        if (t - R.impact > 1e-6) debris.step(t - R.impact, t);
      }
    }
    if (debris.gathered(t)) debris.clear();
    else if (debris.active && !justSpawned) debris.step(dt, t);
    if (visible) apple.reclaimStem();
    apple.setVisible(visible);
    apple.stemLeaf.group.visible = visible || debris.holdsStem();

    apple.setSeams(tl.seamState(t));
    const passes = t < rounds[0].start ? tl.hook.passes : r >= 0 ? rounds[r].passes : [];
    blades.update(t, visible ? passes : [], tl, apple.frame);
    fx.update(t, camera);
    rig.apply(camera, t);
    if (hold) { // final pile: the side kicker and the warm rim glide slowly so the shards keep glinting (pure function of t)
      const u = Math.min(1, Math.max(0, (t - hold.t0) / (hold.t1 - hold.t0))), e = u * u * (3 - 2 * u) * (1 - Math.min(1, Math.max(0, (t - fin.rewind) / (fin.converge - fin.rewind))));
      st.side.position.set(sideBase.x - hold.light * e, sideBase.y + 0.35 * hold.light * e, sideBase.z + 0.5 * hold.light * e);
      st.rim.position.set(rimBase.x + 0.8 * hold.light * e, rimBase.y, rimBase.z);
    }
    hud.update(t);

    const lift = Math.max(0, pose.y - A.Hh);
    blob.visible = visible;
    blob.scale.setScalar(blobBase * (1 + 0.9 * lift));
    blob.material.opacity = (recipe.v3.studio?.blobOpacity ?? 0.8) * Math.exp(-2.4 * lift);

    const cl = debris.drainClatter();
    if (cl.length) runtimeEvents.push({ time: t, type: 'clatter', round: r, count: cl.length, intensity: Math.min(1, Math.max(...cl) / 12) });
  };

  update(0, 0);
  st.render();

  return {
    step(dt) { S.t += dt; update(S.t, dt); st.render(); },
    isDone: () => S.t >= duration - 1e-6,
    getEvents: () => [...tl.events, ...runtimeEvents].sort((a, b) => a.time - b.time).map((e) => ({ ...e, time: +e.time.toFixed(4), intensity: +(e.intensity ?? 0).toFixed(3) })),
    info: () => ({
      width: profile.width, height: profile.height, fps: profile.fps, duration, knifeRaise: 0, engine: 'v3',
      rounds: rounds.length, events: tl.events.length, grids: rounds.map((R) => R.grid.join('x')), pieces: rounds.map((R) => R.count), particles: fx.count,
    }),
    probe: () => ({ t: +S.t.toFixed(3), round: tl.roundAt(S.t), pieces: debris.count(), apple: apple.mesh.visible, y: +apple.frame.position.y.toFixed(4),
      cam: [...camera.position.toArray().map((v) => +v.toFixed(3)), +camera.fov.toFixed(3)] }),
  };
}
