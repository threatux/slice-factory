// Scene layout constants (units: 1 world unit = 10 cm). Recipe-specific data lives in config/recipes/*.json.
export const LAYOUT = {
  camera: { pos: [1.8, 3.35, 3.75], look: [-0.1, 0.62, 0.3], fov: 66 },
  table: { size: [9, 6.4] }, // x, z extent; top surface at y = 0
  ruler: { z: 2.55, length: 8.4 },
  hudSafeTop: 0.285, // fraction of frame height reserved for the top HUD (knife must stay below it)
  knife: { length: 1.9, height: 0.44, thickness: 0.03, handleTiltDeg: 7, maxRaise: 1.3, park: [3.3, 2.55, 0.6] }, // park: x, edge height, z while a block drops
  zIdle: 1.1, // knife rest z (front)
};
