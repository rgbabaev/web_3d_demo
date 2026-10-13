# Furniture module guide

The room is assembled from independent modules under `src/furniture/`. Each module is one
file that exports a factory:

```ts
import * as THREE from 'three';
import type { SceneContext } from '../core/types';

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  // ...build meshes, add them to g...
  return g;
}
```

## Contract

- **Units are metres, Y is up.** Use real-world dimensions (a desk top is 0.74 m high, a seat 0.45 m,
  a 27" monitor panel is 0.61 × 0.36 m). Wrong scale is the first thing that breaks realism.
- **Origin on the floor at the centre of the footprint** (`y = 0` is the floor). The layout only
  translates and rotates the group, so `Box3.setFromObject(group).min.y` must be `0` (±1 mm) for
  floor-standing objects. Exceptions are stated in the module's brief (wall-hung, ceiling-hung,
  on-desk modules).
- **Front faces +Z at rotation 0.** A sofa's seat opens toward +Z, a monitor's screen faces +Z.
- **Every mesh casts and receives shadows** (`mesh()` from `core/geometry.ts` does it). Exceptions:
  thin glass and emissive bulbs (`cast: false`).
- **Lights are registered**, never just added:
  ```ts
  const bulb = ctx.materials.emissive(0xffd9a8, 6);
  const light = new THREE.PointLight(0xffd0a0, 14, 0, 2); // candela-ish; decay 2
  light.castShadow = true; light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.near = 0.05; light.shadow.camera.far = 8; light.shadow.bias = -0.0005; light.shadow.normalBias = 0.02;
  ctx.lights.register({ name: 'floorLamp', role: 'lamp', light, emissives: [bulb] });
  ```
  Roles: `lamp` (table/floor/desk lamps, on at golden hour and night), `ceiling` (pendant, night only),
  `screen` (monitors/TVs). Presets multiply the registered base intensity, so set the *full-power* value.
  Typical full-power values that look right in this scene: PointLight 10–20, SpotLight 15–35
  (angle 0.5–0.8, penumbra 0.4–0.7), emissive bulb 4–10.
- **Only touch your own file.** Do not edit `src/core/*`, `src/room/*`, `src/main.ts` or another module.
  If you need a helper that does not exist, write it inside your module. If you find a real bug in
  core, describe it in your report instead of fixing it.
- Deterministic randomness only: `createRng(ctx.seed + <module offset>)` from `core/noise.ts`.
  Never `Math.random()`.

## Toolkit (read these files before starting)

- `src/core/types.ts` — `SceneContext`, `ROOM` dimensions, light registry.
- `src/core/geometry.ts` — `mesh()`, `roundedBox()`, `cylinder()`, `lathe()`, `tube()`, `extrudeOutline()`,
  `enableShadows()`, `mergeGeometries` (re-exported from three's BufferGeometryUtils).
- `src/core/materials.ts` — the **only** source of materials: `wood(kind, {surface})`, `paintedWood()`,
  `metal(kind)`, `fabric(color, {boucle})`, `linen()`, `leather()`, `plastic()`, `rubber()`, `ceramic()`,
  `glass()`, `solidGlass()`, `paper()`, `concrete()`, `emissive()`, `screen()`, `custom()`.
  Pass `surface: [w, h]` (metres of the UV square) so grain/weave come out at real scale. Materials are
  cached by their arguments; call `.clone()` if you must tint one copy.
- `src/core/textures.ts` — `ctx.textures.canvas(key, w, h, draw)` for bespoke 2D content (book spines,
  labels, artwork, leaf alpha masks). Use a unique key per distinct image; ≤ 1024² and ≤ 6 per module.
- `src/core/noise.ts` — `createRng`, `fbm`, `gradientNoise`, `worley`.

## Realism checklist

1. **No razor edges.** `roundedBox(w, h, d, r)` with r = 3–8 mm for wood/plastic, 1–2 mm for metal
   plates, 15–40 mm for cushions. Cylinders get ≥ 32 segments when larger than 3 cm.
2. **Things rest on things.** Compute contact heights; no floating (> 1 mm gap) and no interpenetration
   (> 2 mm) between parts. Legs touch the floor, a mug sits on the desk top, a cushion sinks 1–2 cm into
   the seat.
3. **Material variety and hierarchy.** A real object mixes 2–4 materials (wood + steel + rubber feet,
   fabric + wood legs + brass caps). Neighbouring surfaces never share the exact same flat colour.
4. **Imperfection.** Rotate a cushion 1–3°, pull one book out 1 cm, let a cable sag, taper a leg. Use the
   seeded RNG. Still keep everything plausible — no chaos.
5. **Silhouette detail at the right scale.** Add the parts a photo would show at 1–2 m: seams and piping
   on cushions, a bezel and a stand on a monitor, casters on a chair, a switch on a lamp cable, a plug in
   a socket. Skip anything smaller than ~3 mm.
6. **Shadows and occlusion.** Everything casts/receives. Tuck small dark gaps where parts meet (a 2 mm
   recess under a drawer front) — the ambient-occlusion pass turns them into believable contact shadow.
7. **Budget.** Aim for ≤ 40 k triangles and ≤ 60 draw calls per module (bookshelf/plant: ≤ 70 k / ≤ 100).
   Merge geometries that share a material with `mergeGeometries([...])` (all need the same attributes —
   RoundedBox/Box/Cylinder all have position/normal/uv). The screenshot tool prints both numbers.

## Verify (mandatory before you report)

A module is previewable once it is listed in `src/room/layout.ts`, which is also what places it
in the room. Add the entry first, then preview.

```bash
node tools/typecheck.mjs                    # must print "typecheck: OK"
node tools/screenshot.mjs --module <name> --preset day --quality low --width 1024 --height 576
# → prints the PNG path, the module's OWN draw calls / triangles (the line marked
#   "THIS MODULE ONLY" — that is what the budget applies to; the other number covers the
#   whole preview page including the room shell), its bounding box and registered lights.
# Optional angles: --az -40 --el 10 --zoom 1.2 ; night lighting: --preset night ; hanging modules: --y 2.75
```

Then **look at the PNG** (open it with your file-reading tool) and fix what you see. Do at least one
look-fix-look cycle; realism only comes from iterating on the render. Both tools queue on a shared two-slot
semaphore (other agents are rendering too), so a run may pause for a while — that is normal, do not
abort it, and always allow at least 15 minutes.
Never run `vite build`, `npm run dev` or your own server; a dev server on :5175 is already running and
the screenshot tool finds it.
