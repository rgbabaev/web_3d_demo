import * as THREE from 'three';
import { mergeGeometries, mesh, roundedBox } from '../core/geometry';
import { createRng } from '../core/noise';
import type { SceneContext } from '../core/types';

const PROFILE = 0.025; // face width of the frame moulding
const DEPTH = 0.03; // front-to-back depth of the moulding
const STANDOFF = 0.006; // wall → frame back
const FRONT = STANDOFF + DEPTH; // 0.036 — the front face of every frame

// The sandwich inside the rebate, in absolute z.
const MAT_FRONT = FRONT - 0.004; // mat recessed 4 mm behind the frame face
const MAT_CORE = 0.0002; // straight part of the mat board…
// 8-ply board: at 4-ply (1.2 mm) the bevel highlight is sub-pixel and breaks
// into dashes along the window edge.
const MAT_BEVEL = 0.0022; // …plus a 45° bevel cut on both faces
const MAT_BACK = MAT_FRONT - (MAT_CORE + 2 * MAT_BEVEL);
const GLASS_Z = MAT_FRONT + 0.001;
const PRINT_Z = MAT_BACK - 0.0006;
const MOUNT_FRONT = PRINT_Z - 0.0006;
const MOUNT_BACK = MOUNT_FRONT - 0.004;
const DUST_FRONT = 0.011; // kraft dust cover across the back of the rebate
const DUST_BACK = 0.0075;
const MAT_BORDER = 0.04; // visible cream border around the print

type Along = 'x' | 'y';

interface Panel {
  name: string;
  w: number; // outer frame width
  h: number; // outer frame height
  cx: number;
  cy: number;
  tilt: number; // small hanging error, radians about z
  oak: boolean;
  tex: THREE.Texture;
}

/** Flatten + merge geometries that share one material into a single draw call. */
function unify(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(flat, false);
  if (!g) throw new Error('wallArt: mergeGeometries failed (incompatible attributes)');
  for (const p of flat) p.dispose();
  for (const p of parts) if (!flat.includes(p)) p.dispose();
  return g;
}

/** Shear the ends of a rail into 45° mitres. `outer` is +1 when the frame's outer edge is at +width, −1 when at −. */
function mitre(geom: THREE.BufferGeometry, along: Along, len: number, outer: number): void {
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const half = len / 2;
  for (let i = 0; i < pos.count; i++) {
    if (along === 'x') {
      const cut = PROFILE / 2 - outer * pos.getY(i);
      pos.setX(i, pos.getX(i) * (1 - cut / half));
    } else {
      const cut = PROFILE / 2 - outer * pos.getX(i);
      pos.setY(i, pos.getY(i) * (1 - cut / half));
    }
  }
  pos.needsUpdate = true;
}

/** Re-project a rail's UVs in metres with u along the rail, so the grain turns the corner with the moulding. */
function grainUV(geom: THREE.BufferGeometry, along: Along, offset: number): void {
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const nor = geom.attributes.normal as THREE.BufferAttribute;
  const uv = geom.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const len = along === 'x' ? px : py; // along the rail
    const across = along === 'x' ? py : px; // across it, in the wall plane
    const nLen = Math.abs(along === 'x' ? nor.getX(i) : nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (nLen > 0.7) {
      u = pz; // mitred end face (hidden in the joint)
      v = across;
    } else if (nz > 0.7) {
      u = len; // front / back face
      // ×3 for the same reason as the edge faces below: at 1:1 the 25 mm face
      // spans 2.5% of the grain texture and comes out as flat tonal drift.
      v = across * 3;
    } else {
      u = len; // outer / inner edge
      // ×4 so 30 mm of depth crosses several grain lines instead of three fat
      // ones; at a grazing angle the sparse version aliased into plywood plies.
      v = pz * 4;
    }
    uv.setXY(i, u + offset, v + offset * 0.37);
  }
  uv.needsUpdate = true;
}

function rectPath(p: THREE.Path | THREE.Shape, w: number, h: number): void {
  p.moveTo(-w / 2, -h / 2);
  p.lineTo(w / 2, -h / 2);
  p.lineTo(w / 2, h / 2);
  p.lineTo(-w / 2, h / 2);
  p.closePath();
}

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Fine paper/print grain so the prints are not flat colour at 1 m. */
function grain(c: CanvasRenderingContext2D, w: number, h: number, seed: number, amount: number): void {
  const rng = createRng(seed);
  const img = c.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  c.putImageData(img, 0, 0);
}

/** Print 1: a warm gradient crossed by two soft, overlapping arcs. */
function drawArcs(c: CanvasRenderingContext2D, w: number, h: number): void {
  // The light end stays well below the mat board (#efe6d2) or the sheet
  // dissolves into its own border.
  const bg = c.createLinearGradient(0, h, w * 0.35, 0);
  bg.addColorStop(0, '#d9966c');
  bg.addColorStop(0.3, '#e7b687');
  bg.addColorStop(0.68, '#e4c296');
  bg.addColorStop(1, '#e8d0ab');
  c.fillStyle = bg;
  c.fillRect(0, 0, w, h);

  // A pale disc sitting low in the field, like a sun behind the arcs.
  const glow = c.createRadialGradient(w * 0.52, h * 0.3, w * 0.02, w * 0.52, h * 0.3, w * 0.62);
  glow.addColorStop(0, 'rgba(255,246,226,0.26)');
  glow.addColorStop(0.55, 'rgba(255,240,214,0.1)');
  glow.addColorStop(1, 'rgba(255,240,214,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, w, h);

  const arc = (cx: number, cy: number, r: number, lw: number, a0: number, a1: number, col: string, blur: number, mode: GlobalCompositeOperation): void => {
    c.save();
    c.filter = `blur(${blur.toFixed(1)}px)`;
    c.globalCompositeOperation = mode;
    c.strokeStyle = col;
    c.lineWidth = lw;
    c.lineCap = 'round';
    c.beginPath();
    c.arc(cx, cy, r, a0, a1);
    c.stroke();
    c.restore();
  };
  const P = Math.PI;
  // A tall terracotta arch that enters at the left edge and leaves at the foot…
  arc(w * 0.28, h * 0.78, w * 0.52, w * 0.11, P * 0.917, P * 2.333, 'rgba(184,88,55,0.9)', w * 0.007, 'multiply');
  // …crossed twice by a cooler sage ring cropped by the right edge. Multiplied,
  // the way two translucent screen-print inks actually layer; the sage is kept
  // pale so the crossings deepen to sienna instead of going to mud or to black.
  arc(w * 0.717, h * 0.289, w * 0.383, w * 0.087, P * 0.194, P * 1.806, 'rgba(168,186,142,0.55)', w * 0.009, 'multiply');
  // A hairline echo of the arch, one stroke of ink. Radius 0.70w keeps it well
  // outside the thick arc's 0.575w outer edge — run closer, the two read as a
  // ringing artefact around one stroke rather than as two strokes.
  c.save();
  c.globalCompositeOperation = 'multiply';
  c.strokeStyle = 'rgba(70,50,36,0.4)';
  c.lineWidth = Math.max(1, w * 0.0038);
  c.beginPath();
  c.arc(w * 0.28, h * 0.78, w * 0.7, P * 1.0, P * 2.25);
  c.stroke();
  c.restore();

  // A settled band of pigment along the bottom edge.
  const band = c.createLinearGradient(0, h * 0.86, 0, h);
  band.addColorStop(0, 'rgba(128,72,48,0)');
  band.addColorStop(1, 'rgba(128,72,48,0.3)');
  c.fillStyle = band;
  c.fillRect(0, h * 0.86, w, h * 0.14);

  const vig = c.createRadialGradient(w * 0.5, h * 0.5, w * 0.4, w * 0.5, h * 0.5, w * 1.0);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(70,42,26,0.12)');
  c.fillStyle = vig;
  c.fillRect(0, 0, w, h);
  grain(c, w, h, 7711, 11);
}

/** Print 2: a minimal black-ink botanical on off-white. */
function drawPlant(c: CanvasRenderingContext2D, w: number, h: number): void {
  const paper = c.createLinearGradient(0, 0, w, h);
  paper.addColorStop(0, '#f7f4ec');
  paper.addColorStop(1, '#eee9dc');
  c.fillStyle = paper;
  c.fillRect(0, 0, w, h);

  const S = w / 420;
  const bez = (t: number, a: number, b: number, d: number, e: number): number => {
    const m = 1 - t;
    return m * m * m * a + 3 * m * m * t * b + 3 * m * t * t * d + t * t * t * e;
  };
  // Main stem (cubic), in canvas pixels.
  const P0 = [w * 0.54, h * 0.99];
  const P1 = [w * 0.5, h * 0.74];
  const P2 = [w * 0.41, h * 0.5];
  const P3 = [w * 0.47, h * 0.13];
  const stemX = (t: number): number => bez(t, P0[0], P1[0], P2[0], P3[0]);
  const stemY = (t: number): number => bez(t, P0[1], P1[1], P2[1], P3[1]);

  c.lineJoin = 'round';
  c.lineCap = 'round';

  // A pale second sprig behind, clear of the ink plant — overlapping the two
  // read as a misregistered second impression rather than depth.
  c.strokeStyle = '#c9c2b0';
  c.lineWidth = 2.1 * S;
  c.beginPath();
  c.moveTo(w * 0.74, h * 0.99);
  c.bezierCurveTo(w * 0.77, h * 0.76, w * 0.8, h * 0.62, w * 0.72, h * 0.36);
  c.stroke();
  const ghost = (t: number, side: number): void => {
    const x = bez(t, w * 0.74, w * 0.77, w * 0.8, w * 0.72);
    const y = bez(t, h * 0.99, h * 0.76, h * 0.62, h * 0.36);
    const ang = -Math.PI / 2 + side * 1.0;
    const len = 46 * S;
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + Math.cos(ang - 0.45) * len, y + Math.sin(ang - 0.45) * len, x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    c.quadraticCurveTo(x + Math.cos(ang + 0.45) * len * 0.8, y + Math.sin(ang + 0.45) * len * 0.8, x, y);
    c.stroke();
  };
  ghost(0.35, 1);
  ghost(0.62, -1);
  ghost(0.85, 1);

  // The ink plant.
  c.strokeStyle = '#1a1714';
  c.fillStyle = '#1a1714';
  c.lineWidth = 3.1 * S;
  c.beginPath();
  c.moveTo(P0[0], P0[1]);
  c.bezierCurveTo(P1[0], P1[1], P2[0], P2[1], P3[0], P3[1]);
  c.stroke();

  const leaf = (t: number, side: number, len: number, wid: number, lift: number, solid: boolean): void => {
    const x = stemX(t);
    const y = stemY(t);
    const ang = side > 0 ? -lift : Math.PI + lift;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const nx = -dy * wid;
    const ny = dx * wid;
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + dx * len * 0.4 + nx, y + dy * len * 0.4 + ny, x + dx * len, y + dy * len);
    c.quadraticCurveTo(x + dx * len * 0.45 - nx, y + dy * len * 0.45 - ny, x, y);
    if (solid) c.fill();
    else c.stroke();
  };
  //     t      side  length      width      lift(rad) solid
  leaf(0.14, 1, 96 * S, 27 * S, 0.62, false);
  leaf(0.27, -1, 104 * S, 30 * S, 0.5, true);
  leaf(0.4, 1, 92 * S, 26 * S, 0.66, false);
  leaf(0.53, -1, 84 * S, 24 * S, 0.62, false);
  leaf(0.66, 1, 72 * S, 21 * S, 0.74, true);
  leaf(0.79, -1, 58 * S, 17 * S, 0.78, false);
  leaf(0.92, 1, 40 * S, 12 * S, 0.95, false);

  // Three ink dots — a seed pod straddling the stem tip, not floating above it.
  for (let i = 0; i < 3; i++) {
    c.beginPath();
    c.arc(P3[0] + (i - 1) * 9 * S, P3[1] - 5 * S + Math.abs(i - 1) * 6 * S, 3.4 * S, 0, Math.PI * 2);
    c.fill();
  }
  grain(c, w, h, 8822, 9);
}

/** Print 3: a Bauhaus grid of muted rectangles. */
function drawGrid(c: CanvasRenderingContext2D, w: number, h: number): void {
  c.fillStyle = '#ece3d2';
  c.fillRect(0, 0, w, h);

  // Full bleed: the mat board is the only border this print gets.
  const cols = 3;
  const rows = 4;
  const gap = w * 0.02;
  const cw = (w - gap * (cols - 1)) / cols;
  const ch = (h - gap * (rows - 1)) / rows;
  const X = (i: number): number => i * (cw + gap);
  const Y = (j: number): number => j * (ch + gap);
  const W = (s: number): number => cw * s + gap * (s - 1);
  const H = (s: number): number => ch * s + gap * (s - 1);

  const OCHRE = '#c79b46';
  const RUST = '#ab563a';
  const TEAL = '#436a68';
  const SLATE = '#3a4450';
  const CREAM = '#e0d4bb';
  const INK = '#221f1c';

  const fill = (x: number, y: number, ww: number, hh: number, col: string): void => {
    c.fillStyle = col;
    c.fillRect(x, y, ww, hh);
  };
  fill(X(0), Y(0), W(2), H(1), OCHRE);
  fill(X(2), Y(0), W(1), H(2), TEAL);
  fill(X(0), Y(1), W(1), H(2), RUST);
  fill(X(1), Y(1), W(1), H(1), CREAM);
  fill(X(1), Y(2), W(2), H(1), SLATE);
  fill(X(1), Y(3), W(1), H(1), INK);

  // Circle inscribed in the cream cell.
  c.fillStyle = INK;
  c.beginPath();
  c.arc(X(1) + cw / 2, Y(1) + ch / 2, Math.min(cw, ch) * 0.29, 0, Math.PI * 2);
  c.fill();
  // Quarter disc sitting in the bottom-right cell.
  c.fillStyle = RUST;
  c.beginPath();
  c.moveTo(X(2), Y(3) + ch);
  c.arc(X(2), Y(3) + ch, Math.min(cw, ch) * 0.86, -Math.PI / 2, 0);
  c.closePath();
  c.fill();
  // Cell (0, 3) is left empty on purpose — the hairlines that used to split it
  // read as an unfinished corner next to the solid blocks.

  // Uneven ink coverage, as a screen print has.
  const rng = createRng(4404);
  c.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 90; i++) {
    const r = 6 + rng() * 26;
    c.fillStyle = `rgba(90,74,54,${(0.02 + rng() * 0.03).toFixed(3)})`;
    c.beginPath();
    c.arc(rng() * w, rng() * h, r, 0, Math.PI * 2);
    c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  grain(c, w, h, 9933, 10);
}

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'wallArt';
  const M = ctx.materials;
  const T = ctx.textures;
  const rng = createRng(ctx.seed + 619);

  // Canvas aspect matches the visible sheet, and fills the 1024 cap: these are
  // the softest surfaces in the module when the camera comes close.
  const big = T.canvas('wallArt:arcs', 720, 1024, drawArcs);
  const plant = T.canvas('wallArt:plant', 560, 646, drawPlant);
  const grid = T.canvas('wallArt:grid', 560, 646, drawGrid);

  // 60 mm between every pair, and the group centred on the origin in x.
  const deg = THREE.MathUtils.degToRad;
  const panels: Panel[] = [
    { name: 'large', w: 0.7, h: 0.95, cx: -0.23, cy: 1.55, tilt: deg(-0.18), oak: true, tex: big },
    { name: 'upper', w: 0.4, h: 0.445, cx: 0.38, cy: 1.8025, tilt: deg(0.55), oak: false, tex: plant },
    { name: 'lower', w: 0.4, h: 0.445, cx: 0.38, cy: 1.2975, tilt: deg(-0.42), oak: false, tex: grid },
  ];

  const oakGeo: THREE.BufferGeometry[] = [];
  const blackGeo: THREE.BufferGeometry[] = [];
  const matGeo: THREE.BufferGeometry[] = [];
  const boardGeo: THREE.BufferGeometry[] = [];
  const glassGeo: THREE.BufferGeometry[] = [];
  const spacerGeo: THREE.BufferGeometry[] = [];
  const prints: THREE.Mesh[] = [];

  for (const p of panels) {
    // Hung by hand: a few tenths of a degree out and a millimetre off centre.
    const dx = (rng() - 0.5) * 0.002;
    const dy = (rng() - 0.5) * 0.002;
    const world = new THREE.Matrix4()
      .makeTranslation(p.cx + dx, p.cy + dy, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(p.tilt));
    const bake = (geom: THREE.BufferGeometry): THREE.BufferGeometry => geom.applyMatrix4(world);

    const openW = p.w - 2 * PROFILE;
    const openH = p.h - 2 * PROFILE;
    const seg = p.oak ? 2 : 1;
    const rad = p.oak ? 0.0018 : 0.0014;
    const rails = p.oak ? oakGeo : blackGeo;

    // Four mitred rails. Grain runs along each rail, so the joint turns the corner.
    const rail = (along: Along, len: number, x: number, y: number, outer: number): void => {
      const geom = along === 'x' ? roundedBox(len, PROFILE, DEPTH, rad, seg) : roundedBox(PROFILE, len, DEPTH, rad, seg);
      mitre(geom, along, len, outer);
      grainUV(geom, along, rng() * 2.0);
      geom.translate(x, y, STANDOFF + DEPTH / 2);
      rails.push(bake(geom));
    };
    rail('x', p.w, 0, (p.h - PROFILE) / 2, 1); // top
    rail('x', p.w, 0, -(p.h - PROFILE) / 2, -1); // bottom
    rail('y', p.h, -(p.w - PROFILE) / 2, 0, -1); // left
    rail('y', p.h, (p.w - PROFILE) / 2, 0, 1); // right

    // Mat board: 4 cm cream border, window cut with a bevel that catches light.
    const matW = openW + 0.001; // tucked a hair under the rebate
    const matH = openH + 0.001;
    const winW = matW - 2 * MAT_BORDER;
    const winH = matH - 2 * MAT_BORDER;
    const shape = new THREE.Shape();
    rectPath(shape, matW, matH);
    const hole = new THREE.Path();
    rectPath(hole, winW, winH);
    shape.holes.push(hole);
    const matBoard = new THREE.ExtrudeGeometry(shape, {
      depth: MAT_CORE,
      bevelEnabled: true,
      bevelThickness: MAT_BEVEL,
      bevelSize: MAT_BEVEL,
      bevelSegments: 1,
      curveSegments: 1,
    });
    matBoard.translate(0, 0, MAT_BACK + MAT_BEVEL);
    matGeo.push(bake(matBoard));

    // The print itself, tucked 1 cm under the mat all round, on its mount board.
    const printW = winW + 0.02;
    const printH = winH + 0.02;
    const inkMat = M.custom({ map: p.tex, roughness: 0.74, metalness: 0, envMapIntensity: 0.5 });
    inkMat.name = `wallArt:print:${p.name}`;
    const print = mesh(new THREE.PlaneGeometry(printW, printH), inkMat, undefined, { name: `print_${p.name}`, cast: false });
    print.geometry.translate(0, 0, PRINT_Z);
    print.geometry.applyMatrix4(world);
    prints.push(print);

    boardGeo.push(bake(boxAt(openW - 0.002, openH - 0.002, MOUNT_FRONT - MOUNT_BACK, 0, 0, (MOUNT_FRONT + MOUNT_BACK) / 2)));
    boardGeo.push(bake(boxAt(openW - 0.0015, openH - 0.0015, DUST_FRONT - DUST_BACK, 0, 0, (DUST_FRONT + DUST_BACK) / 2)));

    const pane = new THREE.PlaneGeometry(openW - 0.0005, openH - 0.0005);
    pane.translate(0, 0, GLASS_Z);
    glassGeo.push(bake(pane));

    // Hanger plate near the top, felt bumpers at the bottom corners: the frame
    // stands 6 mm off the plaster and the gap reads as a contact shadow.
    const plateW = Math.min(0.1, p.w * 0.3);
    spacerGeo.push(bake(boxAt(plateW, 0.03, STANDOFF, 0, p.h / 2 - p.h * 0.2, STANDOFF / 2)));
    for (const s of [-1, 1]) {
      spacerGeo.push(bake(boxAt(0.018, 0.018, STANDOFF, s * (p.w / 2 - 0.025), -(p.h / 2 - 0.022), STANDOFF / 2)));
    }
  }

  const oak = M.wood('oak', { surface: [1, 1], finish: 'satin' });
  // ~4% reflectance: real matte-black frame paint. Darker than this and the
  // front, outer and rebate faces all crush to the same flat silhouette.
  const black = M.paintedWood(0x302e32, 'matte', { surface: [1, 1] });
  g.add(mesh(unify(oakGeo), oak, undefined, { name: 'oakFrame' }));
  g.add(mesh(unify(blackGeo), black, undefined, { name: 'blackFrames' }));
  g.add(mesh(unify(matGeo), M.paper(0xefe6d2, { surface: [1, 1] }), undefined, { name: 'matBoards', cast: false }));
  g.add(mesh(unify(boardGeo), M.paper(0x7d7060), undefined, { name: 'backing', cast: false }));
  for (const p of prints) g.add(p);
  g.add(mesh(unify(glassGeo), M.glass({ opacity: 0.06, roughness: 0.02 }), undefined, { name: 'glazing', cast: false }));
  g.add(mesh(unify(spacerGeo), M.rubber(0x131315), undefined, { name: 'spacers' }));

  return g;
}
