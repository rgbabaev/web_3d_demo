import * as THREE from 'three';
import { cylinder, mergeGeometries, mesh } from '../core/geometry';
import { createRng, fbm } from '../core/noise';
import type { SceneContext } from '../core/types';

const DEG = Math.PI / 180;

const PLATFORM_W = 2.16;
const DEPTH = 0.95;
const LEG_H = 0.14;
const PLATFORM_H = 0.125;
const RAIL_H = 0.024; // recessed base rail at the bottom of the platform
const RAIL_INSET = 0.007;
const PLATFORM_TOP = LEG_H + PLATFORM_H; // 0.265
const PLATFORM_R = 0.03;
const ARM_W = 0.15;
const ARM_TOP = 0.62;
const ARM_FLARE = 0.02; // outward lean of the arm top
const ARM_R = 0.055;
const BACK_T = 0.1;
// 9 cm below the loose back cushions: flush, the two read as one flat wall.
const BACK_TOP = 0.755;
const BACK_RECESS = 0.003; // outside back panel set in from the arms / platform
const SEAT_W = 0.605;
const SEAT_T = 0.2;
const SEAT_D = 0.57;
const SEAT_R = 0.085;
const SEAT_SINK = 0.025;
const SEAT_GAP = 0.012;
const SEAT_FRONT_Z = DEPTH / 2 - 0.004;
const BACK_CUSHION_W = 0.615;
const BACK_CUSHION_H = 0.58; // tops out at ≈0.85 — the nominal height of the sofa
const BACK_CUSHION_T = 0.21;
const BACK_CUSHION_R = 0.095;
const PILLOW = 0.45;
const PILLOW_T = 0.16;
const WELT_R = 0.006;
/** Fraction of its radius the cord sits proud of the surface it is sewn into. */
const WELT_PROUD = 1;

function xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
  m.setPosition(x, y, z);
  return m;
}

function bake(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  g.applyMatrix4(m);
  return g;
}

/** Shear in x (and z) proportional to the distance below `yRef`: x' = x + kx·(yRef − y). */
function shearBelow(yRef: number, kx: number, kz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().set(1, -kx, 0, kx * yRef, 0, 1, 0, 0, 0, -kz, 1, kz * yRef, 0, 0, 0, 1);
}

/** Shear in x proportional to the height above `yRef`: x' = x + kx·(y − yRef). */
function shearAbove(yRef: number, kx: number): THREE.Matrix4 {
  return new THREE.Matrix4().set(1, kx, 0, -kx * yRef, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const uni = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.clearGroups();
    return n;
  });
  const out = mergeGeometries(uni, false);
  if (!out) throw new Error('sofa: mergeGeometries failed');
  return out;
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

const smooth01 = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** 1 at the centre, 0 at |t| = 1, with no plateau and no kink — a real crown. */
const crown = (t: number): number => Math.cos(clamp01(Math.abs(t)) * (Math.PI / 2));

/** Flat faces carry `flat[axis]` grid divisions, edge and corner arcs `arc` uniform angular steps. */
function softBox(w: number, h: number, d: number, radius: number, flat: [number, number, number], arc = 3): THREE.BufferGeometry {
  const r = Math.min(radius, w / 2, h / 2, d / 2);
  const core = [w / 2 - r, h / 2 - r, d / 2 - r];
  const T = flat.map((f) => f + 2 * arc) as [number, number, number];
  const g = new THREE.BoxGeometry(1, 1, 1, T[0], T[1], T[2]);
  g.clearGroups();
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const c = [0, 0, 0];
  const m = [0, 0, 0];
  const p = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    p[0] = pos.getX(i);
    p[1] = pos.getY(i);
    p[2] = pos.getZ(i);
    for (let a = 0; a < 3; a++) {
      const t = p[a];
      const at = Math.abs(t);
      const t0 = (0.5 * flat[a]) / T[a];
      if (at <= t0 + 1e-6) {
        c[a] = t0 > 0 ? (t / t0) * core[a] : 0;
        m[a] = 0;
      } else {
        const u = Math.min(1, (at - t0) / (0.5 - t0));
        c[a] = Math.sign(t) * core[a];
        m[a] = Math.sign(t) * Math.tan((u * Math.PI) / 4);
      }
    }
    const len = Math.hypot(m[0], m[1], m[2]) || 1;
    const nx = m[0] / len;
    const ny = m[1] / len;
    const nz = m[2] / len;
    pos.setXYZ(i, c[0] + nx * r, c[1] + ny * r, c[2] + nz * r);
    nor.setXYZ(i, nx, ny, nz);
  }
  return g;
}

type Deform = (p: THREE.Vector3, n: THREE.Vector3) => void;

/** Angle-weighted smooth normals, welding duplicate positions across faces. */
function smoothNormals(g: THREE.BufferGeometry): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const idx = g.index;
  const count = pos.count;
  const keys = new Array<string>(count);
  const acc = new Map<string, THREE.Vector3>();
  for (let i = 0; i < count; i++) {
    const k = `${Math.round(pos.getX(i) * 2e4)},${Math.round(pos.getY(i) * 2e4)},${Math.round(pos.getZ(i) * 2e4)}`;
    keys[i] = k;
    if (!acc.has(k)) acc.set(k, new THREE.Vector3());
  }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e0 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const tris = idx ? idx.count / 3 : count / 3;
  for (let t = 0; t < tris; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3;
    const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    e0.subVectors(b, a);
    e1.subVectors(c, a);
    fn.crossVectors(e0, e1);
    if (fn.lengthSq() < 1e-22) continue;
    fn.normalize();
    const wa = e0.angleTo(e1);
    e0.subVectors(a, b);
    e1.subVectors(c, b);
    const wb = e0.angleTo(e1);
    const wc = Math.max(0, Math.PI - wa - wb);
    acc.get(keys[ia])!.addScaledVector(fn, wa);
    acc.get(keys[ib])!.addScaledVector(fn, wb);
    acc.get(keys[ic])!.addScaledVector(fn, wc);
  }
  for (let i = 0; i < count; i++) {
    const n = acc.get(keys[i])!;
    if (n.lengthSq() > 0) {
      const l = n.length();
      nor.setXYZ(i, n.x / l, n.y / l, n.z / l);
    }
  }
  nor.needsUpdate = true;
}

/** Displace every vertex with `fn(p, n)` (mutates p) and recompute smooth normals. */
function deform(g: THREE.BufferGeometry, fn: Deform): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    fn(p, n);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  smoothNormals(g);
  return g;
}

/** Box-map UVs in metres (1 UV unit = 1 m) using the dominant normal axis. */
function boxUV(g: THREE.BufferGeometry, ox = 0, oy = 0): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (nx >= ny && nx >= nz) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else if (ny >= nz) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else {
      u = pos.getX(i);
      v = pos.getY(i);
    }
    uv.setXY(i, u + ox, v + oy);
  }
  uv.needsUpdate = true;
  return g;
}

/** `nrm[i]` is the unit normal at `pts[i]`; the cord lifts `proud · tubeR` clear of the deformed surface so it cannot sink through the cloth. */
function cordLoop(pts: THREE.Vector3[], nrm: THREE.Vector3[], tubeR: number, fn?: Deform, proud = WELT_PROUD): THREE.BufferGeometry {
  if (fn) for (let i = 0; i < pts.length; i++) fn(pts[i], nrm[i]);
  for (let i = 0; i < pts.length; i++) pts[i].addScaledVector(nrm[i], proud * tubeR);
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  const g = new THREE.TubeGeometry(curve, pts.length, tubeR, 8, true);
  // u along the cord in metres so the weave is at real scale.
  const length = curve.getLength();
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * length, uv.getY(i) * 2 * Math.PI * tubeR);
  return g;
}

/** `'top'` runs round the +y face (A = x, B = z, C = y half height), `'front'` round the +z face (A = x, B = y, C = z). */
function seamLoop(
  A: number,
  B: number,
  C: number,
  r: number,
  face: 'top' | 'front',
  tubeR: number,
  fn?: Deform,
  step = 0.042,
): THREE.BufferGeometry {
  const k = Math.SQRT1_2;
  const ca = A - r;
  const cb = B - r;
  const up = C - r + r * k;
  const rr = r * k;
  const pts: THREE.Vector3[] = [];
  const nrm: THREE.Vector3[] = [];
  const push = (a: number, b: number, na: number, nb: number): void => {
    if (face === 'top') {
      pts.push(new THREE.Vector3(a, up, b));
      nrm.push(new THREE.Vector3(na, k, nb));
    } else {
      pts.push(new THREE.Vector3(a, b, up));
      nrm.push(new THREE.Vector3(na, nb, k));
    }
  };
  const side = (a0: number, b0: number, a1: number, b1: number, na: number, nb: number): void => {
    const len = Math.hypot(a1 - a0, b1 - b0);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      push(a0 + (a1 - a0) * t, b0 + (b1 - b0) * t, na, nb);
    }
  };
  const corner = (sa: number, sb: number, a0: number): void => {
    const segs = 4;
    for (let i = 0; i <= segs; i++) {
      const phi = a0 + (i / segs) * (Math.PI / 2);
      push(sa * ca + rr * Math.cos(phi), sb * cb + rr * Math.sin(phi), k * Math.cos(phi), k * Math.sin(phi));
    }
  };
  corner(1, 1, 0);
  side(ca, cb + rr, -ca, cb + rr, 0, k);
  corner(-1, 1, Math.PI / 2);
  side(-ca - rr, cb, -ca - rr, -cb, -k, 0);
  corner(-1, -1, Math.PI);
  side(-ca, -cb - rr, ca, -cb - rr, 0, -k);
  corner(1, -1, Math.PI * 1.5);
  side(ca + rr, -cb, ca + rr, cb, k, 0);
  return cordLoop(pts, nrm, tubeR, fn);
}

/** Closed cross-section of a folded blanket: flat faces, semicircular folds. */
function stadiumRing(halfT: number, halfW: number, flatSegs: number, capSegs: number): Array<[number, number]> {
  const zf = Math.max(1e-5, halfW - halfT);
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= flatSegs; i++) out.push([halfT, -zf + (2 * zf * i) / flatSegs]);
  for (let i = 1; i <= capSegs; i++) {
    const th = (i / (capSegs + 1)) * Math.PI;
    out.push([halfT * Math.cos(th), zf + halfT * Math.sin(th)]);
  }
  for (let i = 0; i <= flatSegs; i++) out.push([-halfT, zf - (2 * zf * i) / flatSegs]);
  for (let i = 1; i <= capSegs; i++) {
    const th = (i / (capSegs + 1)) * Math.PI;
    out.push([-halfT * Math.cos(th), -zf - halfT * Math.sin(th)]);
  }
  return out;
}

/** Both ends are closed by folding the cross-section over a quarter circle, so no bare extruded face is ever visible. */
function sweptSlab(path: THREE.Vector2[], halfT: number, halfW: number, flatSegs = 8, capSegs = 3): THREE.BufferGeometry {
  const n = path.length;
  const tangentAt = (i: number): THREE.Vector2 => {
    const p0 = path[Math.max(0, i - 1)];
    const p1 = path[Math.min(n - 1, i + 1)];
    return new THREE.Vector2().subVectors(p1, p0).normalize();
  };
  const CAP_E = [0.966, 0.866, 0.5, 0];
  const CAP_ADV = [0.259, 0.5, 0.866, 1];
  const centres: THREE.Vector2[] = [];
  const normals: THREE.Vector2[] = [];
  const scale: number[] = [];
  const t0 = tangentAt(0);
  for (let j = CAP_E.length - 1; j >= 0; j--) {
    centres.push(new THREE.Vector2().copy(path[0]).addScaledVector(t0, -CAP_ADV[j] * halfT));
    normals.push(new THREE.Vector2(-t0.y, t0.x));
    scale.push(CAP_E[j]);
  }
  for (let i = 0; i < n; i++) {
    const t = tangentAt(i);
    centres.push(path[i].clone());
    normals.push(new THREE.Vector2(-t.y, t.x));
    scale.push(1);
  }
  const tn = tangentAt(n - 1);
  for (let j = 0; j < CAP_E.length; j++) {
    centres.push(new THREE.Vector2().copy(path[n - 1]).addScaledVector(tn, CAP_ADV[j] * halfT));
    normals.push(new THREE.Vector2(-tn.y, tn.x));
    scale.push(CAP_E[j]);
  }

  const R = centres.length;
  const K = 2 * (flatSegs + 1) + 2 * capSegs;
  const position = new Float32Array(R * K * 3);
  for (let r = 0; r < R; r++) {
    const ring = stadiumRing(halfT * scale[r], halfW - halfT * (1 - scale[r]), flatSegs, capSegs);
    const c = centres[r];
    const nv = normals[r];
    for (let k = 0; k < K; k++) {
      const o = (r * K + k) * 3;
      position[o] = c.x + nv.x * ring[k][0];
      position[o + 1] = c.y + nv.y * ring[k][0];
      position[o + 2] = ring[k][1];
    }
  }
  const index: number[] = [];
  for (let r = 0; r < R - 1; r++) {
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      const a = r * K + k;
      const b = r * K + k1;
      const c = (r + 1) * K + k1;
      const d = (r + 1) * K + k;
      index.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(R * K * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(R * K * 2), 2));
  g.setIndex(index);
  smoothNormals(g);
  return g;
}

/** Local frame: origin at the arm top centre, +x outward, +y up. */
function blanketPath(a: number, ra: number, oTop: number, oHang: number, lIn: number, lOut: number, swing: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const cx = a - ra;
  const cy = -ra;
  const Rof = (phi: number): number => ra + oHang + (oTop - oHang) * Math.abs(Math.sin(phi));
  const nIn = Math.max(2, Math.round((lIn - ra) / 0.022));
  for (let i = 0; i <= nIn; i++) {
    const t = i / nIn;
    pts.push(new THREE.Vector2(-(a + oHang) - swing * 0.4 * (1 - t) * (1 - t), -lIn + (lIn - ra) * t));
  }
  for (let i = 1; i <= 7; i++) {
    const phi = Math.PI - (i / 7) * (Math.PI / 2);
    pts.push(new THREE.Vector2(-cx + Rof(phi) * Math.cos(phi), cy + Rof(phi) * Math.sin(phi)));
  }
  const nTop = Math.max(2, Math.round((2 * cx) / 0.022));
  for (let i = 1; i < nTop; i++) pts.push(new THREE.Vector2(-cx + (2 * cx * i) / nTop, oTop));
  for (let i = 0; i <= 7; i++) {
    const phi = Math.PI / 2 - (i / 7) * (Math.PI / 2);
    pts.push(new THREE.Vector2(cx + Rof(phi) * Math.cos(phi), cy + Rof(phi) * Math.sin(phi)));
  }
  const nOut = Math.max(3, Math.round((lOut - ra) / 0.022));
  for (let i = 1; i <= nOut; i++) {
    const t = i / nOut;
    pts.push(new THREE.Vector2(a + oHang + swing * t * t, -ra - (lOut - ra) * t));
  }
  return pts;
}

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'sofa';
  const rng = createRng(ctx.seed + 7301);
  const jit = (amt: number): number => (rng() - 0.5) * 2 * amt;

  const M = ctx.materials;
  const shellFab = M.fabric(0x928878, { boucle: true, surface: [1, 1] });
  // Cloned: the library sheen (0.6, half-white) burns a greasy specular patch
  // into a crowned cushion in direct sun; bouclé scatters it far wider.
  const cushionFab = M.fabric(0x9b9181, { boucle: true, surface: [1, 1] }).clone();
  cushionFab.sheen = 0.3;
  cushionFab.sheenRoughness = 0.95;
  cushionFab.sheenColor.set(0xada392);
  cushionFab.name = 'sofa.cushion';
  // Contrast welt. De-sheened so a 12 mm cord doesn't blow out to white.
  const pipingFab = M.fabric(0x7d766a, { surface: [1, 1] }).clone();
  pipingFab.sheen = 0.12;
  pipingFab.sheenRoughness = 0.95;
  pipingFab.sheenColor.set(0x6b655c);
  pipingFab.name = 'sofa.welt';
  // Oak tinted down from the library's near-white base and given a tight UV so
  // the grain cycles twice over a 0.14 m leg instead of stretching to one band.
  const oak = M.wood('oak', { surface: [0.055, 0.1], rotate: true }).clone();
  oak.color.set(0xdcbb8c);
  oak.clearcoat = 0.18;
  oak.clearcoatRoughness = 0.45;
  oak.name = 'sofa.oak';
  const dark = M.rubber(0x262422);
  // Plain weave against the oat bouclé: the two pillows differ in cloth, not
  // only colour. Default scale — a coarser `scale` flattens the normal map.
  const rustFab = M.fabric(0xa0502e, { surface: [1, 1] }).clone();
  rustFab.normalScale.set(1.3, 1.3);
  rustFab.sheen = 0.3;
  rustFab.name = 'sofa.pillowRust';
  const oatFab = M.fabric(0xd9d0bf, { boucle: true, surface: [1, 1] });
  const sageFab = M.fabric(0x7c8a74, { boucle: true, surface: [1, 1] }).clone();
  sageFab.normalScale.set(1.2, 1.2);
  sageFab.sheen = 0.45;
  sageFab.sheenRoughness = 0.9;
  sageFab.name = 'sofa.throw';

  const shellParts: THREE.BufferGeometry[] = [];
  const cushionParts: THREE.BufferGeometry[] = [];
  const pipingParts: THREE.BufferGeometry[] = [];
  const oakParts: THREE.BufferGeometry[] = [];
  const darkParts: THREE.BufferGeometry[] = [];
  const rustParts: THREE.BufferGeometry[] = [];
  const oatParts: THREE.BufferGeometry[] = [];
  const sageParts: THREE.BufferGeometry[] = [];

  const legTopY = LEG_H + 0.002; // 2 mm into the platform
  const legInsetX = PLATFORM_W / 2 - 0.105;
  const legInsetZ = DEPTH / 2 - 0.105;
  const splay = Math.tan(5 * DEG) * Math.SQRT1_2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const shear = shearBelow(legTopY, splay * sx, splay * sz);
      const bodyH = legTopY - 0.004;
      const leg = cylinder(0.04, 0.025, bodyH, 28);
      bake(leg, xf(0, 0.004 + bodyH / 2, 0));
      bake(leg, shear);
      bake(leg, xf(sx * legInsetX, 0, sz * legInsetZ));
      oakParts.push(leg);
      const pad = cylinder(0.0245, 0.0245, 0.004, 24);
      bake(pad, xf(0, 0.002, 0));
      bake(pad, shear);
      bake(pad, xf(sx * legInsetX, 0, sz * legInsetZ));
      darkParts.push(pad);
    }
  }
  const dust = new THREE.BoxGeometry(PLATFORM_W - 0.08, 0.003, DEPTH - 0.08);
  bake(dust, xf(0, LEG_H - 0.0005, 0));
  darkParts.push(dust);

  // Base rail, inset 7 mm: a shadow line right round the bottom of the frame.
  const rail = softBox(PLATFORM_W - 2 * RAIL_INSET, RAIL_H, DEPTH - 2 * RAIL_INSET, 0.008, [6, 1, 3], 2);
  boxUV(rail, jit(0.3), jit(0.3));
  bake(rail, xf(0, LEG_H + RAIL_H / 2, 0));
  shellParts.push(rail);

  const platH = PLATFORM_H - RAIL_H + 0.004;
  {
    const ph = platH / 2;
    const platform = deform(softBox(PLATFORM_W, platH, DEPTH, PLATFORM_R, [10, 2, 4], 3), (p, n) => {
      const px = p.x / (PLATFORM_W / 2);
      const py = p.y / ph;
      // an upholstered panel is never a plane: the front and back faces belly
      // out between the legs, the ends a little less
      const belly = (1 - py * py) * (0.007 * Math.abs(n.z) * crown(px * 0.85) + 0.004 * Math.abs(n.x));
      const wr = 0.0016 * fbm(p.x * 5 + 3, p.y * 7 + p.z * 4, 3, 21);
      p.addScaledVector(n, belly + wr);
    });
    boxUV(platform, jit(0.3), jit(0.3));
    bake(platform, xf(0, PLATFORM_TOP - platH / 2, 0));
    shellParts.push(platform);
  }

  const armH = ARM_TOP - PLATFORM_TOP + 0.005;
  const armK = ARM_FLARE / (ARM_TOP - PLATFORM_TOP);
  for (const sx of [-1, 1]) {
    const ah = armH / 2;
    const armFn: Deform = (p, n) => {
      const px = p.x / (ARM_W / 2);
      const py = p.y / ah;
      const pz = p.z / (DEPTH / 2);
      // crowned cap and a bellied outer face, so neither meets the other in a
      // crease: the 55 mm fillet then reads as a roll, not a chamfer
      const cap = 0.017 * Math.max(0, n.y) * crown(pz * 0.65) * (1 - 0.22 * px * px);
      const face = 0.009 * Math.abs(n.x) * crown(pz * 0.85) * (1 - 0.7 * py * py);
      const ends = 0.004 * Math.abs(n.z) * (1 - 0.5 * py * py);
      const wr = 0.0024 * fbm(p.z * 7 + sx * 4, p.y * 7 + p.x * 5, 3, 55);
      p.addScaledVector(n, cap + face + ends + wr);
    };
    const arm = deform(softBox(ARM_W, armH, DEPTH, ARM_R, [3, 4, 6], 4), armFn);
    boxUV(arm, jit(0.3), jit(0.3));
    const place = xf(sx * (PLATFORM_W / 2 - ARM_W / 2), PLATFORM_TOP - 0.005 + ah, 0);
    const lean = shearAbove(PLATFORM_TOP, armK * sx);
    bake(arm, place);
    bake(arm, lean);
    shellParts.push(arm);
    const armWelt = seamLoop(ARM_W / 2, DEPTH / 2, ah, ARM_R, 'top', WELT_R, armFn, 0.05);
    bake(armWelt, place);
    bake(armWelt, lean);
    pipingParts.push(armWelt);
  }

  const backW = PLATFORM_W - 2 * ARM_W + 0.06; // tucks 3 cm into each arm
  const backH = BACK_TOP - PLATFORM_TOP + 0.005;
  const back = softBox(backW, backH, BACK_T, 0.035, [8, 3, 1], 3);
  boxUV(back, jit(0.3), jit(0.3));
  // recessed 3 mm from the arms and the platform: the outside back reads as a
  // separate sewn-on panel and the AO pass finds the joint.
  const backPlace = xf(0, PLATFORM_TOP - 0.005 + backH / 2, -DEPTH / 2 + BACK_T / 2 + BACK_RECESS);
  bake(back, backPlace);
  shellParts.push(back);
  const backWelt = seamLoop(backW / 2, BACK_T / 2, backH / 2, 0.035, 'top', WELT_R, undefined, 0.055);
  bake(backWelt, backPlace);
  pipingParts.push(backWelt);

  // The outside back is a separate piece of cloth: welt it right round, just
  // inside the arm junctions and above the platform step.
  {
    const zOut = -DEPTH / 2 + BACK_RECESS;
    const x1 = backW / 2 - 0.022;
    const y0 = PLATFORM_TOP + 0.006;
    const y1 = BACK_TOP - 0.05;
    const cr = 0.03;
    const pts: THREE.Vector3[] = [];
    const nrm: THREE.Vector3[] = [];
    const add = (x: number, y: number): void => {
      pts.push(new THREE.Vector3(x, y, zOut));
      nrm.push(new THREE.Vector3(0, 0, -1));
    };
    const straight = (xa: number, ya: number, xb: number, yb: number): void => {
      const n = Math.max(1, Math.round(Math.hypot(xb - xa, yb - ya) / 0.055));
      for (let i = 1; i < n; i++) add(xa + (xb - xa) * (i / n), ya + (yb - ya) * (i / n));
    };
    const arc = (cx: number, cy: number, a0: number): void => {
      for (let i = 0; i <= 3; i++) {
        const a = a0 + (i / 3) * (Math.PI / 2);
        add(cx + cr * Math.cos(a), cy + cr * Math.sin(a));
      }
    };
    arc(-x1 + cr, y0 + cr, Math.PI);
    straight(-x1 + cr, y0, x1 - cr, y0);
    arc(x1 - cr, y0 + cr, -Math.PI / 2);
    straight(x1, y0 + cr, x1, y1 - cr);
    arc(x1 - cr, y1 - cr, 0);
    straight(x1 - cr, y1, -x1 + cr, y1);
    arc(-x1 + cr, y1 - cr, Math.PI / 2);
    straight(-x1, y1 - cr, -x1, y0 + cr);
    pipingParts.push(cordLoop(pts, nrm, WELT_R));
  }

  // Welt along the platform's top-front edge — the line that separates frame
  // from cushion where the two meet. The return leg runs inside the platform so
  // the loop closes without a second visible cord, and turns under the arms.
  {
    const k = Math.SQRT1_2;
    const x1 = PLATFORM_W / 2 - ARM_W + 0.02;
    const yE = PLATFORM_TOP - PLATFORM_R + PLATFORM_R * k;
    const zE = DEPTH / 2 - PLATFORM_R + PLATFORM_R * k;
    const pts: THREE.Vector3[] = [];
    const nrm: THREE.Vector3[] = [];
    const n = Math.round((2 * x1) / 0.055);
    for (let i = 0; i <= n; i++) {
      pts.push(new THREE.Vector3(-x1 + (2 * x1 * i) / n, yE, zE));
      nrm.push(new THREE.Vector3(0, k, k));
    }
    for (let i = 1; i < 4; i++) {
      pts.push(new THREE.Vector3(x1 - (2 * x1 * i) / 4, PLATFORM_TOP - 0.05, DEPTH / 2 - 0.07));
      nrm.push(new THREE.Vector3(0, 0, 1));
    }
    pipingParts.push(cordLoop(pts, nrm, WELT_R));
  }

  const seatX = [-SEAT_W - SEAT_GAP, 0, SEAT_W + SEAT_GAP];
  const squished = Math.floor(rng() * 3);
  const seatTop: number[] = [];
  const seatZ = SEAT_FRONT_Z - SEAT_D / 2;
  for (let i = 0; i < 3; i++) {
    const compressed = i === squished;
    const hw = SEAT_W / 2;
    const hh = SEAT_T / 2;
    const hd = SEAT_D / 2;
    const domeAmp = compressed ? 0.031 : 0.045 + jit(0.003);
    const frontAmp = compressed ? 0.019 : 0.024;
    const jointL = i > 0 ? 1 : 0;
    const jointR = i < 2 ? 1 : 0;
    const seed = 40 + i * 7;
    const off = rng() * 10;
    const fn: Deform = (p, n) => {
      const px = p.x / hw;
      const pz = p.z / hd;
      const py = p.y / hh;
      // At a free end the crown rolls away to nothing; at a joint it runs on,
      // so the three cushions read as one seat split by two creases rather than
      // three boards with slots between them.
      const j = px < 0 ? jointL : jointR;
      const gx = j ? 1 - 0.14 * px * px : crown(px);
      const gz = crown(pz);
      const dome = domeAmp * gx * gz * Math.max(0, n.y) * (1 + 0.12 * pz);
      const wall = 1 - 0.5 * py * py;
      const side = Math.abs(n.x) * gz * wall * (0.009 + 0.013 * j);
      const front = frontAmp * Math.max(0, n.z) * gx * wall;
      const rear = 0.01 * Math.max(0, -n.z) * gx * wall;
      const wr = 0.003 * fbm(p.x * 9 + off, p.z * 9 + p.y * 6 + off * 0.3, 3, seed);
      p.addScaledVector(n, dome + side + front + rear + wr);
    };
    const cushion = deform(softBox(SEAT_W, SEAT_T, SEAT_D, SEAT_R, [9, 2, 8], 6), fn);
    boxUV(cushion, jit(0.3), jit(0.3));
    const y = PLATFORM_TOP - SEAT_SINK + hh - (compressed ? 0.009 : 0);
    const yaw = jit(0.5 * DEG);
    bake(cushion, xf(seatX[i], y, seatZ, 0, yaw, 0));
    cushionParts.push(cushion);
    seatTop.push(y + hh + domeAmp);
  }

  const backPlanes: Array<{ y0: number; z0: number; tan: number }> = [];
  for (let i = 0; i < 3; i++) {
    const hw = BACK_CUSHION_W / 2;
    const hh = (BACK_CUSHION_H + jit(0.014)) / 2;
    const hd = BACK_CUSHION_T / 2;
    const lean = (12 + jit(1.4)) * DEG;
    const domeAmp = 0.052 + jit(0.004);
    const sag = 0.024 + jit(0.005);
    const jointL = i > 0 ? 1 : 0;
    const jointR = i < 2 ? 1 : 0;
    const seed = 80 + i * 7;
    const off = rng() * 10;
    const fn: Deform = (p, n) => {
      const px = p.x / hw;
      const py = p.y / hh;
      const pz = p.z / hd;
      const j = px < 0 ? jointL : jointR;
      const gx = j ? 1 - 0.12 * px * px : crown(px);
      const gy = crown(py);
      // loose fill settles low, so the belly of the cushion is below centre
      const dome = domeAmp * gx * gy * Math.max(0, n.z) * (0.7 + 0.55 * -py);
      // the ends are stuffed too — without this they stay planar and show as
      // flat vertical fins above the arms
      const ends = (0.013 + 0.007 * j) * Math.abs(n.x) * gy * (1 - 0.45 * pz * pz);
      const top = 0.013 * Math.max(0, n.y) * gx * (1 - 0.4 * pz * pz);
      const bot = 0.008 * Math.max(0, -n.y) * gx;
      const rear = 0.01 * Math.max(0, -n.z) * gx * gy;
      // a soft horizontal crease where a back is leaned against, plus wrinkles
      const crease = -0.006 * Math.max(0, n.z) * gx * Math.exp(-Math.pow((py + 0.12) * 3.2, 2));
      const wr = 0.0055 * fbm(p.x * 6 + off, p.y * 6 + p.z * 4 + off * 0.3, 3, seed);
      p.addScaledVector(n, dome + ends + top + bot + rear + wr + crease);
      // the fill has slumped: the top edge dips in the middle, the corners
      // stand up, and the cushion narrows where nothing holds it out
      const t = smooth01((py - 0.25) / 0.75);
      p.y -= sag * t * (1 - 0.6 * px * px + 0.35 * fbm(px * 1.7 + off, 0.5, 2, seed + 5));
      p.x *= 1 - 0.055 * t;
      // the bottom spills onto the seat; the roll peaks above the seat top so
      // the rolled edge can never surface through the seat cushion
      const d = p.y + hh;
      const u = clamp01(1 - Math.abs(d - 0.16) / 0.13);
      const roll = u * u * (3 - 2 * u);
      p.z += 0.028 * roll * (0.7 + 0.3 * gx);
      p.y -= 0.009 * roll;
      p.z -= 0.012 * smooth01((0.05 - d) / 0.05);
    };
    const cushion = deform(softBox(BACK_CUSHION_W, 2 * hh, BACK_CUSHION_T, BACK_CUSHION_R, [7, 5, 2], 5), fn);
    boxUV(cushion, jit(0.3), jit(0.3));
    // Bottom-front edge drops into the deck channel just behind the seat
    // cushions; the lean presses the top into the back panel.
    const rot = new THREE.Euler(-lean, jit(1 * DEG), jit(1 * DEG), 'YXZ');
    const anchor = new THREE.Vector3(0, -hh, hd).applyEuler(rot);
    const targetY = PLATFORM_TOP - 0.012;
    const targetZ = seatZ - SEAT_D / 2 - 0.004;
    bake(cushion, new THREE.Matrix4().makeRotationFromEuler(rot).setPosition(seatX[i], targetY - anchor.y, targetZ - anchor.z));
    cushionParts.push(cushion);
    // the plane a throw pillow leans on: the crowned front face, not the box
    backPlanes.push({ y0: targetY, z0: targetZ + domeAmp * 0.5, tan: Math.tan(lean) });
  }

  const pillowGeom = (seed: number): THREE.BufferGeometry => {
    const hw = PILLOW / 2;
    const off = rng() * 10;
    const fn: Deform = (p, n) => {
      const px = p.x / hw;
      const py = p.y / hw;
      // knife-edge taper toward the seams, pointed corners...
      const s = 0.1 + 0.9 * Math.sqrt(Math.max(0, (1 - Math.pow(Math.abs(px), 6)) * (1 - Math.pow(Math.abs(py), 6))));
      // ...over a fat dome, so the face is never a dead plane
      p.z *= s * (1 + 0.44 * (1 - px * px) * (1 - py * py));
      // corners poke out, the seams draw in a little between them
      p.x *= 1 + 0.055 * Math.pow(Math.abs(py), 8) - 0.028 * Math.pow(1 - py * py, 2);
      p.y *= 1 + 0.055 * Math.pow(Math.abs(px), 8) - 0.028 * Math.pow(1 - px * px, 2);
      // the seam wanders, so no silhouette edge is ever a straight line
      const rim = 1 - Math.min(1, Math.abs(n.z));
      const rl = Math.hypot(p.x, p.y) || 1;
      const wob =
        (0.015 * fbm(p.x * 2.6 + off, p.y * 2.6 + off * 0.7, 2, seed + 3) + 0.0025 * fbm(p.x * 5.5 + off, p.y * 5.5, 2, seed + 11)) * rim;
      p.x += (p.x / rl) * wob;
      p.y += (p.y / rl) * wob;
      const wr = 0.004 * fbm(p.x * 7 + off, p.y * 7 + off * 0.3, 3, seed) * (0.4 + 0.6 * Math.abs(n.z));
      p.addScaledVector(n, wr * s);
    };
    const geo = deform(softBox(PILLOW, PILLOW, PILLOW_T, 0.03, [10, 10, 2], 3), fn);
    boxUV(geo, jit(0.3), jit(0.3));
    return geo;
  };
  const placePillow = (geo: THREE.BufferGeometry, x: number, lean: number, yaw: number, seatIdx: number, planeIdx: number): void => {
    const rot = new THREE.Euler(-lean, yaw, 0, 'YXZ');
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
    geo.computeBoundingBox();
    const ty = seatTop[seatIdx] - 0.016 - geo.boundingBox!.min.y;
    // slide back until the pillow just touches the leaning back cushion
    const plane = backPlanes[planeIdx];
    const pos = geo.attributes.position as THREE.BufferAttribute;
    let shift = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const planeZ = plane.z0 - (pos.getY(i) + ty - plane.y0) * plane.tan;
      shift = Math.max(shift, planeZ - pos.getZ(i));
    }
    geo.applyMatrix4(xf(x, ty, shift - 0.004));
  };
  const rust = pillowGeom(120);
  placePillow(rust, -0.69, 13 * DEG, -5 * DEG, 0, 0);
  rustParts.push(rust);
  const oat = pillowGeom(130);
  placePillow(oat, 0.6, 19 * DEG, 9 * DEG, 2, 2);
  oatParts.push(oat);

  {
    const a = ARM_W / 2;
    const ra = 0.05; // matches the arm's own top-edge roll
    const t = 0.02;
    const halfT = t / 2;
    const layers = [
      { lOut: 0.185, lIn: 0.085, w: 0.44, oTop: -0.004, oHang: 0.005, roll: 1.4 * DEG, yaw: -0.7 * DEG, dz: 0 },
      { lOut: 0.128, lIn: 0.056, w: 0.415, oTop: 0.016, oHang: 0.014, roll: -1.9 * DEG, yaw: 1.1 * DEG, dz: 0.021 },
      { lOut: 0.092, lIn: 0.04, w: 0.43, oTop: 0.036, oHang: 0.023, roll: 2.4 * DEG, yaw: 0.5 * DEG, dz: -0.015 },
    ];
    layers.forEach((L, k) => {
      const phase = rng() * Math.PI * 2;
      const path = blanketPath(a, ra, L.oTop + jit(0.0012), L.oHang, L.lIn, L.lOut, -0.007);
      const geo = sweptSlab(path, halfT, L.w / 2, 8, 3);
      // knit never lies flat: it undulates across its whole run, the folds
      // deepen down the hangs and the hem stops being level
      deform(geo, (p) => {
        const ph = (2 * Math.PI * p.z) / L.w;
        const fold = 0.005 * Math.sin(1.7 * ph + phase) + 0.0022 * Math.sin(3.6 * ph + phase * 2.1);
        const s = p.x < 0 ? -1 : 1;
        const u = Math.min(1, Math.max(0, -p.y - ra) / 0.1);
        p.y += fold * (1 - 0.4 * u) + u * u * (0.013 * Math.sin(0.85 * ph + phase * 1.7 + 0.9) - 0.004);
        p.x += s * (0.004 + 0.008 * u * u) * Math.sin(1.35 * ph + phase + 0.4);
      });
      boxUV(geo, jit(0.3) + k * 0.11, jit(0.3));
      bake(geo, xf(0, 0, L.dz, 0, L.yaw, L.roll));
      bake(geo, xf(PLATFORM_W / 2 - ARM_W / 2 + ARM_FLARE, ARM_TOP, -0.012, 0, 1.2 * DEG, 0));
      sageParts.push(geo);
    });
  }

  const parts: Array<[THREE.BufferGeometry[], THREE.Material, string]> = [
    [shellParts, shellFab, 'shell'],
    [cushionParts, cushionFab, 'cushions'],
    [pipingParts, pipingFab, 'piping'],
    [oakParts, oak, 'legs'],
    [darkParts, dark, 'glides'],
    [rustParts, rustFab, 'pillowRust'],
    [oatParts, oatFab, 'pillowOat'],
    [sageParts, sageFab, 'throw'],
  ];
  for (const [list, mat, name] of parts) {
    g.add(mesh(merge(list), mat, undefined, { name: `sofa.${name}` }));
  }
  return g;
}
