# The room lights itself: a PMREM probe instead of an HDRI

Date: 2026-10-03
Status: Accepted

## Context

Physically based materials need an environment map, or metal looks black and every surface misses
the first bounce of light. The usual source is an HDRI file, which `scene/` cannot use without
reintroducing a downloaded asset.

A fixed environment map would also be wrong here: the room has three lighting presets (midday,
golden hour, night) and lamps that switch on, so a baked outdoor panorama would contradict the
direct lighting whenever the preset changed.

## Decision

Render the lit room from a point near its centre into a cube map and prefilter it with
`PMREMGenerator` (`src/core/environment.ts`), then use the result as `scene.environment`.
Run it twice, feeding the first result back in, so surfaces see a second bounce. Re-probe whenever
the lighting preset changes.

## Consequences

- Reflections and ambient light come from the actual window, walls and lamps, so they stay
  consistent with the direct lighting in every preset, including with the lamps lit at night.
- Dark corners fill in without a fake ambient term.
- A preset change costs two cube renders plus prefiltering, which is visible as a brief hitch.
- The probe is a single point: objects far from the room centre get a slightly wrong environment.
  At this room size the error is not visible.
- The probe must run after the first frame, so shadow maps exist when it samples the scene.
