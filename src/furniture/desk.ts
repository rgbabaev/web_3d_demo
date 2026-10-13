/** Modern computer work desk: oak top on a black steel loop frame, cable tray, drawer pedestal, felt mat. */
import * as THREE from 'three';
import { box, cylinder, extrudeOutline, mesh, mergeGeometries, roundedBox, tube } from '../core/geometry';
import { createRng, fbm } from '../core/noise';
import type { SceneContext } from '../core/types';

// Dimensions in metres.
const TOP_W = 1.6;
const TOP_D = 0.75;
const TOP_T = 0.03;
const TOP_Y = 0.74; // top surface
const UNDER_Y = TOP_Y - TOP_T; // 0.71, underside of the top

const TUBE = 0.04; // 40 × 40 mm steel tube
const TUBE_R = 0.003; // corner radius of the tube
const LEG_X = TOP_W / 2 - 0.1 - TUBE / 2; // leg centre plane, outer face inset 0.10 m
const LEG_HALF_Z = 0.29; // post centre; loop is 0.62 m deep outside
const PLATE_T = 0.006;
const PLATE_Y = UNDER_Y - PLATE_T / 2 - 0.0005; // mounting plate under the top
const TOP_BAR_Y = UNDER_Y - PLATE_T - 0.0005 - TUBE / 2; // 0.6835
const BOTTOM_BAR_Y = 0.04; // 20 mm clearance under the bottom bar for the feet

const TRAY_W = 0.6;
const TRAY_H = 0.08;
const TRAY_D = 0.12;
const TRAY_X = 0.15;
const TRAY_Z = -0.29; // centred under the back stretcher
const TRAY_TOP = TOP_BAR_Y - TUBE / 2 - 0.015; // 15 mm gap under the stretcher
const TRAY_BOTTOM = TRAY_TOP - TRAY_H;
const HOLE_TILE = 0.064; // one perforation tile = 8 × 8 holes at 8 mm pitch

const PED_W = 0.4;
const PED_D = 0.5;
const PED_TOP = 0.6; // top of the separate top slab
const SLAB_T = 0.012;
const REVEAL = 0.002; // shadow gap between the slab and the case
const CASE_TOP = PED_TOP - SLAB_T - REVEAL; // 0.586
const PED_BODY_BOTTOM = 0.06; // casters underneath
const PLINTH_H = 0.062; // recessed toe plinth
const PLINTH_INSET = 0.015;
const CASE_BOTTOM = PED_BODY_BOTTOM + PLINTH_H; // 0.122
const PED_X = -0.44; // 20 mm clear of the left leg post
const PED_Z = TOP_D / 2 - PED_D / 2; // front flush with the desk front
const FRONT_T = 0.018;
const PULL_GAP = 0.02; // finger-pull gap above each drawer front
const BACK_T = 0.004; // inset back panel
const FRONT_U = 0.33; // where the fronts are cut out of the oak tile; both stay inside u,v < 1
const FRONT_V = 0.3;
// Stretched across the grain: the tile's 21 mm rings would otherwise corrugate a 0.4 m front.
const FRONT_STRETCH = 2.4;

const MAT_W = 0.9;
const MAT_D = 0.4;
const MAT_T = 0.003;

function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  return g;
}

/** Merge geometries that share a material into one draw call (handles indexed/non-indexed mix). */
function unify(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('desk: mergeGeometries failed (incompatible attributes)');
  for (const p of parts) p.dispose();
  for (const g of geoms) g.dispose();
  return merged;
}

function scaleUv(g: THREE.BufferGeometry, su: number, sv: number): THREE.BufferGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return g;
}

/** Unwrap a board (grain along +X) at one UV unit per metre; RoundedBoxGeometry's per-face 0..1 squares would crush a metre of grain into a 30 mm edge. */
function boardUv(g: THREE.BufferGeometry, w: number, t: number, d: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const hw = w / 2;
  const ht = t / 2;
  const hd = d / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i);
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) {
      // end cut: grain runs across the thickness, growth rings along the depth
      u = y + ht + (nx > 0 ? 0.31 : 0.6);
      v = nx > 0 ? z + hd : hd - z;
    } else if (ay >= az) {
      u = x + hw;
      v = ny > 0 ? z + hd : t + z + hd;
    } else {
      u = x + hw;
      v = nz > 0 ? d + ht - y : ht - y;
    }
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return g;
}

/** Planar UVs in metres (dominant normal axis), so a texture keeps its scale on every face. */
function panelUv(g: THREE.BufferGeometry, metresPerUnit: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const k = 1 / metresPerUnit;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    if (ax >= ay && ax >= az) uv.setXY(i, z * k, y * k);
    else if (ay >= az) uv.setXY(i, x * k, z * k);
    else uv.setXY(i, x * k, y * k);
  }
  uv.needsUpdate = true;
  return g;
}

/** A flat perforated panel with UVs in real metres (1 UV unit = one hole tile). */
function perforatedPanel(w: number, h: number): THREE.BufferGeometry {
  return scaleUv(new THREE.PlaneGeometry(w, h), w / HOLE_TILE, h / HOLE_TILE);
}

/** Rounded-rectangle outline in the XY plane, centred, counter-clockwise. */
function roundedRect(w: number, h: number, r: number, cornerSegments = 6): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const corners: Array<[number, number, number]> = [
    [hw, -hh, -Math.PI / 2],
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= cornerSegments; i++) {
      const a = a0 + (i / cornerSegments) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

export function create(ctx: SceneContext): THREE.Group {
  const g = new THREE.Group();
  g.name = 'desk';
  const rng = createRng(ctx.seed + 101);
  const jit = (amount: number): number => (rng() - 0.5) * 2 * amount;

  const M = ctx.materials;
  // The oak normal map is 512 px/m, which combs the 30 mm edges into ribs; a varnished board reads as tone.
  const oakBoard = M.wood('oak', { surface: [1, 1] }).clone();
  oakBoard.normalScale.set(0.09, 0.09);
  // Powder coat is paint: rough, but with enough specular left for the tube's corners to catch a rim highlight.
  const powderCoat = M.custom({
    color: 0x141416,
    metalness: 0.08,
    roughness: 0.62,
    specularIntensity: 0.4,
    envMapIntensity: 0.7,
  });
  const rubberFeet = M.rubber(0x222224);
  const cableJacket = M.plastic(0x141416, 0.4);
  const lockMetal = M.metal('gunmetal');
  const slotDark = M.rubber(0x0e0e10);

  // The 0.3 m weave minifies away at room distance, so a mat-wide roughness mottle gives back the surface.
  const feltMottle = ctx.textures.canvas(
    'desk:feltMottle',
    128,
    128,
    (c, w, h) => {
      const img = c.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const value = 176 + (fbm((x / w) * 5, (y / h) * 2.2, 3, 613) * 0.5 + 0.5) * 60;
          const i4 = (y * w + x) * 4;
          img.data[i4] = value;
          img.data[i4 + 1] = value;
          img.data[i4 + 2] = value;
          img.data[i4 + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    },
    false,
  );
  const felt = M.fabric(0x3a3a3c, { scale: 2, surface: [MAT_W, MAT_D] }).clone();
  felt.roughnessMap = feltMottle;
  felt.roughness = 1;

  // Fine speckle + orange peel, so the pedestal's big flat panels never crush to a single value.
  const coatTex = ctx.textures.canvas('desk:powdercoat', 256, 256, (c, w, h) => {
    const prng = createRng(9241);
    const blocks = 64;
    const cells = new Float32Array(blocks * blocks);
    for (let i = 0; i < cells.length; i++) cells[i] = prng();
    const img = c.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = cells[((y >> 2) % blocks) * blocks + ((x >> 2) % blocks)];
        const value = 212 + cell * 26 + prng() * 16;
        const i4 = (y * w + x) * 4;
        img.data[i4] = value;
        img.data[i4 + 1] = value;
        img.data[i4 + 2] = value;
        img.data[i4 + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  });
  coatTex.wrapS = THREE.RepeatWrapping;
  coatTex.wrapT = THREE.RepeatWrapping;
  coatTex.needsUpdate = true;
  const coatNormal = ctx.textures.plaster().normalMap?.clone();
  if (coatNormal) {
    coatNormal.wrapS = THREE.RepeatWrapping;
    coatNormal.wrapT = THREE.RepeatWrapping;
    coatNormal.repeat.set(4, 4); // ≈ 60 mm per repeat at the UV scale below → fine orange peel
    coatNormal.needsUpdate = true;
  }
  const COAT_UV = 0.25; // metres per UV unit on the pedestal
  const carcass = M.custom({
    // Warm grey, not blue, and envMapIntensity under ~1.3: the probe is a cold sky that would set the hue.
    color: 0x7c7a76,
    metalness: 0.15,
    roughness: 0.52,
    specularIntensity: 0.8,
    map: coatTex,
    normalMap: coatNormal ?? null,
    normalScale: new THREE.Vector2(0.12, 0.12),
    envMapIntensity: 1.2,
  });

  const topGeom = boardUv(roundedBox(TOP_W, TOP_T, TOP_D, 0.004, 3), TOP_W, TOP_T, TOP_D);
  g.add(mesh(topGeom, oakBoard, [0, TOP_Y - TOP_T / 2, 0], { name: 'top' }));

  const steelParts: THREE.BufferGeometry[] = [];
  const rubberParts: THREE.BufferGeometry[] = [];

  const postTop = TOP_BAR_Y + TUBE / 2;
  const postBottom = BOTTOM_BAR_Y - TUBE / 2;
  const postH = postTop - postBottom;
  const barLen = LEG_HALF_Z * 2 - TUBE + 0.004; // between the posts, 2 mm overlap each end

  for (const sx of [-1, 1]) {
    const x = sx * LEG_X;
    // two vertical posts
    for (const sz of [-1, 1]) {
      const z = sz * LEG_HALF_Z;
      steelParts.push(at(roundedBox(TUBE, postH, TUBE, TUBE_R, 2), x, postBottom + postH / 2, z));
      // levelling foot: rubber pad on the floor + threaded stud up into the bar
      rubberParts.push(at(cylinder(0.016, 0.017, 0.01, 24), x, 0.005, z));
      steelParts.push(at(cylinder(0.0065, 0.0065, 0.014, 16), x, 0.01 + 0.007, z));
    }
    // top and bottom horizontals closing the loop
    steelParts.push(at(roundedBox(TUBE, TUBE, barLen, TUBE_R, 2), x, TOP_BAR_Y, 0));
    steelParts.push(at(roundedBox(TUBE, TUBE, barLen, TUBE_R, 2), x, BOTTOM_BAR_Y, 0));
    // mounting plate between the loop and the top
    steelParts.push(at(roundedBox(0.1, PLATE_T, LEG_HALF_Z * 2 + 0.06, 0.001, 1), x, PLATE_Y, 0));
  }
  // back stretcher between the legs, directly under the top
  const stretcherLen = LEG_X * 2 - TUBE + 0.004;
  steelParts.push(at(roundedBox(stretcherLen, TUBE, TUBE, TUBE_R, 2), 0, TOP_BAR_Y, -LEG_HALF_Z));

  // cable tray rim (solid folded lip on top of the perforated walls) and hanging straps
  const rimY = TRAY_TOP - 0.003;
  const rimT = 0.006;
  const tx0 = TRAY_X - TRAY_W / 2;
  const tx1 = TRAY_X + TRAY_W / 2;
  const tz0 = TRAY_Z - TRAY_D / 2;
  const tz1 = TRAY_Z + TRAY_D / 2;
  steelParts.push(at(box(TRAY_W + rimT, rimT, rimT), TRAY_X, rimY, tz0));
  steelParts.push(at(box(TRAY_W + rimT, rimT, rimT), TRAY_X, rimY, tz1));
  steelParts.push(at(box(rimT, rimT, TRAY_D + rimT), tx0, rimY, TRAY_Z));
  steelParts.push(at(box(rimT, rimT, TRAY_D + rimT), tx1, rimY, TRAY_Z));
  const strapH = UNDER_Y - TRAY_BOTTOM;
  for (const sx of [-1, 1]) {
    const x = TRAY_X + sx * 0.22;
    steelParts.push(at(box(0.02, strapH, 0.003), x, TRAY_BOTTOM + strapH / 2, tz0 - 0.0015));
    steelParts.push(at(box(0.02, strapH, 0.003), x, TRAY_BOTTOM + strapH / 2, tz1 + 0.0015));
  }

  const holes = ctx.textures.canvas(
    'desk:perforation',
    256,
    256,
    (c, w, h) => {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#000000';
      const n = 8;
      const pitch = w / n;
      const r = pitch * 0.3;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          c.beginPath();
          c.arc((i + 0.5) * pitch, (j + 0.5) * pitch, r, 0, Math.PI * 2);
          c.fill();
        }
      }
    },
    false,
  );
  holes.wrapS = THREE.RepeatWrapping;
  holes.wrapT = THREE.RepeatWrapping;
  holes.needsUpdate = true;
  // The 8 mm pitch is sub-pixel at room distance, so the read has to come from tone, not from holes.
  const perforated = M.custom({
    color: 0x3a3a3e,
    metalness: 0.15,
    roughness: 0.6,
    specularIntensity: 0.45,
    envMapIntensity: 1.0,
    alphaMap: holes,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  const trayMidY = TRAY_BOTTOM + TRAY_H / 2;
  const trayWalls = unify([
    at(perforatedPanel(TRAY_W, TRAY_D).rotateX(-Math.PI / 2), TRAY_X, TRAY_BOTTOM, TRAY_Z),
    at(perforatedPanel(TRAY_W, TRAY_H), TRAY_X, trayMidY, tz1),
    at(perforatedPanel(TRAY_W, TRAY_H).rotateY(Math.PI), TRAY_X, trayMidY, tz0),
    at(perforatedPanel(TRAY_D, TRAY_H).rotateY(Math.PI / 2), tx1, trayMidY, TRAY_Z),
    at(perforatedPanel(TRAY_D, TRAY_H).rotateY(-Math.PI / 2), tx0, trayMidY, TRAY_Z),
  ]);
  g.add(mesh(trayWalls, perforated, undefined, { name: 'cableTray' }));

  const inTray = TRAY_BOTTOM + 0.03;
  const overRim = TRAY_TOP + 0.006;
  // The desk stands against a wall: nothing may sit further back than ~40 mm behind the top's back edge.
  const leadR = 0.0035;
  const lead = tube(
    [
      v3(tx1 - 0.1, inTray, TRAY_Z),
      v3(tx1 - 0.04, inTray + 0.015, tz0 + 0.02),
      v3(tx1 - 0.01, overRim, tz0 - 0.008),
      v3(tx1 + 0.012 + jit(0.006), 0.55, tz0 - 0.026),
      v3(tx1 + 0.045 + jit(0.006), 0.34, tz0 - 0.044), // belly of the catenary
      v3(tx1 + 0.055, 0.16, tz0 - 0.038),
      v3(tx1 + 0.058, 0.04, tz0 - 0.032),
      v3(tx1 + 0.06, leadR, tz0 - 0.04), // touches down
      v3(tx1 + 0.038, leadR, tz0 + 0.014),
      v3(tx1 - 0.022, leadR, tz0 + 0.028), // loose half-coil of spare cable
      v3(tx1 - 0.07, leadR, tz0 - 0.012),
      v3(tx1 - 0.064, leadR, tz0 - 0.046),
      v3(tx1 - 0.14, leadR, tz0 - 0.052),
      v3(tx1 - 0.26, leadR, tz0 - 0.044),
      v3(0.0, leadR, tz0 - 0.05),
      v3(-0.3, leadR, tz0 - 0.046), // off along the wall
    ],
    leadR,
    8,
    72,
  );
  // the spline may still overshoot the floor by a hair between the last points — lift it out
  lead.computeBoundingBox();
  const leadDip = -(lead.boundingBox?.min.y ?? 0);
  if (leadDip > 0) lead.translate(0, leadDip, 0);

  /** A slack cable looping out of the tray front and back in again. */
  const slackLoop = (cx: number, radius: number, sag: number, skew: number): THREE.BufferGeometry =>
    tube(
      [
        v3(cx + 0.095, inTray, TRAY_Z - 0.02),
        v3(cx + 0.062, inTray + 0.03, tz1 - 0.02),
        v3(cx + 0.046, overRim, tz1 + 0.002),
        v3(cx + 0.03, TRAY_TOP - 0.06, tz1 + 0.02),
        v3(cx + 0.005, TRAY_TOP - sag, tz1 + 0.03 + skew),
        v3(cx - 0.035, TRAY_TOP - sag - 0.012, tz1 + 0.028 + skew * 0.5),
        v3(cx - 0.065, TRAY_TOP - 0.07, tz1 + 0.018),
        v3(cx - 0.077, overRim, tz1 + 0.002),
        v3(cx - 0.088, inTray + 0.03, tz1 - 0.025),
        v3(cx - 0.103, inTray, TRAY_Z - 0.01),
      ],
      radius,
      8,
      64,
    );
  const loopThin = slackLoop(TRAY_X - 0.14 + jit(0.015), 0.0025, 0.155 + jit(0.02), jit(0.008));
  const loopFat = slackLoop(TRAY_X + 0.17 + jit(0.015), 0.004, 0.105 + jit(0.02), jit(0.008));
  g.add(mesh(unify([lead, loopThin, loopFat]), cableJacket, undefined, { name: 'cables' }));

  const ped = new THREE.Group();
  ped.name = 'pedestal';
  ped.position.set(PED_X + jit(0.005), 0, PED_Z);
  ped.rotation.y = THREE.MathUtils.degToRad(jit(0.9));
  {
    const bodyH = CASE_TOP - CASE_BOTTOM;
    const bodyD = PED_D - FRONT_T; // overlay fronts sit in front of the carcass
    const frontZ = PED_D / 2; // pedestal front plane (local)
    const carcassZ = frontZ - FRONT_T - bodyD / 2;
    const backZ = carcassZ - bodyD / 2;

    // 10 mm folded corners, as on a real sheet-steel case, so the silhouette edges catch a rim highlight.
    const caseParts: THREE.BufferGeometry[] = [
      at(roundedBox(PED_W, bodyH, bodyD - BACK_T, 0.01, 3), 0, CASE_BOTTOM + bodyH / 2, carcassZ + BACK_T / 2),
      at(roundedBox(PED_W - 0.02, bodyH - 0.02, BACK_T, 0.002, 1), 0, CASE_BOTTOM + bodyH / 2, backZ + BACK_T / 2),
      // top slab: 3 mm proud of the sides and back, flush with the drawer fronts
      at(roundedBox(PED_W + 0.006, SLAB_T, PED_D + 0.003, 0.005, 2), 0, PED_TOP - SLAB_T / 2, -0.0015),
      at(
        roundedBox(PED_W - 2 * PLINTH_INSET, PLINTH_H, bodyD - 2 * PLINTH_INSET, 0.004, 1),
        0,
        PED_BODY_BOTTOM + PLINTH_H / 2,
        carcassZ,
      ),
    ];
    ped.add(mesh(panelUv(unify(caseParts), COAT_UV), carcass, undefined, { name: 'carcass' }));

    // Overlay fronts, the grain running on from the upper to the lower as on a sequenced board.
    const frontW = PED_W - 0.004;
    const top1 = CASE_TOP - PULL_GAP; // 0.566
    const bot1 = 0.42;
    const top2 = bot1 - PULL_GAP;
    const bot2 = CASE_BOTTOM + 0.004;
    const h1 = top1 - bot1;
    const h2 = top2 - bot2;
    const fz = frontZ - FRONT_T / 2;
    const frontGeom = (w: number, h: number, ov: number): THREE.BufferGeometry => {
      const b = boardUv(roundedBox(w, FRONT_T, h, 0.003, 2), w, FRONT_T, h);
      const uv = b.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + FRONT_U, uv.getY(i) / FRONT_STRETCH + ov);
      uv.needsUpdate = true;
      b.rotateX(Math.PI / 2); // lay the board up as a front panel, UVs unaffected
      return b;
    };
    ped.add(
      mesh(
        unify([
          at(frontGeom(frontW, h1, FRONT_V), 0, (top1 + bot1) / 2, fz),
          at(frontGeom(frontW, h2, FRONT_V + (h1 + PULL_GAP) / FRONT_STRETCH), 0, (top2 + bot2) / 2, fz),
        ]),
        oakBoard,
        undefined,
        { name: 'drawerFronts' },
      ),
    );

    // The recess behind the pull gaps, clamped to the case top, the reveal under the slab, the keyway.
    const recessZ = frontZ - FRONT_T + 0.001;
    const gap1Top = CASE_TOP;
    const gap1Bottom = top1 - 0.003;
    const lockY = top1 - 0.038;
    const lockX = PED_W / 2 - 0.05;
    const darkParts: THREE.BufferGeometry[] = [
      at(box(frontW, gap1Top - gap1Bottom, 0.002), 0, (gap1Top + gap1Bottom) / 2, recessZ),
      at(box(frontW, PULL_GAP + 0.006, 0.002), 0, top2 + PULL_GAP / 2, recessZ),
      at(box(PED_W - 0.016, REVEAL + 0.002, PED_D - 0.04), 0, CASE_TOP + REVEAL / 2, carcassZ),
      at(box(0.003, 0.011, 0.004), lockX, lockY, frontZ + 0.0013), // keyway
    ];
    ped.add(mesh(unify(darkParts), slotDark, undefined, { name: 'pullRecess' }));

    // keyed cam lock near the top-right of the upper drawer front: bezel + barrel
    ped.add(
      mesh(
        unify([
          at(cylinder(0.009, 0.009, 0.0015, 24).rotateX(Math.PI / 2), lockX, lockY, frontZ + 0.0005),
          at(cylinder(0.0072, 0.0072, 0.004, 24).rotateX(Math.PI / 2), lockX, lockY, frontZ + 0.001),
        ]),
        lockMetal,
        undefined,
        { name: 'lock' },
      ),
    );

    // four twin-wheel casters, wheels trailing 12 mm behind the swivel stem
    const wheelR = 0.022;
    const casterSteel: THREE.BufferGeometry[] = [];
    const wheels: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = sx * (PED_W / 2 - 0.05);
        const cz = sz * (PED_D / 2 - 0.05);
        const yaw = jit(Math.PI / 5); // casters point wherever they were last rolled
        const trail = v3(-Math.sin(yaw) * 0.012, 0, -Math.cos(yaw) * 0.012);
        const wz = cz + trail.z;
        const wx = cx + trail.x;
        for (const side of [-1, 1]) {
          const w = cylinder(wheelR, wheelR, 0.016, 24).rotateZ(Math.PI / 2);
          w.rotateY(yaw);
          const off = v3(side * 0.016, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          wheels.push(at(w, wx + off.x, wheelR, wz + off.z));
        }
        const housing = box(0.014, 0.034, 0.04).rotateY(yaw);
        casterSteel.push(at(housing, wx, wheelR + 0.015, wz));
        casterSteel.push(at(cylinder(0.006, 0.006, 0.02, 12), cx, PED_BODY_BOTTOM - 0.004, cz));
      }
    }
    ped.add(mesh(unify(casterSteel), powderCoat, undefined, { name: 'casters' }));
    ped.add(mesh(unify(wheels), rubberFeet, undefined, { name: 'casterWheels' }));
  }
  g.add(ped);

  g.add(mesh(unify(steelParts), powderCoat, undefined, { name: 'frame' }));
  g.add(mesh(unify(rubberParts), rubberFeet, undefined, { name: 'feet' }));

  // 1 mm bevel top and bottom, so the extrusion comes out at the full 3 mm.
  const matBevel = 0.001;
  const matGeom = extrudeOutline(roundedRect(MAT_W - 2 * matBevel, MAT_D - 2 * matBevel, 0.012), MAT_T - 2 * matBevel, matBevel);
  matGeom.rotateX(-Math.PI / 2);
  matGeom.computeBoundingBox();
  matGeom.translate(0, TOP_Y + 0.0003 - (matGeom.boundingBox?.min.y ?? 0), 0);
  {
    const pos = matGeom.getAttribute('position') as THREE.BufferAttribute;
    const uv = matGeom.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / MAT_W + 0.5, pos.getZ(i) / MAT_D + 0.5);
    uv.needsUpdate = true;
  }
  const mat = mesh(matGeom, felt, [0.05, 0, 0.08], { name: 'deskMat' });
  mat.rotation.y = THREE.MathUtils.degToRad(0.6 + jit(0.4));
  g.add(mat);

  return g;
}
