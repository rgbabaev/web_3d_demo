/** Mid-century tripod floor lamp, ~1.65 m tall. */
import * as THREE from 'three';
import { cylinder, lathe, mergeGeometries, mesh, roundedBox, tube } from '../core/geometry';
import { createRng } from '../core/noise';
import type { SceneContext } from '../core/types';

const DEG = Math.PI / 180;
type V3 = THREE.Vector3;
const v3 = (x: number, y: number, z: number): V3 => new THREE.Vector3(x, y, z);
const UP = new THREE.Vector3(0, 1, 0);

// Dimensions in metres.
const FOOT_R = 0.225; // feet stand on a Ø0.45 m circle
const LEG_R0 = 0.015; // Ø30 mm at the floor
const LEG_R1 = 0.01; // Ø20 mm at the collar
const LEG_TOP_R = 0.011; // leg axes end this far from the centre line, inside the collar
const LEG_TOP_Y = 1.168;
const PAD_H = 0.003; // felt pad under each ferrule
const PAD_R = 0.018;
const FERRULE_R = 0.0164;
const FERRULE_L = 0.04;
const COLLAR_Y0 = 1.11;
const COLLAR_Y1 = 1.197;
const STEM_R = 0.011;
const STEM_TOP = 1.352;
const SHADE_R = 0.21;
const SHADE_Y0 = 1.35;
const SHADE_Y1 = 1.65;
const SHADE_H = SHADE_Y1 - SHADE_Y0;
const RIM_R = 0.0022; // real shade wire is 2–3 mm; thicker turns into a lit ring at night
const LINER_R = 0.2055; // styrene liner, 4.5 mm inside the linen
const HUB_Y = 1.364;
const BULB_R = 0.025;
const BULB_Y = 1.438;
const CABLE_R = 0.0035;
const FLOOR_Y = CABLE_R + 0.0011; // cable centre height; the margin absorbs the spline's overshoot at the turn

/** Compose a transform: scale, then rotate (Euler XYZ, radians), then translate. */
function mat4(pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, 'XYZ')),
    new THREE.Vector3(...scale),
  );
}

/** Cylinder whose axis runs from a to b (radius rA at a, rB at b). */
function cylBetween(a: V3, b: V3, rA: number, rB: number, seg = 16, open = false): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const len = d.length();
  const g = cylinder(rB, rA, len, seg, open);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/** Flat torus (in the XZ plane) centred at (0, y, 0). */
function ring(R: number, r: number, y: number, radial = 8, tubular = 64): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(R, r, radial, tubular);
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** Push every vertex below `yCut + tol` down onto y = yCut (a tilted cylinder cut flush to the floor). */
function flattenBottom(g: THREE.BufferGeometry, yCut: number, tol: number): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < yCut + tol) p.setY(i, yCut);
  p.needsUpdate = true;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Emissive map for the lit drum; v runs up the drum, so canvas y = 0 is the top rim. */
function glowMap(ctx: SceneContext): THREE.Texture {
  // Its own rng stream: the texture is cached by key, so it must not consume the module's.
  const rng = createRng(ctx.seed + 4157);
  return ctx.textures.canvas('floorLamp-shadeGlow', 256, 256, (c, w, h) => {
    const grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#84817c'); // top rim
    grad.addColorStop(0.28, '#b0aca4');
    grad.addColorStop(0.58, '#eceae5');
    grad.addColorStop(0.72, '#ffffff'); // level with the bulb
    grad.addColorStop(0.86, '#d9d5cd');
    grad.addColorStop(1, '#94908a'); // bottom rim
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
    // linen slubs: threads run around the drum, so they streak horizontally
    c.lineWidth = 1;
    for (let i = 0; i < 90; i++) {
      const y = rng() * h;
      const x0 = rng() * w;
      const len = w * (0.12 + rng() * 0.5);
      c.strokeStyle = rng() < 0.55 ? `rgba(255,255,255,${0.05 + rng() * 0.07})` : `rgba(0,0,0,${0.03 + rng() * 0.05})`;
      c.beginPath();
      c.moveTo(x0, y);
      c.lineTo(x0 + len, y + (rng() - 0.5) * 2);
      c.stroke();
    }
    // a faint cloudiness, as a fabric drum photographs when it is lit
    for (let i = 0; i < 22; i++) {
      const r = w * (0.05 + rng() * 0.12);
      const blob = c.createRadialGradient(rng() * w, rng() * h, 0, rng() * w, rng() * h, r);
      blob.addColorStop(0, `rgba(255,255,255,${0.03 + rng() * 0.04})`);
      blob.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = blob;
      c.fillRect(0, 0, w, h);
    }
    // the seam where the fabric wraps: two plies, so it passes less light
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(Math.round(w * 0.5), 0, 3, h);
    c.fillStyle = 'rgba(0,0,0,0.1)';
    c.fillRect(Math.round(w * 0.5) - 2, 0, 2, h);
  });
}

/** Offset UVs so identical legs don't show identical grain. */
function shiftUv(g: THREE.BufferGeometry, du: number, dv: number): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
  uv.needsUpdate = true;
  return g;
}

/** Collects geometry per bucket (material + shadow flag) and merges each into one mesh. */
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

  /** Make every geometry in a bucket mergeable: same index-ness, same attribute set. */
  private static normalise(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
    const mixedIndex = geoms.some((g) => g.index === null) && geoms.some((g) => g.index !== null);
    const shared = geoms
      .map((g) => Object.keys(g.attributes))
      .reduce((acc, keys) => acc.filter((k) => keys.includes(k)));
    return geoms.map((g) => {
      const out = mixedIndex && g.index !== null ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes)) if (!shared.includes(name)) out.deleteAttribute(name);
      return out;
    });
  }

  build(group: THREE.Group): void {
    for (const b of this.buckets.values()) {
      if (b.geoms.length === 0) continue;
      const merged = b.geoms.length === 1 ? b.geoms[0] : mergeGeometries(Builder.normalise(b.geoms), false);
      if (merged) {
        group.add(mesh(merged, b.mat, undefined, { cast: b.cast, name: b.name }));
      } else {
        for (const g of b.geoms) group.add(mesh(g, b.mat, undefined, { cast: b.cast, name: b.name }));
      }
    }
  }
}

export function create(ctx: SceneContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'floorLamp';
  const rng = createRng(ctx.seed + 4101);
  const jit = (amt: number): number => (rng() - 0.5) * 2 * amt;
  const M = ctx.materials;
  const B = new Builder();

  // rotate: true maps texture u (the grain) along the leg, so the size is passed swapped [along v, along u].
  // Tinted down into walnut: at its own colour the oak merges with the brass into one gold tripod.
  const oak = M.wood('oak', { surface: [1.2, 0.09], rotate: true }).clone();
  oak.name = 'floorLamp-oak';
  oak.color.setHex(0xbcb0a2);
  // Satin, not polished: 1.6 m under the bulb, the only brass here that can afford a tight specular lobe.
  const brass = M.metal('brass').clone();
  brass.name = 'floorLamp-brass';
  brass.color.setHex(0xd4a85f);
  brass.roughness = 0.42;
  // One brass per distance from the bulb: a mirror 0.07–0.25 m from a point source clips unless it is darker.
  const collarBrass = brass.clone(); // collar, stem, screws — 0.25 m below
  collarBrass.name = 'floorLamp-collar';
  collarBrass.color.setHex(0x9c7a44);
  collarBrass.roughness = 0.45;
  // The room probe sits at the drum's bottom edge, so metal inside the shade mirrors a near-white environment.
  const rimBrass = brass.clone(); // wire rims — 0.09 m below / 0.21 m above
  rimBrass.name = 'floorLamp-rim';
  rimBrass.color.setHex(0xa07f48);
  rimBrass.roughness = 0.68;
  rimBrass.envMapIntensity = 0.45;
  const fitter = brass.clone(); // antiqued holder, hub and spokes — 0.07 m below
  fitter.name = 'floorLamp-fitter';
  fitter.color.setHex(0x3a2d1c);
  fitter.roughness = 0.8;
  fitter.envMapIntensity = 0.3;
  const felt = M.rubber(0x1c1a18);
  // The shared fabric's half-white sheen turns a black 7 mm tube into a pale grey thread at grazing angles.
  const cableMat = M.fabric(0x141416, { surface: [2.4, 0.024] }).clone();
  cableMat.name = 'floorLamp-cable';
  cableMat.sheenColor.setHex(0x2e2e31);
  // A moulded rocker is near-black; at the shared plastic's envMap intensity it reads as mid-grey.
  const switchBody = M.plastic(0x1d1d1f, 0.5).clone();
  switchBody.name = 'floorLamp-switchBody';
  switchBody.color.setHex(0x0d0d0f);
  switchBody.envMapIntensity = 0.4;
  const rocker = M.plastic(0x9d9a93, 0.34);

  const glow = glowMap(ctx);
  // Near-white, not cream: at 0xf5eddd the backlit drum matched the warm plaster behind it and read as a cut-out.
  const shadeMat = M.linen(0xfdf8f2, { surface: [2 * Math.PI * SHADE_R, SHADE_H] }).clone();
  shadeMat.name = 'floorLamp-shade';
  shadeMat.emissive.set(0xffe0b8).multiplyScalar(0.13); // registry drives intensity 6 → effective 0.78
  shadeMat.emissiveMap = glow; // bright band at bulb height, seam, slubs
  shadeMat.emissiveIntensity = 6;
  shadeMat.envMapIntensity = 1; // backlit, the probe is most of what lights it

  // Black metal (metalness 1, black base) with a constant emissive: driven to zero with the lamp, the drum's open top would go black by day.
  const linerMat = M.emissive(0xffe9cf, 0.72, 0x000000);
  linerMat.name = 'floorLamp-liner';
  linerMat.metalness = 1;
  linerMat.roughness = 1;
  linerMat.envMapIntensity = 0;
  linerMat.side = THREE.BackSide;
  linerMat.shadowSide = THREE.DoubleSide; // a light inside only ever sees back faces
  linerMat.emissiveMap = glow; // same falloff, so the visible cavity is not flat

  // Pale frosted base colour: unlit by day, the bulb must still read as glass and not a black ball.
  const bulbMat = M.emissive(0xffd9a8, 6, 0xdcd5c8);
  bulbMat.name = 'floorLamp-bulb';

  // Legs: the back one at -Z, two framing the front (+Z).
  const legAz = [180 * DEG, 60 * DEG, -60 * DEG];
  interface Leg { footTop: V3; top: V3; dir: V3; h: V3; n: V3; side: V3; L: number }
  const legs: Leg[] = [];
  legAz.forEach((az0, i) => {
    const az = az0 + jit(0.5 * DEG);
    const sx = Math.sin(az);
    const cz = Math.cos(az);
    const footR = FOOT_R + jit(0.003);
    const footTop = v3(footR * sx, PAD_H, footR * cz); // leg axis meets the pad top here
    const top = v3(LEG_TOP_R * sx, LEG_TOP_Y, LEG_TOP_R * cz);
    const dir = top.clone().sub(footTop).normalize();
    const h = v3(sx, 0, cz); // horizontal, away from the centre
    const n = h.clone().addScaledVector(dir, -h.dot(dir)).normalize(); // outward, ⟂ to the leg
    const side = new THREE.Vector3().crossVectors(UP, h).normalize();
    const L = top.distanceTo(footTop);
    legs.push({ footTop, top, dir, h, n, side, L });

    // felt pad on the floor
    B.put(felt, cylinder(PAD_R, PAD_R, PAD_H, 24), mat4([footTop.x, PAD_H / 2, footTop.z]), { name: 'floorLamp-pads' });
    // brass ferrule, its lower rim cut flush with the pad
    const f0 = footTop.clone().addScaledVector(dir, 0.0035);
    const f1 = footTop.clone().addScaledVector(dir, FERRULE_L);
    B.put(brass, flattenBottom(cylBetween(f0, f1, FERRULE_R, FERRULE_R - 0.0006, 32), PAD_H, 0.008), undefined, { name: 'floorLamp-brass' });
    // tapered oak leg (its ends are hidden inside the ferrule and the collar)
    const l0 = footTop.clone().addScaledVector(dir, 0.03);
    B.put(oak, shiftUv(cylBetween(l0, top, LEG_R0, LEG_R1, 32, true), i * 0.37, i * 0.23), undefined, { name: 'floorLamp-legs' });
    // dome-head screw on the collar's lower band, holding this leg
    B.put(collarBrass, new THREE.SphereGeometry(0.0035, 12, 8), mat4([0.0372 * sx, 1.128, 0.0372 * cz]), { cast: false });
  });

  // No face 40–65° above horizontal: it would mirror the bulb 0.25 m up into a camera at eye level.
  // Neither part casts: a 76 mm disc under a point source would shadow the floor the drum's open bottom lights.
  B.put(
    collarBrass,
    lathe(
      [
        [0, COLLAR_Y0], [0.034, COLLAR_Y0], [0.0375, COLLAR_Y0 + 0.004], [0.038, 1.142], [0.035, 1.149],
        [0.035, 1.153], [0.038, 1.16], [0.0382, 1.1885], [0.0355, 1.194], [0.0125, 1.194], [0.0115, COLLAR_Y1], [0, COLLAR_Y1],
      ],
      48,
    ),
    undefined,
    { cast: false, name: 'floorLamp-collar' },
  );
  B.put(collarBrass, cylinder(STEM_R, STEM_R, STEM_TOP - 1.19, 32, true), mat4([0, (STEM_TOP + 1.19) / 2, 0]), { cast: false });

  // Holder and hub sit directly under the bulb, so they must not cast.
  B.put(
    fitter,
    lathe(
      [
        [STEM_R, 1.344], [0.0175, 1.348], [0.019, 1.352], [0.019, 1.372], [0.018, 1.375], [0.019, 1.378],
        [0.019, 1.396], [0.017, 1.4], [0.011, 1.402], [0.011, 1.418], [0.009, 1.42], [0, 1.42],
      ],
      32,
    ),
    undefined,
    { cast: false, name: 'floorLamp-holder' },
  );
  B.put(fitter, ring(0.0205, 0.0025, HUB_Y, 6, 32), undefined, { cast: false });

  // The drum casts: it is the only thing that stops the bulb radiating sideways.
  const shade = mesh(cylinder(SHADE_R, SHADE_R, SHADE_H, 64, true), shadeMat, [0, (SHADE_Y0 + SHADE_Y1) / 2, 0], { cast: true, name: 'floorLamp-shade' });
  shade.rotation.y = rng() * Math.PI * 2; // seam anywhere
  group.add(shade);
  // 1 mm shorter than the drum at each end, or the constant-emissive liner dashes the rims with white.
  const liner = mesh(cylinder(LINER_R, LINER_R, SHADE_H - 0.002, 64, true), linerMat, [0, (SHADE_Y0 + SHADE_Y1) / 2, 0], { cast: true, receive: false, name: 'floorLamp-liner' });
  liner.rotation.y = shade.rotation.y;
  group.add(liner);
  // Centreline pushed 0.4 r out so the gold sits proud of the linen; at 6 radial segments the grazing specular aliases into a dashed line.
  B.put(rimBrass, ring(SHADE_R + RIM_R * 0.4, RIM_R, SHADE_Y0, 10, 64), undefined, { name: 'floorLamp-rims' });
  B.put(rimBrass, ring(SHADE_R + RIM_R * 0.4, RIM_R, SHADE_Y1, 10, 64));
  // Spokes must not cast: 4 mm rods 0.07 m under the bulb rake 7 cm bars across the pool on the floor.
  for (const az of legAz) {
    const hub = v3(0.019 * Math.sin(az), HUB_Y, 0.019 * Math.cos(az));
    const rim = v3((SHADE_R - 0.002) * Math.sin(az), SHADE_Y0 + 0.002, (SHADE_R - 0.002) * Math.cos(az));
    B.put(fitter, cylBetween(hub, rim, 0.002, 0.002, 8), undefined, { cast: false });
  }

  group.add(mesh(new THREE.SphereGeometry(BULB_R, 20, 14), bulbMat, [0, BULB_Y, 0], { cast: false, name: 'floorLamp-bulb' }));
  const light = new THREE.PointLight(0xffcf9a, 16, 0, 2);
  light.name = 'floorLamp';
  light.position.set(0, BULB_Y, 0);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.camera.near = 0.05;
  light.shadow.camera.far = 8;
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.02;
  light.shadow.radius = 6; // the source is a 0.42 m drum, not a point
  group.add(light);
  ctx.lights.register({ name: 'floorLamp', role: 'lamp', light, emissives: [bulbMat, shadeMat], baseIntensity: 16, baseEmissive: 6 });

  // Cable: out of the collar, clipped down the back leg, across the floor.
  const back = legs[0];
  const axisPt = (t: number): V3 => back.footTop.clone().addScaledVector(back.dir, t);
  const legR = (t: number): number => LEG_R0 + (LEG_R1 - LEG_R0) * THREE.MathUtils.clamp((t - 0.03) / (back.L - 0.03), 0, 1);
  const onLeg = (t: number, lift = 0, side = 0): V3 =>
    axisPt(t).addScaledVector(back.n, legR(t) + CABLE_R + lift).addScaledVector(back.side, side);
  const floorPt = (along: number, side: number, y = FLOOR_Y): V3 =>
    v3(back.footTop.x, y, back.footTop.z).addScaledVector(back.h, along).addScaledVector(back.side, side);

  const clipTs = [1.0, 0.55, 0.13];
  const sw = rng() < 0.5 ? 1 : -1; // which way the floor run drifts
  const switchY = 0.0095;
  const swIn = floorPt(0.23, sw * 0.022, switchY);
  const swMid = floorPt(0.275, sw * 0.027, switchY);
  const swOut = floorPt(0.32, sw * 0.03, switchY);
  const cablePts: V3[] = [
    v3(0, 1.14, 0).addScaledVector(back.h, 0.02),
    v3(0, 1.107, 0).addScaledVector(back.h, 0.037),
    onLeg(clipTs[0]),
    onLeg(0.86, 0.004, jit(0.003) + 0.002),
    onLeg(0.7, 0.005, jit(0.003) + 0.003),
    onLeg(clipTs[1]),
    onLeg(0.42, 0.004, jit(0.003) - 0.002),
    onLeg(0.27, 0.005, jit(0.003) - 0.003),
    onLeg(clipTs[2]),
    onLeg(0.055, 0.006, 0.001),
    floorPt(0.045, 0.002, 0.018),
    floorPt(0.062, sw * 0.003, 0.009), // damps the spline's overshoot into the boards
    floorPt(0.085, sw * 0.004),
    floorPt(0.16, sw * 0.013),
    swIn,
    swMid,
    swOut,
    floorPt(0.4, sw * 0.02),
    floorPt(0.47, -sw * 0.004),
    floorPt(0.53, -sw * 0.02),
  ];
  B.put(cableMat, tube(cablePts, CABLE_R, 8, 128), undefined, { name: 'floorLamp-cable' });
  const end = cablePts[cablePts.length - 1];
  B.put(cableMat, new THREE.SphereGeometry(CABLE_R, 8, 6), mat4([end.x, end.y, end.z]));

  // cable clips: small black saddles nailed to the leg over the cable
  for (const t of clipTs) {
    const p = axisPt(t).addScaledVector(back.n, legR(t) + CABLE_R);
    const basis = new THREE.Matrix4().makeBasis(back.side, back.n, back.dir).setPosition(p);
    B.put(felt, roundedBox(0.012, 0.0075, 0.009, 0.002, 1), basis, { name: 'floorLamp-clips' });
  }

  // A 0.7 mm step between the two body halves reads as the moulding seam.
  const swDir = swOut.clone().sub(swIn);
  const yaw = Math.atan2(swDir.x, swDir.z);
  const S = mat4([swMid.x, 0, swMid.z], [0, yaw, 0]);
  const at = (pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]): THREE.Matrix4 => mat4(pos, rot).premultiply(S);
  B.put(switchBody, roundedBox(0.026, 0.0118, 0.058, 0.0045, 2), at([0, 0.0059, 0]), { name: 'floorLamp-switch' });
  B.put(switchBody, roundedBox(0.0246, 0.0104, 0.0566, 0.0035, 2), at([0, 0.0166, 0]));
  // bezel rails around the rocker well (top of the body is y = 0.0218)
  B.put(switchBody, roundedBox(0.0052, 0.0032, 0.0404, 0.0012, 1), at([0.0092, 0.0234, 0]));
  B.put(switchBody, roundedBox(0.0052, 0.0032, 0.0404, 0.0012, 1), at([-0.0092, 0.0234, 0]));
  B.put(switchBody, roundedBox(0.0236, 0.0032, 0.0048, 0.0012, 1), at([0, 0.0234, 0.0198]));
  B.put(switchBody, roundedBox(0.0236, 0.0032, 0.0048, 0.0012, 1), at([0, 0.0234, -0.0198]));
  B.put(rocker, roundedBox(0.0128, 0.004, 0.0332, 0.0012, 1), at([0, 0.023, 0], [5 * DEG, 0, 0]), { name: 'floorLamp-rocker' });

  B.build(group);
  return group;
}
