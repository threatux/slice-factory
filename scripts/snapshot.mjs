import { createServer } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Debug helper: deterministic stills at given times (no video/audio).
// Usage: node scripts/snapshot.mjs --times=0.2,1.5,6 --out=output/snap [--max-rounds=2] [--profile=draft] [--recipe=...]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)];
}));
const profile = JSON.parse(fs.readFileSync(path.join(root, 'config', 'render-profiles.json'), 'utf8'))[args.profile ?? 'draft'];
const recipe = JSON.parse(fs.readFileSync(path.resolve(root, args.recipe ?? 'config/recipes/obsidian-lava.json'), 'utf8'));
const outDir = path.resolve(root, args.out ?? 'output/snap');
const times = (args.times ?? '0.2').split(',').map(Number).sort((a, b) => a - b);
const maxRounds = args['max-rounds'] ? Number(args['max-rounds']) : undefined;
fs.mkdirSync(outDir, { recursive: true });

let server, browser;
try {
  server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1' } });
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
  const page = await browser.newPage({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text()); });
  await page.goto(server.resolvedUrls.local[0]);
  console.log('[gpu] WebGL renderer:', await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl'); if (!g) return 'no WebGL'; const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); }));
  await page.waitForFunction(() => !!window.__RENDER_API__);
  const info = await page.evaluate(([p, r, o]) => window.__RENDER_API__.init(p, r, o), [profile, recipe, { maxRounds }]);
  console.log(`duration ${info.duration.toFixed(2)}s, knife raise ${info.knifeRaise.toFixed(2)}`);
  const dt = 1 / profile.fps;
  let frame = 0;
  for (const t of times) {
    const target = Math.round(t * profile.fps);
    for (let left = target - frame; left > 0; left -= 8) await page.evaluate(([n, d]) => { for (let i = 0; i < n; i++) window.__RENDER_API__.step(d); }, [Math.min(8, left), dt]);
    frame = Math.max(frame, target);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    await page.screenshot({ path: path.join(outDir, `t${t.toFixed(2)}.png`), timeout: 300000 });
    console.log(`  t=${t}`, args.probe ? JSON.stringify(await page.evaluate(() => window.__RENDER_API__.probe?.())) : '');
  }
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}
