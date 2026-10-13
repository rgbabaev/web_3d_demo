import * as THREE from 'three';
import { box, cylinder, jitter, lathe, mergeGeometries, mesh, roundedBox, tube } from '../core/geometry';
import { createRng } from '../core/noise';
import type { SceneContext } from '../core/types';

const deg = THREE.MathUtils.degToRad;
const UP = new THREE.Vector3(0, 1, 0);
type V3 = THREE.Vector3;
const v = (x: number, y: number, z: number): V3 => new THREE.Vector3(x, y, z);

const W = 1.6; // overall width (the top)
const D = 0.42; // overall depth (the top)
const H = 0.48; // top surface height
const TOP_T = 0.02; // top thickness
const OVER = 0.01; // top overhang on every side
const TOP_Y0 = H - TOP_T; // 0.46
const CX = W / 2 - OVER; // 0.79  carcass half width
const CZF = D / 2 - OVER; // 0.20  carcass front plane
const CZB = -(D / 2 - OVER); // -0.20 carcass back plane
const LEG_H = 0.12;
const PT = 0.018; // carcass panel thickness
const BACK_T = 0.012;
const CASE_Y0 = LEG_H; // 0.12
const DECK_Y = CASE_Y0 + PT; // 0.138  inside floor of the carcass
const DIV_X0 = 0.254; // centre divider: left 2/3 doors, right 1/3 open bay
const IN_L = -CX + PT; // -0.772
const IN_R = CX - PT; // 0.772
const BAY_ZB = CZB + BACK_T; // -0.188

const VIS_W = 1.23;
const VIS_H = 0.71;
const BEZEL = 0.008;
const TV_W = VIS_W + 2 * BEZEL; // 1.246
const TV_H = VIS_H + 2 * BEZEL; // 0.726
const SCREEN_Z = 0.05; // world z of the glass
const TV_X = 0.025;
const TV_BOTTOM = H + 0.07; // 0.55
const TV_CY = TV_BOTTOM + TV_H / 2; // 0.913
const HUMP_CY = -0.13; // electronics hump, in TV-local y
const Z_HUMP = -0.0405; // back of the hump, in TV-local z (40 mm total)

/** Bake a rotation/translation into a geometry so it can be merged. */
function at(geom: THREE.BufferGeometry, pos: [number, number, number], rot?: THREE.Quaternion | THREE.Euler): THREE.BufferGeometry {
  if (rot) geom.applyQuaternion(rot instanceof THREE.Euler ? new THREE.Quaternion().setFromEuler(rot) : rot);
  geom.translate(pos[0], pos[1], pos[2]);
  return geom;
}

/** Rescale the four side faces to the span they really cover, so a 20 mm edge band is not given the same texture span as the 420 mm face. */
function slabUv(geom: THREE.BufferGeometry, w: number, t: number, d: number): THREE.BufferGeometry {
  const n = geom.attributes.normal;
  const uv = geom.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(n.getY(i)) > 0.5) continue;
    if (Math.abs(n.getX(i)) > 0.5) uv.setX(i, 0.5 + (uv.getX(i) - 0.5) * (d / w));
    uv.setY(i, 0.5 + (uv.getY(i) - 0.5) * (t / d));
  }
  uv.needsUpdate = true;
  return geom;
}

function bake(geom: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  geom.applyMatrix4(m);
  return geom;
}

/** Build a geometry along +Y of the given length and re-orient it to span a -> b. */
function along(build: (length: number) => THREE.BufferGeometry, a: V3, b: V3): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = dir.length();
  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return at(build(len), [mid.x, mid.y, mid.z], q);
}

/** RoundedBoxGeometry is non-indexed in r186 while Box/Cylinder/Lathe/Tube are indexed, so flatten before merging. */
function unify(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(flat, false);
  if (!g) throw new Error('tvConsole: mergeGeometries failed (incompatible attributes)');
  for (const p of flat) p.dispose();
  for (const p of parts) p.dispose();
  return g;
}

function merged(parts: THREE.BufferGeometry[], material: THREE.Material, name: string, cast = true): THREE.Mesh {
  return mesh(unify(parts), material, undefined, { name, cast });
}

export function create(ctx: SceneContext): THREE.Group {
  const M = ctx.materials;
  const rng = createRng(ctx.seed + 73);
  const g = new THREE.Group();
  g.name = 'tvConsole';

  // A third of core's walnut tile lands the growth rings at walnut's real 7 mm.
  // Isotropic: any ratio between the axes shears the figure flat.
  const GRAIN = 3;
  const veneer = (size: [number, number], offset: [number, number]): THREE.MeshPhysicalMaterial => {
    const m = M.wood('walnut', { surface: [size[0] * GRAIN, size[1] * GRAIN], offset }).clone();
    // Near zero: at veneer scale the growth rings are a colour, and any relief
    // at all turns them into reeding.
    m.normalScale.set(0.025, 0.025);
    m.clearcoat = 0.2;
    m.clearcoatRoughness = 0.55;
    return m;
  };
  // roughness 1.7, not <= 1: applySet pins roughness to 1 and lets the map carry
  // it, so the uniform is the only lever left.
  const matte = (m: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial => {
    m.normalScale.set(0.06, 0.06);
    m.clearcoat = 0;
    m.roughness = 1.7;
    m.specularIntensity = 0.2;
    m.needsUpdate = true;
    return m;
  };
  const matTop = matte(veneer([W, D], [0, 0]));
  const matDeck = matte(veneer([1.55, 0.4], [0.62, 0.41]));
  const matSide = veneer([D, 0.36], [0.31, 0.12]);
  // The doors are the one joint where a repeating ring pattern could line up
  // across the gap, so the two leaves are cut from opposite ends of the sheet.
  const matDoorL = veneer([0.52, 0.33], [0.07, 0.22]);
  const matDoorR = veneer([0.52, 0.33], [0.54, 0.63]);

  // Powder-coated black steel. Real powder coat is a satin, not a void: the
  // legs and the TV pedestal need enough gloss to catch a rim off the window,
  // otherwise they read as flat black sticks and the taper disappears.
  const steel = M.metal('blackMatte').clone();
  steel.color.set(0x26272b);
  steel.roughness = 0.33;
  steel.metalness = 0.95;
  steel.needsUpdate = true;
  // Same coat, but the pedestal's two upward-facing plates would mirror the sky
  // at that gloss and blow out to white on the console top.
  const steelFlat = steel.clone();
  steelFlat.color.set(0x1a1b1e);
  steelFlat.roughness = 0.68;
  steelFlat.needsUpdate = true;
  const gunmetal = M.metal('gunmetal');
  // The 8 mm bezel is only a couple of pixels wide at 1-2 m, so it only reads
  // as a frame if it is clearly lighter than the near-black glass it borders.
  // Untextured on purpose: a brushed map on a 10 mm edge face stipples.
  const bezelMetal = gunmetal.clone();
  bezelMetal.color.set(0x6e727a);
  bezelMetal.roughness = 0.3;
  bezelMetal.needsUpdate = true;
  const darkRubber = M.rubber(0x121214);
  const blackPlastic = M.plastic(0x232428, 0.55);

  g.add(mesh(slabUv(roundedBox(W, TOP_T, D, 0.0025, 2), W, TOP_T, D), matTop, [0, TOP_Y0 + TOP_T / 2, 0], { name: 'top' }));

  // Side panels + centre divider (grain running front-to-back).
  g.add(
    merged(
      [
        at(roundedBox(PT, H - LEG_H, D - 2 * OVER, 0.002, 2), [-CX + PT / 2, (CASE_Y0 + TOP_Y0) / 2, 0]),
        at(roundedBox(PT, H - LEG_H, D - 2 * OVER, 0.002, 2), [CX - PT / 2, (CASE_Y0 + TOP_Y0) / 2, 0]),
        at(roundedBox(PT, TOP_Y0 - DECK_Y, CZF - BAY_ZB, 0.002, 2), [DIV_X0 + PT / 2, (DECK_Y + TOP_Y0) / 2, (BAY_ZB + CZF) / 2]),
      ],
      matSide,
      'carcassSides',
    ),
  );
  // Bottom deck + back panel.
  g.add(
    merged(
      [
        at(roundedBox(IN_R - IN_L, PT, D - 2 * OVER, 0.002, 2), [0, CASE_Y0 + PT / 2, 0]),
        at(roundedBox(IN_R - IN_L, TOP_Y0 - DECK_Y, BACK_T, 0.0015, 1), [0, (DECK_Y + TOP_Y0) / 2, CZB + BACK_T / 2]),
      ],
      matDeck,
      'carcassDeck',
    ),
  );

  // Inset push-open pair: 2 mm reveal all round, 3 mm shadow gap in the middle,
  // face 2 mm behind the carcass front plane. No handles — you push them.
  const REVEAL = 0.002;
  const GAP = 0.003;
  const DOOR_T = 0.018;
  const doorW = (DIV_X0 - IN_L - 2 * REVEAL - GAP) / 2;
  const doorH = TOP_Y0 - DECK_Y - 2 * REVEAL;
  const doorCY = (DECK_Y + TOP_Y0) / 2;
  const doorCZ = CZF - 0.002 - DOOR_T / 2; // the 2 mm recess
  const doorGeom = (): THREE.BufferGeometry => roundedBox(doorW, doorH, DOOR_T, 0.0025, 2);

  const doorLeft = mesh(doorGeom(), matDoorL, [IN_L + REVEAL + doorW / 2, doorCY, doorCZ], { name: 'doorLeft' });
  doorLeft.rotation.y = deg(0.15);
  g.add(doorLeft);
  // The right door's push-latch has not quite caught: it stands 1.5 mm proud
  // and hangs a hair open, which opens the shadow gap toward the middle.
  const doorRight = mesh(doorGeom(), matDoorR, [DIV_X0 - REVEAL - doorW / 2, doorCY, doorCZ + 0.0015], { name: 'doorRight' });
  doorRight.rotation.y = deg(-0.5);
  g.add(doorRight);

  const legParts: THREE.BufferGeometry[] = [];
  const footParts: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const top = v(sx * 0.66, CASE_Y0 + 0.008, sz * 0.145);
      const bot = v(sx * 0.692 + jitter(rng, 0.0015), 0.006, sz * 0.163 + jitter(rng, 0.0015));
      legParts.push(along((L) => cylinder(0.015, 0.0095, L, 24), bot, top));
      // mounting plate screwed to the underside of the carcass floor
      legParts.push(at(roundedBox(0.056, 0.004, 0.056, 0.001, 1), [top.x, CASE_Y0 - 0.002, top.z]));
      footParts.push(at(cylinder(0.0118, 0.0118, 0.008, 16), [bot.x, 0.004, bot.z]));
    }
  }

  // The remote, dropped on the top on the way past. Keypad island and d-pad ring
  // in pale grey plastic: on a black body at 1-2 m a 0.5 mm step is invisible.
  const rmt = new THREE.Matrix4()
    .makeTranslation(-0.523, H, 0.112)
    .multiply(new THREE.Matrix4().makeRotationY(deg(24 + jitter(rng, 7))));
  footParts.push(
    bake(at(roundedBox(0.046, 0.017, 0.168, 0.008, 3), [0, 0.0085, 0]), rmt),
    bake(at(cylinder(0.0058, 0.0058, 0.005, 16), [0, 0.0192, 0.032]), rmt),
  );
  g.add(merged(footParts, M.rubber(0x1a1a1c), 'feetAndRemote'));
  g.add(
    merged(
      [
        at(roundedBox(0.034, 0.005, 0.092, 0.0022, 2), [0, 0.0175, -0.014]).applyMatrix4(rmt),
        at(cylinder(0.0142, 0.0142, 0.0045, 20), [0, 0.0185, 0.032]).applyMatrix4(rmt),
        at(roundedBox(0.0105, 0.0035, 0.0075, 0.0014, 1), [-0.0098, 0.0196, -0.031]).applyMatrix4(rmt),
        at(roundedBox(0.0105, 0.0035, 0.0075, 0.0014, 1), [0.0098, 0.0196, -0.031]).applyMatrix4(rmt),
      ],
      M.plastic(0x6f7278, 0.5),
      'remoteKeys',
    ),
  );

  // 0.30 x 0.06 x 0.28, on the open bay's floor, nudged a degree off square.
  const RW = 0.3;
  const RH = 0.06;
  const RD = 0.28;
  const FACE_Z = RD / 2 + 0.0015;
  const FACE_Y = 0.004 + RH / 2 - 0.002;
  const rm = new THREE.Matrix4()
    .makeTranslation(0.432, DECK_Y, 0.045)
    .multiply(new THREE.Matrix4().makeRotationY(deg(-1.6)));

  const recvBody: THREE.BufferGeometry[] = [
    at(roundedBox(RW, RH - 0.004, RD, 0.003, 2), [0, 0.004 + (RH - 0.004) / 2, 0]),
    // four short feet so it stands on the deck rather than sticking to it
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => at(cylinder(0.008, 0.008, 0.004, 12), [sx * 0.13, 0.002, sz * 0.12]))),
  ];
  g.add(mesh(bake(unify(recvBody), rm), M.plastic(0x1c1d20, 0.62), undefined, { name: 'receiverBody' }));

  // Brushed front panel, volume knob and input selector.
  const recvFace: THREE.BufferGeometry[] = [
    at(roundedBox(RW - 0.004, RH - 0.008, 0.004, 0.0012, 1), [0, FACE_Y, FACE_Z - 0.002]),
    at(cylinder(0.019, 0.019, 0.011, 24), [0.115, FACE_Y, FACE_Z + 0.004], new THREE.Euler(Math.PI / 2, 0, 0)),
    at(cylinder(0.011, 0.011, 0.009, 20), [-0.118, FACE_Y, FACE_Z + 0.003], new THREE.Euler(Math.PI / 2, 0, 0)),
  ];
  g.add(mesh(bake(unify(recvFace), rm), gunmetal, undefined, { name: 'receiverFace' }));

  // Display window, a row of small buttons, top vent slots.
  const recvDark: THREE.BufferGeometry[] = [
    at(box(0.1, 0.019, 0.0025), [-0.015, FACE_Y + 0.002, FACE_Z - 0.0002]),
    ...[0, 1, 2].map((i) => at(roundedBox(0.009, 0.005, 0.003, 0.001, 1), [0.05 + i * 0.015, FACE_Y - 0.018, FACE_Z + 0.0015])),
  ];
  for (let i = 0; i < 14; i++) recvDark.push(at(box(0.16, 0.0008, 0.0035), [0, RH + 0.0003, -0.1 + i * 0.0125]));
  g.add(mesh(bake(unify(recvDark), rm), darkRubber, undefined, { name: 'receiverDetail' }));

  // Standby LED. 1.8, not 5: a 3.6 mm emitter at 5 clips through the tone mapper
  // and the amber goes white.
  const ledMat = M.emissive(0xff8a3c, 1.8, 0x120a04);
  const led = at(cylinder(0.0018, 0.0018, 0.0025, 10), [-0.085, FACE_Y - 0.018, FACE_Z - 0.0005], new THREE.Euler(Math.PI / 2, 0, 0));
  g.add(mesh(bake(led, rm), ledMat, undefined, { name: 'standbyLed', cast: false }));
  ctx.lights.register({ name: 'tvReceiverStandby', role: 'screen', emissives: [ledMat] });

  // Cloth-bound hardbacks, spines out, leaning on the right-hand side panel.
  const pages: THREE.BufferGeometry[] = [];
  const foil: THREE.BufferGeometry[] = [];
  const makeBook = (bx: number, bh: number, bw: number, bd: number, lean: number, zc: number): THREE.BufferGeometry[] => {
    // A leaning book pivots on its lower outside edge, so lift it by half the
    // width times the lean or that edge sinks into the deck.
    const lift = (bw / 2) * Math.abs(Math.sin(lean));
    const m = new THREE.Matrix4().makeTranslation(bx, DECK_Y + lift, zc).multiply(new THREE.Matrix4().makeRotationZ(lean));
    const boardT = 0.0035;
    const spineT = 0.005;
    pages.push(bake(at(box(bw - 2 * boardT - 0.002, bh - 0.011, bd - 0.004), [0, bh / 2, -0.0025]), m.clone()));
    foil.push(bake(at(box(bw - 0.012, 0.0035, 0.0012), [0, bh * 0.73, bd / 2 + 0.0002]), m.clone()));
    foil.push(bake(at(box(bw - 0.015, 0.0022, 0.0012), [0, bh * 0.67, bd / 2 + 0.0002]), m.clone()));
    return [
      at(box(boardT, bh, bd), [-(bw - boardT) / 2, bh / 2, 0]),
      at(box(boardT, bh, bd), [(bw - boardT) / 2, bh / 2, 0]),
      at(roundedBox(bw, bh, spineT, 0.0018, 2), [0, bh / 2, bd / 2 - spineT / 2]),
    ].map((p) => bake(p, m));
  };
  // A leans on the bay's right-hand panel, 0.2 mm into the veneer — genuinely
  // touching. B leans on A's cover the same way.
  g.add(merged(makeBook(0.7353, 0.286, 0.04, 0.216, deg(-3.4), 0.052), M.fabric(0x2c4438, { surface: [0.22, 0.3] }), 'bookA'));
  g.add(merged(makeBook(0.6896, 0.264, 0.036, 0.2, deg(-5.1), 0.062), M.fabric(0x7a3a31, { surface: [0.22, 0.28] }), 'bookB'));
  g.add(merged(pages, M.paper(0xe9e1ce, { surface: [0.2, 0.3] }), 'bookPages'));
  g.add(merged(foil, M.metal('brass'), 'bookFoil'));

  const tv = new THREE.Group();
  tv.name = 'tv';
  tv.position.set(TV_X, TV_CY, SCREEN_Z);
  tv.rotation.y = deg(-1.4); // nobody ever leaves it square to the wall
  g.add(tv);

  // Drawn twice from the same seed so the two copies register: one is the
  // clearcoat's roughness, one a near-black albedo. Against a plain wall the
  // wipe marks only show at all because the dust in them scatters.
  const smears = (key: string, base: string, tint: string, srgb: boolean): THREE.CanvasTexture =>
    ctx.textures.canvas(
      key,
      512,
      288,
      (c, w, h) => {
        c.fillStyle = base;
        c.fillRect(0, 0, w, h);
        const r = createRng(ctx.seed + 907);
        for (let i = 0; i < 11; i++) {
          const x = r() * w;
          const y = r() * h;
          const rx = 34 + r() * 110;
          const ry = rx * (0.12 + r() * 0.3);
          const grad = c.createRadialGradient(x, y, 0, x, y, rx);
          grad.addColorStop(0, `rgba(${tint},0.95)`);
          grad.addColorStop(1, `rgba(${tint},0)`);
          c.save();
          c.translate(x, y);
          c.rotate((r() - 0.5) * 1.2);
          c.scale(1, ry / rx);
          c.translate(-x, -y);
          c.fillStyle = grad;
          c.beginPath();
          c.arc(x, y, rx, 0, Math.PI * 2);
          c.fill();
          c.restore();
        }
        const vg = c.createLinearGradient(0, 0, 0, h);
        vg.addColorStop(0, `rgba(${tint},0.6)`);
        vg.addColorStop(0.4, `rgba(${tint},0)`);
        vg.addColorStop(1, `rgba(${tint},0.42)`);
        c.fillStyle = vg;
        c.fillRect(0, 0, w, h);
      },
      srgb,
    );
  const smudge = smears('tvConsole:screenSmear', '#060606', '246,246,246', false);
  const dust = smears('tvConsole:screenDust', '#000000', '38,38,38', true);

  // An off panel emits nothing and carries no picture: near-black glass under a
  // tight clearcoat, so what it shows is the environment, moving with the camera.
  const screenMat = M.screen('off').clone();
  screenMat.emissiveMap = null;
  screenMat.emissiveIntensity = 0;
  screenMat.color.set(0xffffff); // the dust map is the albedo now, and it is near black
  screenMat.map = dust;
  screenMat.roughness = 0.1;
  screenMat.clearcoat = 1;
  // The smear map multiplies this, so the base has to carry the whole sweep:
  // 0.9 takes the clean glass to 0.05 and the wipe marks to 0.75.
  screenMat.clearcoatRoughness = 0.9;
  screenMat.clearcoatRoughnessMap = smudge; // cleaning smears, on the coat only
  // A real off panel sits near sRGB 30. At the room's own strength the probe
  // lifts it to mid-grey and 0.87 m² of it reads as card, not glass.
  screenMat.envMapIntensity = 0.5;
  screenMat.needsUpdate = true;

  // A 1.2 m panel is never dead flat; a 10 mm bow about the horizontal axis
  // sweeps the normal ±3.2°, which is the most a real one does.
  const BOW = 0.01;
  const panel = new THREE.PlaneGeometry(VIS_W, VIS_H, 40, 24);
  const panelPos = panel.attributes.position;
  for (let i = 0; i < panelPos.count; i++) {
    const t = panelPos.getY(i) / (VIS_H / 2);
    panelPos.setZ(i, BOW * (1 - t * t));
  }
  panel.computeVertexNormals();
  const screen = mesh(panel, screenMat, [0, 0, 0.0007], { cast: false, name: 'screen' });
  // The renderer overwrites envMapIntensity with scene.environmentIntensity on
  // any material that has no envMap of its own, so the panel has to adopt the
  // room probe itself or it cannot be dimmed below the room's full brightness.
  screen.onBeforeRender = (_r, sc) => {
    if (sc.environment && screenMat.envMap !== sc.environment) {
      screenMat.envMap = sc.environment;
      screenMat.needsUpdate = true;
    }
  };
  tv.add(screen);

  const BAY_X = -0.16;
  const BAY_Y = HUMP_CY - 0.055;

  // Bezel / front plate: 8 mm of satin metal around the glass. The four HDMI
  // shells ride along in it — in the back shell's own black they were a recess
  // with nothing in it.
  tv.add(
    merged(
      [
        at(roundedBox(TV_W, TV_H, 0.01, 0.0018, 2), [0, 0, -0.005]),
        // IR receiver + brand nub under the bottom edge
        at(roundedBox(0.046, 0.007, 0.008, 0.002, 1), [-0.02, -TV_H / 2 - 0.0015, -0.006]),
        ...[0, 1, 2, 3].map((i) => at(roundedBox(0.019, 0.009, 0.0022, 0.0006, 1), [-0.213 + i * 0.033, BAY_Y, Z_HUMP - 0.0012])),
      ],
      bezelMetal,
      'bezel',
    ),
  );

  // Back shell + electronics hump (40 mm total thickness at the hump), and the
  // 3 mm lip that turns the HDMI bay into a recess the sockets sit inside.
  tv.add(
    merged(
      [
        at(roundedBox(TV_W - 0.006, TV_H - 0.006, 0.012, 0.004, 2), [0, 0, -0.016]),
        at(roundedBox(0.66, 0.34, 0.02, 0.008, 2), [0, HUMP_CY, -0.03]),
        ...[-1, 1].map((s) => at(box(0.16, 0.005, 0.0046), [BAY_X, BAY_Y + s * 0.02, Z_HUMP - 0.0008])),
        ...[-1, 1].map((s) => at(box(0.005, 0.035, 0.0046), [BAY_X + s * 0.0775, BAY_Y, Z_HUMP - 0.0008])),
      ],
      blackPlastic,
      'tvBack',
    ),
  );

  // Vents across the top of the hump, the port bay floor with four socket
  // mouths sunk into it, and the mains plug moulded onto the power lead.
  const tvDark: THREE.BufferGeometry[] = [];
  for (const cx of [-0.18, 0.18]) {
    for (let i = 0; i < 9; i++) tvDark.push(at(box(0.15, 0.0028, 0.0008), [cx, HUMP_CY + 0.105 + i * 0.0072, Z_HUMP]));
  }
  tvDark.push(at(box(0.15, 0.035, 0.0012), [BAY_X, BAY_Y, Z_HUMP - 0.0004]));
  // The opening in each shell. Sits inside the bay lip, so what shows from the
  // back is four dark mouths in metal rims, not four lumps.
  for (let i = 0; i < 4; i++) tvDark.push(at(box(0.0148, 0.0054, 0.0006), [-0.213 + i * 0.033, BAY_Y, Z_HUMP - 0.0026]));
  tvDark.push(at(box(0.036, 0.024, 0.0012), [0.215, HUMP_CY - 0.05, Z_HUMP - 0.0004]));
  // The inlet carries a plugged-in lead, so what stands proud is the moulded
  // plug body, not a bare socket shell.
  tvDark.push(at(roundedBox(0.027, 0.016, 0.012, 0.0025, 2), [0.215, HUMP_CY - 0.05, Z_HUMP - 0.0065]));
  tv.add(merged(tvDark, darkRubber, 'tvPorts'));

  // Central pedestal: a footplate on the console top and a tapered blade.
  const standTopY = H - TV_CY; // console top, in TV-local space
  tv.add(
    merged(
      [
        at(roundedBox(0.34, 0.012, 0.18, 0.004, 2), [0, standTopY + 0.006, -0.075]),
        at(roundedBox(0.17, 0.03, 0.07, 0.008, 2), [0, standTopY + 0.026, -0.038]),
      ],
      steelFlat,
      'tvStandFoot',
    ),
  );
  tv.add(
    merged(
      [
        at(roundedBox(0.1, 0.3, 0.034, 0.01, 2), [0, standTopY + 0.16, -0.037]),
        at(roundedBox(0.13, 0.05, 0.028, 0.008, 2), [0, HUMP_CY - 0.09, -0.032]),
      ],
      steel,
      'tvStandBlade',
    ),
  );
  // The legs share the pedestal's material — one draw call for both.
  g.add(merged(legParts, steel, 'legs'));

  const bar = new THREE.Group();
  bar.name = 'soundbar';
  bar.position.set(0.01, H, 0.125);
  bar.rotation.y = deg(0.8);
  g.add(bar);
  bar.add(mesh(roundedBox(0.9, 0.06, 0.1, 0.01, 2), M.plastic(0x121316, 0.6), [0, 0.03, 0], { name: 'barShell' }));
  // Knitted grille wrapped round the front, standing 2 mm proud of the shell.
  bar.add(mesh(roundedBox(0.874, 0.046, 0.104, 0.004, 2), M.fabric(0x3c4147, { surface: [0.874, 0.046] }), [0, 0.03, 0], { name: 'barGrille' }));

  const spk = new THREE.Group();
  spk.name = 'speaker';
  spk.position.set(-0.7, H, -0.01);
  spk.rotation.y = deg(12 + jitter(rng, 6));
  g.add(spk);
  // Knitted sleeve between a moulded base ring and a dished cap. The knit is
  // sub-pixel at 2 m, so the silhouette has to carry it: a dark sleeve and the
  // machined control ring on top, not a pale cylinder with a lid.
  spk.add(
    mesh(
      lathe([[0.0478, 0.0075], [0.049, 0.013], [0.049, 0.118], [0.0483, 0.1255]], 36),
      M.fabric(0x2f333a, { surface: [0.22, 0.1] }),
      undefined,
      { name: 'speakerSleeve' },
    ),
  );
  spk.add(
    merged(
      [
        lathe([[0, 0], [0.0435, 0], [0.0478, 0.004], [0.0485, 0.0095], [0.0478, 0.0132]], 36),
        lathe(
          [
            [0.0483, 0.1248], [0.0492, 0.129], [0.0487, 0.1342], [0.0458, 0.139],
            [0.0412, 0.1418], [0.0368, 0.1424], [0.03, 0.1416], [0.016, 0.1408], [0, 0.1406],
          ],
          36,
        ),
      ],
      M.plastic(0x1e2024, 0.55),
      'speakerShell',
    ),
  );
  spk.add(
    mesh(lathe([[0.0296, 0.1424], [0.0374, 0.1434]], 36), M.plastic(0xa8adb3, 0.45), undefined, { name: 'speakerRing' }),
  );

  // Out of the TV's mains inlet, down behind the panel, across the top behind
  // the pedestal, over the rear edge and down the back to the floor.
  g.updateMatrixWorld(true);
  const inlet = tv.localToWorld(v(0.215, HUMP_CY - 0.05, Z_HUMP - 0.012));
  const R = 0.0035;
  const x0 = inlet.x;
  const lead = tube(
    [
      inlet,
      v(x0 + 0.004, inlet.y - 0.03, inlet.z - 0.014),
      v(x0 + 0.008, 0.62, -0.03),
      v(x0 + 0.01, 0.545, -0.052),
      v(x0 + 0.01, 0.5, -0.095),
      v(x0 + 0.006, H + R + 0.0004, -0.125),
      v(x0 + 0.003, H + R, -0.175),
      v(x0 + 0.001, H + R, -0.2035),
      v(x0, 0.4817, -0.2117),
      v(x0 - 0.002, 0.4775, -0.2138),
      // A 7 mm mains lead will not hang plumb against a flat back: it leaves
      // the edge where the wrap left it and bows a couple of centimetres out
      // and back on the way down.
      v(x0 - 0.011, 0.452, -0.2095),
      v(x0 - 0.021, 0.392, -0.2078),
      v(x0 - 0.017, 0.318, -0.207),
      v(x0 - 0.003, 0.247, -0.2074),
      v(x0 + 0.013, 0.183, -0.2069),
      v(x0 + 0.024, 0.117, -0.2066),
      v(x0 + 0.033, 0.06, -0.2048),
      v(x0 + 0.055, 0.0155, -0.1955),
      v(x0 + 0.11, R + 0.0008, -0.188),
      v(x0 + 0.2, R + 0.0008, -0.179),
      v(x0 + 0.31, R + 0.0008, -0.1864),
      v(0.63, 0.0058, -0.1912),
      v(0.668, 0.0066, -0.1936),
    ],
    R,
    8,
    110,
  );
  // The moulded C7 plug the lead ends in — same sheath material, so it rides in
  // the lead's own draw call. Without it the run finishes as a cut tube cap on
  // open floor, which reads as a hole in the boards.
  const plugM = new THREE.Matrix4().makeTranslation(0.69, 0.007, -0.1955).multiply(new THREE.Matrix4().makeRotationY(deg(5)));
  g.add(
    merged(
      [
        lead,
        bake(roundedBox(0.026, 0.014, 0.024, 0.0045, 2), plugM.clone()),
        bake(at(cylinder(0.0042, 0.0062, 0.015, 14), [-0.019, -0.0004, 0], new THREE.Euler(0, 0, Math.PI / 2)), plugM),
      ],
      M.rubber(0x0f0f11),
      'powerLead',
    ),
  );

  return g;
}
