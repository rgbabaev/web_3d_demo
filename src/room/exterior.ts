// Unlit (MeshBasicMaterial) on purpose: the day look is baked into the canvases.
import * as THREE from 'three';
import { mergeGeometries } from '../core/geometry';
import { clamp01, createRng, lerp } from '../core/noise';
import { ROOM, type SceneContext } from '../core/types';

type C2D = CanvasRenderingContext2D;
type RGB = [number, number, number];

/** Material colour = white x this. The presets overwrite it with the same shape. */
const BRIGHT = 1.6;

const WIN_X = ROOM.window.x; // -1.2, the window centre; every layer is centred on it
const WALL_Z = -ROOM.depth / 2 - ROOM.wallThickness; // -2.5, outer face of the back wall

/** 60 x 36 keeps every corner inside the rig's 60 m far plane from in-room cameras. */
const SKY = { z: -30, w: 60, h: 36, cy: 1.6 }; // y -16.4 .. 19.6
const FAR = { z: -16, w: 44, h: 17, cy: 7.3 }; // y  -1.2 .. 15.8
const BUSH = { z: -9.0, w: 18, h: 5.5, cy: 2.5 }; // y -0.25 ..  5.25
const HEDGE = { z: -7.0, w: 15, h: 2.2, cy: 0.95 }; // y -0.15 ..  2.05
/** Two coplanar quads share one canvas: the near one gets 4x the texels per metre. */
const GROUND = { y: -0.02, near: WALL_Z, split: -7.6, far: -40, nearW: 18, farW: 44 };
const BIRCH = { x: 0.3, z: -5.1, height: 4.3 };
/** The one small tree in the shrub band; its crown dapples the lawn the window sees. */
const SHRUB_TREE = { x: -4.6, top: 4.2 };

/** Sun direction in canvas space (x right, y down): up and to the left. */
const LIGHT: [number, number] = [-0.7, -0.71];
/**
 * Ground shadow of a point at height y lands at (x + SUN_DX*y, z + SUN_DZ*y).
 * Derived from the day preset's sun: window centre + (-2.5, 5.5, -7) aimed at (0, 0, 0.2).
 */
const SUN_DX = 0.52;
const SUN_DZ = 1.32;

const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const css = (c: RGB, a = 1): string =>
  `rgba(${Math.round(clamp01(c[0]) * 255)},${Math.round(clamp01(c[1]) * 255)},${Math.round(clamp01(c[2]) * 255)},${a})`;
const jit = (rng: () => number, amount: number): number => (rng() - 0.5) * 2 * amount;

function ellipse(c: C2D, x: number, y: number, rx: number, ry: number, style: string, rot = 0): void {
  c.beginPath();
  c.ellipse(x, y, Math.max(0.35, rx), Math.max(0.35, ry), rot, 0, Math.PI * 2);
  c.fillStyle = style;
  c.fill();
}

/** Radial gradient squashed into an ellipse — the workhorse for soft masses. */
function radial(c: C2D, x: number, y: number, rx: number, ry: number, stops: Array<[number, string]>): void {
  c.save();
  c.translate(x, y);
  c.scale(Math.max(0.001, rx), Math.max(0.001, ry));
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const s of stops) g.addColorStop(s[0], s[1]);
  c.fillStyle = g;
  c.beginPath();
  c.arc(0, 0, 1, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/** Per-pixel dither: kills the banding a 100 m wide gradient would otherwise show. */
function dither(c: C2D, w: number, h: number, rng: () => number, amount: number): void {
  const img = c.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  c.putImageData(img, 0, 0);
}

/** Remap alpha so [lo, hi] becomes [0, 255]; RGB is untouched. */
function sharpenAlpha(c: C2D, ox: number, oy: number, w: number, h: number, lo: number, hi: number): void {
  const img = c.getImageData(ox, oy, w, h);
  const d = img.data;
  const k = 255 / (hi - lo);
  for (let i = 3; i < d.length; i += 4) d[i] = (d[i] - lo) * k;
  c.putImageData(img, ox, oy);
}

interface MassOpts {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  base: RGB;
  haze: RGB;
  hazeT: number;
  blobs: number;
  blobR: number;
  stipple: number;
  stippleR: number;
  contrast: number;
  halo?: number;
}

/** Near masses (low hazeT) keep their chroma, far ones wash into the haze, so the depth hierarchy runs rich up close, pale far away. */
function foliageMass(c: C2D, rng: () => number, o: MassOpts): void {
  const col = mix(o.base, o.haze, o.hazeT);
  const dark = mix(col, mix(o.base, [0.022, 0.052, 0.014], 0.82), o.contrast);
  // Back-lit leaves glow yellow-green, they do not go white.
  const lit = mix(col, [0.78, 0.84, 0.28], 0.62 - o.hazeT * 0.45);
  const rmax = Math.max(o.rx, o.ry) * 1.35;
  // Sunlight is rationed, not smeared: shading every blob by its position instead
  // floods the crown with half-light and inverts it into a pale field.
  const shade = (px: number, py: number): RGB => {
    const t = clamp01(0.5 + ((px - o.cx) * LIGHT[0] + (py - o.cy) * LIGHT[1]) / rmax);
    if (rng() < Math.pow(t, 3.5) * 0.42) return mix(col, lit, 0.22 + rng() * 0.45);
    return mix(dark, col, Math.pow(t, 1.6) * (0.25 + rng() * 0.45));
  };
  // The halo only stops the alpha edge cutting into black — keep it darker than
  // the mass, otherwise overlapping masses stack into fog.
  const halo = o.halo ?? 0.3;
  const haloCol = mix(dark, col, 0.2);
  radial(c, o.cx, o.cy, o.rx * 1.08, o.ry * 1.1, [
    [0, css(haloCol, halo)],
    [0.6, css(haloCol, halo * 0.6)],
    [1, css(haloCol, 0)],
  ]);
  // A solid core. Without it the whole mass is alpha ~0.5, the sky washes
  // straight through it, and it inverts into a pale field with dark dots.
  const body = mix(dark, col, 0.4);
  radial(c, o.cx, o.cy, o.rx, o.ry, [
    [0, css(body, 1)],
    [0.8, css(body, 1)],
    [1, css(body, 0)],
  ]);
  // Tonal structure first: a few big soft sub-masses, so the mass already has
  // light and shade before a single leaf mark goes on it.
  const rbig = Math.max(o.rx, o.ry);
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * 0.58;
    const px = o.cx + Math.cos(a) * o.rx * r;
    const py = o.cy + Math.sin(a) * o.ry * r;
    const s = shade(px, py);
    const br = rbig * (0.26 + rng() * 0.3);
    radial(c, px, py, br, br * (0.66 + rng() * 0.5), [
      [0, css(s, 0.38)],
      [0.5, css(s, 0.2)],
      [1, css(s, 0)],
    ]);
  }
  // Leaf clumps: elongated, rotated, and spread over a 6x size range. Equal
  // round marks stamp visible polka dots as soon as the layer is magnified.
  for (let i = 0; i < o.blobs; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng());
    const px = o.cx + Math.cos(a) * o.rx * r * 0.9;
    const py = o.cy + Math.sin(a) * o.ry * r * 0.9;
    const br = o.blobR * (0.32 + Math.pow(rng(), 2.2) * 2.3);
    const s = shade(px, py);
    ellipse(c, px, py, br, br * (0.38 + rng() * 0.6), css(s, 0.34 + rng() * 0.5), rng() * Math.PI);
  }
  // The rim: finer marks reaching past the core so the silhouette is leaves,
  // not the edge of an ellipse.
  for (let i = 0; i < o.stipple; i++) {
    const a = rng() * Math.PI * 2;
    const r = 0.78 + rng() * 0.36;
    const px = o.cx + Math.cos(a) * o.rx * r;
    const py = o.cy + Math.sin(a) * o.ry * r;
    const br = o.stippleR * (0.4 + Math.pow(rng(), 1.8) * 1.8);
    const s = shade(px, py);
    ellipse(c, px, py, br, br * (0.42 + rng() * 0.55), css(s, 0.42 + rng() * 0.5), rng() * Math.PI);
  }
}

function paintSky(c: C2D, w: number, h: number, rng: () => number): void {
  const horizon = 0.529; // world y = -0.02 (the lawn's vanishing line) in texture v
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.0, '#1f56ad');
  g.addColorStop(0.14, '#2c64b7');
  g.addColorStop(0.28, '#3f76c4');
  g.addColorStop(0.4, '#578cd0');
  g.addColorStop(0.465, '#79a6db');
  g.addColorStop(0.5, '#9db9d6');
  g.addColorStop(0.518, '#bcbdb7');
  g.addColorStop(horizon, '#cbc6b7');
  g.addColorStop(0.56, '#bfb9a3');
  g.addColorStop(0.72, '#aaab8e');
  g.addColorStop(1.0, '#8d9576');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);

  // Cirrus streaks high up.
  for (let i = 0; i < 26; i++) {
    const y = h * (0.04 + rng() * 0.22);
    const x = rng() * w;
    const len = w * (0.06 + rng() * 0.16);
    radial(c, x, y, len, len * (0.012 + rng() * 0.02), [
      [0, `rgba(255,255,255,${0.14 + rng() * 0.14})`],
      [0.55, 'rgba(255,255,255,0.06)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
  }

  // Cumulus: flat-bottomed, back-lit (bright rim toward the sun at upper left).
  const cloud = (cx: number, cy: number, s: number, alpha: number): void => {
    const puffs = 9 + Math.floor(rng() * 7);
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < puffs; i++) {
      const u = (i / (puffs - 1) - 0.5) * 2;
      const r = s * (0.34 + rng() * 0.5) * (1 - 0.35 * Math.abs(u));
      pts.push([cx + u * s * 1.05 + jit(rng, s * 0.12), cy - Math.pow(1 - Math.abs(u), 1.4) * s * (0.3 + rng() * 0.4), r]);
    }
    // shaded underside
    for (const [px, py, r] of pts) {
      radial(c, px, py + r * 0.5, r * 1.15, r * 0.6, [
        [0, `rgba(178,192,210,${alpha * 0.55})`],
        [0.6, `rgba(190,202,218,${alpha * 0.3})`],
        [1, 'rgba(195,207,222,0)'],
      ]);
    }
    // body — solid out to two thirds, then a quick falloff: a cumulus has an
    // edge, it is not a smudge
    for (const [px, py, r] of pts) {
      radial(c, px, py, r, r * 0.86, [
        [0, `rgba(252,253,255,${alpha})`],
        [0.62, `rgba(246,249,253,${alpha * 0.97})`],
        [0.86, `rgba(228,236,247,${alpha * 0.5})`],
        [1, 'rgba(226,234,246,0)'],
      ]);
    }
    // sun-side rim
    c.globalCompositeOperation = 'lighter';
    for (const [px, py, r] of pts) {
      radial(c, px - r * 0.34, py - r * 0.34, r * 0.72, r * 0.6, [
        [0, `rgba(255,253,244,${alpha * 0.5})`],
        [0.6, `rgba(255,252,240,${alpha * 0.16})`],
        [1, 'rgba(255,252,240,0)'],
      ]);
    }
    c.globalCompositeOperation = 'source-over';
  };

  // A few big ones up top, smaller + flatter as they approach the horizon.
  cloud(w * 0.16, h * 0.15, w * 0.1, 0.72);
  cloud(w * 0.75, h * 0.12, w * 0.11, 0.7);
  cloud(w * 0.47, h * 0.21, w * 0.068, 0.5);
  cloud(w * 0.94, h * 0.3, w * 0.06, 0.48);
  cloud(w * 0.04, h * 0.31, w * 0.07, 0.45);
  cloud(w * 0.29, h * 0.37, w * 0.05, 0.36);
  cloud(w * 0.66, h * 0.44, w * 0.04, 0.28);
  cloud(w * 0.52, h * 0.466, w * 0.038, 0.17);

  // Haze sitting on the horizon, strongest toward the sun (left).
  const hz = c.createLinearGradient(0, h * 0.44, 0, h * 0.545);
  hz.addColorStop(0, 'rgba(255,248,226,0)');
  hz.addColorStop(0.75, 'rgba(255,248,226,0.1)');
  hz.addColorStop(1, 'rgba(255,248,226,0.19)');
  const side = c.createLinearGradient(0, 0, w, 0);
  side.addColorStop(0, 'rgba(255,255,255,1)');
  side.addColorStop(0.45, 'rgba(255,255,255,0.7)');
  side.addColorStop(1, 'rgba(255,255,255,0.15)');
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = hz;
  c.fillRect(0, h * 0.44, w, h * 0.105);
  c.globalAlpha = 0.06;
  c.fillStyle = side;
  c.fillRect(0, 0, w, h * 0.56);
  c.restore();

  // Sun glow, upper left (the disc itself sits outside the window's cone).
  const sx = w * 0.401;
  const sy = h * 0.111;
  c.globalCompositeOperation = 'lighter';
  radial(c, sx, sy, w * 0.5, h * 0.7, [
    [0, 'rgba(255,248,226,0.17)'],
    [0.3, 'rgba(255,246,222,0.085)'],
    [0.65, 'rgba(255,245,220,0.025)'],
    [1, 'rgba(255,245,220,0)'],
  ]);
  radial(c, sx, sy, w * 0.13, h * 0.2, [
    [0, 'rgba(255,253,244,0.44)'],
    [0.28, 'rgba(255,251,236,0.2)'],
    [0.7, 'rgba(255,250,232,0.045)'],
    [1, 'rgba(255,250,232,0)'],
  ]);
  radial(c, sx, sy, w * 0.017, h * 0.03, [
    [0, 'rgba(255,255,252,0.9)'],
    [0.45, 'rgba(255,254,246,0.42)'],
    [1, 'rgba(255,252,238,0)'],
  ]);
  c.globalCompositeOperation = 'source-over';

  dither(c, w, h, rng, 3.5);
}

function paintFar(c: C2D, w: number, h: number, rng: () => number): void {
  const s = w / FAR.w; // px per metre (square pixels)
  const top = FAR.cy + FAR.h / 2;
  const X = (x: number): number => (x - (WIN_X - FAR.w / 2)) * s;
  const Y = (y: number): number => (top - y) * s;
  const haze: RGB = [0.70, 0.755, 0.745];

  // Aerial-perspective wash so nothing here is ever fully saturated.
  const wash = (yTop: number, yBot: number, a0: number, a1: number): void => {
    const g = c.createLinearGradient(0, Y(yTop), 0, Y(yBot));
    g.addColorStop(0, css(haze, a0));
    g.addColorStop(1, css(haze, a1));
    c.fillStyle = g;
    c.fillRect(0, Y(yTop), w, Y(yBot) - Y(yTop));
  };

  // 1. Neighbour roofs. Both sit off the window's centre line and stay under
  //    4 m so a standing viewer keeps sky and tree line above them.
  /** x of every vertical wall edge, so the understory can be bushed up over it. */
  const wallEdges: number[] = [];
  const roof = (cx: number, eaves: number, ridge: number, width: number, tint: RGB, hz: number): void => {
    wallEdges.push(cx - width * 0.42, cx + width * 0.42);
    // The wall faces us away from the sun, so it sits in its own shade.
    const wallC = mix([0.40, 0.375, 0.34], haze, hz * 0.75);
    const roofC = mix(tint, haze, hz);
    // The fill runs to the bottom of the layer, never to a bare horizontal edge:
    // the understory covers whatever of it should not be seen.
    const wallBot = -FAR.h;
    const wg = c.createLinearGradient(0, Y(eaves), 0, Y(0.6));
    wg.addColorStop(0, css(mix(wallC, [1, 0.97, 0.88], 0.16), 1));
    wg.addColorStop(1, css(mix(wallC, [0.10, 0.11, 0.10], 0.3), 1));
    c.fillStyle = wg;
    c.fillRect(X(cx - width * 0.42), Y(eaves), width * 0.84 * s, Y(wallBot) - Y(eaves));
    // render/brick mottling and the shadow the eaves overhang throws on it
    for (let i = 0; i < 90; i++) {
      const px = X(cx - width * 0.42) + rng() * width * 0.84 * s;
      const py = Y(eaves) + rng() * (Y(0.6) - Y(eaves));
      ellipse(c, px, py, s * (0.06 + rng() * 0.22), s * (0.03 + rng() * 0.08),
        css(mix(wallC, rng() < 0.5 ? [0.85, 0.83, 0.78] : [0.18, 0.17, 0.16], 0.25), 0.1 + rng() * 0.12));
    }
    const eg = c.createLinearGradient(0, Y(eaves), 0, Y(eaves - 0.55));
    eg.addColorStop(0, 'rgba(26,24,22,0.5)');
    eg.addColorStop(1, 'rgba(26,24,22,0)');
    c.fillStyle = eg;
    c.fillRect(X(cx - width * 0.42), Y(eaves), width * 0.84 * s, Y(eaves - 0.55) - Y(eaves));
    // window
    c.fillStyle = css(mix([0.20, 0.24, 0.26], haze, hz * 0.5), 1);
    c.fillRect(X(cx - 0.45), Y(eaves - 0.5), 0.9 * s, 0.9 * s);
    c.strokeStyle = css(mix(wallC, [1, 1, 0.94], 0.5), 0.9);
    c.lineWidth = Math.max(1, s * 0.05);
    c.strokeRect(X(cx - 0.45), Y(eaves - 0.5), 0.9 * s, 0.9 * s);

    // pitched roof, clipped so the tile courses stay inside the gable
    const gable = (): void => {
      c.beginPath();
      c.moveTo(X(cx - width / 2), Y(eaves));
      c.lineTo(X(cx), Y(ridge));
      c.lineTo(X(cx + width / 2), Y(eaves));
      c.closePath();
    };
    c.save();
    gable();
    c.clip();
    c.fillStyle = css(roofC, 1);
    c.fillRect(0, Y(ridge), w, Y(eaves) - Y(ridge));
    // lit left slope
    c.fillStyle = css(mix(roofC, [1, 0.98, 0.88], 0.2), 1);
    c.fillRect(0, Y(ridge), X(cx), Y(eaves) - Y(ridge));
    // tile courses: a 10 % tone step every 0.3 m down the slope
    for (let y = eaves; y < ridge; y += 0.3) {
      const k = Math.round((y - eaves) / 0.3);
      c.fillStyle = css(mix(roofC, k % 2 ? [0.07, 0.06, 0.05] : [1, 0.96, 0.88], 0.1), 0.6);
      c.fillRect(0, Y(y + 0.3), w, Y(y) - Y(y + 0.3));
      c.fillStyle = 'rgba(32,26,22,0.16)';
      c.fillRect(0, Y(y) - Math.max(1, s * 0.03), w, Math.max(1, s * 0.03));
    }
    // vertical tile joints
    for (let x = cx - width / 2; x < cx + width / 2; x += 0.24) {
      c.fillStyle = 'rgba(34,27,22,0.1)';
      c.fillRect(X(x), Y(ridge), Math.max(1, s * 0.025), Y(eaves) - Y(ridge));
    }
    // weathering: moss along the courses and a few faded patches
    for (let i = 0; i < 150; i++) {
      const px = X(cx) + jit(rng, width * 0.5 * s);
      const py = Y(eaves) + rng() * (Y(ridge) - Y(eaves));
      const moss = rng() < 0.45;
      ellipse(c, px, py, s * (0.1 + rng() * 0.45), s * (0.04 + rng() * 0.1),
        css(mix(roofC, moss ? [0.34, 0.40, 0.20] : [0.80, 0.76, 0.70], 0.4 + rng() * 0.4), 0.12 + rng() * 0.22));
    }
    // chimney shadow falling right and down the slope
    const chX = cx + width * 0.22;
    c.fillStyle = 'rgba(26,20,16,0.33)';
    c.beginPath();
    c.moveTo(X(chX + 0.55), Y(ridge + 0.6));
    c.lineTo(X(chX + 1.7), Y(ridge - 0.1));
    c.lineTo(X(chX + 1.7), Y(ridge - 0.65));
    c.lineTo(X(chX + 0.55), Y(eaves + 0.2));
    c.closePath();
    c.fill();
    c.restore();

    // ridge + eaves lines
    c.strokeStyle = css(mix(roofC, [1, 1, 0.95], 0.55), 0.9);
    c.lineWidth = Math.max(1, s * 0.06);
    c.beginPath();
    c.moveTo(X(cx - width / 2), Y(eaves));
    c.lineTo(X(cx), Y(ridge));
    c.stroke();
    c.strokeStyle = css(mix(roofC, [0.1, 0.1, 0.1], 0.35), 0.5);
    c.beginPath();
    c.moveTo(X(cx - width / 2 - 0.15), Y(eaves));
    c.lineTo(X(cx + width / 2 + 0.15), Y(eaves));
    c.stroke();

    // chimney: lit left face, shaded right face, darker cap
    const chX2 = cx + width * 0.22;
    const chTop = ridge + 0.75;
    const cg = c.createLinearGradient(X(chX2), 0, X(chX2 + 0.55), 0);
    cg.addColorStop(0, css(mix([0.72, 0.62, 0.54], haze, hz), 1));
    cg.addColorStop(0.55, css(mix([0.54, 0.45, 0.39], haze, hz), 1));
    cg.addColorStop(1, css(mix([0.34, 0.28, 0.25], haze, hz), 1));
    c.fillStyle = cg;
    c.fillRect(X(chX2), Y(chTop), 0.55 * s, (chTop - eaves + 0.4) * s);
    for (let y = eaves; y < chTop; y += 0.21) {
      c.fillStyle = 'rgba(38,28,24,0.22)';
      c.fillRect(X(chX2), Y(y), 0.55 * s, Math.max(1, s * 0.022));
    }
    c.fillStyle = css(mix([0.30, 0.26, 0.23], haze, hz * 0.8), 1);
    c.fillRect(X(chX2 - 0.08), Y(chTop + 0.15), 0.71 * s, 0.15 * s);
  };
  roof(7.4, 2.9, 3.9, 5.2, [0.48, 0.33, 0.27], 0.30);
  roof(-11.8, 2.8, 3.8, 5.0, [0.40, 0.38, 0.37], 0.34);

  // 2. The tree line itself. Low and open in the middle (that is the slice a
  //    standing viewer sees), tall groups flanking it.
  interface Tree { x: number; top: number; spread: number; hz: number; conifer?: boolean }
  // Tops stay under ~5 m across the middle (x -7 .. +6): that is the slice a
  // standing viewer sees, and it has to keep sky above it.
  const trees: Tree[] = [
    { x: -22.0, top: 8.6, spread: 3.4, hz: 0.38 },
    { x: -19.4, top: 7.2, spread: 2.8, hz: 0.37 },
    { x: -17.2, top: 9.0, spread: 1.5, hz: 0.36, conifer: true },
    { x: -15.0, top: 6.6, spread: 3.0, hz: 0.35 },
    { x: -12.4, top: 6.1, spread: 3.2, hz: 0.34 },
    { x: -9.6, top: 5.2, spread: 2.6, hz: 0.32 },
    { x: -7.3, top: 4.3, spread: 2.2, hz: 0.31 },
    { x: -5.2, top: 3.5, spread: 1.9, hz: 0.30 },
    { x: -3.4, top: 3.9, spread: 1.7, hz: 0.29 },
    { x: -1.5, top: 3.2, spread: 1.5, hz: 0.28 },
    { x: 2.6, top: 3.4, spread: 1.6, hz: 0.27 },
    { x: 4.3, top: 4.4, spread: 2.1, hz: 0.27 },
    // break up the right-hand roof so it never reads as a flat cut-out
    { x: 6.2, top: 4.0, spread: 1.8, hz: 0.28 },
    { x: 9.4, top: 6.2, spread: 3.1, hz: 0.29 },
    { x: 12.2, top: 6.4, spread: 2.8, hz: 0.31 },
    { x: 15.0, top: 9.2, spread: 3.4, hz: 0.33 },
    { x: 18.4, top: 7.6, spread: 3.0, hz: 0.36 },
    { x: 21.0, top: 8.4, spread: 3.2, hz: 0.38 },
  ];
  // Lighter and less saturated than the z = -9 shrub band: 7 m more air in front.
  const greens: RGB[] = [
    [0.34, 0.49, 0.20],
    [0.40, 0.55, 0.23],
    [0.29, 0.44, 0.19],
    [0.45, 0.58, 0.22],
  ];
  for (const t of trees) {
    const base = greens[Math.floor(rng() * greens.length)];
    const crownH = t.conifer ? t.top * 0.78 : t.top * 0.56;
    const cy = t.top - crownH / 2;
    const trunkTop = t.top - crownH * (t.conifer ? 0.95 : 1.05);
    // trunk
    if (!t.conifer && trunkTop > 0.8) {
      const tw = Math.max(1.2, t.spread * 0.075 * s);
      c.fillStyle = css(mix([0.33, 0.28, 0.24], haze, t.hz + 0.12), 0.95);
      c.fillRect(X(t.x) - tw / 2, Y(trunkTop + 0.4), tw, Y(0.4) - Y(trunkTop + 0.4));
    }
    if (t.conifer) {
      // stacked, narrowing tiers
      const tiers = 7;
      for (let i = 0; i < tiers; i++) {
        const f = i / (tiers - 1);
        foliageMass(c, rng, {
          cx: X(t.x) + jit(rng, s * 0.1),
          cy: Y(t.top - crownH * f * 0.95),
          rx: t.spread * s * (0.3 + f * 0.7) * 0.5,
          ry: crownH * s * 0.12,
          base: mix(base, [0.26, 0.38, 0.28], 0.5), haze, hazeT: t.hz,
          blobs: 22, blobR: s * 0.11, stipple: 14, stippleR: s * 0.07,
          contrast: 0.34,
        });
      }
    } else {
      const lobes = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < lobes; i++) {
        const a = (i / lobes) * Math.PI * 2 + rng();
        foliageMass(c, rng, {
          cx: X(t.x) + Math.cos(a) * t.spread * s * 0.22,
          cy: Y(cy) + Math.sin(a) * crownH * s * 0.18,
          rx: t.spread * s * (0.34 + rng() * 0.16),
          ry: crownH * s * (0.3 + rng() * 0.14),
          base, haze, hazeT: t.hz,
          blobs: 150, blobR: s * 0.1, stipple: 110, stippleR: s * 0.055,
          contrast: 0.6, halo: 0.18,
        });
      }
    }
  }

  // 3. Continuous understory in front of it all: the neighbours' own hedges,
  //    shrubs and fences closing the bottom of the view off.
  const under: RGB = [0.30, 0.45, 0.17];
  /** Crown height at x: wavy, and raised wherever a wall meets it so no straight edge survives. */
  const underTop = (x: number): number => {
    let t = 2.05 + Math.sin(x * 0.63 + 0.4) * 0.34 + Math.sin(x * 1.9 + 1.3) * 0.2 + Math.sin(x * 4.7) * 0.09;
    for (const e of wallEdges) t += 1.2 * Math.exp(-Math.pow((x - e) / 0.9, 2));
    return t;
  };
  c.fillStyle = css(mix(under, haze, 0.3), 1);
  c.beginPath();
  c.moveTo(X(-24), Y(underTop(-24)));
  for (let x = -24; x <= 22; x += 0.2) c.lineTo(X(x), Y(underTop(x)));
  c.lineTo(w, h);
  c.lineTo(0, h);
  c.closePath();
  c.fill();
  for (let x = -24; x < 22; x += 0.42) {
    const top2 = underTop(x) + jit(rng, 0.2);
    foliageMass(c, rng, {
      cx: X(x), cy: Y(top2 - 0.78), rx: s * 0.62, ry: s * 0.78,
      base: under, haze, hazeT: 0.3, blobs: 46, blobR: s * 0.072,
      stipple: 34, stippleR: s * 0.044, contrast: 0.52, halo: 0.22,
    });
  }

  // 4. Haze pooling low down + a last wash over everything far away.
  wash(2.8, -1.2, 0, 0.17);
  wash(16, 8, 0.14, 0.02);
}

/**
 * One 240 px cell of the birch leaf atlas, painted opaque then holed: marks that
 * are merely semi-transparent leave alpha ~0.5 and the crown goes milky blue.
 */
function leafCell(c: C2D, rng: () => number, ox: number, oy: number, cell: number): void {
  const cx = ox + cell / 2;
  const cy = oy + cell / 2;
  /** Nothing is drawn past this, leaving ~19 px of empty cell on every side. */
  const R = cell * 0.37;
  const base: RGB = [0.125, 0.268, 0.058];
  const deep: RGB = [0.026, 0.070, 0.016];
  const sunCol: RGB = [0.70, 0.80, 0.26];
  /** 1 where the leaf faces the sun (upper left), 0 in the mass's own shade. */
  const sun = (px: number, py: number): number =>
    clamp01(0.5 - ((px - cx) * 0.70 + (py - cy) * 0.71) / (R * 1.6));

  c.save();
  c.beginPath();
  c.rect(ox + 2, oy + 2, cell - 4, cell - 4);
  c.clip();

  // 1. Body: overlapping opaque lobes. Their soft last fifth is the only
  //    partial alpha in the cell, and it is narrow enough that the alpha test
  //    lands on it instead of on a wide translucent veil.
  const lobes: Array<[number, number, number]> = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rng() * 0.7;
    const d = Math.pow(rng(), 0.55) * R * 0.46;
    lobes.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.92, R * (0.33 + rng() * 0.21)]);
  }
  for (const [px, py, r] of lobes) {
    const t = sun(px, py);
    const col = mix(mix(deep, base, 0.4 + t * 0.45), sunCol, Math.pow(t, 2.6) * 0.34);
    radial(c, px, py, r, r * 0.9, [
      [0, css(col, 1)],
      [0.74, css(col, 1)],
      [1, css(col, 0)],
    ]);
  }

  // 2. Twigs, back-lit so they silhouette dark. Kept inside the body: a twig
  //    over open sky is a hairline scratch at this texel density.
  for (let i = 0; i < 11; i++) {
    const [lx, ly, lr] = lobes[Math.floor(rng() * lobes.length)];
    c.strokeStyle = css([0.20, 0.17, 0.13], 0.8);
    c.lineWidth = 1.2 + rng() * 1.6;
    c.beginPath();
    c.moveTo(cx + jit(rng, R * 0.1), cy + R * 0.5);
    c.quadraticCurveTo(cx + jit(rng, R * 0.3), cy + R * 0.1, lx + jit(rng, lr * 0.5), ly + jit(rng, lr * 0.5));
    c.stroke();
  }

  // 3. Leaves, opaque: a shaded pass then a sun pass. Sizes vary 4x so the
  //    silhouette breaks instead of reading as even confetti.
  const leaf = (lit: boolean, count: number): void => {
    for (let i = 0; i < count; i++) {
      const [lx, ly, lr] = lobes[Math.floor(rng() * lobes.length)];
      const a = rng() * Math.PI * 2;
      const d = Math.pow(rng(), 0.6) * lr * 1.1;
      const px = lx + Math.cos(a) * d;
      const py = ly + Math.sin(a) * d * 0.92;
      if (Math.hypot(px - cx, py - cy) > R * 1.03) continue;
      const t = sun(px, py);
      if (lit && rng() > 0.06 + Math.pow(t, 1.5) * 1.05) continue;
      if (!lit && rng() < t * 0.4) continue;
      const col = lit
        ? mix(mix(base, sunCol, 0.2 + Math.pow(t, 1.5) * 0.42), [0.84, 0.88, 0.48], Math.pow(t, 3) * 0.3)
        : mix(deep, base, rng() * (0.3 + t * 0.55));
      const er = 1.6 + Math.pow(rng(), 0.5) * 4.0;
      ellipse(c, px, py, er, er * (0.52 + rng() * 0.4), css(col, 0.8 + rng() * 0.2), rng() * Math.PI);
    }
  };
  leaf(false, 1300);
  leaf(true, 900);

  // 4. The dark between the leaf sprays is shadow, not sky — paint it, do not
  //    cut it. Cutting it is what turns the crown into a blue veil.
  for (let i = 0; i < 220; i++) {
    const a = rng() * Math.PI * 2;
    const d = Math.pow(rng(), 0.6) * R * 0.95;
    const hr = R * (0.03 + rng() * 0.09);
    radial(c, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.95, hr, hr * (0.55 + rng() * 0.7), [
      [0, css(deep, 0.5)],
      [0.55, css(deep, 0.28)],
      [1, css(deep, 0)],
    ]);
  }

  // 5. Real sky holes: a handful inside, then a ragged rim.
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 230; i++) {
    const a = rng() * Math.PI * 2;
    const d = Math.pow(rng(), 0.35) * R * 1.05;
    const edge = clamp01(d / R);
    if (rng() > 0.09 + Math.pow(edge, 2.6) * 0.95) continue;
    const hr = R * (0.025 + rng() * 0.065) * (1 + edge * 0.9);
    radial(c, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.95, hr, hr * (0.5 + rng() * 0.9), [
      [0, 'rgba(0,0,0,1)'],
      [0.6, 'rgba(0,0,0,0.95)'],
      [1, 'rgba(0,0,0,0)'],
    ]);
  }
  c.globalCompositeOperation = 'source-over';

  // 6. Leaves put back over the bitten rim so the crown ends in leaves, not in
  //    a scalloped curve.
  for (let i = 0; i < 260; i++) {
    const a = rng() * Math.PI * 2;
    const d = R * (0.8 + rng() * 0.2);
    const px = cx + Math.cos(a) * d;
    const py = cy + Math.sin(a) * d * 0.95;
    const t = sun(px, py);
    const er = 1.8 + rng() * 2.8;
    ellipse(c, px, py, er, er * 0.62, css(mix(mix(deep, base, 0.5), sunCol, Math.pow(t, 1.8) * 0.6), 0.95), rng() * Math.PI);
  }
  c.restore();
}

function paintFoliage(c: C2D, w: number, h: number, bushRows: number, rng: () => number): void {
  const haze: RGB = [0.72, 0.78, 0.73];

  // Upper region: the shrub / small-tree band.
  const s = w / BUSH.w;
  const top = BUSH.cy + BUSH.h / 2;
  const X = (x: number): number => (x - (WIN_X - BUSH.w / 2)) * s;
  const Y = (y: number): number => (top - y) * s;
  c.save();
  c.beginPath();
  c.rect(0, 0, w, bushRows);
  c.clip();
  interface Shrub { x: number; top: number; spread: number; base: RGB; hz: number }
  // Deeper, more saturated greens than the z = -16 line: this band is 7 m closer.
  // Crowns stay low across x -5 .. +4.5, the slice the window frames, so sky and
  // tree line survive above them; SHRUB_TREE is the exception that dapples the lawn.
  const shrubs: Shrub[] = [
    { x: -9.8, top: 3.35, spread: 2.4, base: [0.150, 0.305, 0.065], hz: 0.17 },
    { x: -8.0, top: 3.70, spread: 2.2, base: [0.185, 0.350, 0.075], hz: 0.16 },
    { x: -6.3, top: 2.60, spread: 1.9, base: [0.220, 0.390, 0.085], hz: 0.15 },
    { x: SHRUB_TREE.x, top: SHRUB_TREE.top, spread: 2.6, base: [0.165, 0.325, 0.070], hz: 0.14 },
    { x: -3.0, top: 2.10, spread: 1.8, base: [0.195, 0.360, 0.090], hz: 0.12 },
    { x: -1.2, top: 2.25, spread: 2.0, base: [0.160, 0.320, 0.070], hz: 0.11 },
    { x: 0.7, top: 2.00, spread: 1.8, base: [0.235, 0.405, 0.085], hz: 0.10 },
    { x: 2.5, top: 2.35, spread: 2.0, base: [0.140, 0.295, 0.065], hz: 0.11 },
    { x: 4.4, top: 2.80, spread: 2.1, base: [0.190, 0.355, 0.080], hz: 0.13 },
    { x: 6.2, top: 3.45, spread: 2.2, base: [0.155, 0.315, 0.070], hz: 0.15 },
  ];
  for (const b of shrubs) {
    // a soft stem/shadow core so the bases read as solid, with no straight edge
    const stem = mix(mix(b.base, [0.05, 0.11, 0.03], 0.55), haze, b.hz);
    radial(c, X(b.x), Y(b.top * 0.3), b.spread * s * 0.34, b.top * s * 0.45, [
      [0, css(stem, 1)],
      [0.7, css(stem, 0.88)],
      [1, css(stem, 0)],
    ]);
    const lobes = 4;
    for (let i = 0; i < lobes; i++) {
      const f = i / (lobes - 1);
      foliageMass(c, rng, {
        cx: X(b.x) + jit(rng, b.spread * s * 0.22),
        cy: Y(b.top * (0.42 + 0.5 * f)) + jit(rng, s * 0.1),
        rx: b.spread * s * (0.36 + rng() * 0.14) * (1 - 0.2 * f),
        ry: b.top * s * (0.19 + rng() * 0.08),
        base: b.base, haze, hazeT: b.hz,
        blobs: 170, blobR: s * 0.062, stipple: 120, stippleR: s * 0.032,
        contrast: 0.88, halo: 0.22,
      });
    }
  }
  // dry stems / grasses filling the gaps at the base
  for (let i = 0; i < 320; i++) {
    const x = -10.2 + rng() * 18;
    const hgt = 0.35 + rng() * 0.8;
    const col = mix(mix([0.44, 0.50, 0.16], [0.68, 0.68, 0.26], rng()), haze, 0.14);
    c.strokeStyle = css(col, 0.55 + rng() * 0.4);
    c.lineWidth = Math.max(0.8, s * 0.012);
    c.beginPath();
    c.moveTo(X(x), Y(0));
    c.quadraticCurveTo(X(x + jit(rng, 0.1)), Y(hgt * 0.6), X(x + jit(rng, 0.22)), Y(hgt));
    c.stroke();
  }
  c.restore();

  // Lower region: 4 birch leaf cells + the bark strip.
  const cell = 240;
  for (let k = 0; k < 4; k++) leafCell(c, rng, k * cell, bushRows, cell);
  // Squeeze what is left of the alpha ramp. These cards depth-write so they
  // sort by depth, and a pixel that passes the alpha test at 0.6 blocks the
  // cards behind it while still showing 40 % sky — which is the blue veil.
  sharpenAlpha(c, 0, bushRows, 4 * cell, cell, 100, 185);

  const bx0 = 960;
  const bw = 64;
  const y0 = bushRows;
  const bh = h - y0;
  // Bark peaks at 0.68, not at white: at the exterior's x1.6 brightness anything
  // above ~0.72 blows out and the trunk loses every bit of its modelling.
  const bg = c.createLinearGradient(bx0, 0, bx0 + bw, 0);
  bg.addColorStop(0.0, '#6d6a63');
  bg.addColorStop(0.12, '#bcb8ae');
  bg.addColorStop(0.34, '#d2cec4');
  bg.addColorStop(0.62, '#bdb9af');
  bg.addColorStop(0.85, '#8b857c');
  bg.addColorStop(1.0, '#5a5750');
  c.fillStyle = bg;
  c.fillRect(bx0, y0, bw, bh);
  // Rough dark bark at the foot, where a birch loses its white papery skin.
  const rough = c.createLinearGradient(0, y0 + bh * 0.88, 0, y0 + bh);
  rough.addColorStop(0, 'rgba(58,53,46,0)');
  rough.addColorStop(0.55, 'rgba(52,47,41,0.34)');
  rough.addColorStop(1, 'rgba(40,36,31,0.62)');
  c.fillStyle = rough;
  c.fillRect(bx0, y0 + bh * 0.88, bw, bh * 0.12);
  for (let i = 0; i < 55; i++) {
    const py = y0 + bh * (0.89 + rng() * 0.11);
    const fl = bh * (0.008 + rng() * 0.022);
    c.strokeStyle = css(rng() < 0.5 ? [0.10, 0.09, 0.08] : [0.40, 0.37, 0.33], 0.3 + rng() * 0.45);
    c.lineWidth = 1 + rng() * 1.6;
    c.beginPath();
    c.moveTo(bx0 + rng() * bw, py);
    c.lineTo(bx0 + rng() * bw, py + fl);
    c.stroke();
  }
  // grey-green weathering low down, warm peel higher up
  for (let i = 0; i < 90; i++) {
    const py = y0 + rng() * bh;
    const f = (py - y0) / bh; // 0 top of trunk, 1 bottom
    const col: RGB = f > 0.6 ? [0.42, 0.42, 0.37] : mix([0.86, 0.83, 0.76], [0.74, 0.66, 0.55], rng());
    ellipse(c, bx0 + rng() * bw, py, bw * (0.1 + rng() * 0.3), 1.2 + rng() * 2.6, css(col, 0.18 + rng() * 0.3));
  }
  // Lenticels: the horizontal dashes that make birch read as birch. The quad
  // flares 2x at the foot, so a wide dash down there stretches into a sticker.
  for (let i = 0; i < 260; i++) {
    const py = y0 + rng() * bh;
    const f = (py - y0) / bh; // 0 top of trunk, 1 bottom
    const lw = bw * (0.04 + rng() * 0.16) * (1 - 0.45 * rng()) * (1 - f * 0.5);
    const px = bx0 + rng() * (bw - lw);
    const dark: RGB = f > 0.7 ? [0.13, 0.12, 0.10] : [0.22, 0.20, 0.17];
    c.fillStyle = css(dark, 0.3 + rng() * 0.45);
    c.fillRect(px, py, lw, 1 + Math.round(rng() * 0.8));
  }
  // a couple of dark knots / branch scars
  for (let i = 0; i < 4; i++) {
    const py = y0 + bh * (0.1 + rng() * 0.55);
    const px = bx0 + bw * (0.25 + rng() * 0.5);
    ellipse(c, px, py, bw * 0.1, 2.0 + rng() * 1.6, css([0.14, 0.13, 0.11], 0.7));
    ellipse(c, px, py - 2, bw * 0.13, 1.8, css([0.58, 0.56, 0.51], 0.4));
  }
  // shaded right edge so the flat quad still reads as round
  const edge = c.createLinearGradient(bx0, 0, bx0 + bw, 0);
  edge.addColorStop(0, 'rgba(60,58,54,0.45)');
  edge.addColorStop(0.16, 'rgba(60,58,54,0)');
  edge.addColorStop(0.78, 'rgba(48,45,40,0)');
  edge.addColorStop(1, 'rgba(38,36,32,0.5)');
  c.fillStyle = edge;
  c.fillRect(bx0, y0, bw, bh);
  // the root flare sits in grass: darken the last few centimetres of bark
  const footG = c.createLinearGradient(0, h - bh * 0.075, 0, h);
  footG.addColorStop(0, 'rgba(26,30,20,0)');
  footG.addColorStop(1, 'rgba(20,26,15,0.72)');
  c.fillStyle = footG;
  c.fillRect(bx0, h - bh * 0.075, bw, bh * 0.075);
}

function paintHedge(c: C2D, w: number, h: number, rng: () => number): void {
  const s = w / HEDGE.w; // px per metre
  const top = HEDGE.cy + HEDGE.h / 2;
  const X = (x: number): number => (x - (WIN_X - HEDGE.w / 2)) * s;
  const Y = (y: number): number => (top - y) * s;
  const x0 = WIN_X - HEDGE.w / 2;
  const x1 = WIN_X + HEDGE.w / 2;
  // The hedge is the nearest layer and the sun is behind it, so the face turned
  // to the house sits in its own shade: it must be the deepest green in the
  // frame, not the brightest, or the depth cue runs backwards.
  const base: RGB = [0.112, 0.248, 0.052];
  const litC: RGB = [0.50, 0.63, 0.18];
  const darkC: RGB = [0.042, 0.150, 0.028];

  const crest = (x: number): number =>
    1.36 + Math.sin(x * 0.31 + 0.6) * 0.15 + Math.sin(x * 0.9) * 0.09 + Math.sin(x * 2.4 + 2.1) * 0.045 + Math.sin(x * 5.1) * 0.022;
  // Stays above the lawn (y = -0.02) so the scallops read against grass instead
  // of being clipped by the ground plane into a dead-straight line.
  const foot = (x: number): number =>
    0.065 + Math.sin(x * 1.3 + 0.9) * 0.05 + Math.sin(x * 3.1 + 2.4) * 0.035 + Math.sin(x * 0.47) * 0.04;

  c.save();
  c.beginPath();
  c.moveTo(X(x0), Y(crest(x0)));
  for (let x = x0; x <= x1; x += 0.06) c.lineTo(X(x), Y(crest(x)));
  for (let x = x1; x >= x0; x -= 0.06) c.lineTo(X(x), Y(foot(x)));
  c.closePath();
  c.clip();

  const bodyG = c.createLinearGradient(0, Y(1.45), 0, Y(-0.05));
  bodyG.addColorStop(0, css(mix(base, litC, 0.12), 1));
  bodyG.addColorStop(0.22, css(mix(base, darkC, 0.1), 1));
  bodyG.addColorStop(0.55, css(mix(base, darkC, 0.34), 1));
  bodyG.addColorStop(1, css(mix(base, darkC, 0.62), 1));
  c.fillStyle = bodyG;
  c.fillRect(0, 0, w, h);

  // Lobes: the 0.3-0.6 m bulges a clipped hedge grows between trims. Without
  // them the body gradient alone reads as a painted fence panel.
  for (let lx = x0 - 0.3; lx <= x1 + 0.3; lx += 0.3 + rng() * 0.22) {
    const ct = crest(lx);
    const fb = foot(lx);
    for (let k = 0; k < 3; k++) {
      const ly = fb + 0.08 + rng() * Math.max(0.1, ct - fb - 0.1);
      const r = (0.17 + rng() * 0.15) * s;
      const t = clamp01((ly - fb) / Math.max(0.3, ct - fb));
      const mid = mix(mix(base, darkC, 0.3 * (1 - t)), litC, t * t * 0.34);
      const px = X(lx) + jit(rng, s * 0.08);
      const py = Y(ly);
      radial(c, px, py, r, r * 0.82, [
        [0, css(mid, 0.62)],
        [0.66, css(mid, 0.33)],
        [1, css(mid, 0)],
      ]);
      radial(c, px + r * 0.3, py + r * 0.34, r * 0.78, r * 0.58, [
        [0, css(mix(base, darkC, 0.85), 0.58)],
        [0.55, css(mix(base, darkC, 0.85), 0.3)],
        [1, css(mix(base, darkC, 0.85), 0)],
      ]);
      radial(c, px - r * 0.3, py - r * 0.32, r * 0.62, r * 0.5, [
        [0, css(mix(mid, litC, 0.45 + t * 0.35), 0.5 + t * 0.22)],
        [0.6, css(mix(mid, litC, 0.4), 0.22)],
        [1, css(litC, 0)],
      ]);
    }
  }

  // Creases between the individual plants: wavy, and they die out ~0.5 m below
  // the crest — a trimmed hedge knits together at the top.
  for (let x = x0 + 0.6; x < x1; x += 1.5 + rng() * 0.9) {
    const ct = crest(x);
    const tp = ct - 0.45 - rng() * 0.22;
    const fb = foot(x);
    const cg = c.createLinearGradient(0, Y(tp), 0, Y(fb));
    cg.addColorStop(0, 'rgba(10,30,7,0)');
    cg.addColorStop(0.45, 'rgba(10,30,7,0.14)');
    cg.addColorStop(1, 'rgba(8,24,6,0.24)');
    c.strokeStyle = cg;
    c.lineWidth = s * 0.045;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(X(x), Y(tp));
    c.bezierCurveTo(
      X(x + jit(rng, 0.16)), Y(lerp(tp, fb, 0.35)),
      X(x + jit(rng, 0.2)), Y(lerp(tp, fb, 0.7)),
      X(x + jit(rng, 0.24)), Y(fb),
    );
    c.stroke();
  }

  // Leaf clumps: 4-7 px across, wide alpha spread, so they survive mip filtering.
  for (let x = x0 - 0.1; x <= x1 + 0.1; x += 0.022) {
    const ct = crest(x);
    const fb = foot(x);
    for (let i = 0; i < 5; i++) {
      const y = fb + rng() * Math.max(0.1, ct - fb);
      const depth = clamp01((y - fb) / Math.max(0.25, ct - fb));
      const sun = clamp01(Math.pow(depth, 2.4) * 1.15 + rng() * 0.4 - 0.22);
      const vary = 0.58 + Math.pow(rng(), 0.9) * 0.78;
      const body = mix(base, darkC, 0.55 * (1 - depth));
      const col = mix([body[0] * vary, body[1] * vary, body[2] * vary], litC, Math.pow(sun, 2.4) * 0.52);
      // mostly 2-3 px leaf tufts with the odd 6 px clump: an even size reads as bobbles
      const r = s * (0.032 + Math.pow(rng(), 1.9) * 0.062);
      ellipse(c, X(x) + jit(rng, s * 0.05), Y(y), r, r * (0.5 + rng() * 0.6),
        css(col, 0.08 + Math.pow(rng(), 1.6) * 0.62), rng() * 3);
    }
  }
  // fine leaf grain between the clumps
  for (let i = 0; i < 11000; i++) {
    const x = x0 - 0.1 + rng() * (x1 - x0 + 0.2);
    const ct = crest(x);
    const fb = foot(x);
    const y = fb + rng() * Math.max(0.1, ct - fb);
    const depth = clamp01((y - fb) / Math.max(0.25, ct - fb));
    const vary = 0.58 + Math.pow(rng(), 0.85) * 0.82;
    const body = mix(base, darkC, 0.55 * (1 - depth));
    const col = mix([body[0] * vary, body[1] * vary, body[2] * vary], litC, Math.pow(depth, 3.2) * 0.38);
    const r = s * (0.016 + rng() * 0.016);
    ellipse(c, X(x), Y(y), r, r * (0.55 + rng() * 0.55), css(col, 0.2 + rng() * 0.5), rng() * 3);
  }
  c.restore();

  // Sun-lit crest + broken new growth poking out of the clipped top.
  for (let x = x0 - 0.1; x <= x1 + 0.1; x += 0.028) {
    const ct = crest(x);
    const r = s * (0.022 + rng() * 0.03);
    const bright = 0.16 + Math.pow(rng(), 1.9) * 0.52;
    const col = mix(base, litC, bright);
    ellipse(c, X(x) + jit(rng, s * 0.06), Y(ct - 0.03) + jit(rng, s * 0.03), r, r * (0.55 + rng() * 0.5),
      css(col, 0.3 + Math.pow(rng(), 1.4) * 0.5), rng() * 3);
    if (rng() < 0.055) {
      const sh = 0.06 + rng() * 0.18;
      c.strokeStyle = css(mix(col, [0.85, 0.88, 0.5], 0.3), 0.75);
      c.lineWidth = Math.max(0.9, s * 0.012);
      c.beginPath();
      c.moveTo(X(x), Y(ct - 0.05));
      c.lineTo(X(x + jit(rng, 0.06)), Y(ct + sh));
      c.stroke();
      const lr = s * 0.02;
      for (let i = 0; i < 4; i++) {
        ellipse(c, X(x + jit(rng, 0.05)), Y(ct + sh * (0.15 + rng() * 0.9)), lr * 1.5, lr * 0.9,
          css(mix(col, [0.8, 0.85, 0.45], 0.35), 0.7), rng());
      }
    }
  }

  // Grass at the hedge foot, in clumps. It starts at the lawn surface so the
  // ground plane never cuts it, and stays dark: the sun is behind the hedge.
  const tuft = (x: number): number =>
    0.5 + 0.34 * Math.sin(x * 0.52 + 1.1) + 0.2 * Math.sin(x * 1.37 + 0.3) + 0.12 * Math.sin(x * 3.3 + 2.2);
  for (let cx = x0; cx < x1; cx += 0.05 + rng() * 0.22) {
    const f = clamp01(tuft(cx));
    if (rng() > 0.2 + f * 0.9) continue;
    const spread = 0.05 + rng() * 0.16;
    const tall = (0.045 + Math.pow(rng(), 2.2) * 0.26) * (0.5 + f * 0.9);
    for (let i = 0; i < 6 + Math.floor(rng() * 22); i++) {
      const x = cx + jit(rng, spread);
      const hgt = tall * (0.45 + Math.pow(rng(), 0.7) * 0.75);
      c.strokeStyle = css(mix([0.055, 0.135, 0.028], [0.30, 0.42, 0.10], Math.pow(rng(), 1.4) * (0.35 + hgt * 2.2)),
        0.3 + rng() * 0.5);
      c.lineWidth = Math.max(0.8, s * (0.008 + rng() * 0.008));
      c.beginPath();
      c.moveTo(X(x), Y(-0.04));
      c.quadraticCurveTo(X(x + jit(rng, 0.03)), Y(hgt * 0.55), X(x + jit(rng, 0.09)), Y(hgt));
      c.stroke();
    }
  }
}

function paintGround(c: C2D, w: number, h: number, rng: () => number): void {
  const half = h / 2;
  const grass: RGB = [0.260, 0.490, 0.118];

  // Near band, canvas rows 0..512: x WIN_X +/- 9, z -7.6 .. -2.5.
  const nsx = w / GROUND.nearW; // ~57 px/m
  const nsz = half / (GROUND.near - GROUND.split); // ~100 px/m
  const X = (x: number): number => (x - (WIN_X - GROUND.nearW / 2)) * nsx;
  const Z = (z: number): number => (z - GROUND.split) * nsz;

  c.save();
  c.beginPath();
  c.rect(0, 0, w, half);
  c.clip();
  c.fillStyle = css(grass, 1);
  c.fillRect(0, 0, w, half);

  // Broad tonal patches.
  for (let i = 0; i < 70; i++) {
    const r = 24 + rng() * 150;
    const col = mix(grass, rng() < 0.5 ? [0.42, 0.68, 0.14] : [0.15, 0.34, 0.05], 0.3 + rng() * 0.5);
    radial(c, rng() * w, rng() * half, r, r * 0.6, [
      [0, css(col, 0.22)],
      [1, css(col, 0)],
    ]);
  }
  // Mowing stripes parallel to the house.
  for (let z = GROUND.near; z > GROUND.split; z -= 0.9) {
    const lightBand = Math.floor((GROUND.near - z) / 0.9) % 2 === 0;
    c.fillStyle = lightBand ? 'rgba(236,255,150,0.17)' : 'rgba(10,46,4,0.2)';
    c.fillRect(0, Z(z) - 0.9 * nsz, w, 0.9 * nsz);
  }
  // Blade texture — at 57 px/m a 2 px mark is a 3 cm tuft.
  for (let i = 0; i < 38000; i++) {
    const px = rng() * w;
    const py = rng() * half;
    const col = mix(
      mix(grass, [0.44, 0.69, 0.16], rng() * 0.9),
      [0.05, 0.19, 0.03],
      rng() < 0.42 ? 0.45 + rng() * 0.45 : 0,
    );
    c.fillStyle = css(col, 0.22 + rng() * 0.52);
    c.fillRect(px, py, 1, 1 + Math.round(rng() * 2.4));
  }
  // Clover patches and daisies out on the lawn the window actually sees.
  for (let i = 0; i < 30; i++) {
    const r = 10 + rng() * 34;
    radial(c, rng() * w, Z(-6.9 + rng() * 2.6), r, r * 0.55, [
      [0, css([0.34, 0.58, 0.14], 0.45)],
      [1, css([0.34, 0.58, 0.14], 0)],
    ]);
  }

  // Paved terrace along the house + a gravel edge.
  const tz0 = GROUND.near;
  const tz1 = -4.15;
  const stone: RGB = [0.375, 0.358, 0.318];
  c.fillStyle = css(mix(stone, [0.17, 0.16, 0.14], 0.6), 1);
  c.fillRect(0, Z(tz1), w, Z(tz0) - Z(tz1));
  const slab = 0.58;
  for (let z = tz1; z < tz0 - 0.001; z += slab) {
    const row = Math.round((z - tz1) / slab);
    for (let x = -11 + (row % 2) * slab * 0.5; x < 8; x += slab) {
      // One batch of stone: +/-15 % of tone and a touch of warm/cool. A wider
      // spread than that reads as a random light/dark checkerboard.
      const t = 1 + jit(rng, 0.14);
      const warm = jit(rng, 0.012);
      const col: RGB = [stone[0] * t + warm, stone[1] * t, stone[2] * t - warm * 0.7];
      // Joint widths wander by a millimetre or two; a ruled grid of identical
      // dark lines is the thing that reads as a tiled floor rather than paving.
      const px = X(x) + 0.8 + rng() * 1.4;
      const py = Z(z) + 1.0 + rng() * 1.6;
      const pw = slab * nsx - 1.6 - rng() * 1.8;
      const ph = slab * nsz - 2.0 - rng() * 2.2;
      c.fillStyle = css(col, 1);
      c.fillRect(px, py, pw, ph);
      c.save();
      c.beginPath();
      c.rect(px, py, pw, ph);
      c.clip();
      // cloudy grain, then the grit speckle that stops it reading as one flat fill
      for (let k = 0; k < 4; k++) {
        const r = pw * (0.22 + rng() * 0.45);
        radial(c, px + rng() * pw, py + rng() * ph, r, r * 0.85, [
          [0, css(mix(col, rng() < 0.5 ? [0.68, 0.65, 0.58] : [0.26, 0.25, 0.22], 0.4), 0.2)],
          [1, css(col, 0)],
        ]);
      }
      for (let k = 0; k < 260; k++) {
        c.fillStyle = css(mix(col, rng() < 0.5 ? [0.74, 0.71, 0.64] : [0.17, 0.16, 0.14], 0.25 + rng() * 0.55), 0.1 + rng() * 0.38);
        c.fillRect(px + rng() * pw, py + rng() * ph, 1, 1 + Math.round(rng() * 0.6));
      }
      // sawn-edge chipping and a few weathering stains
      for (let k = 0; k < 9; k++) {
        const ex = rng() < 0.5 ? px + rng() * pw : (rng() < 0.5 ? px : px + pw);
        const ey = ex === px || ex === px + pw ? py + rng() * ph : (rng() < 0.5 ? py : py + ph);
        ellipse(c, ex, ey, 0.8 + rng() * 2.2, 0.8 + rng() * 1.6,
          css(mix(col, rng() < 0.5 ? [0.72, 0.70, 0.64] : [0.20, 0.19, 0.17], 0.5), 0.3 + rng() * 0.4));
      }
      if (rng() < 0.3) {
        radial(c, X(x + slab * 0.5), Z(z + slab * 0.5), slab * nsx * 0.4, slab * nsz * 0.4, [
          [0, css([0.32, 0.38, 0.22], 0.3)],
          [1, css([0.32, 0.38, 0.22], 0)],
        ]);
      }
      c.restore();
      // Chamfered arrises: the sun is up, left and beyond the garden, so the
      // -x and -z edges catch it and the facing two drop into the joint.
      c.fillStyle = css(mix(col, [0.80, 0.78, 0.72], 0.4), 0.5);
      c.fillRect(px, py, pw, 1.4);
      c.fillRect(px, py, 1.2, ph);
      c.fillStyle = css(mix(col, [0.14, 0.13, 0.12], 0.58), 0.5);
      c.fillRect(px, py + ph - 2, pw, 2);
      c.fillRect(px + pw - 1.6, py, 1.6, ph);
    }
  }
  // gravel strip between terrace and lawn
  c.fillStyle = css(mix(stone, [0.33, 0.30, 0.26], 0.5), 1);
  c.fillRect(0, Z(tz1 - 0.3), w, Z(tz1) - Z(tz1 - 0.3));
  for (let i = 0; i < 1400; i++) {
    const py = Z(tz1 - 0.3) + rng() * (Z(tz1) - Z(tz1 - 0.3));
    c.fillStyle = css(mix([0.60, 0.57, 0.50], [0.24, 0.22, 0.19], rng()), 0.75);
    c.fillRect(rng() * w, py, 1.8, 1.6);
  }
  // ragged grass creeping over the gravel edge
  for (let i = 0; i < 700; i++) {
    c.fillStyle = css(mix(grass, [0.52, 0.66, 0.18], rng()), 0.6);
    c.fillRect(rng() * w, Z(tz1 - 0.34) + rng() * 6, 1.2, 1.8 + rng() * 2.4);
  }

  // Tufts and fallen birch leaves on the strip of lawn the window sees. These go
  // down before the shadows so the shadows darken them too.
  for (let i = 0; i < 4200; i++) {
    const z = -7.3 + rng() * 3.4;
    const x = -11 + rng() * 19;
    const col = mix(mix(grass, [0.56, 0.70, 0.18], rng()), [0.06, 0.16, 0.03], rng() < 0.45 ? 0.5 : 0);
    c.fillStyle = css(col, 0.3 + rng() * 0.5);
    c.fillRect(X(x), Z(z), 1.2, 1.8 + rng() * 2.8);
  }
  for (let i = 0; i < 38; i++) {
    const z = BIRCH.z - 1.3 + rng() * 2.2;
    const x = BIRCH.x - 1.7 + rng() * 3.4;
    ellipse(c, X(x), Z(z), 1.5 + rng() * 1.1, 1.0 + rng() * 0.7,
      css(mix([0.60, 0.52, 0.20], [0.44, 0.34, 0.13], rng()), 0.6), rng() * 3);
  }

  // Cast shadows. The day sun is ~36 deg up and beyond the garden, so everything
  // throws back toward the house and rakes right: a 1.36 m hedge reaches 1.8 m,
  // the 4.2 m tree in the shrub band 5.5 m.
  const crest = (x: number): number =>
    1.36 + Math.sin(x * 0.31 + 0.6) * 0.15 + Math.sin(x * 0.9) * 0.09 + Math.sin(x * 2.4 + 2.1) * 0.045;
  const hedgeEdge = (x: number): number => HEDGE.z + SUN_DZ * crest(x - SUN_DX * 1.36);
  // Eight stacked fills: the overlap ramps the penumbra over the last 0.45 m.
  for (let k = 0; k < 8; k++) {
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(w, 0);
    for (let px = w; px >= -8; px -= 6) {
      const wx = WIN_X - GROUND.nearW / 2 + (px / w) * GROUND.nearW;
      c.lineTo(px, Z(hedgeEdge(wx) - (k / 8) * 0.45));
    }
    c.closePath();
    c.fillStyle = 'rgba(10,30,11,0.165)';
    c.fill();
  }
  // Contact shadow hugging the foot. Without it the lawn is lighter than the
  // hedge base and their meeting line reads as a ruled edge.
  const contact = c.createLinearGradient(0, Z(HEDGE.z), 0, Z(HEDGE.z + 1.0));
  contact.addColorStop(0, 'rgba(7,22,8,0.62)');
  contact.addColorStop(0.45, 'rgba(8,24,9,0.3)');
  contact.addColorStop(1, 'rgba(9,26,10,0)');
  c.fillStyle = contact;
  c.fillRect(0, 0, w, Z(HEDGE.z + 1.0));
  // light leaking through the thin base of the hedge, right along the penumbra
  for (let i = 0; i < 520; i++) {
    const x = -11 + rng() * 19;
    const z = hedgeEdge(x) - 0.8 + rng() * 1.0;
    const r = 4 + rng() * 16;
    radial(c, X(x), Z(z), r, r * 0.45, [
      [0, rng() < 0.6 ? 'rgba(206,228,146,0.3)' : 'rgba(18,44,14,0.3)'],
      [1, 'rgba(110,146,70,0)'],
    ]);
  }

  // The small tree in the shrub band drops its dappled pool across exactly the
  // strip of lawn the window frames.
  for (let i = 0; i < 170; i++) {
    const cy = 1.5 + rng() * 2.7; // height within the crown
    const sx = SHRUB_TREE.x + jit(rng, 1.5);
    const r = (0.2 + rng() * 0.44) * nsx;
    radial(c, X(sx + SUN_DX * cy), Z(BUSH.z + SUN_DZ * cy), r, r * (0.5 + rng() * 0.28), [
      [0, 'rgba(14,38,13,0.34)'],
      [0.55, 'rgba(16,42,15,0.2)'],
      [1, 'rgba(20,50,18,0)'],
    ]);
  }
  // sun flecks punched back through it so it reads as gaps between leaves
  for (let i = 0; i < 80; i++) {
    const cy = 1.7 + rng() * 2.3;
    const sx = SHRUB_TREE.x + jit(rng, 1.3);
    const r = (0.07 + rng() * 0.17) * nsx;
    radial(c, X(sx + SUN_DX * cy), Z(BUSH.z + SUN_DZ * cy), r, r * 0.55, [
      [0, 'rgba(228,246,168,0.32)'],
      [1, 'rgba(228,246,168,0)'],
    ]);
  }

  // Birch: the trunk's own shadow raking over lawn and terrace, plus the
  // darkened grass collar where the root flare sits in it.
  c.save();
  c.lineCap = 'round';
  for (let k = 0; k < 5; k++) {
    c.strokeStyle = `rgba(15,40,13,${0.17 - k * 0.012})`;
    c.lineWidth = (0.16 + k * 0.08) * nsx;
    c.beginPath();
    c.moveTo(X(BIRCH.x), Z(BIRCH.z));
    c.lineTo(X(BIRCH.x + SUN_DX * BIRCH.height * 0.46), Z(BIRCH.z + SUN_DZ * BIRCH.height * 0.46));
    c.stroke();
  }
  c.restore();
  radial(c, X(BIRCH.x), Z(BIRCH.z), 0.36 * nsx, 0.36 * nsz, [
    [0, 'rgba(12,34,8,0.8)'],
    [0.55, 'rgba(18,46,14,0.44)'],
    [1, 'rgba(26,60,20,0)'],
  ]);
  c.restore();

  // Far band, canvas rows 512..1024: x WIN_X +/- 22, z -40 .. -2.5. It runs the
  // whole depth so that outside the near quad's 18 m there is still ground, not a
  // hole; hidden behind the hedge, it only has to carry tone.
  const fsz = half / (GROUND.near - GROUND.far);
  const FZ = (z: number): number => half + (z - GROUND.far) * fsz;

  c.save();
  c.beginPath();
  c.rect(0, half, w, half);
  c.clip();
  // Base tone matches the near quad's so the two never show a step.
  c.fillStyle = css(mix(grass, [0.33, 0.52, 0.15], 0.18), 1);
  c.fillRect(0, half, w, half);
  for (let i = 0; i < 70; i++) {
    const r = 20 + rng() * 130;
    const col = mix(grass, rng() < 0.5 ? [0.48, 0.62, 0.18] : [0.17, 0.30, 0.07], 0.3 + rng() * 0.5);
    radial(c, rng() * w, half + rng() * half, r, r * 0.55, [
      [0, css(col, 0.32)],
      [1, css(col, 0)],
    ]);
  }
  for (let z = GROUND.near; z > GROUND.far; z -= 0.9) {
    const lightBand = Math.floor((GROUND.near - z) / 0.9) % 2 === 0;
    c.fillStyle = lightBand ? 'rgba(255,255,210,0.09)' : 'rgba(14,32,6,0.1)';
    c.fillRect(0, FZ(z) - 0.9 * fsz, w, 0.9 * fsz);
  }
  for (let i = 0; i < 9000; i++) {
    c.fillStyle = css(mix(grass, [0.56, 0.68, 0.19], rng()), 0.2 + rng() * 0.4);
    c.fillRect(rng() * w, half + rng() * half, 1, 1);
  }
  // The terrace continues past the near quad's 18 m, plainly, so it cannot stop
  // dead in an oblique view.
  c.fillStyle = css(mix(stone, [0.22, 0.21, 0.19], 0.5), 1);
  c.fillRect(0, FZ(tz1), w, FZ(tz0) - FZ(tz1));
  for (let z = tz1; z < tz0 - 0.001; z += slab) {
    for (let x = -22; x < 20; x += slab) {
      c.fillStyle = css([stone[0] * (1 + jit(rng, 0.14)), stone[1] * (1 + jit(rng, 0.14)), stone[2] * (1 + jit(rng, 0.14))], 1);
      c.fillRect((x - (WIN_X - GROUND.farW / 2)) * (w / GROUND.farW) + 0.7, FZ(z) + 0.7, slab * (w / GROUND.farW) - 1.4, slab * fsz - 1.4);
    }
  }
  c.fillStyle = css(mix(stone, [0.33, 0.30, 0.26], 0.5), 1);
  c.fillRect(0, FZ(tz1 - 0.3), w, FZ(tz1) - FZ(tz1 - 0.3));
  // Aerial perspective: the far end of the lawn washes out into the haze.
  const farG = c.createLinearGradient(0, half, 0, half + half * 0.8);
  farG.addColorStop(0, 'rgba(212,222,202,0.62)');
  farG.addColorStop(0.4, 'rgba(204,216,196,0.26)');
  farG.addColorStop(1, 'rgba(198,212,190,0)');
  c.fillStyle = farG;
  c.fillRect(0, half, w, half * 0.8);
  c.restore();
}

function remapUV(geo: THREE.BufferGeometry, u0: number, v0: number, u1: number, v1: number): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, lerp(u0, u1, uv.getX(i)), lerp(v0, v1, uv.getY(i)));
  uv.needsUpdate = true;
  return geo;
}

function layer(
  material: THREE.MeshBasicMaterial,
  w: number,
  h: number,
  pos: [number, number, number],
  renderOrder: number,
  name: string,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  m.position.set(...pos);
  m.renderOrder = renderOrder;
  m.castShadow = false;
  m.receiveShadow = false;
  m.name = name;
  return m;
}

/** Tapered, slightly bent trunk quad with a root flare in the last 30 cm. */
function trunkQuad(height: number, halfBottom: number, halfTop: number, bend: number, segments = 14): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, height, 1, segments);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let j = 0; j <= segments; j++) {
    const t = j / segments; // 0 at the top row, 1 at the base
    const hw = lerp(halfTop, halfBottom, t) * (1 + 1.1 * Math.pow(t, 14));
    const dx = Math.sin((1 - t) * 2.2) * bend;
    for (let i = 0; i <= 1; i++) pos.setX(j * 2 + i, (i === 0 ? -hw : hw) + dx);
  }
  pos.needsUpdate = true;
  g.translate(0, height / 2, 0);
  return g;
}

export function createExterior(ctx: SceneContext): { group: THREE.Group; materials: THREE.MeshBasicMaterial[] } {
  const group = new THREE.Group();
  group.name = 'exterior';
  const materials: THREE.MeshBasicMaterial[] = [];
  const colour = new THREE.Color(BRIGHT, BRIGHT, BRIGHT);

  const basic = (map: THREE.Texture, opts: { transparent?: boolean; side?: THREE.Side; alphaTest?: number; depthWrite?: boolean } = {}): THREE.MeshBasicMaterial => {
    const m = new THREE.MeshBasicMaterial({
      map,
      color: colour.clone(),
      toneMapped: true,
      transparent: opts.transparent ?? false,
      depthWrite: opts.depthWrite ?? !(opts.transparent ?? false),
      alphaTest: opts.alphaTest ?? 0,
      side: opts.side ?? THREE.FrontSide,
    });
    materials.push(m);
    return m;
  };

  // Five canvases, all <= 1024 px.
  const skyTex = ctx.textures.canvas('exterior.sky', 1024, 576, (c, w, h) => paintSky(c, w, h, createRng(ctx.seed + 9101)));
  const farTex = ctx.textures.canvas('exterior.far', 1024, 396, (c, w, h) => paintFar(c, w, h, createRng(ctx.seed + 9102)));
  const folTex = ctx.textures.canvas('exterior.foliage', 1024, 512, (c, w, h) => paintFoliage(c, w, h, 272, createRng(ctx.seed + 9103)));
  const hedgeTex = ctx.textures.canvas('exterior.hedge', 1024, 150, (c, w, h) => paintHedge(c, w, h, createRng(ctx.seed + 9104)));
  const groundTex = ctx.textures.canvas('exterior.ground', 1024, 1024, (c, w, h) => paintGround(c, w, h, createRng(ctx.seed + 9105)));

  const skyMat = basic(skyTex);
  const farMat = basic(farTex, { transparent: true });
  const folMat = basic(folTex, { transparent: true, side: THREE.DoubleSide });
  // The birch's cards overlap, so they have to sort by depth: depth write does it.
  // The alpha test has to bite high — a card that writes depth at 10 % opacity
  // blocks what is behind it while adding no colour, which fringes the crown blue.
  const birchMat = basic(folTex, { transparent: true, depthWrite: true, alphaTest: 0.5, side: THREE.DoubleSide });
  const hedgeMat = basic(hedgeTex, { transparent: true });
  const groundMat = basic(groundTex);

  // Negative render orders: the window pane (transparent, renderOrder 0) must
  // composite OVER the whole backdrop, not under half of it.
  group.add(layer(skyMat, SKY.w, SKY.h, [WIN_X, SKY.cy, SKY.z], -5, 'exteriorSky'));

  const nearD = GROUND.near - GROUND.split;
  const nearGround = layer(groundMat, GROUND.nearW, nearD, [WIN_X, GROUND.y, (GROUND.near + GROUND.split) / 2], -5, 'exteriorLawnNear');
  nearGround.rotation.x = -Math.PI / 2;
  remapUV(nearGround.geometry, 0, 0.5, 1, 1);
  group.add(nearGround);

  const farD = GROUND.near - GROUND.far;
  const farGround = layer(groundMat, GROUND.farW, farD, [WIN_X, GROUND.y - 0.002, (GROUND.near + GROUND.far) / 2], -5, 'exteriorLawnFar');
  farGround.rotation.x = -Math.PI / 2;
  remapUV(farGround.geometry, 0, 0, 1, 0.5);
  group.add(farGround);

  group.add(layer(farMat, FAR.w, FAR.h, [WIN_X, FAR.cy, FAR.z], -4, 'exteriorTreeLine'));

  const bushMesh = layer(folMat, BUSH.w, BUSH.h, [WIN_X, BUSH.cy, BUSH.z], -3, 'exteriorShrubs');
  remapUV(bushMesh.geometry, 0, 1 - 272 / 512, 1, 1);
  group.add(bushMesh);

  group.add(layer(hedgeMat, HEDGE.w, HEDGE.h, [WIN_X, HEDGE.cy, HEDGE.z], -2, 'exteriorHedge'));

  const rng = createRng(ctx.seed + 9106);
  const parts: THREE.BufferGeometry[] = [];
  const place = (g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, rz = 0): void => {
    g.rotateZ(rz);
    g.rotateY(ry);
    g.translate(x, y, z);
    parts.push(g);
  };
  const U = (px: number): number => px / 1024;
  const V = (py: number): number => 1 - py / 512;

  // The last 15 cm are buried: a trunk that stops exactly at y = 0 shows a
  // straight cut with grass visible underneath from any camera above the lawn.
  const trunk = trunkQuad(BIRCH.height + 0.15, 0.071, 0.021, 0.05);
  remapUV(trunk, U(960), V(512), U(1024), V(272));
  place(trunk, BIRCH.x, -0.15, BIRCH.z, 0, -0.022);

  // No separate branch cards: at this distance a painted branch is a sub-pixel
  // hairline, and each cluster carries its own. Neighbours overlap by about a
  // third so the crown reads as one airy mass, not pom-poms on a pole.
  const clusters: Array<[number, number, number, number]> = [
    // [x offset, y, z offset, size]
    [-0.60, 2.30, 0.20, 1.02],
    [0.58, 2.44, -0.22, 0.96],
    [-0.28, 2.72, -0.30, 1.18],
    [0.84, 2.86, 0.16, 1.08],
    [-0.94, 2.98, -0.08, 1.10],
    [0.16, 3.06, 0.30, 1.34],
    [-0.54, 3.30, 0.24, 1.26],
    [0.74, 3.36, -0.26, 1.20],
    [-1.00, 3.54, 0.06, 1.06],
    [0.12, 3.60, -0.18, 1.38],
    [0.90, 3.78, 0.22, 1.02],
    [-0.66, 3.88, -0.24, 1.20],
    [0.40, 4.06, 0.10, 1.16],
    [-0.22, 4.26, -0.14, 1.14],
    [0.58, 4.40, -0.20, 0.92],
    [-0.50, 4.54, 0.16, 0.86],
    [0.06, 4.72, 0.02, 0.90],
  ];
  /** Four cells, mirrored at random: 8 apparent clusters out of one atlas row. */
  const cellUV = (q: THREE.BufferGeometry, cell: number): void => {
    const u0 = U(cell * 240);
    const u1 = U(cell * 240 + 240);
    if (rng() < 0.5) remapUV(q, u1, V(512), u0, V(272));
    else remapUV(q, u0, V(512), u1, V(272));
  };
  clusters.forEach(([dx, y, dz, size], i) => {
    const q = new THREE.PlaneGeometry(size, size * (0.82 + rng() * 0.3));
    cellUV(q, i % 4);
    place(q, BIRCH.x + dx, y, BIRCH.z + dz, jit(rng, 0.7), jit(rng, 0.35));
    // a second, cross-facing card for parallax
    const q2 = new THREE.PlaneGeometry(size * 0.86, size * 0.8);
    cellUV(q2, (i + 1) % 4);
    place(q2, BIRCH.x + dx + jit(rng, 0.12), y + jit(rng, 0.1), BIRCH.z + dz - 0.18, 0.7 + jit(rng, 0.4), jit(rng, 0.4));
  });

  const birch = new THREE.Mesh(mergeGeometries(parts, false), birchMat);
  birch.name = 'exteriorBirch';
  birch.renderOrder = -1;
  group.add(birch);

  for (const o of group.children) {
    o.castShadow = false;
    o.receiveShadow = false;
  }

  return { group, materials };
}
