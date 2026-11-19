import * as THREE from 'three';
import { LAYOUT } from './config.js';
import { createScene } from './scene.js';
import { createBlock, createKnife } from './objects.js';
import { createPhysics } from './physics.js';
import { createPile, createParticles, createSweeper, createGoldGlow } from './effects.js';
import { createHud } from './hud.js';
import { createEventLog } from './audio.js';
import { buildTimeline } from './timeline.js';
import { planCubes, slabCells } from './slabs.js';
import { mulberry32, clamp01, lerp, smooth } from './util.js';

const SHAKE = [0.05, 0.03, 0.014, 0.008, 0.006]; // per-cut camera impulse by round (heavy hits first)

export async function createGame(profile, recipe, opts = {}) {
  const pal = recipe.palette;
  const size = recipe.object.size;
  const [W, H, D] = size;
  const timeline = buildTimeline(recipe, opts);
  const { T, rounds, duration } = timeline;
  const sched = [...timeline.events, ...timeline.internal].sort((a, b) => a.time - b.time);
  const log = createEventLog(timeline.events);
  const totalRounds = recipe.rounds.length;

  const { renderer, scene, camera, key, knifeLight } = createScene(profile, pal);
  const hud = createHud(profile, recipe);
  const physics = await createPhysics({ maxCubes: profile.maxCubes, scene, table: LAYOUT.table.size });
  const block = await createBlock(recipe.object, pal);
  scene.add(block.group, block.capGroup);
  const knife = await createKnife(recipe.tools, pal.accent);
  scene.add(knife.group, knife.light, ...knife.ghosts);
  const pile = createPile({ count: profile.maxCubes * 5, pal });
  const particles = createParticles({ count: Math.min(2400, profile.maxCubes * 1.5), pal });
  const sweeper = createSweeper(pal);
  const goldGlow = createGoldGlow(pal);
  scene.add(pile.group, particles.points, sweeper.group, goldGlow);
  scene.remove(knifeLight);

  // ---- camera framing + knife safety against the top HUD ---------------------------------------
  const look = new THREE.Vector3(...LAYOUT.camera.look);
  const camBase = new THREE.Vector3(...LAYOUT.camera.pos);
  const minZoom = Math.min(1, ...rounds.map((r) => r.zoom));
  const tmp = new THREE.Vector3();
  const placeCamera = (cam, zoom, ox = 0, oy = 0) => {
    cam.position.copy(look).addScaledVector(tmp.copy(camBase).sub(look), zoom);
    cam.position.x += ox; cam.position.y += oy;
    cam.lookAt(look.x + ox * 0.5, look.y + oy * 0.5, look.z);
    cam.updateMatrixWorld(true);
  };
  const probe = camera.clone();
  const topPx = (raise, zoom) => {
    placeCamera(probe, zoom);
    let best = Infinity;
    for (const [x, y, z] of knife.topPoints()) {
      for (const zz of [-D / 2, LAYOUT.zIdle]) {
        const v = tmp.set(x, y + raise, z + zz).project(probe);
        best = Math.min(best, ((1 - v.y) / 2) * profile.height);
      }
    }
    return best;
  };
  const safePx = LAYOUT.hudSafeTop * profile.height + 0.025 * profile.height; // + shake margin
  let lo = 0, hi = LAYOUT.knife.maxRaise;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (Math.min(topPx(mid, 1), topPx(mid, minZoom)) >= safePx) lo = mid; else hi = mid;
  }
  const HMAX = lo;

  // ---- state ----------------------------------------------------------------------------------
  const S = {
    t: 0, round: 0, evPtr: 0, cutPtr: 0, cutsDone: 0, alive: false, pourOn: false, pileP: 0, sweepX: null,
    shake: 0, flash: 0, rnd: mulberry32(1), plan: null, started: false,
  };
  const seed = recipe.seed ?? 1337;
  const R0 = rounds[0];

  const startRound = (i) => {
    const R = rounds[i];
    S.round = i; S.cutPtr = 0; S.cutsDone = 0; S.alive = true; S.pourOn = false; S.pileP = 0; S.started = true;
    S.rnd = mulberry32(seed + i * 977);
    S.plan = R.mode === 'slice' ? planCubes(R, size, profile.maxCubes, R.listB.length + 1, S.rnd) : null;
    block.reset();
    knife.setTool(R.tool);
    S.flash = 1;
    S.shake += 0.0;
  };

  const spawnSlab = (R, j) => {
    const B = R.listB, nB = B.length;
    const zHi = j === 0 ? D / 2 : B[j - 1].z, zLo = j < nB ? B[j].z : -D / 2;
    physics.spawn(slabCells(S.plan, j, zLo, zHi, size, S.rnd, pal));
  };

  const onCut = (R, c) => {
    S.cutsDone++;
    if (R.mode === 'slice') {
      S.shake = Math.min(0.09, S.shake + SHAKE[R.index] * 0.6);
      if (c.phase === 'a') block.paintCut(c.z, recipe.tools[R.tool].edge, Math.floor(R.cuts / 2));
      else {
        spawnSlab(R, c.idx);
        if (c.idx === R.listB.length - 1) { spawnSlab(R, c.idx + 1); S.alive = false; block.hide(); }
      }
    } else if (S.cutsDone === R.list.length) { S.alive = false; block.hide(); }
  };

  const onEvent = (e) => {
    switch (e.type) {
      case 'drop': startRound(e.round); break;
      case 'rotate': S.shake = Math.min(0.09, S.shake + 0.01); break;
      case 'pour_start': S.pourOn = true; break;
      case 'pour_end': S.pourOn = false; break;
      case 'sweep': S.sweepOn = true; break;
      case 'sweep_end':
        S.sweepOn = false; S.sweepX = null; S.pileP = 0;
        physics.clear(); // free all Rapier bodies/colliders
        break;
      default: break;
    }
  };

  // ---- pure helpers -----------------------------------------------------------------------------
  const roundAt = () => rounds[S.round] ?? R0;
  const bisect = (L, t) => { let a = 0, b = L.length; while (a < b) { const m = (a + b) >> 1; if (L[m].t <= t) a = m + 1; else b = m; } return a; };

  /** Clip-plane z for the slab phase: holds at the last cap, then slides to the next cut while the blade descends. */
  const planeAt = (R, t) => {
    const B = R.listB, k = bisect(B, t);
    const zc = (c) => c.zk ?? c.z;
    if (k >= B.length) return zc(B[B.length - 1]);
    const prevZ = k === 0 ? D / 2 + 0.02 : zc(B[k - 1]);
    const prevT = k === 0 ? B[0].t - 0.4 : B[k - 1].t;
    const dn = Math.min(0.2, 0.8 * (B[k].t - prevT));
    const f = (t - (B[k].t - dn)) / dn;
    return f <= 0 ? prevZ : lerp(prevZ, zc(B[k]), smooth(f));
  };

  /** Pour rounds: clip depth follows the fractional cut index linearly, +D/2 -> -D/2, hitting -D/2 exactly on the last cut. */
  const pourProgress = (R, t) => {
    const L = R.list, n = L.length, k = bisect(L, t);
    if (k >= n) return 1;
    const t0 = k === 0 ? R.cutStart + 0.2 : L[k - 1].t;
    const u = clamp01((t - t0) / Math.max(1e-4, L[k].t - t0));
    return clamp01((k + (k === 0 ? 0 : u)) / n);
  };

  /** Knife pose at time t: z along the cut axis, h edge height above the table. Stroke shortens as cuts speed up. */
  const PARK_X = 2.7; // knife parked right of the block (outside its silhouette) while a block drops
  const hMinOf = (c) => (c.phase === 'a' ? H - 0.02 : 0); // phase A: edge stops on the top face; phase B: cuts to the table
  const poseAt = (R, t) => {
    const L = R.list, n = L.length, k = bisect(L, t);
    let tp, zp, tn, zn, mode, hp = 0, hn = 0;
    if (k === 0) { tp = R.cutStart; zp = LAYOUT.zIdle; tn = L[0].t; zn = L[0].z; mode = 'in'; hn = hMinOf(L[0]); }
    else if (k >= n) { tp = L[n - 1].t; zp = L[n - 1].zk ?? L[n - 1].z; tn = R.sweepEnd; zn = LAYOUT.zIdle; mode = 'out'; hp = hMinOf(L[n - 1]); }
    else { tp = L[k - 1].t; zp = L[k - 1].zk ?? L[k - 1].z; tn = L[k].t; zn = L[k].zk ?? L[k].z; mode = 'mid'; hp = hMinOf(L[k - 1]); hn = hMinOf(L[k]); }
    const I = Math.max(1e-4, tn - tp), u = clamp01((t - tp) / I);
    let z, h, x = 0, vib = 0;
    if (mode === 'in') {
      z = lerp(zp, zn, smooth(u)); h = lerp(HMAX, hn, smooth(u)); x = PARK_X * (1 - smooth(u));
    } else if (mode === 'out') {
      z = lerp(zp, zn, smooth(u)); h = lerp(hp, HMAX, smooth(u)); x = PARK_X * smooth(u);
    } else {
      z = lerp(zp, zn, smooth((u - 0.1) / 0.7));
      const base = lerp(hp, hn, smooth(u)), amp = Math.max(HMAX - base, 0.3);
      h = base + amp * clamp01(I / 0.4) * 0.5 * (1 - Math.cos(2 * Math.PI * u));
      vib = smooth(1 - I / 0.1); // ultra-fast regime: high-frequency vibration instead of full strokes
      h += vib * (0.5 + 0.5 * Math.sin(2 * Math.PI * 53 * t)) * 0.07;
    }
    return { x, z, h, vib };
  };

  const zoomAt = (R, t) => {
    const cp = smooth((t - R.cutStart) / (R.cutEnd - R.cutStart));
    const back = smooth((t - R.sweepStart) / (R.sweepEnd - R.sweepStart + 0.6));
    return lerp(1, R.zoom, cp) * (1 - back) + back * 1;
  };

  const pieces = (R, cuts) => Math.pow(Math.pow(R.cuts / 3 + 1, 3), clamp01(cuts / R.cuts));
  const sizeM = (R, cuts) => 0.042 * Math.pow(45e-6 / 0.042, clamp01((R.index + smooth(cuts / R.cuts)) / totalRounds));

  const goldPos = new THREE.Vector3();

  function render() {
    const t = S.t, R = roundAt(), dt = 1 / profile.fps;
    S.shake *= Math.exp(-dt * 9);

    // block: drop, turn, clip plane + cap
    if (S.alive) {
      const u = clamp01((t - R.dropStart) / T.drop);
      block.group.position.set(0, H / 2 + 5.2 * (1 - u * u), 0);
      block.group.visible = true;
      block.group.rotation.y = R.rot ? (Math.PI / 2) * smooth((t - R.rot.start) / T.rotate) : 0;
      const inB = R.mode === 'pour' || t > (R.rot ? R.rot.start : 0);
      if (R.mode === 'pour') {
        const p = pourProgress(R, t);
        block.setClip(D / 2 - p * D);
        // remaining slab crumbles away: face shrinks (about the table) over the last 30% of depth, no pop at the end
        const sc = Math.max(1e-3, smooth(clamp01((1 - p) / 0.3)));
        block.group.scale.set(sc, sc, 1);
        block.group.position.y = (H / 2) * sc;
        block.capGroup.scale.set(sc, sc, 1);
      } else {
        block.setClip(inB ? planeAt(R, t) : D / 2 + 1);
        block.group.scale.set(1, 1, 1);
        block.capGroup.scale.set(1, 1, 1);
      }
      const cp = clamp01((t - R.cutStart) / (R.cutEnd - R.cutStart));
      block.setHeat(clamp01(0.3 + 0.55 * (R.index / Math.max(1, totalRounds - 1)) + 0.15 * cp), t);
      if (u < 1 && t - R.dropStart + dt >= T.drop) S.shake = Math.min(0.09, S.shake + 0.05 + 0.01 * R.index); // impact
    } else {
      block.group.visible = false;
    }

    // knife
    const pose = poseAt(R, t);
    knife.group.position.set(pose.x + (pose.vib > 0 ? (Math.sin(t * 91) * 0.01 * pose.vib) : 0), pose.h + 0.004, pose.z);
    S.flash = Math.max(0, S.flash - dt * 2.5);
    const contact = 1 - clamp01(pose.h / 0.3);
    knife.updateGlow(t, S.flash, contact);
    knife.light.position.set(pose.x + 0.2, pose.h + 0.3, pose.z + 0.7);
    const gc = knife.ghostCount();
    knife.ghosts.forEach((g, i) => {
      if (i >= gc) { g.visible = false; return; }
      const p = poseAt(R, t - ((i + 1) / (gc + 1)) * (1.4 / profile.fps));
      g.visible = true;
      g.position.set(p.x, p.h + 0.004, p.z);
      g.material.opacity = knife.ghostOpacity() * (1 - i / (gc + 1));
    });

    // pour effects (pyramid + particles)
    const pouring = R.mode === 'pour';
    if (pouring && S.started && t < R.sweepEnd) S.pileP = clamp01(S.cutsDone / R.list.length);
    if (pouring && S.pourOn) S.shake = Math.min(0.09, S.shake + 0.0035);
    pile.update(S.pileP, t, S.sweepX);
    const tool = recipe.tools[R.tool];
    const emit = pouring && S.started ? [R.cutStart + 0.1, R.cutEnd] : [1e9, 1e9];
    particles.update(t, emit, (te) => poseAt(R, te).z, 0.55 + 0.45 * (R.index - 3), tool.edge, H);
    particles.points.visible = pouring;

    // sweeper pushes cubes / hides the pile
    if (S.sweepOn) {
      const f = clamp01((t - R.sweepStart) / T.sweep);
      S.sweepX = lerp(-3.4, 3.8, f);
      physics.sweep(S.sweepX);
    }
    sweeper.set(S.sweepX);

    // gold cube halo
    goldGlow.visible = physics.goldPosition(goldPos) && goldPos.y > -1;
    if (goldGlow.visible) goldGlow.position.copy(goldPos).add(new THREE.Vector3(0, 0.03, 0.05));

    // camera: slow zoom-in per round + deterministic micro-shake
    const z = zoomAt(R, t), sh = S.shake;
    placeCamera(camera, z, Math.sin(t * 47.3) * sh + Math.sin(t * 83.1 + 1.3) * sh * 0.5, Math.sin(t * 61.7 + 0.7) * sh);

    // HUD
    const inAlpha = smooth((t - 0.05) / 0.3), outAlpha = 1 - smooth((t - (duration - 0.5)) / 0.4);
    const titleAlpha = smooth(t / 0.15) * (1 - smooth((t - (T.hook - 0.45)) / 0.45));
    const cuts = S.started ? S.cutsDone : 0;
    hud.set({
      alpha: Math.min(inAlpha, outAlpha), titleAlpha,
      round: R.index, rounds: totalRounds, tool: R.tool, cuts, cutsTotal: R.cuts,
      roundProgress: clamp01(cuts / R.cuts),
      pieces: pieces(R, cuts), sizeM: sizeM(R, cuts),
    });
    renderer.render(scene, camera);
  }

  const advance = () => {
    while (S.evPtr < sched.length && sched[S.evPtr].time <= S.t) onEvent(sched[S.evPtr++]);
    if (S.started) {
      const R = rounds[S.round];
      while (S.cutPtr < R.list.length && R.list[S.cutPtr].t <= S.t) onCut(R, R.list[S.cutPtr++]);
    }
  };
  // Cuts of a round must run before its sweep_end etc., but events are strictly ordered per round, so a single pass is enough.

  advance();
  render();

  return {
    step(dt) {
      S.t += dt;
      advance();
      physics.step(dt);
      render();
    },
    isDone: () => S.t >= duration,
    getEvents: () => log.all(),
    info: () => ({
      width: profile.width, height: profile.height, fps: profile.fps, duration, knifeRaise: HMAX,
      rounds: rounds.length, events: timeline.events.length,
    }),
  };
}
