import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LAYOUT } from './config.js';
import { makeTableTexture, makeRulerTexture, makeBackdropTexture } from './textures.js';

/** "Precision Cutting Lab": dark matte table with mm markings, ruler, architectural backdrop, rim lighting. No post-processing. */
export function createScene(profile, pal) {
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(profile.width, profile.height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(pal.background);
  scene.fog = new THREE.Fog(pal.background, 10, 22);

  const c = LAYOUT.camera;
  const camera = new THREE.PerspectiveCamera(c.fov, profile.width / profile.height, 0.1, 60);
  camera.position.set(...c.pos);
  camera.lookAt(...c.look);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0x8aa0c8, 0x1a1418, 0.25));

  const key = new THREE.DirectionalLight(0xdce6ff, 2.2);
  key.position.set(-2.5, 6, 4.5);
  key.castShadow = true;
  key.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
  Object.assign(key.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 1, far: 16 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 4;
  scene.add(key);

  // Rim / back lights give obsidian its edge highlights.
  const rim = new THREE.SpotLight(pal.accent, 35, 14, 0.7, 0.8, 2);
  rim.position.set(-2.8, 1.3, -3.0); // low: grazes the edges, no orange glare blob on the glossy top
  rim.target.position.set(0, 0.5, 0);
  const rim2 = new THREE.SpotLight(0x86b4ff, 70, 14, 0.7, 0.8, 2);
  rim2.position.set(3.2, 3.2, -3.0);
  rim2.target.position.set(0, 0.6, 0);
  scene.add(rim, rim.target, rim2, rim2.target);

  const [tx, tz] = LAYOUT.table.size;
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(tx, 0.3, tz),
    new THREE.MeshStandardMaterial({ map: makeTableTexture(pal, [tx, tz]), roughness: 0.82, metalness: 0.25 }),
  );
  table.position.y = -0.15;
  table.receiveShadow = true;
  scene.add(table);

  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), new THREE.MeshBasicMaterial({ map: makeBackdropTexture(pal), fog: false }));
  backdrop.position.set(0, 4.2, -tz / 2 - 0.02);
  scene.add(backdrop);

  const R = LAYOUT.ruler;
  const ruler = new THREE.Mesh(
    new THREE.BoxGeometry(R.length, 0.03, 0.32),
    [0, 1, 2, 3, 4, 5].map((i) => new THREE.MeshStandardMaterial(
      i === 2 ? { map: makeRulerTexture(pal, R.length), roughness: 0.45, metalness: 0.6 } : { color: 0x20232a, roughness: 0.5, metalness: 0.6 },
    )),
  );
  ruler.position.set(0, 0.015, R.z);
  ruler.receiveShadow = true;
  scene.add(ruler);

  const knifeLight = new THREE.PointLight(0xffffff, 0, 3.2, 2);
  scene.add(knifeLight);

  return { renderer, scene, camera, key, knifeLight };
}
