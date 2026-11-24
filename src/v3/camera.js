// v3 camera: pure function of t. Key poses (smootherstep between keys, same schema as v2), slow orbital breathing, and per
// impact a micro shake measured in screen pixels (2-4 px, exponential decay over ~120 ms) + a +1.5% FOV zoom punch.
import * as THREE from 'three';
import { clamp01 } from '../util.js';

const sm5 = (u) => { u = clamp01(u); return u * u * u * (u * (u * 6 - 15) + 10); };

export function createCameraRigV3(recipe, tl, profile) {
  const V = recipe.v2, C = V.camera, K = { shakePx: 3, shakeMs: 120, punch: 0.015, punchMs: 140, ...(recipe.v3.kinetics ?? {}) };
  const keys = C.keys.map(([t, name]) => ({ t, ...C[name] }));
  const fin = V.finale;
  const P = new THREE.Vector3(), L = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3();
  const F = new THREE.Vector3(), Rt = new THREE.Vector3(), Up = new THREE.Vector3();
  const breath = THREE.MathUtils.degToRad(C.breath ?? 3);
  const hookEnd = V.hook.end, whipEnd = V.hook.whipEnd;

  return {
    apply(camera, t) {
      let k = 0;
      while (k < keys.length - 2 && t >= keys[k + 1].t) k++;
      const a = keys[k], b = keys[k + 1];
      const u = sm5((t - a.t) / Math.max(1e-6, b.t - a.t));
      P.fromArray(a.pos).lerp(B.fromArray(b.pos), u);
      L.fromArray(a.look).lerp(B.fromArray(b.look), u);
      let fov = a.fov + (b.fov - a.fov) * u;
      const w = sm5((t - hookEnd) / (whipEnd - hookEnd)) * (1 - sm5((t - fin.rewind) / (fin.converge - fin.rewind)));
      // final-pile hold: slow monotonic orbit drift (deg) that melts back into the rewind pose
      const hd = V.hold, drift = hd ? THREE.MathUtils.degToRad(hd.yaw) * sm5((t - hd.t0) / (hd.t1 - hd.t0)) * (1 - sm5((t - fin.rewind) / (fin.converge - fin.rewind))) : 0;
      const ang = breath * Math.sin((2 * Math.PI * 3 * t) / tl.duration) * w + drift;
      A.copy(P).sub(L).applyAxisAngle(B.set(0, 1, 0), ang);
      P.copy(L).add(A);
      // impact kinetics: pixel-space shake + FOV punch
      let sx = 0, sy = 0, punch = 0;
      const T = K.shakeMs / 1000;
      for (const R of tl.rounds) {
        const tau = t - R.impact;
        if (tau < 0 || tau > Math.max(T, K.punchMs / 1000)) continue;
        const px = (R.shakePx ?? K.shakePx) * (R.tier >= 3 ? 1.25 : 1);
        if (tau <= T) {
          const env = Math.exp(-tau / (T / 3.5)) * (1 - tau / T);
          sy += px * env * Math.sin(2 * Math.PI * 27 * tau + 0.4);
          sx += px * 0.6 * env * Math.sin(2 * Math.PI * 19 * tau + 1.7);
        }
        punch = Math.max(punch, K.punch * Math.exp(-tau / ((K.punchMs / 1000) / 3)));
      }
      fov *= 1 + punch;
      const dist = A.length();
      const wpp = (2 * dist * Math.tan(THREE.MathUtils.degToRad(fov / 2))) / profile.height;
      F.copy(L).sub(P).normalize();
      Rt.crossVectors(F, B.set(0, 1, 0)).normalize();
      Up.crossVectors(Rt, F);
      const off = B.copy(Rt).multiplyScalar(sx * wpp).addScaledVector(Up, sy * wpp);
      camera.position.copy(P).add(off);
      camera.lookAt(L.x + off.x, L.y + off.y, L.z + off.z);
      if (Math.abs(camera.fov - fov) > 1e-6) { camera.fov = fov; camera.updateProjectionMatrix(); }
    },
  };
}
