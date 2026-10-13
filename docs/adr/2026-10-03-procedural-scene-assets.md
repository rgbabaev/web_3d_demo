# Every asset in the 3D scene is generated in code

Date: 2026-10-03
Status: Accepted

## Context

`scene/` renders a photorealistic living room in the browser. The conventional way to get
photorealism is downloaded content: glTF furniture, 2K–4K PBR texture sets, an HDRI for lighting.
That path brings a tens-of-megabytes payload, a licence per asset, a binary blob no reviewer can
diff, and a loading screen before anything appears.

The scene is also the only place in this repository with no server, so anything it needs at runtime
has to be committed or fetched from a third party.

## Decision

Nothing is downloaded. Geometry is built from three.js primitives in `src/furniture/*.ts`;
colour, normal and roughness maps are synthesised from seeded noise in `src/core/textures.ts`;
lighting comes from the room itself rather than an HDRI (see the companion record on the room probe).

- Textures are deterministic: the same seed gives the same image, so screenshots are comparable
  between runs.
- A generator declares the physical size one repeat covers, and materials derive `repeat` from it,
  so grain and weave land at real-world scale on any surface.

## Consequences

- The built scene is a few hundred kilobytes of JavaScript with no binary assets and no licences to
  track. Everything in a diff is readable text.
- Texture generation costs roughly a second of CPU at startup, spent behind the loading panel.
- Fidelity is bounded by what noise functions can express. Scanned detail — a specific fabric, a
  real wood species, lettering on a book — is out of reach unless it is drawn with the 2D canvas
  helper.
- Any new material must be written as a generator rather than dropped in as a file.
