/** 27" monitor on a clamped arm, with keyboard and mouse on the desk. */
import * as THREE from 'three';
import { box, cylinder, jitter, mergeGeometries, mesh, roundedBox, tube } from '../core/geometry';
import { createRng } from '../core/noise';
import type { SceneContext } from '../core/types';

// Mirrored from desk.ts.
const DESK_TOP = 0.74;
const DESK_BACK = -0.375;
const MAT_TOP = DESK_TOP + 0.0003 + 0.003; // felt mat surface
const MAT_BACK = -0.12; // mat's back edge (z)
// Cable tray under the back edge: x ∈ [-0.15, 0.45], z ∈ [-0.35, -0.23], rim y = 0.6485.

const UP = new THREE.Vector3(0, 1, 0);
const deg = THREE.MathUtils.degToRad;
const step = THREE.MathUtils.smoothstep;

type V3 = THREE.Vector3;
const v = (x: number, y: number, z: number): V3 => new THREE.Vector3(x, y, z);

/** Bake a rotation and translation into a geometry so it can be merged. */
function at(geom: THREE.BufferGeometry, pos: [number, number, number], rot?: THREE.Quaternion | THREE.Euler): THREE.BufferGeometry {
  if (rot) geom.applyQuaternion(rot instanceof THREE.Euler ? new THREE.Quaternion().setFromEuler(rot) : rot);
  geom.translate(pos[0], pos[1], pos[2]);
  return geom;
}

/** Build a geometry along +Y with the given length and re-orient it to span a → b. */
function along(build: (length: number) => THREE.BufferGeometry, a: V3, b: V3, overshoot = 0): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = dir.length() + overshoot;
  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return at(build(len), [mid.x, mid.y, mid.z], q);
}

/** Merge parts sharing a material into one draw call; RoundedBoxGeometry is non-indexed in r186 while the primitives are indexed, so every part is flattened first. */
function unify(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(flat, false);
  if (!g) throw new Error('monitor: mergeGeometries failed (incompatible attributes)');
  for (const p of flat) p.dispose();
  for (const p of parts) p.dispose();
  return g;
}

function merged(parts: THREE.BufferGeometry[], material: THREE.Material, name: string, cast = true): THREE.Mesh {
  return mesh(unify(parts), material, undefined, { name, cast });
}

/** Height a cable of radius r lies at, stepping off the mat's back edge; the desk yaws the mat ~1°, moving that edge ~8 mm, so the step is eased over 25 mm. */
function lieY(z: number, r: number): number {
  const t = step(z, MAT_BACK - 0.02, MAT_BACK + 0.005);
  return THREE.MathUtils.lerp(DESK_TOP, MAT_TOP, t) + r;
}

/** Prism on y = 0 whose section is the mouse's plan-form: an ellipse widened by `widen(zu)` so the ends come out blunt. */
function planPrism(rx: number, rz: number, h: number, widen: (zu: number) => number, segments = 48): THREE.BufferGeometry {
  const geom = cylinder(1, 1, 1, segments);
  const p = geom.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const zu = p.getZ(i);
    p.setXYZ(i, p.getX(i) * rx * widen(zu), (p.getY(i) + 0.5) * h, zu * rz);
  }
  geom.computeVertexNormals();
  return geom;
}

/** Keycap: a rounded slab whose top face is inset ~1.2 mm all round, so the flanks slope like a moulded cap's. */
function keycap(w: number, d: number, h: number, inset = 0.0012): THREE.BufferGeometry {
  const g = roundedBox(w, h, d, 0.0012, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = THREE.MathUtils.clamp(p.getY(i) / h + 0.5, 0, 1); // 0 at the base, 1 at the top
    p.setX(i, p.getX(i) * (1 - (2 * inset * t) / w));
    p.setZ(i, p.getZ(i) * (1 - (2 * inset * t) / d));
  }
  g.computeVertexNormals();
  return g;
}

/** sRGB hex scaled by `f`, as a canvas fill string. */
function tint(hex: number, f: number): string {
  const ch = (shift: number): number => Math.round(THREE.MathUtils.clamp(((hex >> shift) & 255) * f, 0, 255));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export function create(ctx: SceneContext): THREE.Group {
  const M = ctx.materials;
  const rng = createRng(ctx.seed + 41);
  const g = new THREE.Group();
  g.name = 'monitor';

  const PANEL_W = 0.615;
  const PANEL_H = 0.365;
  const BEZEL = 0.006;
  const CHIN = 0.014;
  const W = PANEL_W + 2 * BEZEL; // 0.627
  const H = PANEL_H + BEZEL + CHIN; // 0.385
  const PANEL_CY = 1.18;
  const Z_FACE = -0.22;

  const bezelMat = M.metal('blackMatte');
  // Bead-blasted: at the shared aluminium's metalness 1 and envMapIntensity 1 a flat plate clips to white.
  const alu = M.metal('aluminum').clone();
  alu.roughness = 0.55;
  alu.envMapIntensity = 0.3;
  const backMat = M.plastic(0x2a2a2c, 0.5);
  const darkMat = M.rubber(0x0f0f11);
  const trimMat = M.plastic(0x232326, 0.6);
  // Anti-glare IPS: genuinely diffuse, since a tight specular lobe turns a nearby light into a blob that erases the picture.
  const screenMat = M.screen('ide').clone();
  screenMat.roughness = 0.68;
  screenMat.clearcoat = 0.05;
  screenMat.clearcoatRoughness = 0.5;
  screenMat.envMapIntensity = 0.45;

  const monitor = new THREE.Group();
  monitor.name = 'panel';
  monitor.position.set(0, PANEL_CY, Z_FACE);
  monitor.rotation.order = 'YXZ';
  // Set by hand: a hint of backward tilt and not quite square to the desk.
  monitor.rotation.set(deg(-2), deg(-1.5), 0);
  g.add(monitor);

  // Local frame: panel centre at the origin, screen glass at z = 0 facing +Z.
  const bezelCy = -(CHIN - BEZEL) / 2; // chin is thicker than the top bezel
  const zBezelFront = -0.001;
  const bezelT = 0.007;
  monitor.add(mesh(roundedBox(W, H, bezelT, 0.002, 2), bezelMat, [0, bezelCy, zBezelFront - bezelT / 2], { name: 'bezel' }));

  const screen = mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), screenMat, [0, 0, 0], { cast: false, name: 'screen' });
  monitor.add(screen);

  // Satin aluminium band between bezel and back shell (visible from the side).
  const trimT = 0.003;
  const zTrimFront = zBezelFront - bezelT + 0.001;
  monitor.add(mesh(roundedBox(W - 0.006, H - 0.004, trimT, 0.001, 1), alu, [0, bezelCy, zTrimFront - trimT / 2], { name: 'trimBand' }));

  // The hump's bottom 32 mm steps 5 mm forward, so the ports sit in a real recess with a lip over them.
  const zShellFront = zTrimFront - trimT + 0.002;
  const shellT = 0.028;
  const humpT = 0.02;
  const zHumpBack = zShellFront - shellT - humpT + 0.004;
  const zShellBack = zShellFront - shellT;
  const HUMP_W = 0.36;
  const HUMP_H = 0.25;
  const HUMP_CY = 0.012;
  const PORT_H = 0.032;
  const PORT_CY = HUMP_CY - HUMP_H / 2 + PORT_H / 2;
  const RECESS = 0.005;
  const zPortFace = zHumpBack + RECESS;
  monitor.add(
    merged(
      [
        at(roundedBox(W - 0.012, H - 0.01, shellT, 0.01, 3), [0, bezelCy, zShellFront - shellT / 2]),
        at(roundedBox(HUMP_W, HUMP_H - PORT_H, humpT, 0.012, 3), [0, HUMP_CY + PORT_H / 2, zHumpBack + humpT / 2]),
        at(roundedBox(HUMP_W - 0.004, PORT_H, humpT - RECESS, 0.004, 2), [0, PORT_CY, zPortFace + (humpT - RECESS) / 2]),
      ],
      backMat,
      'backShell',
    ),
  );

  // Vent slots, the connector openings in the recess, the VESA screw heads, the moulding parting line.
  const vents: THREE.BufferGeometry[] = [];
  for (const cx of [-0.105, 0.105]) {
    for (let i = 0; i < 10; i++) vents.push(at(box(0.07, 0.0025, 0.0006), [cx, 0.05 + i * 0.006, zHumpBack - 0.0003]));
  }
  // [x, width, height] — AC inlet, spare DP, the two in use, USB-C, 2× USB-A.
  const portSlots: Array<[number, number, number]> = [
    [-0.072, 0.017, 0.0115],
    [-0.042, 0.016, 0.0075],
    [0.032, 0.016, 0.0075],
    [0.058, 0.016, 0.007],
    [0.082, 0.0095, 0.0042],
    [0.104, 0.013, 0.0058],
    [0.122, 0.013, 0.0058],
  ];
  for (const [px, pw, ph] of portSlots) vents.push(at(box(pw, ph, 0.0008), [px, PORT_CY, zPortFace - 0.0004]));
  const zVesaBack = zHumpBack - 0.0055;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      vents.push(at(cylinder(0.0035, 0.0035, 0.0026, 14), [sx * 0.05, sy * 0.05, zVesaBack - 0.0004], new THREE.Euler(Math.PI / 2, 0, 0)));
    }
  }
  vents.push(at(box(W - 0.06, 0.0013, 0.0014), [0, bezelCy - H / 2 + 0.045, zShellBack - 0.0007]));
  monitor.add(merged(vents, darkMat, 'vents'));

  // Two connector shells, plus the moulding step the hump sits on (a flat 0.6 m back reads as cardboard).
  const plugLocal = [v(0.032, PORT_CY, zHumpBack - 0.0015), v(0.058, PORT_CY, zHumpBack - 0.0015)];
  monitor.add(
    merged(
      [
        at(roundedBox(0.46, 0.3, 0.0028, 0.005, 2), [0, HUMP_CY, zShellBack]),
        ...plugLocal.map((p, i) => at(roundedBox(i === 0 ? 0.0145 : 0.0152, 0.009, 0.014, 0.0015, 1), [p.x, p.y, p.z])),
      ],
      trimMat,
      'backTrim',
    ),
  );

  // VESA plate: machined aluminium, so its 5.5 mm proud edge picks up a gradient.
  monitor.add(mesh(roundedBox(0.116, 0.116, 0.0055, 0.0025, 2), alu, [0, 0, zVesaBack + 0.00275], { name: 'vesa' }));

  // Chin details: an etched badge in the centre, power LED bottom right.
  const chinY = bezelCy - H / 2 + 0.007;
  const badgeMat = M.metal('aluminum').clone();
  badgeMat.color.set(0x45484d);
  badgeMat.roughness = 0.62;
  badgeMat.envMapIntensity = 0.35;
  monitor.add(mesh(roundedBox(0.024, 0.0045, 0.0008, 0.0004, 1), badgeMat, [0, chinY, zBezelFront + 0.0004], { name: 'badge' }));
  const ledMat = M.emissive(0xdfe9ff, 5, 0x1a1a1a);
  const led = mesh(cylinder(0.0012, 0.0012, 0.0012, 12), ledMat, [0.27, chinY, zBezelFront + 0.0004], { cast: false, name: 'led' });
  led.rotation.x = Math.PI / 2;
  monitor.add(led);
  ctx.lights.register({ name: 'monitorLed', role: 'screen', emissives: [ledMat] });

  // Three shadowless points across the panel, 0.67 m out: one point near the glass lights the panel itself.
  // 0.65 is under the guide's 10–20 band because that band assumes a lamp about a metre from its subject.
  [-0.21, 0, 0.21].forEach((lx, i) => {
    const glow = new THREE.PointLight(0xbcd0ff, 0.65, 2.6, 2);
    glow.position.set(lx, 1.16, 0.45);
    glow.castShadow = false;
    g.add(glow);
    ctx.lights.register({ name: `monitorScreen${i}`, role: 'screen', light: glow, emissives: i === 1 ? [screenMat] : undefined });
  });

  // World-space anchors that depend on the panel's tilt/yaw (g is at the origin while building).
  g.updateMatrixWorld(true);
  const plugWorld = plugLocal.map((p) => monitor.localToWorld(p.clone().add(v(0, 0, -0.0075))));
  const toWorld = (geom: THREE.BufferGeometry): THREE.BufferGeometry => geom.applyMatrix4(monitor.matrixWorld);

  // Both copies are toned down: the shared brushedSteel clips to white in direct sun on an 80 mm plate.
  const steel = M.metal('brushedSteel').clone();
  steel.color.set(0xb7bbc2);
  steel.envMapIntensity = 0.8;
  const clampMat = M.metal('brushedSteel').clone();
  clampMat.color.set(0x53565c);
  clampMat.roughnessMap = null;
  clampMat.roughness = 0.5;
  clampMat.envMapIntensity = 0.5;
  const postX = -0.21; // clear of the desk's cable tray (x ≥ -0.15)
  const postZ = DESK_BACK + 0.04;
  const plateH = 0.012;
  const postTop = 1.0;
  const J1 = v(postX, postTop - 0.005, postZ); // shoulder
  const J2 = v(0.1, postTop + 0.002, -0.44); // elbow, folded behind the desk edge
  // Head, in monitor-local space: tilt hinge just behind the VESA plate, swivel behind it.
  const hingeL = v(0, 0, zVesaBack - 0.0075);
  const swivelL = v(0, -0.012, zVesaBack - 0.027);
  const J3 = monitor.localToWorld(swivelL.clone());

  // clamp: top plate on the desk, bracket down the back edge, jaw underneath, screw
  const clampParts: THREE.BufferGeometry[] = [
    at(roundedBox(0.08, plateH, 0.09, 0.003, 2), [postX, DESK_TOP + plateH / 2, DESK_BACK + 0.045]),
    at(roundedBox(0.08, 0.075, 0.012, 0.002, 2), [postX, DESK_TOP + plateH - 0.0375 - 0.001, DESK_BACK - 0.006]),
    at(roundedBox(0.08, 0.012, 0.058, 0.002, 2), [postX, DESK_TOP - 0.062, DESK_BACK + 0.023]),
    at(cylinder(0.004, 0.004, 0.05, 12), [postX, DESK_TOP - 0.05, DESK_BACK + 0.036]),
  ];
  g.add(merged(clampParts, clampMat, 'clamp'));

  const steelParts: THREE.BufferGeometry[] = [
    // post + knuckles
    at(cylinder(0.017, 0.017, postTop - DESK_TOP - plateH, 32), [postX, (postTop + DESK_TOP + plateH) / 2, postZ]),
    at(cylinder(0.024, 0.024, 0.05, 32), [J1.x, J1.y, J1.z]),
    at(cylinder(0.024, 0.024, 0.05, 32), [J2.x, J2.y, J2.z]),
    // upper arm (horizontal) and gas-spring forearm rising to the head
    along((L) => roundedBox(0.04, L, 0.028, 0.006, 2), J1, J2),
    along((L) => roundedBox(0.03, L, 0.036, 0.006, 2), J2, J3),
    // head: swivel (world-vertical), bracket and tilt hinge (follow the panel)
    at(cylinder(0.015, 0.015, 0.07, 32), [J3.x, J3.y, J3.z]),
    toWorld(at(roundedBox(0.03, 0.05, 0.026, 0.004, 2), [hingeL.x, hingeL.y - 0.004, hingeL.z - 0.009])),
    toWorld(at(cylinder(0.012, 0.012, 0.06, 24), [hingeL.x, hingeL.y, hingeL.z], new THREE.Euler(0, 0, Math.PI / 2))),
  ];
  g.add(merged(steelParts, steel, 'arm'));

  const blackParts: THREE.BufferGeometry[] = [
    // knuckle end caps
    at(cylinder(0.0245, 0.0245, 0.004, 32), [J1.x, J1.y + 0.027, J1.z]),
    at(cylinder(0.0245, 0.0245, 0.004, 32), [J1.x, J1.y - 0.027, J1.z]),
    at(cylinder(0.0245, 0.0245, 0.004, 32), [J2.x, J2.y + 0.027, J2.z]),
    at(cylinder(0.0245, 0.0245, 0.004, 32), [J2.x, J2.y - 0.027, J2.z]),
    at(cylinder(0.0155, 0.0155, 0.004, 24), [J3.x, J3.y + 0.037, J3.z]),
    // clamp knob under the jaw
    at(cylinder(0.014, 0.012, 0.018, 24), [postX, DESK_TOP - 0.077, DESK_BACK + 0.036]),
    // post collar where it meets the clamp plate
    at(cylinder(0.021, 0.019, 0.008, 32), [postX, DESK_TOP + plateH + 0.004, postZ]),
  ];
  g.add(merged(blackParts, trimMat, 'armTrim'));
  // rubber pad of the clamp screw pressing on the underside of the 30 mm top
  g.add(mesh(cylinder(0.016, 0.016, 0.005, 24), M.rubber(0x1a1a1a), [postX, DESK_TOP - 0.0315, DESK_BACK + 0.036], { name: 'clampPad' }));

  // DisplayPort + USB-C, out of the port bay, over the desk's back edge and into the cable tray.
  // Glossy PVC (below 0.3 the library adds the clearcoat): a matte 5 mm tube draws as an ink line.
  const cableMat = M.plastic(0x202026, 0.29);
  const rA = 0.0025;
  const rB = 0.0022;
  const cableA = tube(
    [
      plugWorld[0],
      v(plugWorld[0].x, plugWorld[0].y - 0.02, plugWorld[0].z - 0.012),
      v(0.05, 0.98, -0.3),
      v(0.07, 0.87, -0.325),
      v(0.1, 0.78, -0.345),
      v(0.15, DESK_TOP + rA, -0.352),
      v(0.23, DESK_TOP + rA, -0.356),
      v(0.31, DESK_TOP + rA, -0.36),
      v(0.355, DESK_TOP - 0.004, -0.385),
      v(0.37, 0.7, -0.4),
      v(0.372, 0.668, -0.38),
      v(0.368, 0.658, -0.345),
      v(0.36, 0.62, -0.31),
      v(0.35, 0.59, -0.285),
    ],
    rA,
    10,
    64,
  );
  // The second lead clears the desk accessories' power cord, which crosses at x ≈ 0.01.
  const cableB = tube(
    [
      plugWorld[1],
      v(plugWorld[1].x + 0.004, plugWorld[1].y - 0.025, plugWorld[1].z - 0.014),
      v(0.082, 0.98, -0.31),
      v(0.072, 0.9, -0.322),
      v(0.058, 0.82, -0.336),
      v(0.045, DESK_TOP + rB + 0.01, -0.352),
      v(0.038, DESK_TOP + rB, -0.366),
      v(0.033, DESK_TOP - 0.004, -0.386),
      v(0.03, 0.7, -0.402),
      v(0.03, 0.668, -0.382),
      v(0.029, 0.658, -0.345),
      v(0.027, 0.615, -0.305),
      v(0.024, 0.59, -0.28),
    ],
    rB,
    10,
    64,
  );
  g.add(merged([cableA, cableB], cableMat, 'monitorCables'));

  const KB_W = 0.36;
  const KB_D = 0.13;
  const KB_H = 0.016;
  const PITCH = 0.01905;
  const PAD = 0.0015; // front rubber pads
  const TYPING_ANGLE = deg(3);
  const kbOuter = new THREE.Group(); // yaw + position, origin at the front bottom edge, on the mat
  kbOuter.name = 'keyboard';
  kbOuter.position.set(0.0, MAT_TOP, 0.15 + KB_D / 2);
  kbOuter.rotation.y = deg(4);
  g.add(kbOuter);
  const kb = new THREE.Group(); // typing-angle pitch about the front edge
  kb.rotation.x = TYPING_ANGLE;
  kbOuter.add(kb);

  const caseMat = M.metal('gunmetal');
  const plateMat = M.rubber(0x141416);
  const caseCenter: [number, number, number] = [0, PAD + KB_H / 2, -KB_D / 2];
  kb.add(mesh(roundedBox(KB_W, KB_H, KB_D, 0.004, 3), caseMat, caseCenter, { name: 'kbCase' }));
  const plateTop = PAD + KB_H + 0.001;
  kb.add(
    merged(
      [
        // dark switch plate showing between the keycaps
        at(box(KB_W - 0.008, 0.001, KB_D - 0.006), [0, plateTop - 0.0005, -KB_D / 2]),
        // USB-C socket recess on the back edge
        at(box(0.011, 0.0045, 0.002), [-0.1, PAD + KB_H / 2, -KB_D - 0.0005]),
      ],
      plateMat,
      'kbPlate',
    ),
  );

  // ANSI tenkeyless layout: [column start (u), width (u), modifier?] per row.
  type KeyDef = [number, number, boolean?];
  const rows: KeyDef[][] = [
    [[0, 1, true], [2, 1], [3, 1], [4, 1], [5, 1], [6.5, 1], [7.5, 1], [8.5, 1], [9.5, 1], [11, 1], [12, 1], [13, 1], [14, 1], [15.25, 1, true], [16.25, 1, true], [17.25, 1, true]],
    [...Array.from({ length: 13 }, (_, i): KeyDef => [i, 1]), [13, 2, true], [15.25, 1, true], [16.25, 1, true], [17.25, 1, true]],
    [[0, 1.5, true], ...Array.from({ length: 12 }, (_, i): KeyDef => [1.5 + i, 1]), [13.5, 1.5, true], [15.25, 1, true], [16.25, 1, true], [17.25, 1, true]],
    [[0, 1.75, true], ...Array.from({ length: 11 }, (_, i): KeyDef => [1.75 + i, 1]), [12.75, 2.25, true]],
    [[0, 2.25, true], ...Array.from({ length: 10 }, (_, i): KeyDef => [2.25 + i, 1]), [12.25, 2.75, true], [16.25, 1, true]],
    [[0, 1.25, true], [1.25, 1.25, true], [2.5, 1.25, true], [3.75, 6.25, true], [10, 1.25, true], [11.25, 1.25, true], [12.5, 1.25, true], [13.75, 1.25, true], [15.25, 1, true], [16.25, 1, true], [17.25, 1, true]],
  ];
  // Latin glyphs only: the headless canvas has no symbol font and a missing glyph draws as a tofu box.
  const legends: string[][] = [
    ['esc', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'prt', 'slk', 'brk'],
    ['~', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'bksp', 'ins', 'home', 'pgup'],
    ['tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\', 'del', 'end', 'pgdn'],
    ['caps', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'enter'],
    ['shift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'shift', '^'],
    ['ctrl', 'win', 'alt', '', 'alt', 'win', 'menu', 'ctrl', '<', 'v', '>'],
  ];
  const areaW = 18.25 * PITCH;
  const areaD = 6.5 * PITCH;
  const x0 = -areaW / 2;
  const z0 = -KB_D / 2 - areaD / 2;
  const CAP_H = 0.0042;
  const CAP_W = 0.0168; // base of the cap; the top is 2.4 mm narrower (see keycap)
  const CAP_D = 0.0164;
  const capY = plateTop + 0.0012 + CAP_H / 2;
  // Warm charcoal: against the window's 0xcfe1ff fill a neutral-blue ABS reads distinctly blue.
  const CAP_ALPHA = 0x302d2a;
  const CAP_MOD = 0x44413d;
  const CAP_ACCENT = 0xd8742c;

  // Rows pitched toward the home row (r = 3) and rising away from it; tiny, but it is what stops the caps
  // reading as a grid of identical slabs at 1–2 m.
  const rowTilt = [deg(2.6), deg(2.1), deg(1.1), deg(-0.2), deg(-1.5), deg(-2.5)];
  const rowRise = [0.0009, 0.0011, 0.0005, 0, 0.0003, 0.0007];

  const caps: Array<{ geom: THREE.BufferGeometry; fill: string; legend: string }> = [];
  rows.forEach((row, r) => {
    const rowOff = r === 0 ? 0 : r + 0.5; // the F-row sits 0.5u above the rest
    const z = z0 + (rowOff + 0.5) * PITCH;
    row.forEach(([col, u, mod], i) => {
      const x = x0 + (col + u / 2) * PITCH;
      const y = capY + rowRise[r] + jitter(rng, 0.00015);
      const rot = new THREE.Euler(rowTilt[r] + jitter(rng, deg(0.4)), 0, jitter(rng, deg(0.4)));
      const base = r === 0 && col === 0 ? CAP_ACCENT : mod ? CAP_MOD : CAP_ALPHA;
      caps.push({
        geom: at(keycap(u * PITCH - (PITCH - CAP_W), CAP_D, CAP_H), [x, y, z], rot),
        fill: tint(base, 1 + jitter(rng, 0.07)),
        legend: legends[r][i] ?? '',
      });
    });
  });

  // One atlas cell per cap carries its moulding colour and its legend, so the set stays one mesh.
  const ATLAS_COLS = 10;
  const atlasRows = Math.ceil(caps.length / ATLAS_COLS);
  const capAtlas = ctx.textures.canvas('monitor:keycaps', 1024, 1024, (c, w, h) => {
    const cw = w / ATLAS_COLS;
    const ch = h / atlasRows;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    caps.forEach((k, i) => {
      const cx = (i % ATLAS_COLS) * cw;
      const cy = Math.floor(i / ATLAS_COLS) * ch;
      c.fillStyle = k.fill;
      c.fillRect(cx, cy, cw, ch);
      if (!k.legend) return;
      const scale = k.legend.length > 2 ? 0.19 : k.legend.length > 1 ? 0.25 : 0.34;
      c.font = `600 ${Math.round(ch * scale)}px sans-serif`;
      c.fillStyle = k.legend.length > 1 ? '#8e8b86' : '#c6c2bb';
      c.fillText(k.legend, cx + cw * 0.5, cy + ch * 0.5);
    });
  });
  const capMat = M.plastic(0xffffff, 0.55).clone();
  capMat.map = capAtlas;
  kb.add(
    merged(
      caps.map((k, i) => {
        // RoundedBox faces run +X, -X, +Y, -Y, +Z, -Z: only the top one gets the legend.
        const uv = k.geom.attributes.uv as THREE.BufferAttribute;
        const perFace = uv.count / 6;
        const u0 = (i % ATLAS_COLS) / ATLAS_COLS;
        const v0 = 1 - (Math.floor(i / ATLAS_COLS) + 1) / atlasRows;
        for (let n = 0; n < uv.count; n++) {
          const top = n >= perFace * 2 && n < perFace * 3;
          const a = top ? 0.11 + uv.getX(n) * 0.78 : 0.5;
          const b = top ? 0.11 + uv.getY(n) * 0.78 : 0.17;
          uv.setXY(n, u0 + a / ATLAS_COLS, v0 + b / atlasRows);
        }
        return k.geom;
      }),
      capMat,
      'keycaps',
    ),
  );

  // Feet: rubber pads in front, flip-out feet (vertical, in the yawed frame) at the back.
  const rearLift = KB_D * Math.sin(TYPING_ANGLE) + PAD;
  const feet: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) feet.push(at(cylinder(0.006, 0.006, rearLift, 16), [sx * 0.16, rearLift / 2, -KB_D + 0.008]));
  kbOuter.add(merged(feet, plateMat, 'kbFeet'));
  const pads: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) pads.push(at(cylinder(0.005, 0.005, PAD, 16), [sx * 0.16, PAD / 2, -0.008]));
  kb.add(merged(pads, plateMat, 'kbPads'));

  // Coiled fabric cable: out of the USB-C port, a coil on the mat, then a run into the cable tray.
  g.updateMatrixWorld(true);
  const port = kb.localToWorld(v(-0.1, PAD + KB_H / 2, -KB_D));
  const kbCableR = 0.0021;
  const edgeCross = v(-0.06, lieY(DESK_BACK, kbCableR), DESK_BACK + 0.012);
  const axis = edgeCross.clone().sub(port).setY(0).normalize();
  const side = new THREE.Vector3().crossVectors(UP, axis).normalize();
  const coilR = 0.011;
  const coilPitch = 0.006; // a 4.2 mm cable: the turns nearly touch
  const coilTurns = 8;
  const kbCable: V3[] = [port.clone(), port.clone().add(axis.clone().multiplyScalar(0.02))];
  const coilStart = port.clone().add(axis.clone().multiplyScalar(0.05)).setY(MAT_TOP + coilR + kbCableR);
  kbCable.push(coilStart.clone().add(v(0, -coilR, 0)));
  const stepsPerTurn = 12;
  for (let i = 0; i <= coilTurns * stepsPerTurn; i++) {
    const t = (i / stepsPerTurn) * Math.PI * 2;
    const p = coilStart
      .clone()
      .add(axis.clone().multiplyScalar((t / (Math.PI * 2)) * coilPitch))
      .add(v(0, -Math.cos(t) * coilR, 0))
      .add(side.clone().multiplyScalar(Math.sin(t) * coilR));
    kbCable.push(p);
  }
  const coilEnd = kbCable[kbCable.length - 1];
  // Straight run: sample along the axis so the height can follow the mat edge.
  const runStart = coilEnd.clone().add(axis.clone().multiplyScalar(0.02));
  const runLen = edgeCross.clone().sub(runStart).setY(0).length();
  const runAt = (s: number): V3 => {
    const p = runStart.clone().add(axis.clone().multiplyScalar(s * runLen));
    p.add(side.clone().multiplyScalar(Math.sin(Math.PI * s) * 0.012)); // gentle bow
    p.y = lieY(p.z, kbCableR);
    return p;
  };
  const run = [0, 0.25, 0.5, 0.65, 0.8, 1].map(runAt);
  // extra samples either side of the mat's back edge so the step reads as a step
  for (const dz of [0.006, -0.008]) run.push(runAt((MAT_BACK + dz - runStart.z) / (edgeCross.z - runStart.z)));
  run.sort((a, b) => b.z - a.z); // front → back
  kbCable.push(...run);
  kbCable.push(
    v(-0.055, DESK_TOP - 0.004, DESK_BACK - 0.01),
    v(-0.05, 0.7, DESK_BACK - 0.025),
    v(-0.05, 0.668, DESK_BACK - 0.008),
    v(-0.052, 0.657, -0.345),
    v(-0.058, 0.62, -0.31),
    v(-0.065, 0.59, -0.285),
  );
  const kbCableGeom = tube(kbCable, kbCableR, 8, 300);
  // The shared fabric's sheen 0.6 and half-white sheen colour made the coil read as a pale blue spring.
  const kbCableMat = M.fabric(0x35353c, { surface: [0.013, 0.9] }).clone();
  kbCableMat.color.set(0x6a6a72);
  kbCableMat.sheen = 0.28;
  kbCableMat.sheenColor.set(0x6e6e76);
  g.add(mesh(kbCableGeom, kbCableMat, undefined, { name: 'kbCable' }));

  const mouse = new THREE.Group();
  mouse.name = 'mouse';
  mouse.position.set(0.33, MAT_TOP, 0.17);
  mouse.rotation.y = deg(-7);
  g.add(mouse);
  // 65 × 120 × 38 mm; the user is at +Z, so the palm hump is at +Z and the buttons and wheel at the −Z nose.
  const domeRX = 0.0325;
  const domeRY = 0.0305;
  const domeRZ = 0.06;
  const SKIRT_H = 0.0045;
  const domeY = SKIRT_H; // the shell's rim lands on top of the skirt
  const HUMP_K = 0.34; // dome asymmetry: puts the palm peak 17 mm toward the user
  const SECTION = 0.78; // squircle section: the flanks stand up, the top flattens
  const SEAM_Z = -0.009; // where the two buttons meet the palm rest
  const WHEEL_Z = -0.03;
  const WHEEL_R = 0.0085;
  /** Plan-form: an ellipse widened toward both ends (|zu|^p for zu²), the tail blunter than the nose. */
  const widen = (zu: number): number => {
    const p = zu > 0 ? 3.6 : 2.4;
    const e = 1 - zu * zu;
    return e > 1e-5 ? Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(zu), p)) / e) : Math.sqrt(p / 2);
  };
  /** Shell point at slice z and arch angle a (π/2 the top meridian, 0 and π the rim); both parting lines fall on grid lines. */
  const shellAt = (zu: number, a: number): V3 => {
    const m = Math.sqrt(Math.max(0, 1 - zu * zu));
    const k = widen(zu);
    const c = Math.cos(a);
    const sx = -Math.sign(c) * Math.pow(Math.abs(c), SECTION) * m;
    const sy = Math.pow(Math.max(Math.sin(a), 0), SECTION) * m;
    return v(sx * domeRX * k, sy * domeRY * (1 + HUMP_K * zu) * k + domeY, zu * domeRZ);
  };
  const shellTopAt = (zu: number): number => shellAt(zu, Math.PI / 2).y;

  const GAP_HW = 0.0012; // half width of the moulded gaps
  const GAP_D = 0.0011;
  const BTN_RISE = 0.0005; // the two buttons stand this much proud of the palm shell
  const WELL_HX = 0.0046; // scroll-wheel well
  const WELL_HZ = 0.0092;
  const WELL_D = 0.0032;
  /** How far the shell surface moves along its normal: the gaps and the wheel well. */
  const relief = (p: V3): number => {
    let gap = 1 - step(Math.abs(p.z - SEAM_Z), GAP_HW * 0.3, GAP_HW);
    if (p.z < SEAM_Z + GAP_HW) gap = Math.max(gap, 1 - step(Math.abs(p.x), GAP_HW * 0.3, GAP_HW));
    const dx = Math.abs(p.x) - WELL_HX;
    const dz = Math.abs(p.z - WHEEL_Z) - WELL_HZ;
    const out = Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
    const well = 1 - step(out, -0.0008, 0.0004);
    // The primary button has settled a little lower than its neighbour.
    const lean = THREE.MathUtils.lerp(1, 0.7, step(p.x, -0.001, 0.001));
    const rise = BTN_RISE * lean * step(SEAM_Z - p.z, 0.0005, 0.004) * step(p.z, -0.059, -0.05);
    return rise - Math.max(gap * GAP_D, well * WELL_D);
  };

  // A cosine spread for the blunt ends, plus rings 0.6–2.2 mm either side of every edge the relief resolves.
  const zRaw: number[] = [];
  for (let i = 0; i <= 18; i++) zRaw.push(-Math.cos((i / 18) * Math.PI));
  for (const zc of [SEAM_Z, WHEEL_Z - WELL_HZ, WHEEL_Z + WELL_HZ]) {
    for (const d of [-0.0022, -0.0013, -0.0006, 0, 0.0006, 0.0013, 0.0022]) zRaw.push((zc + d) / domeRZ);
  }
  zRaw.push(WHEEL_Z / domeRZ);
  zRaw.sort((p, q) => p - q);
  const zs = zRaw.filter((z, i) => i === 0 || z - zRaw[i - 1] > 1e-4);
  // Mirrored about the top meridian and crowding it: |x| ≈ β^0.78, so a few lines inside β = 0.04 cover the 1.2 mm gap wall.
  const beta = [0, 0.0025, 0.005, 0.0085, 0.013, 0.019, 0.027, 0.037, 0.05, 0.063, 0.075, 0.086, 0.096, 0.107, 0.12, 0.14, 0.17, 0.21, 0.27, 0.35, 0.45, 0.58, 0.74, 0.93, 1.14, 1.35, Math.PI / 2];
  const as = [...beta.slice(1).reverse().map((b) => Math.PI / 2 - b), ...beta.map((b) => Math.PI / 2 + b)];

  const nz = zs.length;
  const na = as.length;
  const base: V3[] = [];
  for (const zu of zs) for (const a of as) base.push(shellAt(zu, a));
  const pos = new Float32Array(nz * na * 3);
  const uvs = new Float32Array(nz * na * 2);
  const off = new THREE.Vector3();
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < na; j++) {
      const o = i * na + j;
      const p = base[o];
      const dz = base[Math.min(nz - 1, i + 1) * na + j].clone().sub(base[Math.max(0, i - 1) * na + j]);
      const da = base[i * na + Math.min(na - 1, j + 1)].clone().sub(base[i * na + Math.max(0, j - 1)]);
      off.crossVectors(dz, da); // outward: +Z × +X at the apex
      if (off.lengthSq() > 1e-16) off.normalize().multiplyScalar(relief(p));
      else off.set(0, 0, 0); // the two tips, where the slice collapses to a point
      pos[o * 3] = p.x + off.x;
      pos[o * 3 + 1] = p.y + off.y;
      pos[o * 3 + 2] = p.z + off.z;
      uvs[o * 2] = j / (na - 1);
      uvs[o * 2 + 1] = i / (nz - 1);
    }
  }
  const shellIndex: number[] = [];
  for (let i = 0; i < nz - 1; i++) {
    for (let j = 0; j < na - 1; j++) {
      const a0 = i * na + j;
      const b0 = a0 + na;
      shellIndex.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
    }
  }
  const shellGeom = new THREE.BufferGeometry();
  shellGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  shellGeom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  shellGeom.setIndex(shellIndex);
  shellGeom.computeVertexNormals();
  // Soft-touch ABS: at the library default a near-black shell samples pale putty in direct sun.
  const shellMat = M.plastic(0x211f1d, 0.6).clone();
  shellMat.envMapIntensity = 0.3;
  shellMat.specularIntensity = 0.45;
  mouse.add(mesh(shellGeom, shellMat, undefined, { name: 'mouseShell' }));

  // Skirt: the shell's plan-form inset 1.5 mm, so only a dark contact-shadow gap shows under the edge.
  const skirtMat = M.plastic(0x141416, 0.55);
  const dpiZ = -0.0155;
  mouse.add(
    merged(
      [
        at(planPrism(domeRX - 0.0015, domeRZ - 0.0015, SKIRT_H + 0.001, widen), [0, 0, 0]),
        // two thumb buttons on the left flank, forward where a thumb reaches
        at(roundedBox(0.005, 0.004, 0.012, 0.0015, 1), [-0.029, 0.0142, -0.0155], new THREE.Euler(0, 0, -0.45)),
        at(roundedBox(0.005, 0.004, 0.012, 0.0015, 1), [-0.029, 0.0142, -0.03], new THREE.Euler(0, 0, -0.45)),
        // DPI button plugging the gap between the two button shells
        at(roundedBox(0.0032, 0.0014, 0.0085, 0.0005, 1), [0, shellTopAt(dpiZ / domeRZ) + 0.0001, dpiZ]),
      ],
      skirtMat,
      'mouseBase',
    ),
  );
  // Knurled tread, sunk so ~4.5 mm shows above the well floor; a plain cylinder reads as a black pill.
  const wheelGeom = cylinder(WHEEL_R, WHEEL_R, 0.0062, 48);
  const wp = wheelGeom.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < wp.count; i++) {
    const f = 1 + 0.045 * Math.cos(12 * Math.atan2(wp.getZ(i), wp.getX(i)));
    wp.setXYZ(i, wp.getX(i) * f, wp.getY(i), wp.getZ(i) * f);
  }
  wheelGeom.computeVertexNormals();
  const wheel = mesh(wheelGeom, M.rubber(0x3a3a3f), [0, shellTopAt(WHEEL_Z / domeRZ) - WHEEL_R + 0.0018, WHEEL_Z], { name: 'wheel' });
  wheel.rotation.z = Math.PI / 2;
  mouse.add(wheel);

  return g;
}
