# rainy-night-webgpu

English · [中文](README.zh-CN.md)

A rainy Kyoto-style alley in the browser: rain, wet streets, a canal, lanterns, and occasional lightning. Built with three.js `0.186` `WebGPURenderer` + TSL.

Live demo: https://rainy-night-webgpu.vercel.app/

## Run

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173/. Requires a WebGPU browser. Without it you get a black screen, not a slow load.

## Controls

- Drag / scroll to look around (orbit is disabled while the walk tour is playing)
- Camera button, bottom right: start the walk tour (Space / Enter also work)
- Speaker button, bottom right: rain audio; the first click on the page also unlocks audio

## Scene

- City `public/models/city.glb` (KTX2 textures + meshopt), loaded with `KTX2Loader` and `MeshoptDecoder`
- Colliding rain via a height map, plus splash sprites
- Canal lighting, reflection, and flowing waves
- Road / bridge wet film and puddle planar reflection
- Lantern fill lights and flicker, warm windows, shop emissive
- Night sky, horizon fill, lightning bolts
- Post: ACES exposure, bloom, height fog, dither

## Credits

- City GLB: Sketchfab “Tanabata evening - Kyoto inspired city scene” (Mathias Tossens, CC-BY-4.0)
- Rain and puddle ripples follow the approach in [ektogamat/threejs-conference](https://github.com/ektogamat/threejs-conference)
- Rain / thunder: `public/audio/`
- Basis transcoder: `public/basis/`
