import profiles from '../config/render-profiles.json';
import { createGame } from './game.js';

let game = null;

window.__RENDER_API__ = {
  async init(profile, recipe, opts = {}) {
    game = await createGame(profile, recipe, opts);
    return game.info();
  },
  step(dt) { game.step(dt); },
  isDone() { return game.isDone(); },
  getEvents() { return game.getEvents(); },
  probe() { return game.probe(); },
};

// Manual preview in a normal browser: /?preview=draft&recipe=obsidian-lava&rounds=2 (real-time playback of fixed steps).
const q = new URLSearchParams(location.search);
const preview = q.get('preview');
if (preview && profiles[preview]) {
  const profile = profiles[preview];
  const name = q.get('recipe') ?? 'obsidian-lava';
  fetch(`/config/recipes/${name}.json`).then((r) => r.json()).then((recipe) => {
    const maxRounds = q.get('rounds') ? Number(q.get('rounds')) : undefined;
    return window.__RENDER_API__.init(profile, recipe, { maxRounds });
  }).then(() => {
    const dt = 1 / profile.fps;
    let last = performance.now(), acc = 0;
    const loop = (now) => {
      acc += (now - last) / 1000; last = now;
      while (acc >= dt && !game.isDone()) { game.step(dt); acc -= dt; }
      if (!game.isDone()) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
