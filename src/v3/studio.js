// v3 studio (engineVersion 3 only): ACES filmic + sRGB, procedural Softbox Studio environment (PMREM), obsidian-slate podium,
// key light with 2048 PCF shadows, contact shadow blob, and a post chain: MSAA (4x, half-float) RenderPass -> selective
// UnrealBloom (high threshold: only the gold core / hot glass glints bloom; the DOM HUD is never touched) -> OutputPass.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mulberry32 } from '../util.js';

/** Softbox Studio HDRI scene: dark room, 2 tall contrasting vertical softboxes left/right, warm top rim strip, faint front kicker. */
function softboxScene(o) {
  const s = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(30, 16, 30), new THREE.MeshBasicMaterial({ color: new THREE.Color(o.room ?? '#07080b'), side: THREE.BackSide }));
  room.position.y = 4;
  s.add(room);
  const panel = (w, h, color, k, pos, look) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(...look);
    s.add(m);
    return m;
  };
  const L = o.softboxL ?? 9, R = o.softboxR ?? 5.5, T = o.topRim ?? 4.5;
  panel(2.2, 7.5, '#f3f6ff', L, [-6.5, 2.4, 2.0], [0, 1, 0]); // key softbox (left, cool white)
  panel(1.6, 7.5, '#ffffff', R, [6.5, 2.4, 1.0], [0, 1, 0]); // fill softbox (right), contrasting intensity
  panel(9.0, 1.2, '#ffd29a', T, [0, 7.2, -3.5], [0, 0, 0]); // warm top rim strip behind
  panel(4.0, 0.8, '#e8eeff', 0.9, [0, 1.2, 9.0], [0, 1, 0]); // faint low front kicker
  return s;
}

/** Background: deep studio gradient (warm-dark centre glow, near-black edges). */
function backgroundTexture(o) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 1024;
  const g = c.getContext('2d');
  const lin = g.createLinearGradient(0, 0, 0, 1024);
  lin.addColorStop(0, o.bgTop ?? '#0b0d12'); lin.addColorStop(0.55, o.bgMid ?? '#151821'); lin.addColorStop(1, o.bgBottom ?? '#050608');
  g.fillStyle = lin; g.fillRect(0, 0, 512, 1024);
  const rad = g.createRadialGradient(256, 470, 20, 256, 470, 520);
  rad.addColorStop(0, 'rgba(70,40,52,0.35)'); rad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rad; g.fillRect(0, 0, 512, 1024);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Stone roughness (0.16 .. 0.32) + faint vein albedo, tileable value-noise fbm. */
function stoneMaps(o, seed = 11) {
  const N = 512, rnd = mulberry32(seed), lat = new Float32Array(64 * 64);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const vn = (x, y, p) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (a, b) => lat[((((a % p) + p) % p) * 64 + (((b % p) + p) % p)) % lat.length];
    return (at(xi, yi) * (1 - sx) + at(xi + 1, yi) * sx) * (1 - sy) + (at(xi, yi + 1) * (1 - sx) + at(xi + 1, yi + 1) * sx) * sy;
  };
  const fbm = (x, y) => { let s = 0, a = 0.5, p = 8; for (let k = 0; k < 5; k++) { s += a * vn(x * (p / 8), y * (p / 8), p); a *= 0.5; p *= 2; } return s; };
  const rough = new Uint8Array(N * N * 4), alb = new Uint8Array(N * N * 4);
  const [r0, r1] = o.roughness ?? [0.16, 0.32];
  const base = new THREE.Color(o.table ?? '#0d0f14');
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x / N) * 8, v = (y / N) * 8, n = fbm(u, v);
    const vein = Math.pow(1 - Math.abs(2 * fbm(u * 0.7 + n * 1.5, v * 0.7 + 3.1) - 1), 14);
    const r = (r0 + (r1 - r0) * n) * 255, i = (y * N + x) * 4;
    rough.set([r, r, r, 255], i);
    const k = 0.82 + 0.3 * n + 0.9 * vein;
    alb.set([Math.min(255, base.r * 255 * k * 3.2), Math.min(255, base.g * 255 * k * 3.2), Math.min(255, base.b * 255 * k * 3.2), 255], i);
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { rough: mk(rough, false), map: mk(alb, true) };
}

// ---- v3.1 "bright-marble" studio (recipe.v3.studioTheme): high-key food-ad set for the Shorts feed ----------------------
/** Bright studio HDRI: warm pearl room, two big soft white boxes, a broad top light and a soft front fill. */
function brightSoftboxScene(o) {
  const s = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(30, 16, 30), new THREE.MeshBasicMaterial({ color: new THREE.Color(o.room ?? '#b9b1a6').multiplyScalar(o.roomK ?? 0.55), side: THREE.BackSide }));
  room.position.y = 4;
  s.add(room);
  const panel = (w, h, color, k, pos, look) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(...look);
    s.add(m);
  };
  panel(3.2, 7.5, '#fff6ec', o.softboxL ?? 6, [-6.5, 2.6, 2.4], [0, 1, 0]); // key softbox (left, warm white)
  panel(2.4, 7.5, '#ffffff', o.softboxR ?? 4, [6.5, 2.4, 1.2], [0, 1, 0]); // fill softbox (right)
  panel(8.0, 3.0, '#fff8f0', o.topRim ?? 3, [0, 8.5, -1.0], [0, 0, 0]); // broad overhead
  panel(6.0, 1.6, '#fffaf2', o.front ?? 1.6, [0, 1.6, 9.0], [0, 1, 0]); // soft front fill (glass reads bright on frame 0)
  return s;
}

/** Bright backdrop: warm pearl centre glow -> greige edges with a light vignette (values kept below the bloom threshold). */
function brightBackgroundTexture(o) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 1024;
  const g = c.getContext('2d');
  const lin = g.createLinearGradient(0, 0, 0, 1024);
  lin.addColorStop(0, o.bgTop ?? '#d9d2c8'); lin.addColorStop(0.5, o.bgMid ?? '#ece7df'); lin.addColorStop(1, o.bgBottom ?? '#d4cdc2');
  g.fillStyle = lin; g.fillRect(0, 0, 512, 1024);
  const rad = g.createRadialGradient(256, 430, 40, 256, 470, 640);
  rad.addColorStop(0, 'rgba(250,247,242,0.55)'); rad.addColorStop(0.55, 'rgba(236,231,223,0)'); rad.addColorStop(1, o.bgEdge ?? 'rgba(170,160,148,0.55)');
  g.fillStyle = rad; g.fillRect(0, 0, 512, 1024);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Warm polished marble / travertine: #e5dfd5 -> #d6cec2 cloudy base, thin grey-taupe veins, roughness 0.22..0.38. */
function marbleMaps(o, seed = 23) {
  const N = 1024, rnd = mulberry32(seed), lat = new Float32Array(64 * 64);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const vn = (x, y, p) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (a, b) => lat[((((a % p) + p) % p) * 64 + (((b % p) + p) % p)) % lat.length];
    return (at(xi, yi) * (1 - sx) + at(xi + 1, yi) * sx) * (1 - sy) + (at(xi, yi + 1) * (1 - sx) + at(xi + 1, yi + 1) * sx) * sy;
  };
  const fbm = (x, y) => { let s = 0, a = 0.5, p = 8; for (let k = 0; k < 6; k++) { s += a * vn(x * (p / 8), y * (p / 8), p); a *= 0.5; p *= 2; } return s; };
  const rough = new Uint8Array(N * N * 4), alb = new Uint8Array(N * N * 4);
  const [r0, r1] = o.roughness ?? [0.22, 0.38];
  const A0 = new THREE.Color(o.table ?? '#e5dfd5'), A1 = new THREE.Color(o.table2 ?? '#d6cec2'), Vc = new THREE.Color(o.vein ?? '#9c9186');
  const col = new THREE.Color();
  A0.convertLinearToSRGB(); A1.convertLinearToSRGB(); Vc.convertLinearToSRGB();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x / N) * 8, v = (y / N) * 8, n = fbm(u, v);
    const warp = fbm(u * 0.5 + 7.3, v * 0.5 + 1.1);
    const vein = Math.pow(1 - Math.abs(2 * fbm(u * 0.6 + warp * 2.2, v * 0.35 + n * 1.4 + 3.1) - 1), 22);
    const fine = Math.pow(1 - Math.abs(2 * fbm(u * 1.7 + 11 + warp, v * 1.1 + 5) - 1), 40) * 0.5;
    col.copy(A0).lerp(A1, Math.min(1, Math.max(0, (n - 0.3) * 2.2))).lerp(Vc, Math.min(0.55, (vein + fine) * (o.veinStrength ?? 0.45)));
    const i = (y * N + x) * 4;
    alb.set([col.r * 255, col.g * 255, col.b * 255, 255], i);
    const r = (r0 + (r1 - r0) * Math.min(1, n * 1.2 + vein * 0.3)) * 255;
    rough.set([r, r, r, 255], i);
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(o.marbleRepeat ?? 1.6, o.marbleRepeat ?? 1.6); t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { rough: mk(rough, false), map: mk(alb, true) };
}

/** Pink caustic decal (ruby light focused through the glass onto the stone). */
function causticTexture(color) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), k = new THREE.Color(color);
  const rgb = `${Math.round(k.r * 255)},${Math.round(k.g * 255)},${Math.round(k.b * 255)}`;
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, `rgba(${rgb},1)`); r.addColorStop(0.45, `rgba(${rgb},0.55)`); r.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function blobTexture(rgb = '0,0,0') { // v3.1 bright studio: warm umber contact shadow instead of pure black
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, `rgba(${rgb},1)`); r.addColorStop(0.35, `rgba(${rgb},0.75)`); r.addColorStop(0.7, `rgba(${rgb},0.22)`); r.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

export function createStudio(profile, recipe) {
  const o = recipe.v3.studio ?? {};
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(profile.width, profile.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = o.exposure ?? 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // r187: PCFSoftShadowMap was folded into PCF (soft radius below)

  const bright = recipe.v3.studioTheme === 'bright-marble'; // v3.1; every other recipe keeps the v3.0 dark studio
  const scene = new THREE.Scene();
  scene.background = bright ? brightBackgroundTexture(o) : backgroundTexture(o);
  const fogC = new THREE.Color(o.fog ?? '#08090d');
  scene.fog = new THREE.Fog(fogC, o.fogNear ?? 7, o.fogFar ?? 17); // podium fades softly into the dark backdrop

  const camera = new THREE.PerspectiveCamera(45, profile.width / profile.height, 0.05, 60);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = bright ? brightSoftboxScene : softboxScene;
  scene.environment = pmrem.fromScene(envScene(o), 0.02).texture;
  scene.environmentIntensity = o.environmentIntensity ?? 1.0;
  // the podium gets its own reflection probe: same studio, but a dimmer warm top strip (its grazing reflection was a beige haze at the frame bottom)
  const tableEnv = o.tableTopRim !== undefined ? pmrem.fromScene(envScene({ ...o, topRim: o.tableTopRim }), 0.02).texture : null;
  pmrem.dispose();

  scene.add(bright ? new THREE.HemisphereLight(0xfff7ee, 0xb8aea2, o.ambient ?? 0.5) : new THREE.HemisphereLight(0x9fb0d0, 0x120c10, o.ambient ?? 0.12));
  const key = new THREE.DirectionalLight(bright ? 0xfff6ec : 0xf2f5ff, o.key ?? 2.6);
  key.position.set(...(o.keyPos ?? [-2.6, 6.2, 3.4]));
  key.castShadow = true;
  const sm = o.shadowMapSize ?? 2048;
  key.shadow.mapSize.set(sm, sm);
  Object.assign(key.shadow.camera, { left: -4.2, right: 4.2, top: 4.2, bottom: -4.2, near: 1, far: 16 });
  key.shadow.bias = -0.00025; key.shadow.normalBias = 0.015; key.shadow.radius = o.shadowRadius ?? 5; key.shadow.blurSamples = o.shadowSamples ?? 16;
  scene.add(key);
  const rim = new THREE.SpotLight(0xffc68a, o.rim ?? 26, 14, o.rimAngle ?? 0.75, o.rimPenumbra ?? 0.85, 2); // warm top-back rim
  rim.position.set(0.6, 5.5, -3.6); rim.target.position.set(0, 0.6, o.rimTargetZ ?? 0);
  const side = new THREE.SpotLight(0xdfe8ff, o.side ?? 14, 12, 0.6, 0.9, 2); // right softbox kick (crisp glass edge)
  side.position.set(4.2, 2.2, 1.2); side.target.position.set(0, 0.6, 0);
  scene.add(rim, rim.target, side, side.target);

  // podium: polished obsidian-slate disc (clearcoat for the studio reflections), procedural stone roughness 0.16-0.32
  const st = bright ? marbleMaps(o) : stoneMaps(o);
  const table = new THREE.Mesh(new THREE.CylinderGeometry(o.podiumRadius ?? 7, o.podiumRadius ?? 7, 0.3, 128), new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: st.map, roughness: 1, roughnessMap: st.rough, metalness: 0.0, clearcoat: o.clearcoat ?? 0.85, clearcoatRoughness: 0.06,
    envMap: tableEnv, envMapIntensity: o.tableEnv ?? 0.9, specularIntensity: o.tableSpecular ?? 0.12, // broad key-light lobe of the rough stone base stays low: no haze
  }));
  table.position.y = -0.15;
  table.receiveShadow = true;
  scene.add(table);

  // polished stone: faint planar mirror added on top of the podium (radially faded), the apple and the gems reflect in it
  const mr = o.mirror ?? { strength: 0.2, fade: [1.4, 4.2], scale: 0.5 };
  if (mr.strength > 0) {
    const mirror = new Reflector(new THREE.CircleGeometry(o.podiumRadius ?? 7, 96), {
      textureWidth: Math.round(profile.width * mr.scale), textureHeight: Math.round(profile.height * mr.scale), multisample: 4, clipBias: 0.002,
      shader: {
        name: 'PolishedStoneMirror',
        uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, uStrength: { value: mr.strength }, uFade: { value: new THREE.Vector2(...mr.fade) } },
        vertexShader: `uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vWP;
          void main() { vUv = textureMatrix * vec4(position, 1.0); vWP = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform sampler2D tDiffuse; uniform float uStrength; uniform vec2 uFade; varying vec4 vUv; varying vec3 vWP;
          void main() { vec4 base = texture2DProj(tDiffuse, vUv); float f = 1.0 - smoothstep(uFade.x, uFade.y, length(vWP.xz));
            gl_FragColor = vec4(base.rgb * uStrength * f, 1.0); }`,
      },
    });
    mirror.material.transparent = true; mirror.material.blending = THREE.AdditiveBlending; mirror.material.depthWrite = false;
    mirror.rotation.x = -Math.PI / 2; mirror.position.y = 0.0008; mirror.renderOrder = 0;
    scene.add(mirror);
  }

  // contact shadow (soft AO blob under the intact apple; the debris has real shadows)
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: bright ? blobTexture(o.blobRGB ?? '58,44,40') : blobTexture(), transparent: true, depthWrite: false, opacity: 0.7, toneMapped: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.002; blob.renderOrder = 1;
  scene.add(blob);

  // v3.1 bright studio: ruby caustic decal under the glass (driven by the game like the blob)
  let caustic = null;
  if (bright && o.caustic) {
    const cg = new THREE.PlaneGeometry(1, 1); cg.rotateX(-Math.PI / 2);
    caustic = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ map: causticTexture(o.caustic.color ?? '#ff3d6e'), transparent: true, depthWrite: false, opacity: 0.4, toneMapped: true, color: new THREE.Color(o.caustic.tint ?? '#ffffff').multiplyScalar(o.caustic.gain ?? 1) }));
    caustic.position.set(o.caustic.offset?.[0] ?? 0.3, 0.003, o.caustic.offset?.[1] ?? -0.3); caustic.renderOrder = 2;
    scene.add(caustic);
  }

  const knifeLight = new THREE.PointLight(0xe8f4ff, 0, 1.1, 2); // short reach: lights the cut, never a hot spot on the podium
  scene.add(knifeLight);

  // post: MSAA half-float target -> bloom -> output (tone mapping + sRGB)
  const rt = new THREE.WebGLRenderTarget(profile.width, profile.height, { type: THREE.HalfFloatType, samples: o.msaa ?? 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1);
  composer.setSize(profile.width, profile.height);
  composer.addPass(new RenderPass(scene, camera));
  const b = o.bloom ?? {};
  const bloom = new UnrealBloomPass(new THREE.Vector2(profile.width, profile.height), b.strength ?? 0.32, b.radius ?? 0.45, b.threshold ?? 0.88);
  if (b.clamp) { // soft HDR ceiling into the bright-pass: a single hot specular pixel can no longer bloom into a giant white ball
    const fs = bloom.materialHighPassFilter.fragmentShader;
    bloom.materialHighPassFilter.fragmentShader = fs.replace('gl_FragColor = mix( outputColor, texel, alpha );', `gl_FragColor = mix( outputColor, vec4( min( texel.rgb, vec3( ${Number(b.clamp).toFixed(3)} ) ), texel.a ), alpha );`);
    if (bloom.materialHighPassFilter.fragmentShader === fs) console.warn('bloom clamp: high-pass shader pattern not found');
    bloom.materialHighPassFilter.needsUpdate = true;
  }
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  return { renderer, scene, camera, key, rim, side, knifeLight, blob, caustic, composer, bloom, render: () => composer.render() };
}
