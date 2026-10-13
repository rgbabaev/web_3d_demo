import * as THREE from 'three';
import { box, cylinder, lathe, mergeGeometries, mesh, roundedBox, tube } from '../core/geometry';
import { clamp01, createRng, fbm, lerp, smoothstep } from '../core/noise';
import type { SceneContext } from '../core/types';

const WALL_Z = -0.1;
/** The shell's sill board reaches local z = +0.07, so the rod stands clear of it. */
const HANG_Z = 0.12;

const ROD_Y = 2.62;
const ROD_R = 0.0125;
const ROD_HALF = 1.55;

const BRACKET_X = 1.52;
const FINIAL_COLLAR_X = 1.546;
const FINIAL_X = 1.575;
const FINIAL_R = 0.026;

const RING_R = 0.023; // centre-line radius (Ø 52.4 mm ring on a Ø 25 mm rod)
const RING_TUBE = 0.0032;
const RING_OUTER = RING_R + RING_TUBE;
const RING_Y = ROD_Y + ROD_R - (RING_R - RING_TUBE); // ring rests on the rod

/** Tangent-angle swing of the fold wave; sets how deep the cloth folds, not how wide it hangs. */
const FOLD_A = 1.32;
/** Skews the fold so the room-facing crest is a little broader than the back valley. */
const FOLD_SKEW = 0.1;
const FOLD_P = 0.2286; // developed arc length of one fold
const FOLDS = 4;
const COLS_PER_FOLD = 22;
const EDGE_COLS = 2; // the panel overhangs its end rings by this much
const PANEL_SEG_X = FOLDS * COLS_PER_FOLD + 2 * EDGE_COLS;
const DPSI = (2 * Math.PI) / COLS_PER_FOLD;
const PSI0 = -EDGE_COLS * DPSI;
/** Columns crowd onto the creases, where the cloth turns through its tightest radius. */
const WARP = 0.5;
const PANEL_W = ((PANEL_SEG_X * DPSI) / (2 * Math.PI)) * FOLD_P;

/** Hung width: the rings hold the header to SPAN_TOP and the free cloth flares to SPAN_HEM (2.4× / 1.7× gathered). */
const SPAN_TOP = 0.4;
const SPAN_HEM = 0.56;

/** Over the top 85 mm the rings pinch: the fundamental is damped and a third harmonic pleats it. */
const HDR_TOP = 0.085;
const HDR_EASE = 0.1; // the drop amplitude eases in over this much below the header
const HDR_MIX = 0.4;
const HDR_A3 = 0.35;

/** The free edge of the hem bends forward on this radius over the last HEM_ROLL_H. */
const HEM_ROLL_R = 0.005;
const HEM_ROLL_H = 0.007;
const HEM_ROLL_TH = HEM_ROLL_H / HEM_ROLL_R;
const HEM_ROLL_DROP = HEM_ROLL_H - HEM_ROLL_R * Math.sin(HEM_ROLL_TH);

const HEM_EDGE_Y = 0.0045; // mean height of the free edge; the fold phase waves it ±9 mm
const HEM_FLOOR = 0.001; // lobes that reach the boards flatten here instead of sinking in
const FABRIC_BOT = HEM_EDGE_Y - HEM_ROLL_DROP;
const FABRIC_TOP = 2.575; // ~11 mm below the ring bottoms
const FABRIC_H = FABRIC_TOP - FABRIC_BOT;

const TIE_Y = 1.05;
const TIE_HOOK = new THREE.Vector3(1.555, 1.09, -0.022);
const CORD_R = 0.009;
const CORD_RADIAL = 12;
const CORD_TUBULAR = 64;

const LINEN_COLOR = 0xe4dccc;
const CORD_COLOR = 0x8c7250;

/** [height above FABRIC_BOT, push along the normal]: the rise at 0.0635 is the hem's shoulder, the dip its topstitch. */
const ROWS: Array<[number, number]> = [
  [0, 0.005],
  [0.0025, 0.005],
  [0.005, 0.005],
  [0.0075, 0.005],
  [0.012, 0.005],
  [0.02, 0.005],
  [0.032, 0.005],
  [0.044, 0.005],
  [0.0535, 0.005],
  [0.055, 0.002],
  [0.0565, 0.005],
  [0.0625, 0.005],
  [0.0635, 0.0005],
  [0.082, 0],
  [0.15, 0],
  [0.22, 0],
  [0.31, 0],
  [0.43, 0],
  [0.57, 0],
  [0.72, 0],
  [0.85, 0],
  [0.93, 0],
  [1.0, 0],
  [1.045, 0],
  [1.09, 0],
  [1.15, 0],
  [1.25, 0],
  [1.37, 0],
  [1.55, 0],
  [1.78, 0],
  [2.03, 0],
  [2.3, 0],
  [2.462, 0],
  [2.476, 0.0022],
  [2.508, 0.0026],
  [2.534, 0.0026],
  [2.551, 0.0026],
  [FABRIC_H, 0.0026],
];

/** A band boundary never cuts flat across the folds: its row bends with the fold phase. */
const wobAt = (d: number): number => (d > 0.04 && d < 0.075 ? 0.005 : d > 2.45 && d < 2.49 ? 0.008 : 0);

/** Rows that only earn their place where the holdback gathers a panel. */
const WAIST_ROWS = [0.93, 1.045, 1.09, 1.25];

function at(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
  m.setPosition(x, y, z);
  g.applyMatrix4(m);
  return g;
}

/** Round bar between two points (bracket arms, braces, ring hooks). */
function bar(a: THREE.Vector3, b: THREE.Vector3, radius: number, segments = 8): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = cylinder(radius, radius, len, segments);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  m.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  g.applyMatrix4(m);
  return g;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const uni = list.map((geo) => {
    const n = geo.index ? geo.toNonIndexed() : geo;
    n.clearGroups();
    return n;
  });
  const out = mergeGeometries(uni, false);
  if (!out) throw new Error('curtains: mergeGeometries failed');
  return out;
}

/** Bring a 0..1 UV square down to a real-world tile size. */
function scaleUv(g: THREE.BufferGeometry, sx: number, sy: number): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv) return g;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  uv.needsUpdate = true;
  return g;
}

interface PanelSpec {
  cx: number;
  side: number; // +1 right panel, -1 left panel
  phase: number;
  seed: number;
  tie: boolean;
}

interface Column {
  theta: number;
  t: number; // developed arc length from the leading edge
  dt: number; // to the next column
}

interface Row {
  y: number;
  wob: number;
  off: number; // push along the surface normal (doubled cloth)
}

function buildColumns(spec: PanelSpec): Column[] {
  const cols: Column[] = [];
  for (let i = 0; i <= PANEL_SEG_X; i++) {
    const psi = PSI0 + i * DPSI;
    cols.push({ theta: psi - (WARP / 2) * Math.sin(2 * psi), t: 0, dt: 0 });
  }
  let acc = 0;
  for (let i = 0; i < PANEL_SEG_X; i++) {
    const mid = (cols[i].theta + cols[i + 1].theta) / 2;
    // Fold spacing wanders, but only ±18 %: a fold must never widen until it vanishes.
    const p = FOLD_P * (1 + 0.18 * fbm(mid * 0.16, spec.phase + 3, 2, spec.seed + 9));
    cols[i].dt = (p / (2 * Math.PI)) * (cols[i + 1].theta - cols[i].theta);
    cols[i].t = acc;
    acc += cols[i].dt;
  }
  cols[PANEL_SEG_X].t = acc;
  return cols;
}

const gauss = (dy: number, s: number): number => Math.exp(-((dy / s) ** 2));

/** The holdback necks the panel to ~0.27 m at hip height and lets it flare above and below. */
function tieSpan(y: number): number {
  return 1 - 0.46 * gauss(y - TIE_Y, 0.11) + 0.12 * gauss(y - TIE_Y - 0.45, 0.28) + 0.05 * gauss(y - TIE_Y + 0.46, 0.3);
}

const PHI = new Float64Array(PANEL_SEG_X + 1);
const THETA = new Float64Array(PANEL_SEG_X + 1);
const RX = new Float64Array(PANEL_SEG_X + 1);
const RZ = new Float64Array(PANEL_SEG_X + 1);

/** One horizontal section of the drape as xyz triples; the fold tangent is integrated so cloth folds, not stretches. */
function rowPoints(spec: PanelSpec, cols: Column[], row: Row, out: Float32Array): void {
  const y = row.y;
  const d = y - FABRIC_BOT;
  const v = clamp01(d / FABRIC_H);
  const hdr = smoothstep(FABRIC_TOP - HDR_TOP - HDR_EASE, FABRIC_TOP - HDR_TOP, y);
  // A weighted hem settles: over the last 180 mm the folds lose half their depth and open 154 → 165 mm.
  const settle = 1 - smoothstep(0, 0.18, d);
  let amp = FOLD_A * lerp(1.1, 0.6, v) * lerp(1, 0.55, settle);
  let span = lerp(SPAN_HEM, SPAN_TOP, v) * lerp(1, 1.17, settle);
  if (spec.tie) {
    amp *= 1 + 0.22 * gauss(y - TIE_Y, 0.11);
    span *= tieSpan(y);
  }
  amp = Math.min(amp, 2.05);

  // The folds are not plumb: the pattern drifts a few degrees per metre and single folds widen as they descend.
  const drift = 0.17 * (1 - v) ** 1.25 * (1 + 0.6 * fbm(v * 2.1, spec.phase, 2, spec.seed + 43));
  const breathe = 0.13 * fbm(v * 1.9, spec.phase + 4, 2, spec.seed + 47);

  let yRoll = 0;
  let nOff = row.off;
  if (d < HEM_ROLL_H) {
    const th = (HEM_ROLL_H - d) / HEM_ROLL_R;
    yRoll = FABRIC_BOT + HEM_ROLL_H - HEM_ROLL_R * Math.sin(th) - y;
    nOff += HEM_ROLL_R * (1 - Math.cos(th));
  }

  for (let i = 0; i <= PANEL_SEG_X; i++) {
    const c = cols[i];
    const th = c.theta + drift + breathe * Math.sin(0.5 * c.theta + 1.3);
    THETA[i] = th;
    const w = 1 + 0.17 * fbm(th * 0.22, y * 0.8 + spec.phase, 2, spec.seed + 5);
    PHI[i] =
      amp * w * (1 - HDR_MIX * hdr) * (Math.sin(th) + FOLD_SKEW * Math.sin(2 * th)) +
      hdr * HDR_A3 * Math.sin(3 * th) +
      0.07 * fbm(c.t * 1.8, y * 0.75 + spec.phase, 2, spec.seed + 23) +
      0.04 * fbm(c.t * 6.5, y * 2.2 + spec.phase, 2, spec.seed + 31);
  }
  let x = 0;
  let z = 0;
  let xMin = 0;
  let xMax = 0;
  let zMin = 0;
  for (let i = 0; i <= PANEL_SEG_X; i++) {
    RX[i] = x;
    RZ[i] = z;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (z < zMin) zMin = z;
    if (i < PANEL_SEG_X) {
      const ph = (PHI[i] + PHI[i + 1]) / 2;
      x += Math.cos(ph) * cols[i].dt;
      z += Math.sin(ph) * cols[i].dt;
    }
  }
  const sx = span / Math.max(0.05, xMax - xMin);

  // The drop is not plumb: it sways a little on its way down and leans outboard.
  const sway = 1 - smoothstep(0.75, 1, v); // but hangs true where the rings hold it
  let dx =
    spec.cx +
    spec.side * 0.012 * (1 - v) ** 2 +
    0.013 * sway * fbm(v * 1.7, spec.phase, 2, spec.seed + 13) -
    ((xMin + xMax) / 2) * sx;
  if (spec.tie) dx += spec.side * 0.055 * gauss(y - TIE_Y, 0.16);
  const dz = HANG_Z - 0.005 + 0.022 * (1 - v) ** 2 + 0.008 * sway * fbm(v * 1.9, spec.phase + 5, 2, spec.seed + 19) - zMin;

  // Leading-edge roll: depth, reach and lateral position all waver with height, so
  // the silhouette is cloth rather than a machined line.
  const rollD = 0.005 * (1 + 0.5 * fbm(v * 2.6, spec.phase + 1, 2, spec.seed + 51));
  const rollW = 0.05 * (1 + 0.4 * fbm(v * 2.2, spec.phase + 6, 2, spec.seed + 57));
  const latA = 0.006 * fbm(v * 2.4, spec.phase + 8, 2, spec.seed + 61);
  const latB = 0.006 * fbm(v * 2.4, spec.phase + 12, 2, spec.seed + 67);

  const hemFade = 1 - smoothstep(0, 0.1, d);
  const scallop = smoothstep(FABRIC_TOP - 0.055, FABRIC_TOP, y);
  const wTot = cols[PANEL_SEG_X].t;

  for (let i = 0; i <= PANEL_SEG_X; i++) {
    const th = THETA[i];
    const edge = Math.min(cols[i].t, wTot - cols[i].t);
    const off = nOff - rollD * (1 - smoothstep(0.003, rollW, edge));
    const lat = (cols[i].t < wTot / 2 ? latA : latB) * (1 - smoothstep(0, 0.1, edge));
    const sn = Math.sin(PHI[i]);
    const cs = Math.cos(PHI[i]) * sx;
    const nl = Math.hypot(sn, cs) || 1;

    let yy =
      y +
      yRoll +
      row.wob * Math.sin(th + 1.3) +
      // The free edge breaks on the boards under some folds and lifts between them;
      // the noise term keeps the lobes from repeating one per fold.
      hemFade *
        (0.0038 * Math.sin(th + 0.7) +
          0.0022 * Math.sin(0.47 * th + 2.1) +
          0.003 * fbm(th * 0.42, spec.phase + 9, 2, spec.seed + 71)) +
      // The header is scalloped: pinched up at each ring, swagged down between them.
      scallop * (0.0135 * (0.5 + 0.5 * Math.cos(th)) - 0.0095);
    if (hemFade > 0 && yy < HEM_FLOOR) yy = HEM_FLOOR;

    out[i * 3] = RX[i] * sx + dx + lat - (sn / nl) * off;
    out[i * 3 + 1] = yy;
    out[i * 3 + 2] = RZ[i] + dz + (cs / nl) * off;
  }
}

function panelRows(tie: boolean): Row[] {
  return ROWS.filter(([d]) => tie || !WAIST_ROWS.includes(d)).map(([d, off]) => ({ y: FABRIC_BOT + d, wob: wobAt(d), off }));
}

function buildSheet(spec: PanelSpec, cols: Column[], rows: Row[]): THREE.BufferGeometry {
  const segY = rows.length - 1;
  const g = new THREE.PlaneGeometry(PANEL_W, rows[segY].y - rows[0].y, PANEL_SEG_X, segY);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const nx = PANEL_SEG_X + 1;
  const buf = new Float32Array(nx * 3);
  for (let j = 0; j <= segY; j++) {
    const row = rows[segY - j]; // PlaneGeometry row 0 is the top
    rowPoints(spec, cols, row, buf);
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      pos.setXYZ(idx, buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]);
      // Both UV axes in metres of cloth, so the weave never stretches over a fold.
      uv.setXY(idx, cols[i].t / PANEL_W, (row.y - FABRIC_BOT) / FABRIC_H);
    }
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function bracketParts(bx: number, rng: () => number): { matte: THREE.BufferGeometry[]; gloss: THREE.BufferGeometry[] } {
  const matte: THREE.BufferGeometry[] = [];
  const plateY = ROD_Y - 0.02;
  const plateZ = WALL_Z + 0.005;
  matte.push(at(roundedBox(0.056, 0.086, 0.01, 0.002, 1), bx, plateY, plateZ));
  for (const dy of [0.028, -0.028]) {
    matte.push(at(cylinder(0.0045, 0.0045, 0.0035, 10), bx, plateY + dy, plateZ + 0.006, Math.PI / 2));
    matte.push(at(box(0.007, 0.0012, 0.0012), bx, plateY + dy, plateZ + 0.0078, 0, 0, rng() * Math.PI));
  }
  const armY = ROD_Y - ROD_R - 0.009;
  const armZ0 = WALL_Z + 0.01;
  matte.push(at(roundedBox(0.014, 0.018, HANG_Z - armZ0, 0.002, 1), bx, armY, (armZ0 + HANG_Z) / 2));
  matte.push(bar(new THREE.Vector3(bx, plateY - 0.035, WALL_Z + 0.012), new THREE.Vector3(bx, armY, 0.05), 0.005));
  // The split collar is polished, so a highlight separates it from the matte arm.
  const gloss = [at(new THREE.TorusGeometry(0.0175, 0.005, 6, 12), bx, ROD_Y, HANG_Z, 0, Math.PI / 2)];
  return { matte, gloss };
}

function sagPoint(a: THREE.Vector3, b: THREE.Vector3, drop: number): THREE.Vector3 {
  return new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5).add(new THREE.Vector3(0, -drop, 0));
}

/** 2D convex hull (monotone chain) of (x, z) points, counter-clockwise. */
function hull2d(input: Array<[number, number]>): Array<[number, number]> {
  const p = input.slice().sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Closed tie-back cord: the convex hull of the panel's section over the cord's height band, so it cannot cut in. */
function cordCurve(spec: PanelSpec, cols: Column[]): { pts: THREE.Vector3[]; hookEnd: THREE.Vector3 } {
  const samples: Array<[number, number]> = [];
  const buf = new Float32Array((PANEL_SEG_X + 1) * 3);
  for (let k = 0; k <= 12; k++) {
    rowPoints(spec, cols, { y: TIE_Y - 0.03 + 0.005 * k, wob: 0, off: 0 }, buf);
    for (let i = 0; i <= PANEL_SEG_X; i++) samples.push([buf[i * 3], buf[i * 3 + 2]]);
  }
  let h = hull2d(samples);
  let area = 0;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) h = h.slice().reverse();
  const edgeN = h.map((a, i) => {
    const b = h[(i + 1) % h.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    return [dz / len, -dx / len] as [number, number];
  });
  const clear = CORD_R + 0.002;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < h.length; i++) {
    const n0 = edgeN[(i - 1 + h.length) % h.length];
    const n1 = edgeN[i];
    let nx = n0[0] + n1[0];
    let nz = n0[1] + n1[1];
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    // Mitred, not radial: the section is wide and shallow, so a radial push would
    // barely move the room-facing side and the cord would bury itself there.
    const miter = clear / Math.max(0.5, nx * n1[0] + nz * n1[1]);
    const q: [number, number] = [h[i][0] + nx * miter, h[i][1] + nz * miter];
    const last = ring[ring.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.0015) ring.push(q);
  }
  let start = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i][0] > ring[start][0]) start = i;
  const ordered = ring.slice(start).concat(ring.slice(0, start));

  const xs = ordered.map((q) => q[0]);
  const zs = ordered.map((q) => q[1]);
  const xMax = Math.max(...xs);
  const xSpan = Math.max(0.001, xMax - Math.min(...xs));
  const zMid = (Math.max(...zs) + Math.min(...zs)) / 2;
  const zHalf = Math.max(0.001, (Math.max(...zs) - Math.min(...zs)) / 2);
  // The loop rides high at the back and at the hook, low across the room face.
  const nodes = ordered.map(
    ([x, z]) => new THREE.Vector3(x, TIE_Y - 0.016 * ((z - zMid) / zHalf) - 0.012 * ((xMax - x) / xSpan), z),
  );

  const hookEnd = TIE_HOOK.clone().add(new THREE.Vector3(-0.004, -0.008, 0.006));
  return {
    pts: [hookEnd, sagPoint(hookEnd, nodes[0], 0.014), ...nodes, sagPoint(nodes[nodes.length - 1], hookEnd, 0.009)],
    hookEnd,
  };
}

/** Twist a tube into a three-strand rope by riding its radius with a 3-lobed cam. */
function braid(g: THREE.BufferGeometry, radius: number): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i <= CORD_TUBULAR; i++) {
    const twist = (i / CORD_TUBULAR) * 2 * Math.PI * 10;
    for (let j = 0; j <= CORD_RADIAL; j++) {
      const k = i * (CORD_RADIAL + 1) + j;
      const bump = radius * 0.34 * Math.cos(3 * ((2 * Math.PI * j) / CORD_RADIAL + twist));
      pos.setXYZ(k, pos.getX(k) + nor.getX(k) * bump, pos.getY(k) + nor.getY(k) * bump, pos.getZ(k) + nor.getZ(k) * bump);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
}

/** Wrapped knot + hanging tassel where both cord ends meet the wall hook. */
function tasselParts(hookEnd: THREE.Vector3): THREE.BufferGeometry[] {
  const kx = hookEnd.x - 0.016;
  const ky = hookEnd.y - 0.004;
  const kz = hookEnd.z + 0.003;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(scaleUv(at(cylinder(0.0115, 0.0125, 0.024, 14), kx, ky, kz, 0, 0, Math.PI / 2), 0.1, 0.1));
  // Tassel: neck, head, waist, skirt — profile is (radius, y), bottom → top.
  const profile: Array<[number, number]> = [
    [0.0016, -0.105],
    [0.0115, -0.097],
    [0.018, -0.071],
    [0.0166, -0.05],
    [0.0092, -0.041],
    [0.0084, -0.034],
    [0.0138, -0.022],
    [0.0146, -0.012],
    [0.0095, -0.004],
    [0.0018, 0],
  ];
  parts.push(scaleUv(at(lathe(profile, 16), kx, ky - 0.008, kz), 0.4, 0.42));
  return parts;
}

/** Retile a tube's UVs so the weave keeps its real 0.25 m repeat. */
function retileTube(g: THREE.BufferGeometry, length: number, radius: number): void {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) * length) / 0.25, (uv.getY(i) * 2 * Math.PI * radius) / 0.25);
  }
  uv.needsUpdate = true;
}

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'curtains';
  const rng = createRng(ctx.seed + 617);
  const { materials } = ctx;

  const panels: PanelSpec[] = [
    { cx: -1.27, side: -1, phase: 0.7, seed: 311, tie: false },
    { cx: 1.27, side: 1, phase: 2.9, seed: 907, tie: true },
  ];
  const colsOf = panels.map(buildColumns);

  const cloth: THREE.BufferGeometry[] = [];
  const ringAnchors: THREE.Vector3[][] = [];
  const headerBuf = new Float32Array((PANEL_SEG_X + 1) * 3);
  panels.forEach((spec, pi) => {
    const cols = colsOf[pi];
    const rows = panelRows(spec.tie);
    cloth.push(buildSheet(spec, cols, rows));

    rowPoints(spec, cols, rows[rows.length - 1], headerBuf);
    const anchors: THREE.Vector3[] = [];
    for (let k = 0; k <= FOLDS; k++) {
      const i = EDGE_COLS + k * COLS_PER_FOLD; // θ = 2πk: the crease the ring pinches
      anchors.push(new THREE.Vector3(headerBuf[i * 3], headerBuf[i * 3 + 1], headerBuf[i * 3 + 2]));
    }
    ringAnchors.push(anchors);
  });
  // Cloned so shadowSide can be set: a DoubleSide zero-thickness sheet defaults to
  // shadowSide = DoubleSide and speckles every crease with self-shadow acne.
  const linen = materials.linen(LINEN_COLOR, { surface: [PANEL_W, FABRIC_H] }).clone();
  linen.shadowSide = THREE.BackSide;
  g.add(mesh(merge(cloth), linen, undefined, { name: 'curtainPanels' }));

  const matte: THREE.BufferGeometry[] = [];
  const gloss: THREE.BufferGeometry[] = [];
  matte.push(at(cylinder(ROD_R, ROD_R, ROD_HALF * 2, 24), 0, ROD_Y, HANG_Z, 0, 0, Math.PI / 2));
  for (const sx of [-1, 1]) {
    gloss.push(at(cylinder(0.016, 0.016, 0.014, 16), sx * FINIAL_COLLAR_X, ROD_Y, HANG_Z, 0, 0, Math.PI / 2));
    gloss.push(at(new THREE.SphereGeometry(FINIAL_R, 16, 10), sx * FINIAL_X, ROD_Y, HANG_Z));
  }
  for (const bx of [-BRACKET_X, 0, BRACKET_X]) {
    const parts = bracketParts(bx, rng);
    matte.push(...parts.matte);
    gloss.push(...parts.gloss);
  }
  for (const anchors of ringAnchors) {
    for (const a of anchors) {
      matte.push(at(new THREE.TorusGeometry(RING_R, RING_TUBE, 6, 16), a.x, RING_Y, HANG_Z, 0, Math.PI / 2 + (rng() - 0.5) * 0.12));
      matte.push(bar(new THREE.Vector3(a.x, RING_Y - RING_OUTER + 0.002, HANG_Z), a, 0.0022, 6));
    }
  }
  // Tie-back holdback pin: rose, shaft, ball end.
  matte.push(at(cylinder(0.014, 0.014, 0.006, 14), TIE_HOOK.x, TIE_HOOK.y + 0.002, WALL_Z + 0.003, Math.PI / 2));
  matte.push(
    bar(
      new THREE.Vector3(TIE_HOOK.x, TIE_HOOK.y + 0.002, WALL_Z + 0.004),
      TIE_HOOK.clone().add(new THREE.Vector3(0, -0.003, 0.004)),
      0.0042,
      10,
    ),
  );
  gloss.push(at(new THREE.SphereGeometry(0.0062, 12, 8), TIE_HOOK.x, TIE_HOOK.y - 0.003, TIE_HOOK.z + 0.005));
  g.add(mesh(merge(matte), materials.metal('blackMatte'), undefined, { name: 'curtainRod' }));
  g.add(mesh(merge(gloss), materials.metal('blackGloss'), undefined, { name: 'curtainRodTrim' }));

  const { pts: cordPts, hookEnd } = cordCurve(panels[1], colsOf[1]);
  const cordGeo = tube(cordPts, CORD_R, CORD_RADIAL, CORD_TUBULAR, true);
  braid(cordGeo, CORD_R);
  retileTube(cordGeo, new THREE.CatmullRomCurve3(cordPts, true, 'catmullrom', 0.5).getLength(), CORD_R);
  g.add(
    mesh(merge([cordGeo, ...tasselParts(hookEnd)]), materials.fabric(CORD_COLOR, { surface: [0.25, 0.25] }), undefined, {
      name: 'tieBackCord',
    }),
  );

  return g;
}
