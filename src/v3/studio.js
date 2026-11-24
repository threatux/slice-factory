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

function blobTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, 'rgba(0,0,0,1)'); r.addColorStop(0.35, 'rgba(0,0,0,0.75)'); r.addColorStop(0.7, 'rgba(0,0,0,0.22)'); r.addColorStop(1, 'rgba(0,0,0,0)');
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

  const scene = new THREE.Scene();
  scene.background = backgroundTexture(o);
  const fogC = new THREE.Color(o.fog ?? '#08090d');
  scene.fog = new THREE.Fog(fogC, o.fogNear ?? 7, o.fogFar ?? 17); // podium fades softly into the dark backdrop

  const camera = new THREE.PerspectiveCamera(45, profile.width / profile.height, 0.05, 60);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(softboxScene(o), 0.02).texture;
  scene.environmentIntensity = o.environmentIntensity ?? 1.0;
  // the podium gets its own reflection probe: same studio, but a dimmer warm top strip (its grazing reflection was a beige haze at the frame bottom)
  const tableEnv = o.tableTopRim !== undefined ? pmrem.fromScene(softboxScene({ ...o, topRim: o.tableTopRim }), 0.02).texture : null;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0x9fb0d0, 0x120c10, o.ambient ?? 0.12));
  const key = new THREE.DirectionalLight(0xf2f5ff, o.key ?? 2.6);
  key.position.set(-2.6, 6.2, 3.4);
  key.castShadow = true;
  const sm = o.shadowMapSize ?? 2048;
  key.shadow.mapSize.set(sm, sm);
  Object.assign(key.shadow.camera, { left: -4.2, right: 4.2, top: 4.2, bottom: -4.2, near: 1, far: 16 });
  key.shadow.bias = -0.00025; key.shadow.normalBias = 0.015; key.shadow.radius = 5; key.shadow.blurSamples = 16;
  scene.add(key);
  const rim = new THREE.SpotLight(0xffc68a, o.rim ?? 26, 14, o.rimAngle ?? 0.75, o.rimPenumbra ?? 0.85, 2); // warm top-back rim
  rim.position.set(0.6, 5.5, -3.6); rim.target.position.set(0, 0.6, o.rimTargetZ ?? 0);
  const side = new THREE.SpotLight(0xdfe8ff, o.side ?? 14, 12, 0.6, 0.9, 2); // right softbox kick (crisp glass edge)
  side.position.set(4.2, 2.2, 1.2); side.target.position.set(0, 0.6, 0);
  scene.add(rim, rim.target, side, side.target);

  // podium: polished obsidian-slate disc (clearcoat for the studio reflections), procedural stone roughness 0.16-0.32
  const st = stoneMaps(o);
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
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.7, toneMapped: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.002; blob.renderOrder = 1;
  scene.add(blob);

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

  return { renderer, scene, camera, key, rim, side, knifeLight, blob, composer, bloom, render: () => composer.render() };
}
