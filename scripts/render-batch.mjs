#!/usr/bin/env node
// Sequential batch renderer + cover thumbnail extractor.
// Usage: node scripts/render-batch.mjs [--profile=prod|draft] [--force] [--thumbs-only] <recipe...>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const MIN_BYTES = 1024 * 1024;
const THUMBS = [['hook', 0.6], ['split', 3.0]];

const HELP = `Usage: node scripts/render-batch.mjs [options] <recipe> [<recipe> ...]
  <recipe>          short name (config/recipes/<name>.json) or path to a recipe json
  --profile=NAME    prod (default) | draft
  --force           re-render even if a valid output mp4 exists
  --thumbs-only     only extract thumbnails from existing mp4s (no rendering)
  --help            show this help`;

const opts = { profile: 'prod', force: false, thumbsOnly: false };
const recipes = [];
for (const a of process.argv.slice(2)) {
  if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
  else if (a === '--force') opts.force = true;
  else if (a === '--thumbs-only') opts.thumbsOnly = true;
  else if (a.startsWith('--profile=')) opts.profile = a.slice(10);
  else if (a.startsWith('--')) { console.error(`Unknown option: ${a}\n${HELP}`); process.exit(2); }
  else recipes.push(a);
}
if (!['prod', 'draft'].includes(opts.profile)) { console.error(`Bad --profile: ${opts.profile}`); process.exit(2); }
if (!recipes.length) { console.error(`No recipes given.\n${HELP}`); process.exit(2); }

const resolveRecipe = (arg) => {
  const hasExt = arg.toLowerCase().endsWith('.json');
  const isPath = /[\\/]/.test(arg);
  const file = isPath ? path.resolve(root, arg) : path.join(root, 'config', 'recipes', hasExt ? arg : `${arg}.json`);
  return { file, base: path.basename(file, '.json') };
};

const probe = (file) => {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const types = (j.streams ?? []).map((s) => s.codec_type);
    return { video: types.includes('video'), audio: types.includes('audio'), duration: parseFloat(j.format?.duration) || 0 };
  } catch { return null; }
};

const validOutput = (file) => {
  if (!fs.existsSync(file) || fs.statSync(file).size <= MIN_BYTES) return null;
  const p = probe(file);
  return p && p.video && p.audio ? p : null;
};

const extractThumbs = (mp4, name) => {
  const dir = path.join(root, 'output', 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  for (const [tag, t] of THUMBS) {
    const out = path.join(dir, `${name}_${tag}.png`);
    const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(t), '-i', mp4, '-frames:v', '1', out], { encoding: 'utf8' });
    if (r.error || r.status !== 0 || !fs.existsSync(out)) throw new Error(`thumb ${tag} failed: ${r.error?.message ?? r.stderr}`);
  }
};

const renderOne = (recipeFile, out) => new Promise((resolve) => {
  const child = spawn(process.execPath, [
    path.join(root, 'scripts', 'render.mjs'), `--recipe=${recipeFile}`, `--profile=${opts.profile}`, `--out=${out}`,
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const tee = (stream, sink) => stream.on('data', (d) => { sink.write(d); buf += d.toString(); });
  tee(child.stdout, process.stdout);
  tee(child.stderr, process.stderr);
  child.on('error', (e) => resolve({ code: -1, buf: buf + e.message }));
  child.on('close', (code) => resolve({ code, buf }));
});

const rows = [];
for (const arg of recipes) {
  const { file, base } = resolveRecipe(arg);
  const name = `${base}-${opts.profile}`;
  const rel = path.join('output', `${name}.mp4`);
  const out = path.join(root, rel);
  const row = { recipe: base, status: '', duration: '-', size: '-', peak: '-', clipped: '-', elapsed: '-' };
  rows.push(row);
  const t0 = Date.now();
  console.log(`\n=== ${base} [${opts.profile}] ===`);
  try {
    if (opts.thumbsOnly) {
      if (!validOutput(out)) throw new Error(`no valid ${rel}`);
      extractThumbs(out, name);
      row.status = 'THUMBS';
    } else {
      if (!fs.existsSync(file)) throw new Error(`recipe not found: ${file}`);
      if (!opts.force && validOutput(out)) {
        row.status = 'SKIPPED';
        extractThumbs(out, name);
      } else {
        const { code, buf } = await renderOne(file, out);
        const m = [...buf.matchAll(/peak\s+(-?[\d.]+)\s+dBFS,\s*clipped\s+(\d+)/g)].pop();
        if (m) { row.peak = m[1]; row.clipped = m[2]; }
        if (code !== 0) throw new Error(`render.mjs exit ${code}`);
        if (!validOutput(out)) throw new Error('output invalid (size/streams)');
        extractThumbs(out, name);
        row.status = 'OK';
      }
    }
    const p = probe(out);
    const st = fs.statSync(out);
    row.duration = p ? `${p.duration.toFixed(1)}s` : '-';
    row.size = (st.size / 1048576).toFixed(1);
  } catch (e) {
    row.status = 'FAILED';
    console.error(`FAILED ${base}: ${e.message}`);
  }
  const s = Math.round((Date.now() - t0) / 1000);
  row.elapsed = `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const head = ['Recipe', 'Status', 'Duration', 'Size (MB)', 'Peak dBFS', 'Clipped', 'Elapsed'];
const table = [head, ...rows.map((r) => [r.recipe, r.status, r.duration, r.size, r.peak, r.clipped, r.elapsed])];
const w = head.map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
const fmt = (r) => r.map((c, i) => String(c).padEnd(w[i])).join(' | ');
console.log('\n' + fmt(table[0]));
console.log(w.map((n) => '-'.repeat(n)).join('-+-'));
table.slice(1).forEach((r) => console.log(fmt(r)));
process.exit(rows.some((r) => r.status === 'FAILED') ? 1 : 0);
