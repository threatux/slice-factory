// v2 minimal HUD (DOM, rasterised by the screenshot capture). No boxes: stage label + piece counter in the top safe zone,
// hook title + badge, finale call-to-action in the upper third, white transition flash. Bottom 20% always empty.
// Every value is a pure function of t.
import { clamp01 } from '../util.js';

const sm = (a, b, x) => { const u = clamp01((x - a) / (b - a)); return u * u * (3 - 2 * u); };

export function createHudV2(profile, recipe, tl) {
  const V = recipe.v2, pal = recipe.palette;
  // recipe.v2.hud overrides (defaults reproduce the gold-emerald look 1:1)
  const hc = { badgeFrom: pal.shell, badgeTo: '#ffe27a', badgeText: '#111', bonusFrom: pal.shell, bonusMid: '#fff3b0', bonusTo: pal.core, hot: pal.accent, ...(V.hud ?? {}) };
  const bonusGrad = hc.bonusMid ? `${hc.bonusFrom}, ${hc.bonusMid} 45%, ${hc.bonusTo}` : `${hc.bonusFrom}, ${hc.bonusTo}`;
  const stage = document.getElementById('stage');
  stage.style.width = profile.width + 'px';
  stage.style.height = profile.height + 'px';
  stage.style.setProperty('--h', profile.height + 'px');
  for (const id of ['hud', 'title']) document.getElementById(id)?.remove(); // v1 telemetry boxes are not used by v2
  const css = document.createElement('style');
  css.textContent = `
    #v2 { position: absolute; inset: 0; pointer-events: none; color: #fff; text-align: center;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-weight: 900; }
    #v2 .ln { position: absolute; left: 4%; right: 4%; white-space: nowrap; transform-origin: 50% 50%;
      text-shadow: 0 0 calc(var(--h) * .012) rgba(0,0,0,.85), 0 calc(var(--h) * .003) calc(var(--h) * .004) rgba(0,0,0,.9); }
    #v2 #v2-label { top: 8.5%; font-size: calc(var(--h) * .064); letter-spacing: -.01em; line-height: 1; }
    #v2 #v2-label.bonus { background: linear-gradient(90deg, ${bonusGrad}); -webkit-background-clip: text; background-clip: text;
      color: transparent; text-shadow: none; filter: drop-shadow(0 0 calc(var(--h) * .008) rgba(0,0,0,.9)); }
    #v2 #v2-count { top: 15.6%; font-size: calc(var(--h) * .03); font-weight: 700; letter-spacing: .02em; color: #e9ecf2; line-height: 1; }
    #v2 #v2-count.hot { color: ${hc.hot}; }
    #v2 #v2-hook { top: 8%; font-size: calc(var(--h) * .07); line-height: 1; letter-spacing: -.01em; }
    #v2 #v2-badge { top: 16.2%; left: 50%; right: auto; width: max-content; transform: translateX(-50%); font-size: calc(var(--h) * .03); font-weight: 800; line-height: 1;
      padding: calc(var(--h) * .011) calc(var(--h) * .022); border-radius: 999px; color: ${hc.badgeText}; text-shadow: none;
      background: linear-gradient(90deg, ${hc.badgeFrom}, ${hc.badgeTo}); box-shadow: 0 calc(var(--h) * .004) calc(var(--h) * .02) rgba(0,0,0,.55); }
    #v2 #v2-final { top: 22%; font-size: calc(var(--h) * .047); line-height: 1.05; }
    #v2-flash { position: absolute; inset: 0; background: #fff; opacity: 0; mix-blend-mode: screen; }
  ` + (hc.textShadowStrong ? `
    #v2 #v2-count, #v2 #v2-final { text-shadow: 0 0 calc(var(--h) * .006) rgba(0,8,20,.95), 0 0 calc(var(--h) * .018) rgba(0,8,20,.9),
      0 0 calc(var(--h) * .036) rgba(0,8,20,.75), 0 calc(var(--h) * .003) calc(var(--h) * .005) rgba(0,0,0,.95); }
    #v2 #v2-label.bonus { filter: drop-shadow(0 0 calc(var(--h) * .006) rgba(0,8,20,.95)) drop-shadow(0 0 calc(var(--h) * .02) rgba(0,8,20,.8)); }
  ` : '');
  document.head.appendChild(css);
  const root = document.createElement('div');
  root.id = 'v2';
  root.innerHTML = `<div id="v2-flash"></div><div id="v2-label" class="ln"></div><div id="v2-count" class="ln"></div>
    <div id="v2-hook" class="ln"></div><div id="v2-badge" class="ln"></div><div id="v2-final" class="ln"></div>`;
  stage.appendChild(root);
  const $ = (id) => document.getElementById(id);
  const label = $('v2-label'), count = $('v2-count'), hook = $('v2-hook'), badge = $('v2-badge'), final = $('v2-final'), flash = $('v2-flash');
  hook.textContent = V.hook.title;
  badge.textContent = V.hook.badge;
  final.textContent = V.finale.text;
  // shrink long lines to 92% of the frame width
  const fit = (el) => {
    const r = document.createRange(); r.selectNodeContents(el);
    const w = r.getBoundingClientRect().width, max = profile.width * 0.92;
    if (w > max) el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * max / w).toFixed(2) + 'px';
  };
  [hook, final].forEach(fit);
  const fitCache = new Map();
  const setLabel = (txt, bonus) => {
    if (label.textContent !== txt) {
      label.textContent = txt;
      label.className = 'ln' + (bonus ? ' bonus' : '');
      label.style.fontSize = '';
      if (!fitCache.has(txt)) { fit(label); fitCache.set(txt, label.style.fontSize); } else label.style.fontSize = fitCache.get(txt);
    }
  };
  const fin = V.finale, R0 = tl.rounds[0], hk = V.hook;
  const op = (el, a) => { el.style.opacity = a.toFixed(3); el.style.visibility = a > 0.001 ? 'visible' : 'hidden'; };

  return {
    update(t) {
      // hook title (also fades back in at the very end so the last frame matches frame 0)
      const hookA = (1 - sm(hk.end - 0.05, hk.end + 0.12, t)) + sm(V.duration - 0.25, V.duration, t); // reappears only once the ingot is whole
      op(hook, Math.min(1, hookA)); op(badge, Math.min(1, hookA));
      const bp = 1 + 0.04 * Math.sin(t * 2 * Math.PI * 1.6) * (t < hk.end ? 1 : 0);
      badge.style.transform = `translateX(-50%) scale(${bp.toFixed(4)})`;
      // stage label + counter
      const r = tl.roundAt(t);
      if (r < 0 || t < R0.start - 0.1) { op(label, 0); op(count, 0); } else {
        // the title switches to the next round halfway through the reverse assembly (old pieces still on the table until then)
        const Rn = tl.rounds[r], sw = Rn.start + 0.5 * (Rn.reasmEnd - Rn.start);
        const rl = r > 0 && t < sw ? r - 1 : r;
        const R = tl.rounds[rl];
        setLabel(R.label, R.bonus);
        const tin = rl === 0 ? hk.whipEnd - 0.1 : sw;
        const out = 1 - sm(fin.rewind, fin.rewind + 0.3, t);
        const a = (rl === 0 ? sm(tin, tin + 0.15, t) : 1) * out;
        op(label, a);
        const pop = 1 + 0.18 * Math.exp(-(t - tin) / 0.09) * (t >= tin ? 1 : 0) + (R.bonus ? 0.06 * Math.exp(-(t - tin) / 0.3) * Math.sin((t - tin) * 18) : 0);
        label.style.transform = `scale(${pop.toFixed(4)})`;
        const hit = t >= R.impact;
        const txt = hit ? R.pieces : '1 Piece';
        if (count.textContent !== txt) count.textContent = txt;
        count.className = 'ln' + (hit && t - R.impact < 0.5 ? ' hot' : '');
        const cp = hit ? 1 + 0.35 * Math.exp(-(t - R.impact) / 0.08) : 1;
        count.style.transform = `scale(${cp.toFixed(4)})`;
        op(count, a * (hit ? 1 : 0.7));
      }
      // finale call to action (upper third)
      const fa = sm(fin.in, fin.in + 0.25, t) * (1 - sm(fin.out, fin.out + 0.3, t));
      op(final, fa);
      final.style.transform = `translateY(${((1 - sm(fin.in, fin.in + 0.3, t)) * profile.height * 0.02).toFixed(2)}px)`;
      // flash: whip transition, impacts, round transitions
      let f = 0.38 * Math.max(0, 1 - Math.abs(t - (hk.end + 0.13)) / 0.17);
      for (const R of tl.rounds) {
        const tau = t - R.impact;
        if (tau >= 0 && tau < 0.2) f = Math.max(f, (0.05 + 0.04 * R.tier) * (1 - tau / 0.2));
        const tr = t - R.start;
        if (R.index > 0 && tr >= 0 && tr < 0.25) f = Math.max(f, 0.1 * Math.sin(Math.PI * tr / 0.25));
      }
      op(flash, f);
    },
  };
}
