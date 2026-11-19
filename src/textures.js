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
const polygon = (ctx, pts) => {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
};

/** Faceted obsidian shell: colour map + bump map sharing the same shard layout. */
export function makeObsidian(pal) {
  const S = 1024, rnd = mulberry32(31);
  const shards = [];
  for (let i = 0; i < 95; i++) {
    const cx = rnd() * S, cy = rnd() * S, r = 40 + rnd() * 130, n = 5 + Math.floor(rnd() * 3), rot = rnd() * 6.28;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = rot + (k / n) * 6.283 + (rnd() - 0.5) * 0.5, rr = r * (0.6 + rnd() * 0.5);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    shards.push({ pts, h: rnd(), l: rnd() });
  }
  const arcs = Array.from({ length: 34 }, () => [rnd() * S, rnd() * S, 30 + rnd() * 160, rnd() * 6.28, 0.6 + rnd() * 1.4]);
  const base = canvasTex(S, S, (ctx) => {
    ctx.fillStyle = pal.shell; ctx.fillRect(0, 0, S, S);
    const g = ctx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, 'rgba(255,255,255,0.06)'); g.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    for (const s of shards) {
      polygon(ctx, s.pts);
      ctx.fillStyle = s.l > 0.5 ? `rgba(140,160,255,${0.015 + s.l * 0.05})` : `rgba(0,0,0,${0.1 + s.h * 0.2})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(170,185,255,0.08)'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(150,165,230,0.06)'; ctx.lineWidth = 1.5;
    for (const [x, y, r, a, len] of arcs) { ctx.beginPath(); ctx.arc(x, y, r, a, a + len); ctx.stroke(); }
    for (let i = 0; i < 140; i++) {
      ctx.fillStyle = rgba(pal.core, 0.08 + rnd() * 0.25);
      ctx.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
    }
  });
  const bump = canvasTex(S, S, (ctx) => {
    ctx.fillStyle = '#777'; ctx.fillRect(0, 0, S, S);
    for (const s of shards) {
      polygon(ctx, s.pts);
      const v = (90 + s.h * 110) | 0;
      ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2;
    for (const [x, y, r, a, len] of arcs) { ctx.beginPath(); ctx.arc(x, y, r, a, a + len); ctx.stroke(); }
  }, { srgb: false });
  return { map: base.tex, bump: bump.tex, baseCanvas: base.canvas };
}

/** Copy of the shell texture that accumulates kerf lines. */
export function makeLined(baseCanvas) {
  const t = canvasTex(baseCanvas.width, baseCanvas.height, (ctx) => ctx.drawImage(baseCanvas, 0, 0));
  t.base = baseCanvas;
  return t;
}
export function resetLined(t) { t.ctx.drawImage(t.base, 0, 0); t.tex.needsUpdate = true; }
/** pos: 0..1 along the canvas axis; vertical lines vary x, horizontal lines vary y. */
export function scoreLine(t, pos, vertical, accent, n = 10) {
  const S = t.canvas.width, p = pos * S, ctx = t.ctx;
  const k = Math.min(5, Math.max(1.4, (S / Math.max(1, n)) * 0.45)); // line width follows cut density
  const draw = (w, style) => { ctx.fillStyle = style; if (vertical) ctx.fillRect(p - w / 2, 0, w, S); else ctx.fillRect(0, p - w / 2, S, w); };
  draw(k * 3.2, rgba(accent, 0.28));
  draw(k * 1.6, rgba(accent, 0.95));
  draw(Math.max(1, k * 0.6), 'rgba(255,255,255,0.9)');
  t.tex.needsUpdate = true;
}

/** Cross-section texture: shell ring, inner rock, heated band and a white-hot core (separate emissive map). */
export function makeCap(pal) {
  const S = 512, rnd = mulberry32(77);
  const veins = [];
  for (let i = 0; i < 16; i++) {
    const pts = []; let a = rnd() * 6.283, r = 10;
    while (r < S * 0.5) { pts.push([S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r]); a += (rnd() - 0.5) * 0.7; r += 14 + rnd() * 22; }
    veins.push(pts);
  }
  const drawVeins = (ctx, style, w) => {
    ctx.strokeStyle = style; ctx.lineWidth = w;
    for (const v of veins) { ctx.beginPath(); v.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
  };
  const map = canvasTex(S, S, (ctx) => {
    ctx.fillStyle = pal.inner; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 4500; i++) {
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,220,200,0.07)';
      ctx.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.55);
    g.addColorStop(0, rgba(pal.core, 0.95)); g.addColorStop(0.25, rgba(pal.core, 0.55));
    g.addColorStop(0.55, 'rgba(110,30,12,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    drawVeins(ctx, rgba(pal.core, 0.4), 2);
    ctx.strokeStyle = pal.shell; ctx.lineWidth = S * 0.13; ctx.strokeRect(0, 0, S, S);
    ctx.strokeStyle = 'rgba(190,200,255,0.18)'; ctx.lineWidth = 2; ctx.strokeRect(S * 0.065, S * 0.065, S * 0.87, S * 0.87);
  });
  const emissive = canvasTex(S, S, (ctx) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.45);
    g.addColorStop(0, '#fff3d0'); g.addColorStop(0.12, '#ffc060'); g.addColorStop(0.3, pal.core);
    g.addColorStop(0.62, rgba(pal.core, 0.22)); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    drawVeins(ctx, rgba(pal.accent, 0.5), 2.5);
  });
  emissive.tex.center.set(0.5, 0.5);
  return { map: map.tex, emissive: emissive.tex };
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

/** Opaque grayscale gradient for the blade emissiveMap: v=0 (edge) white -> v=1 (spine) black. */
export function makeBladeGradient() { // bright only on the lowest ~14% of the blade (edge), black above
  return canvasTex(4, 64, (ctx) => {
    const g = ctx.createLinearGradient(0, 64, 0, 0); // canvas bottom == v 0 (edge)
    g.addColorStop(0, 'rgb(255,255,255)');
    g.addColorStop(0.07, 'rgb(150,150,150)');
    g.addColorStop(0.14, 'rgb(0,0,0)');
    g.addColorStop(1, 'rgb(0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 64);
  }).tex;
}
