// Scene layout constants (units: 1 world unit = 10 cm). Recipe-specific data lives in config/recipes/*.json.
export const LAYOUT = {
  camera: { pos: [0.5, 3.3, 6.6], look: [0, 0.55, 0.5], fov: 50 },
  table: { size: [9, 6.4] }, // x, z extent; top surface at y = 0
  ruler: { z: 2.55, length: 8.4 },
  hudSafeTop: 0.285, // fraction of frame height reserved for the top HUD (knife must stay below it)
  knife: { length: 1.9, height: 0.5, thickness: 0.022, handleTiltDeg: 20, maxRaise: 1.2 },
  zIdle: 1.1, // knife rest z (front)
};
