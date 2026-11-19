// Cube sampling for sliced slabs (rounds in "slice" mode). Cube count is capped by the profile budget.
import * as THREE from 'three';

export function planCubes(R, [W, H], maxCubes, nSlabs, rnd) {
  const s = R.cubeSize;
  const cols = Math.max(1, Math.round(W / s)), rows = Math.max(1, Math.round(H / s));
  const cells = cols * rows;
  const perSlab = Math.min(cells, Math.max(1, Math.floor((maxCubes * 0.92) / nSlabs)));
  const total = perSlab * nSlabs;
  return { cols, rows, cw: W / cols, rh: H / rows, cells, perSlab, goldIndex: Math.floor(rnd() * total), spawned: 0 };
}

const mix = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);

export function slabCells(plan, j, zLo, zHi, size, rnd, pal) {
  const [W, H, D] = size;
  const { cols, rows, cw, rh, perSlab, cells } = plan;
  const thick = zHi - zLo, zc = (zHi + zLo) / 2;
  const depth = Math.max(thick, 0.9 * Math.min(cw, rh));
  const idx = Array.from({ length: cells }, (_, i) => i);
  if (perSlab < cells) for (let i = 0; i < perSlab; i++) { const k = i + Math.floor(rnd() * (cells - i)); [idx[i], idx[k]] = [idx[k], idx[i]]; }
  const out = [];
  for (let n = 0; n < perSlab; n++) {
    const a = idx[n] % cols, b = Math.floor(idx[n] / cols);
    const x = -W / 2 + (a + 0.5) * cw, y = (b + 0.5) * rh;
    const nx = x / (W / 2), ny = (y - H / 2) / (H / 2), nz = zc / (D / 2);
    const edge = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz)), core = Math.hypot(nx, ny, nz);
    let color;
    if (core < 0.38) color = mix(pal.core, '#ffd27a', rnd() * 0.5);
    else if (edge > 0.8) color = mix(pal.shell, '#3c3a48', rnd() * 0.5);
    else color = mix(pal.inner, '#6a4a48', rnd() * 0.5);
    const gold = plan.spawned === plan.goldIndex;
    plan.spawned++;
    out.push({
      pos: [x, y + 0.004, zc],
      size: [cw * 0.94, rh * 0.94, depth * 0.94],
      color: gold ? new THREE.Color(pal.gold).getHex() : color.getHex(),
      gold,
      vel: [x * 0.7 + (rnd() - 0.5) * 0.6, 0.5 + rnd() * 1.2, 1.1 + rnd() * 1.6],
      ang: [(rnd() - 0.5) * 8, (rnd() - 0.5) * 8, (rnd() - 0.5) * 8],
    });
  }
  return out;
}
