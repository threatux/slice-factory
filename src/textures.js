// Procedural canvas textures (no external assets).
import * as THREE from 'three';
import { mulberry32 } from './util.js';

function canvasTex(w, h, paint, { srgb = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  paint(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, ctx, canvas };
}
const rgba = (c, a = 1) => {
  const h = new THREE.Color(c).getHex();
  return `rgba(${(h >> 16) & 255},${(h >> 8) & 255},${h & 255},${a})`;
};
const clamp = (x, a = 0, b = 255) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---- noise -------------------------------------------------------------------------------------
function hash2(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Periodic value noise (period in cells; optional separate y period). */
function vnoise(x, y, period, seed, periodY = period) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const w = (i, p) => ((i % p) + p) % p;
  const x0 = w(ix, period), x1 = w(ix + 1, period), y0 = w(iy, periodY), y1 = w(iy + 1, periodY);
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, period, seed, oct = 4, periodY = period) {
  let s = 0, amp = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { s += amp * vnoise(x * f, y * f, period * f, seed + o * 17, periodY * f); n += amp; amp *= 0.5; f *= 2; }
  return s / n;
}

/** Height field (Float32Array, w*h, tileable) -> tangent-space normal map. */
function normalFromHeight(hf, w, h, strength) {
  const at = (x, y) => hf[((y + h) % h) * w + ((x + w) % w)];
  const t = pixelData(w, h, (x, y) => {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  }, false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function pixelData(w, h, fn, srgb = true) {
  return canvasTex(w, h, (ctx) => {
    const img = ctx.createImageData(w, h), d = img.data;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      const c = fn(x, y);
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, { srgb }).tex;
}
const repeat = (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };

// ---- obsidian shell ----------------------------------------------------------------------------
const obsCache = new Map();
/**
 * Volcanic glass with inner heat, 1024² tileable, all maps share one height field:
 * - conchoidal flake facets (Voronoi cells, each a slightly tilted shell with ripple rings) -> sharp light edges;
 * - narrow chopped fracture network pressed deep into the normal map;
 * - roughness 0.08 (fresh flakes) .. 0.38 (matte patches / inside fractures);
 * - emissive: only the very core of some fracture segments smoulders deep red-orange.
 */
export function makeObsidian(pal) {
  const key = `${pal.shell}|${pal.magma}`;
  if (obsCache.has(key)) return obsCache.get(key);
  const S = 1024, rnd = mulberry32(31);

  // 1. chopped fracture polylines (tileable: drawn with ±S offsets), R = glowing core, G = groove
  const cracks = [];
  const walk = (x, y, ang, len, w, depth) => {
    const pts = [[x, y]];
    for (let s = 0; s < len;) {
      const seg = 26 + rnd() * 60;
      ang += (rnd() - 0.5) * 1.15; // hard direction changes: chopped, not wormy
      x += Math.cos(ang) * seg; y += Math.sin(ang) * seg; s += seg;
      pts.push([x, y]);
      if (depth > 0 && rnd() < 0.1) walk(x, y, ang + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.7), len * (0.2 + rnd() * 0.2), w * 0.6, depth - 1);
    }
    cracks.push({ pts, w });
  };
  for (let i = 0; i < 3; i++) walk(rnd() * S, rnd() * S, rnd() * 6.283, 380 + rnd() * 420, 1.1 + rnd() * 0.5, 1);
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#000'; cx.fillRect(0, 0, S, S);
  cx.globalCompositeOperation = 'lighter';
  cx.lineCap = 'round'; cx.lineJoin = 'miter';
  const stroke = (style, lw) => {
    cx.strokeStyle = style;
    for (const c of cracks) for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      cx.beginPath();
      c.pts.forEach(([px, py], i) => (i ? cx.lineTo(px + ox, py + oy) : cx.moveTo(px + ox, py + oy)));
      cx.lineWidth = lw * c.w; cx.stroke();
    }
  };
  stroke('rgb(0,50,0)', 16); stroke('rgb(0,80,0)', 8); stroke('rgb(0,125,0)', 4);
  stroke('rgb(255,0,0)', 2.2);
  const cd = cx.getImageData(0, 0, S, S).data;

  // 2. conchoidal facets
  const N = 42;
  const seeds = Array.from({ length: N }, () => ({
    x: rnd() * S, y: rnd() * S, gx: (rnd() - 0.5) * 0.07, gy: (rnd() - 0.5) * 0.07,
    f: 0.07 + rnd() * 0.06, p: rnd() * 6.28, a: 0.15 + rnd() * 0.25, r: 60 + rnd() * 90,
  }));
  const hf = new Float32Array(S * S), rough = new Float32Array(S * S), core = new Float32Array(S * S), groove = new Float32Array(S * S);
  for (let y = 0, j = 0; y < S; y++) for (let x = 0; x < S; x++, j++) {
    let f1 = 1e9, f2 = 1e9, id = 0, ddx = 0, ddy = 0;
    for (let i = 0; i < N; i++) {
      let dx = x - seeds[i].x, dy = y - seeds[i].y;
      if (dx > S / 2) dx -= S; else if (dx < -S / 2) dx += S;
      if (dy > S / 2) dy -= S; else if (dy < -S / 2) dy += S;
      const d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; id = i; ddx = dx; ddy = dy; } else if (d < f2) f2 = d;
    }
    const s = seeds[id], d = Math.sqrt(f1), edge = Math.sqrt(f2) - d;
    const g = cd[j * 4 + 1] / 255, c = cd[j * 4] / 255;
    core[j] = c; groove[j] = g;
    hf[j] = s.gx * ddx + s.gy * ddy // tilted flake
      - 0.00018 * f1 // shallow conchoidal scoop
      + Math.sin(d * s.f + s.p) * s.a * Math.exp(-d / s.r) // ripple rings
      + (fbm(x / 64, y / 64, 16, 3) - 0.5) * 1.2
      - g * 4 - c * 2; // deep narrow groove
    const matte = sstep(0.55, 0.78, fbm(x / 128, y / 128, 8, 9));
    rough[j] = Math.min(0.38, 0.08 + 0.22 * matte + 0.09 * Math.exp(-edge / 3) + 0.3 * g);
  }
  const base = new THREE.Color(pal.shell);
  const br = base.r * 255, bg = base.g * 255, bb = base.b * 255;
  const map = repeat(pixelData(S, S, (x, y) => {
    const j = y * S + x;
    const band = fbm(x / S * 3, y / S * 22, 3, 21, 3, 22); // faint flow banding of the glass
    const k = (0.62 + 0.42 * band + 0.12 * fbm(x / 32, y / 32, 32, 5)) * (1 - 0.55 * groove[j]);
    const sp = hash2(x, y, 5) > 0.99965 ? 45 : 0;
    return [br * k * 0.8 + sp, bg * k * 0.86 + sp, bb * k + 6 * band + sp];
  }));
  const roughnessMap = repeat(pixelData(S, S, (x, y) => { const r = rough[y * S + x] * 255; return [r, r, r]; }, false));
  const normalMap = normalFromHeight(hf, S, S, 1.0);
  const magma = new THREE.Color(pal.magma);
  const emissiveMap = repeat(pixelData(S, S, (x, y) => {
    const j = y * S + x;
    const e = core[j] * groove[j] * sstep(0.55, 0.72, fbm(x / S * 6, y / S * 6, 6, 77));
    return [255 * e * 0.42, 255 * e * magma.g * 0.12, 255 * e * magma.b * 0.04];
  }));
  const out = { map, normalMap, roughnessMap, emissiveMap };
  obsCache.set(key, out);
  return out;
}

// ---- cross-section (cap) -----------------------------------------------------------------------
/**
 * Fresh cut face: black glassy rim, cooling dark crust, sharp magma crack network (yellow cores, orange glow).
 * Returns { map, emissive, roughness } for a W:H plane.
 */
const capCache = new Map();
export function makeCap(pal, aspect = 1.58) {
  const key = `${pal.shell}|${pal.core}|${aspect.toFixed(3)}`;
  if (capCache.has(key)) return capCache.get(key);
  const Wd = 1024, Ht = Math.round(1024 / aspect), rnd = mulberry32(77);
  const seedsA = Array.from({ length: 22 }, () => [rnd() * Wd, rnd() * Ht]);
  const seedsB = Array.from({ length: 70 }, () => [rnd() * Wd, rnd() * Ht]);
  const rimW = 0.075 * Ht;
  const crust = new Float32Array(Wd * Ht), crack = new Float32Array(Wd * Ht);
  const f12 = (seeds, x, y) => {
    let f1 = 1e9, f2 = 1e9;
    for (const [sx, sy] of seeds) {
      const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return Math.sqrt(f2) - Math.sqrt(f1);
  };
  for (let y = 0; y < Ht; y++) for (let x = 0; x < Wd; x++) {
    const wx = x + (fbm(x / 70, y / 70, 64, 4) - 0.5) * 60, wy = y + (fbm(x / 70 + 9, y / 70, 64, 6) - 0.5) * 60;
    const a = f12(seedsA, wx, wy), b = f12(seedsB, wx + 13, wy - 7);
    const edge = Math.min(x, y, Wd - 1 - x, Ht - 1 - y);
    const inner = sstep(rimW + 4, rimW + 46, edge);
    const centre = 1 - Math.min(1, Math.hypot((x - Wd / 2) / (Wd / 2), (y - Ht / 2) / (Ht / 2)));
    const ca = Math.exp(-(a * a) / 2.2), ga = Math.exp(-a / 10);
    const cb = Math.exp(-(b * b) / 1.1) * 0.55, gb = Math.exp(-b / 5) * 0.35;
    crack[y * Wd + x] = inner * Math.min(1.6, (ca + cb) * (0.75 + 0.5 * centre));
    crust[y * Wd + x] = inner * (ga * 0.6 + gb) * (0.6 + 0.6 * centre);
  }
  const shell = new THREE.Color(pal.shell);
  const isRim = (x, y) => Math.min(x, y, Wd - 1 - x, Ht - 1 - y) < rimW;
  const map = pixelData(Wd, Ht, (x, y) => {
    const i = y * Wd + x, edge = Math.min(x, y, Wd - 1 - x, Ht - 1 - y);
    if (edge < rimW) {
      const hl = Math.exp(-((edge - rimW + 2) ** 2) / 3) * 40; // thin highlight where glass meets crust
      const s = 0.7 + 0.3 * fbm(x / 30, y / 30, 1e6, 2);
      return [shell.r * 255 * s * 0.6 + hl, shell.g * 255 * s * 0.6 + hl, shell.b * 255 * s * 0.7 + hl];
    }
    const n = fbm(x / 22, y / 22, 1e6, 8), c = crack[i], g = crust[i];
    const r = 34 + 26 * n + 120 * g, gg = 22 + 14 * n + 40 * g, b = 22 + 12 * n + 10 * g;
    return [r + 200 * c, gg + 150 * c, b + 60 * c];
  });
  const emissive = pixelData(Wd, Ht, (x, y) => {
    const i = y * Wd + x;
    if (isRim(x, y)) return [0, 0, 0];
    const c = Math.min(1, crack[i]), g = crust[i];
    return [255 * Math.min(1, c * 1.1 + g * 0.85), clamp(236 * c + 95 * g), clamp(150 * c * c + 16 * g)];
  });
  const roughness = pixelData(Wd, Ht, (x, y) => {
    const v = isRim(x, y) ? 30 : 160 + 60 * fbm(x / 18, y / 18, 1e6, 12);
    return [v, v, v];
  }, false);
  const out = { map, emissive, roughness };
  capCache.set(key, out);
  return out;
}

// ---- knife ------------------------------------------------------------------------------------
/** Damascus pattern in blade UV (u: heel->tip, v: edge->spine). The ground bevel (v < grind) is polished bright. */
export function makeDamascus(grind = 0.115) {
  const Wd = 1024, Ht = 256;
  const pat = (x, y) => {
    const u = x / Wd, v = 1 - y / Ht;
    const t = v * 13 + 2.4 * fbm(u * 9, v * 3, 1e6, 41) + 0.7 * Math.sin(u * 26 + v * 6) + 0.25 * Math.sin(u * 71);
    return { u, v, band: Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2), 2.2) };
  };
  const map = pixelData(Wd, Ht, (x, y) => {
    const { u, v, band } = pat(x, y);
    if (v < grind) {
      const brush = 0.9 + 0.1 * fbm(u * 400, v * 8, 1e6, 3), apex = Math.exp(-v / 0.012) * 40;
      return [150 * brush + apex, 154 * brush + apex, 162 * brush + apex];
    }
    const k = 34 + 46 * band, w = sstep(grind, grind + 0.02, v);
    return [k * w + 150 * (1 - w), (k + 2) * w + 154 * (1 - w), (k + 7) * w + 162 * (1 - w)];
  });
  const rough = pixelData(Wd, Ht, (x, y) => {
    const { v, band } = pat(x, y);
    const r = v < grind ? 34 : 70 + 60 * (1 - band);
    return [r, r, r];
  }, false);
  const bump = pixelData(Wd, Ht, (x, y) => { const b = 90 + 80 * pat(x, y).band; return [b, b, b]; }, false);
  return { map, rough, bump };
}

/** Thin glow mask for the cutting bevel: bright at v = 0, gone at v = frac. */
export function makeEdgeMask(frac = 0.11) {
  return canvasTex(4, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 256, 0, 0); // canvas bottom == v 0 (edge)
    g.addColorStop(0, 'rgb(255,255,255)');
    g.addColorStop(frac * 0.35, 'rgb(170,170,170)');
    g.addColorStop(frac, 'rgb(0,0,0)');
    g.addColorStop(1, 'rgb(0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 256);
  }).tex;
}

/** Dark twill carbon weave for the handle. */
export function makeCarbon() {
  const S = 256;
  const map = repeat(pixelData(S, S, (x, y) => {
    const cx = Math.floor(x / 16), cy = Math.floor(y / 16), fx = (x % 16) / 16, fy = (y % 16) / 16;
    const horiz = ((cx + cy) & 3) < 2;
    const s = horiz ? Math.sin(fy * Math.PI) : Math.sin(fx * Math.PI);
    const k = 18 + 30 * s * (horiz ? 1 : 0.75);
    return [k, k + 1, k + 4];
  }));
  return { map };
}

// ---- pile surfaces -----------------------------------------------------------------------------
/** Chunky volcanic gravel: Voronoi-domed stones, per-stone tint/gloss, rare glowing embers. Tileable. */
export function makeGravel(pal) {
  const S = 512, rnd = mulberry32(55), N = 150;
  const seeds = Array.from({ length: N }, () => ({ x: rnd() * S, y: rnd() * S, tint: rnd(), gloss: rnd(), ember: rnd() < 0.035 }));
  const id = new Int32Array(S * S), f1 = new Float32Array(S * S), f2 = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let a = 1e9, b = 1e9, k = 0;
    for (let i = 0; i < N; i++) {
      let dx = Math.abs(x - seeds[i].x), dy = Math.abs(y - seeds[i].y);
      dx = Math.min(dx, S - dx); dy = Math.min(dy, S - dy);
      const d = dx * dx + dy * dy;
      if (d < a) { b = a; a = d; k = i; } else if (d < b) b = d;
    }
    const j = y * S + x; id[j] = k; f1[j] = Math.sqrt(a); f2[j] = Math.sqrt(b);
  }
  const hf = new Float32Array(S * S);
  for (let j = 0; j < S * S; j++) hf[j] = Math.min(8, f2[j] - f1[j]) * 1.0 + (hash2(j % S, (j / S) | 0, 2) - 0.5) * 0.6;
  const crumb = new THREE.Color(pal.crumb);
  const map = repeat(pixelData(S, S, (x, y) => {
    const j = y * S + x, s = seeds[id[j]], gap = sstep(0, 3, f2[j] - f1[j]);
    const k = (0.45 + 0.9 * s.tint) * (0.35 + 0.65 * gap);
    if (s.ember) return [200 * gap + 40, 70 * gap + 20, 20];
    return [crumb.r * 255 * k, crumb.g * 255 * k, crumb.b * 255 * k * 1.1];
  }));
  const roughness = repeat(pixelData(S, S, (x, y) => { const r = 40 + 150 * seeds[id[y * S + x]].gloss; return [r, r, r]; }, false));
  const emissive = repeat(pixelData(S, S, (x, y) => {
    const j = y * S + x, s = seeds[id[j]];
    if (!s.ember) return [0, 0, 0];
    const c = Math.exp(-f1[j] / 9);
    return [255 * c, 120 * c * c, 30 * c * c * c];
  }));
  return { map, roughness, emissive, normalMap: normalFromHeight(hf, S, S, 0.9) };
}

/** Fine volcanic glass dust (tiled, high-frequency): graphite grain, dense micro-glints in colour/roughness/normal. */
export function makeSand() {
  const S = 512;
  const hf = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const g = hash2(x, y, 11);
    hf[y * S + x] = hash2(x, y, 7) * 0.9 + vnoise(x / 2, y / 2, S / 2, 3) * 0.7 + fbm(x / 40, y / 40, 12.8, 4) * 0.9 + (g > 0.975 ? 1.2 : 0);
  }
  const graphite = new THREE.Color('#3e3f48');
  const map = repeat(pixelData(S, S, (x, y) => {
    const g = hash2(x, y, 11), glint = g > 0.975 ? 110 + 120 * hash2(x, y, 17) : 0;
    const k = 0.55 + 0.45 * hash2(x, y, 13) + 0.25 * vnoise(x / 5, y / 5, S / 5, 9);
    return [graphite.r * 255 * k + glint * 0.96, graphite.g * 255 * k + glint * 0.98, graphite.b * 255 * k + glint];
  }));
  // mirror-like glass flakes (glints) scattered through a satin grain field
  const roughness = repeat(pixelData(S, S, (x, y) => {
    const g = hash2(x, y, 11), r = g > 0.975 ? 6 : g > 0.93 ? 50 : 130 + 100 * hash2(x, y, 23);
    return [r, r, r];
  }, false));
  const normalMap = normalFromHeight(hf, S, S, 2.2);
  return { map, roughness, normalMap };
}

export function makeTableTexture(pal, size) {
  const ppu = 228, w = Math.round(size[0] * ppu), h = Math.round(size[1] * ppu);
  const rnd = mulberry32(9);
  return canvasTex(w, h, (ctx) => {
    ctx.fillStyle = pal.table; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 16000; i++) {
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.12)';
      ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 6, 1);
    }
    const cx = w / 2, cy = h / 2;
    const grid = (step, style, lw) => {
      ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.beginPath();
      for (let x = cx % step; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = cy % step; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
    };
    grid(ppu / 100, 'rgba(150,170,210,0.035)', 1); // 1 mm
    grid(ppu / 10, 'rgba(150,170,210,0.09)', 1); // 1 cm
    grid(ppu / 2, 'rgba(170,190,230,0.17)', 1.5); // 5 cm
    // 10 cm crosses
    ctx.strokeStyle = rgba(pal.accent, 0.35); ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = cx % ppu; x < w; x += ppu) for (let y = cy % ppu; y < h; y += ppu) {
      ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
    }
    ctx.stroke();
    // cut-zone corner brackets
    const half = 0.98 * ppu, len = 0.2 * ppu;
    ctx.strokeStyle = rgba(pal.accent, 0.7); ctx.lineWidth = 3;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * half, cy + sy * (half - len)); ctx.lineTo(cx + sx * half, cy + sy * half); ctx.lineTo(cx + sx * (half - len), cy + sy * half);
      ctx.stroke();
    }
  }).tex;
}

export function makeRulerTexture(pal, lengthUnits) {
  const w = 2048, h = 96, ppu = w / lengthUnits; // px per 10 cm
  return canvasTex(w, h, (ctx) => {
    ctx.fillStyle = '#1b1e24'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(0, 0, w, 3);
    const mm = ppu / 100;
    ctx.strokeStyle = 'rgba(210,220,240,0.8)';
    for (let i = 0; i * mm < w; i++) {
      const len = i % 10 === 0 ? 38 : i % 5 === 0 ? 26 : 14;
      ctx.lineWidth = i % 10 === 0 ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(i * mm, 3); ctx.lineTo(i * mm, 3 + len); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(210,220,240,0.85)'; ctx.font = '600 20px monospace'; ctx.textBaseline = 'top';
    for (let cm = 0; cm * mm * 10 < w - 40; cm += 5) ctx.fillText(String(cm), cm * mm * 10 + 4, 48);
    ctx.fillStyle = pal.accent; ctx.fillRect(0, 0, 6, h);
    ctx.fillText('cm', w - 44, 70);
  }).tex;
}

export function makeBackdropTexture(pal) {
  const S = 512, rnd = mulberry32(3);
  return canvasTex(S, S, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#06070a'); g.addColorStop(0.55, '#0d1016'); g.addColorStop(1, '#1a1f28');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    const panels = 14;
    for (let i = 0; i < panels; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.12)';
      ctx.fillRect((i * S) / panels, 0, S / panels, S);
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect((i * S) / panels, 0, 2, S);
      ctx.fillStyle = 'rgba(160,180,230,0.05)'; ctx.fillRect((i * S) / panels + 2, 0, 1, S);
    }
    ctx.fillStyle = 'rgba(170,190,240,0.09)'; ctx.fillRect(0, S * 0.7, S, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(0, S * 0.7 + 2, S, 6);
    const r = ctx.createRadialGradient(S / 2, S * 0.95, 0, S / 2, S * 0.95, S * 0.7);
    r.addColorStop(0, rgba(pal.accent, 0.16)); r.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = r; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 1500; i++) { ctx.fillStyle = 'rgba(255,255,255,0.02)'; ctx.fillRect(rnd() * S, rnd() * S, 1, 1); }
  }).tex;
}

export function makeGlowTexture() {
  return canvasTex(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  }).tex;
}

/** Small round sprite with a hard core (grains, chips) — less "bokeh" than the glow texture. */
export function makeGrainTexture() {
  return canvasTex(32, 32, (ctx) => {
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.15)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 32);
  }).tex;
}

/** Vertical falloff: v=0 (bottom of the strip, blade edge) is hottest. */
export function makeEdgeGradient(power = 2.2) {
  const t = canvasTex(4, 64, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    const stops = 8;
    for (let i = 0; i <= stops; i++) { const v = i / stops; g.addColorStop(v, `rgba(255,255,255,${Math.pow(1 - v, power).toFixed(3)})`); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 64);
  });
  return t.tex;
}
