# Living Room Study — a photorealistic browser scene

A living room with a computer work desk, rendered in real time in the browser with
[three.js](https://threejs.org). Everything in it is generated in code: the wood grain, the
linen curtains, the books on the shelf, the light coming through the window. There are no
downloaded models or textures, so the whole thing is a few hundred kilobytes of TypeScript.

## Run it

```bash
cd scene
npm install
npm run dev        # http://localhost:5175
npm run build      # static site in dist/ (serve it from any web server)
npm run preview    # serve the production build
```

Drag to orbit, scroll to zoom, right-drag to pan. The buttons at the bottom jump between
composed views; the panel at the top right switches time of day (midday / golden hour /
night), exposure, ambient occlusion and bloom. URL parameters do the same thing for deep
links and screenshots: `?view=desk&preset=night&quality=low`.

## How the realism is built

| Layer | Where | What it does |
| --- | --- | --- |
| Materials | `src/core/materials.ts` | One `MeshPhysicalMaterial` vocabulary for the whole room: oak and walnut with clearcoat, bouclé and linen with sheen, brushed steel, ceramic, glass. |
| Textures | `src/core/textures.ts` | Seeded procedural colour / normal / roughness maps (planks with bevelled seams, plaster, weave, leather grain, kilim rug, a code editor for the monitor). Real-world scale via `surface: [w, h]`. |
| Sun and sky | `src/core/lighting.ts` | A shadow-casting directional sun through the window, a sky-coloured area light in the opening, and the room's own lamps, all driven by time-of-day presets. |
| Bounce light | `src/core/environment.ts` | The lit room is rendered into a cube map and prefiltered (PMREM) twice, so reflections and ambient come from the actual window, walls and lamps — no HDRI file. |
| Post | `src/core/postfx.ts` | MSAA HDR render → ground-truth ambient occlusion → gentle bloom → ACES tone mapping. |
| Furniture | `src/furniture/*.ts` | Independent modules (desk, chair, sofa, bookshelf, plant, …) built to the contract in `docs/MODULE_GUIDE.md` and placed by `src/room/layout.ts`. |

## Verify a change visually

Headless Chromium (SwiftShader) renders the real thing:

```bash
node tools/screenshot.mjs --view overview --preset golden          # one framed view
node tools/screenshot.mjs --all --preset day                        # all four views
node tools/screenshot.mjs --module sofa --preset day                # one module alone, auto-framed
node tools/typecheck.mjs                                            # tsc --noEmit
```

Screenshots land in `shots/`. The tool uses a running dev server on :5175 when there is one
and otherwise builds first.

## Add a piece of furniture

1. Create `src/furniture/<name>.ts` exporting `create(ctx: SceneContext): THREE.Group`
   (origin on the floor, front facing +Z, metres — see `docs/MODULE_GUIDE.md`).
2. Add it to `PLACEMENTS` in `src/room/layout.ts`, which both places it in the room and makes
   it previewable by name.
3. Preview it on its own: `node tools/screenshot.mjs --module <name>`.

Screenshot flags: `--view`, `--preset`, `--all`, `--module`, `--out`, `--width`, `--height`,
`--quality low|high`, `--y` for ceiling-hung modules, and `--az` / `--el` / `--zoom` to aim the
module-preview camera.
