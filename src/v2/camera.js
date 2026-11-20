// v2 camera: pure function of t. Key poses from recipe.v2.camera (smootherstep between keys), slow orbital "breathing"
// (±breath° yaw, zero at the macro ends so frame(0) === frame(duration)), damped-sine micro shake at every impact.
import * as THREE from 'three';
import { clamp01 } from '../util.js';

const sm5 = (u) => { u = clamp01(u); return u * u * u * (u * (u * 6 - 15) + 10); };

export function createCameraRig(recipe, tl) {
  const C = recipe.v2.camera;
  const keys = C.keys.map(([t, name]) => ({ t, ...C[name] }));
  const fin = recipe.v2.finale;
  const P = new THREE.Vector3(), L = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3();
  const breath = THREE.MathUtils.degToRad(C.breath ?? 4);
  const hookEnd = recipe.v2.hook.end, whipEnd = recipe.v2.hook.whipEnd;

  return {
    apply(camera, t) {
      let k = 0;
      while (k < keys.length - 2 && t >= keys[k + 1].t) k++;
      const a = keys[k], b = keys[k + 1];
      const u = sm5((t - a.t) / Math.max(1e-6, b.t - a.t));
      P.fromArray(a.pos).lerp(B.fromArray(b.pos), u);
      L.fromArray(a.look).lerp(B.fromArray(b.look), u);
      const fov = a.fov + (b.fov - a.fov) * u;
      // breathing orbit around the look target (off on the macro ends of the loop)
      const w = sm5((t - hookEnd) / (whipEnd - hookEnd)) * (1 - sm5((t - fin.rewind) / (fin.converge - fin.rewind)));
      const ang = breath * Math.sin((2 * Math.PI * 3 * t) / tl.duration) * w;
      A.copy(P).sub(L).applyAxisAngle(B.set(0, 1, 0), ang);
      P.copy(L).add(A);
      // impact micro shake: damped sine, 0.18 s
      let sy = 0, sx = 0;
      for (const R of tl.rounds) {
        const tau = t - R.impact;
        if (tau < 0 || tau > 0.18) continue;
        const env = Math.exp(-tau / 0.055) * (1 - tau / 0.18);
        sy += R.shake * env * Math.sin(2 * Math.PI * 23 * tau);
        sx += R.shake * 0.45 * env * Math.sin(2 * Math.PI * 17 * tau + 1.3);
      }
      camera.position.set(P.x + sx, P.y + sy, P.z);
      camera.lookAt(L.x + sx * 0.5, L.y + sy * 0.6, L.z);
      if (Math.abs(camera.fov - fov) > 1e-6) { camera.fov = fov; camera.updateProjectionMatrix(); }
    },
  };
}
