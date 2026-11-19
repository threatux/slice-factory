import { formatPieces, formatSize } from './util.js';

/** Telemetry overlay (DOM, rasterised by the screenshot capture). */
export function createHud(profile, recipe) {
  const stage = document.getElementById('stage');
  stage.style.width = profile.width + 'px';
  stage.style.height = profile.height + 'px';
  stage.style.setProperty('--h', profile.height + 'px');
  stage.style.setProperty('--accent', recipe.palette.accent);
  const $ = (id) => document.getElementById(id);
  const hud = $('hud'), tool = $('tool'), roundTag = $('round'), cuts = $('v-cuts'), of = $('v-of');
  const pieces = $('v-pieces'), size = $('v-size'), title = $('title');
  // Hook card: two balanced lines (big subject / smaller tracked challenge), falls back to splitting the title at " vs ".
  const lines = recipe.titleLines ?? (/ vs /i.test(recipe.title) ? [recipe.title.split(/ vs /i)[0], 'vs ' + recipe.title.split(/ vs /i)[1]] : [recipe.title, '']);
  $('t-main').textContent = lines[0];
  $('t-line2').textContent = lines[1] ?? '';
  $('t-sub').textContent = recipe.subtitle ?? '';

  const segs = $('segs');
  segs.innerHTML = '';
  const fills = [], labels = [];
  recipe.rounds.forEach((r) => {
    const seg = document.createElement('div'); seg.className = 'seg';
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('i'); bar.appendChild(fill);
    const lab = document.createElement('span'); lab.textContent = r.cuts.toLocaleString('en-US');
    seg.append(bar, lab); segs.appendChild(seg);
    fills.push(fill); labels.push(lab);
  });

  return {
    set(s) {
      hud.style.opacity = s.alpha.toFixed(3);
      title.style.opacity = s.titleAlpha.toFixed(3);
      tool.textContent = 'TOOL: ' + s.tool;
      roundTag.textContent = `R${s.round + 1}/${s.rounds}`;
      cuts.textContent = String(s.cuts);
      of.textContent = '/ ' + s.cutsTotal.toLocaleString('en-US');
      pieces.textContent = formatPieces(s.pieces);
      size.textContent = formatSize(s.sizeM);
      fills.forEach((f, i) => {
        const v = i < s.round ? 1 : i === s.round ? s.roundProgress : 0;
        f.style.transform = `scaleX(${v.toFixed(3)})`;
        labels[i].className = i === s.round ? 'on' : '';
      });
    },
  };
}
