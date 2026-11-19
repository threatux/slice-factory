# Project: Slice Factory (3D ASMR Cutting Video Engine)

## Architecture & Portability

- Cross-platform Node.js (Vite + Three.js + @dimforge/rapier3d-compat) + Playwright + FFmpeg.
- Strictly use relative paths (`path.join` / POSIX paths). Zero OS-specific shell scripts inside the pipeline.
- Deterministic step-by-step simulation (`stepFrame(dt)`), never rely on `requestAnimationFrame` wall-clock time during render.

## Hardware Profiles (`config/render-profiles.json`)

- `draft` (for 8GB RAM / iGPU): 540x960, 30fps, shadowMap 1024, max active rigid cubes 400.
- `prod` (for Apple Silicon 32GB): 1080x1920, 60fps, shadowMap 2048, max active rigid cubes 2500.
- Default profile during development: `draft`.

## Token & Scope Rules

- Keep shaders, physics, scene, HUD, and audio timestamps cleanly separated into modules.
- Do not install heavy UI frameworks or Remotion.
