import * as THREE from 'three';
import {
  makeObsidian, makeLined, resetLined, scoreLine, makeCap,
  makeGlowTexture, makeEdgeGradient, makeBladeGradient,
} from './textures.js';
import { LAYOUT } from './config.js';
import { clamp01 } from './util.js';

async function loadGlb(cfg) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(cfg.url);
  const root = gltf.scene;
  if (cfg.scale) root.scale.setScalar(cfg.scale);
  if (cfg.rotation) root.rotation.set(...cfg.rotation);
  root.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return root;
}

/**
 * Sliceable block. Cuts happen along world Z (the knife travels front/back); the block is turned 90° between phases.
 * `type: "procedural"` builds the faceted obsidian block, `type: "glb"` loads recipe.object.glb (size still defines the slicing volume).
 * Returns { group, capGroup, setClip(z), setCapVisible, paintCut(z), reset(), setHeat(h, t) }.
 */
export async function createBlock(cfg, pal) {
  const [W, H, D] = cfg.size;
  const group = new THREE.Group();
  const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), D / 2 + 1); // keeps z <= constant
  const clipMats = [];
  let lined = null;

  if (cfg.type === 'glb') {
    const root = await loadGlb(cfg.glb);
    root.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach((m) => clipMats.push(m)); });
    group.add(root);
  } else {
    const obs = makeObsidian(pal);
    lined = { top: makeLined(obs.baseCanvas), px: makeLined(obs.baseCanvas), nx: makeLined(obs.baseCanvas) };
    const common = {
      bumpMap: obs.bump, bumpScale: 2.2 * (cfg.relief ?? 1), roughness: cfg.roughness ?? 0.35, metalness: 0.15,
      envMapIntensity: 1.3, clippingPlanes: [clip], clipShadows: true,
    };
    const mk = (map, glow) => new THREE.MeshStandardMaterial({ ...common, map, ...(glow ? { emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.9 } : {}) });
    const plain = mk(obs.map);
    const mats = [mk(lined.px.tex, true), mk(lined.nx.tex, true), mk(lined.top.tex, true), plain, plain, plain]; // px nx py ny pz nz
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), mats);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    clipMats.push(...mats);
  }
  for (const m of clipMats) { m.clippingPlanes = [clip]; m.clipShadows = true; }

  // Cross-section cap: solid face exactly at the clipping plane with inner-layer texture and glowing core.
  const capTex = makeCap(pal);
  const capMat = new THREE.MeshStandardMaterial({
    map: capTex.map, bumpMap: capTex.map, bumpScale: 1.5, roughness: 0.5, metalness: 0.1,
    emissive: 0xffffff, emissiveMap: capTex.emissive, emissiveIntensity: 1.2,
  });
  const cap = new THREE.Mesh(new THREE.PlaneGeometry(W, H), capMat);
  cap.receiveShadow = true;
  cap.visible = false;
  const glowTex = makeGlowTexture();
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: pal.core, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.4, toneMapped: false,
  }));
  coreGlow.visible = false;
  const capGroup = new THREE.Group();
  capGroup.add(cap, coreGlow);

  const coreLight = new THREE.PointLight(pal.core, 0, 3.4, 2);
  capGroup.add(coreLight);

  return {
    group, capGroup, coreLight, size: [W, H, D],
    setClip(z) {
      clip.constant = z;
      const open = z < D / 2 - 0.005 && z > -D / 2 + 1e-4;
      cap.visible = coreGlow.visible = open;
      cap.position.set(0, H / 2, z + 0.0015);
      coreGlow.position.set(0, H / 2, z + 0.04);
      coreLight.position.set(0, H / 2, z + 0.45);
      // Core is an ellipsoid: its section shrinks toward the faces.
      const d = z / (D / 2), s = Math.sqrt(Math.max(0.14, 1 - d * d));
      capTex.emissive.repeat.set(1 / s, 1 / s);
      coreGlow.scale.setScalar(W * 0.95 * s);
    },
    paintCut(z, color = pal.accent, n = 10) { // z in the block's local (unrotated) frame
      if (!lined) return;
      const v = (z + D / 2) / D;
      scoreLine(lined.top, v, false, color, n); // top: canvas y = (z + D/2)/D
      scoreLine(lined.px, 1 - v, true, color, n); // +x face: canvas x = (D/2 - z)/D
      scoreLine(lined.nx, v, true, color, n); // -x face: canvas x = (z + D/2)/D
    },
    setHeat(h, t) {
      const flick = 0.92 + 0.08 * Math.sin(t * 9) + 0.04 * Math.sin(t * 23);
      capMat.emissiveIntensity = (0.9 + 1.5 * h) * flick;
      coreGlow.material.opacity = (0.25 + 0.4 * h) * flick;
      coreLight.intensity = (2 + 9 * h) * flick;
    },
    reset() {
      if (lined) for (const l of Object.values(lined)) resetLined(l);
      group.rotation.set(0, 0, 0);
      group.visible = true;
      this.setClip(D / 2 + 1);
    },
    hide() { group.visible = false; cap.visible = coreGlow.visible = false; coreLight.intensity = 0; },
  };
}

function bladeGeometry(len, h, thickness) {
  // Shape in XY (x: heel -> tip, y: edge -> spine); the edge is flat so the cut is clean.
  const s = new THREE.Shape();
  const x0 = -len / 2, x1 = len / 2;
  s.moveTo(x0, 0);
  s.lineTo(x1 - 0.35, 0);
  s.quadraticCurveTo(x1 - 0.06, 0.015, x1, h * 0.58);
  s.lineTo(x1 - 0.3, h * 0.92);
  s.lineTo(x0 + 0.1, h);
  s.lineTo(x0, h);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -thickness / 2);
  return g;
}

/**
 * Fixed-size knife (never scaled to the object): blade edge on y=0, blade along X, handle up-left at ~20°.
 * Tool look (steel / hot / ultrasonic / plasma / hyper) is applied through setTool().
 */
export async function createKnife(tools, accent) {
  const K = LAYOUT.knife;
  const BL = K.length, BH = K.height, th = (K.handleTiltDeg * Math.PI) / 180;
  const group = new THREE.Group();
  const geo = bladeGeometry(BL, BH, K.thickness);

  const grad = makeBladeGradient();
  grad.repeat.set(0.01, 1 / BH);
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0xcccccc, metalness: 0.9, roughness: 0.25, emissive: 0x000000, emissiveMap: grad, emissiveIntensity: 0,
  });
  const blade = new THREE.Mesh(geo, bladeMat);
  blade.castShadow = true;

  const gripMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.55, metalness: 0.1 });
  const hLen = 0.58;
  const handle = new THREE.Mesh(new THREE.BoxGeometry(hLen, 0.078, 0.05), gripMat);
  handle.rotation.z = Math.PI - th; // +x axis -> (-cos, +sin): up and to the left
  const baseX = -BL / 2 + 0.03, baseY = BH - 0.075;
  handle.position.set(baseX - (Math.cos(th) * hLen) / 2, baseY + (Math.sin(th) * hLen) / 2, 0);
  handle.castShadow = true;
  const bolster = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.055), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.9, roughness: 0.3 }));
  bolster.position.set(baseX + 0.01, baseY, 0);
  bolster.rotation.z = -th;
  group.add(blade, handle, bolster);

  // Light additive glow (no post-processing bloom).
  const edgeTex = makeEdgeGradient();
  const edgeMat = new THREE.MeshBasicMaterial({
    map: edgeTex, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0.5,
  });
  const edge = new THREE.Mesh(new THREE.PlaneGeometry(BL, 0.07), edgeMat);
  edge.position.set(0, 0.035, K.thickness / 2 + 0.002);
  edge.renderOrder = 5;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(), color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.4, toneMapped: false,
  }));
  halo.position.set(0, 0.02, 0.06);
  halo.renderOrder = 6;
  group.add(edge, halo);

  const light = new THREE.PointLight(0xffffff, 0, 3.2, 2);

  // Motion-blur ghosts (blade only), positioned by the game from past poses.
  const ghosts = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    m.visible = false; m.renderOrder = 4;
    ghosts.push(m);
  }

  let cur = tools[Object.keys(tools)[0]];
  return {
    group, light, ghosts, bladeLength: BL,
    setTool(name) {
      const t = tools[name];
      if (!t) throw new Error(`Unknown tool "${name}"`);
      cur = t;
      const hot = new THREE.Color(t.emissive).getHex() !== 0;
      if (hot) { // dark polished body, glow only on the thin cutting edge (emissiveMap)
        bladeMat.color.set(0x14161a); bladeMat.metalness = 0.9; bladeMat.roughness = 0.22;
        bladeMat.emissive.set(t.emissive); bladeMat.emissiveIntensity = Math.max(2.2, t.emissiveIntensity * 2.5);
        bladeMat.transparent = false; bladeMat.opacity = 1; bladeMat.depthWrite = true;
      } else {
        bladeMat.color.set(t.blade); bladeMat.metalness = t.metalness; bladeMat.roughness = t.roughness;
        bladeMat.emissive.set(t.emissive); bladeMat.emissiveIntensity = t.emissiveIntensity;
        bladeMat.transparent = t.opacity < 1; bladeMat.opacity = t.opacity; bladeMat.depthWrite = t.opacity >= 1;
      }
      bladeMat.needsUpdate = true;
      edgeMat.color.set(t.edge); halo.material.color.set(t.edge);
      light.color.set(t.light);
      ghosts.forEach((g, i) => { g.material.color.set(t.edge); g.visible = i < (t.ghosts ?? 0); });
    },
    /** boost: 0..1 flash right after a tool switch; t: seconds. */
    updateGlow(t, boost, contact) {
      const flick = 0.9 + 0.1 * Math.sin(t * 31) + 0.05 * Math.sin(t * 57);
      const g = cur.edgeGlow * (1 + boost * 1.5);
      edgeMat.opacity = clamp01(0.5 * g * flick);
      halo.material.opacity = clamp01((0.18 + 0.3 * g) * flick * (0.45 + 0.55 * contact));
      halo.scale.setScalar(0.5 + 0.5 * g);
      light.intensity = cur.lightIntensity * flick * (0.4 + 0.6 * contact) * (1 + boost);
    },
    ghostOpacity: () => cur.ghostOpacity ?? 0.25,
    ghostCount: () => cur.ghosts ?? 0,
    topPoints: () => [ // knife silhouette extremes (local) for HUD-safety projection
      [-BL / 2 - Math.cos(th) * hLen, baseY + Math.sin(th) * hLen + 0.05, 0],
      [-BL / 2, BH, 0], [BL / 2 - 0.3, BH * 0.92, 0],
    ],
  };
}
