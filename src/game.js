import * as THREE from 'three';
import { LAYOUT } from './config.js';
import { createScene } from './scene.js';
import { createBlock, createKnife, CLIP_OFF } from './objects.js';
import { createPhysics } from './physics.js';
import { createPile, createStream, createSparks, createSweeper, createGoldGlow } from './effects.js';
import { createHud } from './hud.js';
import { createEventLog } from './audio.js';
import { buildTimeline } from './timeline.js';
import { planSlabs, slabCells, makeShardGeometry, makeShardMaterial } from './slabs.js';
import { makeObsidian, makeCap } from './textures.js';
import { mulberry32, clamp01, lerp, smooth } from './util.js';

const PUNCH = [0.055, 0.022, 0.008, 0, 0]; // damped vertical camera punch per cut, by round (heavy R1 hits)
const SIZE0 = 0.042; // whole block, metres (HUD)
const SNAP_FRAC = 0.2; // a phase-B slab breaks off when the knife edge passes 20% of the block height
const KNIFE_HALF = LAYOUT.knife.thickness / 2; // blade half thickness: the blade face sits exactly on the cut plane

/*
 * Invariants (world space, table top y = 0, block centred at x = z = 0, size W x H x D, cut planes are z = const):
 *  - slice rounds: during drop, phase A and the 90° turn the clip plane is off (CLIP_OFF) and the cap hidden.
 *    Phase-B cut k (plane z_k = c.zk ?? c.z) "snaps" at ts_k = time the descending edge crosses SNAP_FRAC·H:
 *    clip = z_{k-1} (or off) before ts_k, z_k from ts_k on. The slab [z_k, z_{k-1}] spawns at ts_k with piece centres at
 *    (z_k + z_{k-1})/2 + 0.02, i.e. strictly in front of the blade (blade at z_k, half thickness 0.015).
 *    The knife only changes z while its edge is above the block, so during every descent knife.z === z_k.
 *  - phase-A kerf k is drawn from the block top down to the current edge height while the knife descends (synchronised).
 *  - pour rounds: knife.z = clipZ + KNIFE_HALF at all times while cutting; the stream leaves the edge/face contact line.
 *  - every round starts with the knife parked off-frame (PARK) until the dropped block has settled.
 */
export async function createGame(profile, recipe, opts = {}) {
  const pal = recipe.palette;
  const size = recipe.object.size;
  const [W, H, D] = size;
  const timeline = buildTimeline(recipe, opts);
  const { T, rounds, duration } = timeline;
  const sched = [...timeline.events, ...timeline.internal].sort((a, b) => a.time - b.time);
  const log = createEventLog(timeline.events);
  const totalRounds = recipe.rounds.length;

  const { renderer, scene, camera, knifeLight } = createScene(profile, pal);
  const hud = createHud(profile, recipe);
  const obs = makeObsidian(pal);
  const physics = await createPhysics({
    maxCubes: profile.maxCubes, maxInstances: Math.round(profile.maxCubes * 2.5), scene, table: LAYOUT.table.size,
    geometry: makeShardGeometry(), material: makeShardMaterial(obs, makeCap(pal, W / H)),
  });
  const block = await createBlock(recipe.object, pal);
  scene.add(block.group, block.capGroup);
  const knife = await createKnife(recipe.tools, pal.accent);
  scene.add(knife.group, knife.light, ...knife.ghosts);
  const pxScale = profile.height / (2 * Math.tan(THREE.MathUtils.degToRad(LAYOUT.camera.fov / 2)));
  const piles = {
    gravel: createPile({ pal, kind: 'gravel', chunks: Math.round(Math.min(900, profile.maxCubes * 1.5)), pxScale }),
    sand: createPile({ pal, kind: 'sand', seed: 9, pxScale }),
  };
  const stream = createStream({ count: Math.round(Math.min(6000, Math.max(1600, profile.maxCubes * 4.5))), pal, pxScale });
  const sparks = createSparks({ pal, pxScale });
  const sweeper = createSweeper(pal, pxScale);
  const goldGlow = createGoldGlow(pal);
  scene.add(piles.gravel.group, piles.sand.group, stream.group, sparks.group, sweeper.group, sweeper.wave, goldGlow);
  scene.remove(knifeLight);

  // ---- camera framing + knife safety against the top HUD ---------------------------------------
  const look = new THREE.Vector3(...LAYOUT.camera.look);
  const camBase = new THREE.Vector3(...LAYOUT.camera.pos);
  const minZoom = Math.min(1, ...rounds.map((r) => r.zoom));
  const tmp = new THREE.Vector3();
  const placeCamera = (cam, zoom, ox = 0, oy = 0) => {
    cam.position.copy(look).addScaledVector(tmp.copy(camBase).sub(look), zoom);
    cam.position.x += ox; cam.position.y += oy;
    cam.lookAt(look.x + ox * 0.5, look.y + oy * 0.6, look.z);
    cam.updateMatrixWorld(true);
  };
  const probe = camera.clone();
  const topPx = (raise, zoom) => {
    placeCamera(probe, zoom);
    let best = Infinity;
    for (const [x, y, z] of knife.topPoints()) {
      for (const zz of [-D / 2, D / 2]) {
        const v = tmp.set(x, y + raise, z + zz).project(probe);
        best = Math.min(best, ((1 - v.y) / 2) * profile.height);
      }
    }
    return best;
  };
  const safePx = LAYOUT.hudSafeTop * profile.height + 0.02 * profile.height;
  let lo = 0, hi = LAYOUT.knife.maxRaise;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (Math.min(topPx(mid, 1), topPx(mid, minZoom)) >= safePx) lo = mid; else hi = mid;
  }
  const HMAX = lo;
  // Stroke apex: the edge must clear the block top so the blade only ever travels in z above it.
  const HTOP = Math.max(HMAX, H + 0.26);
  const [PARK_X, PARK_H, PARK_Z] = LAYOUT.knife.park;

  // ---- state ----------------------------------------------------------------------------------
  const S = {
    t: 0, round: 0, evPtr: 0, cutPtr: 0, snapPtr: 0, fxPtr: 0, cutsDone: 0, alive: false, pourOn: false, pileP: 0, sweepX: null,
    flash: 0, rnd: mulberry32(1), plan: null, started: false, sweepOn: false,
  };
  const seed = recipe.seed ?? 1337;
  const R0 = rounds[0];

  // ---- pure helpers -----------------------------------------------------------------------------
  const roundAt = () => rounds[S.round] ?? R0;
  const bisect = (L, t, key = 't') => { let a = 0, b = L.length; while (a < b) { const m = (a + b) >> 1; if (L[m][key] <= t) a = m + 1; else b = m; } return a; };
  const zOf = (c) => c.zk ?? c.z;

  /** Pour rounds: cut depth follows the fractional cut index linearly, +D/2 -> -D/2, hitting -D/2 exactly on the last cut. */
  const pourProgress = (R, t) => {
    const L = R.list, n = L.length, k = bisect(L, t);
    if (k >= n) return 1;
    const t0 = k === 0 ? R.cutStart + 0.2 : L[k - 1].t;
    const u = clamp01((t - t0) / Math.max(1e-4, L[k].t - t0));
    return clamp01((k + (k === 0 ? 0 : u)) / n);
  };
  const pourZ = (R, t) => D / 2 - pourProgress(R, t) * D;
  const faceScaleAt = (R, t) => smooth(clamp01((1 - pourProgress(R, t)) / 0.3));

  /**
   * Knife pose at time t: x, z, h (edge height above the table).
   * Slice rounds: every stroke goes from above the block straight down to the table; z only changes while the edge is above the block.
   * Entry/exit: the knife parks high up-right (never crosses the dropping block) and enters from above.
   */
  const strokeBump = (u) => Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.55);
  // Phase A (monolith): snap out of the block right after the hit (ease-out over 75% of the cycle), sharp strike in the last 25%.
  const strokeA = (u) => (u < 0.75 ? 1 - Math.pow(1 - u / 0.75, 4) : 1 - ((u - 0.75) / 0.25) ** 2);
  const POUR_HOLD = 0.15; // pour rounds: knife stays parked off-frame until the dropped block has settled
  const PARK = { x: PARK_X, z: PARK_Z, h: PARK_H, vib: 0 };
  const poseAt = (R, t) => {
    const L = R.list, n = L.length, k = bisect(L, t), pour = R.mode === 'pour';
    if (k === 0) { // enter: glide high to above the first cut, then chop down
      const tp = R.dropEnd + (pour ? POUR_HOLD : 0), tn = L[0].t;
      if (t <= tp) return PARK;
      const u = clamp01((t - tp) / Math.max(1e-4, tn - tp));
      const a = smooth(u / 0.6), b = clamp01((u - 0.6) / 0.4);
      const zT = pour ? D / 2 + KNIFE_HALF : zOf(L[0]);
      const z = lerp(PARK_Z, zT, a), x = lerp(PARK_X, 0, a);
      const h = u < 0.6 ? lerp(PARK_H, HTOP, a) : lerp(HTOP, 0, b * b);
      return { x, z, h, vib: 0 };
    }
    if (k >= n) { // exit: lift clear, then glide to the parking spot (reached well before the next drop)
      const tp = L[n - 1].t, tn = R.sweepEnd, u = clamp01((t - tp) / Math.max(1e-4, tn - tp));
      const a = smooth(u / 0.25), b = smooth((u - 0.25) / 0.55);
      const zp = pour ? -D / 2 + KNIFE_HALF : zOf(L[n - 1]);
      return { x: lerp(0, PARK_X, b), z: lerp(zp, PARK_Z, b), h: lerp(lerp(0, HTOP, a), PARK_H, b), vib: 0 };
    }
    const tp = L[k - 1].t, tn = L[k].t;
    const I = Math.max(1e-4, tn - tp), u = clamp01((t - tp) / I);
    if (!pour) {
      const zp = zOf(L[k - 1]), zn = zOf(L[k]);
      if (L[k].phase === 'a') {
        const z = lerp(zp, zn, smooth((u - 0.3) / 0.42)); // z only shifts while the edge is above the block
        return { x: 0, z, h: HTOP * strokeA(u), vib: 0 };
      }
      const z = lerp(zp, zn, smooth((u - 0.3) / 0.4));
      const h = HTOP * strokeBump(u);
      if (L[k - 1].phase !== 'a') return { x: 0, z, h, vib: 0 };
      // A -> B transition (the 90° turn): the knife backs off toward its parking spot so the turning block stays fully
      // visible, and is back above the first B plane before the edge reaches the block top.
      const w = 0.7 * Math.pow(Math.sin(Math.PI * clamp01((u - 0.08) / 0.62)), 0.7);
      return { x: lerp(0, PARK_X, w), z: lerp(z, PARK_Z, w), h: lerp(h, Math.max(h, PARK_H), w), vib: 0 };
    }
    // pour: the blade face rides exactly on the melting cut face; strokes stay inside the (shrinking) face and
    // shorten into a high-frequency vibration as the cuts accelerate
    const z = pourZ(R, t) + KNIFE_HALF;
    const amp = Math.min(Math.max(HTOP * 0.6, 0.3), 0.72 * H * faceScaleAt(R, t));
    let h = amp * clamp01(I / 0.4) * 0.5 * (1 - Math.cos(2 * Math.PI * u));
    const vib = smooth(1 - I / 0.1);
    h += vib * (0.5 + 0.5 * Math.sin(2 * Math.PI * 53 * t)) * 0.06;
    return { x: 0, z, h, vib };
  };

  /** Time at which the knife edge descends through height y in the stroke that ends with cut c (index k of R.list). */
  const crossDown = (R, k, y) => {
    const L = R.list, tn = L[k].t, tp = k === 0 ? R.dropEnd : L[k - 1].t;
    const step = (tn - tp) / 128;
    let a = tn;
    while (a - step > tp && poseAt(R, a - step).h < y) a -= step;
    let lo2 = Math.max(tp, a - step), hi2 = a;
    for (let i = 0; i < 28; i++) { const m = (lo2 + hi2) / 2; if (poseAt(R, m).h >= y) lo2 = m; else hi2 = m; }
    return hi2;
  };

  /** Per-round precompute (slice rounds): kerf entry times, slab snap times, contact-spark schedule. */
  const prepareRound = (R) => {
    if (R.prepared) return;
    R.prepared = true;
    R.listA = R.list.filter((c) => c.phase === 'a');
    R.fx = [];
    if (R.mode !== 'slice') return;
    R.list.forEach((c, k) => {
      c.tEntry = crossDown(R, k, H);
      if (c.phase === 'b') c.ts = crossDown(R, k, SNAP_FRAC * H);
    });
    const big = R.index === 0;
    for (const c of R.listA) {
      R.fx.push({ t: c.tEntry, z: c.z, xr: [-W / 2, W / 2], y: H, n: big ? 8 : 4 }); // blade bites into the top
      R.fx.push({ t: crossDown(R, R.list.indexOf(c), 0.5 * H), z: c.z, xr: [W / 2 - 0.02, W / 2], y: 0.5 * H, n: big ? 4 : 2 }); // side contact
      R.fx.push({ t: c.t, z: c.z, xr: [-W / 2, W / 2], y: 0.02, n: big ? 6 : 3 }); // bottom impact
    }
    for (const c of R.listB) {
      R.fx.push({ t: c.tEntry, z: zOf(c), xr: [-W / 2, W / 2], y: H, n: big ? 8 : 3 });
      R.fx.push({ t: c.ts, z: zOf(c), xr: [-W / 2, W / 2], y: SNAP_FRAC * H, n: big ? 6 : 3 });
    }
    R.fx.sort((a, b) => a.t - b.t);
  };

  const startRound = (i) => {
    const R = rounds[i];
    prepareRound(R);
    S.round = i; S.cutPtr = 0; S.snapPtr = 0; S.fxPtr = 0; S.cutsDone = 0; S.alive = true; S.pourOn = false; S.pileP = 0; S.started = true;
    S.rnd = mulberry32(seed + i * 977);
    S.plan = R.mode === 'slice' ? planSlabs(R, size, physics.capacity, R.listB.length + 1, S.rnd) : null;
    block.reset();
    sparks.clear();
    knife.setTool(R.tool);
    S.flash = 1;
  };

  /** Slab j lies between plane j-1 (or the front face) and plane j (or the back face). */
  const spawnSlab = (R, j) => {
    const B = R.listB, nB = B.length;
    const zHi = j === 0 ? D / 2 : zOf(B[j - 1]), zLo = j < nB ? zOf(B[j]) : -D / 2;
    if (zHi - zLo < 1e-4) return;
    physics.spawn(slabCells(S.plan, j, zLo, zHi, size, S.rnd, pal));
  };

  const onSnap = (R, j) => {
    const nB = R.listB.length;
    if (j === nB - 1) {
      // final stroke clears the block to 100% depth: the last two slabs (split at the planned plane) fall together
      const zHi = j === 0 ? D / 2 : zOf(R.listB[j - 1]), zMid = R.listB[j].z;
      physics.spawn(slabCells(S.plan, j, zMid, zHi, size, S.rnd, pal));
      physics.spawn(slabCells(S.plan, j + 1, -D / 2, zMid, size, S.rnd, pal));
      S.alive = false; block.hide();
    } else spawnSlab(R, j);
  };

  const onCut = (R) => {
    S.cutsDone++;
    if (R.mode === 'pour' && S.cutsDone === R.list.length) { S.alive = false; block.hide(); }
  };

  const onEvent = (e) => {
    switch (e.type) {
      case 'drop': startRound(e.round); break;
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

  const zoomAt = (R, t) => {
    const cp = smooth((t - R.cutStart) / (R.cutEnd - R.cutStart));
    const back = smooth((t - R.sweepStart) / (R.sweepEnd - R.sweepStart + 0.25));
    return lerp(1, R.zoom, cp) * (1 - back) + back * 1;
  };

  /** Damped vertical punch: block impact + heavy cuts (deterministic, from event times). */
  const punchAt = (R, t) => {
    let y = 0;
    const td = t - R.dropEnd;
    if (td >= 0 && td < 0.7) y += 0.07 * Math.exp(-td * 8) * Math.sin(td * 34);
    const A = PUNCH[Math.min(R.index, PUNCH.length - 1)];
    if (A > 0) {
      const L = R.list, k = bisect(L, t);
      for (let i = k - 1; i >= Math.max(0, k - 6); i--) {
        const tau = t - L[i].t;
        if (tau > 0.6) break;
        y += A * Math.exp(-tau * 11) * Math.sin(tau * 40 + 0.4);
      }
    }
    return -y;
  };

  /** Barely visible micro-vibration of the block from each blade impact (phase-A bottom hits, phase-B break-offs). */
  const impactAt = (R, t) => {
    const out = { x: 0, y: 0 };
    if (R.mode !== 'slice') return out;
    const A = 0.0045 / (1 + R.index);
    const scan = (L, key) => {
      for (let i = bisect(L, t, key) - 1; i >= 0; i--) {
        const tau = t - L[i][key];
        if (tau > 0.35) break;
        const e = A * Math.exp(-tau * 26);
        out.y += e * Math.sin(tau * 110); out.x += 0.6 * e * Math.sin(tau * 150 + 1.3);
      }
    };
    scan(R.listA, 't'); scan(R.listB, 'ts');
    return out;
  };

  const pieces = (R, cuts) => Math.pow(Math.pow(R.cuts / 3 + 1, 3), clamp01(cuts / R.cuts));
  /** Each round restarts from the whole block (4.2 cm) and shrinks geometrically to that round's final particle size. */
  const sizeM = (R, cuts) => SIZE0 * Math.pow(R.finalSize / SIZE0, clamp01(cuts / R.cuts));

  const goldPos = new THREE.Vector3();

  function render() {
    const t = S.t, R = roundAt(), dt = 1 / profile.fps;
    const pose = poseAt(R, t);

    // block: drop, turn, clip plane + cap, kerfs
    if (S.alive) {
      const u = clamp01((t - R.dropStart) / T.drop);
      const dropH = R.index === 0 ? 0.75 : 5.2; // R1: block is already in frame on frame 0
      const imp = impactAt(R, t);
      block.group.position.set(imp.x, H / 2 + dropH * (1 - u * u) + imp.y, 0);
      block.capGroup.position.set(imp.x, imp.y, 0);
      block.group.visible = true;
      block.group.rotation.y = R.rot ? (Math.PI / 2) * smooth((t - R.rot.start) / (R.rot.end - R.rot.start)) : 0;
      if (R.mode === 'pour') {
        if (S.cutsDone === 0) {
          block.setClip(CLIP_OFF); // untouched block: no clip plane on the front face, no cap
          block.group.scale.set(1, 1, 1);
          block.capGroup.scale.set(1, 1, 1);
        } else {
          block.setClip(pourZ(R, t));
          // remaining slab crumbles away: face shrinks (about the table) over the last 30% of depth, no pop at the end
          const sc = Math.max(1e-3, faceScaleAt(R, t));
          block.group.scale.set(sc, sc, 1);
          block.group.position.y = (H / 2) * sc + imp.y;
          block.capGroup.scale.set(sc, sc, 1);
        }
        block.setKerf(0, 1, 0, 0);
      } else {
        // clip is a pure function of time: off until the first phase-B break-off, then the last snapped plane
        const kS = bisect(R.listB, t, 'ts');
        block.setClip(kS === 0 ? CLIP_OFF : zOf(R.listB[kS - 1]));
        block.group.scale.set(1, 1, 1);
        block.capGroup.scale.set(1, 1, 1);
        // phase-A kerfs: the newest one opens from the top down exactly to the descending edge
        const LA = R.listA, nA = LA.length, kA = bisect(LA, t);
        let count = kA, cutY = 0, flash = kA > 0 ? 3.0 * Math.exp(-(t - LA[kA - 1].t) * 7) : 0;
        if (kA < nA && t >= LA[kA].tEntry) { count = kA + 1; cutY = clamp01(pose.h / H) * H; flash = 2.4; }
        block.setKerf(count, nA, cutY, flash, pal.core);
      }
      const cp = clamp01((t - R.cutStart) / (R.cutEnd - R.cutStart));
      block.setHeat(clamp01(0.3 + 0.55 * (R.index / Math.max(1, totalRounds - 1)) + 0.15 * cp), t);
    } else {
      block.group.visible = false;
    }

    // knife
    knife.group.position.set(pose.x + (pose.vib > 0 ? (Math.sin(t * 91) * 0.01 * pose.vib) : 0), pose.h + 0.004, pose.z);
    S.flash = Math.max(0, S.flash - dt * 2.5);
    const contact = 1 - clamp01(pose.h / 0.3);
    knife.updateGlow(t, S.flash, contact);
    // the tool light only exists near the block (no coloured spill on the pile / table while parked or leaving)
    const presence = 1 - smooth((Math.hypot(pose.x, Math.max(0, pose.h - H)) - 0.4) / 1.0);
    knife.light.intensity *= presence;
    knife.light.position.set(pose.x + 0.2, pose.h + 0.3, pose.z + 0.2);
    const gc = knife.ghostCount();
    knife.ghosts.forEach((g, i) => {
      if (i >= gc) { g.visible = false; return; }
      const p = poseAt(R, t - ((i + 1) / (gc + 1)) * (1.4 / profile.fps));
      g.visible = true;
      g.position.set(p.x, p.h + 0.004, p.z);
      g.material.opacity = knife.ghostOpacity() * (1 - i / (gc + 1));
    });

    // sweeper: pushes rigid pieces; for heaps it clips the heap at its front face and rolls a wave of swept material
    if (S.sweepOn) {
      S.sweepX = lerp(-3.4, 3.8, clamp01((t - R.sweepStart) / T.sweep));
      physics.sweep(S.sweepX);
    }

    // pour effects: cone grows from the first cuts, grains fly from the edge/face contact line onto its apex
    const pouring = R.mode === 'pour' && S.started;
    const pile = piles[R.pile] ?? piles.gravel;
    for (const p of Object.values(piles)) if (p !== pile) p.group.visible = false;
    if (pouring && t < R.sweepEnd) S.pileP = clamp01(S.cutsDone / R.list.length);
    pile.update(pouring ? S.pileP : 0, t, S.sweepX);
    stream.setVisible(pouring);
    if (pouring) {
      const progAt = (te) => clamp01(bisect(R.list, te) / R.list.length);
      stream.update(t, {
        kind: R.pile, emit: [R.list[0].t - 0.02, R.cutEnd], zAt: (te) => pourZ(R, te),
        hAt: (te) => poseAt(R, te).h, faceScale: (te) => faceScaleAt(R, te), size: [W, H], pile, progressAt: progAt,
        density: R.pile === 'sand' ? 1 : 0.55,
      });
    }
    sparks.update(t);

    sweeper.set(S.sweepX, pouring ? { pile, kind: R.pile, t } : null);

    // gold cube halo
    goldGlow.visible = physics.goldPosition(goldPos) && goldPos.y > -1;
    if (goldGlow.visible) goldGlow.position.copy(goldPos).add(new THREE.Vector3(0, 0.03, 0.05));

    // camera: per-round push-in (R3–R5), damped punch on heavy hits, clean return on the sweep
    placeCamera(camera, zoomAt(R, t), 0, S.started ? punchAt(R, t) : 0);

    // HUD
    const inAlpha = smooth((t - 0.05) / 0.3), outAlpha = 1 - smooth((t - (duration - 0.5)) / 0.4);
    const titleAlpha = smooth(t / 0.12) * (1 - smooth((t - 1.2) / 0.4)); // hook card: 0.0–1.6 s
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
      const R = rounds[S.round], tool = recipe.tools[R.tool];
      while (S.fxPtr < R.fx.length && R.fx[S.fxPtr].t <= S.t) {
        const f = R.fx[S.fxPtr++];
        sparks.hit(f.t, f.z, f.xr, f.y, f.n, tool.edge);
      }
      if (R.mode === 'slice') while (S.snapPtr < R.listB.length && R.listB[S.snapPtr].ts <= S.t) onSnap(R, S.snapPtr++);
      while (S.cutPtr < R.list.length && R.list[S.cutPtr].t <= S.t) { S.cutPtr++; onCut(R); }
    }
  };
  // Events are strictly ordered per round (drop -> cuts -> sweep -> sweep_end), so a single pass per frame is enough.

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
      width: profile.width, height: profile.height, fps: profile.fps, duration, knifeRaise: HMAX, strokeTop: HTOP,
      rounds: rounds.length, events: timeline.events.length,
    }),
    /** debug probe (snapshots): knife / clip / piece state */
    probe: () => ({ t: S.t, knife: knife.group.position.toArray(), clipZ: block.clipZ, pieces: physics.count, cuts: S.cutsDone }),
  };
}
