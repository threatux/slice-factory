// Pure scheduling: turns a recipe into per-round cut lists and a sorted list of audio/game events.
import { clamp01 } from './util.js';

const accelT = (s, p) => 1 - Math.pow(1 - clamp01(s), p); // fast-forward: intervals shrink toward the end

export function buildTimeline(recipe, { maxRounds = Infinity } = {}) {
  const T = { hook: 1.8, drop: 0.25, pre: 0.15, settle: 0.55, sweep: 0.55, tail: 0.5, rotate: 0.4, gap: 0.9, ...recipe.timing };
  const [, , D] = recipe.object.size;
  const events = [];
  const internal = [];
  const rounds = [];
  let t = 0;

  recipe.rounds.slice(0, maxRounds).forEach((rc, i) => {
    const tool = rc.tool;
    const R = {
      index: i, tool, cuts: rc.cuts, mode: rc.mode ?? 'slice', cubeSize: rc.cubeSize ?? 0.1,
      zoom: rc.zoom ?? 1, accel: rc.accel ?? 1.5,
      dropStart: t, dropEnd: t + T.drop,
    };
    R.cutStart = R.dropEnd + T.pre;
    R.cutEnd = R.cutStart + rc.duration;
    R.sweepStart = R.cutEnd + T.settle;
    R.sweepEnd = R.sweepStart + T.sweep;
    const N = rc.cuts;
    const list = [];
    const ev = (time, type, intensity) => events.push({ time, type, round: i, tool, intensity });

    ev(R.dropStart, 'drop', Math.min(1, 0.7 + 0.06 * i));

    if (R.mode === 'slice') {
      const nA = Math.floor(N / 2), nB = N - nA;
      const durA = (rc.duration - T.gap) * 0.5;
      const first = 0.28;
      for (let k = 0; k < nA; k++) {
        const time = R.cutStart + first + (durA - first) * (nA > 1 ? accelT(k / (nA - 1), R.accel) : 0);
        list.push({ t: time, z: -D / 2 + ((k + 1) * D) / (nA + 1), phase: 'a', idx: k });
      }
      const endA = R.cutStart + durA;
      const startB = R.cutEnd - (rc.duration - durA - T.gap);
      for (let k = 0; k < nB; k++) {
        const time = startB + (R.cutEnd - startB) * (nB > 1 ? accelT(k / (nB - 1), R.accel) : 1);
        list.push({ t: time, z: D / 2 - ((k + 1) * D) / (nB + 1), phase: 'b', idx: k });
      }
      R.rot = { start: endA + 0.22, end: endA + 0.22 + T.rotate };
      ev(R.rot.start, 'rotate', 0.5);
      const heavy = Math.max(0.3, 1 - 0.22 * i);
      for (const c of list) ev(c.t, 'chop', heavy);
    } else {
      const t0 = R.cutStart + 0.2;
      for (let k = 0; k < N; k++) {
        const time = t0 + (R.cutEnd - t0) * (N > 1 ? accelT(k / (N - 1), R.accel) : 1);
        list.push({ t: time, z: D / 2 - ((k + 1) * D) / (N + 1), phase: 'b', idx: k });
      }
      R.rot = null;
      ev(R.cutStart + 0.1, 'pour_start', 0.6 + 0.1 * (i % 2));
      // Ultra-fast chopping is batched into ~30 Hz audio hits.
      let bucketStart = -1, bucketTime = 0, count = 0;
      const flush = () => { if (count) ev(bucketTime, 'chop', Math.min(1, 0.2 + 0.15 * count)); count = 0; };
      for (const c of list) {
        if (c.t - bucketStart > 1 / 30) { flush(); bucketStart = c.t; bucketTime = c.t; }
        count++;
      }
      flush();
      ev(R.cutEnd + 0.2, 'pour_end', 0.9);
    }
    R.listB = list.filter((c) => c.phase === 'b');
    if (R.listB.length) R.listB[R.listB.length - 1].zk = -D / 2; // final stroke clears the block to 100% depth (slab z kept for cube planning)
    R.list = list;
    ev(R.sweepStart, 'sweep', 0.8);
    internal.push({ time: R.sweepEnd, type: 'sweep_end', round: i, tool, intensity: 0 });
    rounds.push(R);
    t = R.sweepEnd;
  });

  const byTime = (a, b) => a.time - b.time;
  events.sort(byTime);
  return { T, rounds, events, internal, duration: t + T.tail };
}
