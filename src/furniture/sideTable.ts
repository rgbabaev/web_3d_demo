// Origin on the floor at the centre of the footprint; rotation only swings the objects on top.
import * as THREE from 'three';
import { cylinder, lathe, mergeGeometries, mesh, roundedBox } from '../core/geometry';
import { createRng } from '../core/noise';
import type { SceneContext } from '../core/types';

const TOP_R = 0.225; // 0.45 m diameter
const TOP_T = 0.02; // 20 mm slab
const TABLE_H = 0.55;
const TOP_Y = TABLE_H; // top surface — everything on the table sits here
const TOP_UNDER = TABLE_H - TOP_T; // 0.53

const ROD_R = 0.005; // 10 mm steel leg rod
const RING_ROD_R = 0.004; // 8 mm tie ring
const RING_Y = 0.125;
const FOOT_H = 0.007;
const PLATE_R = 0.055;
const PLATE_T = 0.005;
const LEG_ANGLES = [Math.PI / 2, Math.PI / 2 + (2 * Math.PI) / 3, Math.PI / 2 + (4 * Math.PI) / 3];

const BOOK_W = 0.11;
const BOOK_T = 0.02;
const BOOK_D = 0.18;

const VASE_H = 0.28;
const COASTER_R = 0.048;
const COASTER_T = 0.006;
const GLASS_H = 0.1;

// Where the three dressings stand on the top (x, z from the table centre).
const VASE_POS: [number, number] = [-0.07, -0.1];
const COASTER_POS: [number, number] = [0.105, 0.025];
const BOOK_POS: [number, number] = [-0.06, 0.075];

const SERIF = '"Liberation Serif", "FreeSerif", "DejaVu Serif", Georgia, serif';
const SANS = '"Liberation Sans", "FreeSans", "DejaVu Sans", Helvetica, Arial, sans-serif';

/** Merge geometries sharing a material. RoundedBox is non-indexed and mergeGeometries refuses a mixed list. */
function unify(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('sideTable: mergeGeometries failed (incompatible attributes)');
  for (const p of parts) if (!geoms.includes(p)) p.dispose();
  for (const g of geoms) g.dispose();
  return merged;
}

/** Planar UVs for a lathed disc: the radial coordinate is profile arc length, `size` the metres a UV square covers. */
function discUv(geo: THREE.BufferGeometry, profile: Array<[number, number]>, size: number, rotation = 0): void {
  const last = profile.length - 1;
  const rho = new Float64Array(profile.length);
  for (let j = last - 1; j >= 0; j--) {
    rho[j] = rho[j + 1] + Math.hypot(profile[j + 1][0] - profile[j][0], profile[j + 1][1] - profile[j][1]);
  }
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    // LatheGeometry's v is the profile index — what ties a vertex to its arc length.
    const k = r > 1e-6 ? rho[Math.round(uv.getY(i) * last)] / r : 0;
    const px = x * k;
    const pz = z * k;
    uv.setXY(i, (px * c - pz * s) / size + 0.5, (px * s + pz * c) / size + 0.5);
  }
  uv.needsUpdate = true;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squeeze a geometry's 0..1 UVs into one pixel rect of an atlas (canvas coords, bleed guard). */
function mapUvToRect(geo: THREE.BufferGeometry, rect: Rect, texW: number, texH: number): void {
  const pad = 2;
  const u0 = (rect.x + pad) / texW;
  const u1 = (rect.x + rect.w - pad) / texW;
  // CanvasTexture is flipped, so canvas row 0 is v = 1.
  const v1 = 1 - (rect.y + pad) / texH;
  const v0 = 1 - (rect.y + rect.h - pad) / texH;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
}

function polar(angle: number, radius: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
}

/** TubeGeometry with a varying radius — a dried stem is 2.2 mm at the cut and under 1 mm at the tip. */
function taperedTube(
  curve: THREE.Curve<THREE.Vector3>,
  tubular: number,
  radial: number,
  radiusAt: (t: number) => number,
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(tubular, false);
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    const p = curve.getPointAt(t);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    const r = radiusAt(t);
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      const nx = cos * N.x + sin * B.x;
      const ny = cos * N.y + sin * B.y;
      const nz = cos * N.z + sin * B.z;
      normal.push(nx, ny, nz);
      position.push(p.x + r * nx, p.y + r * ny, p.z + r * nz);
      uv.push(t, j / radial);
    }
  }
  for (let i = 1; i <= tubular; i++) {
    for (let j = 1; j <= radial; j++) {
      const a = (radial + 1) * (i - 1) + (j - 1);
      const b = (radial + 1) * i + (j - 1);
      const c = (radial + 1) * i + j;
      const d = (radial + 1) * (i - 1) + j;
      index.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(index);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

/** Smallest arc-length parameter whose point is at or above `y`. */
function tAboveHeight(curve: THREE.Curve<THREE.Vector3>, y: number, steps = 240): number {
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (curve.getPointAt(t).y >= y) return t;
  }
  return 1;
}

/** The leg's path: splayed and gently curved, tucked 34 mm inside the top's edge. */
function legCurve(angle: number): THREE.CatmullRomCurve3 {
  const profile: Array<[number, number]> = [
    [0.044, TOP_UNDER + 0.006],
    [0.062, 0.47],
    [0.092, 0.38],
    [0.132, 0.25],
    [0.166, 0.13],
    [0.186, 0.035],
    [0.191, 0.003],
  ];
  return new THREE.CatmullRomCurve3(
    profile.map(([r, y]) => polar(angle, r, y)),
    false,
    'catmullrom',
    0.5,
  );
}

/** Horizontal radius of a curve where it crosses height `y`. */
function radiusAtHeight(curve: THREE.CatmullRomCurve3, y: number): number {
  const pts = curve.getPoints(180);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.y !== b.y && (a.y - y) * (b.y - y) <= 0) {
      const p = a.clone().lerp(b, (y - a.y) / (b.y - a.y));
      return Math.hypot(p.x, p.z);
    }
  }
  return Math.hypot(pts[0].x, pts[0].z);
}

/** 20 mm slab with a 6 mm bull-nose top and bottom. */
function topProfile(): Array<[number, number]> {
  const r = 0.006;
  const pts: Array<[number, number]> = [[0, 0], [TOP_R - r, 0]];
  for (let i = 1; i <= 3; i++) {
    const a = (i / 4) * (Math.PI / 2);
    pts.push([TOP_R - r + Math.sin(a) * r, r - Math.cos(a) * r]);
  }
  pts.push([TOP_R, r], [TOP_R, TOP_T - r]);
  for (let i = 1; i <= 3; i++) {
    const a = (i / 4) * (Math.PI / 2);
    pts.push([TOP_R - r + Math.cos(a) * r, TOP_T - r + Math.sin(a) * r]);
  }
  pts.push([TOP_R - r, TOP_T], [0, TOP_T]);
  return pts;
}

/** Slim mounting disc welded to the leg tops, screwed up into the slab. */
function plateProfile(): Array<[number, number]> {
  return [
    [0, 0],
    [PLATE_R - 0.003, 0],
    [PLATE_R, 0.0015],
    [PLATE_R, PLATE_T - 0.0015],
    [PLATE_R - 0.003, PLATE_T],
    [0, PLATE_T],
  ];
}

/** Tall matte stoneware vase, 0.28 m: soft shoulder, narrow neck, 3 mm rim. */
function vaseProfile(): Array<[number, number]> {
  return [
    [0, 0.0025],
    [0.0215, 0.0025],
    [0.0275, 0],
    [0.0315, 0.004],
    [0.0375, 0.028],
    [0.0452, 0.072],
    [0.0498, 0.114],
    [0.0482, 0.156],
    [0.0422, 0.196],
    [0.0362, 0.236],
    [0.0336, 0.266],
    [0.0342, 0.2775],
    [0.0332, 0.2805],
    [0.0312, 0.2805],
    [0.0304, 0.2765],
    [0.029, 0.258],
    [0.0312, 0.228],
    [0.036, 0.178],
    [0.0398, 0.1],
    [0.0318, 0.03],
    [0.026, 0.02],
    [0, 0.018],
  ];
}

/** Straight-sided tumbler, 2 mm wall, 6 mm base. */
function glassProfile(): Array<[number, number]> {
  return [
    [0, 0],
    [0.0215, 0],
    [0.0252, 0.0016],
    [0.0266, 0.005],
    [0.0284, 0.03],
    [0.0302, 0.07],
    [0.0314, 0.0985],
    [0.0316, 0.0995],
    [0.0312, 0.1002],
    [0.0304, 0.1005],
    [0.0296, 0.1002],
    [0.0294, 0.0985],
    [0.0282, 0.07],
    [0.0264, 0.03],
    [0.0247, 0.0095],
    [0.0224, 0.0072],
    [0.016, 0.0062],
    [0, 0.006],
  ];
}

/** Water body: follows the inside wall 0.2 mm clear, open at the top (the surface is its own mesh). */
function waterProfile(level: number): Array<[number, number]> {
  return [
    [0, 0.0063],
    [0.0155, 0.0065],
    [0.0222, 0.0075],
    [0.0245, 0.0098],
    [0.0262, 0.03],
    [0.0272, level],
  ];
}

/** Pampas plume: a soft tapered spindle. */
function plumeProfile(h: number, r: number): Array<[number, number]> {
  return [
    [0, 0],
    [r * 0.42, h * 0.07],
    [r * 0.86, h * 0.22],
    [r, h * 0.42],
    [r * 0.88, h * 0.64],
    [r * 0.55, h * 0.85],
    [r * 0.2, h * 0.96],
    [0, h],
  ];
}

/** Cork coaster: 96 mm disc, 6 mm thick, chamfered. */
function coasterProfile(): Array<[number, number]> {
  return [
    [0, 0],
    [COASTER_R - 0.0025, 0],
    [COASTER_R, 0.0018],
    [COASTER_R, COASTER_T - 0.0018],
    [COASTER_R - 0.0025, COASTER_T],
    [0, COASTER_T],
  ];
}

// Leaf atlas: 2 × 4 cells of 128 px — four eucalyptus blades, two pampas fronds, two fallen blades.
const ATLAS_W = 256;
const ATLAS_H = 512;
const ATLAS_CELL = 128;

/** UV rect of atlas cell `i` (0..5). */
function atlasCell(i: number): Rect {
  return { x: (i % 2) * ATLAS_CELL, y: Math.floor(i / 2) * ATLAS_CELL, w: ATLAS_CELL, h: ATLAS_CELL };
}

/** One feathery pampas frond. Every hair starts on the rachis: a detached mark floats free one mip up. */
function drawFrond(c: CanvasRenderingContext2D, cell: number, hairs: number, spread: number, seed: number): void {
  const rng = createRng(seed);
  const my = cell * 0.5;
  const x0 = cell * 0.03;
  const x1 = cell * 0.78; // hairs sweep forward from here, so the tip lands near 0.98
  // envelope: widest a third of the way up, tapering to the tip
  const env = (u: number): number => Math.sin(Math.min(1, u * 1.15) * Math.PI * 0.9) * (1 - u * 0.3);

  const core = new Path2D();
  const cx1 = cell * 0.72;
  core.moveTo(x0, my);
  for (let i = 0; i <= 16; i++) core.lineTo(x0 + (cx1 - x0) * (i / 16), my - cell * spread * 0.16 * env(i / 16));
  for (let i = 16; i >= 0; i--) core.lineTo(x0 + (cx1 - x0) * (i / 16), my + cell * spread * 0.16 * env(i / 16));
  core.closePath();
  c.fillStyle = 'rgba(226,212,182,0.42)';
  c.fill(core);

  c.lineCap = 'round';
  for (let i = 0; i < hairs; i++) {
    const u = Math.pow((i + rng()) / hairs, 0.8);
    const sx = x0 + (x1 - x0) * u;
    const s = rng() < 0.5 ? -1 : 1;
    const len = cell * spread * env(u) * (0.5 + rng() * 0.74);
    const fwd = cell * (0.06 + rng() * 0.14);
    const tone = rng();
    c.strokeStyle =
      tone < 0.34 ? 'rgba(212,194,158,0.9)' : tone < 0.72 ? 'rgba(238,226,200,0.96)' : 'rgba(186,163,124,0.85)';
    c.lineWidth = 1.25 + rng() * 0.75;
    c.beginPath();
    c.moveTo(sx - fwd * 0.25, my);
    c.quadraticCurveTo(sx + fwd * 0.4, my + s * len * 0.5, sx + fwd, my + s * len);
    c.stroke();
  }
  // the rachis itself
  c.strokeStyle = 'rgba(205,185,146,0.95)';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(x0, my);
  c.lineTo(cell * 0.78, my);
  c.stroke();
}

interface LeafVariant {
  base: string;
  tip: string;
  vein: string;
  half: number;
  len: number;
  mottle: string;
}

/** One alpha cut-out blade, drawn into the cell the context is translated to. */
function drawLeaf(c: CanvasRenderingContext2D, cell: number, v: LeafVariant, rng: () => number): void {
  const x0 = cell * 0.05;
  const x1 = cell * v.len;
  const my = cell * 0.5;
  const half = cell * v.half;
  const leaf = new Path2D();
  leaf.moveTo(x0, my);
  leaf.bezierCurveTo(x0 + (x1 - x0) * 0.22, my - half, x0 + (x1 - x0) * 0.66, my - half * 0.92, x1, my - cell * 0.012);
  leaf.bezierCurveTo(x1 + cell * 0.01, my, x1 + cell * 0.01, my, x1, my + cell * 0.012);
  leaf.bezierCurveTo(x0 + (x1 - x0) * 0.66, my + half * 0.92, x0 + (x1 - x0) * 0.22, my + half, x0, my);
  const grad = c.createLinearGradient(x0, 0, x1, 0);
  grad.addColorStop(0, v.base);
  grad.addColorStop(0.62, v.base);
  grad.addColorStop(1, v.tip);
  c.fillStyle = grad;
  c.fill(leaf);

  c.save();
  c.clip(leaf);
  // The dried edge is a gradient inward, not a stroke: a drawn rim survives minification as a border.
  const rim = c.createLinearGradient(0, my - half, 0, my + half);
  rim.addColorStop(0, 'rgba(150,126,86,0.34)');
  rim.addColorStop(0.3, 'rgba(150,126,86,0)');
  rim.addColorStop(0.7, 'rgba(150,126,86,0)');
  rim.addColorStop(1, 'rgba(150,126,86,0.34)');
  c.fillStyle = rim;
  c.fillRect(0, my - half, cell, half * 2);
  for (let k = 0; k < 26; k++) {
    const px = x0 + rng() * (x1 - x0);
    const py = my + (rng() - 0.5) * half * 1.8;
    c.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.07)' : v.mottle;
    c.beginPath();
    c.ellipse(px, py, cell * (0.02 + rng() * 0.05), cell * (0.015 + rng() * 0.035), rng() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }
  // midrib + side veins
  c.strokeStyle = v.vein;
  c.globalAlpha = 0.55;
  c.lineWidth = Math.max(1, cell * 0.014);
  c.beginPath();
  c.moveTo(x0, my);
  c.lineTo(x1 - cell * 0.02, my);
  c.stroke();
  c.lineWidth = Math.max(1, cell * 0.007);
  c.globalAlpha = 0.35;
  for (let k = 1; k <= 6; k++) {
    const t = k / 7;
    const vx = x0 + (x1 - x0) * t;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(vx, my);
      c.quadraticCurveTo(vx + (x1 - x0) * 0.08, my + s * half * 0.35, vx + (x1 - x0) * 0.2, my + s * half * (0.72 - t * 0.3));
      c.stroke();
    }
  }
  c.restore();
}

/** Six blades plus two pampas fronds, alpha cut-out. */
function drawLeafAtlas(c: CanvasRenderingContext2D, W: number, H: number): void {
  const rng = createRng(7731);
  c.clearRect(0, 0, W, H);
  const cell = W / 2;
  // 6-7 are the browner, further-gone blades lying on the slab, where a leaf faces the whole sky.
  const variants: LeafVariant[] = [
    { base: '#8d9779', tip: '#b5a378', vein: '#b9c0a4', half: 0.3, len: 0.94, mottle: 'rgba(80,90,66,0.10)' },
    { base: '#6f7857', tip: '#8a7b57', vein: '#929b78', half: 0.27, len: 0.96, mottle: 'rgba(70,78,56,0.12)' },
    { base: '#9aa184', tip: '#c0ad83', vein: '#c8cdb3', half: 0.32, len: 0.9, mottle: 'rgba(80,90,66,0.10)' },
    { base: '#636b50', tip: '#7a6d4e', vein: '#838b68', half: 0.25, len: 0.95, mottle: 'rgba(60,66,46,0.12)' },
  ];
  const fallenVariants: LeafVariant[] = [
    { base: '#7d6f49', tip: '#9a8356', vein: '#8e8259', half: 0.29, len: 0.93, mottle: 'rgba(58,46,28,0.2)' },
    { base: '#6a5c3b', tip: '#857048', vein: '#7b6d49', half: 0.26, len: 0.96, mottle: 'rgba(48,38,22,0.22)' },
  ];
  variants.concat(fallenVariants).forEach((v, k) => {
    const i = k < variants.length ? k : k + 2; // cells 4-5 are the pampas fronds
    c.save();
    c.translate((i % 2) * cell, Math.floor(i / 2) * cell);
    drawLeaf(c, cell, v, rng);
    c.restore();
  });

  // pampas fronds — cells 4 and 5, third row
  [
    { hairs: 330, spread: 0.46, seed: 9104 },
    { hairs: 280, spread: 0.38, seed: 9137 },
  ].forEach((f, i) => {
    c.save();
    c.translate(i * cell, cell * 2);
    drawFrond(c, cell, f.hairs, f.spread, f.seed);
    c.restore();
  });

  // Bleed colour into the transparent border: clearRect leaves black that every mip mixes into the edge.
  c.save();
  c.globalCompositeOperation = 'destination-over';
  c.globalAlpha = 0.13;
  c.filter = 'blur(2.5px)';
  c.drawImage(c.canvas, 0, 0);
  c.restore();
}

/** Flat-sawn walnut. textures.wood() is a fixed-pitch ring field that reads as corduroy on a 0.45 m disc. */
function drawWalnut(c: CanvasRenderingContext2D, W: number, H: number): void {
  const rng = createRng(2213);
  c.fillStyle = '#56392a';
  c.fillRect(0, 0, W, H);

  // slow tonal drift along the board
  for (let i = 0; i < 7; i++) {
    const grad = c.createLinearGradient(0, rng() * H, 0, rng() * H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, rng() < 0.5 ? 'rgba(130,96,67,0.18)' : 'rgba(38,25,16,0.18)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = grad;
    c.fillRect(0, 0, W, H);
  }

  // Every ring is the same bell-sum displaced vertically, so the board carries cathedral arches.
  const bells = [
    { x: W * 0.36, amp: 132, wid: 82 },
    { x: W * 0.88, amp: 64, wid: 52 },
  ];
  const disp = (x: number): number => bells.reduce((s, b) => s + b.amp * Math.exp(-(((x - b.x) / b.wid) ** 2)), 0);
  const ringY = (x: number, cy: number): number => cy - disp(x) * (0.86 + (cy / H) * 0.26) + Math.sin(x * 0.011 + cy) * 2.2;

  c.lineCap = 'round';
  c.filter = 'blur(0.8px)';
  // The arch lifts a ring by ~200 px, so the range of ring origins has to overrun the canvas at both ends.
  for (let cy = -220; cy < H + 300; cy += 7 + rng() * 21) {
    const dark = rng() < 0.6;
    c.strokeStyle = dark
      ? `rgba(40,25,15,${(0.16 + rng() * 0.3).toFixed(3)})`
      : `rgba(152,116,80,${(0.1 + rng() * 0.2).toFixed(3)})`;
    c.lineWidth = dark ? 1.2 + rng() * 4 : 1 + rng() * 2.6;
    c.beginPath();
    for (let i = 0; i <= 56; i++) {
      const x = -20 + ((W + 40) * i) / 56;
      const y = ringY(x, cy);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }
  c.filter = 'none';

  // Open pores: short broken streaks lying along the local grain direction.
  for (let i = 0; i < 2600; i++) {
    const x = rng() * W;
    const cy = -220 + rng() * (H + 520);
    const y = ringY(x, cy);
    if (y < -10 || y > H + 10) continue;
    const slope = (ringY(x + 6, cy) - ringY(x - 6, cy)) / 12;
    const len = 5 + rng() * 26;
    c.strokeStyle =
      rng() < 0.78
        ? `rgba(30,19,11,${(0.08 + rng() * 0.16).toFixed(3)})`
        : `rgba(176,140,101,${(0.06 + rng() * 0.12).toFixed(3)})`;
    c.lineWidth = 0.7 + rng() * 1.1;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + len, y + slope * len + (rng() - 0.5) * 1.4);
    c.stroke();
  }
}

/** Matte stoneware. The pot is a lathe, so u wraps: grains near an edge are drawn again on the far side. */
function drawStone(c: CanvasRenderingContext2D, W: number, H: number): void {
  const rng = createRng(6611);
  c.fillStyle = '#f2ece2';
  c.fillRect(0, 0, W, H);
  // throwing rings run around the pot (constant v → horizontal in the canvas)
  for (let y = 0; y < H; y += 6 + Math.floor(rng() * 8)) {
    c.fillStyle = `rgba(198,190,176,${(0.08 + rng() * 0.11).toFixed(3)})`;
    c.fillRect(0, y, W, 1 + (rng() < 0.25 ? 1 : 0));
  }
  const grain = (x: number, y: number, rx: number, ry: number, rot: number): void => {
    c.beginPath();
    c.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    c.fill();
  };
  for (let i = 0; i < 16000; i++) {
    const t = rng();
    c.fillStyle =
      t < 0.6
        ? `rgba(202,194,180,${(0.06 + rng() * 0.14).toFixed(3)})`
        : t < 0.95
          ? `rgba(253,250,244,${(0.14 + rng() * 0.28).toFixed(3)})`
          : `rgba(168,158,142,${(0.05 + rng() * 0.1).toFixed(3)})`;
    const x = rng() * W;
    const y = rng() * H;
    const r = 0.7 + rng() * 1.9;
    const ry = r * (0.6 + rng() * 0.7);
    const rot = rng() * Math.PI;
    grain(x, y, r, ry, rot);
    if (x < 4) grain(x + W, y, r, ry, rot);
    else if (x > W - 4) grain(x - W, y, r, ry, rot);
  }
}

/** Pressed cork. Granules are sub-millimetre and low-contrast; coarser, and the disc reads as an oat cracker. */
function drawCork(c: CanvasRenderingContext2D, W: number, H: number): void {
  const rng = createRng(4471);
  c.fillStyle = '#bd9a72';
  c.fillRect(0, 0, W, H);
  for (let i = 0; i < 5200; i++) {
    const t = rng();
    c.fillStyle =
      t < 0.4
        ? `rgba(176,141,102,${(0.2 + rng() * 0.32).toFixed(3)})`
        : t < 0.78
          ? `rgba(207,178,140,${(0.18 + rng() * 0.3).toFixed(3)})`
          : t < 0.94
            ? `rgba(190,163,124,${(0.2 + rng() * 0.32).toFixed(3)})`
            : `rgba(151,119,84,${(0.22 + rng() * 0.3).toFixed(3)})`;
    const r = 0.55 + rng() * 1.7;
    c.beginPath();
    c.ellipse(rng() * W, rng() * H, r, r * (0.55 + rng() * 0.8), rng() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }
  for (let i = 0; i < 45; i++) {
    c.fillStyle = `rgba(126,96,66,${(0.22 + rng() * 0.26).toFixed(3)})`;
    c.beginPath();
    c.ellipse(rng() * W, rng() * H, 0.8 + rng() * 1.1, 0.8 + rng() * 1, rng() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }
}

// Paperback cover atlas: back cover (seen, face down), front cover, spine.
const COVER_W = 1024;
const COVER_H = 768;
const COVER_CELLS = {
  back: { x: 0, y: 0, w: 392, h: 640 },
  front: { x: 400, y: 0, w: 392, h: 640 },
  spine: { x: 0, y: 656, w: 900, h: 100 },
} as const satisfies Record<string, Rect>;

const INK = '#ece2cd';
const BOARD = '#2f4a40';
const ACCENT = '#c4894a';

/** Coarse book-cloth weave, drawn straight into the colour map. */
function weave(c: CanvasRenderingContext2D, w: number, h: number): void {
  c.save();
  for (let x = 0; x < w; x += 4) {
    c.fillStyle = 'rgba(255,255,255,0.028)';
    c.fillRect(x, 0, 1, h);
  }
  for (let y = 0; y < h; y += 4) {
    c.fillStyle = 'rgba(0,0,0,0.038)';
    c.fillRect(0, y, w, 1);
  }
  c.restore();
}

function textLines(c: CanvasRenderingContext2D, lines: string[], x: number, y: number, lh: number, maxW?: number): number {
  let cy = y;
  for (const line of lines) {
    if (maxW) c.fillText(line, x, cy, maxW);
    else c.fillText(line, x, cy);
    cy += lh;
  }
  return cy;
}

function drawCover(c: CanvasRenderingContext2D, W: number, H: number): void {
  const rng = createRng(5309);
  // The gutter is the board colour, not a dark key: the UV rect's bleed guard samples it along the edges.
  c.fillStyle = BOARD;
  c.fillRect(0, 0, W, H);

  const cell = (r: Rect, draw: () => void): void => {
    c.save();
    c.beginPath();
    c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    c.translate(r.x, r.y);
    draw();
    c.restore();
  };

  cell(COVER_CELLS.back, () => {
    const w = COVER_CELLS.back.w;
    const h = COVER_CELLS.back.h;
    c.fillStyle = BOARD;
    c.fillRect(0, 0, w, h);
    weave(c, w, h);
    // print wear: the board is lighter where the light hits
    const sheen = c.createLinearGradient(0, 0, w, h);
    sheen.addColorStop(0, 'rgba(255,255,255,0.07)');
    sheen.addColorStop(0.55, 'rgba(255,255,255,0.01)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.10)');
    c.fillStyle = sheen;
    c.fillRect(0, 0, w, h);

    c.fillStyle = ACCENT;
    c.font = `600 15px ${SANS}`;
    c.fillText('FICTION', 30, 46);
    c.fillRect(30, 56, 44, 2);

    c.fillStyle = INK;
    c.font = `italic 22px ${SERIF}`;
    textLines(c, ['"A quiet, exact book about', 'the weather of a marriage."'], 30, 104, 29);
    c.font = `600 13px ${SANS}`;
    c.fillStyle = ACCENT;
    c.fillText('THE OBSERVER', 30, 186);

    c.fillStyle = INK;
    c.font = `16px ${SERIF}`;
    c.globalAlpha = 0.92;
    textLines(
      c,
      [
        'The winter Ines turns forty, the sea',
        'takes the road below her mother’s',
        'house, and the village begins to keep',
        'its distance. She stays on through the',
        'storms, cataloguing what the water',
        'leaves — a chair, a door, a pair of',
        'boots — and waiting for the one thing',
        'she is certain it will return to her.',
      ],
      30,
      230,
      25,
    );
    c.globalAlpha = 1;

    c.font = `13px ${SANS}`;
    c.fillStyle = 'rgba(236,226,205,0.7)';
    textLines(c, ['Cover design by A. Merrow', 'Author photograph © J. Kestrel'], 30, 452, 19);

    // barcode block
    const bx = 30;
    const by = h - 132;
    c.fillStyle = '#f4f1e8';
    c.fillRect(bx, by, 150, 92);
    c.fillStyle = '#16211c';
    let x = bx + 10;
    while (x < bx + 138) {
      const bw = 1 + Math.floor(rng() * 3);
      c.fillRect(x, by + 10, bw, 58);
      x += bw + 1 + Math.floor(rng() * 3);
    }
    c.font = `11px ${SANS}`;
    c.fillText('9 781784 709891', bx + 12, by + 84);
    c.fillStyle = INK;
    c.font = `600 15px ${SANS}`;
    c.fillText('£9.99', bx + 168, by + 26);
    c.font = `12px ${SANS}`;
    c.globalAlpha = 0.75;
    textLines(c, ['ISBN 978-1-78470-989-1', 'NORTHLIGHT PRESS', 'northlightpress.co.uk'], bx + 168, by + 50, 17);
    c.globalAlpha = 1;
  });

  cell(COVER_CELLS.front, () => {
    const w = COVER_CELLS.front.w;
    const h = COVER_CELLS.front.h;
    c.fillStyle = BOARD;
    c.fillRect(0, 0, w, h);
    weave(c, w, h);
    const sky = c.createLinearGradient(0, 120, 0, 430);
    sky.addColorStop(0, '#3c6058');
    sky.addColorStop(1, '#8fa08b');
    c.fillStyle = sky;
    c.fillRect(0, 120, w, 310);
    c.fillStyle = '#1f3029';
    c.fillRect(0, 392, w, 38);
    c.fillStyle = ACCENT;
    c.beginPath();
    c.arc(w * 0.68, 236, 44, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = INK;
    c.font = `600 44px ${SERIF}`;
    textLines(c, ['SALT', 'AND', 'STONE'], 34, 500, 46);
    c.fillStyle = ACCENT;
    c.fillRect(34, 520, 60, 3);
    c.fillStyle = INK;
    c.font = `600 20px ${SANS}`;
    c.fillText('ELENA VOSS', 34, 560);
    c.font = `italic 15px ${SERIF}`;
    c.globalAlpha = 0.8;
    c.fillText('a novel', 34, 66);
    c.globalAlpha = 1;
  });

  cell(COVER_CELLS.spine, () => {
    const w = COVER_CELLS.spine.w;
    const h = COVER_CELLS.spine.h;
    c.fillStyle = BOARD;
    c.fillRect(0, 0, w, h);
    weave(c, w, h);
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(0, 0, 6, h);
    c.fillRect(w - 6, 0, 6, h);
    c.fillStyle = INK;
    c.font = `600 40px ${SERIF}`;
    c.fillText('SALT AND STONE', 60, h * 0.5 + 14);
    c.font = `600 26px ${SANS}`;
    c.globalAlpha = 0.85;
    c.fillText('VOSS', 420, h * 0.5 + 10);
    c.globalAlpha = 1;
    c.fillStyle = ACCENT;
    c.beginPath();
    c.arc(w - 46, h * 0.5, 13, 0, Math.PI * 2);
    c.fill();
  });
}

interface StemSpec {
  a: number; // azimuth out of the vase mouth
  tipR: number; // how far the tip leans from the vase axis
  tipY: number; // tip height above the table top
  twist: number; // sideways drift on the way up
  kind: 'euc' | 'pampas';
}

// Tips kept under ~0.50 m above the top, so the whole piece stays around 1.05 m tall.
const STEMS: StemSpec[] = [
  { a: 0.55, tipR: 0.148, tipY: 0.435, twist: 0.26, kind: 'euc' },
  { a: 2.45, tipR: 0.126, tipY: 0.485, twist: -0.3, kind: 'euc' },
  { a: 4.35, tipR: 0.104, tipY: 0.4, twist: 0.36, kind: 'euc' },
  { a: 1.45, tipR: 0.055, tipY: 0.5, twist: -0.18, kind: 'pampas' },
  { a: 5.3, tipR: 0.086, tipY: 0.455, twist: 0.22, kind: 'pampas' },
];

const UP = new THREE.Vector3(0, 1, 0);

/** One alpha-cut blade on a stem: `size` across the stem, `size * aspect` out along `side`. */
function leafGeometry(
  p: THREE.Vector3,
  tangent: THREE.Vector3,
  radial: THREE.Vector3,
  phi: number,
  size: number,
  droop: number,
  cell: number,
  aspect = 1.42,
  segs: [number, number] = [2, 2],
): THREE.BufferGeometry {
  const u = radial.clone().addScaledVector(tangent, -radial.dot(tangent));
  if (u.lengthSq() < 1e-9) u.set(1, 0, 0);
  u.normalize();
  const v = new THREE.Vector3().crossVectors(tangent, u).normalize();
  const side = u.multiplyScalar(Math.cos(phi)).addScaledVector(v, Math.sin(phi));
  side.addScaledVector(UP, -droop).normalize();
  const along = tangent.clone().addScaledVector(side, -tangent.dot(side)).normalize();
  const normal = new THREE.Vector3().crossVectors(side, along).normalize();

  const w = size * aspect;
  const geo = new THREE.PlaneGeometry(w, size, segs[0], segs[1]);
  geo.translate(w / 2, 0, 0); // petiole at the origin
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const tx = pos.getX(i) / w;
    const ty = pos.getY(i) / (size / 2);
    pos.setZ(i, -w * 0.13 * tx * tx - size * 0.1 * ty * ty);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  mapUvToRect(geo, atlasCell(cell), ATLAS_W, ATLAS_H);
  const m = new THREE.Matrix4().makeBasis(side, along, normal);
  m.setPosition(p);
  geo.applyMatrix4(m);
  return geo;
}

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'sideTable';
  const rng = createRng(ctx.seed + 7731);
  const M = ctx.materials;

  // Oiled, not lacquered: a lacquer-weight clearcoat mirrors enough sky to grey the walnut.
  // The bump is the grain map itself; without relief the sky lies across the whole disc as one haze.
  const walnutTex = ctx.textures.canvas('sideTable:walnut', 512, 512, drawWalnut);
  const walnut = M.custom({
    map: walnutTex,
    bumpMap: walnutTex,
    bumpScale: 0.0012,
    metalness: 0,
    roughness: 0.52,
    clearcoat: 0.06,
    clearcoatRoughness: 0.5,
    specularIntensity: 0.45,
    envMapIntensity: 0.35,
  });
  const topProf = topProfile();
  const topGeo = lathe(topProf, 72);
  // 0.48 m per UV square, so the clamped canvas never smears at the rim.
  discUv(topGeo, topProf, 0.48, rng() * Math.PI);
  topGeo.translate(0, TOP_UNDER, 0);
  g.add(mesh(topGeo, walnut, undefined, { name: 'top' }));

  // Not a mirror, but not a light sink either: the rod keeps a narrow grazing highlight along its top.
  const steelMat = M.metal('blackMatte').clone();
  steelMat.color.set(0x202024);
  steelMat.metalness = 0.3;
  steelMat.roughness = 0.45;
  steelMat.specularIntensity = 0.65;
  steelMat.envMapIntensity = 0.95;

  const steel: THREE.BufferGeometry[] = [];
  const plate = lathe(plateProfile(), 36);
  plate.translate(0, TOP_UNDER - PLATE_T, 0);
  steel.push(plate);

  const curves = LEG_ANGLES.map((a) => legCurve(a));
  const ringR = radiusAtHeight(curves[0], RING_Y) - (ROD_R + RING_ROD_R - 0.0015);
  for (const curve of curves) {
    // 8 sides on a 10 mm rod: the grazing highlight needs a facet narrower than itself.
    steel.push(new THREE.TubeGeometry(curve, 20, ROD_R, 8, false));
  }
  const ring = new THREE.TorusGeometry(ringR, RING_ROD_R, 8, 36);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, RING_Y, 0);
  steel.push(ring);
  // weld fillets where the ring meets each leg
  const legRingR = radiusAtHeight(curves[0], RING_Y);
  for (const a of LEG_ANGLES) {
    const blob = new THREE.SphereGeometry(0.0068, 9, 6);
    blob.scale(1, 0.8, 1);
    blob.translate(Math.cos(a) * (legRingR - 0.0015), RING_Y, Math.sin(a) * (legRingR - 0.0015));
    steel.push(blob);
  }
  g.add(mesh(unify(steel), steelMat, undefined, { name: 'base' }));

  const glides: THREE.BufferGeometry[] = [];
  for (const a of LEG_ANGLES) {
    const p = curves[0].getPoint(1);
    const r = Math.hypot(p.x, p.z);
    const foot = cylinder(0.0078, 0.0089, FOOT_H, 20);
    foot.translate(Math.cos(a) * r, FOOT_H / 2, Math.sin(a) * r);
    glides.push(foot);
  }
  g.add(mesh(unify(glides), M.rubber(0x141416), undefined, { name: 'glides' }));

  // ceramic() carries no map, and 0.28 m of flat cream is the biggest single surface in the module.
  const [vx, vz] = VASE_POS;
  const stoneTex = ctx.textures.canvas('sideTable:stone', 512, 512, drawStone);
  const vaseMat = M.ceramic(0xe8e2d6, false).clone();
  vaseMat.map = stoneTex;
  // No bumpMap: a bump from a speckle map aliases into vertical dashes that read as drip stains.
  vaseMat.roughness = 0.68;
  const vaseGeo = lathe(vaseProfile(), 48);
  vaseGeo.translate(vx, TOP_Y, vz);
  g.add(mesh(vaseGeo, vaseMat, undefined, { name: 'vase' }));

  const leafTex = ctx.textures.canvas('sideTable:leaves', ATLAS_W, ATLAS_H, drawLeafAtlas);
  // alphaTest well below half: the mip chain halves the hairs' alpha every level, and 0.5 discarded them.
  const leafMat = M.custom({
    map: leafTex,
    alphaTest: 0.18,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
    // At full environment even the dark atlas variants wash out to white flecks on the walnut.
    envMapIntensity: 0.65,
  });
  const stemMat = M.plastic(0x93805f, 0.93);
  const plumeMat = M.fabric(0xd8c7a3, { boucle: true, scale: 1.8, surface: [0.05, 0.05] });

  const stemGeos: THREE.BufferGeometry[] = [];
  const leafGeos: THREE.BufferGeometry[] = [];
  const plumeGeos: THREE.BufferGeometry[] = [];
  const vaseBase = new THREE.Vector3(vx, TOP_Y, vz);

  // Nothing may be born below this line or it grows out through the vase wall.
  const RIM_Y = TOP_Y + 0.2805;
  const LEAF_MAX = 0.033;
  const CLEAR_Y = RIM_Y + LEAF_MAX + 0.005;

  STEMS.forEach((s, si) => {
    const a = s.a + (rng() - 0.5) * 0.18;
    const tipY = s.tipY + (rng() - 0.5) * 0.03;
    const tw = s.twist + (rng() - 0.5) * 0.1;
    const rim = VASE_H - 0.004;
    // Starts below the vase's interior floor, so the cut end is never visible down the neck.
    const pts = [
      polar(a, 0.004, 0.012),
      polar(a, 0.011, 0.16),
      polar(a, 0.018, rim),
      polar(a + tw * 0.35, s.tipR * 0.4, rim + (tipY - rim) * 0.42),
      polar(a + tw * 0.75, s.tipR * 0.78, rim + (tipY - rim) * 0.79),
      polar(a + tw, s.tipR, tipY),
    ].map((p) => p.add(vaseBase));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    const r0 = s.kind === 'pampas' ? 0.0027 : 0.0022;
    const r1 = s.kind === 'pampas' ? 0.0013 : 0.0009;
    stemGeos.push(taperedTube(curve, 20, 6, (t) => r0 + (r1 - r0) * Math.pow(t, 0.75)));

    if (s.kind === 'pampas') {
      const plumeH = 0.1;
      const tBase = Math.max(0.05, 1 - plumeH / curve.getLength());
      const p = curve.getPointAt(tBase);
      const t = curve.getTangentAt(tBase).normalize();
      // Only the stem core the fronds grow out of; alone it was an opaque cream lance.
      const plume = lathe(plumeProfile(plumeH, 0.004), 10);
      plume.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, t));
      plume.translate(p.x, p.y, p.z);
      plumeGeos.push(plume);
      // Body and silhouette both come from the fronds, so there have to be enough to break the outline.
      const radial0 = new THREE.Vector3(p.x - vaseBase.x, 0, p.z - vaseBase.z);
      if (radial0.lengthSq() < 1e-6) radial0.set(Math.cos(a), 0, Math.sin(a));
      radial0.normalize();
      const fronds = 28;
      for (let i = 0; i < fronds; i++) {
        const u = 0.08 + (i / (fronds - 1)) * 0.68 + (rng() - 0.5) * 0.04;
        const fp = p.clone().addScaledVector(t, plumeH * u);
        const env = Math.sin(Math.min(1, u * 1.25) * Math.PI * 0.9);
        const len = 0.028 + env * 0.02 + rng() * 0.006;
        // lower fronds hang, the crown sweeps up
        const droop = 0.22 - u * 1.35 + (rng() - 0.5) * 0.18;
        leafGeos.push(
          leafGeometry(
            fp,
            t.clone(),
            radial0.clone(),
            i * 2.399 + si + (rng() - 0.5) * 0.3,
            0.0105,
            droop,
            rng() < 0.5 ? 4 : 5,
            len / 0.0105,
            [3, 1],
          ),
        );
      }
      return;
    }

    // Only from the first parameter that clears the rim, or the blades punch out through the ceramic.
    const t0 = Math.min(0.9, tAboveHeight(curve, CLEAR_Y) + 0.005);
    const count = 12;
    for (let ni = 0; ni < count; ni++) {
      const t = t0 + ((0.98 - t0) * ni) / (count - 1);
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).normalize();
      const radial = new THREE.Vector3(p.x - vaseBase.x, 0, p.z - vaseBase.z);
      if (radial.lengthSq() < 1e-6) radial.set(Math.cos(a), 0, Math.sin(a));
      radial.normalize();
      const size = LEAF_MAX - ni * 0.0009 + (rng() - 0.5) * 0.004;
      const phi = ni * 1.15 + si * 0.7 + (rng() - 0.5) * 0.25;
      for (const dir of [0, Math.PI]) {
        leafGeos.push(
          leafGeometry(p.clone(), tan, radial.clone(), phi + dir, size, 0.28 + rng() * 0.26, Math.floor(rng() * 4)),
        );
      }
    }

    const bt = Math.min(0.88, t0 + 0.14);
    const bp = curve.getPointAt(bt);
    const btan = curve.getTangentAt(bt).normalize();
    const bradial = new THREE.Vector3(bp.x - vaseBase.x, 0, bp.z - vaseBase.z).normalize();
    const bdir = btan.clone().multiplyScalar(0.55).addScaledVector(bradial, 0.85).normalize();
    const branch = new THREE.CatmullRomCurve3(
      [
        bp.clone(),
        bp.clone().addScaledVector(bdir, 0.03).addScaledVector(UP, 0.012),
        bp.clone().addScaledVector(bdir, 0.062).addScaledVector(UP, 0.03),
      ],
      false,
      'catmullrom',
      0.5,
    );
    stemGeos.push(taperedTube(branch, 10, 5, (t) => 0.0014 - 0.0007 * t));
    [0.3, 0.62, 0.9].forEach((t, ni) => {
      const p = branch.getPointAt(t);
      const tan = branch.getTangentAt(t).normalize();
      for (const dir of [0, Math.PI]) {
        leafGeos.push(
          leafGeometry(p.clone(), tan, bradial.clone(), 1.2 + ni * 1.4 + dir, 0.025 - ni * 0.0025, 0.35, Math.floor(rng() * 4)),
        );
      }
    });
  });

  // Built with leafGeometry (cells 6-7) so they keep its curl and normals; a flat quad read as a decal.
  const fallen: Array<[number, number, number, number, number]> = [
    [0.062, -0.148, 0.9, 7, 0.34],
    [-0.152, -0.025, 2.4, 6, -0.38],
    [0.136, -0.082, 4.1, 7, 0.26],
  ];
  for (const [fx, fz, fa, cell, roll] of fallen) {
    const along = new THREE.Vector3(Math.cos(fa), 0, Math.sin(fa));
    const across = new THREE.Vector3(-Math.sin(fa), 0, Math.cos(fa));
    // 2.8 mm off the slab: at a hair's clearance the shadow bias swallowed the contact entirely.
    const fy = TOP_Y + 0.0028;
    const blade = leafGeometry(new THREE.Vector3(fx, fy, fz), across, along, 0, 0.026 + rng() * 0.008, 0, cell);
    blade.translate(-fx, -fy, -fz);
    blade.applyMatrix4(new THREE.Matrix4().makeRotationAxis(along, roll));
    blade.translate(fx, fy, fz);
    leafGeos.push(blade);
  }

  g.add(mesh(unify(stemGeos), stemMat, undefined, { name: 'stems' }));
  g.add(mesh(unify(leafGeos), leafMat, undefined, { name: 'leaves' }));
  g.add(mesh(unify(plumeGeos), plumeMat, undefined, { name: 'plumes' }));

  const [cxp, czp] = COASTER_POS;
  const corkTex = ctx.textures.canvas('sideTable:cork', 256, 256, drawCork);
  const coasterProf = coasterProfile();
  const coaster = lathe(coasterProf, 40);
  // 0.12 m per UV square keeps the chamfer inside the canvas, which is clamped.
  discUv(coaster, coasterProf, 0.12, rng() * Math.PI);
  coaster.translate(cxp, TOP_Y, czp);
  g.add(
    mesh(coaster, M.custom({ map: corkTex, bumpMap: corkTex, bumpScale: 0.0005, roughness: 0.93, metalness: 0 }), undefined, {
      name: 'coaster',
    }),
  );

  const gx = cxp + (rng() - 0.5) * 0.004;
  const gz = czp + (rng() - 0.5) * 0.004;
  const glassGeo = lathe(glassProfile(), 34);
  glassGeo.translate(gx, TOP_Y + COASTER_T, gz);
  // solidGlass() assumes a 50 mm slab; the refracted volume still has to bend what is behind it.
  // depthWrite off: the transmissive pass runs before the transparent one and would hide the water.
  const glassMat = M.solidGlass().clone();
  glassMat.thickness = 0.015;
  glassMat.attenuationDistance = 0.4;
  glassMat.depthWrite = false;
  // Both walls refract: with the inner surface culled you look straight through the tumbler.
  glassMat.side = THREE.DoubleSide;
  glassMat.roughness = 0.02;
  glassMat.envMapIntensity = 0.75;
  const glassMesh = mesh(glassGeo, glassMat, undefined, { name: 'glass', cast: false });
  glassMesh.renderOrder = 1;
  g.add(glassMesh);

  // Half full. Alpha scales the specular lobe too, so the waterline needs a material of its own.
  const level = GLASS_H * 0.52;
  const waterGeo = lathe(waterProfile(level), 34);
  waterGeo.translate(gx, TOP_Y + COASTER_T, gz);
  const waterMesh = mesh(
    waterGeo,
    M.custom({
      color: 0x9cc3da,
      metalness: 0,
      roughness: 0.08,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      side: THREE.FrontSide,
      ior: 1.33,
      specularIntensity: 1,
      envMapIntensity: 0.9,
    }),
    undefined,
    // The glass is too thin to cast; the water volume is what carries the shadow.
    { name: 'water' },
  );
  waterMesh.renderOrder = 2; // after the glass, which would otherwise overwrite it
  g.add(waterMesh);

  const surfDisc = new THREE.CircleGeometry(0.0272, 32);
  surfDisc.rotateX(-Math.PI / 2);
  surfDisc.translate(0, level, 0);
  const meniscus = new THREE.TorusGeometry(0.0273, 0.0009, 6, 32);
  meniscus.rotateX(Math.PI / 2);
  meniscus.translate(0, level, 0);
  const surfGeo = unify([surfDisc, meniscus]);
  surfGeo.translate(gx, TOP_Y + COASTER_T, gz);
  const surfMesh = mesh(
    surfGeo,
    M.custom({
      color: 0xd2e8f2,
      metalness: 0,
      roughness: 0.02,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
      ior: 1.33,
      specularIntensity: 1,
      envMapIntensity: 1,
    }),
    undefined,
    { name: 'waterline', cast: false },
  );
  surfMesh.renderOrder = 3;
  g.add(surfMesh);

  const coverTex = ctx.textures.canvas('sideTable:cover', COVER_W, COVER_H, drawCover);
  const paperSet = ctx.textures.paper();
  const coverNormal = paperSet.normalMap ? paperSet.normalMap.clone() : null;
  if (coverNormal) {
    // The cover UVs are squeezed into an atlas cell, so the repeat divides by the cell's own extent.
    const cu = (COVER_CELLS.back.w - 2) / COVER_W;
    const cv = (COVER_CELLS.back.h - 2) / COVER_H;
    coverNormal.repeat.set(BOOK_W / 0.3 / cu, BOOK_D / 0.3 / cv);
    coverNormal.needsUpdate = true;
  }
  const coverMat = M.custom({
    map: coverTex,
    normalMap: coverNormal ?? undefined,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.74,
    metalness: 0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.55,
  });

  const bookM = new THREE.Matrix4().makeRotationY(0.28 + (rng() - 0.5) * 0.08);
  bookM.setPosition(BOOK_POS[0], TOP_Y, BOOK_POS[1]);

  const pages = roundedBox(BOOK_W - 0.0022, BOOK_T - 0.0008, BOOK_D - 0.0022, 0.0007, 2);
  pages.translate(0, BOOK_T / 2, 0);
  pages.applyMatrix4(bookM);
  g.add(mesh(pages, M.paper(0xeee3ca, { surface: [0.025, 0.025] }), undefined, { name: 'pages' }));

  // Covers stand ~1.5 mm proud of the page block, or the long side is a razor join.
  const cw = BOOK_W + 0.003;
  const cd = BOOK_D + 0.003;
  const covers: THREE.BufferGeometry[] = [];
  const back = new THREE.PlaneGeometry(cw, cd);
  back.rotateX(-Math.PI / 2);
  back.translate(0, BOOK_T, 0);
  mapUvToRect(back, COVER_CELLS.back, COVER_W, COVER_H);
  covers.push(back);

  const front = new THREE.PlaneGeometry(cw, cd);
  front.rotateX(Math.PI / 2);
  mapUvToRect(front, COVER_CELLS.front, COVER_W, COVER_H);
  covers.push(front);

  const spine = new THREE.PlaneGeometry(cd, BOOK_T);
  spine.rotateY(-Math.PI / 2);
  spine.translate(-cw / 2, BOOK_T / 2, 0);
  mapUvToRect(spine, COVER_CELLS.spine, COVER_W, COVER_H);
  covers.push(spine);

  const coverGeo = unify(covers);
  coverGeo.applyMatrix4(bookM);
  g.add(mesh(coverGeo, coverMat, undefined, { name: 'cover' }));

  return g;
}
