// 2.20 m (x) × 3.00 m (z); origin on the floor at the centre of the woven body.
import * as THREE from 'three';
import { mergeGeometries, mesh, tube } from '../core/geometry';
import { createRng, fbm, lerp, smoothstep } from '../core/noise';
import type { SceneContext } from '../core/types';

const RUG_W = 2.2; // x
const RUG_D = 3.0; // z
const PILE = 0.012; // woven thickness in the field
const EDGE_PILE = 0.0075; // …thinning into the bound selvedge
const EDGE_INSET = 0.0038; // grid perimeter inset; the hem bulges back out by half the edge thickness
const BOTTOM_Y = 0.0004; // keep the (culled) underside off the floor plane
const EDGE_X = RUG_W / 2 - EDGE_INSET;
const EDGE_Z = RUG_D / 2 - EDGE_INSET;

const SWELL = 0.009; // broad humps where the rug does not touch the floor
const EDGE_LIFT = 0.008; // extra travelling lift along the four free edges
const WANDER = 0.011; // lateral wobble of the selvedge
const UV_WARP = 0.013; // metres the woven pattern drifts sideways

const CURL_L = 0.3; // leg length of the folded corner triangle
const CURL_U = CURL_L * Math.SQRT1_2; // arc length from the crease to the tip
const CURL_CREASE = 0.018 / CURL_U; // the fold itself, as a fraction of that arc
const CURL_CREASE_A = 0.17; // tangent angle gained across the crease (rad)
const CURL_RAMP = 0.1; // …across the flat run of the flap, as s^CURL_P
const CURL_P = 2;
const CURL_TIP_A = 2; // …and across the roll, which takes the tip 40° past vertical
const CURL_TIP_S = 0.6;
const CURL_N = 64; // samples of the rolled profile
const CURL_FLAT = 0.012 / CURL_U; // plan pull is frozen this close to the tip
const CURL_GX = Math.SQRT1_2; // unit direction the fold rises along, in plan
const CURL_GZ = Math.SQRT1_2;

const GRID_X = 26;
const GRID_Z = 27;
const RINGS = 2; // hem cross-section: a two-facet chamfer, not a piped bead

const FRINGE_PER_END = 60;
const FRINGE_LEN = 0.062;
const FRINGE_KNEE = 0.013; // the yarn bends off the bound edge over this much of its run
const FRINGE_DROP = 0.0095; // …and loses this much height doing it, then lies flat
const CORD_R = 0.0034; // one of the three sub-cords in a tassel
const CORD_RS = 4; // a three-sided cord leaves one face unlit and renders as dark wire
// Ring positions per sub-cord: one inside the knee, the rest along the flat.
const CORD_T = [
  [0, 0.22, 1],
  [0, 0.18, 0.55, 1],
  [0, 0.25, 1],
];

const BIND_R = 0.0036;

const PALETTE = { base: 0xd6c8b0, border: 0x3b3f4d, accent: 0xa85a3c, accent2: 0x6b7a8f };
const FRINGE_COLOR = 0xe9e0cf;
const BIND_COLOR = 0xc9bca5;

/** Cell boundaries along one axis, graded to ~15 mm where the corner rolls and ~180 mm in the field. */
function axisCells(n: number, len: number): Float64Array {
  const w = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    w[i] = Math.min(
      lerp(0.35, 1, smoothstep(0, 0.1, t * len)),
      Math.min(1, 0.07 + ((1 - t) * len) / 0.45),
    );
    sum += w[i];
  }
  const p = new Float64Array(n + 1);
  p[0] = -len / 2;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += w[i];
    p[i + 1] = (acc / sum) * len - len / 2;
  }
  return p;
}

/** 1 within ~0.1 m of a plan corner, 0 along the open edges. */
function cornerness(x: number, z: number): number {
  return (
    smoothstep(0.8, 0.98, Math.abs(x) / (RUG_W / 2)) * smoothstep(0.85, 0.985, Math.abs(z) / (RUG_D / 2))
  );
}

/** Height of the underside above the floor: swells and a travelling edge wave, but corners lie down. */
function lift(x: number, z: number): number {
  const swell = Math.sin(x * 2.9 + 0.6) * Math.sin(z * 2.1 - 1.4);
  const n = fbm(x * 1.1 + 3.1, z * 1.1 + 7.7, 3, 4171) * 1.7;
  let h = Math.max(0, swell * 0.5 + n * 0.8 - 0.1) * SWELL;

  const ex = Math.abs(x) / (RUG_W / 2);
  const ez = Math.abs(z) / (RUG_D / 2);
  const wx = smoothstep(0.62, 1, ex) * (0.5 + 0.5 * Math.sin(z * 5.3 + 0.9 + (x > 0 ? 0 : 2.4)));
  const wz = smoothstep(0.72, 1, ez) * (0.5 + 0.5 * Math.sin(x * 6.1 - 2.2 + (z > 0 ? 0 : 1.7)));
  h += EDGE_LIFT * Math.max(wx, wz);
  return Math.min(SWELL + EDGE_LIFT, h) * (1 - 0.88 * cornerness(x, z));
}

/** Woven thickness here: 12 mm in the field, thinning into the bound selvedge, ±0.8 mm of weave. */
function pileAt(x: number, z: number): number {
  const edge = Math.max(Math.abs(x) / (RUG_W / 2), Math.abs(z) / (RUG_D / 2));
  const thin = smoothstep(0.962, 1, edge);
  return PILE - (PILE - EDGE_PILE) * thin + fbm(x * 5 + 2.2, z * 5 + 6.6, 2, 5501) * 0.0008;
}

/** Lateral wander of the woven selvedge, sampled in world space so it is smooth along the edge. */
function edgeWander(x: number, z: number): number {
  return fbm(x * 2.4 + 17.3, z * 2.4 + 41.7, 3, 6607) * WANDER * (1 - 0.9 * cornerness(x, z));
}

/** Tangent angle of the folded sheet. It rolls past vertical, so the tip overhangs and the fold reads. */
function rollAngle(s: number): number {
  const t = Math.max(0, (s - CURL_CREASE) / (1 - CURL_CREASE));
  return (
    CURL_CREASE_A * smoothstep(0, CURL_CREASE, s) +
    CURL_RAMP * t ** CURL_P +
    CURL_TIP_A * smoothstep(CURL_TIP_S, 1, s)
  );
}

/** Integrate the rolled sheet once: height and horizontal run against arc length. */
const CURL_ROLL = ((): { y: Float64Array; run: Float64Array } => {
  const y = new Float64Array(CURL_N + 1);
  const run = new Float64Array(CURL_N + 1);
  for (let i = 1; i <= CURL_N; i++) {
    const th = rollAngle((i - 0.5) / CURL_N);
    y[i] = y[i - 1] + (Math.sin(th) * CURL_U) / CURL_N;
    run[i] = run[i - 1] + (Math.cos(th) * CURL_U) / CURL_N;
  }
  return { y, run };
})();

interface Curl {
  /** 0 outside the flap, 1 at the tip. */
  s: number;
  /** Height of the folded sheet above the floor. */
  y: number;
  /** How far the tip has drawn back along the diagonal. */
  pull: number;
  /** Tangent angle of the sheet here — the pile stands along its normal. */
  ang: number;
  /** 1 just inboard of the crease: the sheet is pinned flat there, so the fold reads as a valley. */
  pin: number;
}
const NO_CURL: Curl = { s: 0, y: 0, pull: 0, ang: 0, pin: 0 };

function sampleRoll(arr: Float64Array, s: number): number {
  const f = Math.min(CURL_N, Math.max(0, s * CURL_N));
  const i = Math.min(CURL_N - 1, Math.floor(f));
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}

function curlAt(x: number, z: number): Curl {
  const q = CURL_GX * (x - RUG_W / 2) + CURL_GZ * (z - RUG_D / 2);
  if (q < -CURL_U - 0.1) return NO_CURL;
  // A real dog-ear creases along a wandering line, not a drafted one.
  const d = q + CURL_U + fbm(x * 5.5 + 21.4, z * 5.5 + 3.9, 2, 9311) * 0.035;
  if (d <= 0) return { ...NO_CURL, pin: smoothstep(-0.07, 0, d) };
  const s = Math.min(1, d / CURL_U);
  const sp = Math.min(s, 1 - CURL_FLAT);
  return {
    s,
    y: sampleRoll(CURL_ROLL.y, s),
    pull: sp * CURL_U - sampleRoll(CURL_ROLL.run, sp),
    ang: rollAngle(s),
    pin: 1,
  };
}

/** Total height of the woven sheet's underside above the floor at (x, z). */
function underside(x: number, z: number): number {
  const c = curlAt(x, z);
  return lift(x, z) * (1 - c.s) * (1 - 0.85 * c.pin) + c.y;
}

/** Closed rug body: displaced top, chamfered hem, darker bottom. */
function buildBody(): THREE.BufferGeometry {
  const innerW = RUG_W - 2 * EDGE_INSET;
  const innerD = RUG_D - 2 * EDGE_INSET;
  const nx = GRID_X;
  const nz = GRID_Z;
  const vx = nx + 1;
  const vz = nz + 1;
  const n = vx * vz;

  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  /** Push a vertex; `c` = 1 keeps the map colour, < 1 darkens it with a warm bias. */
  const push = (x: number, y: number, z: number, u: number, v: number, c: number): number => {
    positions.push(x, y, z);
    uvs.push(u, v);
    const k = 1 - c;
    colors.push(c, c - k * 0.08, c - k * 0.18);
    return positions.length / 3 - 1;
  };

  // The top sheet is offset along the *sheet* normal, not straight up, so the fold keeps its thickness.
  const gx = new Float64Array(n);
  const gz = new Float64Array(n);
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  const gu = new Float64Array(n);
  const gv = new Float64Array(n);
  const gs = new Float64Array(n); // flap parameter, for the shading
  const topY = new Float64Array(n);
  const botY = new Float64Array(n);
  const topIdx: number[] = new Array(n);
  const botIdx: number[] = new Array(n);
  const cellX = axisCells(nx, innerW);
  const cellZ = axisCells(nz, innerD);

  for (let j = 0; j < vz; j++) {
    for (let i = 0; i < vx; i++) {
      const g = j * vx + i;
      const bx = cellX[i];
      const bz = cellZ[j];

      // Selvedge wander: full on the perimeter ring, 40 % on the next one in.
      const wx = i === 0 ? -1 : i === nx ? 1 : i === 1 ? -0.4 : i === nx - 1 ? 0.4 : 0;
      const wz = j === 0 ? -1 : j === nz ? 1 : j === 1 ? -0.4 : j === nz - 1 ? 0.4 : 0;
      const w = wx !== 0 || wz !== 0 ? edgeWander(bx, bz) : 0;

      // Folded corner: rolls up and draws back along the fold's rise direction.
      const c = curlAt(bx, bz);
      gs[g] = c.s;

      gx[g] = bx + wx * w - c.pull * CURL_GX;
      gz[g] = bz + wz * w - c.pull * CURL_GZ;

      // UVs from the undisplaced grid so the weave keeps its scale, warped so the border stripes wander.
      gu[g] = (bx + RUG_W / 2) / RUG_W + (fbm(bx * 1.25 + 11.3, bz * 1.25 + 4.7, 3, 8113) * UV_WARP) / RUG_W;
      gv[g] = 1 - (bz + RUG_D / 2) / RUG_D + (fbm(bx * 1.25 + 31.7, bz * 1.25 + 19.1, 3, 8114) * UV_WARP) / RUG_D;

      const yb = BOTTOM_Y + lift(bx, bz) * (1 - c.s) * (1 - 0.85 * c.pin) + c.y;
      const thick = pileAt(bx, bz);
      const nOut = -thick * Math.sin(c.ang);
      botY[g] = yb;
      topY[g] = yb + thick * Math.cos(c.ang);
      tx[g] = gx[g] + nOut * CURL_GX;
      tz[g] = gz[g] + nOut * CURL_GZ;

      // Top shading: grime creeping in from the selvedge plus uneven fading.
      const edge = Math.max(Math.abs(bx) / (RUG_W / 2), Math.abs(bz) / (RUG_D / 2));
      const blot = 0.5 + 0.5 * fbm(bx * 0.9 + 13.7, bz * 0.9 + 27.1, 3, 7717);
      topIdx[g] = push(tx[g], topY[g], tz[g], gu[g], gv[g], 1 - 0.05 * smoothstep(0.86, 1, edge) - 0.045 * blot);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = topIdx[j * vx + i];
      const b = topIdx[j * vx + i + 1];
      const c = topIdx[(j + 1) * vx + i];
      const d = topIdx[(j + 1) * vx + i + 1];
      indices.push(a, c, b, b, c, d); // normal +y
    }
  }

  // Bottom grid (normal −y). The strip the fold lifts clear is the only underside seen, so it is darker.
  for (let j = 0; j < vz; j++) {
    for (let i = 0; i < vx; i++) {
      const g = j * vx + i;
      botIdx[g] = push(gx[g], botY[g], gz[g], gu[g], gv[g], 0.44 - 0.26 * gs[g]);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = botIdx[j * vx + i];
      const b = botIdx[j * vx + i + 1];
      const c = botIdx[(j + 1) * vx + i];
      const d = botIdx[(j + 1) * vx + i + 1];
      indices.push(a, b, c, b, d, c);
    }
  }

  // Perimeter loop: −z edge (+x dir) → +x edge (+z dir) → +z edge (−x dir) → −x edge (−z dir)
  const loop: Array<{ i: number; j: number; ox: number; oz: number }> = [];
  for (let i = 0; i < nx; i++) loop.push({ i, j: 0, ox: 0, oz: -1 });
  for (let j = 0; j < nz; j++) loop.push({ i: nx, j, ox: 1, oz: 0 });
  for (let i = nx; i > 0; i--) loop.push({ i, j: nz, ox: 0, oz: 1 });
  for (let j = nz; j > 0; j--) loop.push({ i: 0, j, ox: -1, oz: 0 });
  for (const p of loop) {
    const cx = p.i === 0 ? -1 : p.i === nx ? 1 : 0;
    const cz = p.j === 0 ? -1 : p.j === nz ? 1 : 0;
    if (cx !== 0 && cz !== 0) {
      p.ox = cx * Math.SQRT1_2;
      p.oz = cz * Math.SQRT1_2;
    }
  }

  // Hem rings: ring 0 = top perimeter (shared), ring 1 new, ring 2 = bottom perimeter (shared).
  const rimColor = [1, 0.64, 0.44];
  const rings: number[][] = [];
  for (let k = 0; k <= RINGS; k++) {
    const ring: number[] = [];
    const theta = Math.PI / 2 - (k / RINGS) * Math.PI; // +90° (top) → −90° (bottom)
    for (const p of loop) {
      const g = p.j * vx + p.i;
      if (k === 0) {
        ring.push(topIdx[g]);
        continue;
      }
      if (k === RINGS) {
        ring.push(botIdx[g]);
        continue;
      }
      // Chamfer across the edge: `out` is orthogonalised against the sheet normal, so the hem rolls with it.
      const ux = tx[g] - gx[g];
      const uy = topY[g] - botY[g];
      const uz = tz[g] - gz[g];
      const half = Math.hypot(ux, uy, uz) / 2;
      const inv = half > 1e-9 ? 1 / (2 * half) : 0;
      const nx2 = ux * inv;
      const ny2 = uy * inv;
      const nz2 = uz * inv;
      const dot = p.ox * nx2 + p.oz * nz2;
      let ox = p.ox - nx2 * dot;
      let oy = -ny2 * dot;
      let oz = p.oz - nz2 * dot;
      const len = Math.hypot(ox, oy, oz) || 1;
      ox /= len;
      oy /= len;
      oz /= len;
      // A bound hem is yarn, not extrusion: its thickness wanders.
      const lumpy = fbm(gx[g] * 9 + 5.5, gz[g] * 9 + 12.5, 2, 2287);
      const r = half * (1 + 0.3 * lumpy);
      const co = Math.cos(theta) * r;
      const si = Math.sin(theta) * r;
      const cxm = (gx[g] + tx[g]) / 2;
      const cym = (botY[g] + topY[g]) / 2;
      const czm = (gz[g] + tz[g]) / 2;
      // Continue the map inward across the hem instead of smearing one texel round the rug.
      const arc = (k / RINGS) * Math.PI * r;
      const grain = fbm(gx[g] * 34 + 3.3, gz[g] * 34 + 8.1, 2, 2289);
      ring.push(
        push(
          cxm + ox * co + nx2 * si,
          cym + oy * co + ny2 * si,
          czm + oz * co + nz2 * si,
          gu[g] - (p.ox * arc) / RUG_W,
          gv[g] + (p.oz * arc) / RUG_D,
          rimColor[k] * (1 - 0.18 * gs[g]) * (1 + 0.14 * grain),
        ),
      );
    }
    rings.push(ring);
  }
  const L = loop.length;
  for (let k = 0; k < RINGS; k++) {
    const r0 = rings[k];
    const r1 = rings[k + 1];
    for (let s = 0; s < L; s++) {
      const a = r0[s];
      const b = r0[(s + 1) % L];
      const c = r1[s];
      const d = r1[(s + 1) % L];
      indices.push(a, b, c, b, d, c); // outward-facing
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

interface Tassel {
  /** Half-angle the outer sub-cords fan out by. */
  splay: number;
  /** Signed lateral bow of the whole tassel. */
  bend: number;
  /** Length of each sub-cord relative to FRINGE_LEN. */
  lens: [number, number, number];
  /** Lateral spacing of the three roots. */
  gap: number;
  /** Phase of the ripple the yarn keeps once it is lying on the boards. */
  ripple: number;
}

/** One knotted tassel: three sub-cords that bend down over the first 13 mm and then lie flat. */
function buildTassel(t: Tassel): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const P = new THREE.Vector3();
  const Q = new THREE.Vector3();
  const B = new THREE.Vector3();
  const T = new THREE.Vector3();
  const R = new THREE.Vector3();
  const U = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  const centre = (c: number, u: number, out: THREE.Vector3): void => {
    const psi = (c - 1) * t.splay;
    const len = FRINGE_LEN * t.lens[c];
    const d = u * len;
    const drop = -FRINGE_DROP * smoothstep(0, FRINGE_KNEE, d);
    const lie =
      0.0006 * (1 + Math.sin(d * 85 + t.ripple + c * 2.1)) * smoothstep(FRINGE_KNEE, FRINGE_KNEE * 1.8, d);
    out.set(
      (c - 1) * t.gap + Math.sin(psi) * d + t.bend * (1 + c * 0.35) * u ** 1.7,
      drop + lie,
      Math.cos(psi) * d,
    );
  };

  for (let c = 0; c < 3; c++) {
    const base = positions.length / 3;
    const ts = CORD_T[c];
    for (let k = 0; k < ts.length; k++) {
      const u = ts[k];
      centre(c, u, P);
      centre(c, Math.max(0, u - 0.03), B);
      centre(c, Math.min(1, u + 0.03), Q);
      T.subVectors(Q, B).normalize();
      R.crossVectors(T, UP).normalize();
      U.crossVectors(R, T).normalize();
      const r = CORD_R * (1.05 - 0.6 * u) * (c === 1 ? 1.15 : 0.92);
      for (let a = 0; a < CORD_RS; a++) {
        const th = (a / CORD_RS) * Math.PI * 2 + c * 0.7;
        positions.push(
          P.x + (R.x * Math.cos(th) + U.x * Math.sin(th)) * r,
          P.y + (R.y * Math.cos(th) + U.y * Math.sin(th)) * r,
          P.z + (R.z * Math.cos(th) + U.z * Math.sin(th)) * r,
        );
      }
    }
    centre(c, 1.05, P);
    positions.push(P.x, P.y, P.z);
    const tip = positions.length / 3 - 1;
    // `R = T × UP` winds the ring clockwise from the tip, so the obvious face order is inside out.
    for (let k = 0; k < ts.length - 1; k++) {
      for (let a = 0; a < CORD_RS; a++) {
        const i0 = base + k * CORD_RS + a;
        const i1 = base + k * CORD_RS + ((a + 1) % CORD_RS);
        indices.push(i0, i0 + CORD_RS, i1, i1, i0 + CORD_RS, i1 + CORD_RS);
      }
    }
    const last = base + (ts.length - 1) * CORD_RS;
    for (let a = 0; a < CORD_RS; a++) indices.push(last + a, tip, last + ((a + 1) % CORD_RS));
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

const TASSELS: Tassel[] = [
  { splay: 0.185, bend: 0.0045, lens: [0.92, 1, 0.84], gap: 0.0042, ripple: 0.4 },
  { splay: 0.14, bend: -0.006, lens: [0.8, 1, 0.96], gap: 0.005, ripple: 2.3 },
];

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'rug';
  const rng = createRng(ctx.seed + 4171);

  const set = ctx.textures.rug([RUG_W, RUG_D], PALETTE);
  const woven = ctx.materials.custom({
    color: 0xffffff,
    map: set.map,
    normalMap: set.normalMap ?? null,
    roughnessMap: set.roughnessMap ?? null,
    roughness: 1,
    metalness: 0,
    sheen: 0.4,
    sheenRoughness: 1,
    sheenColor: new THREE.Color(0xfff1dc),
    vertexColors: true,
    envMapIntensity: 0.5,
  });
  woven.normalScale.set(0.9, 0.9);
  woven.name = 'rug-woven';

  // Loose cotton: matte, with just enough sheen to catch the window.
  const yarn = ctx.materials.custom({
    color: FRINGE_COLOR,
    roughness: 0.95,
    metalness: 0,
    sheen: 0.32,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0xfaf1e2),
    envMapIntensity: 0.45,
  });
  yarn.name = 'rug-yarn';

  // Denser and duller than the loose fringe, or the binding renders as a white hairline.
  const bindYarn = ctx.materials.custom({
    color: BIND_COLOR,
    roughness: 0.98,
    metalness: 0,
    sheen: 0.2,
    sheenRoughness: 0.95,
    sheenColor: new THREE.Color(0xeee3d0),
    envMapIntensity: 0.3,
  });
  bindYarn.name = 'rug-binding';

  g.add(mesh(buildBody(), woven, undefined, { name: 'rug-body' }));

  // The wrapped cord the warps are knotted to, sitting proud of the weave.
  const endEdgeZ = (x: number, s: number): number => s * (EDGE_Z + edgeWander(x, s * EDGE_Z));
  const bindingParts: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const pts: THREE.Vector3[] = [];
    const n = 26;
    for (let i = 0; i <= n; i++) {
      const x0 = -EDGE_X + (i / n) * (2 * EDGE_X);
      const c = curlAt(x0, s * EDGE_Z);
      // Stand the cord off along the *sheet* normal, or it floats free where the corner rolls.
      const off = EDGE_PILE + BIND_R * 0.45 + (rng() - 0.5) * 0.0022;
      const back = c.pull + off * Math.sin(c.ang);
      pts.push(
        new THREE.Vector3(
          x0 - back * CURL_GX,
          underside(x0, s * EDGE_Z) + off * Math.cos(c.ang),
          endEdgeZ(x0, s) - s * 0.0022 - back * CURL_GZ,
        ),
      );
    }
    bindingParts.push(tube(pts, BIND_R, 3, 30));
  }
  g.add(mesh(mergeGeometries(bindingParts), bindYarn, undefined, { name: 'rug-bindings' }));

  const geos = TASSELS.map(buildTassel);
  const verts = geos.map((geo) => geo.attributes.position as THREE.BufferAttribute);
  const placed: Array<{ v: number; m: THREE.Matrix4; c: THREE.Color }> = [];
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const sc = new THREE.Vector3();
  const vtx = new THREE.Vector3();
  const span = 2 * EDGE_X - 0.04;

  for (const s of [1, -1]) {
    for (let i = 0; i < FRINGE_PER_END; i++) {
      let x = -span / 2 + ((i + 0.5) / FRINGE_PER_END) * span + (rng() - 0.5) * 0.016;
      // Real fringe clumps: an evenly pitched band reads as a comb.
      if (rng() < 0.4) x += (i % 2 === 0 ? 1 : -1) * 0.012;
      const v = rng() < 0.5 ? 0 : 1;
      const lenScale = 0.62 + rng() * 0.78; // ±40 %, so neighbouring tips overlap
      const wide = 0.72 + rng() * 0.58; // fans the tassel and scales its bow
      const rootLift = underside(x, s * EDGE_Z);
      const pull = curlAt(x, s * EDGE_Z).pull;
      const rootY = rootLift + EDGE_PILE * 0.45;
      const tail = FRINGE_LEN * lenScale - FRINGE_KNEE;
      // Pitch only takes up the slack the baked knee leaves; the rest of the cord lies on the boards.
      let pitch = Math.asin(THREE.MathUtils.clamp((rootY - FRINGE_DROP - CORD_R * 0.6) / tail, -0.6, 0.6));
      if (rng() < 0.12) pitch -= 0.14 + rng() * 0.2; // a few tips lift off the floor
      pitch += (rng() - 0.5) * 0.12;
      const yaw = (s > 0 ? 0 : Math.PI) + THREE.MathUtils.degToRad((rng() - 0.5) * 34);
      e.set(pitch, yaw, (rng() - 0.5) * 0.36, 'YXZ');
      q.setFromEuler(e);
      sc.set(wide, 0.85 + rng() * 0.35, lenScale);
      p.set(x - pull * CURL_GX, rootY, endEdgeZ(x, s) + s * 0.0012 - pull * CURL_GZ);
      m.compose(p, q, sc);

      // Measure the lowest transformed vertex rather than guessing a half-thickness off a bent cord.
      const sPos = verts[v];
      const me = m.elements;
      let minY = Infinity;
      for (let k = 0; k < sPos.count; k++) {
        const y = me[1] * sPos.getX(k) + me[5] * sPos.getY(k) + me[9] * sPos.getZ(k) + me[13];
        if (y < minY) minY = y;
      }
      p.y -= THREE.MathUtils.clamp(minY - 0.0005, -0.02, 0.004);
      m.compose(p, q, sc);

      const tone = 0.86 + rng() * 0.14;
      const dust = rng() * 0.07;
      placed.push({ v, m: m.clone(), c: new THREE.Color(tone, tone - dust * 0.35, tone - dust) });
    }
  }

  for (let v = 0; v < geos.length; v++) {
    const mine = placed.filter((e2) => e2.v === v);
    const inst = new THREE.InstancedMesh(geos[v], yarn, mine.length);
    inst.name = `rug-fringe-${v}`;
    inst.castShadow = true;
    inst.receiveShadow = true;
    const bounds = new THREE.Box3();
    const sPos = verts[v];
    mine.forEach((entry, k) => {
      inst.setMatrixAt(k, entry.m);
      inst.setColorAt(k, entry.c);
      for (let j = 0; j < sPos.count; j++) {
        vtx.set(sPos.getX(j), sPos.getY(j), sPos.getZ(j)).applyMatrix4(entry.m);
        bounds.expandByPoint(vtx);
      }
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    // Real transformed vertex bounds: a rotated box AABB over-reports and pushes min.y below the floor.
    inst.boundingBox = bounds.clone();
    inst.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
    g.add(inst);
  }

  return g;
}
