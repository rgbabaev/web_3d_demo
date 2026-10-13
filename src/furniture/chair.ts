import * as THREE from 'three';
import { cylinder, lathe, mergeGeometries, mesh, roundedBox } from '../core/geometry';
import { createRng } from '../core/noise';
import type { SceneContext } from '../core/types';

const DEG = Math.PI / 180;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Seamless value noise on a G × G lattice, sampled in lattice units. */
function latticeNoise(G: number, seed: number): (x: number, y: number) => number {
  const grid: number[] = [];
  let st = seed >>> 0;
  for (let i = 0; i < G * G; i++) {
    st = (st * 1664525 + 1013904223) >>> 0;
    grid.push(st / 4294967296);
  }
  const at = (x: number, y: number): number => grid[(((y % G) + G) % G) * G + (((x % G) + G) % G)];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = smooth(x - xi);
    const fy = smooth(y - yi);
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), fx), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), fx), fy);
  };
}

function xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
  m.setPosition(x, y, z);
  return m;
}

function bake(g: THREE.BufferGeometry, ...ms: THREE.Matrix4[]): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  for (const k of ms) m.multiply(k);
  g.applyMatrix4(m);
  return g;
}

/** Merge geometries that share a material; RoundedBox is non-indexed, so unify first. */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const uni = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = mergeGeometries(uni, false);
  if (!out) throw new Error('chair: mergeGeometries failed');
  return out;
}

interface Frame {
  p: THREE.Vector3;
  b: THREE.Vector3; // section x axis
  n: THREE.Vector3; // section y axis
  sb: number; // scale along b
  sn: number; // scale along n
}

interface Section {
  x: number[];
  y: number[];
  nx: number[];
  ny: number[];
}

/** Rounded-rectangle section, CCW, with per-vertex outward normals. */
function roundedRectSection(w: number, h: number, r: number, cornerSegs = 3): Section {
  const rr = Math.min(r, w / 2, h / 2);
  const s: Section = { x: [], y: [], nx: [], ny: [] };
  const corners: Array<[number, number, number]> = [
    [w / 2 - rr, h / 2 - rr, 0],
    [-w / 2 + rr, h / 2 - rr, Math.PI / 2],
    [-w / 2 + rr, -h / 2 + rr, Math.PI],
    [w / 2 - rr, -h / 2 + rr, Math.PI * 1.5],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= cornerSegs; i++) {
      const a = a0 + (i / cornerSegs) * (Math.PI / 2);
      const c = Math.cos(a);
      const sn = Math.sin(a);
      s.x.push(cx + rr * c);
      s.y.push(cy + rr * sn);
      s.nx.push(c);
      s.ny.push(sn);
    }
  }
  return s;
}

function loft(frames: Frame[], sec: Section, opts: { closed?: boolean; caps?: boolean } = {}): THREE.BufferGeometry {
  const M = sec.x.length;
  const F = frames.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const nn = new THREE.Vector3();
  for (let i = 0; i < F; i++) {
    const f = frames[i];
    for (let j = 0; j < M; j++) {
      v.copy(f.p).addScaledVector(f.b, sec.x[j] * f.sb).addScaledVector(f.n, sec.y[j] * f.sn);
      nn.set(0, 0, 0).addScaledVector(f.b, sec.nx[j] / f.sb).addScaledVector(f.n, sec.ny[j] / f.sn).normalize();
      pos.push(v.x, v.y, v.z);
      nor.push(nn.x, nn.y, nn.z);
      uv.push(i / Math.max(1, F - 1), j / M);
    }
  }
  const t = new THREE.Vector3().subVectors(frames[1].p, frames[0].p);
  const flip = new THREE.Vector3().crossVectors(frames[0].b, frames[0].n).dot(t) < 0;
  const segs = opts.closed ? F : F - 1;
  for (let i = 0; i < segs; i++) {
    const i1 = (i + 1) % F;
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M;
      const a = i * M + j;
      const b = i * M + j1;
      const c = i1 * M + j1;
      const d = i1 * M + j;
      if (flip) idx.push(a, c, b, a, d, c);
      else idx.push(a, b, c, a, c, d);
    }
  }
  if (opts.caps && !opts.closed) {
    const cap = (fi: number, dir: 1 | -1): void => {
      const f = frames[fi];
      const tn = new THREE.Vector3().crossVectors(f.b, f.n).normalize().multiplyScalar(flip ? -dir : dir);
      const base = pos.length / 3;
      pos.push(f.p.x, f.p.y, f.p.z);
      nor.push(tn.x, tn.y, tn.z);
      uv.push(0.5, 0.5);
      for (let j = 0; j < M; j++) {
        const k = (fi * M + j) * 3;
        pos.push(pos[k], pos[k + 1], pos[k + 2]);
        nor.push(tn.x, tn.y, tn.z);
        uv.push(sec.x[j], sec.y[j]);
      }
      for (let j = 0; j < M; j++) {
        const j1 = (j + 1) % M;
        const forward = (dir === 1) !== flip;
        if (forward) idx.push(base, base + 1 + j, base + 1 + j1);
        else idx.push(base, base + 1 + j1, base + 1 + j);
      }
    };
    cap(0, -1);
    cap(F - 1, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Frames along a polyline: tangent by central differences, `ref` picks the section x axis. */
function framesAlong(
  points: THREE.Vector3[],
  ref: THREE.Vector3,
  scale: (u: number) => [number, number],
  closed = false,
): Frame[] {
  const F = points.length;
  const out: Frame[] = [];
  for (let i = 0; i < F; i++) {
    const prev = points[closed ? (i - 1 + F) % F : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % F : Math.min(F - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(next, prev).normalize();
    const b = ref.clone().addScaledVector(t, -ref.dot(t)).normalize();
    const n = new THREE.Vector3().crossVectors(t, b).normalize();
    const [sb, sn] = scale(i / Math.max(1, F - 1));
    out.push({ p: points[i], b, n, sb: Math.max(0.05, sb), sn: Math.max(0.05, sn) });
  }
  return out;
}

function curvePoints(pts: THREE.Vector3[], count: number, tension = 0.5): THREE.Vector3[] {
  return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', tension).getSpacedPoints(count);
}

type Deform = (p: THREE.Vector3, n: THREE.Vector3) => void;

function softBox(
  w: number,
  h: number,
  d: number,
  r: number,
  opts: { band?: number; flat?: [number, number, number]; deform?: Deform } = {},
): THREE.BufferGeometry {
  const band = opts.band ?? 5;
  const flat = opts.flat ?? [6, 2, 6];
  const half = [w / 2, h / 2, d / 2];
  const rr = Math.min(r, half[0], half[1], half[2]) * 0.999;
  const inner = half.map((H) => H - rr);
  const coords = half.map((H, axis) => {
    const list: number[] = [];
    const inn = H - rr;
    for (let i = 0; i <= band; i++) list.push(-inn - rr * Math.tan(((1 - i / band) * Math.PI) / 4));
    if (inn > 1e-6) for (let i = 1; i < flat[axis]; i++) list.push(-inn + (2 * inn * i) / flat[axis]);
    for (let i = 0; i <= band; i++) list.push(inn + rr * Math.tan(((i / band) * Math.PI) / 4));
    return list;
  });
  /** Surface arc length for a box coordinate: the fillet bands are tan-spaced, so a raw coordinate ribs the weave. */
  const arc = (t: number, axis: number): number => {
    const inn = inner[axis];
    const a = Math.abs(t);
    return a <= inn ? t : Math.sign(t) * (inn + rr * Math.atan((a - inn) / rr));
  };
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const c = [0, 0, 0];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const vv = (axis + 2) % 3;
    for (const sgn of [1, -1]) {
      const cu = coords[u];
      const cv = coords[vv];
      const base = pos.length / 3;
      for (let i = 0; i < cu.length; i++) {
        for (let j = 0; j < cv.length; j++) {
          c[axis] = sgn * half[axis];
          c[u] = cu[i];
          c[vv] = cv[j];
          const q = [0, 1, 2].map((k) => Math.min(inner[k], Math.max(-inner[k], c[k])));
          n.set(c[0] - q[0], c[1] - q[1], c[2] - q[2]).normalize();
          p.set(q[0] + n.x * rr, q[1] + n.y * rr, q[2] + n.z * rr);
          opts.deform?.(p, n);
          pos.push(p.x, p.y, p.z);
          nor.push(n.x, n.y, n.z);
          uv.push(arc(cu[i], u) + axis * 0.37 + (sgn > 0 ? 0 : 0.61), arc(cv[j], vv) + axis * 0.23);
        }
      }
      for (let i = 0; i < cu.length - 1; i++) {
        for (let j = 0; j < cv.length - 1; j++) {
          const a = base + i * cv.length + j;
          const b = base + (i + 1) * cv.length + j;
          const cc = base + (i + 1) * cv.length + j + 1;
          const dd = base + i * cv.length + j + 1;
          if (sgn > 0) idx.push(a, b, cc, a, cc, dd);
          else idx.push(a, cc, b, a, dd, cc);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Height-field style deformation y' = y - F(x, z) with the matching normal update. */
function lowerBy(p: THREE.Vector3, n: THREE.Vector3, F: number, Fx: number, Fz: number): void {
  p.y -= F;
  n.x += Fx * n.y;
  n.z += Fz * n.y;
}

const BACK = { W: 0.23, H: 0.6, rt: 0.075, rb: 0.055 } as const;

function backHalfWidth(t: number): number {
  return 0.205 + 0.025 * (t / BACK.H);
}

/** Depth profile (back-local z) of the mesh surface at (x, y). */
function backDepth(x: number, y: number): number {
  const lumbar = 0.032 * Math.exp(-(((y - 0.16) / 0.11) ** 2));
  const upper = -0.03 * smooth((y - 0.3) / 0.3);
  const cup = 0.04 * (x / BACK.W) ** 2;
  return lumbar + upper + cup;
}

function backNormal(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
  const e = 1e-4;
  const dx = (backDepth(x + e, y) - backDepth(x - e, y)) / (2 * e);
  const dy = (backDepth(x, y + e) - backDepth(x, y - e)) / (2 * e);
  return out.set(-dx, -dy, 1).normalize();
}

/** (s, t) on the un-tapered rectangle → back-local 3D point. */
function backPoint(s: number, t: number): THREE.Vector3 {
  const x = (s * backHalfWidth(t)) / BACK.W;
  return new THREE.Vector3(x, t, backDepth(x, t));
}

/** Square-to-disk mapping of the rectangle corners so the grid fits inside the rounded frame. */
function cornerMap(s: number, t: number): [number, number] {
  const { W, H, rt, rb } = BACK;
  let rc: number;
  let cy: number;
  if (t > H - rt) {
    rc = rt;
    cy = H - rt;
  } else if (t < rb) {
    rc = rb;
    cy = rb;
  } else return [s, t];
  const ax = Math.abs(s);
  if (ax <= W - rc) return [s, t];
  const ox = ax - (W - rc);
  const oy = t - cy;
  const l = Math.hypot(ox, oy);
  if (l < 1e-9) return [s, t];
  const k = Math.max(ox, Math.abs(oy)) / l;
  return [Math.sign(s) * (W - rc + ox * k), cy + oy * k];
}

function backMeshGeometry(ns = 30, nt = 40): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const n = new THREE.Vector3();
  for (let i = 0; i <= nt; i++) {
    for (let j = 0; j <= ns; j++) {
      const [s, t] = cornerMap(-BACK.W + (2 * BACK.W * j) / ns, (BACK.H * i) / nt);
      const p = backPoint(s, t);
      backNormal(p.x, p.y, n);
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
      uv.push((s + BACK.W) / (2 * BACK.W), t / BACK.H);
    }
  }
  for (let i = 0; i < nt; i++) {
    for (let j = 0; j < ns; j++) {
      const a = i * (ns + 1) + j;
      const b = a + 1;
      const c = a + ns + 2;
      const d = a + ns + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function backFrameGeometry(samples = 128): THREE.BufferGeometry {
  const { W, H, rt, rb } = BACK;
  const path = new THREE.Path();
  path.moveTo(W, rb);
  path.lineTo(W, H - rt);
  path.absarc(W - rt, H - rt, rt, 0, Math.PI / 2, false);
  path.lineTo(-W + rt, H);
  path.absarc(-W + rt, H - rt, rt, Math.PI / 2, Math.PI, false);
  path.lineTo(-W, rb);
  path.absarc(-W + rb, rb, rb, Math.PI, Math.PI * 1.5, false);
  path.lineTo(W - rb, 0);
  path.absarc(W - rb, rb, rb, Math.PI * 1.5, Math.PI * 2, false);
  const outline = path.getSpacedPoints(samples).slice(0, samples);
  const pts = outline.map((q) => backPoint(q.x, q.y));
  const frames: Frame[] = pts.map((p, i) => {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const next = pts[(i + 1) % pts.length];
    const t = new THREE.Vector3().subVectors(next, prev).normalize();
    const n = backNormal(p.x, p.y, new THREE.Vector3());
    const b = new THREE.Vector3().crossVectors(t, n).normalize(); // outward, in-surface
    return { p, b, n, sb: 1, sn: 1 };
  });
  return loft(frames, roundedRectSection(0.025, 0.017, 0.006, 3), { closed: true });
}

const WEAVE_CELLS = 8; // yarns per canvas tile, per axis
const WEAVE_RIB = 4; // every 4th yarn is a heavy float
const WEAVE_OPEN = 0.3; // opening side as a fraction of the yarn pitch
const WEAVE_TILE = 0.0513; // metres per tile → 6.4 mm yarns, 26 mm ribs

const isRib = (i: number): boolean => ((i % WEAVE_RIB) + WEAVE_RIB) % WEAVE_RIB === 0;

/** Opening beside yarn `i`, in pitch units. A rib crowds its neighbours: ~5 % mean open area, 6:1 across the grid. */
const weaveGap = (i: number): number => (isRib(i) || isRib(i - 1) ? WEAVE_OPEN * 0.45 : WEAVE_OPEN);

/** Plain-weave height in pitch units. A rib always floats over its crossing, so its 26 mm lattice survives mipping. */
function weaveHeight(u: number, v: number): number {
  const i = Math.floor(u);
  const j = Math.floor(v);
  const ri = isRib(i);
  const rj = isRib(j);
  const yarn = (d: number, rib: boolean): number => {
    const hw = rib ? 0.46 : 0.35;
    const a = Math.abs(d) / hw;
    return a < 1 ? (rib ? 1.3 : 1) * Math.sqrt(1 - a * a) : 0;
  };
  const warp = yarn(u - i - 0.5, ri);
  const weft = yarn(v - j - 0.5, rj);
  const warpOver = ri !== rj ? ri : ((i + j) & 1) === 0;
  return Math.max(warpOver ? warp : weft, (warpOver ? weft : warp) * 0.55);
}

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'chair';
  const rng = createRng(ctx.seed + 1207);
  const mats = ctx.materials;

  // The cached 'aluminum' blows out to flat white against the window: darker, rougher, with a roughness mottle.
  const aluRough = ctx.textures.canvas(
    'chair:alu-roughness',
    256,
    256,
    (c, w, h) => {
      const G = 16;
      const noise = latticeNoise(G, 0x2f6e2b1);
      const img = c.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const u = (x / w) * G;
          const v = (y / h) * G;
          const n = 0.55 * noise(u, v) + 0.3 * noise(u * 3, v * 3) + 0.15 * noise(u * 9, v * 9);
          const q = Math.round(255 * (0.19 + 0.17 * n));
          const o = (y * w + x) * 4;
          img.data[o] = q;
          img.data[o + 1] = q;
          img.data[o + 2] = q;
          img.data[o + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    },
    false,
  );
  aluRough.wrapS = THREE.RepeatWrapping;
  aluRough.wrapT = THREE.RepeatWrapping;
  aluRough.repeat.set(4, 4);
  aluRough.needsUpdate = true;
  const alu = mats.metal('aluminum').clone();
  alu.color.set(0x9ea3a9);
  alu.roughness = 1; // the map carries the value (0.19 – 0.36): not sharp enough to clip the sun to white
  alu.roughnessMap = aluRough;
  alu.envMapIntensity = 0.58;
  alu.name = 'chair-alu';
  // A mirror-sharp piston reflects the dark underside of the seat and renders black from
  // most angles; a touch of roughness lets the floor and window onto the tube as well.
  const chrome = mats.metal('chrome').clone();
  chrome.roughness = 0.09;
  chrome.envMapIntensity = 1.25;
  chrome.name = 'chair-chrome';
  const rubber = mats.rubber(0x161718);
  const grey = mats.plastic(0x3d3f43, 0.5);
  const dark = mats.plastic(0x1c1d1f, 0.55); // structural black plastic
  const frameMat = mats.plastic(0x141517, 0.35); // back frame, satin
  const pu = mats.plastic(0x232426, 0.75); // soft armrest pads, knob
  // Office upholstery, not hessian: at 1–2 m the stock 2.7 mm thread beats against the
  // pixel grid into an embossed lattice, so the yarn is enlarged and the relief halved.
  const fabric = mats.fabric(0x2c2d30, { surface: [1, 1], scale: 0.6 }).clone(); // UVs in metres
  fabric.normalScale.set(0.32, 0.32);
  fabric.name = 'chair-fabric';

  const repU = Math.max(1, Math.round((2 * BACK.W) / WEAVE_TILE));
  const repV = Math.max(1, Math.round(BACK.H / WEAVE_TILE));
  const weaveAlpha = ctx.textures.canvas(
    'chair:mesh-weave',
    512,
    512,
    (c, w, h) => {
      c.fillStyle = 'rgb(255,255,255)';
      c.fillRect(0, 0, w, h);
      // Pure black, not dark grey: a grey opening averages above 0 and the 0.5 alphaTest contour creeps outward.
      c.fillStyle = 'rgb(0,0,0)';
      const pitch = w / WEAVE_CELLS;
      // Openings sit on the cell corners; drawing the i = CELLS row as well keeps the
      // halves lined up across the tile seam.
      for (let i = 0; i <= WEAVE_CELLS; i++) {
        for (let j = 0; j <= WEAVE_CELLS; j++) {
          const sx = weaveGap(i) * pitch;
          const sy = weaveGap(j) * pitch;
          const r = Math.min(sx, sy) * 0.34;
          const x = i * pitch - sx / 2;
          const y = j * pitch - sy / 2;
          c.beginPath();
          c.moveTo(x + r, y);
          c.arcTo(x + sx, y, x + sx, y + sy, r);
          c.arcTo(x + sx, y + sy, x, y + sy, r);
          c.arcTo(x, y + sy, x, y, r);
          c.arcTo(x, y, x + sx, y, r);
          c.closePath();
          c.fill();
        }
      }
    },
    false,
  );
  const weaveNormal = ctx.textures.canvas(
    'chair:mesh-weave-normal',
    512,
    512,
    (c, w, h) => {
      const at = (x: number, y: number): number => weaveHeight((x / w) * WEAVE_CELLS, (y / h) * WEAVE_CELLS);
      const img = c.createImageData(w, h);
      const k = 2.4;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (at(x + 1, y) - at(x - 1, y)) * k;
          const dy = (at(x, y + 1) - at(x, y - 1)) * k;
          const len = Math.hypot(dx, dy, 1);
          const o = (y * w + x) * 4;
          img.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
          img.data[o + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
          img.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
          img.data[o + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    },
    false,
  );
  const weaveColor = ctx.textures.canvas('chair:mesh-weave-color', 512, 512, (c, w, h) => {
    const mottle = latticeNoise(8, 0x6d2f91b);
    const img = c.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x / w) * WEAVE_CELLS;
        const v = (y / h) * WEAVE_CELLS;
        const l = 0.72 + 0.34 * weaveHeight(u, v) + 0.09 * (mottle(u, v) - 0.5);
        const q = Math.round(255 * clamp01(l));
        const o = (y * w + x) * 4;
        img.data[o] = q;
        img.data[o + 1] = q;
        img.data[o + 2] = q;
        img.data[o + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  });
  for (const t of [weaveAlpha, weaveNormal, weaveColor]) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repU, repV);
    t.needsUpdate = true;
  }
  // Yarns mip to a constant at ~1.5 px: only the ~5 % open area and the rib lattice stop it reading as acrylic.
  const meshMat = mats.custom({
    color: 0x191a1d,
    metalness: 0,
    roughness: 0.68,
    map: weaveColor,
    normalMap: weaveNormal,
    alphaMap: weaveAlpha,
    transparent: true,
    // three copies alphaTest onto the depth material, so close up the openings are
    // punched in the shadow pass too instead of throwing a solid slab shadow.
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    sheen: 0.45,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0x9aa0a6),
    envMapIntensity: 0.5,
  });
  meshMat.normalScale.set(0.55, 0.55);
  meshMat.name = 'chair-mesh';

  const aluParts: THREE.BufferGeometry[] = [];
  const rubberParts: THREE.BufferGeometry[] = [];
  const greyParts: THREE.BufferGeometry[] = [];
  const darkParts: THREE.BufferGeometry[] = [];
  const frameParts: THREE.BufferGeometry[] = [];
  const puParts: THREE.BufferGeometry[] = [];
  const fabricParts: THREE.BufferGeometry[] = [];

  aluParts.push(
    lathe(
      [
        [0.0, 0.05],
        [0.05, 0.05],
        [0.056, 0.062],
        [0.052, 0.1],
        [0.046, 0.128],
        [0.036, 0.136],
        [0.027, 0.138],
        [0.0, 0.138],
      ],
      48,
    ),
  );
  const ARM_R = 0.33;
  const armSection = roundedRectSection(0.056, 0.05, 0.012, 3);
  const armPts: THREE.Vector3[] = [];
  const armScale: Array<[number, number]> = [];
  const N_ARM = 14;
  for (let i = 0; i <= N_ARM; i++) {
    const t = i / N_ARM;
    armPts.push(new THREE.Vector3(0.03 + (ARM_R - 0.03) * t, 0.094 - 0.02 * smooth(t) - 0.005 * Math.sin(Math.PI * t), 0));
    armScale.push([lerp(1, 0.55, t), lerp(1, 0.5, t)]);
  }
  const K_NOSE = 4;
  for (let k = 1; k <= K_NOSE; k++) {
    const a = (k / K_NOSE) * (Math.PI / 2);
    const s = Math.max(0.12, Math.cos(a));
    armPts.push(new THREE.Vector3(ARM_R + 0.022 * Math.sin(a), 0.074 - 0.011 * (1 - Math.cos(a)), 0));
    armScale.push([0.55 * s, 0.5 * s]);
  }
  const armFrames = framesAlong(armPts, new THREE.Vector3(0, 0, 1), (u) => {
    const i = Math.round(u * (armPts.length - 1));
    return armScale[i];
  });
  const armGeo = loft(armFrames, armSection, { caps: true });
  const armAngles = [0, 1, 2, 3, 4].map((k) => -90 * DEG + k * 72 * DEG);
  for (const phi of armAngles) aluParts.push(bake(armGeo.clone(), xf(0, 0, 0, 0, -phi, 0)));

  const WHEEL_R = 0.0275;
  const wheelProfile: Array<[number, number]> = [
    [0.011, -0.007],
    [0.0245, -0.007],
    [WHEEL_R, -0.0045],
    [WHEEL_R, 0.0045],
    [0.0245, 0.007],
    [0.011, 0.007],
  ];
  for (const phi of armAngles) {
    const swivel = rng() * Math.PI * 2;
    const cm = xf(ARM_R * Math.cos(phi), 0, ARM_R * Math.sin(phi), 0, swivel, 0);
    const trail = 0.018;
    for (const side of [-1, 1]) {
      rubberParts.push(bake(lathe(wheelProfile, 32), cm, xf(side * 0.0135, WHEEL_R, trail, 0, 0, Math.PI / 2)));
      greyParts.push(bake(cylinder(0.0115, 0.0115, 0.005, 24), cm, xf(side * 0.0205, WHEEL_R, trail, 0, 0, Math.PI / 2)));
    }
    darkParts.push(bake(roundedBox(0.048, 0.03, 0.058, 0.012, 3), cm, xf(0, 0.046, trail + 0.004)));
    darkParts.push(bake(cylinder(0.011, 0.012, 0.024, 24), cm, xf(0, 0.062, 0)));
  }

  // The shroud is only a trim collar (0.132 – 0.150): the seat shell already hides the column above y 0.20.
  darkParts.push(
    lathe(
      [
        [0.0, 0.132],
        [0.031, 0.132],
        [0.031, 0.1405],
        [0.0285, 0.1455],
        [0.0235, 0.1495],
        [0.0215, 0.15],
        [0.0205, 0.15],
      ],
      40,
    ),
  );
  // Chrome piston: r 0.019 inside the collar's 0.0205 rim, leaving a 1.5 mm shadow gap.
  const chromeGeo = bake(cylinder(0.019, 0.019, 0.18, 32), xf(0, 0.23, 0));

  const seatM = xf(0, 0.435, 0.02, 1.5 * DEG, 0, 0);
  const SEAT_W = 0.5;
  const SEAT_D = 0.48;
  const SEAT_T = 0.07;
  const seatDeform: Deform = (p, n) => {
    const ny0 = n.y;
    // waterfall front edge
    const z0 = 0.09;
    const a = 0.03 / (SEAT_D / 2 - z0) ** 2;
    if (p.z > z0) {
      const dz = p.z - z0;
      lowerBy(p, n, a * dz * dz, 0, 2 * a * dz);
    }
    // dished top where the sitter goes
    const wx = 1 - (p.x / 0.21) ** 2;
    const wz = 1 - ((p.z + 0.03) / 0.19) ** 2;
    if (wx > 0 && wz > 0 && ny0 > 0.2) {
      const wgt = smooth((ny0 - 0.2) / 0.6) * 0.012;
      const F = wgt * wx * wx * wz * wz;
      const Fx = wgt * 2 * wx * (-2 * p.x / 0.21 ** 2) * wz * wz;
      const Fz = wgt * wx * wx * 2 * wz * (-2 * (p.z + 0.03) / 0.19 ** 2);
      lowerBy(p, n, F, Fx, Fz);
    }
    n.normalize();
  };
  fabricParts.push(bake(softBox(SEAT_W, SEAT_T, SEAT_D, 0.028, { band: 5, flat: [8, 2, 8], deform: seatDeform }), seatM));
  // satin shell with 1 cm rim, top 12 mm into the cushion (its highlight separates it from the matte fabric)
  frameParts.push(bake(roundedBox(SEAT_W + 0.02, 0.035, SEAT_D + 0.01, 0.008, 3), seatM, xf(0, -0.0405, -0.005)));
  // mechanism housing
  darkParts.push(bake(roundedBox(0.3, 0.07, 0.24, 0.012, 3), seatM, xf(0, -0.093, -0.02)));
  // tilt lever (right) and height lever (left)
  darkParts.push(bake(cylinder(0.005, 0.005, 0.1, 12), seatM, xf(0.19, -0.1, -0.07, 0, 0, Math.PI / 2)));
  darkParts.push(bake(roundedBox(0.012, 0.03, 0.1, 0.005, 2), seatM, xf(0.243, -0.1, -0.035, 0, 8 * DEG, 0)));
  darkParts.push(bake(cylinder(0.005, 0.005, 0.08, 12), seatM, xf(-0.18, -0.1, -0.06, 0, 0, Math.PI / 2)));
  darkParts.push(bake(roundedBox(0.012, 0.026, 0.075, 0.005, 2), seatM, xf(-0.223, -0.1, -0.035, 0, -6 * DEG, 0)));
  // tension knob (right front)
  puParts.push(bake(cylinder(0.02, 0.02, 0.034, 32), seatM, xf(0.165, -0.1, 0.055, 0, 0, Math.PI / 2)));
  greyParts.push(bake(cylinder(0.007, 0.007, 0.036, 16), seatM, xf(0.165, -0.1, 0.055, 0, 0, Math.PI / 2)));

  const backM = xf(0, 0.5, -0.25, -8 * DEG, 0, 0);
  const toWorld = (x: number, y: number, dz: number): THREE.Vector3 =>
    new THREE.Vector3(x, y, backDepth(x, y) + dz).applyMatrix4(backM);
  const meshGeo = bake(backMeshGeometry(30, 40), backM);
  frameParts.push(bake(backFrameGeometry(128), backM));

  // PostureFit-style lumbar pad hugging the mesh from behind
  {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 20; i++) pts.push(toWorld(-0.16 + (0.32 * i) / 20, 0.135, -0.0095));
    const fr = framesAlong(pts, new THREE.Vector3(0, 1, 0), (u) => {
      const e = Math.min(1, Math.min(u, 1 - u) / 0.15);
      const s = 0.55 + 0.45 * Math.sqrt(e);
      return [s, s];
    });
    frameParts.push(loft(fr, roundedRectSection(0.05, 0.013, 0.005, 3), { caps: true }));
  }

  // spine: mechanism → up the centre of the back
  {
    const ctrl = [
      new THREE.Vector3(0, 0.318, -0.05),
      new THREE.Vector3(0, 0.326, -0.15),
      new THREE.Vector3(0, 0.39, -0.235),
      toWorld(0, 0.0, -0.022),
      toWorld(0, 0.1, -0.022),
      toWorld(0, 0.2, -0.021),
      toWorld(0, 0.29, -0.02),
    ];
    const pts = curvePoints(ctrl, 40);
    const fr = framesAlong(pts, new THREE.Vector3(1, 0, 0), (u) => [lerp(1, 0.62, smooth(u)), lerp(1, 0.7, smooth(u))]);
    darkParts.push(loft(fr, roundedRectSection(0.085, 0.03, 0.01, 3), { caps: true }));
    // …then forks into a Y whose thin arms run out to the frame at shoulder-blade height
    for (const side of [-1, 1]) {
      const yc = [
        toWorld(0, 0.245, -0.02),
        toWorld(side * 0.045, 0.32, -0.02),
        toWorld(side * 0.13, 0.395, -0.018),
        toWorld(side * 0.213, 0.45, -0.011),
      ];
      const ypts = curvePoints(yc, 26);
      const yfr = framesAlong(ypts, new THREE.Vector3(1, 0, 0), (u) => [lerp(1, 0.75, u), lerp(1, 0.85, u)]);
      darkParts.push(loft(yfr, roundedRectSection(0.034, 0.017, 0.006, 3), { caps: true }));
    }
  }
  // side struts: mechanism sides → frame's lower corners
  for (const side of [-1, 1]) {
    const ctrl = [
      new THREE.Vector3(side * 0.13, 0.325, -0.06),
      new THREE.Vector3(side * 0.2, 0.352, -0.165),
      toWorld(side * 0.15, -0.012, -0.012),
      toWorld(side * 0.15, 0.045, -0.014),
    ];
    const pts = curvePoints(ctrl, 30);
    const fr = framesAlong(pts, new THREE.Vector3(1, 0, 0), (u) => [lerp(1, 0.7, u), lerp(1, 0.8, u)]);
    darkParts.push(loft(fr, roundedRectSection(0.034, 0.02, 0.007, 3), { caps: true }));
  }

  {
    const headDeform: Deform = (p, n) => {
      const G = 0.018 * (p.x / 0.14) ** 2; // cup around the head
      const Gx = 0.018 * 2 * p.x / 0.14 ** 2;
      p.z += G;
      n.x -= Gx * n.z;
      n.normalize();
    };
    const zTop = backDepth(0, BACK.H);
    fabricParts.push(
      bake(
        softBox(0.28, 0.1, 0.045, 0.018, { band: 4, flat: [6, 2, 2], deform: headDeform }),
        backM,
        xf(0, 0.638, zTop + 0.046, 12 * DEG, 0, 0),
      ),
    );
    for (const side of [-1, 1]) {
      // A block clamped round the 25 × 17 mm top rail, so the headrest grips the frame
      // instead of sprouting from the mesh; the stalks start inside it.
      const zRail = backDepth(side * 0.06, BACK.H);
      frameParts.push(bake(roundedBox(0.044, 0.033, 0.03, 0.006, 2), backM, xf(side * 0.06, BACK.H - 0.001, zRail - 0.005)));
      const pts = curvePoints(
        [
          new THREE.Vector3(side * 0.06, 0.606, zRail - 0.004),
          new THREE.Vector3(side * 0.06, 0.624, zRail + 0.002),
          new THREE.Vector3(side * 0.06, 0.64, zRail + 0.024),
        ],
        10,
      );
      const fr = framesAlong(pts, new THREE.Vector3(1, 0, 0), () => [1, 1]);
      frameParts.push(bake(loft(fr, roundedRectSection(0.022, 0.013, 0.004, 2), { caps: true }), backM));
    }
  }

  for (const side of [-1, 1]) {
    const px = side * 0.295;
    darkParts.push(bake(roundedBox(0.17, 0.028, 0.05, 0.006, 3), xf(side * 0.215, 0.335, 0)));
    darkParts.push(bake(roundedBox(0.05, 0.25, 0.048, 0.008, 3), xf(px, 0.446, 0)));
    darkParts.push(bake(roundedBox(0.038, 0.11, 0.036, 0.006, 3), xf(px, 0.6, 0)));
    greyParts.push(bake(cylinder(0.006, 0.006, 0.006, 16), xf(px + side * 0.019, 0.6, 0.0, 0, 0, Math.PI / 2)));
    const pivot = -side * (4 + rng() * 3) * DEG; // pads turned slightly inward, not identical
    const slide = side > 0 ? 0.02 : 0.004; // one pad slid a little forward
    const padM = xf(side * 0.28, 0, slide, 0, pivot, 0);
    darkParts.push(bake(roundedBox(0.075, 0.012, 0.11, 0.004, 2), padM, xf(side * 0.012, 0.649, 0)));
    const padDeform: Deform = (p, n) => {
      const wx = 1 - (p.x / 0.045) ** 2;
      const wz = 1 - (p.z / 0.125) ** 2;
      if (wx > 0 && wz > 0 && n.y > 0.2) {
        const k = -0.004 * smooth((n.y - 0.2) / 0.6);
        lowerBy(p, n, k * wx * wz, k * (-2 * p.x / 0.045 ** 2) * wz, k * wx * (-2 * p.z / 0.125 ** 2));
        n.normalize();
      }
    };
    puParts.push(bake(softBox(0.09, 0.025, 0.25, 0.011, { band: 4, flat: [3, 1, 6], deform: padDeform }), padM, xf(0, 0.6675, 0)));
  }

  g.add(mesh(merge(aluParts), alu, undefined, { name: 'base' }));
  g.add(mesh(merge(rubberParts), rubber, undefined, { name: 'wheels' }));
  g.add(mesh(merge(greyParts), grey, undefined, { name: 'caps' }));
  g.add(mesh(merge(darkParts), dark, undefined, { name: 'structure' }));
  g.add(mesh(merge(frameParts), frameMat, undefined, { name: 'backFrame' }));
  g.add(mesh(chromeGeo, chrome, undefined, { name: 'piston' }));
  g.add(mesh(merge(fabricParts), fabric, undefined, { name: 'cushions' }));
  g.add(mesh(merge(puParts), pu, undefined, { name: 'armPads' }));
  g.add(mesh(meshGeo, meshMat, undefined, { name: 'backMesh' }));

  // Budget report for the screenshot tool (frame stats include the room shell).
  let tris = 0;
  let meshes = 0;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const geo = m.geometry;
    tris += (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
  });
  console.log(`[module] chair geometry: ${Math.round(tris).toLocaleString()} tris in ${meshes} meshes (${meshes} draw calls before shadow passes)`);
  return g;
}
