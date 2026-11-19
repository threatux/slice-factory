import { createServer } from 'vite';
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node scripts/render.mjs --recipe=config/recipes/obsidian-lava.json --profile=draft --out=output/obsidian-draft.mp4 [--max-rounds=2]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)];
  }),
);
const profileName = args.profile ?? 'draft';
const recipePath = path.resolve(root, args.recipe ?? 'config/recipes/obsidian-lava.json');
const out = path.resolve(root, args.out ?? 'output/obsidian-draft.mp4');
const maxRounds = args['max-rounds'] ? Number(args['max-rounds']) : undefined;
if (maxRounds !== undefined && !(maxRounds >= 1)) throw new Error('--max-rounds must be an integer >= 1');

const profiles = JSON.parse(fs.readFileSync(path.join(root, 'config', 'render-profiles.json'), 'utf8'));
const profile = profiles[profileName];
if (!profile) throw new Error(`Unknown profile "${profileName}". Available: ${Object.keys(profiles).join(', ')}`);
const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));

fs.mkdirSync(path.dirname(out), { recursive: true });
const base = out.replace(/\.[^./\\]+$/, '');
const eventsPath = base + '.events.json';
const wavPath = base + '.wav';
const videoPath = base + '.video.mp4'; // silent intermediate

let server, browser, ffmpeg;
try {
  server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1' } });
  await server.listen();
  const url = server.resolvedUrls.local[0];

  browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page console]', m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => !!window.__RENDER_API__);
  const info = await page.evaluate(([p, r, o]) => window.__RENDER_API__.init(p, r, o), [profile, recipe, { maxRounds }]);
  console.log(`Recipe ${recipe.id} / profile ${profileName}: ${info.width}x${info.height}@${info.fps}, ${info.rounds} rounds, ~${info.duration.toFixed(2)}s, knife raise ${info.knifeRaise.toFixed(2)}`);

  ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(profile.fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18',
    '-movflags', '+faststart', videoPath,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffmpegClosed = once(ffmpeg, 'close');
  ffmpeg.on('error', (e) => { console.error('ffmpeg spawn error:', e.message); });
  ffmpeg.stdin.on('error', () => {}); // surfaced via exit code

  const dt = 1 / profile.fps;
  const total = Math.round(info.duration * profile.fps);
  let frames = 0;
  while (!(await page.evaluate(() => window.__RENDER_API__.isDone()))) {
    await page.evaluate((d) => window.__RENDER_API__.step(d), dt);
    const png = await page.screenshot({ type: 'png' });
    if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain');
    frames++;
    if (frames % 100 === 0) console.log(`  frame ${frames}/${total}`);
  }
  ffmpeg.stdin.end();
  const [code] = await ffmpegClosed;
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);

  const events = await page.evaluate(() => window.__RENDER_API__.getEvents());
  fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2));

  // ASMR audio track + mux (video stream is copied, audio encoded to AAC)
  const run = (cmd, argv) => {
    const r = spawnSync(cmd, argv, { stdio: 'inherit' });
    if (r.error || r.status !== 0) throw new Error(`${cmd} failed (${r.error?.message ?? 'exit ' + r.status})`);
  };
  run(process.env.PYTHON_PATH || 'python', [path.join(root, 'scripts', 'build-audio.py'), eventsPath, wavPath]);
  run(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-y', '-loglevel', 'error', '-i', videoPath, '-i', wavPath,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out,
  ]);
  fs.rmSync(videoPath, { force: true });
  console.log(`Done: ${frames} frames -> ${path.relative(root, out)} (+audio), ${events.length} events -> ${path.relative(root, eventsPath)}`);
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}
