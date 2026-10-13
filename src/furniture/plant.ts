// Origin: floor, centre of the pot.
import * as THREE from 'three';
import { cylinder, lathe, mergeGeometries, mesh } from '../core/geometry';
import { createRng } from '../core/noise';
import type { SceneContext } from '../core/types';

const DEG = Math.PI / 180;
type V3 = THREE.Vector3;
const v3 = (x: number, y: number, z: number): V3 => new THREE.Vector3(x, y, z);
const UP = new THREE.Vector3(0, 1, 0);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const SAUCER_FLOOR = 0.008; // pot stands on the saucer floor
const POT_H = 0.38;
const POT_RIM_Y = SAUCER_FLOOR + POT_H; // 0.388
const SOIL_R = 0.162; // reaches 3 mm into the pot wall so no gap shows
const SOIL_RIM_Y = POT_RIM_Y - 0.03; // 0.358
const SOIL_DEPTH = 0.02; // concave dish
const TRUNK_BASE_Y = 0.30; // buried below the soil
const TRUNK_TOP_Y = 1.40;
const BARK_TILE = 0.25; // metres of stem per bark texture repeat
const LEAF_VARIANTS = 2; // blades side by side on the one leaf canvas

// Leaf outline: half width (as a fraction of the full width) vs s = 0 (base) .. 1 (tip).
const PROFILE: Array<[number, number]> = [
  [0.0, 0.02], [0.05, 0.09], [0.11, 0.20], [0.19, 0.29], [0.28, 0.325], [0.41, 0.272],
  [0.53, 0.35], [0.64, 0.455], [0.74, 0.49], [0.83, 0.455], [0.90, 0.37], [0.955, 0.23],
  [0.985, 0.09], [1.0, 0.01],
];

function hwAt(s: number): number {
  for (let i = 1; i < PROFILE.length; i++) {
    if (s <= PROFILE[i][0]) {
      const [s0, h0] = PROFILE[i - 1];
      const [s1, h1] = PROFILE[i];
      return lerp(h0, h1, (s - s0) / (s1 - s0));
    }
  }
  return PROFILE[PROFILE.length - 1][1];
}

/** Canvas y of the leaf axis position s (base at the bottom of the image, tip at the top). */
const yAt = (h: number, s: number): number => h * 0.985 - s * h * 0.97;

/** Call fn at every wrapped copy of (x, y) whose r-disc crosses a tile edge. */
function wrapped(x: number, y: number, r: number, w: number, h: number, fn: (x: number, y: number) => void): void {
  const xs = x < r ? [0, w] : x > w - r ? [-w, 0] : [0];
  const ys = y < r ? [0, h] : y > h - r ? [-h, 0] : [0];
  for (const dx of xs) for (const dy of ys) fn(x + dx, y + dy);
}

function leafPath(w: number, h: number, ph: number): Path2D {
  const pts = PROFILE.map(([s, hw]) => new THREE.Vector2(w / 2 + hw * w * 0.98, yAt(h, s)));
  const right = new THREE.SplineCurve(pts).getPoints(200);
  const n = right.length - 1;
  // The two halves of a fig blade never match; a symmetric vector outline reads as a printed decal.
  const ripple = (i: number, phase: number): number => {
    const s = i / n;
    const env = Math.sin(Math.PI * clamp01((s - 0.05) / 0.9)) ** 0.7; // dies at base and tip
    return (
      env * w * 0.013 * (0.72 * Math.sin(s * 5.3 * Math.PI + phase) + 0.28 * Math.sin(s * 11.1 * Math.PI + phase * 1.7))
    );
  };
  const p = new Path2D();
  p.moveTo(right[0].x + ripple(0, 0.4 + ph), right[0].y);
  for (let i = 0; i <= n; i++) p.lineTo(right[i].x + ripple(i, 0.4 + ph), right[i].y);
  for (let i = n; i >= 0; i--) p.lineTo(w - right[i].x - ripple(i, 2.35 + ph * 1.6), right[i].y);
  p.closePath();
  return p;
}

interface QCurve { x0: number; y0: number; cx: number; cy: number; x1: number; y1: number }

function qPoint(q: QCurve, f: number): [number, number] {
  const a = (1 - f) * (1 - f);
  const b = 2 * (1 - f) * f;
  const c = f * f;
  return [a * q.x0 + b * q.cx + c * q.x1, a * q.y0 + b * q.cy + c * q.y1];
}

/** Stroke a quadratic curve with a line width that tapers from w0 to w1. */
function strokeTapered(ctx: CanvasRenderingContext2D, q: QCurve, w0: number, w1: number, pieces = 12): void {
  ctx.lineCap = 'round';
  let [px, py] = qPoint(q, 0);
  for (let i = 1; i <= pieces; i++) {
    const [x, y] = qPoint(q, i / pieces);
    ctx.lineWidth = lerp(w0, w1, (i - 0.5) / pieces);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x, y);
    ctx.stroke();
    px = x;
    py = y;
  }
}

interface VeinSet { mid: QCurve; laterals: QCurve[]; tertiaries: QCurve[]; cells: Array<[number, number]> }

/** Midrib, ~8 pairs of arching lateral veins, tertiary branches and the puffed cells between them. */
function veinLayout(w: number, h: number, rng: () => number): VeinSet {
  const cx = w / 2;
  const mid: QCurve = { x0: cx, y0: yAt(h, -0.01), cx: cx + 3, cy: yAt(h, 0.5), x1: cx, y1: yAt(h, 0.99) };
  const laterals: QCurve[] = [];
  const tertiaries: QCurve[] = [];
  const cells: Array<[number, number]> = [];
  for (const side of [-1, 1]) {
    for (let k = 0; k < 8; k++) {
      const s0 = 0.06 + k * 0.112 + (side > 0 ? 0.03 : 0) + (rng() - 0.5) * 0.05;
      if (s0 > 0.9) continue;
      const rise = 0.16 - k * 0.006 + (rng() - 0.5) * 0.03;
      const s1 = Math.min(0.985, s0 + rise);
      const x1 = cx + side * hwAt(s1) * w * 0.98 * 0.94;
      const y0 = yAt(h, s0);
      const y1 = yAt(h, s1);
      const q: QCurve = { x0: cx, y0, cx: cx + side * Math.abs(x1 - cx) * 0.55, cy: y0 - (y0 - y1) * 0.42, x1, y1 };
      laterals.push(q);
      for (const f of [0.42, 0.68]) {
        const [px, py] = qPoint(q, f);
        const s2 = Math.min(0.99, s0 + rise * f + 0.07 + rng() * 0.03);
        const ex = cx + side * hwAt(s2) * w * 0.98 * 0.9;
        const ey = yAt(h, s2);
        tertiaries.push({ x0: px, y0: py, cx: (px + ex) / 2 + side * 6, cy: (py + ey) / 2 + 8, x1: ex, y1: ey });
      }
      const sc = s0 + 0.055;
      cells.push([cx + side * hwAt(sc) * w * 0.98 * 0.5, yAt(h, sc)]);
    }
  }
  return { mid, laterals, tertiaries, cells };
}

/** The venation stays close to the lamina green: high contrast on 33 blades reads as zebra stripes. */
function drawLeafColor(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
  const vw = w / LEAF_VARIANTS;
  const paths: Path2D[] = [];
  for (let k = 0; k < LEAF_VARIANTS; k++) {
    const path = leafPath(vw, h, k * 1.9);
    paths.push(path);
    const veins = veinLayout(vw, h, createRng(21 + k * 9));
    ctx.save();
    ctx.translate(k * vw, 0);
    // Paint the whole tile green first so alpha-tested edges never bleed to black.
    ctx.fillStyle = '#3a6b34';
    ctx.fillRect(0, 0, vw, h);
    ctx.clip(path);
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, '#2e5a2b');
    grad.addColorStop(0.45, '#3b6d34');
    grad.addColorStop(1, '#45793d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, vw, h);
    // Broad tonal regions across the lamina — most of what tells 33 blades apart.
    for (let i = 0; i < 16; i++) {
      const x = vw * (0.05 + rng() * 0.9);
      const y = h * rng();
      const r = h * (0.15 + rng() * 0.3);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rng() < 0.5 ? 'rgba(124,166,84,0.33)' : 'rgba(24,52,24,0.36)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    for (let i = 0; i < 90; i++) {
      const x = rng() * vw;
      const y = rng() * h;
      const r = 20 + rng() * 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rng() < 0.5 ? 'rgba(150,192,108,0.20)' : 'rgba(22,48,20,0.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    strokeTapered(ctx, veins.mid, 26, 8);
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    for (const q of veins.laterals) strokeTapered(ctx, q, 14, 4);
    ctx.strokeStyle = 'rgba(138,167,97,0.22)';
    for (const q of veins.tertiaries) strokeTapered(ctx, q, 1.7, 0.95, 6);
    ctx.strokeStyle = 'rgba(146,177,104,0.40)';
    for (const q of veins.laterals) strokeTapered(ctx, q, 5.4, 1.2);
    ctx.strokeStyle = 'rgba(163,190,117,0.42)';
    strokeTapered(ctx, veins.mid, 11, 2.2);
    ctx.strokeStyle = 'rgba(199,216,152,0.35)';
    strokeTapered(ctx, veins.mid, 4.5, 1.0);
    // Slightly paler, slightly drier margin.
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(160,178,108,0.22)';
    ctx.stroke(path);
    ctx.restore();
  }
  const mask = document.createElement('canvas');
  mask.width = w;
  mask.height = h;
  const mc = mask.getContext('2d');
  if (!mc) return;
  mc.fillStyle = '#000';
  mc.fillRect(0, 0, w, h);
  mc.fillStyle = '#fff';
  // A 1.5 px ramp on the margin: alphaTest alone stair-steps where a blade crosses the bright wall.
  mc.filter = 'blur(1.5px)';
  for (let k = 0; k < LEAF_VARIANTS; k++) {
    mc.save();
    mc.translate(k * vw, 0);
    mc.fill(paths[k]);
    mc.restore();
  }
  mc.filter = 'none';
  const md = mc.getImageData(0, 0, w, h).data;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 14;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
    d[i + 3] = md[i];
  }
  ctx.putImageData(img, 0, 0);
}

/** Bump: recessed veins, puffed lamina between them, fine grain. Linear (non-sRGB). */
function drawLeafBump(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
  const vw = w / LEAF_VARIANTS;
  ctx.fillStyle = '#7d7d7d';
  ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < LEAF_VARIANTS; k++) {
    const veins = veinLayout(vw, h, createRng(21 + k * 9));
    ctx.save();
    ctx.translate(k * vw, 0);
    for (const [x, y] of veins.cells) {
      const r = 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(176,176,176,0.65)');
      g.addColorStop(1, 'rgba(176,176,176,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    ctx.restore();
    // Strokes go to a tile and are blurred once: a filter left set blurs the whole surface per stroke.
    const tile = document.createElement('canvas');
    tile.width = vw;
    tile.height = h;
    const tc = tile.getContext('2d');
    if (!tc) return;
    tc.strokeStyle = '#575757';
    for (const q of veins.tertiaries) strokeTapered(tc, q, 3, 1.5, 6);
    tc.strokeStyle = '#424242';
    for (const q of veins.laterals) strokeTapered(tc, q, 9, 3);
    tc.strokeStyle = '#2b2b2b';
    strokeTapered(tc, veins.mid, 18, 5);
    ctx.filter = 'blur(2px)';
    ctx.drawImage(tile, k * vw, 0);
    ctx.filter = 'none';
  }
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 10;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** Tiling bark: grey-brown with deep vertical furrows and pale lenticels (map and bump). */
function drawBark(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
  ctx.fillStyle = '#6b5a4a';
  ctx.fillRect(0, 0, w, h);
  ctx.lineCap = 'butt';
  const streak = (x: number, light: boolean, lw: number, alpha: number): void => {
    const amp = 2 + rng() * 5;
    const freq = 1 + Math.floor(rng() * 3);
    const ph = rng() * Math.PI * 2;
    ctx.strokeStyle = light ? `rgba(152,133,110,${alpha.toFixed(2)})` : `rgba(44,33,25,${alpha.toFixed(2)})`;
    ctx.lineWidth = lw;
    for (const dx of [-w, 0, w]) {
      ctx.beginPath();
      for (let y = -8; y <= h + 8; y += 8) ctx.lineTo(x + dx + amp * Math.sin((y / h) * Math.PI * 2 * freq + ph), y);
      ctx.stroke();
    }
  };
  for (let i = 0; i < 130; i++) streak(rng() * w, rng() < 0.45, 1 + rng() * 7, 0.22 + rng() * 0.4);
  // A handful of deep, narrow furrows — the thing a bump map needs to catch a grazing light.
  for (let i = 0; i < 16; i++) streak(rng() * w, false, 1 + rng() * 2, 0.6 + rng() * 0.3);
  // Lenticels: varied in size and brightness, so a narrow strip is not a row of identical rivets.
  for (let i = 0; i < 44; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const lw = 3 + rng() * 9;
    const lh = 1.5 + rng() * 2;
    const pale = (0.3 + rng() * 0.35).toFixed(2);
    for (const dy of [-h, 0, h]) {
      for (const dx of [-w, 0, w]) {
        ctx.fillStyle = 'rgba(46,34,26,0.55)';
        ctx.beginPath();
        ctx.roundRect(x + dx - lw / 2, y + dy - lh / 2 + 1.5, lw, lh, 1);
        ctx.fill();
        ctx.fillStyle = `rgba(188,170,142,${pale})`;
        ctx.beginPath();
        ctx.roundRect(x + dx - lw / 2, y + dy - lh / 2, lw, lh, 1);
        ctx.fill();
      }
    }
  }
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 24;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** Linear (non-sRGB); used as bumpMap and roughnessMap, so the base stays near white or the clay greys. */
function drawGlaze(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 46; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 26 + rng() * 74;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const up = rng() < 0.5;
    g.addColorStop(0, up ? 'rgba(255,255,255,0.34)' : 'rgba(198,198,198,0.34)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // Throwing rings — horizontal in UV, i.e. running around the pot.
  ctx.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    const y = rng() * h;
    ctx.strokeStyle = rng() < 0.5 ? 'rgba(206,206,206,0.30)' : 'rgba(248,248,248,0.26)';
    ctx.lineWidth = 1 + rng() * 2.5;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) ctx.lineTo(x, y + Math.sin((x / w) * Math.PI * 2 + i) * 1.6);
    ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 22;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** The lathe's v runs foot → outside wall → rim → inside, so the ramp darkens the foot and the inside. */
function drawPotColor(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
  const ramp = ctx.createLinearGradient(0, h, 0, 0);
  ramp.addColorStop(0, '#8d5538');
  ramp.addColorStop(0.12, '#b06c48');
  ramp.addColorStop(0.3, '#d28b60');
  ramp.addColorStop(0.5, '#de9568');
  ramp.addColorStop(0.62, '#d9906a');
  ramp.addColorStop(0.73, '#e0a079');
  ramp.addColorStop(0.8, '#8a573c');
  ramp.addColorStop(1, '#5c3827');
  ctx.fillStyle = ramp;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 64; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 18 + rng() * 60;
    const warm = rng() < 0.55;
    for (const dx of [-w, 0, w]) {
      const g = ctx.createRadialGradient(x + dx, y, 0, x + dx, y, r);
      g.addColorStop(0, warm ? 'rgba(242,186,140,0.44)' : 'rgba(124,76,50,0.40)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x + dx - r, y - r, 2 * r, 2 * r);
    }
  }
  // Throwing bands run around the pot (horizontal in UV).
  ctx.lineCap = 'round';
  for (let i = 0; i < 13; i++) {
    const y = rng() * h;
    ctx.strokeStyle = rng() < 0.5 ? 'rgba(126,76,50,0.16)' : 'rgba(232,186,146,0.14)';
    ctx.lineWidth = 1 + rng() * 3;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) ctx.lineTo(x, y + Math.sin((x / w) * Math.PI * 2 + i) * 1.4);
    ctx.stroke();
  }
  // Iron speckle and the occasional lime blowout in the clay body.
  for (let i = 0; i < 340; i++) {
    const x = rng() * w;
    const y = rng() * h;
    ctx.fillStyle = rng() < 0.78 ? 'rgba(78,46,30,0.4)' : 'rgba(208,178,150,0.2)';
    ctx.beginPath();
    ctx.arc(x, y, 0.4 + rng() * 1.0, 0, Math.PI * 2);
    ctx.fill();
  }
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 12;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** Tiling potting compost; also the soil bump, without which a near-horizontal surface shows nothing. */
function drawSoil(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number): void {
  ctx.fillStyle = '#2b2018';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 44; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 14 + rng() * 38;
    const dry = rng() < 0.42;
    wrapped(x, y, r, w, h, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, dry ? 'rgba(108,80,54,0.38)' : 'rgba(12,9,6,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(px - r, py - r, 2 * r, 2 * r);
    });
  }
  for (let i = 0; i < 900; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = 1.2 + rng() * 4.2;
    const t = rng() * rng(); // mostly dark crumbs, a few pale dry ones
    const cr = Math.round(34 + t * 106);
    const cg = Math.round(25 + t * 84);
    const cb = Math.round(18 + t * 60);
    const ry = r * (0.55 + rng() * 0.6);
    const rot = rng() * Math.PI;
    const alpha = (0.45 + rng() * 0.5).toFixed(2);
    wrapped(x, y, r + 3, w, h, (px, py) => {
      ctx.fillStyle = 'rgba(6,4,3,0.55)';
      ctx.beginPath();
      ctx.ellipse(px + r * 0.4, py + ry * 0.55, r * 0.9, ry * 0.8, rot, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha})`;
      ctx.beginPath();
      ctx.ellipse(px, py, r, ry, rot, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 20;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function mat4(pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
}

/** Cylinder whose axis runs from a to b (radius rA at a, rB at b). */
function cylBetween(a: V3, b: V3, rA: number, rB: number, seg = 8): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const len = d.length();
  const g = cylinder(rB, rA, len, seg, false);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/** Direction vector from azimuth (0 = +Z, turning toward +X) and elevation above the horizon. */
function dirFrom(az: number, el: number): V3 {
  return v3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

/** u drift per unit of t, so one small bark tile never repeats as a column down the stem. */
const U_SKEW = 1.4;

/** Tube along a curve with a varying radius. UVs: u once around (plus a slow drift), v in metres / BARK_TILE. */
function taperedTube(
  curve: THREE.Curve<V3>,
  radiusAt: (t: number) => number,
  radial: number,
  tubular: number,
  lumpy = 0,
  phase = 0,
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(tubular, false);
  const len = curve.getLength();
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let rings = 0;
  const P = new THREE.Vector3();
  const addRing = (c: V3, N: V3, B: V3, radius: number, v: number, along: number, T?: V3, tilt = 0): void => {
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const p1 = 3 * a + phase + along * 5;
      const p2 = 5 * a - phase * 1.7 + along * 9;
      const lump = lumpy > 0 ? 1 + lumpy * (0.6 * Math.sin(p1) + 0.4 * Math.sin(p2)) : 1;
      const dLump = lumpy > 0 ? lumpy * (1.8 * Math.cos(p1) + 2.0 * Math.cos(p2)) : 0;
      const rr = radius * lump;
      const ux = N.x * ca + B.x * sa;
      const uy = N.y * ca + B.y * sa;
      const uz = N.z * ca + B.z * sa;
      pos.push(c.x + ux * rr, c.y + uy * rr, c.z + uz * rr);
      // Normal of the lumpy cross-section (polar curve: r·u − r′·u⊥), not the undisplaced radial one.
      const wx = -N.x * sa + B.x * ca;
      const wy = -N.y * sa + B.y * ca;
      const wz = -N.z * sa + B.z * ca;
      const dr = radius * dLump;
      let n = v3(ux * rr - wx * dr, uy * rr - wy * dr, uz * rr - wz * dr).normalize();
      if (T && tilt > 0) n = n.multiplyScalar(1 - tilt).addScaledVector(T, tilt).normalize();
      nor.push(n.x, n.y, n.z);
      uv.push(j / radial + along * U_SKEW, v);
    }
    rings++;
  };
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    curve.getPointAt(t, P);
    addRing(P, frames.normals[i], frames.binormals[i], radiusAt(t), (t * len) / BARK_TILE, t);
  }
  // Rounded end cap.
  const T = frames.tangents[tubular];
  const r0 = radiusAt(1);
  for (const phi of [30, 60, 88]) {
    const c = P.clone().addScaledVector(T, r0 * Math.sin(phi * DEG));
    addRing(c, frames.normals[tubular], frames.binormals[tubular], r0 * Math.cos(phi * DEG), len / BARK_TILE + 0.05, 1, T, Math.sin(phi * DEG));
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      const c = a + 1;
      const d = b + 1;
      idx.push(a, c, b, c, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Point on a (monotonically rising) curve at world height y. */
function pointAtHeight(curve: THREE.Curve<V3>, y: number, samples = 240): V3 {
  let prev = curve.getPointAt(0);
  for (let i = 1; i <= samples; i++) {
    const p = curve.getPointAt(i / samples);
    if (p.y >= y) {
      const f = (y - prev.y) / Math.max(1e-6, p.y - prev.y);
      return prev.clone().lerp(p, f);
    }
    prev = p;
  }
  return prev;
}

/** Soil surface height at radius rho: concave dish with a small mound around the trunk. */
function soilY(rho: number): number {
  const f = rho / SOIL_R;
  return SOIL_RIM_Y - SOIL_DEPTH * (1 - f * f) + 0.008 * Math.exp(-(rho * rho) / (0.05 * 0.05));
}

function soilGeometry(rng: () => number): THREE.BufferGeometry {
  const seg = 64;
  const rings = 13;
  // Clods big enough to cast their own shadow; vertex jitter alone only makes the surface noisy.
  const clods = Array.from({ length: 15 }, () => {
    const rho = 0.02 + rng() * 0.12;
    const a = rng() * Math.PI * 2;
    return { x: Math.sin(a) * rho, z: Math.cos(a) * rho, r: 0.011 + rng() * 0.015, hgt: 0.005 + rng() * 0.008 };
  });
  const relief = (x: number, z: number): number => {
    let b = 0;
    for (const c of clods) {
      const dx = x - c.x;
      const dz = z - c.z;
      b += c.hgt * Math.exp(-(dx * dx + dz * dz) / (c.r * c.r));
    }
    return b;
  };
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  pos.push(0, soilY(0) + relief(0, 0), 0);
  uv.push(0.5, 0.5);
  for (let k = 1; k <= rings; k++) {
    const f = k / rings;
    const fade = 1 - f ** 8; // the outermost ring stays flat against the pot wall
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const rho = SOIL_R * f + (rng() - 0.5) * 0.009 * fade;
      const x = Math.sin(a) * rho;
      const z = Math.cos(a) * rho;
      const y = soilY(rho) + (relief(x, z) + (rng() - 0.5) * 0.011) * fade;
      pos.push(x, y, z);
      uv.push(0.5 + Math.sin(a) * f * 0.5, 0.5 + Math.cos(a) * f * 0.5);
    }
  }
  const at = (k: number, j: number): number => 1 + (k - 1) * seg + (j % seg);
  for (let j = 0; j < seg; j++) idx.push(0, at(1, j), at(1, j + 1));
  for (let k = 2; k <= rings; k++) {
    for (let j = 0; j < seg; j++) {
      const i0 = at(k - 1, j);
      const i1 = at(k - 1, j + 1);
      const o0 = at(k, j);
      const o1 = at(k, j + 1);
      idx.push(i0, o0, o1, i0, o1, i1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** One torn mulch flake: a rounded box with 0..1 UVs averages the bark tile to flat cardboard brown. */
function chipGeometry(rng: () => number, size: number, th: number, tint: THREE.Color): THREE.BufferGeometry {
  const n = 5 + Math.floor(rng() * 3);
  const u0 = rng() * 0.85;
  const v0 = rng() * 0.85;
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5 + (rng() - 0.5) * 0.7) * Math.PI * 2) / n;
    const r = size * (0.35 + rng() * 0.65);
    px.push(Math.cos(a) * r);
    pz.push(Math.sin(a) * r * 0.62);
    py.push(th * (0.5 - rng() * 0.55));
  }
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const push = (x: number, y: number, z: number): void => {
    pos.push(x, y, z);
    uv.push(u0 + (x / (2 * size) + 0.5) * 0.15, v0 + (z / (2 * size) + 0.5) * 0.15);
    col.push(tint.r, tint.g, tint.b);
  };
  push(0, th * 0.55, 0);
  for (let i = 0; i < n; i++) push(px[i], py[i], pz[i]);
  push(0, -th * 0.5, 0);
  for (let i = 0; i < n; i++) push(px[i] * 0.78, -th * 0.5, pz[i] * 0.78);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(0, 1 + j, 1 + i);
    idx.push(n + 1, n + 2 + i, n + 2 + j);
    idx.push(1 + i, 1 + j, n + 2 + i, 1 + j, n + 2 + j, n + 2 + i);
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

interface LeafSpec {
  base: V3; // petiole end = blade base
  dir: V3; // blade axis direction
  roll: number;
  L: number; // length
  W: number; // width
  droop: number; // tip drop as a fraction of L
  cup: number; // edge rise (m)
  arch: number; // out-of-plane bow along the midrib (m)
  twist: number; // m
  waveAmp: number;
  waveFreq: number;
  wavePhase: number;
  tint: THREE.Color; // per-leaf vertex-colour multiplier — no two leaves the same green
  variant: number; // which blade on the shared canvas
  flip: boolean; // mirror u so the vein pattern is not visibly repeated
}

/** Blade base sunk back along −dir so it covers the petiole's end cap. */
const BLADE_SINK = 0.012;

/** One violin leaf as a bent 12 × 18 grid in world space (the outline comes from the alpha map). */
function leafGeometry(sp: LeafSpec): THREE.BufferGeometry {
  const NX = 12;
  const NZ = 18;
  const d = sp.dir.clone().normalize();
  let n = UP.clone().sub(d.clone().multiplyScalar(UP.dot(d)));
  if (n.lengthSq() < 1e-6) n = v3(1, 0, 0);
  n.normalize();
  const r = n.clone().cross(d).normalize(); // x = y × z
  const cr = Math.cos(sp.roll);
  const sr = Math.sin(sp.roll);
  const r2 = r.clone().multiplyScalar(cr).addScaledVector(n, sr);
  const n2 = n.clone().multiplyScalar(cr).addScaledVector(r, -sr);
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= NZ; j++) {
    const s = j / NZ;
    for (let i = 0; i <= NX; i++) {
      const t = (i / NX) * 2 - 1;
      const x = t * sp.W * 0.5;
      const z = lerp(-BLADE_SINK, sp.L, s);
      // Out-of-plane shaping in the blade's own frame; a ruled plane reads as a sticker.
      let y = sp.cup * t * t * (0.6 + 0.4 * s);
      y += sp.arch * Math.sin(Math.PI * s);
      y += sp.twist * t * s;
      // The two halves of a fig lamina rise and fall along the midrib at a different phase.
      y += sp.cup * 0.55 * t * Math.sin(Math.PI * s * 1.7 + sp.wavePhase);
      y += sp.waveAmp * Math.sin(s * sp.waveFreq + sp.wavePhase + t * 0.6) * t * t * t * t;
      const p = sp.base.clone().addScaledVector(r2, x).addScaledVector(n2, y).addScaledVector(d, z);
      // Gravity acts in WORLD space, so a blade rolled 60° still hangs instead of swinging sideways.
      p.y -= sp.droop * sp.L * s * s;
      pos.push(p.x, p.y, p.z);
      const u = (t + 1) / 2;
      uv.push((sp.variant + (sp.flip ? 1 - u : u)) / LEAF_VARIANTS, s);
      const k = 0.95 + 0.1 * s; // the tip of a blade is a shade lighter than its base
      col.push(sp.tint.r * k, sp.tint.g * k, sp.tint.b * k);
    }
  }
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i;
      const b = a + NX + 1;
      const c = a + 1;
      const dd = b + 1;
      idx.push(a, b, c, c, b, dd);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export function create(ctx: SceneContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'plant';
  const rng = createRng(ctx.seed + 7301);
  const jit = (amt: number): number => (rng() - 0.5) * 2 * amt;
  const M = ctx.materials;

  const leafMap = ctx.textures.canvas('plant:leaf', 1024, 1024, (c, w, h) => drawLeafColor(c, w, h, createRng(11)), true);
  const leafBump = ctx.textures.canvas('plant:leafBump', 1024, 1024, (c, w, h) => drawLeafBump(c, w, h, createRng(12)), false);
  const barkTex = ctx.textures.canvas('plant:bark', 256, 512, (c, w, h) => drawBark(c, w, h, createRng(13)), true);
  barkTex.wrapS = THREE.RepeatWrapping;
  barkTex.wrapT = THREE.RepeatWrapping;
  barkTex.needsUpdate = true;
  const glazeTex = ctx.textures.canvas('plant:glaze', 256, 256, (c, w, h) => drawGlaze(c, w, h, createRng(14)), false);
  const potTex = ctx.textures.canvas('plant:potColor', 256, 256, (c, w, h) => drawPotColor(c, w, h, createRng(15)), true);
  potTex.wrapS = THREE.RepeatWrapping;
  potTex.needsUpdate = true;
  const soilTex = ctx.textures.canvas('plant:soil', 256, 256, (c, w, h) => drawSoil(c, w, h, createRng(16)), true);
  soilTex.wrapS = THREE.RepeatWrapping;
  soilTex.wrapT = THREE.RepeatWrapping;
  soilTex.repeat.set(3, 3);
  soilTex.needsUpdate = true;

  const potMat = M.custom({
    color: 0xffffff,
    map: potTex,
    metalness: 0,
    roughness: 1,
    roughnessMap: glazeTex,
    bumpMap: glazeTex,
    bumpScale: 0.0012,
    // A strong environment term washes fired clay grey and it stops reading as ceramic.
    envMapIntensity: 0.45,
  });
  const saucerMat = M.custom({
    color: 0xfff0e4, // the same clay from a slightly different firing
    map: potTex,
    metalness: 0,
    roughness: 1,
    roughnessMap: glazeTex,
    bumpMap: glazeTex,
    bumpScale: 0.001,
    envMapIntensity: 0.45,
  });
  const soilMat = M.custom({ color: 0xffffff, map: soilTex, metalness: 0, roughness: 1, bumpMap: soilTex, bumpScale: 0.009 });
  const chipMat = M.custom({
    color: 0xcaa87e,
    map: barkTex,
    bumpMap: barkTex,
    bumpScale: 0.0015,
    metalness: 0,
    roughness: 0.95,
    vertexColors: true,
  });
  const barkMat = M.custom({
    color: 0xffffff,
    map: barkTex,
    bumpMap: barkTex,
    bumpScale: 0.005,
    metalness: 0,
    roughness: 0.96,
    // Left at 1 the sky lays a specular sheen down the whole stem and greys the bark out.
    envMapIntensity: 0.26,
  });
  const leafMat = M.custom({
    color: 0xffffff,
    map: leafMap,
    bumpMap: leafBump,
    bumpScale: 0.0055,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    metalness: 0,
    // One shared texture would otherwise give all 33 leaves the identical green.
    vertexColors: true,
    // Waxy, not chrome: at grazing incidence Fresnel drives any specular term to 1 and the blade silvers.
    roughness: 0.66,
    clearcoat: 0.05,
    clearcoatRoughness: 0.75,
    envMapIntensity: 0.2,
    specularIntensity: 0.28,
    // Cheap stand-in for the light a thin blade transmits, so the shaded side is not a black silhouette.
    emissive: 0xe6ffb4,
    emissiveMap: leafMap,
    emissiveIntensity: 0.19,
  });

  // A lathe's v is the profile index, so long straight runs are subdivided or the clay smears into streaks.
  const saucerProfile: Array<[number, number]> = [
    [0, 0], [0.10, 0], [0.202, 0], [0.218, 0.004], [0.226, 0.016], [0.227, 0.040], [0.221, 0.048],
    [0.212, 0.047], [0.208, 0.030], [0.206, SAUCER_FLOOR], [0.14, SAUCER_FLOOR], [0.07, SAUCER_FLOOR], [0, SAUCER_FLOOR],
  ];
  group.add(mesh(lathe(saucerProfile, 64), saucerMat, undefined, { name: 'saucer' }));

  const potProfile: Array<[number, number]> = [
    [0, 0], [0.136, 0], [0.15, 0.007], [0.151, 0.02],
    [0.1546, 0.061], [0.1583, 0.103], [0.1619, 0.144], [0.1655, 0.185], [0.1691, 0.226], [0.1728, 0.268], [0.1764, 0.309], [0.18, 0.35],
    [0.185, 0.36], [0.185, 0.372], [0.18, 0.378], [0.172, POT_H],
    [0.164, 0.378], [0.16, 0.37], [0.159, 0.352], [0.154, 0.3], [0, 0.3],
  ];
  const potGeo = lathe(potProfile, 64);
  potGeo.translate(0, SAUCER_FLOOR, 0);
  group.add(mesh(potGeo, potMat, undefined, { name: 'pot' }));

  group.add(mesh(soilGeometry(rng), soilMat, undefined, { name: 'soil' }));
  const chipGeos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 22; i++) {
    const rho = 0.03 + rng() * 0.112;
    const a = rng() * Math.PI * 2;
    const th = 0.004 + rng() * 0.004;
    const k = 0.85 + rng() * 0.75;
    const tint = new THREE.Color(k * (0.92 + rng() * 0.22), k, k * (0.82 + rng() * 0.16));
    const g = chipGeometry(rng, 0.013 + rng() * 0.015, th, tint);
    // A real mulch scatter has chips propped on each other and half-buried, not tiles laid flat.
    g.applyMatrix4(mat4([Math.sin(a) * rho, soilY(rho) + th * (rng() * 0.6 - 0.1), Math.cos(a) * rho], [jit(28 * DEG), rng() * Math.PI, jit(28 * DEG)]));
    chipGeos.push(g);
  }
  const chips = mergeGeometries(chipGeos, false);
  if (chips) group.add(mesh(chips, chipMat, undefined, { name: 'barkChips' }));

  // A ~6° lean plus a shallow S below the first branch, so the lower stem is not a dowel.
  const leanAz = 0.75 + jit(0.5);
  const lean = v3(Math.sin(leanAz), 0, Math.cos(leanAz));
  const side0 = v3(Math.cos(leanAz), 0, -Math.sin(leanAz));
  const trunkNodes: Array<[number, number, number]> = [
    // [height, offset along the lean, offset across it]
    [TRUNK_BASE_Y, 0.020, 0.004],
    [0.44, -0.034, 0.020],
    [0.60, -0.030, -0.008],
    [0.76, 0.006, -0.032],
    [0.94, 0.050, -0.022],
    [1.10, 0.080, 0.012],
    [1.24, 0.094, 0.034],
    [TRUNK_TOP_Y, 0.100, 0.030],
  ];
  const trunkPts = trunkNodes.map(([y, a, b], i) =>
    lean
      .clone()
      .multiplyScalar(a + (i === 0 ? 0 : jit(0.006)))
      .addScaledVector(side0, b + (i === 0 ? 0 : jit(0.006)))
      .setY(y),
  );
  const trunkCurve = new THREE.CatmullRomCurve3(trunkPts, false, 'catmullrom', 0.5);
  const soilLineT = (() => {
    for (let i = 0; i <= 200; i++) if (trunkCurve.getPointAt(i / 200).y >= soilY(0)) return i / 200;
    return 0;
  })();
  // The stem swells where it enters the compost and is back to its normal taper 3 cm higher.
  const trunkRadius = (t: number): number =>
    0.009 + 0.008 * (1 - t) + 0.0065 * Math.max(0, 1 - Math.max(0, t - soilLineT) / 0.03) ** 1.7;
  const barkGeos: THREE.BufferGeometry[] = [taperedTube(trunkCurve, trunkRadius, 14, 44, 0.06, rng() * 6.28)];

  // Two low roots breaking the surface beside the flare and diving back under.
  const rootBase = pointAtHeight(trunkCurve, soilY(0) + 0.004);
  for (const turn of [2.1, -1.5]) {
    const a = leanAz + turn + jit(0.4);
    const dirR = v3(Math.sin(a), 0, Math.cos(a));
    const reach = 0.055 + rng() * 0.035;
    const pts = [0, 1, 2, 3].map((k) => {
      const f = k / 3;
      const rho = 0.016 + f * reach;
      return rootBase.clone().addScaledVector(dirR, rho).setY(soilY(rho) - 0.001 - f * f * 0.016);
    });
    const rootCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    barkGeos.push(taperedTube(rootCurve, (t) => lerp(0.0095, 0.003, t), 10, 12, 0.2, rng() * 6.28));
  }

  const az0 = rng() * Math.PI * 2;
  // Elevations deliberately not laddered: a steep branch beside a flat one breaks the stacked-shelves read.
  const branchHeights = [0.72, 0.84, 0.94, 1.04, 1.13, 1.22, 1.30];
  const branchLengths = [0.26, 0.245, 0.23, 0.215, 0.20, 0.185, 0.16];
  const branchElev = [30, 48, 34, 56, 40, 50, 32];
  const branchRise = [26, 11, 22, 7, 18, 9, 21];
  const branches: THREE.CatmullRomCurve3[] = [];
  branchHeights.forEach((h0, i) => {
    const h = h0 + jit(0.05);
    const az = az0 + i * 137.5 * DEG + jit(34 * DEG);
    const L = branchLengths[i] + jit(0.025);
    const e0 = (branchElev[i] + jit(8)) * DEG;
    const rise = (branchRise[i] + jit(5)) * DEG;
    const side = v3(Math.cos(az), 0, -Math.sin(az));
    const wob = jit(0.14);
    const pts = [pointAtHeight(trunkCurve, h)];
    let p = pts[0].clone();
    const steps = 5;
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      const e = e0 + f * rise;
      const seg = L / steps;
      p = p.clone().addScaledVector(dirFrom(az, e), seg).addScaledVector(side, Math.sin(f * Math.PI) * wob * seg);
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    branches.push(curve);
    barkGeos.push(taperedTube(curve, (t) => lerp(0.0075, 0.0028, t), 10, 24, 0.03, rng() * 6.28));
  });

  const leafGeos: THREE.BufferGeometry[] = [];
  const addLeaf = (node: V3, dir: V3, o: { L: number; droop?: number; cup?: number; young?: boolean }): void => {
    const d = dir.clone().normalize();
    const petiole = o.young ? 0.02 : 0.035 + rng() * 0.03;
    const base = node.clone().addScaledVector(d, petiole);
    // Stops at the blade base: any overshoot shows as a bare twig when the blade rolls or droops.
    barkGeos.push(cylBetween(node, base.clone().addScaledVector(d, 0.004), 0.0032, 0.0026, 8));
    const L = o.L;
    // A signed 25–70° roll turns the broad face outward on about half the canopy.
    const roll = (rng() < 0.5 ? -1 : 1) * (25 + rng() * 45) * DEG;
    // Older leaves low in the canopy are darker and bluer, young ones at the tips paler and yellower.
    const age = clamp01((base.y - 0.7) / 0.7); // 0 = low/old, 1 = high/young
    const shade = 0.76 + age * 0.16 + rng() * 0.22 + (o.young ? 0.1 : 0);
    const warm = age * 0.05 + jit(0.035) + (o.young ? 0.05 : 0);
    leafGeos.push(
      leafGeometry({
        base,
        dir: d,
        roll,
        L,
        W: L * (0.63 + jit(0.05)),
        droop: o.droop ?? 0.2 + rng() * 0.18,
        cup: o.cup ?? 0.026 + rng() * 0.024,
        arch: jit(0.026),
        twist: jit(0.022),
        waveAmp: 0.006 + rng() * 0.009,
        waveFreq: (2.5 + rng()) * Math.PI,
        wavePhase: rng() * Math.PI * 2,
        tint: new THREE.Color(shade * (1 + warm), shade, shade * (1 - warm * 1.1)),
        variant: rng() < 0.5 ? 0 : 1,
        flip: rng() < 0.5,
      }),
    );
  };
  const sizeAt = (y: number): number => lerp(0.33, 0.265, clamp01((y - 0.7) / 0.68)) + jit(0.018);

  // Along the branches: alternate sides, bigger and flatter lower down, small upright tip leaf.
  const leafCounts = [5, 4, 4, 4, 4, 3, 3];
  branches.forEach((br, bi) => {
    const n = leafCounts[bi];
    for (let k = 0; k < n; k++) {
      const s = 0.3 + 0.7 * (k / (n - 1)) ** 0.9;
      const node = br.getPointAt(s);
      const tan = br.getTangentAt(s);
      const azT = Math.atan2(tan.x, tan.z);
      const tip = k === n - 1;
      const side = (k % 2 === 0 ? 1 : -1) * (rng() < 0.15 ? -1 : 1);
      const az = tip ? azT + side * (15 + rng() * 15) * DEG : azT + side * (40 + rng() * 30) * DEG;
      const e = tip ? (48 + rng() * 14) * DEG : lerp(16, 34, s) * DEG + jit(9 * DEG) - (bi === 0 ? 6 * DEG : 0);
      const L = sizeAt(node.y) * (tip ? 0.85 : 1);
      addLeaf(node, dirFrom(az, e), { L, droop: tip ? 0.12 + rng() * 0.08 : undefined });
    }
  });
  // Directly on the upper trunk, between the branch nodes.
  [1.0, 1.09, 1.18, 1.27].forEach((h, j) => {
    const p = pointAtHeight(trunkCurve, h + jit(0.015));
    const az = az0 + (70 + j * 137.5) * DEG + jit(25 * DEG);
    addLeaf(p, dirFrom(az, (28 + rng() * 16) * DEG), { L: sizeAt(p.y) });
  });
  // Crown: one rising leaf and one furled young leaf at the very top.
  const top = trunkCurve.getPointAt(0.985);
  addLeaf(top, dirFrom(az0 + 200 * DEG + jit(30 * DEG), 56 * DEG), { L: 0.26, droop: 0.15 });
  addLeaf(top.clone().add(v3(0, 0.01, 0)), dirFrom(az0 + 320 * DEG + jit(30 * DEG), 72 * DEG), { L: 0.2, droop: 0.1, cup: 0.028, young: true });

  const bark = mergeGeometries(barkGeos, false);
  if (bark) group.add(mesh(bark, barkMat, undefined, { name: 'trunk' }));
  const leaves = mergeGeometries(leafGeos, false);
  if (leaves) group.add(mesh(leaves, leafMat, undefined, { name: 'leaves' }));
  console.log(`[module] plant: ${leafGeos.length} leaves, ${branches.length} branches`);

  return group;
}
