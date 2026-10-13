import * as THREE from 'three';
import { box, cylinder, lathe, mergeGeometries, mesh, roundedBox } from '../core/geometry';
import { clamp01, createRng, fbm, lerp, worley } from '../core/noise';
import type { SceneContext } from '../core/types';

const TABLE_W = 1.1;
const TABLE_D = 0.6;
const TABLE_H = 0.4;
const TOP_T = 0.03; // top slab
const SHELF_T = 0.018; // lower shelf
const SHELF_Y = 0.14; // underside of the shelf above the floor
const LEG = 0.025; // square tube section
const LEG_INSET = 0.06; // leg centre from the top's edge
const FOOT_H = 0.012; // rubber glide, tapering in toward the floor
const RAIL_H = 0.02; // steel apron under the top
const BAR_H = 0.008; // flat bars carrying the shelf

const LEG_X = TABLE_W / 2 - LEG_INSET; // 0.49
const LEG_Z = TABLE_D / 2 - LEG_INSET; // 0.24
const TOP_Y = TABLE_H; // top surface
const LEG_TOP = TABLE_H - TOP_T; // 0.37, underside of the top
const SHELF_TOP = SHELF_Y + SHELF_T; // 0.158
const INNER_X = 2 * LEG_X - LEG; // 0.955 clear span between legs along x
const INNER_Z = 2 * LEG_Z - LEG; // 0.455 clear span along z
const SHELF_D = 2 * LEG_Z + LEG; // 0.505, shelf reaches the bars' outer faces

// The slabs get their own map: the shared wood() grain is finer than its texel pitch and ribs a 1.1 m top.
const WOOD_TEX = 1024;
const BOARD_W = 1.5; // metres one cell covers along the grain (u)
const BOARD_D = 0.75; // ... and across it (v)
const RING_PITCH = 0.021;

interface Board {
  /** 0 = upper half of the canvas, 1 = lower half. */
  row: 0 | 1;
  /** Where the slab's corner sits inside the 1.5 × 0.75 m board, in metres. */
  ox: number;
  oy: number;
}

let woodBuffers: { color: Uint8ClampedArray; rough: Uint8ClampedArray } | null = null;

/** Paint both walnut cells once; the colour and roughness canvases share the pass. */
function walnutBuffers(): { color: Uint8ClampedArray; rough: Uint8ClampedArray } {
  if (woodBuffers) return woodBuffers;
  const S = WOOD_TEX;
  const half = S / 2;
  const color = new Uint8ClampedArray(S * S * 4);
  const rough = new Uint8ClampedArray(S * S * 4);
  const LIGHT = [0.508, 0.356, 0.223]; // #825a39 sapwood-side figure
  const DARK = [0.247, 0.159, 0.095]; // #3f2818 heartwood
  const RING = [0.176, 0.114, 0.063]; // #2d1d10 latewood line
  const pithOff = new Float32Array(S);
  const pithY = new Float32Array(S);
  for (let row = 0; row < 2; row++) {
    const seed = row === 0 ? 137 : 613;
    for (let px = 0; px < S; px++) {
      const x = (px / S) * BOARD_W;
      pithOff[px] = 0.028 + 0.05 * (0.5 + 0.5 * Math.sin(x * 2.1 + seed * 0.013))
        + 0.016 * Math.sin(x * 4.7 + seed * 0.031)
        + 0.018 * fbm(x * 1.3, 0.5, 2, seed);
      pithY[px] = BOARD_D * 0.52 + 0.07 * Math.sin(x * 1.25 + seed * 0.07);
    }
    for (let py = 0; py < half; py++) {
      const y = (py / half) * BOARD_D;
      for (let px = 0; px < S; px++) {
        const x = (px / S) * BOARD_W;
        const dy = y - pithY[px];
        const t = pithOff[px];
        let r = Math.sqrt(dy * dy + t * t);
        // ±11 mm of wander over half a metre; dead-straight parallel rings read
        // as reeding when the camera sights down the length of the table.
        r += 0.011 * fbm(x * 2.4, y * 3, 3, seed + 3);
        // 21 mm, chirped, close to a pure sinusoid: a 10 mm pitch projects to
        // about two pixels on a top seen at 12° and beats against the grid.
        const phase = r / RING_PITCH + 0.7 * fbm(r * 9, x * 0.8, 2, seed + 19);
        const ring = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
        const ringT = ring * (0.7 + 0.3 * ring);
        const streak = fbm(x * 2.2, y * 14, 3, seed + 7) * 0.5 + 0.5;
        const tone = fbm(x * 0.8, y * 1.15, 2, seed + 11) * 0.5 + 0.5;
        const f = clamp01(0.08 + 0.46 * streak + 0.32 * tone + 0.09 * ringT);
        const rt = ringT * 0.19;
        const i = ((row * half + py) * S + px) * 4;
        color[i] = lerp(lerp(LIGHT[0], DARK[0], f), RING[0], rt) * 255;
        color[i + 1] = lerp(lerp(LIGHT[1], DARK[1], f), RING[1], rt) * 255;
        color[i + 2] = lerp(lerp(LIGHT[2], DARK[2], f), RING[2], rt) * 255;
        color[i + 3] = 255;
        // Matte oil, and the swing stays inside 0.61–0.69: anything glossier
        // mirrors the window straight back and bleaches the whole top.
        const rv = clamp01(0.65 + 0.04 * ringT + 0.035 * (streak - 0.5) + 0.03 * (tone - 0.5)) * 255;
        rough[i] = rv;
        rough[i + 1] = rv;
        rough[i + 2] = rv;
        rough[i + 3] = 255;
      }
    }
  }
  // Box-blur across the grain, cell by cell, so nothing on the board carries
  // energy at a scale the mip chain cannot resolve honestly.
  for (let row = 0; row < 2; row++) {
    blurAcrossGrain(color, S, row * half, half);
    blurAcrossGrain(rough, S, row * half, half);
  }
  woodBuffers = { color, rough };
  return woodBuffers;
}

/** 3-texel box blur down the columns of one cell (rows [y0, y0+h)). */
function blurAcrossGrain(buf: Uint8ClampedArray, S: number, y0: number, h: number): void {
  const src = buf.slice(y0 * S * 4, (y0 + h) * S * 4);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(h - 1, y + 1);
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      const a = (ym * S + x) * 4;
      const b = (yp * S + x) * 4;
      for (let c = 0; c < 3; c++) buf[y0 * S * 4 + o + c] = (src[a + c] + src[o + c] + src[b + c]) / 3;
    }
  }
}

function blitWalnut(which: 'color' | 'rough'): (c: CanvasRenderingContext2D, w: number, h: number) => void {
  return (c, w, h) => {
    const img = c.createImageData(w, h);
    img.data.set(walnutBuffers()[which]);
    c.putImageData(img, 0, 0);
  };
}

// A 60 mm ball is ~40 px at 2 m, so only broad blotches and 8-9 bands survive; three rows in v = three woods.
const BALL_TEX = 512;
const BALL_BANDS = [
  { base: '#6b4626', dark: '#2a1809', light: '#a97b46' }, // walnut
  { base: '#b99a6c', dark: '#78552c', light: '#e8d2a8' }, // oak
  { base: '#54381f', dark: '#1f1206', light: '#8d6238' }, // dark walnut
] as const;

const hexA = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');

function drawBalls(c: CanvasRenderingContext2D, W: number, H: number): void {
  const rng = createRng(7731);
  const bandH = H / BALL_BANDS.length;
  BALL_BANDS.forEach((band, i) => {
    const y0 = i * bandH;
    c.save();
    c.beginPath();
    c.rect(0, y0, W, bandH);
    c.clip();
    c.fillStyle = band.base;
    c.fillRect(0, y0, W, bandH);
    // Three blotches a third of the ball wide — the only figure big enough to
    // survive minification.
    for (let k = 0; k < 3; k++) {
      const col = k === 1 ? band.light : band.dark;
      const gx = (k + 0.25 + rng() * 0.5) * (W / 3);
      const gy = y0 + bandH * (0.25 + rng() * 0.5);
      const gr = W * (0.22 + rng() * 0.16);
      const blob = c.createRadialGradient(gx, gy, 0, gx, gy, gr);
      blob.addColorStop(0, col + hexA(0.45 + rng() * 0.2));
      blob.addColorStop(1, col + '00');
      c.fillStyle = blob;
      c.fillRect(0, y0, W, bandH);
    }
    const stripe = (x: number, w: number, col: string, a: number, wave: number, freq: number, phase: number): void => {
      const g = c.createLinearGradient(-w, 0, w, 0);
      g.addColorStop(0, col + '00');
      g.addColorStop(0.5, col + hexA(a));
      g.addColorStop(1, col + '00');
      c.fillStyle = g;
      for (const off of [-W, 0, W]) {
        for (let y = y0 - 4; y < y0 + bandH + 4; y += 5) {
          const dx = wave * Math.sin((y - y0) * freq + phase);
          c.save();
          c.translate(x + off + dx, 0);
          c.fillRect(-w, y, 2 * w, 6);
          c.restore();
        }
      }
    };
    const n = 8 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k++) {
      const x = (k + 0.2 + rng() * 0.6) * (W / n);
      const w = (W / n) * (0.13 + rng() * 0.09); // ~a quarter of the band, full width
      const dark = rng() < 0.55;
      stripe(x, w, dark ? band.dark : band.light, dark ? 0.75 + rng() * 0.2 : 0.6 + rng() * 0.2,
        3 + rng() * 7, 0.01 + rng() * 0.02, rng() * 6.3);
    }
    for (let k = 0; k < 20; k++) {
      stripe(rng() * W, 1 + rng() * 1.5, rng() < 0.7 ? band.dark : band.light, 0.18 + rng() * 0.18,
        2 + rng() * 5, 0.02 + rng() * 0.03, rng() * 6.3);
    }
    c.restore();
  });
  for (let i = 0; i < 6000; i++) {
    c.fillStyle = `rgba(30,18,8,${0.03 + rng() * 0.06})`;
    c.fillRect(rng() * W, rng() * H, 1, 1);
  }
}

/** Map a sphere's native UVs onto one of the three bands (canvas row `i`). */
function ballUv(geo: THREE.BufferGeometry, i: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const pad = 2 / BALL_TEX;
  const v0 = 1 - (i + 1) / BALL_BANDS.length + pad;
  const v1 = 1 - i / BALL_BANDS.length - pad;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k), v0 + uv.getY(k) * (v1 - v0));
  uv.needsUpdate = true;
}

/** Tiling roughness grain, 0.78–1.0, for the bowl's glaze and the turned balls. */
function drawSpeckle(c: CanvasRenderingContext2D, W: number, H: number): void {
  const img = c.createImageData(W, H);
  const P = 12; // worley cells per tile, and the tiling period
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / W) * P;
      const v = (y / H) * P;
      const g = clamp01(0.80 + 0.16 * worley(u, v, 311, P).f1 + 0.05 * fbm(u * 0.5, v * 0.5, 2, 313, P * 0.5)) * 255;
      const i = (y * W + x) * 4;
      img.data[i] = g;
      img.data[i + 1] = g;
      img.data[i + 2] = g;
      img.data[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
}

// Four magazine covers and the book jacket share one canvas, so every printed surface is one texture.
const ATLAS = 1024;
interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}
const CELLS = {
  magA: { x: 0, y: 0, w: 384, h: 512 },
  magB: { x: 384, y: 0, w: 384, h: 512 },
  label: { x: 768, y: 0, w: 256, h: 380 },
  magC: { x: 0, y: 512, w: 384, h: 512 },
  magD: { x: 384, y: 512, w: 384, h: 512 },
} as const satisfies Record<string, Cell>;

const SERIF = '"Liberation Serif", "FreeSerif", "DejaVu Serif", Georgia, serif';
const SANS = '"Liberation Sans", "FreeSans", "DejaVu Sans", Helvetica, Arial, sans-serif';

/** Letter-spaced text, drawn glyph by glyph (no reliance on canvas letterSpacing support). */
function spaced(c: CanvasRenderingContext2D, s: string, x: number, y: number, spacing: number, align: 'left' | 'center' | 'right' = 'left'): void {
  c.textAlign = 'left';
  const widths = Array.from(s).map((ch) => c.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (s.length - 1);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  Array.from(s).forEach((ch, i) => {
    c.fillText(ch, cx, y);
    cx += widths[i] + spacing;
  });
}

function barcode(c: CanvasRenderingContext2D, rng: () => number, x: number, y: number, w: number, h: number, dark = '#111'): void {
  c.fillStyle = '#f7f4ee';
  c.fillRect(x - 4, y - 4, w + 8, h + 8);
  c.fillStyle = dark;
  let bx = x;
  while (bx < x + w) {
    const bw = 1 + Math.floor(rng() * 3);
    c.fillRect(bx, y, bw, h);
    bx += bw + 1 + Math.floor(rng() * 3);
  }
}

function drawAtlas(c: CanvasRenderingContext2D, W: number, H: number): void {
  const rng = createRng(90210);
  c.fillStyle = '#2b2825';
  c.fillRect(0, 0, W, H);

  const inCell = (cell: Cell, draw: () => void): void => {
    c.save();
    c.translate(cell.x, cell.y);
    c.beginPath();
    c.rect(0, 0, cell.w, cell.h);
    c.clip();
    draw();
    c.restore();
  };

  // Magazine A: an interiors title, warm paper, quiet serif masthead.
  inCell(CELLS.magA, () => {
    c.fillStyle = '#ebe4d6';
    c.fillRect(0, 0, 384, 512);
    const wall = c.createLinearGradient(0, 96, 0, 400);
    wall.addColorStop(0, '#d9ccb9');
    wall.addColorStop(1, '#a5927a');
    c.fillStyle = wall;
    c.fillRect(0, 96, 384, 304);
    c.fillStyle = 'rgba(255, 246, 224, 0.6)';
    c.fillRect(236, 118, 96, 168); // window light
    c.fillStyle = '#7e6247';
    c.fillRect(0, 332, 384, 68); // floor
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(0, 332, 384, 6);
    c.fillStyle = '#55685a'; // sofa
    c.beginPath();
    c.roundRect(34, 262, 214, 76, 12);
    c.fill();
    c.fillStyle = '#617566';
    c.beginPath();
    c.roundRect(44, 248, 96, 34, 8);
    c.fill();
    c.beginPath();
    c.roundRect(146, 248, 96, 34, 8);
    c.fill();
    c.fillStyle = '#c9a27a'; // side table + lamp
    c.fillRect(276, 292, 46, 44);
    c.fillStyle = '#e9d8ad';
    c.beginPath();
    c.ellipse(299, 252, 30, 20, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#6b5a45';
    c.fillRect(297, 270, 4, 24);
    c.fillStyle = '#3f6a48'; // plant
    for (const [px, py, r] of [[338, 300, 26], [318, 282, 18], [356, 280, 16], [330, 268, 12]] as const) {
      c.beginPath();
      c.arc(px, py, r, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = '#b26a4e';
    c.fillRect(326, 318, 26, 20);
    c.fillStyle = '#2a2521';
    c.font = `bold 66px ${SERIF}`;
    spaced(c, 'HABITAT', 192, 78, 5, 'center');
    c.fillStyle = '#6b6157';
    c.font = `600 12px ${SANS}`;
    spaced(c, 'THE SLOW HOME ISSUE', 192, 26, 3, 'center');
    c.textAlign = 'right';
    c.font = `12px ${SANS}`;
    c.fillText('Nº 31', 368, 26);
    c.textAlign = 'left';
    c.fillStyle = '#2a2521';
    c.font = `30px ${SERIF}`;
    c.fillText('24 rooms that breathe', 22, 438);
    c.fillStyle = '#4a433c';
    c.font = `14px ${SANS}`;
    c.fillText('Walnut, wool & unglazed clay', 22, 464);
    c.fillText('A weekend house in the Dolomites', 22, 486);
    barcode(c, rng, 302, 452, 58, 36);
  });

  // Magazine B: a travel title, dusk gradient, bold sans masthead.
  inCell(CELLS.magB, () => {
    const sky = c.createLinearGradient(0, 0, 0, 512);
    sky.addColorStop(0, '#12224a');
    sky.addColorStop(0.35, '#3c4d86');
    sky.addColorStop(0.7, '#df7a3c');
    sky.addColorStop(1, '#f6c46b');
    c.fillStyle = sky;
    c.fillRect(0, 0, 384, 512);
    const glow = c.createRadialGradient(262, 312, 10, 262, 312, 130);
    glow.addColorStop(0, 'rgba(255, 236, 190, 0.9)');
    glow.addColorStop(1, 'rgba(255, 200, 120, 0)');
    c.fillStyle = glow;
    c.fillRect(0, 0, 384, 512);
    c.fillStyle = '#ffe6a8';
    c.beginPath();
    c.arc(262, 312, 54, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#2a2542';
    c.beginPath();
    c.moveTo(0, 512);
    c.lineTo(0, 372);
    c.lineTo(58, 318);
    c.lineTo(118, 358);
    c.lineTo(188, 284);
    c.lineTo(250, 350);
    c.lineTo(318, 304);
    c.lineTo(384, 344);
    c.lineTo(384, 512);
    c.closePath();
    c.fill();
    c.fillStyle = '#15132a';
    c.beginPath();
    c.moveTo(0, 512);
    c.lineTo(0, 428);
    c.lineTo(90, 396);
    c.lineTo(170, 424);
    c.lineTo(260, 386);
    c.lineTo(384, 418);
    c.lineTo(384, 512);
    c.closePath();
    c.fill();
    c.shadowColor = 'rgba(0,0,0,0.4)';
    c.shadowBlur = 6;
    c.fillStyle = '#ffffff';
    c.font = `bold 60px ${SANS}`;
    spaced(c, 'MERIDIAN', 192, 82, 4, 'center');
    c.shadowBlur = 0;
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.font = `600 12px ${SANS}`;
    spaced(c, 'JOURNEYS OFF THE MAP', 192, 108, 3, 'center');
    c.fillStyle = '#ffffff';
    c.font = `bold 30px ${SANS}`;
    c.fillText('Patagonia by rail', 20, 466);
    c.font = `13px ${SANS}`;
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.fillText('Kyoto’s hidden gardens  ·  Lisbon after dark', 20, 490);
    barcode(c, rng, 306, 452, 54, 30);
  });

  // Magazine C: a design title, flat yellow, oversized wordmark.
  inCell(CELLS.magC, () => {
    c.fillStyle = '#f0c31c';
    c.fillRect(0, 0, 384, 512);
    c.strokeStyle = 'rgba(0,0,0,0.08)';
    c.lineWidth = 1;
    for (let i = 48; i < 384; i += 48) {
      c.beginPath();
      c.moveTo(i, 0);
      c.lineTo(i, 512);
      c.stroke();
    }
    for (let i = 48; i < 512; i += 48) {
      c.beginPath();
      c.moveTo(0, i);
      c.lineTo(384, i);
      c.stroke();
    }
    c.fillStyle = '#d63b2b';
    c.beginPath();
    c.arc(292, 134, 86, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#141414';
    c.fillRect(0, 0, 384, 26);
    c.fillStyle = '#f0c31c';
    c.font = `600 11px ${SANS}`;
    spaced(c, 'FORM  ·  AUTUMN  ·  No. 47', 14, 18, 2);
    c.fillStyle = '#141414';
    c.font = `bold 150px ${SANS}`;
    c.textAlign = 'left';
    c.fillText('FORM', 8, 412);
    c.font = `600 14px ${SANS}`;
    spaced(c, 'OBJECTS & SPACE', 18, 452, 3);
    c.font = `14px ${SANS}`;
    c.fillText('The chair issue — sixty seats, one century', 18, 478);
    barcode(c, rng, 300, 464, 62, 30, '#141414');
  });

  // Magazine D: a photography quarterly, duotone stair, condensed sans.
  inCell(CELLS.magD, () => {
    c.fillStyle = '#e8e9e6';
    c.fillRect(0, 0, 384, 512);
    c.fillStyle = '#5c5f63';
    c.fillRect(24, 122, 336, 298);
    const rake = c.createLinearGradient(24, 122, 360, 420);
    rake.addColorStop(0, 'rgba(242,240,232,0.72)');
    rake.addColorStop(0.55, 'rgba(242,240,232,0.04)');
    rake.addColorStop(1, 'rgba(10,12,16,0.5)');
    c.fillStyle = rake;
    c.fillRect(24, 122, 336, 298);
    c.fillStyle = 'rgba(248,246,238,0.3)'; // a slab of window light across the flight
    c.beginPath();
    c.moveTo(228, 122);
    c.lineTo(330, 122);
    c.lineTo(286, 420);
    c.lineTo(196, 420);
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(20,22,26,0.7)';
    for (let i = 0; i < 7; i++) c.fillRect(24 + i * 26, 414 - i * 40, 336 - i * 26, 13);
    c.fillStyle = '#16181c';
    c.font = `bold 54px ${SANS}`;
    spaced(c, 'GRAIN', 24, 84, 9);
    c.fillStyle = '#6a6d70';
    c.font = `600 12px ${SANS}`;
    spaced(c, 'PHOTOGRAPHY QUARTERLY', 26, 104, 3);
    c.fillStyle = '#16181c';
    c.font = `26px ${SERIF}`;
    c.fillText('Concrete & shadow', 24, 462);
    c.fillStyle = '#4a4d50';
    c.font = `13px ${SANS}`;
    c.fillText('Portfolio: forty years of empty rooms', 24, 486);
    barcode(c, rng, 300, 448, 58, 32, '#16181c');
  });

  // Book jacket: cream laid paper, a dark band and one big word — at ~40 px only coarse contrast survives.
  inCell(CELLS.label, () => {
    c.fillStyle = '#e7dcc2';
    c.fillRect(0, 0, 256, 380);
    for (let i = 0; i < 900; i++) {
      c.fillStyle = `rgba(90, 70, 40, ${0.03 + rng() * 0.08})`;
      c.fillRect(rng() * 256, rng() * 380, 1 + rng() * 2, 1);
    }
    const INK = '#221a12';
    const CREAM = '#ece2c9';
    c.strokeStyle = INK;
    c.lineWidth = 4;
    c.strokeRect(13, 13, 230, 354);
    c.fillStyle = INK;
    c.fillRect(0, 123, 256, 99); // the band runs off both edges of the jacket
    c.fillRect(67, 89, 122, 5);
    c.fillRect(67, 312, 122, 5);
    c.font = `bold 65px ${SERIF}`;
    c.fillStyle = CREAM;
    spaced(c, 'QUIET', 128, 194, 3, 'center');
    c.fillStyle = INK;
    spaced(c, 'LIGHT', 128, 291, 3, 'center');
    c.font = `24px ${SERIF}`;
    c.fillStyle = '#3a2a1c';
    spaced(c, 'M. ALDANA', 128, 346, 6, 'center');
  });

  // Faint print grain over everything so flat fills don't look vector-clean.
  for (let i = 0; i < 9000; i++) {
    c.fillStyle = `rgba(0,0,0,${0.02 + rng() * 0.05})`;
    c.fillRect(rng() * W, rng() * H, 1, 1);
  }
}

/** Page-block edges: leaves at ~0.5 mm on a 25 mm block; anything finer mips to flat cream. */
function drawPages(c: CanvasRenderingContext2D, W: number, H: number): void {
  const rng = createRng(4471);
  c.fillStyle = '#efe6d1';
  c.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 9) {
    const a = rng() < 0.16 ? 0.3 + rng() * 0.22 : 0.08 + rng() * 0.14;
    const g = c.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, `rgba(110, 90, 60, ${a})`);
    g.addColorStop(0.5, `rgba(110, 90, 60, ${a * (0.6 + rng() * 0.8)})`);
    g.addColorStop(1, `rgba(110, 90, 60, ${a})`);
    c.fillStyle = g;
    c.fillRect(0, y, W, 4 + rng() * 3);
  }
  for (let i = 0; i < 300; i++) {
    c.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.1})`;
    c.fillRect(rng() * W, rng() * H, 2 + rng() * 6, 1);
  }
}

/** Merge into one draw call. RoundedBox is non-indexed, Box/Cylinder/Sphere are
 *  indexed, and mergeGeometries refuses a mixed list — so flatten first. */
function unify(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('coffeeTable: mergeGeometries failed (incompatible attributes)');
  for (const p of parts) if (!geoms.includes(p)) p.dispose();
  for (const g of geoms) g.dispose();
  return merged;
}

/** A tube whose rings are pulled in toward the tip; a constant-radius stalk reads as a painted dowel. */
function taperedTube(curve: THREE.Curve<THREE.Vector3>, radius: number, tip: number, tubular = 20, radial = 6): THREE.BufferGeometry {
  const geo = new THREE.TubeGeometry(curve, tubular, radius, radial, false);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const ring = radial + 1;
  for (let i = 0; i <= tubular; i++) {
    const k = lerp(1, tip, (i / tubular) ** 1.4);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let j = 0; j < ring; j++) {
      cx += pos.getX(i * ring + j);
      cy += pos.getY(i * ring + j);
      cz += pos.getZ(i * ring + j);
    }
    cx /= ring;
    cy /= ring;
    cz /= ring;
    for (let j = 0; j < ring; j++) {
      const n = i * ring + j;
      pos.setXYZ(n, cx + (pos.getX(n) - cx) * k, cy + (pos.getY(n) - cy) * k, cz + (pos.getZ(n) - cz) * k);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Unwrap a slab onto one painted board at 1:1, carried over the bullnose so the edge is the wood above it. */
function boardUv(
  geo: THREE.BufferGeometry,
  w: number,
  h: number,
  d: number,
  b: Board,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Weight the three planar projections by the face normal, cubed so flat
    // faces stay pure and only the 8 mm rounds blend.
    const ax = Math.abs(nor.getX(i)) ** 3;
    const ay = Math.abs(nor.getY(i)) ** 3;
    const az = Math.abs(nor.getZ(i)) ** 3;
    const s = ax + ay + az || 1;
    const down = h / 2 - y; // distance travelled down from the top face
    const uEnd = (x >= 0 ? 1 : -1) * (w / 2 + down); // wrap over the ±X ends
    const vEdge = (z >= 0 ? 1 : -1) * (d / 2 + down); // wrap over the ±Z bullnose
    const u = (ax * uEnd + (ay + az) * x) / s;
    const v = (az * vEdge + (ax + ay) * z) / s;
    const cu = (b.ox + u + w / 2) / BOARD_W; // 0..1 inside the cell
    const cv = (b.oy + v + d / 2) / BOARD_D;
    uv.setXY(i, cu, b.row === 0 ? 0.5 + cv * 0.5 : cv * 0.5);
  }
  uv.needsUpdate = true;
}

/** Remap a geometry's 0..1 UVs onto one cell of the atlas (2 px bleed guard). */
function mapUvToCell(geo: THREE.BufferGeometry, cell: Cell): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const pad = 2 / ATLAS;
  const u0 = cell.x / ATLAS + pad;
  const u1 = (cell.x + cell.w) / ATLAS - pad;
  const v1 = 1 - cell.y / ATLAS - pad;
  const v0 = 1 - (cell.y + cell.h) / ATLAS + pad;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
}

/** A printed sheet lying flat, facing +Y, with the top of the artwork toward -Z. */
function coverSheet(w: number, d: number, cell: Cell): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  mapUvToCell(g, cell);
  return g;
}

interface BookParts {
  cover: THREE.BufferGeometry;
  pages: THREE.BufferGeometry;
  label?: THREE.BufferGeometry;
}

/** Hardcover lying flat; local origin at the bottom centre, `m` bakes the pose so parts can be merged. */
function bookParts(w: number, d: number, t: number, m: THREE.Matrix4, labelCell?: Cell): BookParts {
  const tb = 0.0025; // board
  const bottom = roundedBox(w, tb, d, 0.0008, 2);
  bottom.translate(0, tb / 2, 0);
  const top = roundedBox(w, tb, d, 0.0008, 2);
  top.translate(0, t - tb / 2, 0);
  // The rounded back stands 1 mm proud of the boards and wraps ~29° onto them, so the spine has no zero-thickness lip.
  const r = t / 2 + 0.001;
  const spine = new THREE.CylinderGeometry(r, r, d + 0.0006, 32, 1, false, Math.PI - 0.5, Math.PI + 1);
  spine.rotateX(Math.PI / 2);
  spine.translate(-w / 2 + 0.0035, t / 2, 0);
  const cover = unify([bottom, top, spine]);
  cover.applyMatrix4(m);

  const inset = 0.004;
  const pages = roundedBox(w - inset, t - 2 * tb - 0.0004, d - 2 * inset, 0.0008, 1);
  pages.translate(-inset / 2, t / 2, 0);
  pages.applyMatrix4(m);

  let label: THREE.BufferGeometry | undefined;
  if (labelCell) {
    label = coverSheet(w - 0.034, d - 0.034, labelCell);
    label.translate(0.004, t + 0.0004, 0);
    label.applyMatrix4(m);
  }
  return { cover, pages, label };
}

/** Bowl meridian (r, y). 62 mm deep, not 75: a deeper wall swallows 60 mm spheres whole. */
function bowlProfile(): Array<[number, number]> {
  const H = 0.062;
  const R = 0.108;
  const footR = 0.046;
  const wall = 0.005;
  const outer = (y: number): number => footR + (R - footR) * Math.sin(((y - 0.004) / (H - 0.004)) * Math.PI * 0.5);
  const pts: Array<[number, number]> = [[0, 0], [0.036, 0], [footR - 0.002, 0], [footR, 0.004]];
  const N = 14;
  for (let i = 1; i <= N; i++) {
    const y = 0.004 + ((H - 0.004) * i) / N;
    pts.push([outer(y), y]);
  }
  pts.push([R - wall / 2, H + 0.0018], [R - wall, H]);
  for (let i = N - 1; i >= 2; i--) {
    const y = 0.004 + ((H - 0.004) * i) / N;
    pts.push([outer(y) - wall, y]);
  }
  pts.push([0.05, 0.013], [0.03, 0.012], [0, 0.012]);
  return pts;
}

/** Bud vase profile (r, y): base → belly → neck → flared lip → inner cavity. */
function vaseProfile(): Array<[number, number]> {
  return [
    [0, 0], [0.026, 0], [0.03, 0.003],
    [0.034, 0.012], [0.036, 0.025], [0.035, 0.04], [0.03, 0.055], [0.022, 0.07],
    [0.015, 0.085], [0.013, 0.098], [0.013, 0.108], [0.016, 0.116], [0.019, 0.12],
    [0.0175, 0.1212], [0.016, 0.12],
    [0.0105, 0.108], [0.0105, 0.098], [0.0125, 0.085], [0.019, 0.07], [0.027, 0.055],
    [0.032, 0.04], [0.033, 0.025], [0.031, 0.014], [0.02, 0.011], [0, 0.01],
  ];
}

/** Height at which a sphere of radius `R`, centred `rho` from the bowl axis, rests on its inner surface. */
function restingHeight(inner: Array<[number, number]>, rho: number, R: number): number {
  let best = -Infinity;
  for (let i = 0; i < inner.length - 1; i++) {
    const [r0, y0] = inner[i];
    const [r1, y1] = inner[i + 1];
    for (let k = 0; k <= 12; k++) {
      const s = k / 12;
      const r = r0 + (r1 - r0) * s;
      const y = y0 + (y1 - y0) * s;
      const dx = Math.abs(rho - r);
      if (dx <= R) best = Math.max(best, y + Math.sqrt(R * R - dx * dx));
    }
  }
  return best;
}

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'coffeeTable';
  const rng = createRng(ctx.seed + 4102);
  const M = ctx.materials;

  // No normal map on the slabs: the shared wood pore band is below its own texel pitch and scallops the bullnose.
  const walnut = M.custom({
    map: ctx.textures.canvas('coffeeTable:walnutBoards', WOOD_TEX, WOOD_TEX, blitWalnut('color')),
    roughnessMap: ctx.textures.canvas('coffeeTable:walnutRough', WOOD_TEX, WOOD_TEX, blitWalnut('rough'), false),
    roughness: 1, // the map carries the value
    metalness: 0,
    clearcoat: 0.05,
    clearcoatRoughness: 0.6,
    specularIntensity: 0.45,
    envMapIntensity: 0.4,
  });
  walnut.name = 'coffeeTable:walnut';
  // Slab shadows cast from the back faces: a 30 mm offset against a 5 mm shadow texel keeps the bullnose clean.
  walnut.shadowSide = THREE.BackSide;
  woodBuffers = null; // both blits are done; the textures are memoised by key

  // Powder coat, not bare metal: at metalness 0.9 a near-black tube has nothing to reflect and goes flat.
  const steel = M.metal('blackMatte').clone();
  steel.color.setHex(0x24242a);
  steel.metalness = 0.15;
  steel.roughness = 0.5;
  steel.envMapIntensity = 1.2;
  // Two stops lighter than the frame, or the glide is invisible under it.
  const rubberFeet = M.rubber(0x46464c);

  // Top and shelf are cut from the same board texture (different cells), so
  // they merge into one draw call.
  const topGeo = roundedBox(TABLE_W, TOP_T, TABLE_D, 0.008, 4);
  boardUv(topGeo, TABLE_W, TOP_T, TABLE_D, { row: 0, ox: 0.2, oy: 0.075 });
  topGeo.translate(0, TOP_Y - TOP_T / 2, 0);
  const shelfGeo = roundedBox(INNER_X, SHELF_T, SHELF_D, 0.004, 3);
  boardUv(shelfGeo, INNER_X, SHELF_T, SHELF_D, { row: 1, ox: 0.3, oy: 0.12 });
  shelfGeo.translate(0, SHELF_Y + SHELF_T / 2, 0);
  g.add(mesh(unify([topGeo, shelfGeo]), walnut, undefined, { name: 'boards' }));

  const frame: THREE.BufferGeometry[] = [];
  const legH = LEG_TOP - FOOT_H;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = roundedBox(LEG, legH, LEG, 0.0015, 2);
      leg.translate(sx * LEG_X, FOOT_H + legH / 2, sz * LEG_Z);
      frame.push(leg);
    }
    // apron rails along z between the leg pair at x = ±LEG_X
    const railZ = roundedBox(LEG, RAIL_H, INNER_Z, 0.0015, 2);
    railZ.translate(sx * LEG_X, LEG_TOP - RAIL_H / 2, 0);
    frame.push(railZ);
  }
  for (const sz of [-1, 1]) {
    const railX = roundedBox(INNER_X, RAIL_H, LEG, 0.0015, 2);
    railX.translate(0, LEG_TOP - RAIL_H / 2, sz * LEG_Z);
    frame.push(railX);
    const bar = roundedBox(INNER_X, BAR_H, LEG, 0.001, 2);
    bar.translate(0, SHELF_Y - BAR_H / 2, sz * LEG_Z);
    frame.push(bar);
  }
  g.add(mesh(unify(frame), steel, undefined, { name: 'frame' }));

  const feet: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Flush with the tube where it is pressed in, narrowing to the floor;
      // a glide under the 25 mm section simply vanishes.
      const foot = cylinder(0.0132, 0.0108, FOOT_H, 24);
      foot.translate(sx * LEG_X, FOOT_H / 2, sz * LEG_Z);
      feet.push(foot);
    }
  }
  g.add(mesh(unify(feet), rubberFeet, undefined, { name: 'feet' }));

  const atlas = ctx.textures.canvas('coffeeTable:atlas', ATLAS, ATLAS, drawAtlas);
  const pagesTex = ctx.textures.canvas('coffeeTable:pages', 256, 256, drawPages);
  pagesTex.wrapS = THREE.RepeatWrapping;
  pagesTex.wrapT = THREE.RepeatWrapping;
  pagesTex.repeat.set(1, 2);
  pagesTex.needsUpdate = true;
  const paperSet = ctx.textures.paper();
  // Uncoated stock has essentially no mirror lobe; at the default specular
  // intensity Fresnel turns the ink panel white when it is seen edge-on.
  const pagesMat = M.custom({ map: pagesTex, normalMap: paperSet.normalMap, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 0.9, metalness: 0, specularIntensity: 0.4, envMapIntensity: 0.45 });
  // Coated magazine stock, but only just: a clearcoat of 0.5 mirrors the room
  // at a grazing angle and blows the covers out to white paper.
  const glossPrint = M.custom({ map: atlas, roughness: 0.44, metalness: 0, clearcoat: 0.22, clearcoatRoughness: 0.38, envMapIntensity: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const mattePrint = M.custom({ map: atlas, normalMap: paperSet.normalMap, normalScale: new THREE.Vector2(0.25, 0.25), roughness: 0.84, metalness: 0, specularIntensity: 0.35, envMapIntensity: 0.45, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });

  const pageGeos: THREE.BufferGeometry[] = [];
  const glossGeos: THREE.BufferGeometry[] = [];
  const matteGeos: THREE.BufferGeometry[] = [];

  const stackX = -0.27;
  const stackZ = 0.03;
  const books = [
    { w: 0.22, d: 0.3, t: 0.03, mat: M.fabric(0x5e2f27, { scale: 2.5, surface: [0.2, 0.25] }), rot: 0.05, dx: 0, dz: 0 },
    { w: 0.2, d: 0.27, t: 0.025, mat: M.fabric(0x35513f, { scale: 2.5, surface: [0.2, 0.25] }), rot: -0.11, dx: 0.014, dz: -0.006 },
    { w: 0.18, d: 0.25, t: 0.021, mat: M.fabric(0x2c3556, { scale: 2.5, surface: [0.2, 0.25] }), rot: 0.17, dx: -0.006, dz: 0.012, label: CELLS.label },
  ];
  let stackY = TOP_Y;
  for (const b of books) {
    const m = new THREE.Matrix4().makeRotationY(b.rot + (rng() - 0.5) * 0.03);
    m.setPosition(stackX + b.dx, stackY, stackZ + b.dz);
    const parts = bookParts(b.w, b.d, b.t, m, b.label);
    g.add(mesh(parts.cover, b.mat, undefined, { name: 'bookCover' }));
    pageGeos.push(parts.pages);
    if (parts.label) matteGeos.push(parts.label);
    stackY += b.t;
  }

  // bottom → top; the top cover is the one a viewer sees, so the boldest goes last
  const magCells: Cell[] = [CELLS.magB, CELLS.magD, CELLS.magA, CELLS.magC];
  const magW = 0.21;
  const magD = 0.28;
  const magT = 0.0045;
  let magY = SHELF_TOP;
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Matrix4().makeRotationY(-0.12 + i * 0.14 + (rng() - 0.5) * 0.02); // ~8° fan
    m.setPosition(-0.16 + i * 0.042, magY, 0.014 - i * 0.007);
    const block = roundedBox(magW, magT, magD, 0.0008, 1);
    block.translate(0, magT / 2, 0);
    block.applyMatrix4(m);
    pageGeos.push(block);
    const sheet = coverSheet(magW - 0.002, magD - 0.002, magCells[i]);
    sheet.translate(0, magT + 0.0004, 0);
    sheet.applyMatrix4(m);
    glossGeos.push(sheet);
    magY += magT + 0.0003;
  }

  g.add(mesh(unify(pageGeos), pagesMat, undefined, { name: 'pages' }));
  g.add(mesh(unify(glossGeos), glossPrint, undefined, { name: 'magazineCovers' }));
  g.add(mesh(unify(matteGeos), mattePrint, undefined, { name: 'bookLabel' }));

  const speckle = ctx.textures.canvas('coffeeTable:speckle', 256, 256, drawSpeckle, false);
  speckle.wrapS = THREE.RepeatWrapping;
  speckle.wrapT = THREE.RepeatWrapping;
  speckle.repeat.set(12, 5);
  speckle.needsUpdate = true;

  const bowlPos: [number, number, number] = [0.17, TOP_Y, -0.06];
  // Unglazed stoneware, not a black cut-out: it needs a lighter base, a rim reflection and a speckle on the belly.
  const bowlMat = M.ceramic(0x26262a, false).clone();
  bowlMat.name = 'coffeeTable:stoneware';
  bowlMat.roughnessMap = speckle;
  bowlMat.roughness = 0.5; // × the map's 0.78–1.0
  bowlMat.envMapIntensity = 1;
  const profile = bowlProfile();
  g.add(mesh(lathe(profile, 64), bowlMat, bowlPos, { name: 'bowl' }));
  // The lip is the highest point of the profile; everything after it is the
  // inner wall running back down to the bowl floor.
  let rimIndex = 0;
  profile.forEach(([, y], i) => {
    if (y > profile[rimIndex][1]) rimIndex = i;
  });
  const inner = profile.slice(rimIndex + 1);
  // One walnut, one oak, one dark walnut: three of the same wood merge into a
  // single lump inside a black bowl.
  const spheres: Array<{ r: number; band: number; x: number; z: number; squash: number }> = [
    { r: 0.033, band: 0, x: -0.031, z: 0.016, squash: 0.985 },
    { r: 0.029, band: 1, x: 0.029, z: 0.026, squash: 1.012 },
    { r: 0.026, band: 2, x: -0.006, z: -0.036, squash: 0.992 },
  ];
  const ballMat = M.custom({
    map: ctx.textures.canvas('coffeeTable:turnedWood', BALL_TEX, BALL_TEX, drawBalls),
    roughnessMap: speckle,
    roughness: 0.56, // × the map's 0.78–1.0
    metalness: 0,
    clearcoat: 0.08,
    clearcoatRoughness: 0.5,
    specularIntensity: 0.5,
    envMapIntensity: 0.45,
  });
  ballMat.name = 'coffeeTable:turnedWood';
  const ballGeos: THREE.BufferGeometry[] = [];
  for (const s of spheres) {
    const rho = Math.hypot(s.x, s.z);
    const y = restingHeight(inner, rho, s.r);
    const geo = new THREE.SphereGeometry(s.r, 28, 18);
    ballUv(geo, s.band);
    // Lay the turning axis nearly flat: with a pole up the meridians converge
    // in the middle of the visible face and the ball reads as a melon.
    geo.rotateZ(1.25 + rng() * 0.5);
    geo.rotateY(rng() * Math.PI);
    geo.scale(s.squash, 1, s.squash); // hand-turned: a touch out of round in plan
    geo.translate(bowlPos[0] + s.x, bowlPos[1] + y, bowlPos[2] + s.z);
    ballGeos.push(geo);
  }
  g.add(mesh(unify(ballGeos), ballMat, undefined, { name: 'spheres' }));

  const vasePos = new THREE.Vector3(-0.03, TOP_Y, -0.17);
  const vaseGlass = M.solidGlass().clone();
  vaseGlass.name = 'coffeeTable:vaseGlass';
  // solidGlass() is tuned for a solid lump; `thickness` also drives refraction, so a bud vase wants more than 4 mm.
  vaseGlass.thickness = 0.012;
  vaseGlass.attenuationColor.setHex(0xbcded0);
  vaseGlass.attenuationDistance = 0.35;
  vaseGlass.roughness = 0.02;
  vaseGlass.ior = 1.52;
  vaseGlass.envMapIntensity = 1.1;
  g.add(mesh(lathe(vaseProfile(), 48), vaseGlass, [vasePos.x, vasePos.y, vasePos.z], { name: 'vase', cast: false }));
  // Darker than dried straw and the specular damped: a highlight down each tube reads as brown plastic rod.
  const stemMat = M.plastic(0xa08051, 0.92).clone();
  stemMat.specularIntensity = 0.22;
  stemMat.envMapIntensity = 0.5;
  const fluffMat = M.fabric(0xcdb68c, { boucle: true, scale: 1.6, surface: [0.06, 0.06] });
  const stemGeos: THREE.BufferGeometry[] = [];
  const fluffGeos: THREE.BufferGeometry[] = [];
  /** Nine stalks; `h` is the tip height above the top, `lean` the tip's offset. The flare stays inside 0.09 m. */
  const stems = [
    { base: [0.004, -0.002], lean: [0.028, -0.016], h: 0.244, head: 'plume', scale: 1.15, r: 0.0019 },
    { base: [-0.004, 0.003], lean: [-0.05, 0.03], h: 0.24, head: 'bare', scale: 1, r: 0.002 },
    { base: [0.002, 0.005], lean: [0.076, 0.034], h: 0.224, head: 'fluff', scale: 1.28, r: 0.0019 },
    { base: [-0.005, -0.003], lean: [-0.022, -0.056], h: 0.213, head: 'spike', scale: 1, r: 0.0017 },
    { base: [0.005, 0.001], lean: [0.045, 0.072], h: 0.199, head: 'fluff', scale: 0.82, r: 0.0017 },
    { base: [-0.002, -0.005], lean: [-0.08, -0.012], h: 0.187, head: 'pod', scale: 1, r: 0.002 },
    { base: [0.003, -0.004], lean: [0.06, -0.045], h: 0.173, head: 'bare', scale: 1, r: 0.0018 },
    { base: [-0.003, 0.004], lean: [-0.012, 0.084], h: 0.161, head: 'fluff', scale: 1.05, r: 0.0018 },
    { base: [0.001, 0.004], lean: [-0.038, -0.03], h: 0.144, head: 'bare', scale: 1, r: 0.0019 },
  ] as const;
  const up = new THREE.Vector3(0, 1, 0);
  for (const s of stems) {
    const sag = (rng() - 0.5) * 0.01; // no two stalks bend on the same arc
    // Six control points: evenly spaced ones give straight spokes instead of a stalk arcing over under its head.
    const top = s.h - 0.118;
    const pts = [
      new THREE.Vector3(s.base[0], 0.012, s.base[1]),
      new THREE.Vector3(s.base[0] * 0.6, 0.07, s.base[1] * 0.6),
      new THREE.Vector3(s.base[0] * 0.25, 0.118, s.base[1] * 0.25),
      new THREE.Vector3(s.lean[0] * 0.2 + sag, 0.118 + top * 0.38, s.lean[1] * 0.2 - sag),
      new THREE.Vector3(s.lean[0] * 0.68 + sag * 0.5, 0.118 + top * 0.76, s.lean[1] * 0.68 - sag * 0.5),
      new THREE.Vector3(s.lean[0], s.h, s.lean[1]),
    ].map((p) => p.add(vasePos));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
    stemGeos.push(taperedTube(curve, s.r, s.head === 'bare' ? 0.3 : 0.5));
    const tip = pts[pts.length - 1];
    const tangent = curve.getTangent(1).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(up, tangent);
    const at = (dist: number, geo: THREE.BufferGeometry): THREE.BufferGeometry =>
      geo.translate(tip.x + tangent.x * dist, tip.y + tangent.y * dist, tip.z + tangent.z * dist);
    if (s.head === 'fluff' || s.head === 'plume') {
      // bunny-tail: a soft oval of seed down
      const k = s.scale;
      const head = new THREE.SphereGeometry(1, 14, 11);
      head.scale(0.0128 * k, (s.head === 'plume' ? 0.032 : 0.023) * k, 0.0128 * k);
      head.applyQuaternion(q);
      fluffGeos.push(at(0.017 * k + (s.head === 'plume' ? 0.008 : 0), head));
    } else if (s.head === 'spike') {
      // a dried grass spike: slim, long, stiffer than the fluff
      const head = new THREE.SphereGeometry(1, 12, 10);
      head.scale(0.0068, 0.04, 0.0068);
      head.applyQuaternion(q);
      fluffGeos.push(at(0.035, head));
    } else if (s.head === 'pod') {
      const pod = new THREE.SphereGeometry(1, 14, 11);
      pod.scale(0.0095, 0.0115, 0.0095);
      pod.applyQuaternion(q);
      stemGeos.push(at(0.009, pod));
      const cap = cylinder(0.0105, 0.0072, 0.0018, 14);
      cap.applyQuaternion(q);
      stemGeos.push(at(0.0185, cap));
    } else {
      // bare stalk: one swollen leaf node partway up; the tube's own taper takes
      // the tip to a point, where a ball read as a pin.
      const node = new THREE.SphereGeometry(s.r * 0.95, 8, 6);
      node.scale(1, 1.8, 1);
      node.applyQuaternion(q);
      stemGeos.push(at(-0.03, node));
    }
  }
  g.add(mesh(unify(stemGeos), stemMat, undefined, { name: 'stems' }));
  g.add(mesh(unify(fluffGeos), fluffMat, undefined, { name: 'stemHeads' }));

  const remote = new THREE.Group();
  remote.name = 'remote';
  const remL = 0.16;
  const remH = 0.02;
  const remW = 0.045;
  remote.add(mesh(roundedBox(remL, remH, remW, 0.006), M.rubber(0x121214), [0, remH / 2, 0]));
  // IR window on the far end
  remote.add(mesh(box(0.003, 0.006, 0.024), M.plastic(0x1c0d10, 0.12), [-remL / 2 + 0.0012, remH * 0.6, 0]));
  interface Btn {
    x: number;
    z: number;
    r: number;
    h: number;
    c: number;
    sx?: number;
    sz?: number;
  }
  const DARK = 0x2e2e31;
  const btns: Btn[] = [
    { x: -0.066, z: -0.011, r: 0.0036, h: 0.002, c: 0xa8231c },
    { x: -0.066, z: 0.011, r: 0.0036, h: 0.002, c: DARK },
    { x: -0.052, z: -0.012, r: 0.003, h: 0.0018, c: DARK },
    { x: -0.052, z: 0, r: 0.003, h: 0.0018, c: DARK },
    { x: -0.052, z: 0.012, r: 0.003, h: 0.0018, c: DARK },
    { x: -0.03, z: 0, r: 0.0118, h: 0.0016, c: 0x3a3a3e }, // nav ring
    { x: -0.03, z: 0, r: 0.0046, h: 0.0028, c: 0x1c1c1e }, // OK
    { x: -0.008, z: -0.0135, r: 0.0028, h: 0.0018, c: 0xb8281f },
    { x: -0.008, z: -0.0045, r: 0.0028, h: 0.0018, c: 0x2f8a3a },
    { x: -0.008, z: 0.0045, r: 0.0028, h: 0.0018, c: 0xd9a41c },
    { x: -0.008, z: 0.0135, r: 0.0028, h: 0.0018, c: 0x2450a8 },
    { x: 0.012, z: -0.0105, r: 0.0034, h: 0.002, c: DARK, sx: 2.6, sz: 1 }, // vol rocker
    { x: 0.012, z: 0.0105, r: 0.0034, h: 0.002, c: DARK, sx: 2.6, sz: 1 }, // ch rocker
  ];
  for (let row = 0; row < 4; row++) {
    for (let col = -1; col <= 1; col++) btns.push({ x: 0.03 + row * 0.0125, z: col * 0.0118, r: 0.0034, h: 0.0018, c: DARK });
  }
  const btnGeo = new THREE.CylinderGeometry(1, 1, 1, 18);
  const buttons = new THREE.InstancedMesh(btnGeo, M.plastic(0xffffff, 0.55), btns.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  btns.forEach((b, i) => {
    dummy.position.set(b.x, remH + b.h / 2 - 0.0006, b.z);
    dummy.scale.set(b.r * (b.sx ?? 1), b.h, b.r * (b.sz ?? 1));
    dummy.updateMatrix();
    buttons.setMatrixAt(i, dummy.matrix);
    buttons.setColorAt(i, color.setHex(b.c));
  });
  buttons.instanceMatrix.needsUpdate = true;
  if (buttons.instanceColor) buttons.instanceColor.needsUpdate = true;
  buttons.castShadow = true;
  buttons.receiveShadow = true;
  buttons.name = 'remoteButtons';
  remote.add(buttons);
  remote.rotation.y = -0.42;
  remote.position.set(0.4, TOP_Y, 0.17);
  g.add(remote);

  return g;
}
