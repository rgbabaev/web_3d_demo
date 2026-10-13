import * as THREE from 'three';
import { box, cylinder, lathe, mergeGeometries, mesh, roundedBox, tube } from '../core/geometry';
import { createRng } from '../core/noise';
import type { SceneContext } from '../core/types';

const W = 1.2;
const H = 2.1;
const D = 0.35;
const SIDE_T = 0.025;
const TOP_T = 0.025;
const BOTTOM_T = 0.025;
const BACK_T = 0.006;
const SHELF_T = 0.018;
const DIV_T = 0.018;
const PLINTH_H = 0.06;
const INNER_W = W - 2 * SIDE_T; // 1.15
const HALF_IN = INNER_W / 2; // 0.575
const BACK_FRONT_Z = -D / 2 + BACK_T; // front face of the back panel
const SHELF_D = 0.33;
const SHELF_Z = BACK_FRONT_Z + SHELF_D / 2;
const SHELF_FRONT = BACK_FRONT_Z + SHELF_D; // 0.161 — shelves sit 14 mm behind the side edges
const BAYS = [0.4, 0.36, 0.33, 0.31, 0.28, 0.22]; // clear heights, bottom → top
/** Top surface of the bottom panel and of each shelf (index = bay). */
const SHELF_Y: number[] = [];
{
  let y = PLINTH_H + BOTTOM_T;
  for (const c of BAYS) {
    SHELF_Y.push(y);
    y += c + SHELF_T;
  }
}
const SPINE_Z = SHELF_FRONT - 0.025; // default spine line, 25 mm behind the shelf edge
/** Upright plate of the brass bookend. Must exceed the leaning books it props. */
const BOOKEND_H = 0.205;

type V3 = THREE.Vector3;
const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const deg = THREE.MathUtils.degToRad;
const clamp = THREE.MathUtils.clamp;

/** Merge geometries sharing one material into a single draw call. */
function unify(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geoms.some((g) => !g.index) ? geoms.map((g) => (g.index ? g.toNonIndexed() : g)) : geoms;
  return parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
}

function planarUv(g: THREE.BufferGeometry, fn: (p: V3, n: V3) => [number, number]): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    const [u, v] = fn(p, n);
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return g;
}

/** Metre-scale UVs, texture u along `grain`; sv > 1 squeezes the cross-grain figure so rings stop reading as ribs. */
function grainUv(grain: 'x' | 'y' | 'z', ou = 0, ov = 0, su = 1, sv = 1): (p: V3, n: V3) => [number, number] {
  return (p, n) => {
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    let a: number;
    let b: number;
    if (ax >= ay && ax >= az) [a, b] = grain === 'z' ? [p.z, p.y] : [p.y, p.z];
    else if (ay >= az) [a, b] = grain === 'z' ? [p.z, p.x] : [p.x, p.z];
    else [a, b] = grain === 'y' ? [p.y, p.x] : [p.x, p.y];
    return [a * su + ou, b * sv + ov];
  };
}

/** A 16x-anisotropic copy; `Material.clone()` shares textures, and these are the library's. */
function anisotropic(t: THREE.Texture): THREE.Texture {
  const c = t.clone();
  c.anisotropy = 16;
  c.needsUpdate = true;
  return c;
}

function addColor(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function translation(x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, y, z);
}

/** Orthonormal frame: local +Y along `yDir`, local +Z as close as possible to `zHint`. */
function basisAt(origin: V3, yDir: V3, zHint: V3, roll = 0): THREE.Matrix4 {
  const Y = yDir.clone().normalize();
  const Z = zHint.clone().addScaledVector(Y, -zHint.dot(Y)).normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
  const m = new THREE.Matrix4().makeBasis(X, Y, Z);
  m.setPosition(origin);
  if (roll) m.multiply(new THREE.Matrix4().makeRotationY(roll));
  return m;
}

/** Perceptual lightness (0..1) of a linear-space colour. */
function lightness(c: THREE.Color): number {
  return Math.pow(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, 1 / 2.2);
}

const ATLAS = 1024;
const CELL_H = 400;
/** Spine families by aspect; cell width = CELL_H / aspect. 40 designs in all — at 24 the repeats were visible. */
const FAMILIES = [
  { aspect: 6, w: 67, n: 9 },
  { aspect: 9, w: 44, n: 11 },
  { aspect: 13, w: 31, n: 12 },
  { aspect: 19, w: 21, n: 8 },
];

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  dark: boolean;
  family: number;
}

/** Pack the 40 cells into two 400 px rows: [family, count] per group. */
function buildCells(): Cell[] {
  const cells: Cell[] = [];
  const rows: Array<Array<[number, number]>> = [
    [[0, 9], [1, 5]],
    [[1, 6], [2, 12], [3, 8]],
  ];
  const used = [0, 0, 0, 0];
  rows.forEach((groups, r) => {
    let x = 8;
    const y = 6 + r * (CELL_H + 12);
    for (const [f, n] of groups) {
      for (let i = 0; i < n; i++) {
        const k = used[f]++;
        // Every third design is printed in dark ink, for the pale spines.
        cells.push({ x, y, w: FAMILIES[f].w, h: CELL_H, dark: k % 3 === 2, family: f });
        x += FAMILIES[f].w + 6;
      }
      x += 10;
    }
  });
  return cells;
}

const NOUNS = ['GARDEN', 'LIGHT', 'WINTER', 'STONE', 'RIVER', 'CITY', 'MEMORY', 'ATLAS', 'FORM', 'SPACE', 'SILENCE', 'HOUSE', 'NORTH', 'COLOUR', 'DESIGN', 'PATTERN', 'JOURNEY', 'MAPS', 'SHADOWS', 'ORIGINS', 'THEORY', 'SYSTEMS', 'SEASONS', 'HARBOUR', 'MOUNTAIN', 'ARCHITECTURE', 'TYPOGRAPHY', 'ISLANDS', 'WEATHER', 'GLASS'];
const ADJ = ['SILENT', 'BRIGHT', 'DISTANT', 'NORTHERN', 'HIDDEN', 'MODERN', 'SLOW', 'GOLDEN', 'QUIET', 'LATE'];
const AUTHORS = ['A. MORENO', 'K. LINDQVIST', 'J. HARTWELL', 'M. OKAFOR', 'E. SATO', 'R. DUBOIS', 'L. FERREIRA', 'T. NAKAMURA', 'S. VOSS', 'P. ANAND', 'C. BERG', 'H. IVANOVA', 'D. WHITLOCK', 'N. HAAS'];
const LIGHT_INK = ['#e6d9bd', '#d8b264', '#f0ece2', '#cdbf9e', '#e2c98a', '#f3e9cf'];
const DARK_INK = ['#1e1a17', '#3b2a21', '#2a2d38', '#4a3826'];
const FONTS = ['Georgia, "Times New Roman", serif', '"Times New Roman", Times, serif', 'Arial, Helvetica, sans-serif', 'Verdana, Geneva, sans-serif', '"Palatino Linotype", "Book Antiqua", Palatino, serif', '"Trebuchet MS", sans-serif'];

function drawSpineAtlas(c: CanvasRenderingContext2D, cells: Cell[]): void {
  const rng = createRng(9001);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const title = (): string => {
    const r = rng();
    if (r < 0.25) return `THE ${pick(NOUNS)}`;
    if (r < 0.45) return `${pick(NOUNS)} OF ${pick(NOUNS)}`;
    if (r < 0.6) return `A ${pick(ADJ)} ${pick(NOUNS)}`;
    if (r < 0.75) return `${pick(NOUNS)} & ${pick(NOUNS)}`;
    return pick(NOUNS);
  };
  /** Text running down the spine (top-to-bottom, letter tops to the right). */
  const vText = (text: string, x: number, y: number, size: number, font: string, weight: string, maxLen: number, align: CanvasTextAlign = 'left'): number => {
    let s = size;
    c.font = `${weight} ${s}px ${font}`;
    while (c.measureText(text).width > maxLen && s > 6) {
      s -= 1;
      c.font = `${weight} ${s}px ${font}`;
    }
    const len = c.measureText(text).width;
    c.save();
    c.translate(x, y);
    c.rotate(Math.PI / 2);
    c.textBaseline = 'middle';
    c.textAlign = align;
    c.fillText(text, 0, 0);
    c.restore();
    return len;
  };
  const emblem = (kind: number, x: number, y: number, r: number): void => {
    c.lineWidth = Math.max(1, r * 0.18);
    c.beginPath();
    switch (kind % 5) {
      case 0: // ring with dot
        c.arc(x, y, r, 0, Math.PI * 2);
        c.stroke();
        c.beginPath();
        c.arc(x, y, r * 0.35, 0, Math.PI * 2);
        c.fill();
        break;
      case 1: // diamond
        c.moveTo(x, y - r);
        c.lineTo(x + r * 0.7, y);
        c.lineTo(x, y + r);
        c.lineTo(x - r * 0.7, y);
        c.closePath();
        c.fill();
        break;
      case 2: // little tree
        c.moveTo(x, y - r);
        c.lineTo(x + r * 0.8, y + r * 0.4);
        c.lineTo(x - r * 0.8, y + r * 0.4);
        c.closePath();
        c.fill();
        c.fillRect(x - r * 0.12, y + r * 0.4, r * 0.24, r * 0.5);
        break;
      case 3: // nested squares
        c.strokeRect(x - r, y - r, 2 * r, 2 * r);
        c.fillRect(x - r * 0.45, y - r * 0.45, r * 0.9, r * 0.9);
        break;
      default: // leaf / almond
        c.moveTo(x, y - r);
        c.quadraticCurveTo(x + r, y, x, y + r);
        c.quadraticCurveTo(x - r, y, x, y - r);
        c.fill();
        c.moveTo(x, y - r * 0.8);
        c.lineTo(x, y + r * 0.8);
        c.stroke();
    }
  };

  cells.forEach((cell, idx) => {
    const { w, h } = cell;
    const ink = pick(cell.dark ? DARK_INK : LIGHT_INK);
    const font = pick(FONTS);
    const weight = rng() < 0.5 ? '700' : '400';
    const variant = idx % 5;
    const cx = w / 2;
    const fs = Math.round(w * (0.36 + rng() * 0.1));
    c.save();
    c.translate(cell.x, cell.y);
    c.beginPath();
    c.rect(0, 0, w, h);
    c.clip();
    c.fillStyle = ink;
    c.strokeStyle = ink;
    const t = title();
    const author = pick(AUTHORS);
    if (variant === 0) {
      // Classic: thin rules top and bottom, title, author, emblem.
      c.fillRect(w * 0.15, h * 0.07, w * 0.7, Math.max(1.5, w * 0.03));
      c.fillRect(w * 0.15, h * 0.93, w * 0.7, Math.max(1.5, w * 0.03));
      const len = vText(t, cx, h * 0.11, fs, font, weight, h * 0.5);
      vText(author, cx, h * 0.13 + len + fs * 0.9, Math.round(fs * 0.62), font, '400', h * 0.25);
      emblem(idx, cx, h * 0.865, w * 0.16);
    } else if (variant === 1) {
      // Big centred title, publisher dot at the foot.
      vText(t, cx, h * 0.46, Math.round(fs * 1.25), font, '700', h * 0.72, 'center');
      vText(author, cx, h * 0.09, Math.round(fs * 0.55), font, '400', h * 0.22);
      emblem(idx + 1, cx, h * 0.94, w * 0.13);
    } else if (variant === 2) {
      // Solid bands head and foot.
      c.fillRect(0, h * 0.035, w, h * 0.05);
      c.fillRect(0, h * 0.915, w, h * 0.05);
      const len = vText(t, cx, h * 0.14, fs, font, weight, h * 0.5);
      vText(author, cx, h * 0.16 + len + fs, Math.round(fs * 0.6), font, '400', h * 0.22);
      c.fillRect(w * 0.3, h * 0.855, w * 0.4, Math.max(1.5, w * 0.03));
    } else if (variant === 3 && w >= 50) {
      // Horizontal stacked words for wide spines.
      const words = t.split(' ');
      let y = h * 0.1;
      c.textAlign = 'center';
      c.textBaseline = 'top';
      for (const word of words) {
        let s = Math.round(w * 0.3);
        c.font = `700 ${s}px ${font}`;
        while (c.measureText(word).width > w * 0.86 && s > 6) {
          s -= 1;
          c.font = `700 ${s}px ${font}`;
        }
        c.fillText(word, cx, y);
        y += s * 1.15;
      }
      emblem(idx + 2, cx, y + w * 0.3, w * 0.17);
      vText(author, cx, h * 0.6, Math.round(fs * 0.6), font, '400', h * 0.3);
      c.fillRect(w * 0.2, h * 0.95, w * 0.6, Math.max(1.5, w * 0.03));
    } else {
      // Minimal modern: small title near the head, hairline, square mark at the foot.
      vText(t, cx, h * 0.06, Math.round(fs * 0.85), font, '400', h * 0.55);
      c.fillRect(w * 0.25, h * 0.7, w * 0.5, Math.max(1, w * 0.02));
      vText(author, cx, h * 0.73, Math.round(fs * 0.55), font, '400', h * 0.15);
      emblem(3, cx, h * 0.93, w * 0.12);
    }
    c.restore();
  });
}

/** Page-block edges: cream with fine leaf lines running along v (stack axis = u). */
function drawPages(c: CanvasRenderingContext2D, W_: number, H_: number): void {
  const rng = createRng(4402);
  c.fillStyle = '#ece3cf';
  c.fillRect(0, 0, W_, H_);
  for (let x = 0; x < W_; x += 2) {
    const a = rng() < 0.1 ? 0.2 + rng() * 0.2 : 0.03 + rng() * 0.1;
    c.fillStyle = `rgba(105, 85, 55, ${a})`;
    c.fillRect(x, 0, 1, H_);
  }
  for (let i = 0; i < 260; i++) {
    c.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.1})`;
    c.fillRect(rng() * W_, rng() * H_, 1, 2 + rng() * 8);
  }
}

/** Golden pothos leaf: heart shape, tip at the top, notch (petiole) at the bottom. Alpha outside. */
function drawLeaf(c: CanvasRenderingContext2D, W_: number, H_: number): void {
  const rng = createRng(3131);
  const path = (): void => {
    c.beginPath();
    c.moveTo(128, 10);
    c.bezierCurveTo(196, 52, 240, 150, 212, 206);
    c.bezierCurveTo(192, 242, 152, 238, 128, 224);
    c.bezierCurveTo(104, 238, 64, 242, 44, 206);
    c.bezierCurveTo(16, 150, 60, 52, 128, 10);
    c.closePath();
  };
  c.clearRect(0, 0, W_, H_);
  c.save();
  path();
  c.clip();
  const g = c.createLinearGradient(0, 0, 0, H_);
  g.addColorStop(0, '#36612f');
  g.addColorStop(0.55, '#3f7136');
  g.addColorStop(1, '#2f5a2b');
  c.fillStyle = g;
  c.fillRect(0, 0, W_, H_);
  // Variegation blotches.
  for (let i = 0; i < 9; i++) {
    const x = 40 + rng() * 176;
    const y = 30 + rng() * 190;
    const r = 8 + rng() * 22;
    const rg = c.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(205, 195, 90, ${0.35 + rng() * 0.3})`);
    rg.addColorStop(1, 'rgba(205, 195, 90, 0)');
    c.fillStyle = rg;
    c.beginPath();
    c.ellipse(x, y, r * (0.7 + rng() * 0.6), r, rng() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }
  // Mid-rib and side veins.
  c.strokeStyle = 'rgba(196, 214, 150, 0.55)';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(128, 222);
  c.lineTo(128, 16);
  c.stroke();
  c.lineWidth = 1.4;
  c.strokeStyle = 'rgba(196, 214, 150, 0.35)';
  for (let i = 0; i < 7; i++) {
    const y = 40 + i * 26;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(128, y + 8);
      c.quadraticCurveTo(128 + s * 40, y - 4, 128 + s * (78 - i * 4), y - 26 + i * 4);
      c.stroke();
    }
  }
  // Slightly darker rim.
  c.restore();
  path();
  c.strokeStyle = 'rgba(20, 45, 20, 0.6)';
  c.lineWidth = 2.5;
  c.stroke();
}

/** A dusk seascape for the framed photo (portrait). */
function drawPhoto(c: CanvasRenderingContext2D, W_: number, H_: number): void {
  const rng = createRng(6161);
  const sky = c.createLinearGradient(0, 0, 0, H_ * 0.62);
  sky.addColorStop(0, '#26355a');
  sky.addColorStop(0.55, '#8d6a78');
  sky.addColorStop(0.85, '#d98a5c');
  sky.addColorStop(1, '#f2c27c');
  c.fillStyle = sky;
  c.fillRect(0, 0, W_, H_);
  // Sun.
  const sg = c.createRadialGradient(W_ * 0.62, H_ * 0.58, 4, W_ * 0.62, H_ * 0.58, 70);
  sg.addColorStop(0, 'rgba(255, 240, 200, 1)');
  sg.addColorStop(0.25, 'rgba(255, 210, 140, 0.8)');
  sg.addColorStop(1, 'rgba(255, 200, 120, 0)');
  c.fillStyle = sg;
  c.fillRect(0, 0, W_, H_);
  // Sea.
  const sea = c.createLinearGradient(0, H_ * 0.62, 0, H_);
  sea.addColorStop(0, '#c98a68');
  sea.addColorStop(0.3, '#6c5a6e');
  sea.addColorStop(1, '#2c3346');
  c.fillStyle = sea;
  c.fillRect(0, H_ * 0.62, W_, H_ * 0.38);
  for (let i = 0; i < 260; i++) {
    const y = H_ * 0.62 + rng() * H_ * 0.38;
    const t = (y - H_ * 0.62) / (H_ * 0.38);
    c.fillStyle = `rgba(255, 220, 170, ${(0.35 - t * 0.3) * rng()})`;
    c.fillRect(W_ * 0.62 + (rng() - 0.5) * (40 + t * 260), y, 6 + rng() * 30 * (0.3 + t), 1 + t * 2);
  }
  // Headlands.
  c.fillStyle = '#2a2632';
  c.beginPath();
  c.moveTo(0, H_ * 0.66);
  c.lineTo(0, H_ * 0.5);
  c.bezierCurveTo(W_ * 0.12, H_ * 0.47, W_ * 0.22, H_ * 0.56, W_ * 0.38, H_ * 0.66);
  c.closePath();
  c.fill();
  c.fillStyle = '#3a3340';
  c.beginPath();
  c.moveTo(W_, H_ * 0.64);
  c.lineTo(W_, H_ * 0.55);
  c.bezierCurveTo(W_ * 0.9, H_ * 0.55, W_ * 0.84, H_ * 0.6, W_ * 0.74, H_ * 0.64);
  c.closePath();
  c.fill();
  // Foreground rocks.
  c.fillStyle = '#17161c';
  c.beginPath();
  c.moveTo(0, H_);
  c.lineTo(0, H_ * 0.86);
  c.bezierCurveTo(W_ * 0.15, H_ * 0.8, W_ * 0.3, H_ * 0.9, W_ * 0.45, H_);
  c.closePath();
  c.fill();
  // Grain + vignette.
  for (let i = 0; i < 6000; i++) {
    c.fillStyle = `rgba(0,0,0,${rng() * 0.06})`;
    c.fillRect(rng() * W_, rng() * H_, 1, 1);
  }
  const vg = c.createRadialGradient(W_ / 2, H_ / 2, H_ * 0.3, W_ / 2, H_ / 2, H_ * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.35)');
  c.fillStyle = vg;
  c.fillRect(0, 0, W_, H_);
}

const PALETTE = [0x6e2a2a, 0x8a3b32, 0x5a2431, 0x22314d, 0x1c2a3f, 0x2f4a3a, 0x3b5a40, 0xb0853a, 0xc09a56, 0x1c1b1a, 0x26262a, 0xe3d9c2, 0xd9cdb3, 0x7a7b7d, 0x5a5c60, 0xa88a63, 0x9a5330, 0x2c5a5e, 0xb3923d, 0xece7da, 0x4c5a6a, 0x5b3f2c, 0x3a3a3a, 0x8c6d4f, 0x24344a, 0x7b2e2a];
const SPINE_ALT = [0x1c1b1a, 0x5b3f2c, 0xa88a63, 0x6e2a2a, 0x22314d];
/** Everything in PALETTE that is not near-black: three dark spines in a row fuse into one slab in a shadowed bay. */
const PALETTE_LIGHT = [0x8a3b32, 0x3b5a40, 0xb0853a, 0xc09a56, 0xe3d9c2, 0xd9cdb3, 0xa88a63, 0xb3923d, 0xa8703a, 0x8c6d4f, 0x9a5330, 0x2c5a5e, 0x7a7b7d, 0x4c5a6a];
/** Covers for books lying face up: PALETTE's near-whites blow out under the window into a concrete slab. */
const STACK_PALETTE = [0x6e2a2a, 0x8a3b32, 0x22314d, 0x2f4a3a, 0xb0853a, 0x9a5330, 0x2c5a5e, 0x5b3f2c, 0x7b2e2a, 0x4c5a6a, 0x3b5a40, 0x24344a, 0x1c2a3f, 0x5a2431];

interface BookSpec {
  t: number;
  h: number;
  d: number;
  cover: THREE.Color;
  spine: THREE.Color;
  cloth: boolean;
  hard: boolean;
  cell: Cell | null;
  /** Stamping colour for the spine decal — gold foil, white, tan, pale blue. */
  ink: THREE.Color;
  uvOff: [number, number];
  /** Dust-jacket band laid across the +x board (the face that points up when flat). */
  band: THREE.Color | null;
}

class BookBuilder {
  readonly cloth: THREE.BufferGeometry[] = [];
  readonly smooth: THREE.BufferGeometry[] = [];
  readonly pages: THREE.BufferGeometry[] = [];
  readonly decals: THREE.BufferGeometry[] = [];
  count = 0;
  /** The last few spine designs used, so no title appears twice in one eyeful. */
  private readonly recent: Cell[] = [];
  /** How many near-black covers in a row — three of them merge into one slab. */
  private darkRun = 0;

  constructor(private readonly cells: Cell[], private readonly rng: () => number) {}

  private pickCell(aspect: number, lightSpine: boolean): Cell {
    let best = 0;
    let bestErr = Infinity;
    FAMILIES.forEach((f, i) => {
      const e = Math.abs(Math.log(aspect / f.aspect));
      if (e < bestErr) {
        bestErr = e;
        best = i;
      }
    });
    const all = this.cells.filter((c) => c.family === best && c.dark === lightSpine);
    // Recency has to be counted inside this pool, not globally: a global window
    // longer than the pool empties it and the design repeats two books later.
    const avoid = this.recent.filter((c) => all.includes(c)).slice(-Math.max(1, all.length - 2));
    const pool = all.filter((c) => !avoid.includes(c));
    const cell = (pool.length ? pool : all)[Math.floor(this.rng() * (pool.length || all.length))];
    this.recent.push(cell);
    if (this.recent.length > 40) this.recent.shift();
    return cell;
  }

  spec(h: number, t: number, d: number): BookSpec {
    const rng = this.rng;
    const jit = (a: number): number => (rng() - 0.5) * 2 * a;
    const src = this.darkRun >= 3 ? PALETTE_LIGHT : PALETTE;
    const cover = new THREE.Color(src[Math.floor(rng() * src.length)]).offsetHSL(jit(0.012), jit(0.06), jit(0.035));
    const hard = rng() < 0.68;
    const cloth = hard && rng() < 0.6;
    let spine = cover.clone();
    if (hard && rng() < 0.2) spine = new THREE.Color(SPINE_ALT[Math.floor(rng() * SPINE_ALT.length)]);
    // The spine is the face on show, so count the run of dark ones on that.
    this.darkRun = lightness(spine) < 0.32 ? this.darkRun + 1 : 0;
    const cell = rng() < 0.92 ? this.pickCell(h / t, lightness(spine) > 0.6) : null;
    // 40 designs carry 150 books, so each is stamped in its own foil colour: no two read as the same book.
    const ink = new THREE.Color().setHSL(
      rng() < 0.78 ? 0.06 + rng() * 0.09 : 0.5 + rng() * 0.12,
      rng() * rng() * 0.5,
      0.66 + rng() * 0.34,
      THREE.SRGBColorSpace,
    );
    return { t, h, d, cover, spine, cloth, hard, cell, ink, uvOff: [rng(), rng()], band: null };
  }

  /** Upright book in local space (thickness x, height y from 0, depth z, spine at +z), posed by `m`. */
  add(s: BookSpec, m: THREE.Matrix4): void {
    const { t, h, d } = s;
    const bt = s.hard ? 0.0025 : 0.0008; // board thickness
    const sq = s.hard ? 0.003 : 0.0006; // squares: how far the boards overhang the pages
    const boards: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      const b = box(bt, h, d - bt);
      b.translate((sx * (t - bt)) / 2, h / 2, -bt / 2);
      boards.push(addColor(b, s.cover));
    }
    const sp = box(t, h, bt);
    sp.translate(0, h / 2, d / 2 - bt / 2);
    boards.push(addColor(sp, s.spine));
    const weave = grainUv('y', s.uvOff[0], s.uvOff[1]);
    for (const b of boards) {
      planarUv(b, weave);
      b.applyMatrix4(m);
    }
    (s.cloth ? this.cloth : this.smooth).push(...boards);
    if (s.band) {
      // 0.7 mm proud of the cover: a belly band breaks up the one flat colour a
      // face-up cover would otherwise show, and catches its own sliver of shadow.
      const bnd = box(0.0007, h * 0.2, d - bt - 0.006);
      bnd.translate(t / 2 + 0.00035, h * 0.7, -bt / 2);
      planarUv(bnd, weave);
      bnd.applyMatrix4(m);
      (s.cloth ? this.cloth : this.smooth).push(addColor(bnd, s.band));
    }

    const pg = box(t - 2 * bt, h - 2 * sq, d - bt - sq);
    pg.translate(0, h / 2, (sq - bt) / 2);
    planarUv(pg, (p, n) => {
      const ax = Math.abs(n.x);
      const ay = Math.abs(n.y);
      const az = Math.abs(n.z);
      if (ay >= ax && ay >= az) return [p.x + s.uvOff[0], p.z];
      if (az >= ax) return [p.x + s.uvOff[0], p.y];
      return [p.z, p.y];
    });
    pg.applyMatrix4(m);
    this.pages.push(pg);

    if (s.cell) {
      const pl = new THREE.PlaneGeometry(t - 0.002, h - 0.008);
      pl.translate(0, h / 2, d / 2 + 0.0003);
      const uv = pl.getAttribute('uv') as THREE.BufferAttribute;
      const u0 = (s.cell.x + 1) / ATLAS;
      const u1 = (s.cell.x + s.cell.w - 1) / ATLAS;
      const vTop = 1 - (s.cell.y + 1) / ATLAS;
      const vBot = 1 - (s.cell.y + s.cell.h - 1) / ATLAS;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), vBot + uv.getY(i) * (vTop - vBot));
      addColor(pl, s.ink);
      pl.applyMatrix4(m);
      this.decals.push(pl);
    }
    this.count++;
  }
}

// Lathe profiles: [radius, y].
const POT_PROFILE: Array<[number, number]> = [
  [0, 0], [0.028, 0], [0.032, 0.002], [0.036, 0.012], [0.041, 0.04], [0.045, 0.07], [0.047, 0.088],
  [0.05, 0.092], [0.051, 0.097], [0.05, 0.1], [0.046, 0.1], [0.045, 0.096], [0.0435, 0.085], [0, 0.085],
];
const VASE_PROFILE: Array<[number, number]> = [
  [0, 0], [0.03, 0], [0.034, 0.002], [0.042, 0.02], [0.048, 0.06], [0.047, 0.1], [0.04, 0.14], [0.03, 0.17],
  [0.023, 0.195], [0.021, 0.215], [0.023, 0.222], [0.017, 0.222], [0.016, 0.21], [0, 0.2],
];

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'bookshelf';
  const rng = createRng(ctx.seed + 501);
  const rnd = (a: number, b: number): number => a + rng() * (b - a);
  const jit = (a: number): number => (rng() - 0.5) * 2 * a;
  const M = ctx.materials;
  const T = ctx.textures;

  /** Library wood retempered: the roughness map has to go before `roughness` bites, and `clone()` shares textures. */
  const temper = (src: THREE.MeshPhysicalMaterial, name: string, roughness: number, env: number, normal: number): THREE.MeshPhysicalMaterial => {
    const m = src.clone();
    m.name = name;
    m.roughnessMap = null;
    m.roughness = roughness;
    m.envMapIntensity = env;
    m.normalScale.set(normal, normal);
    m.clearcoat = 0;
    m.specularIntensity = 0.3;
    m.specularColor.set(0xd9bb92);
    if (m.map) m.map = anisotropic(m.map);
    if (m.normalMap) m.normalMap = anisotropic(m.normalMap);
    m.needsUpdate = true;
    return m;
  };
  // A metre of flat board under the window goes steel-blue at satin roughness; hand-oiled walnut is matte.
  const walnutFlat = temper(M.wood('walnut', { surface: [1, 1] }), 'bookshelf:walnutFlat', 0.7, 0.12, 0.22);
  // The flanks are 0.7 m² each, the largest surface here: at the flat temper they read as painted MDF.
  const walnutUp = walnutFlat.clone();
  walnutUp.name = 'bookshelf:walnutUpright';
  walnutUp.roughness = 0.5;
  walnutUp.envMapIntensity = 0.16;
  walnutUp.normalScale.set(0.5, 0.5);
  walnutUp.specularIntensity = 0.45;
  // Nothing bounces into the back of a deep bay, so a sparsely filled one goes to pure
  // black. The back board is stained lighter than the carcass to stay a readable surface.
  const walnutBack = walnutUp.clone();
  walnutBack.name = 'bookshelf:walnutBack';
  walnutBack.color.setRGB(1.5, 1.4, 1.3);
  walnutBack.normalScale.set(0.3, 0.3); // a 6 mm veneered back, not a corduroy board
  walnutBack.envMapIntensity = 0.35;

  const flatPanels: THREE.BufferGeometry[] = [];
  const upPanels: THREE.BufferGeometry[] = [];
  const backPanel: THREE.BufferGeometry[] = [];
  /** One carcass panel. `sv` squeezes the cross-grain figure: 2.4-3.2 puts rings 6-10 mm apart, a flank needs ~1.5. */
  const panel = (into: THREE.BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z: number, grain: 'x' | 'y', r = 0.002, sv: [number, number] = [2.4, 3.2]): void => {
    const geo = roundedBox(w, h, d, r, 2);
    planarUv(geo, grainUv(grain, rnd(0, 7), rnd(0, 7), rnd(0.8, 1.3), rnd(sv[0], sv[1])));
    geo.translate(x, y, z);
    into.push(geo);
  };
  const sideH = H - TOP_T;
  for (const sx of [-1, 1]) panel(upPanels, SIDE_T, sideH, D, sx * (W / 2 - SIDE_T / 2), sideH / 2, 0, 'y', 0.002, [1.3, 1.7]);
  panel(flatPanels, W, TOP_T, D, 0, H - TOP_T / 2, 0, 'x');
  panel(flatPanels, INNER_W + 0.004, BOTTOM_T, SHELF_D, 0, PLINTH_H + BOTTOM_T / 2, SHELF_Z, 'x');
  // The kicks stand exactly on the floor and run 2 mm up into the bottom panel.
  panel(upPanels, INNER_W + 0.004, PLINTH_H + 0.002, 0.02, 0, PLINTH_H / 2 + 0.001, SHELF_FRONT - 0.026, 'x', 0.001); // front kick, recessed 15 mm
  panel(upPanels, INNER_W + 0.004, PLINTH_H + 0.002, 0.02, 0, PLINTH_H / 2 + 0.001, BACK_FRONT_Z + 0.01, 'x', 0.001); // rear kick
  panel(backPanel, INNER_W + 0.004, sideH - PLINTH_H + 0.002, BACK_T, 0, (sideH + PLINTH_H) / 2, -D / 2 + BACK_T / 2, 'x', 0.0005); // veneered back, grain across
  for (let i = 1; i < BAYS.length; i++) panel(flatPanels, INNER_W + 0.004, SHELF_T, SHELF_D, 0, SHELF_Y[i] - SHELF_T / 2, SHELF_Z, 'x');
  for (const bay of [0, 1]) panel(upPanels, DIV_T, BAYS[bay] + 0.002, SHELF_D - 0.002, 0, SHELF_Y[bay] + BAYS[bay] / 2, SHELF_Z, 'y');
  g.add(mesh(unify(flatPanels), walnutFlat, undefined, { name: 'carcassBoards' }));
  g.add(mesh(unify(upPanels), walnutUp, undefined, { name: 'carcassUprights' }));
  g.add(mesh(unify(backPanel), walnutBack, undefined, { name: 'carcassBack' }));

  const cells = buildCells();
  const atlas = T.canvas('bookshelf:spines', ATLAS, ATLAS, (c) => drawSpineAtlas(c, cells));
  const pagesTex = T.canvas('bookshelf:pages', 256, 256, drawPages);
  pagesTex.wrapS = THREE.RepeatWrapping;
  pagesTex.wrapT = THREE.RepeatWrapping;
  pagesTex.repeat.set(20, 20); // one 256 px tile = 50 mm
  pagesTex.needsUpdate = true;

  const clothMat = M.fabric(0xffffff, { scale: 2, surface: [1, 1] }).clone();
  clothMat.vertexColors = true;
  clothMat.sheen = 0.22;
  clothMat.sheenColor.set(0xf2e6d2);
  clothMat.normalScale.set(0.5, 0.5);
  clothMat.envMapIntensity = 0.45;
  clothMat.name = 'bookshelf:cloth';
  const smoothMat = M.custom({ color: 0xffffff, vertexColors: true, roughness: 0.44, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.4, specularIntensity: 0.6, envMapIntensity: 0.5 });
  smoothMat.name = 'bookshelf:smoothCover';
  // Cream paper takes the cool sky probe at full strength and renders slate, so warm it and damp the env.
  const pagesMat = M.custom({ map: pagesTex, color: 0xffeed2, roughness: 0.93, metalness: 0, envMapIntensity: 0.3 });
  pagesMat.name = 'bookshelf:pages';
  const decalMat = M.custom({ map: atlas, vertexColors: true, alphaTest: 0.35, roughness: 0.5, metalness: 0.25, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  decalMat.name = 'bookshelf:spineDecal';

  const books = new BookBuilder(cells, rng);
  /** Height / thickness / depth for one book; `maxD` stops a run piercing the 6 mm back panel. */
  const dims = (h: [number, number], t: [number, number], maxH: number, maxD = 0.22): [number, number, number] => {
    const tt = rnd(t[0], t[1]);
    const hh = Math.min(maxH, rnd(h[0], h[1]) + (tt - t[0]) * 0.35);
    const hi = clamp(maxD, 0.1, 0.22);
    const dd = clamp(hh * rnd(0.62, 0.74), Math.min(0.13, hi), hi);
    return [hh, tt, dd];
  };
  /** Clearance from a spine line back to the front face of the back panel. */
  const depthLimit = (zLine: number): number => zLine - BACK_FRONT_Z - 0.004;

  interface RunOpts { bay: number; x0: number; width: number; z?: number; h: [number, number]; t: [number, number]; pullProb?: number; lift?: number; gap?: number }
  /** Upright run left → right; returns the x where it ended. */
  const placeRun = (o: RunOpts): number => {
    const y = SHELF_Y[o.bay] + (o.lift ?? 0);
    const zLine = o.z ?? SPINE_Z;
    const maxH = BAYS[o.bay] - 0.012;
    const maxD = depthLimit(zLine);
    let x = o.x0;
    const end = o.x0 + o.width;
    let series = 0;
    let last: BookSpec | null = null;
    for (;;) {
      let s: BookSpec;
      if (series > 0 && last) {
        s = { ...last, uvOff: [rng(), rng()] };
        series--;
      } else {
        const [h, t, d] = dims(o.h, o.t, maxH, maxD);
        s = books.spec(h, t, d);
        // Matching sets are what a real shelf has, but four near-black clones in a
        // row fuse into one slab in a shadowed bay — only light spines get a series.
        if (rng() < 0.18 && lightness(s.spine) > 0.3) series = 1 + Math.floor(rng() * 3);
        last = s;
      }
      if (x + s.t > end) break;
      const pulled = rng() < (o.pullProb ?? 0.08);
      const zf = zLine + (pulled ? rnd(0.005, 0.015) : jit(0.002));
      books.add(s, translation(x + s.t / 2, y, zf - s.d / 2));
      x += s.t + (o.gap ?? rnd(0.0003, 0.0015));
    }
    return x;
  };

  interface FanOpts { bay: number; supportX: number; supportH?: number; dir?: 1 | -1; count: number; angle: number; z?: number; h: [number, number]; t: [number, number]; lift?: number }
  /** Books leaning toward `dir` against a vertical support at `supportX`; returns the far bottom-corner x. */
  const placeFan = (o: FanOpts): number => {
    const dir = o.dir ?? 1;
    const y0 = SHELF_Y[o.bay] + (o.lift ?? 0);
    const zLine = o.z ?? SPINE_Z;
    const maxH = BAYS[o.bay] - 0.02;
    const maxD = depthLimit(zLine);
    let p = 0;
    let prevT = 0;
    let th = deg(o.angle);
    for (let k = 0; k < o.count; k++) {
      const [h, t, d] = dims(o.h, o.t, maxH, maxD);
      const s = books.spec(h, t, d);
      th = deg(o.angle) * (1 + jit(0.05));
      if (k === 0) {
        const hTop = h * Math.cos(th);
        const hc = Math.min(hTop, o.supportH ?? Infinity);
        p = o.supportX - dir * (hc >= hTop - 1e-6 ? h * Math.sin(th) : hc * Math.tan(th));
      } else {
        p -= dir * (prevT / Math.cos(th) + 0.0006);
      }
      const m = translation(p, y0, zLine - d / 2 + jit(0.002))
        .multiply(new THREE.Matrix4().makeRotationZ(-dir * th))
        .multiply(translation((-dir * t) / 2, 0, 0));
      books.add(s, m);
      prevT = t;
    }
    return p - dir * (prevT / Math.cos(th));
  };

  interface StackOpts { y: number; xLeft: number; z?: number; count: number; h: [number, number]; t: [number, number] }
  /** Flat stack, cover up, head to the left; returns the top y. A near-white board facing up reads as foam. */
  const placeStack = (o: StackOpts): number => {
    let y = o.y;
    const zLine = o.z ?? SPINE_Z;
    const maxD = depthLimit(zLine);
    for (let k = 0; k < o.count; k++) {
      const [h, t, d] = dims(o.h, o.t, 1, maxD);
      const s = books.spec(h, t, d);
      s.hard = true;
      s.cover = new THREE.Color(STACK_PALETTE[Math.floor(rng() * STACK_PALETTE.length)]).offsetHSL(jit(0.012), jit(0.05), jit(0.03));
      if (lightness(s.spine) > 0.62) s.spine = s.cover.clone().offsetHSL(0, 0, -0.04);
      s.band = s.cover.clone().offsetHSL(jit(0.03), 0.06, lightness(s.cover) > 0.42 ? -0.2 : 0.22);
      const m = translation(o.xLeft + s.h + jit(0.004), y + s.t / 2, zLine - s.d / 2 + jit(0.003))
        .multiply(new THREE.Matrix4().makeRotationY(jit(deg(1.5))))
        .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
      books.add(s, m);
      y += s.t;
    }
    return y;
  };

  const brass = M.metal('brass').clone();
  brass.name = 'bookshelf:brass';
  brass.color.set(0xcda056);
  brass.roughness = 0.42;
  brass.envMapIntensity = 0.8;

  /** L-shaped brass bookend; `xIn` is the inner face of the plate, which must overtop the books it props. */
  const bookend = (xIn: number, bay: number, zFront: number): void => {
    const y = SHELF_Y[bay];
    const baseD = 0.125;
    const plateD = 0.115;
    const base = roundedBox(0.19, 0.005, baseD, 0.0012, 2);
    base.translate(xIn + 0.006 - 0.19 / 2, y + 0.0025, zFront - baseD / 2);
    const plate = roundedBox(0.006, BOOKEND_H, plateD, 0.002, 2);
    plate.translate(xIn + 0.003, y + BOOKEND_H / 2, zFront - 0.0055 - plateD / 2);
    g.add(mesh(unify([base, plate]), brass, undefined, { name: 'bookend' }));
  };

  // Oak takes the same treatment as the walnut: raw, its roughness map pins roughness to
  // 1 and the lid's upward face mirrors the cool sky probe as grey-blue concrete.
  const oak = temper(M.wood('oak', { surface: [1, 1] }), 'bookshelf:oak', 0.62, 0.15, 0.3);
  /** Lidded oak box; `y` is the surface it stands on, `rot` a small yaw. Height 0.102. */
  const woodBox = (x: number, y: number, z: number, rot = 0): void => {
    const bw = 0.24;
    const bd = 0.15;
    const grp = new THREE.Group();
    grp.name = 'woodBox';
    grp.position.set(x, y, z);
    grp.rotation.y = rot;
    const body = roundedBox(bw, 0.072, bd, 0.004, 2);
    body.translate(0, 0.036, 0);
    planarUv(body, grainUv('x', 0.3, 0.2, 1.1, 3.6));
    const lid = roundedBox(bw + 0.014, 0.02, bd + 0.014, 0.004, 2);
    lid.translate(0, 0.092, 0);
    planarUv(lid, grainUv('x', 2.7, 1.5, 0.95, 4.2));
    grp.add(mesh(unify([body, lid]), oak, undefined, { name: 'boxWood' }));
    // 10 mm reveal, inset 7 mm all round: a deep shadow line plus the lid overhang is
    // what makes a box read as lidded at 1-2 m. A 5 mm flush seam did not.
    grp.add(mesh(box(bw - 0.014, 0.01, bd - 0.014), M.rubber(0x17110c), [0, 0.077, 0], { name: 'boxReveal' }));
    const clasp = roundedBox(0.032, 0.026, 0.012, 0.0012, 2);
    clasp.translate(0, 0.08, bd / 2 + 0.006);
    const hinges: THREE.BufferGeometry[] = [clasp];
    for (const sx of [-1, 1]) {
      const hg = roundedBox(0.026, 0.014, 0.01, 0.001, 2);
      hg.translate(sx * 0.07, 0.086, -bd / 2 - 0.005);
      hinges.push(hg);
    }
    grp.add(mesh(unify(hinges), brass, undefined, { name: 'boxFittings' }));
    g.add(grp);
  };

  const vase = (x: number, bay: number, z: number): void => {
    g.add(mesh(lathe(VASE_PROFILE, 48), M.ceramic(0xcbc3b4, false), [x, SHELF_Y[bay], z], { name: 'vase' }));
  };

  /** Fabric-wrapped smart speaker, 84 mm across and 127 mm tall, on the surface at `y`. */
  const speaker = (x: number, y: number, z: number): void => {
    const R = 0.042;
    // The library fabric carries 0.6 sheen and 0.6 env, which on an 84 mm tube washes a
    // dark grille out to pale taupe: pull the albedo down, trade sheen for relief.
    const cloth = M.fabric(0x44464d, { scale: 3, surface: [0.132, 0.06] }).clone();
    cloth.name = 'bookshelf:speakerCloth';
    cloth.color.setRGB(0.72, 0.72, 0.75);
    cloth.normalScale.set(1, 1);
    cloth.sheen = 0.3;
    cloth.sheenColor.set(0x5c5e66);
    cloth.envMapIntensity = 0.28;
    g.add(mesh(cylinder(0.039, 0.039, 0.004, 32), M.rubber(0x161618), [x, y + 0.002, z], { name: 'speakerFoot' }));
    g.add(mesh(cylinder(R, R * 0.99, 0.106, 48), cloth, [x, y + 0.057, z], { name: 'speakerBody' }));
    // Bezel and domed cap, anodised not polished: a polished 5 mm ring blows out to an even white band.
    const bezel = M.metal('aluminum').clone();
    bezel.name = 'bookshelf:speakerBezel';
    bezel.color.set(0x7c8188);
    bezel.roughness = 0.5;
    bezel.envMapIntensity = 0.35;
    g.add(mesh(cylinder(R + 0.0012, R + 0.0012, 0.005, 48), bezel, [x, y + 0.1125, z], { name: 'speakerBezel' }));
    const cap: Array<[number, number]> = [[0, 0], [0.0382, 0], [0.0408, 0.0018], [0.0414, 0.005], [0.0392, 0.0092], [0.028, 0.0122], [0, 0.0132]];
    g.add(mesh(lathe(cap, 48), M.plastic(0x24252a, 0.38), [x, y + 0.115, z], { name: 'speakerTop' }));
    const led = M.emissive(0x63e2d0, 1.4);
    led.name = 'bookshelf:speakerLed';
    g.add(mesh(cylinder(0.0045, 0.0045, 0.0012, 16), led, [x, y + 0.1258, z + 0.022], { name: 'speakerLed', cast: false }));
    ctx.lights.register({ name: 'bookshelfSpeakerLed', role: 'screen', emissives: [led] });
  };

  /** Framed 13 × 18 photo standing on the shelf, leaning back 12° onto the spines at `zSpines`. */
  const photo = (x: number, bay: number, zSpines: number): void => {
    const tilt = deg(12);
    const FH = 0.235;
    const FW = 0.18;
    const ph = new THREE.Group();
    ph.name = 'framedPhoto';
    ph.position.set(x, SHELF_Y[bay], zSpines + FH * Math.sin(tilt) + 0.0015);
    ph.rotation.x = -tilt;
    const outer = new THREE.Shape();
    outer.moveTo(-FW / 2, 0);
    outer.lineTo(FW / 2, 0);
    outer.lineTo(FW / 2, FH);
    outer.lineTo(-FW / 2, FH);
    outer.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-0.075, 0.015);
    hole.lineTo(-0.075, 0.22);
    hole.lineTo(0.075, 0.22);
    hole.lineTo(0.075, 0.015);
    hole.closePath();
    outer.holes.push(hole);
    const frame = new THREE.ExtrudeGeometry(outer, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.001, bevelSize: 0.001, bevelSegments: 2, curveSegments: 4 });
    frame.translate(0, 0, 0.001);
    ph.add(mesh(frame, M.paintedWood(0x1c1a18, 'satin'), undefined, { name: 'frame' }));
    ph.add(mesh(box(0.148, 0.203, 0.003), M.plastic(0x2a2a2a, 0.8), [0, 0.1175, 0.0095], { name: 'backBoard' }));
    const photoTex = T.canvas('bookshelf:photo', 384, 512, drawPhoto);
    const pic = new THREE.PlaneGeometry(0.13, 0.18);
    ph.add(mesh(pic, M.custom({ map: photoTex, roughness: 0.55, metalness: 0 }), [0, 0.1175, 0.0112], { name: 'photo', cast: false }));
    const matShape = new THREE.Shape();
    matShape.moveTo(-0.074, 0.016);
    matShape.lineTo(0.074, 0.016);
    matShape.lineTo(0.074, 0.219);
    matShape.lineTo(-0.074, 0.219);
    matShape.closePath();
    const opening = new THREE.Path();
    opening.moveTo(-0.055, 0.0375);
    opening.lineTo(-0.055, 0.1975);
    opening.lineTo(0.055, 0.1975);
    opening.lineTo(0.055, 0.0375);
    opening.closePath();
    matShape.holes.push(opening);
    const mat = new THREE.ExtrudeGeometry(matShape, { depth: 0.0015, bevelEnabled: false });
    mat.translate(0, 0, 0.0115);
    ph.add(mesh(mat, M.paper(0xf6f3ec), undefined, { name: 'mat' }));
    const glass = new THREE.PlaneGeometry(0.148, 0.203);
    ph.add(mesh(glass, M.glass({ opacity: 0.08 }), [0, 0.1175, 0.0136], { name: 'glass', cast: false }));
    g.add(ph);
  };

  /** Pothos: pot on the shelf, three vines trailing ~0.30 m over the front edge; leaves spaced by arc length. */
  const plant = (x: number, bay: number, z: number): number => {
    const y = SHELF_Y[bay];
    g.add(mesh(lathe(POT_PROFILE, 48), M.ceramic(0xb5674b, false), [x, y, z], { name: 'pot' }));
    g.add(mesh(cylinder(0.0432, 0.0432, 0.004, 40), M.rubber(0x2a211a), [x, y + 0.087, z], { name: 'soil' }));
    const leafTex = T.canvas('bookshelf:leaf', 256, 256, drawLeaf);
    const leafMat = M.custom({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.3 });
    leafMat.name = 'bookshelf:leaf';
    const stemMat = M.plastic(0x4d6c3c, 0.7);
    const stems: THREE.BufferGeometry[] = [];
    const leaves: THREE.BufferGeometry[] = [];
    const soilY = y + 0.089;
    const edgeZ = SHELF_FRONT + 0.002;
    const vines = [
      { a: -0.62, xEnd: x - 0.095, drop: 0.3, zHang: 0.021, wob: 0.03 },
      { a: -0.05, xEnd: x - 0.015, drop: 0.24, zHang: 0.015, wob: -0.026 },
      { a: 0.72, xEnd: x + 0.1, drop: 0.28, zHang: 0.018, wob: 0.022 },
    ];
    let leafCount = 0;
    for (const vn of vines) {
      const dx = Math.sin(vn.a);
      const dz = Math.cos(vn.a);
      const pts = [
        v3(x + dx * 0.012, soilY - 0.006, z + dz * 0.012),
        v3(x + dx * 0.034, soilY + 0.034, z + dz * 0.034),
        v3(x + dx * 0.062, y + 0.118, z + dz * 0.056),
        v3(x + (vn.xEnd - x) * 0.55 + dx * 0.03, y + 0.072, z + 0.072),
        v3(vn.xEnd - vn.wob * 0.25, y + 0.006, edgeZ - 0.04),
        v3(vn.xEnd, y + 0.004, edgeZ),
        v3(vn.xEnd + vn.wob * 0.5, y - vn.drop * 0.2, edgeZ + vn.zHang),
        v3(vn.xEnd + vn.wob, y - vn.drop * 0.48, edgeZ + vn.zHang * 0.7),
        v3(vn.xEnd + vn.wob * 0.45, y - vn.drop * 0.74, edgeZ + vn.zHang * 1.2),
        v3(vn.xEnd + vn.wob * 1.3, y - vn.drop, edgeZ + vn.zHang * 0.75),
      ];
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      // 3.5 mm stem: a 2.5 mm tube at this distance is a hair, not a vine.
      stems.push(new THREE.TubeGeometry(curve, 56, 0.0035, 6, false));
      const len = curve.getLength();
      const n = clamp(Math.round(len / 0.048), 9, 11); // a leaf every ~4.8 cm of arc
      for (let i = 0; i < n; i++) {
        const s = clamp(0.15 + ((0.98 - 0.15) * i) / (n - 1) + jit(0.018), 0.05, 0.99);
        const P = curve.getPointAt(s);
        const tan = curve.getTangentAt(s);
        const onShelf = P.y > y + 0.03;
        const side = i % 2 === 0 ? -1 : 1;
        const perp = v3(-tan.z, 0, tan.x).normalize().multiplyScalar(side);
        const l = rnd(0.062, 0.098);
        const w = l * rnd(0.72, 0.82);
        let tip: THREE.Vector3;
        let up: THREE.Vector3;
        if (onShelf) {
          tip = perp.clone().multiplyScalar(0.6).add(v3(0, 0.25, 0.7)).normalize();
          up = v3(0, 1, 0.2);
        } else {
          tip = v3(perp.x * 0.45 + jit(0.35), -1, 0.4 + rng() * 0.35).normalize();
          up = v3(0, 0.35, 1);
        }
        const petDir = perp.clone().multiplyScalar(0.7).add(tip.clone().multiplyScalar(0.4)).normalize();
        const B = P.clone().addScaledVector(petDir, 0.02);
        const mid = P.clone().lerp(B, 0.5).add(v3(0, 0.004, 0));
        stems.push(tube([P, mid, B], 0.0017, 5, 5));
        const leaf = new THREE.PlaneGeometry(w, l, 4, 7);
        leaf.translate(0, l / 2 - 0.13 * l, 0);
        const pos = leaf.getAttribute('position') as THREE.BufferAttribute;
        const droop = rnd(0.28, 0.5);
        const fold = rnd(0.16, 0.3);
        for (let j = 0; j < pos.count; j++) {
          const lx = pos.getX(j);
          const ly = pos.getY(j);
          const yn = (ly + 0.13 * l) / l;
          pos.setZ(j, -droop * l * yn * yn - fold * Math.abs(lx) + 0.006 * l * Math.sin(yn * 6.3));
        }
        leaf.computeVertexNormals();
        leaf.applyMatrix4(basisAt(B, tip, up, jit(deg(22))));
        leaves.push(leaf);
        leafCount++;
      }
    }
    g.add(mesh(unify(stems), stemMat, undefined, { name: 'vines' }));
    g.add(mesh(unify(leaves), leafMat, undefined, { name: 'leaves' }));
    return leafCount;
  };

  const L = -HALF_IN + 0.003; // usable left edge
  const R = HALF_IN - 0.003; // usable right edge
  const DIV_L = -DIV_T / 2 - 0.003; // left of the divider
  const DIV_R = DIV_T / 2 + 0.003;

  placeRun({ bay: 0, x0: L, width: DIV_L - L - 0.004, h: [0.25, 0.32], t: [0.032, 0.062], pullProb: 0.08 });
  placeRun({ bay: 0, x0: DIV_R, width: 0.278, h: [0.29, 0.35], t: [0.034, 0.065], pullProb: 0.12 });
  const boxStack = placeStack({ y: SHELF_Y[0], xLeft: 0.305, count: 3, h: [0.235, 0.255], t: [0.028, 0.042] });
  woodBox(0.435, boxStack, 0.058, deg(3));

  // The bookend stands 65 mm clear of the divider and overtops the books it props, or no brass shows.
  const fanBaseX = -0.075;
  bookend(fanBaseX, 1, SPINE_Z + 0.005);
  const fan1 = placeFan({ bay: 1, supportX: fanBaseX, supportH: BOOKEND_H, count: 4, angle: 14, h: [0.155, 0.19], t: [0.022, 0.042], lift: 0.005 });
  placeRun({ bay: 1, x0: L, width: fan1 - L - 0.004, h: [0.22, 0.29], t: [0.024, 0.05], pullProb: 0.1 });
  const stack1 = placeStack({ y: SHELF_Y[1], xLeft: DIV_R + 0.014, count: 4, h: [0.205, 0.235], t: [0.024, 0.038] });
  speaker(DIV_R + 0.014 + 0.112, stack1, SPINE_Z - 0.095);
  placeRun({ bay: 1, x0: 0.28, width: R - 0.28, h: [0.19, 0.26], t: [0.02, 0.044], pullProb: 0.08 });

  placeRun({ bay: 2, x0: L, width: 0.6, h: [0.2, 0.28], t: [0.02, 0.05], pullProb: 0.1 });
  const fan2 = placeFan({ bay: 2, supportX: HALF_IN, count: 5, angle: 15, h: [0.19, 0.25], t: [0.022, 0.04] });
  placeRun({ bay: 2, x0: L + 0.605, width: fan2 - (L + 0.605) - 0.005, h: [0.19, 0.27], t: [0.02, 0.044], pullProb: 0.12 });

  // This bay is deliberately left ~40 % bare.
  placeRun({ bay: 3, x0: L, width: 0.56, z: 0.085, h: [0.25, 0.29], t: [0.024, 0.048], pullProb: 0 });
  photo(-0.315, 3, 0.088);
  vase(0.3, 3, SHELF_Z + 0.015);

  placeRun({ bay: 4, x0: L, width: 0.68, h: [0.18, 0.25], t: [0.021, 0.046], pullProb: 0.12 });
  placeRun({ bay: 4, x0: L + 0.69, width: 0.215, h: [0.175, 0.235], t: [0.018, 0.038], pullProb: 0.06 });
  placeStack({ y: SHELF_Y[4], xLeft: 0.345, count: 2, h: [0.2, 0.22], t: [0.028, 0.036] });

  placeRun({ bay: 5, x0: L, width: 0.44, h: [0.16, 0.2], t: [0.017, 0.04] });
  placeRun({ bay: 5, x0: L + 0.447, width: 0.39, h: [0.15, 0.19], t: [0.016, 0.034], pullProb: 0.1 });
  const leafCount = plant(0.4, 5, SHELF_Z + 0.05);

  placeStack({ y: H, xLeft: -0.5, z: SPINE_Z - 0.02, count: 3, h: [0.22, 0.27], t: [0.024, 0.038] });

  g.add(mesh(unify(books.cloth), clothMat, undefined, { name: 'booksCloth' }));
  g.add(mesh(unify(books.smooth), smoothMat, undefined, { name: 'booksSmooth' }));
  g.add(mesh(unify(books.pages), pagesMat, undefined, { name: 'bookPages' }));
  g.add(mesh(unify(books.decals), decalMat, undefined, { name: 'spineDecals', cast: false }));

  console.log(`[module] bookshelf: ${books.count} books, ${leafCount} leaves`);
  return g;
}
