export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

export function formatPieces(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  return Math.max(1, Math.round(n)).toLocaleString('en-US');
}
export function formatSize(m) {
  if (m >= 0.01) return (m * 100).toFixed(1) + ' cm';
  if (m >= 0.001) return (m * 1000).toFixed(1) + ' mm';
  return Math.round(m * 1e6) + ' µm';
}
