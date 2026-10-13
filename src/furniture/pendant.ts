// Origin is the ceiling plane: y = 0 at the ceiling, and the fitting hangs into negative y.
import * as THREE from 'three';
import { cylinder, lathe, mergeGeometries, mesh, roundedBox, tube } from '../core/geometry';
import { createRng } from '../core/noise';
import type { SceneContext } from '../core/types';

const DEG = Math.PI / 180;

const ROSE_R = 0.05; // Ø0.10 m
const ROSE_THROAT_Y = -0.041; // where the flex leaves the rose

const CABLE_R = 0.002; // Ø4 mm
const CABLE_TOP_Y = -0.0295; // capped by the cord-grip plate inside the rose
const HANG_Y = -0.594; // lower end of the flex = top of the lamp holder

// hang space: y = 0 at the lower end of the flex
const RIM_Y = -0.25; // rolled-rim centre line
const SHADE_H = 0.22; // apex → rim
const SHADE_R = 0.1955; // outer skin radius at the rim
const SHEET = 0.0018; // brass sheet thickness — also the liner's offset inside the skin
const HOLE_R = 0.058; // crown vent, Ø116 mm
const ROLL_R = 0.005; // rolled rim tube → widest point ≈ 0.1946 + 0.005 = Ø0.400
const ROD_SPLIT_Y = -0.04; // holder is split here into casting / non-casting halves

const ARM_TOP_Y = -0.0421; // carrier arms, their tips under the shade's top lip
const HOLDER_BOTTOM = -0.1375;
const BULB_R = 0.03; // Ø60 mm globe
const BULB_Y = RIM_Y + 0.04; // centre 4 cm inside the rim
const NECK_BOTTOM = -0.195;

/** Compose scale → rotate (Euler XYZ) → translate. */
function mat4(
  pos: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, 'XYZ')),
    new THREE.Vector3(...scale),
  );
}

/** Torus lying flat in the XZ plane, centred on the axis at height `y`. */
function ring(R: number, r: number, y: number, radial = 8, tubular = 48): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(R, r, radial, tubular);
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/**
 * Quarter-ellipse dome profile, ordered bottom (rim) → top (vent) so
 * LatheGeometry's normals come out facing outward.
 */
function domeProfile(r: number, h: number, yRim: number, holeR: number, steps: number): Array<[number, number]> {
  const a1 = Math.PI / 2;
  const a0 = Math.asin(Math.min(1, holeR / r));
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // bias the samples toward the top, where the curvature is highest
    const a = a1 + (a0 - a1) * Math.pow(t, 0.85);
    pts.push([r * Math.sin(a), yRim + h * Math.cos(a)]);
  }
  return pts;
}

/**
 * Tiny out-of-round, applied as a purely radial scale so every part of the
 * shade (outer skin, liner, rolled rim) stays concentric and never crosses.
 * Normals are deliberately left alone: we want the silhouette to breathe, not
 * the shading to break up.
 */
function spunWobble(g: THREE.BufferGeometry, amp: number, phase: [number, number, number]): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-5) continue;
    const th = Math.atan2(z, x);
    const f =
      Math.sin(2 * th + phase[0]) * 0.55 + Math.sin(5 * th + phase[1]) * 0.3 + Math.sin(9 * th + phase[2]) * 0.15;
    const s = 1 + amp * f;
    p.setX(i, x * s);
    p.setZ(i, z * s);
  }
  p.needsUpdate = true;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Collects geometry per (material, shadow flag) and merges each bucket into one mesh. */
class Builder {
  private buckets = new Map<string, { mat: THREE.Material; geoms: THREE.BufferGeometry[]; cast: boolean; name: string }>();

  put(mat: THREE.Material, g: THREE.BufferGeometry, transform?: THREE.Matrix4, opts: { cast?: boolean; name?: string } = {}): void {
    if (transform) g.applyMatrix4(transform);
    const cast = opts.cast ?? true;
    const key = `${mat.uuid}|${cast}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { mat, geoms: [], cast, name: opts.name ?? mat.name ?? 'part' };
      this.buckets.set(key, b);
    }
    if (opts.name) b.name = opts.name;
    b.geoms.push(g);
  }

  build(parent: THREE.Object3D): void {
    for (const b of this.buckets.values()) {
      // RoundedBoxGeometry is non-indexed while lathes/cylinders are indexed;
      // mergeGeometries refuses a mixed bucket, so level it first.
      const mixed = b.geoms.some((g) => g.getIndex() === null) && b.geoms.some((g) => g.getIndex() !== null);
      const geoms = mixed ? b.geoms.map((g) => (g.getIndex() ? g.toNonIndexed() : g)) : b.geoms;
      const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
      if (!merged) throw new Error(`pendant: cannot merge ${b.name} (${geoms.length} parts)`);
      parent.add(mesh(merged, b.mat, undefined, { cast: b.cast, name: b.name }));
    }
  }
}

export function create(ctx: SceneContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'pendant';
  const rng = createRng(ctx.seed + 6907);
  const jit = (amt: number): number => (rng() - 0.5) * 2 * amt;
  const M = ctx.materials;

  const shell = new Builder(); // module space (ceiling rose, screws, flex)
  const fit = new Builder(); // hang space (shade, holder, bulb)

  const rosePlastic = M.plastic(0xf3f0e9, 0.55);
  const fittingBrass = M.metal('brass'); // cord grip, above the shade and in plain view
  // The same brass gone dull with heat; it is seen through the vent beside the polished cord grip.
  const fitterBrass = fittingBrass.clone();
  fitterBrass.name = 'pendant-fitter';
  fitterBrass.color.setHex(0xb08b4e);
  fitterBrass.roughness = 0.45;
  // TubeGeometry's u runs along the path and v around it, so the UV square is drop × circumference.
  const cableMat = M.fabric(0x131315, { surface: [0.57, 0.0126] });

  // The roughness map alone dies on the crown; the normal map is what keeps the turning visible.
  const spinMarks = ctx.textures.canvas(
    'pendant-spun-brass',
    32,
    1024,
    (c, w, h) => {
      const r2 = createRng(91373);
      c.fillStyle = '#545454';
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 560; i++) {
        const y = r2() * h;
        const v = THREE.MathUtils.clamp(0.38 + (r2() - 0.5) * 0.4, 0.26, 0.58);
        const g = Math.round(v * 255);
        c.fillStyle = `rgba(${g},${g},${g},${(0.3 + r2() * 0.65).toFixed(3)})`;
        c.fillRect(0, y, w, r2() < 0.75 ? 1 : 2);
      }
      // Flipped on upload, so canvas row 0 is the top of the dome, where dust settles.
      const dust = c.createLinearGradient(0, 0, 0, h * 0.34);
      dust.addColorStop(0, 'rgba(126,126,126,0.5)');
      dust.addColorStop(1, 'rgba(126,126,126,0)');
      c.fillStyle = dust;
      c.fillRect(0, 0, w, h * 0.34);
      // The bottom of the canvas is the lip folded into the rolled edge; forming scuffs the brass.
      const lip = c.createLinearGradient(0, h, 0, h * 0.86);
      lip.addColorStop(0, 'rgba(200,200,200,0.92)');
      lip.addColorStop(1, 'rgba(200,200,200,0)');
      c.fillStyle = lip;
      c.fillRect(0, h * 0.86, w, h * 0.14);
    },
    false,
  );
  const spinNormal = ctx.textures.canvas(
    'pendant-spun-normal',
    16,
    1024,
    (c, w, h) => {
      const r2 = createRng(77041);
      c.fillStyle = '#8080ff';
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 430; i++) {
        const y = r2() * h;
        const g = Math.round(128 + (r2() - 0.5) * 52);
        c.fillStyle = `rgb(128,${g},255)`;
        c.fillRect(0, y, w, r2() < 0.7 ? 1 : 2);
      }
    },
    false,
  );
  const shadeBrass = M.metal('brass').clone();
  shadeBrass.name = 'pendant-spunBrass';
  shadeBrass.color.set(0xe0b878);
  shadeBrass.roughnessMap = spinMarks;
  shadeBrass.roughness = 1; // the map carries the value (≈0.26–0.58, up to 0.78 on the lip)
  shadeBrass.normalMap = spinNormal;
  shadeBrass.normalScale.set(0.28, 0.28);
  shadeBrass.envMapIntensity = 1.15;

  // Tori: v runs around the tube, so the 1024-row spin maps average out and are dropped.
  // Roughness 0.72, not the skin's ~0.38: a tighter lobe breaks the rim's highlight into dots.
  const rimBrass = shadeBrass.clone();
  rimBrass.name = 'pendant-rimBrass';
  rimBrass.color.set(0xd2a86c);
  rimBrass.roughnessMap = null;
  rimBrass.normalMap = null;
  rimBrass.roughness = 0.72;
  rimBrass.envMapIntensity = 0.7;

  // Near-black albedo, not a paint's 0.9: the bulb lights this bowl to ~500 lx and the room's one
  // environment probe would spread that over every surface. The emissive stands in for its bounce.
  const linerGlow = ctx.textures.canvas('pendant-liner-glow', 16, 256, (c, w, h) => {
    const r2 = createRng(52291);
    // Flipped on upload, so canvas row 0 is the vent end of the profile.
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#b4ada3'); // sheet edge at the vent: grazing light, and the lip's own shade
    g.addColorStop(0.12, '#f0ece5');
    g.addColorStop(0.45, '#ffffff'); // squarest to the bulb
    g.addColorStop(0.84, '#eae5dd');
    g.addColorStop(0.96, '#b8b1a6'); // down into the rolled rim
    g.addColorStop(1, '#948d84');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // brush marks in the white paint, concentric because they follow the spinning
    for (let i = 0; i < 140; i++) {
      const y = r2() * h;
      const v = r2() < 0.5 ? 255 : 150;
      c.fillStyle = `rgba(${v},${v},${v},${(0.04 + r2() * 0.1).toFixed(3)})`;
      c.fillRect(0, y, w, r2() < 0.7 ? 1 : 2);
    }
  });
  const interior = M.custom({
    color: 0x0c0a08,
    metalness: 0,
    roughness: 0.9,
    specularIntensity: 0,
    side: THREE.BackSide,
    emissive: 0xffeedd,
    emissiveIntensity: 0.3,
  });
  interior.name = 'pendant-shadeLiner';
  interior.emissiveMap = linerGlow;

  const bulbMat = M.emissive(0xffe2b8, 6, 0xe7dfd1);
  bulbMat.name = 'pendant-bulb';

  // Profile bottom (flex throat) → top, flat against the ceiling at y = 0; the dip around
  // y = -0.008 is the shadow-gap seam, and the last two points keep the contact circle crisp.
  const roseProfile: Array<[number, number]> = [
    [0.0062, ROSE_THROAT_Y],
    [0.0098, -0.0392],
    [0.0128, -0.0345],
    [0.014, -0.0292],
    [0.021, -0.0272],
    [0.032, -0.024],
    [0.041, -0.0195],
    [0.047, -0.0145],
    [0.0494, -0.0104],
    [0.0488, -0.0092],
    [0.0488, -0.007],
    [0.0496, -0.0058],
    [ROSE_R, -0.0032],
    [ROSE_R, 0],
    [0, 0],
  ];
  shell.put(rosePlastic, lathe(roseProfile, 24), undefined, { name: 'pendant-rose' });

  const bowAz = rng() * Math.PI * 2;
  const bow = new THREE.Vector3(Math.cos(bowAz), 0, Math.sin(bowAz));
  const amp = 0.0072 + jit(0.0008);
  const cableEnd = HANG_Y - 0.005; // the cut end hides inside the brass cord grip
  const cablePts: THREE.Vector3[] = [];
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const s = Math.sin(Math.PI * t);
    const off = amp * (s * s * 0.9 + Math.sin(2 * Math.PI * t) * 0.25);
    cablePts.push(new THREE.Vector3(bow.x * off, CABLE_TOP_Y + (cableEnd - CABLE_TOP_Y) * t, bow.z * off));
  }
  shell.put(cableMat, tube(cablePts, CABLE_R, 6, 20), undefined, { name: 'pendant-flex' });
  // cord-grip plate up inside the rose: caps the flex and the rose's cavity
  shell.put(cableMat, cylinder(0.0125, 0.0125, 0.004, 12), mat4([0, -0.031, 0]), { name: 'pendant-flex' });

  const hang = new THREE.Group();
  hang.name = 'pendant-fitting';
  hang.position.set(bow.x * 0.0002, HANG_Y, bow.z * 0.0002);
  // No yaw: it would only inflate the axis-aligned bounding box the layout reads back.
  const tilt = 0.4 * DEG;
  hang.rotation.set(tilt * bow.z, 0, -tilt * bow.x);
  group.add(hang);

  const phase: [number, number, number] = [rng() * 6.283, rng() * 6.283, rng() * 6.283];
  const WOBBLE = 0.003; // 0.3 % out of round → ±0.6 mm at the rim

  const SHADE_STEPS = 10;
  const outerPts = domeProfile(SHADE_R, SHADE_H, RIM_Y, HOLE_R, SHADE_STEPS);
  const innerPts = domeProfile(SHADE_R - SHEET, SHADE_H - SHEET, RIM_Y, HOLE_R, SHADE_STEPS);
  // Both sheets run into the roll, so neither open boundary ring is left on the silhouette.
  outerPts[0] = [SHADE_R - SHEET / 2, RIM_Y + 0.0008];
  innerPts[0] = [SHADE_R - SHEET / 2, RIM_Y - 0.0008];
  // Same treatment at the vent, where a Ø3.2 mm lip closes the sheet.
  const LIP_R = 0.0016;
  const LIP_Y = RIM_Y + 0.2091;
  outerPts[outerPts.length - 1] = [HOLE_R, LIP_Y + 0.0004];
  innerPts[innerPts.length - 1] = [HOLE_R, LIP_Y - 0.0004];

  fit.put(shadeBrass, spunWobble(lathe(outerPts, 48), WOBBLE, phase), undefined, { name: 'pendant-shade' });
  // 10 sides rather than 8: the rim is the whole silhouette and carries the brightest highlight.
  fit.put(rimBrass, spunWobble(ring(SHADE_R - SHEET / 2, ROLL_R, RIM_Y, 10, 48), WOBBLE, phase), undefined, {
    name: 'pendant-rim',
  });
  // rolled lip closing the sheet edge around the vent
  fit.put(rimBrass, spunWobble(ring(HOLE_R, LIP_R, LIP_Y, 6, 28), WOBBLE, phase), undefined, { name: 'pendant-rim' });

  const liner = mesh(spunWobble(lathe(innerPts, 48), WOBBLE, phase), interior, undefined, {
    cast: false,
    name: 'pendant-shadeLiner',
  });
  hang.add(liner);

  // Two lathes meeting flush at ROD_SPLIT_Y on the plain rod, so the join is invisible.
  const holderLower: Array<[number, number]> = [
    [0, HOLDER_BOTTOM],
    [0.015, HOLDER_BOTTOM],
    [0.0168, -0.1362],
    [0.0195, -0.1345],
    [0.0195, -0.1285],
    [0.0178, -0.1268],
    [0.0178, -0.0998],
    [0.019, -0.0982],
    [0.019, -0.0928],
    [0.016, -0.0908],
    [0.0085, -0.0895],
    [0.0085, ROD_SPLIT_Y],
  ];
  const holderUpper: Array<[number, number]> = [
    [0.0085, ROD_SPLIT_Y],
    [0.0118, -0.0384],
    [0.0118, -0.0206],
    [0.0085, -0.019],
    [0.0085, -0.0042],
    [0.0072, -0.0014],
    [0.003, 0],
  ];
  fit.put(fitterBrass, lathe(holderLower, 24), undefined, { name: 'pendant-holder' });
  fit.put(fittingBrass, lathe(holderUpper, 20), undefined, { cast: false, name: 'pendant-cordGrip' });

  // three carrier arms: rod → under the shade's top lip, which rests on the tips
  const armAz = rng() * Math.PI * 2;
  for (let i = 0; i < 3; i++) {
    const az = armAz + i * 120 * DEG;
    fit.put(
      fitterBrass,
      roundedBox(0.0515, 0.003, 0.011, 0.0012, 1),
      mat4([0.03375 * Math.cos(az), ARM_TOP_Y - 0.0015, 0.03375 * Math.sin(az)], [0, -az, 0]),
      { name: 'pendant-holder' },
    );
  }

  // E27 cap, emerging from the holder's bottom lip
  fit.put(fitterBrass, cylinder(0.0132, 0.0138, 0.02, 12), mat4([0, -0.14, 0]), { name: 'pendant-holder' });

  const neckProfile: Array<[number, number]> = [
    [0.026, NECK_BOTTOM],
    [0.025, -0.188],
    [0.0215, -0.179],
    [0.0172, -0.169],
    [0.0142, -0.158],
    [0.0136, -0.1485],
  ];
  fit.put(bulbMat, lathe(neckProfile, 16), undefined, { cast: false, name: 'pendant-bulb' });
  fit.put(bulbMat, new THREE.SphereGeometry(BULB_R, 20, 12), mat4([0, BULB_Y, 0]), { cast: false, name: 'pendant-bulb' });

  const light = new THREE.PointLight(0xffd6a6, 18, 0, 2);
  light.name = 'pendant';
  light.position.set(0, BULB_Y, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.near = 0.05;
  light.shadow.camera.far = 8;
  light.shadow.bias = -0.0005;
  // 0.0025, not the brief's 0.02: 20 mm would displace the terminator across the whole rolled rim.
  light.shadow.normalBias = 0.0025;
  light.shadow.radius = 1.5; // the source is a Ø60 mm globe, so the ring on the ceiling has a penumbra
  hang.add(light);
  ctx.lights.register({ name: 'pendant', role: 'ceiling', light, emissives: [bulbMat], baseIntensity: 18, baseEmissive: 6 });

  shell.build(group);
  fit.build(hang);
  return group;
}
