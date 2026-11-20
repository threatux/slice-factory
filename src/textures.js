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
export function makeObsidian(pal, opts = {}) {
  // opts (all optional, defaults = v1 look): roughMax (roughness ceiling), lift [r,g,b] (0..255 albedo floor so near-black glass still shows facets)
  const roughMax = opts.roughMax ?? 0.38, lift = opts.lift ?? [0, 0, 0], smoulder = opts.smoulder ?? null; // smoulder: [r,g,b] 0..255 colour of the glowing fracture cores
  const key = `${pal.shell}|${pal.magma}` + (opts.roughMax || opts.lift || opts.smoulder ? `|${roughMax}|${lift.join(',')}|${smoulder}` : '');
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
    rough[j] = Math.min(roughMax, 0.08 + 0.22 * matte + 0.09 * Math.exp(-edge / 3) + 0.3 * g);
  }
  const base = new THREE.Color(pal.shell);
  const br = base.r * 255 + lift[0], bg = base.g * 255 + lift[1], bb = base.b * 255 + lift[2];
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
    if (smoulder) return [smoulder[0] * e, smoulder[1] * e, smoulder[2] * e];
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

// ======================================================================================================
// 24K gold / emerald look (recipe.object.material = "gold-emerald"). Obsidian code paths above are untouched.
// ======================================================================================================

/** Separable box blur on a Float32 field (clamped edges). */
function boxBlur(a, w, h, r) {
  if (r < 1) return a;
  const k = 2 * r + 1, tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += a[y * w + Math.min(w - 1, Math.max(0, x + i))];
    tmp[y * w + x] = s / k;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    out[y * w + x] = s / k;
  }
  return out;
}
/** Paints white-on-black with the 2D API and returns the red channel as a 0..1 field. */
function paintLayer(w, h, paint) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  paint(c);
  const d = c.getImageData(0, 0, w, h).data, o = new Float32Array(w * h);
  for (let j = 0; j < o.length; j++) o[j] = d[j * 4] / 255;
  return o;
}
const srgbBytes = (c) => { const h = new THREE.Color(c).getHex(); return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; };

// ---- cast gold shell ----------------------------------------------------------------------------
const goldCache = new Map();
/**
 * Cast 24K gold skin (1024² tileable): micro-sanded brushing + faint casting waves + hairline scratches.
 * roughnessMap 0.14..0.28, fine metal normal map; same keys as makeObsidian (map, normalMap, roughnessMap).
 */
export function makeGoldCast(pal) {
  const key = `gold|${pal.shell}`;
  if (goldCache.has(key)) return goldCache.get(key);
  const S = 1024, rnd = mulberry32(61);
  const scr = paintLayer(S, S, (c) => {
    c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
    for (let i = 0; i < 90; i++) {
      const x = rnd() * S, y = rnd() * S, a = (rnd() < 0.7 ? 0 : 1.57) + (rnd() - 0.5) * 0.5, len = 30 + rnd() * 220;
      c.strokeStyle = `rgba(255,255,255,${(0.2 + rnd() * 0.6).toFixed(2)})`; c.lineWidth = 0.6 + rnd() * 0.9;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        c.beginPath(); c.moveTo(x + ox, y + oy); c.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len); c.stroke();
      }
    }
  });
  const hf = new Float32Array(S * S), rough = new Float32Array(S * S), tone = new Float32Array(S * S);
  for (let y = 0, j = 0; y < S; y++) for (let x = 0; x < S; x++, j++) {
    const wave = fbm(x / 128, y / 128, 8, 3, 3) - 0.5;
    const brush = vnoise(x / 64, y / 2, 16, 5, 512) - 0.5;
    const blot = sstep(0.4, 0.75, fbm(x / 128, y / 128, 8, 9, 3));
    hf[j] = wave * 3.0 + brush * 0.9 + (hash2(x, y, 7) - 0.5) * 0.3 - scr[j] * 1.6;
    rough[j] = Math.min(0.28, Math.max(0.14, 0.14 + 0.09 * blot + 0.035 * (brush + 0.5) + 0.05 * scr[j]));
    tone[j] = 0.9 + 0.2 * fbm(x / 64, y / 64, 16, 11, 3);
  }
  const [R, G, B] = srgbBytes(pal.shell);
  const map = repeat(pixelData(S, S, (x, y) => {
    const j = y * S + x, k = tone[j], s = scr[j];
    return [R * k + 34 * s, G * k + 28 * s, B * k + 14 * s];
  }));
  const roughnessMap = repeat(pixelData(S, S, (x, y) => { const r = rough[y * S + x] * 255; return [r, r, r]; }, false));
  const out = { map, normalMap: normalFromHeight(hf, S, S, 0.8), roughnessMap };
  goldCache.set(key, out);
  return out;
}

// ---- engraving + surface hints of the core ----------------------------------------------------------
/**
 * Object-space decals for the gold block: top face (u = x, v = -z) carries the stamp (frame + 999.9 / FINE GOLD / 1000g)
 * and one hairline crack; the +x face (u = -z, v = y) carries one more crack. Each face: tangent normal map + RGB mask
 * (R = engraving ink, G = crack groove, B = emerald glow inside the crack). No decals on the front face.
 */
export function makeIngotDecals([W, H, D], { engrave: withStamp = true } = {}) {
  const rnd = mulberry32(2024);
  const TW = 1024, TH = Math.round((1024 * D) / W), SW = 1024, SH = Math.round((1024 * H) / D);
  const crack = (x0, y0, x1, y1, jit) => { // chopped, hard-angled polyline
    const pts = [[x0, y0]], dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
    for (let s = 0; s < L;) {
      s += 12 + rnd() * 24;
      const u = Math.min(1, s / L), off = (rnd() - 0.5) * 2 * jit * (1 - 0.5 * u);
      pts.push([x0 + dx * u + nx * off, y0 + dy * u + ny * off]);
    }
    return pts;
  };
  const strokePts = (c, pts, lw) => {
    c.strokeStyle = '#fff'; c.lineWidth = lw; c.lineJoin = 'miter'; c.lineCap = 'butt';
    c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke();
  };
  const engrave = (c, w, h) => {
    c.fillStyle = c.strokeStyle = '#fff'; c.lineJoin = 'round';
    const m = 0.095 * w, m2 = m + 0.032 * w;
    c.lineWidth = 0.014 * w; c.strokeRect(m, m, w - 2 * m, h - 2 * m);
    c.lineWidth = 0.005 * w; c.strokeRect(m2, m2, w - 2 * m2, h - 2 * m2);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const fit = (txt, maxW, maxPx, yy) => {
      const setFont = (px) => {
        c.font = `900 ${px}px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;
        if ('letterSpacing' in c) c.letterSpacing = `${(px * 0.05).toFixed(2)}px`;
      };
      setFont(100);
      const px = Math.min(maxPx, (100 * maxW) / c.measureText(txt).width);
      setFont(px);
      c.fillText(txt, w / 2 + px * 0.025, yy);
    };
    fit('999.9', 0.64 * w, 0.27 * w, 0.335 * h);
    c.fillRect(0.24 * w, 0.452 * h, 0.52 * w, 0.006 * w);
    fit('FINE GOLD', 0.66 * w, 0.115 * w, 0.545 * h);
    fit('1000g', 0.42 * w, 0.115 * w, 0.7 * h);
  };
  const face = (w, h, paintInk, cracks) => {
    const ink = paintLayer(w, h, paintInk);
    const groove = paintLayer(w, h, (c) => cracks.forEach((p) => strokePts(c, p.pts, p.lw)));
    const core = paintLayer(w, h, (c) => cracks.forEach((p) => strokePts(c, p.pts, p.lw * 0.5)));
    const coreBlur = boxBlur(core, w, h, 1), halo = boxBlur(core, w, h, 3);
    const hf = new Float32Array(w * h), inkB = boxBlur(ink, w, h, 1), grvB = boxBlur(groove, w, h, 1);
    for (let j = 0; j < hf.length; j++) hf[j] = inkB[j] + 1.4 * grvB[j];
    const normal = normalFromHeight(hf, w, h, 3.0);
    normal.wrapS = normal.wrapT = THREE.ClampToEdgeWrapping;
    const mask = pixelData(w, h, (x, y) => {
      const j = y * w + x;
      return [inkB[j] * 255, grvB[j] * 255, Math.min(1, coreBlur[j] * 1.6 + halo[j] * 2.2) * 255];
    }, false);
    return { normal, mask };
  };
  // top face: cracks live in the margin between the bevel and the stamp frame (not over the lettering)
  const A = crack(0.97 * TW, 0.68 * TH, 0.93 * TW, 0.87 * TH, 6);
  const Ab = crack(A[2][0], A[2][1], A[2][0] - 0.022 * TW, A[2][1] + 0.025 * TH, 3);
  const C = crack(0.3 * SW, 0, 0.36 * SW, 0.3 * SH, 7);
  const Cb = crack(C[2][0], C[2][1], C[2][0] + 0.06 * SW, C[2][1] + 0.1 * SH, 4);
  return {
    top: face(TW, TH, withStamp ? (c) => engrave(c, TW, TH) : () => {}, [{ pts: A, lw: 3.4 }, { pts: Ab, lw: 2.4 }]),
    side: face(SW, SH, () => {}, [{ pts: C, lw: 3.4 }, { pts: Cb, lw: 2.4 }]),
  };
}

// ---- crystalline emerald cross-section ---------------------------------------------------------------
const emeraldCache = new Map();
/**
 * Faceted emerald section: thin brushed-gold rim, then a Voronoi crystal (large flat facets + a faint fine layer),
 * deep green #007a44 -> #00e676 by facet tilt, bright mint #b9ffdf refraction facets and edge lines.
 * Returns { map, emissive, roughness, metal } (metal: B channel, gold rim only).
 */
export function makeEmeraldCap(pal, aspect = 1.58, scheme = {}) {
  const sc = { name: 'emerald', dark: [0, 122, 68], bright: [0, 230, 118], mint: [185, 255, 223], rim: true, seed: 88, ...scheme };
  const key = `${sc.name}|${pal.core}|${pal.shell}|${aspect.toFixed(3)}`;
  if (emeraldCache.has(key)) return emeraldCache.get(key);
  const Wd = 1024, Ht = Math.round(1024 / aspect), rnd = mulberry32(sc.seed);
  const mk = (nx, ny, jit) => {
    const a = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      a.push({ x: (i + 0.5 + (rnd() - 0.5) * jit) * (Wd / nx), y: (j + 0.5 + (rnd() - 0.5) * jit) * (Ht / ny), tx: rnd() * 2 - 1, ty: rnd() * 2 - 1, g: rnd(), k: rnd() });
    }
    return a;
  };
  const big = mk(8, 5, 1.15), fine = mk(12, 8, 1.0);
  const near2 = (seeds, x, y) => {
    let a = 1e9, b = 1e9, s = seeds[0];
    for (const p of seeds) {
      const d = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y);
      if (d < a) { b = a; a = d; s = p; } else if (d < b) b = d;
    }
    return { s, edge: Math.sqrt(b) - Math.sqrt(a) };
  };
  const { dark, bright, mint } = sc, gold = srgbBytes(pal.shell);
  const rimW = sc.rim ? 0.055 * Ht : 0;
  const N = Wd * Ht, hf = new Float32Array(Wd * Ht), col = new Float32Array(N * 3), emi = new Float32Array(N * 3), rgh = new Float32Array(N), met = new Float32Array(N);
  for (let y = 0, j = 0; y < Ht; y++) for (let x = 0; x < Wd; x++, j++) {
    const e = Math.min(x, y, Wd - 1 - x, Ht - 1 - y);
    if (e < rimW) { // brushed gold lip: bright outer bevel -> darker inner step
      const t = e / rimW, brush = 0.9 + 0.1 * fbm(x / 30, y / 3, 1e6, 4);
      const k = (t < 0.3 ? 1.18 : 1.0 - 0.32 * sstep(0.5, 1, t)) * brush;
      col[j * 3] = gold[0] * k; col[j * 3 + 1] = gold[1] * k; col[j * 3 + 2] = gold[2] * k;
      rgh[j] = 56; met[j] = 255;
      continue;
    }
    const B = near2(big, x, y), F = near2(fine, x, y), b = B.s;
    let s = 0.5 + 0.5 * (b.tx * -0.55 + b.ty * -0.45) + 0.35 * (((x - b.x) * b.tx + (y - b.y) * b.ty) / 180) + (F.s.g - 0.5) * 0.22;
    s = Math.min(1, Math.max(0, s));
    const sp = Math.pow(s, 1.35);
    hf[j] = ((x - b.x) * b.tx + (y - b.y) * b.ty) * 0.05; // flat tilted facet planes -> piecewise-constant normals
    let r = dark[0] + (bright[0] - dark[0]) * sp, g = dark[1] + (bright[1] - dark[1]) * sp, bl = dark[2] + (bright[2] - dark[2]) * sp;
    const hi = sstep(0.8, 1.0, s) * (b.k > 0.45 ? 1 : 0.4) * 0.7;
    r += (mint[0] - r) * hi; g += (mint[1] - g) * hi; bl += (mint[2] - bl) * hi;
    const line = Math.exp(-(B.edge * B.edge) / (2 * 1.3 * 1.3)) * (b.k < 0.7 ? 0.95 : 0.55);
    const fl = Math.exp(-(F.edge * F.edge) / (2 * 0.9 * 0.9)) * 0.22;
    const seam = Math.exp(-((B.edge - 5) ** 2) / 6) * 0.38;
    const m = Math.min(1, line + fl);
    r = (r + (mint[0] - r) * m) * (1 - seam); g = (g + (mint[1] - g) * m) * (1 - seam); bl = (bl + (mint[2] - bl) * m) * (1 - seam);
    const lip = rimW > 0 && e < rimW + 5 ? 0.4 + 0.6 * ((e - rimW) / 5) : 1; // thin shadow seam under the gold rim
    const ex = 0.8 * lip; // albedo pre-compensated for the lab key light (keeps the emerald saturated instead of pastel)
    col[j * 3] = r * ex; col[j * 3 + 1] = g * ex; col[j * 3 + 2] = bl * ex;
    const se = 0.25 + 0.75 * Math.pow(s, 1.4);
    emi[j * 3] = bright[0] * se * 0.65 + mint[0] * m * 0.4; emi[j * 3 + 1] = bright[1] * se * 0.65 + mint[1] * m * 0.5; emi[j * 3 + 2] = bright[2] * se * 0.65 + mint[2] * m * 0.45;
    rgh[j] = m > 0.4 ? 9 : 22 + 30 * b.g;
    met[j] = 0;
  }
  const idx = (x, y) => y * Wd + x;
  const out = {
    map: pixelData(Wd, Ht, (x, y) => { const j = idx(x, y) * 3; return [col[j], col[j + 1], col[j + 2]]; }),
    emissive: pixelData(Wd, Ht, (x, y) => { const j = idx(x, y) * 3; return [emi[j], emi[j + 1], emi[j + 2]]; }),
    roughness: pixelData(Wd, Ht, (x, y) => { const v = rgh[idx(x, y)]; return [v, v, v]; }, false),
    metal: pixelData(Wd, Ht, (x, y) => { const v = met[idx(x, y)]; return [v, v, v]; }, false),
    normal: normalFromHeight(hf, Wd, Ht, 10),
  };
  out.normal.wrapS = out.normal.wrapT = THREE.ClampToEdgeWrapping;
  emeraldCache.set(key, out);
  return out;
}

/** Faceted ruby (anomaly cube): same Voronoi crystal as the emerald section in a deep ruby palette, no gold rim. */
export function makeRubyCap(pal, aspect = 1.58) {
  return makeEmeraldCap(pal, aspect, { name: 'ruby', dark: [110, 0, 22], bright: [213, 0, 50], mint: [255, 138, 163], rim: false, seed: 131 });
}

// ---- gold / emerald piles --------------------------------------------------------------------------
/** R4: coarse gold shavings/nuggets (faceted Voronoi chips) with bright emerald shards. Tileable. Returns { map, roughness, emissive, normalMap, metal }. */
export function makeGoldGravel(pal) {
  const S = 512, rnd = mulberry32(56), N = 150;
  const seeds = Array.from({ length: N }, () => ({ x: rnd() * S, y: rnd() * S, tint: rnd(), gloss: rnd(), emerald: rnd() < 0.22, gx: (rnd() - 0.5) * 0.9, gy: (rnd() - 0.5) * 0.9 }));
  const id = new Int32Array(S * S), f1 = new Float32Array(S * S), f2 = new Float32Array(S * S), sh = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let a = 1e9, b = 1e9, k = 0, ex = 0, ey = 0;
    for (let i = 0; i < N; i++) {
      let dx = x - seeds[i].x, dy = y - seeds[i].y;
      if (dx > S / 2) dx -= S; else if (dx < -S / 2) dx += S;
      if (dy > S / 2) dy -= S; else if (dy < -S / 2) dy += S;
      const d = dx * dx + dy * dy;
      if (d < a) { b = a; a = d; k = i; ex = dx; ey = dy; } else if (d < b) b = d;
    }
    const j = y * S + x;
    id[j] = k; f1[j] = Math.sqrt(a); f2[j] = Math.sqrt(b);
    sh[j] = seeds[k].gx * ex + seeds[k].gy * ey; // facet tilt
  }
  const hf = new Float32Array(S * S);
  for (let j = 0; j < S * S; j++) hf[j] = Math.min(8, f2[j] - f1[j]) + sh[j] * 0.12 + (hash2(j % S, (j / S) | 0, 2) - 0.5) * 0.5;
  const [R, G, B] = srgbBytes(pal.shell);
  const map = repeat(pixelData(S, S, (x, y) => {
    const j = y * S + x, s = seeds[id[j]], gap = sstep(0, 3, f2[j] - f1[j]);
    const lit = 0.5 + 0.5 * Math.max(-1, Math.min(1, sh[j] / 18));
    if (s.emerald) {
      const t = (0.35 + 0.65 * lit) * (0.45 + 0.55 * gap), hi = sstep(0.8, 1, lit * s.gloss + 0.25) * 0.6;
      return [185 * hi, (122 + 108 * t) + 60 * hi, (68 + 50 * t) + 100 * hi];
    }
    const k = (0.5 + 0.8 * s.tint) * (0.3 + 0.7 * gap) * (0.75 + 0.5 * lit);
    return [R * k, G * k, B * k];
  }));
  const roughness = repeat(pixelData(S, S, (x, y) => { const s = seeds[id[y * S + x]], r = s.emerald ? 14 + 30 * s.gloss : 40 + 90 * s.gloss; return [r, r, r]; }, false));
  const emissive = repeat(pixelData(S, S, (x, y) => {
    const j = y * S + x, s = seeds[id[j]];
    if (!s.emerald) return [0, 0, 0];
    const c = 0.35 + 0.65 * Math.exp(-f1[j] / 16);
    return [30 * c, 205 * c, 105 * c];
  }));
  const metal = repeat(pixelData(S, S, (x, y) => { const v = seeds[id[y * S + x]].emerald ? 0 : 255; return [v, v, v]; }, false));
  return { map, roughness, emissive, metal, normalMap: normalFromHeight(hf, S, S, 0.9) };
}

/** R5: silky gold micro-dust (tiled, high-frequency): dense metal micro-glints, rare emerald crumbs. */
export function makeGoldDust(pal) {
  const S = 512, hf = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const g = hash2(x, y, 11);
    hf[y * S + x] = hash2(x, y, 7) * 0.9 + vnoise(x / 2, y / 2, S / 2, 3) * 0.7 + fbm(x / 40, y / 40, 12.8, 4) * 0.9 + (g > 0.96 ? 1.4 : 0);
  }
  const [R, G, B] = srgbBytes(pal.shell);
  const map = repeat(pixelData(S, S, (x, y) => {
    const g = hash2(x, y, 11), k = 0.5 + 0.5 * hash2(x, y, 13) + 0.25 * vnoise(x / 5, y / 5, S / 5, 9);
    if (hash2(x, y, 19) > 0.977) return [10, 170 + 60 * hash2(x, y, 21), 95];
    const glint = g > 0.96 ? 90 + 130 * hash2(x, y, 17) : 0;
    return [R * k * 0.95 + glint, G * k * 0.95 + glint * 0.94, B * k + glint * 0.7];
  }));
  const roughness = repeat(pixelData(S, S, (x, y) => {
    const g = hash2(x, y, 11), r = g > 0.96 ? 6 : g > 0.9 ? 40 : 90 + 90 * hash2(x, y, 23);
    return [r, r, r];
  }, false));
  return { map, roughness, normalMap: normalFromHeight(hf, S, S, 2.4) };
}


// ======================================================================================================
// Volcanic obsidian / molten magma look (recipe.object.surfaceStyle = "obsidian"). Gold paths above are untouched.
// ======================================================================================================
/** Volcanic glass shell (shared by the ingot and its shards): roughness 0.08-0.32, lifted near-black albedo, smouldering fracture cores. */
export function makeVolcanicObsidian(pal) {
  const h = new THREE.Color(pal.crackGlow ?? '#ff3b00').getHex();
  return makeObsidian(pal, { roughMax: 0.32, lift: pal.glassLift ?? [14, 15, 20], smoulder: [(h >> 16) & 255, (h >> 8) & 255, h & 255] });
}

const magmaCache = new Map();
/**
 * Molten-magma cut face: deep black basalt crust with a network of glowing veins. Emissive ramp (per pal.magmaVeins,
 * default #d91e00 -> #ff7b00 -> #fff1b8): white only on the thinnest vein cores, so the face glows without burning out to a flat white patch.
 * Returns { map, emissive, roughness } (same keys as makeCap / makeEmeraldCap).
 */
export function makeMagmaCap(pal, aspect = 1.58) {
  const veins = pal.magmaVeins ?? ['#d91e00', '#ff7b00', '#fff1b8'];
  const key = `magma|${veins.join('')}|${pal.shell}|${aspect.toFixed(3)}`;
  if (magmaCache.has(key)) return magmaCache.get(key);
  const [v0, v1, v2] = veins.map(srgbBytes), shell = srgbBytes(pal.shell);
  const Wd = 1024, Ht = Math.round(1024 / aspect), rnd = mulberry32(177);
  const seedsA = Array.from({ length: 26 }, () => [rnd() * Wd, rnd() * Ht]);
  const seedsB = Array.from({ length: 90 }, () => [rnd() * Wd, rnd() * Ht]);
  const rimW = 0.06 * Ht;
  const f12 = (seeds, x, y) => {
    let f1 = 1e9, f2 = 1e9;
    for (const [sx, sy] of seeds) {
      const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return Math.sqrt(f2) - Math.sqrt(f1);
  };
  const heat = new Float32Array(Wd * Ht), crustG = new Float32Array(Wd * Ht);
  for (let y = 0; y < Ht; y++) for (let x = 0; x < Wd; x++) {
    const wx = x + (fbm(x / 70, y / 70, 64, 4) - 0.5) * 70, wy = y + (fbm(x / 70 + 9, y / 70, 64, 6) - 0.5) * 70;
    const a = f12(seedsA, wx, wy), b = f12(seedsB, wx + 13, wy - 7);
    const edge = Math.min(x, y, Wd - 1 - x, Ht - 1 - y);
    const inner = sstep(rimW + 3, rimW + 30, edge);
    const centre = 1 - Math.min(1, Math.hypot((x - Wd / 2) / (Wd / 2), (y - Ht / 2) / (Ht / 2)));
    const ca = Math.exp(-(a * a) / 1.5), ga = Math.exp(-a / 7);
    const cb = Math.exp(-(b * b) / 0.75) * 0.6, gb = Math.exp(-b / 4) * 0.3;
    const pulse = 0.55 + 0.45 * fbm(x / 60, y / 60, 1e6, 31); // some veins burn hotter than others
    const c = (ca + cb) * (0.7 + 0.5 * centre) * (0.65 + 0.55 * pulse);
    const g = (ga * 0.55 + gb) * (0.6 + 0.6 * centre);
    heat[y * Wd + x] = inner * (c * 0.85 + g * 0.26);
    crustG[y * Wd + x] = inner * g;
  }
  const ramp = (e) => { // e: 0..~1.2 -> emissive rgb (0..255)
    const lerp3 = (A, B, u) => [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, A[2] + (B[2] - A[2]) * u];
    if (e < 0.6) return lerp3([0, 0, 0], v0, sstep(0.3, 0.6, e)); // no dim glow between the veins: black glass stays black
    if (e < 0.9) return lerp3(v0, v1, sstep(0.6, 0.9, e));
    return lerp3(v1, v2, sstep(0.95, 1.2, e));
  };
  const isRim = (x, y) => Math.min(x, y, Wd - 1 - x, Ht - 1 - y) < rimW;
  const map = pixelData(Wd, Ht, (x, y) => {
    const i = y * Wd + x;
    if (isRim(x, y)) { const s = 0.7 + 0.3 * fbm(x / 30, y / 30, 1e6, 2); return [shell[0] * s + 14, shell[1] * s + 15, shell[2] * s + 20]; }
    const n = fbm(x / 20, y / 20, 1e6, 8), g = crustG[i], e = Math.min(1.2, heat[i]);
    return [9 + 7 * n + 12 * g + 22 * e, 9 + 5 * n + 4 * g + 6 * e, 12 + 5 * n + 2 * g]; // near-black volcanic glass crust (~#09090c), faintly scorched at the veins
  });
  const emissive = pixelData(Wd, Ht, (x, y) => (isRim(x, y) ? [0, 0, 0] : ramp(Math.min(1.2, heat[y * Wd + x]))));
  const roughness = pixelData(Wd, Ht, (x, y) => { const v = isRim(x, y) ? 26 : 150 + 70 * fbm(x / 16, y / 16, 1e6, 12); return [v, v, v]; }, false);
  const out = { map, emissive, roughness };
  magmaCache.set(key, out);
  return out;
}
