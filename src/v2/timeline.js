// v2.0 (Levitate -> X/Y/Z slash -> drop -> shatter) pure schedule. Everything here is a function of the recipe + profile only:
// no state, no wall clock. game.js evaluates it at the simulation time t of each fixed step.
import { clamp01 } from '../util.js';
import { sphereCellKeep } from './sphere.js';
import { cylinderCellKeep } from './cylinder.js';

export const AXIS = { x: 0, y: 1, z: 2, d: 3 }; // d = diagonal flourish pass (no seams of its own)
const easeIO = (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(u)); // samurai stroke: slow-in, very fast middle, slow-out

/**
 * Timeline maths (world units: 1 = 10 cm, table top y = 0, ingot W x H x D centred on its own origin):
 *  - levitation: centre y = Y(t) + bob(t); bob/yaw periods divide the clip length, so pose(0) === pose(duration) (seamless loop).
 *  - drop: centre falls y(τ) = y0 - G τ²/2 with G = 2 (Ylev - H/2) / fall², so with y0 = Ylev the bottom face touches the table
 *    (centre = H/2) exactly at impact = dropStart + fall. Bob is faded to 0 before dropStart, i.e. y0 === Y exactly.
 *    Rounds that give `impact` derive dropStart = impact - fall(Y); rounds that give `dropAt` derive impact = dropAt + fall(Y).
 *  - the frame with t >= impact is the first frame of the shattered state; pieces spawn in the ingot frame at that same impact pose
 *    (centre y = H/2, yaw = yaw(dropStart)), so cell k occupies exactly the volume it had inside the ingot (1:1 swap, nothing below y = 0).
 */
export function buildTimelineV2(recipe, profile) {
  const V = recipe.v2;
  const [W, H, D] = recipe.object.size;
  const half = [W / 2, H / 2, D / 2];
  const duration = V.duration;
  const Y0 = V.levitateY;
  const G = (2 * (Y0 - H / 2)) / (V.fall * V.fall);
  const fallFrom = (y) => Math.sqrt((2 * (y - H / 2)) / G);
  const bob = { amp: 0.025, cycles: 18, yaw: 0.06, yawCycles: 9, ...V.bob };
  const reasm = V.reassemble ?? 0.3;
  const budget = profile.maxShards ?? 8000;
  const events = [];
  const ev = (time, type, extra = {}) => events.push({ time, type, ...extra });

  /** Grid scaled down (cube root) to the profile's instance budget; HUD labels stay as authored. */
  const sphere = recipe.object.shape === 'sphere';
  /** Sphere mode: pieces actually kept inside the ball (R1-R3 by volume, micro rounds by cell centre). */
  const sphereCount = (g, physics) => sphereCellKeep(g, W / 2, physics === 'rapier' ? 'volume' : 'center').reduce((s, v) => s + v, 0);
  const cyl = recipe.object.shape === 'cylinder';
  /** Cylinder mode: pieces kept inside the rod (R1-R3 by x/z footprint, micro rounds by cell centre). */
  const cylCount = (g, physics) => cylinderCellKeep(g, W / 2, physics === 'rapier' ? 'volume' : 'center').reduce((s, v) => s + v, 0);
  const fitGrid = (g, physics) => {
    if (cyl) { // largest uniform shrink whose in-rod piece count fits the instance budget
      if (cylCount(g, physics) <= budget) return [...g];
      let k = 1;
      while (k > 0.2 && cylCount(g.map((v) => Math.max(2, Math.floor(v * k))), physics) > budget) k -= 0.01;
      return g.map((v) => Math.max(2, Math.floor(v * k)));
    }
    if (sphere) { // largest uniform shrink whose in-ball piece count fits the instance budget
      if (sphereCount(g, physics) <= budget) return [...g];
      let k = 1;
      while (k > 0.2 && sphereCount(g.map((v) => Math.max(2, Math.floor(v * k))), physics) > budget) k -= 0.01;
      return g.map((v) => Math.max(2, Math.floor(v * k)));
    }
    const n = g[0] * g[1] * g[2];
    if (n <= budget) return [...g];
    const f = Math.cbrt(budget / n);
    return g.map((v) => Math.max(2, Math.floor(v * f)));
  };

  /** Pass list -> seam index ranges per axis (seams k = 1..n-1, split evenly between the passes of that axis) + blade plane offsets. */
  const planPasses = (passes, grid, round) => {
    const byAxis = [[], [], []];
    const out = passes.map((p) => {
      const a = AXIS[p.axis];
      const P = { axis: a, t0: p.t, t1: p.t + p.dur, dur: p.dur, fan: p.fan ?? 0, round, k0: 1, k1: 1, planes: [] };
      if (a < 3) byAxis[a].push(P);
      return P;
    });
    byAxis.forEach((list, a) => {
      const n = grid[a], seams = n - 1, m = list.length;
      list.forEach((P, j) => {
        P.k0 = 1 + Math.floor((j * seams) / m);
        P.k1 = 1 + Math.floor(((j + 1) * seams) / m);
        const span = (2 * half[a]) / n;
        const ks = [];
        for (let k = P.k0; k < P.k1; k++) ks.push(-half[a] + k * span);
        const want = P.fan ? Math.min(P.fan, Math.max(1, ks.length)) : Math.max(1, ks.length);
        if (ks.length <= want) P.planes = ks;
        else { // evenly spread fan inside the range of this pass
          const lo = ks[0], hi = ks[ks.length - 1];
          P.planes = Array.from({ length: want }, (_, i) => lo + ((hi - lo) * i) / Math.max(1, want - 1));
        }
      });
    });
    out.filter((P) => P.axis === 3).forEach((P) => {
      const want = P.fan || 1;
      P.planes = Array.from({ length: want }, (_, i) => -W * 0.62 + (1.24 * W * i) / Math.max(1, want - 1));
    });
    return out;
  };

  // ---- hook (macro teaser) ----
  const Hk = V.hook;
  const hook = { ...Hk, grid: Hk.grid, passes: planPasses(Hk.passes, Hk.grid, -1) };
  for (const P of hook.passes) ev(P.t0 + P.dur * 0.35, 'fan_slash', { round: -1, blades: P.planes.length, intensity: 0.85 });
  ev(Hk.end, 'whip', { intensity: 0.8 });

  // ---- rounds ----
  const rounds = V.rounds.map((rc, i) => {
    const grid = fitGrid(rc.grid, rc.physics ?? 'analytic');
    const Y = rc.levitateY ?? Y0;
    const fall = fallFrom(Y);
    const impact = rc.impact ?? rc.dropAt + fall;
    const R = {
      index: i, label: rc.label, pieces: rc.pieces, bonus: !!rc.bonus, start: rc.start, grid, authoredGrid: rc.grid,
      physics: rc.physics ?? 'analytic', tier: rc.tier ?? 1, Y, fall, impact, dropStart: impact - fall,
      shake: rc.shake ?? 0.08, pop: rc.pop ?? 2.5, spread: rc.spread ?? 8, pile: rc.pile ?? null, ruby: !!rc.ruby, silence: !!rc.silence, pulse: rc.pulse ?? 0,
      rise: rc.rise ?? null, rain: rc.rain ?? null, split: rc.split ?? null, damping: rc.damping ?? null, dust: !!rc.dust, drizzle: rc.drizzle ?? 0,
      reasmEnd: i === 0 ? rc.start : rc.start + reasm,
    };
    R.passes = planPasses(rc.passes, grid, i);
    R.cutEnd = Math.max(...R.passes.map((p) => p.t1));
    R.count = cyl ? cylCount(grid, R.physics) : sphere ? sphereCount(grid, R.physics) : grid[0] * grid[1] * grid[2];
    if (i > 0) ev(R.start, 'transition', { round: i, intensity: 0.7 });
    for (const P of R.passes) {
      const type = P.fan ? 'fan_slash' : 'slash';
      ev(P.t0 + P.dur * 0.35, type, { round: i, blades: P.planes.length, axis: 'xyzd'[P.axis], intensity: Math.min(1, 0.75 + 0.05 * i) });
    }
    if (R.silence) ev(R.cutEnd + 0.04, 'tension_pause', { round: i, until: R.impact, intensity: 0 });
    ev(R.impact, 'impact_shatter', { round: i, tier: R.tier, pieces: R.count, label: R.pieces, intensity: 1 });
    return R;
  });
  rounds.forEach((R, i) => { R.end = i + 1 < rounds.length ? rounds[i + 1].start : duration; });

  const fin = V.finale;
  ev(fin.rewind, 'rewind', { until: duration, intensity: 1 });
  ev(duration, 'end', { intensity: 0 });
  events.sort((a, b) => a.time - b.time);

  // ---- pure pose / progress helpers ----
  const yLev = (t) => {
    if (t >= fin.rewind) return Y0; // rewind converges to the frame-0 pose
    for (const R of rounds) {
      if (!R.rise || t < R.start || t >= R.end) continue;
      const u = clamp01((t - R.rise[0]) / (R.rise[1] - R.rise[0]));
      return Y0 + (R.Y - Y0) * easeIO(u);
    }
    return Y0;
  };
  const roundAt = (t) => { let r = -1; for (const R of rounds) if (t >= R.start) r = R.index; return r; };
  /** Levitation envelope: bob/yaw sway fades out before each drop and back in after the reassembly. */
  const swayEnv = (t) => {
    const r = roundAt(t);
    if (r < 0 || t >= fin.rewind) return 1;
    return clamp01((rounds[r].dropStart - 0.05 - t) / 0.35);
  };
  const sway = (t, env = swayEnv(t)) => ({
    dy: bob.amp * Math.sin((2 * Math.PI * bob.cycles * t) / duration) * env,
    yaw: bob.yaw * Math.sin((2 * Math.PI * bob.yawCycles * t) / duration) * env,
  });
  /** Ingot pose at time t (visible or not): { y, yaw }. During a drop the pose is ballistic, after impact it rests at H/2. */
  const ingotPose = (t) => {
    const r = roundAt(t);
    if (r >= 0 && t < fin.rewind) {
      const R = rounds[r];
      if (t >= R.dropStart) {
        const tau = Math.min(t, R.impact) - R.dropStart;
        return { y: Math.max(H / 2, R.Y - 0.5 * G * tau * tau), yaw: 0 };
      }
    }
    const s = sway(t);
    return { y: yLev(t) + s.dy, yaw: s.yaw };
  };

  /**
   * Seam state of the levitating ingot at t: per axis { lo, hi, rev, flash } (seams k < lo fully lit, lo <= k < hi revealed
   * behind the blade edge with progress rev), plus grid, global alpha and pulse. Hook seams fade out during the whip.
   */
  const strokeU = (P, t) => easeIO((t - P.t0) / P.dur);
  const passReveal = (P, t) => { // fraction of the ingot the blade edge has crossed (exactly synced with bladeEdge)
    if (t <= P.t0) return 0;
    if (t >= P.t1) return 1;
    const a = P.axis === 1 ? 2 : 1, ext = half[a], o = V.knife.overshoot ?? 0.6;
    const e = ext + o - strokeU(P, t) * 2 * (ext + o);
    return clamp01((ext - e) / (2 * ext));
  };
  const seamState = (t) => {
    let ctx = null, alpha = 1;
    if (t < rounds[0].start) {
      ctx = hook;
      alpha = 1 - clamp01((t - Hk.end) / (Hk.whipEnd - Hk.end) * 1.6);
    } else {
      const r = roundAt(t);
      ctx = rounds[r];
    }
    const st = [0, 1, 2].map(() => ({ lo: 1, hi: 1, rev: 0, flash: 0 }));
    for (const P of ctx.passes) {
      if (P.axis > 2 || t < P.t0) continue;
      const s = st[P.axis];
      s.lo = P.k0; s.hi = P.k1; s.rev = passReveal(P, t);
      s.flash = t < P.t1 ? 1 : Math.exp(-(t - P.t1) / 0.22);
    }
    // loop closure: the re-assembled ingot sheds its seams over the last (duration - converge) s, so frame(end) === frame(0)
    if (t >= fin.converge) { const u = clamp01((t - fin.converge) / Math.max(1e-6, duration - fin.converge)); alpha = 1 - u * u * (3 - 2 * u); }
    const R = ctx === hook ? null : ctx;
    const pulse = R && R.pulse ? 0.75 + 0.25 * Math.sin(t * 2 * Math.PI * 2.2) : 1;
    return { grid: ctx.grid, axes: st, alpha, pulse, round: R ? R.index : -1 };
  };

  return { duration, G, Y0, rounds, hook, events, ingotPose, seamState, strokeU, passReveal, roundAt, yLev, size: [W, H, D], half };
}
