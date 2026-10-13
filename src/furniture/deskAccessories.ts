/** Lamp, mug, notebook, headphones, succulent, phone and power strip on the work desk. */
import * as THREE from 'three';
import { box, cylinder, lathe, mergeGeometries, mesh, roundedBox, tube } from '../core/geometry';
import { createRng, smoothstep } from '../core/noise';
import type { SceneContext } from '../core/types';

const TOP = 0.74; // desk top height (m)
const DEG = Math.PI / 180;
type V3 = THREE.Vector3;
const v3 = (x: number, y: number, z: number): V3 => new THREE.Vector3(x, y, z);

/** Compose a transform: scale, then rotate (Euler XYZ, radians), then translate. */
function mat4(pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, 'XYZ')),
    new THREE.Vector3(...scale),
  );
}

/** Cylinder whose axis runs from a to b (rA at a, rB at b). */
function cylBetween(a: V3, b: V3, rA: number, seg = 16, rB = rA): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const len = d.length();
  const g = cylinder(rB, rA, len, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/** Torus arc in the XY plane, centred on +x and spanning ±arc/2. */
function torusArc(R: number, r: number, arc: number, radial = 10, tubular = 32): THREE.TorusGeometry {
  const g = new THREE.TorusGeometry(R, r, radial, tubular, arc);
  g.rotateZ(-arc / 2);
  return g;
}

/** Collects geometry per material and merges it into one mesh per material. */
class Builder {
  private buckets = new Map<THREE.Material, { geoms: THREE.BufferGeometry[]; cast: boolean; name: string }>();

  put(mat: THREE.Material, g: THREE.BufferGeometry, ...transforms: THREE.Matrix4[]): void {
    for (const m of transforms) g.applyMatrix4(m);
    let b = this.buckets.get(mat);
    if (!b) {
      b = { geoms: [], cast: true, name: mat.name || 'part' };
      this.buckets.set(mat, b);
    }
    b.geoms.push(g);
  }

  name(mat: THREE.Material, name: string, cast = true): void {
    const b = this.buckets.get(mat);
    if (b) {
      b.name = name;
      b.cast = cast;
    }
  }

  build(group: THREE.Group): void {
    for (const [mat, b] of this.buckets) {
      let geoms = b.geoms;
      if (geoms.some((g) => !g.index)) geoms = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
      const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
      if (!merged) continue;
      group.add(mesh(merged, mat, undefined, { cast: b.cast, name: b.name }));
    }
  }
}

export function create(ctx: SceneContext): THREE.Group {
  const group = new THREE.Group();
  group.name = 'deskAccessories';
  const rng = createRng(ctx.seed + 7301);
  const jit = (amt: number): number => (rng() - 0.5) * 2 * amt;
  const M = ctx.materials;
  const B = new Builder();

  const black = M.metal('blackMatte');
  const alu = M.metal('aluminum');
  const brushed = M.metal('brushedSteel');
  const chrome = M.metal('chrome');
  const rubber = M.rubber(0x161616);
  const darkPlastic = M.plastic(0x232426, 0.55);
  const leatherBlack = M.leather(0x151515, { surface: [0.12, 0.12] });
  const whitePaper = M.paper(0xf4f1ea, { surface: [0.2, 0.2] });

  // Power strip on the floor behind the desk, built first so the cables can end inside its plug boots.
  const plugEntry: V3[][] = []; // per plug: [approach, end] in module space
  {
    const F = mat4([-0.4, 0, -0.3], [0, 4 * DEG + jit(2 * DEG), 0]);
    const white = M.plastic(0xe4e1da, 0.5);
    const socketPlastic = M.plastic(0x35373a, 0.6);
    B.put(white, roundedBox(0.28, 0.036, 0.062, 0.005, 3), mat4([0, 0.02, 0]), F);
    for (const fx of [-0.12, 0.12]) for (const fz of [-0.022, 0.022]) B.put(rubber, cylinder(0.006, 0.006, 0.002, 12), mat4([fx, 0.001, fz]), F);
    B.name(white, 'power-strip');
    const socketX = [-0.075, 0, 0.075];
    for (const sx of socketX) B.put(socketPlastic, cylinder(0.0185, 0.0185, 0.004, 32), mat4([sx, 0.0365, 0]), F);
    B.name(socketPlastic, 'sockets');
    // pin holes on the empty socket
    for (const px of [-0.0095, 0.0095]) B.put(rubber, cylinder(0.0025, 0.0025, 0.003, 10), mat4([socketX[2] + px, 0.038, 0]), F);
    // illuminated rocker switch
    const led = M.emissive(0xff3a1a, 1.4, 0x3a0a05);
    B.put(led, roundedBox(0.012, 0.005, 0.02, 0.002, 2), mat4([0.126, 0.039, 0], [0, 0, 8 * DEG]), F);
    B.name(led, 'strip-switch', false);
    // two angled Schuko plugs, cable boots pointing to the back (-z)
    for (const sx of socketX.slice(0, 2)) {
      B.put(rubber, cylinder(0.0185, 0.0185, 0.022, 32), mat4([sx, 0.038 + 0.011, 0]), F);
      B.put(rubber, cylinder(0.013, 0.0185, 0.004, 32), mat4([sx, 0.038 + 0.024, 0]), F);
      B.put(rubber, cylinder(0.0072, 0.0072, 0.024, 16), mat4([sx, 0.049, -0.022], [Math.PI / 2, 0, 0]), F);
      B.put(rubber, cylinder(0.0072, 0.0055, 0.012, 16), mat4([sx, 0.049, -0.038], [Math.PI / 2, 0, 0]), F);
      plugEntry.push([v3(sx, 0.049, -0.06).applyMatrix4(F), v3(sx, 0.049, -0.03).applyMatrix4(F)]);
    }
    // strain-relief boot for the strip's own cord (left end) and the cord itself
    B.put(rubber, cylinder(0.0065, 0.0075, 0.02, 16), mat4([-0.148, 0.018, 0], [0, 0, Math.PI / 2]), F);
    const cord = [v3(-0.155, 0.018, 0), v3(-0.188, 0.012, -0.012), v3(-0.208, 0.006, -0.05), v3(-0.2, 0.006, -0.11), v3(-0.165, 0.006, -0.16), v3(-0.11, 0.006, -0.195)];
    B.put(rubber, tube(cord, 0.005, 8, 32), F);
  }

  // Articulated LED desk lamp, back-left.
  {
    const basePos: [number, number, number] = [-0.62, TOP, -0.25];
    // local +z points at the aim point on the desk (toward the notebook / mat)
    const aimDir = new THREE.Vector2(-0.3 - basePos[0], 0.2 - basePos[2]).normalize();
    const yaw = Math.atan2(aimDir.x, aimDir.y);
    const F = mat4(basePos, [0, yaw, 0]);

    // rubber anti-slip ring under the base, then the weighted base (lathe)
    B.put(rubber, cylinder(0.08, 0.08, 0.002, 48), mat4([0, 0.001, 0]), F);
    B.put(
      black,
      lathe(
        [
          [0, 0.002], [0.086, 0.002], [0.09, 0.006], [0.09, 0.016], [0.086, 0.021], [0.05, 0.024],
          [0.03, 0.026], [0.024, 0.03], [0.024, 0.032], [0, 0.032],
        ],
        64,
      ),
      F,
    );
    // brushed steel inlay disc on the base top + touch dimmer plate
    B.put(brushed, cylinder(0.046, 0.046, 0.0025, 48), mat4([0, 0.0242 + 0.00125, 0]), F);
    B.put(alu, cylinder(0.006, 0.006, 0.001, 16), mat4([0, 0.0255, 0.062]), F);

    // post + articulated arms
    const P0 = v3(0, 0.064, 0);
    const dir0 = v3(0, Math.cos(12 * DEG), -Math.sin(12 * DEG));
    const P1 = P0.clone().addScaledVector(dir0, 0.3);
    const dir1 = v3(0, Math.sin(22 * DEG), Math.cos(22 * DEG));
    const P2 = P1.clone().addScaledVector(dir1, 0.3);
    const headTilt = 8 * DEG;
    const dirH = v3(0, -Math.sin(headTilt), Math.cos(headTilt));
    const headLen = 0.3;
    const Hc = P2.clone().addScaledVector(dirH, headLen / 2);

    B.put(black, cylBetween(v3(0, 0.03, 0), v3(0, P0.y, 0), 0.013, 24), F);
    B.put(alu, cylBetween(P0, P1, 0.0085, 20), F);
    B.put(alu, cylBetween(P1, P2, 0.0075, 20), F);
    // knuckles (pivots along local x) with steel end caps
    const knuckle = (p: V3, r: number, len: number): void => {
      B.put(black, cylinder(r, r, len, 24), mat4([p.x, p.y, p.z], [0, 0, Math.PI / 2]), F);
      B.put(brushed, cylinder(r * 0.6, r * 0.6, len + 0.003, 20), mat4([p.x, p.y, p.z], [0, 0, Math.PI / 2]), F);
    };
    knuckle(P0, 0.015, 0.034);
    knuckle(P1, 0.013, 0.03);
    knuckle(P2, 0.012, 0.046);

    // head: slim bar extending forward from the P2 pivot, tilted nose-down
    const HF = mat4([Hc.x, Hc.y, Hc.z], [headTilt, 0, 0]);
    B.put(black, roundedBox(0.036, 0.013, headLen, 0.005, 3), HF, F);
    B.put(black, roundedBox(0.03, 0.02, 0.03, 0.004, 2), mat4([0, 0, -headLen / 2 + 0.012]), HF, F);
    // diffuser strip on the underside
    const strip = M.emissive(0xfff0d8, 6, 0x2a2622);
    B.put(strip, box(0.02, 0.0012, headLen - 0.04), mat4([0, -0.0065, 0.008]), HF, F);
    B.name(strip, 'deskLamp-diffuser', false);

    // SpotLight mounted under the head, aiming along the head's underside normal
    const light = new THREE.SpotLight(0xffd9a8, 25, 0, 0.7, 0.6, 2);
    light.name = 'deskLamp';
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.near = 0.05;
    light.shadow.camera.far = 4;
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.02;
    const lightLocal = Hc.clone().add(v3(0, -0.012, 0.01));
    const n = v3(0, -Math.cos(headTilt), -Math.sin(headTilt)); // underside normal
    const targetLocal = lightLocal.clone().addScaledVector(n, lightLocal.y / -n.y); // on the desk top
    light.position.copy(lightLocal.applyMatrix4(F));
    light.target.position.copy(targetLocal.applyMatrix4(F));
    group.add(light, light.target);
    ctx.lights.register({ name: 'deskLamp', role: 'lamp', light, emissives: [strip] });

    // power cable: out from under the base rim, over the back edge, down to plug 1
    const backDir = v3(-aimDir.x, 0, -aimDir.y);
    const origin = v3(basePos[0], TOP + 0.005, basePos[2]);
    const [approach, end] = plugEntry[0];
    const lampCable = [
      origin.clone().addScaledVector(backDir, 0.07),
      origin.clone().addScaledVector(backDir, 0.1),
      v3(-0.668, TOP + 0.005, -0.35),
      v3(-0.658, TOP + 0.001, -0.379),
      v3(-0.645, TOP - 0.03, -0.396),
      v3(-0.6, 0.45, -0.41),
      v3(-0.55, 0.15, -0.395),
      v3(approach.x - 0.03, 0.06, approach.z - 0.02),
      approach,
      end,
    ];
    B.put(rubber, tube(lampCable, 0.004, 8, 48));
  }

  // Coffee mug on a cork coaster, front-right.
  {
    const mugPos: [number, number, number] = [0.56, TOP, 0.08];
    const cork = M.custom({ color: 0xb8925f, roughness: 0.92, metalness: 0 });
    B.put(cork, cylinder(0.05, 0.05, 0.004, 48), mat4([mugPos[0] + 0.004, TOP + 0.002, mugPos[2] + 0.003]));
    B.name(cork, 'coaster');
    const glaze = M.ceramic(0x25453a, true);
    const F = mat4([mugPos[0], TOP + 0.004, mugPos[2]], [0, -30 * DEG + jit(8 * DEG), 0]);
    B.put(
      glaze,
      lathe(
        [
          [0, 0], [0.03, 0], [0.038, 0.002], [0.0415, 0.006], [0.043, 0.02], [0.0435, 0.045], [0.0445, 0.08],
          [0.045, 0.093], [0.0445, 0.096], [0.0405, 0.096], [0.039, 0.092], [0.0385, 0.06], [0.038, 0.02],
          [0.034, 0.01], [0.02, 0.008], [0, 0.008],
        ],
        56,
      ),
      F,
    );
    // handle: D-shaped torus arc with its ends buried in the wall
    B.put(glaze, torusArc(0.026, 0.0065, 1.25 * Math.PI, 12, 28), mat4([0.052, 0.05, 0], [0, 0, 0], [1, 1.2, 1]), F);
    B.name(glaze, 'mug');
    // coffee surface 1 cm below the rim
    // black coffee: near-black and only softly reflective (a clearcoat glaze reads as milk)
    const coffee = M.custom({ color: 0x120a05, roughness: 0.3, metalness: 0, specularIntensity: 0.6 });
    B.put(coffee, cylinder(0.039, 0.039, 0.002, 48), mat4([0, 0.086, 0]), F);
    B.name(coffee, 'coffee');
  }

  // A5 notebook with a pen, front-left.
  {
    // x = -0.5 keeps the rotated cover clear of the desk mat's left edge (x = -0.4)
    const F = mat4([-0.5, TOP, 0.15], [0, 8 * DEG + jit(1.5 * DEG), 0]);
    const kraft = M.paper(0xb4855a, { surface: [0.15, 0.21] });
    const cloth = M.custom({ color: 0x2c2926, roughness: 0.95, metalness: 0 });
    // back cover, page block, front cover
    B.put(kraft, roundedBox(0.15, 0.002, 0.21, 0.001, 2), mat4([0, 0.001, 0]), F);
    B.put(whitePaper, box(0.146, 0.011, 0.205), mat4([0.001, 0.0075, 0]), F);
    B.put(kraft, roundedBox(0.15, 0.002, 0.21, 0.001, 2), mat4([0, 0.014, 0]), F);
    B.name(kraft, 'notebook');
    // cloth spine tape on the left edge
    B.put(cloth, roundedBox(0.008, 0.0154, 0.212, 0.001, 2), mat4([-0.071, 0.0077, 0]), F);
    // elastic closure band wrapping the right side
    B.put(cloth, box(0.006, 0.0008, 0.214), mat4([0.058, 0.0154, 0]), F);
    B.put(cloth, box(0.006, 0.0164, 0.0008), mat4([0.058, 0.0078, 0.1066]), F);
    B.put(cloth, box(0.006, 0.0164, 0.0008), mat4([0.058, 0.0078, -0.1066]), F);
    B.name(cloth, 'notebook-cloth');
    // paper label on the front cover
    B.put(whitePaper, box(0.06, 0.0005, 0.034), mat4([0.012, 0.01525, -0.055], [0, 1.5 * DEG, 0]), F);
    // ribbon bookmark drooping out of the bottom edge
    const ribbon = M.plastic(0x7a2a2a, 0.8);
    B.put(ribbon, box(0.008, 0.0006, 0.034), mat4([-0.02, 0.009, 0.118], [6 * DEG, 10 * DEG, 0]), F);
    B.name(ribbon, 'ribbon');

    // pen resting on the cover at ~20°; +z is the tip
    const penAng = 20 * DEG + jit(3 * DEG);
    const PF = mat4([-0.028, 0.015 + 0.0045 - 0.0003, -0.012], [0, penAng, 0]);
    const along: [number, number, number] = [Math.PI / 2, 0, 0]; // cylinder +y → +z
    const penBody = M.plastic(0x1a2340, 0.18);
    B.put(penBody, cylinder(0.0045, 0.0045, 0.098, 20), mat4([0, 0, -0.008], along), PF, F);
    B.put(penBody, cylinder(0.0045, 0.0032, 0.007, 20), mat4([0, 0, -0.0605], along), PF, F);
    B.put(chrome, cylinder(0.0032, 0.0032, 0.002, 16), mat4([0, 0, -0.065], along), PF, F);
    B.put(chrome, cylinder(0.0048, 0.0048, 0.003, 20), mat4([0, 0, 0.0425], along), PF, F);
    B.put(rubber, cylinder(0.0042, 0.0044, 0.022, 20), mat4([0, 0, 0.055], along), PF, F);
    B.put(chrome, cylinder(0.0012, 0.0042, 0.013, 20), mat4([0, 0, 0.0725], along), PF, F);
    B.put(chrome, cylinder(0.0004, 0.0012, 0.003, 10), mat4([0, 0, 0.0805], along), PF, F);
    // clip: raised bar on the upper side toward the back end
    B.put(chrome, roundedBox(0.0035, 0.0015, 0.04, 0.0007, 1), mat4([0, 0.0045 + 0.0006, -0.036]), PF, F);
    B.put(chrome, box(0.0035, 0.0035, 0.003), mat4([0, 0.0038, -0.055]), PF, F);
    B.name(penBody, 'pen');
  }

  // Headphones on an aluminium stand, back-right.
  {
    const F = mat4([0.62, TOP, -0.22], [0, 6 * DEG + jit(3 * DEG), 0]);
    // base disc with a rubber ring underneath
    B.put(alu, lathe([[0, 0], [0.058, 0], [0.061, 0.003], [0.061, 0.009], [0.057, 0.012], [0.014, 0.013], [0, 0.013]], 56), F);
    B.put(rubber, cylinder(0.05, 0.05, 0.0015, 40), mat4([0, 0.0007, 0]), F);
    // curved rod: rises then hooks forward into a saddle
    const rod = [
      v3(0, 0.01, 0), v3(0, 0.1, 0), v3(0, 0.2, 0), v3(0, 0.25, 0.008), v3(0, 0.275, 0.03),
      v3(0, 0.283, 0.06), v3(0, 0.28, 0.085), v3(0, 0.268, 0.1), v3(0, 0.252, 0.107),
    ];
    B.put(alu, tube(rod, 0.006, 12, 40), F);
    B.put(alu, new THREE.SphereGeometry(0.0065, 12, 8), mat4([0, 0.252, 0.107]), F);
    // saddle pad the headband rests on
    const saddleZ = 0.062;
    B.put(rubber, roundedBox(0.03, 0.01, 0.05, 0.004, 2), mat4([0, 0.283, saddleZ]), F);

    // headphones hang from the saddle; their plane is XY at z = saddleZ
    const HF = mat4([0, 0, saddleZ], [0, 0, jit(2 * DEG)]);
    const R = 0.088;
    const cy = 0.288 - (R - 0.0022 - 0.011); // cushion inner surface touches the saddle top
    const band = torusArc(R, 0.0022, Math.PI + 20 * DEG, 8, 48);
    band.rotateZ(Math.PI / 2); // centre the arc on +y
    B.put(alu, band, mat4([0, cy, 0], [0, 0, 0], [1, 1, 5.5]), HF, F);
    const cushion = torusArc(R - 0.0022 - 0.0055, 0.0055, 70 * DEG, 10, 24);
    cushion.rotateZ(Math.PI / 2);
    B.put(leatherBlack, cushion, mat4([0, cy, 0], [0, 0, 0], [1, 1, 3]), HF, F);
    // ear cups
    const endA = -10 * DEG;
    const cupPlastic = M.plastic(0x1e1f22, 0.5);
    for (const side of [-1, 1]) {
      const ex = side * R * Math.cos(endA);
      const ey = cy + R * Math.sin(endA);
      B.put(alu, cylBetween(v3(ex, ey + 0.004, 0), v3(ex, ey - 0.04, 0), 0.0035, 12), HF, F);
      const cupTop = ey - 0.035;
      const CF = mat4([side * (R + 0.006), cupTop - 0.049, 0], [0, 0, side * (2 * DEG + jit(1.5 * DEG))]);
      B.put(alu, cylinder(0.006, 0.006, 0.016, 16), mat4([0, 0.049, 0], [Math.PI / 2, 0, 0]), CF, HF, F);
      B.put(cupPlastic, roundedBox(0.03, 0.098, 0.078, 0.014, 3), CF, HF, F);
      // aluminium accent ring on the outer shell
      B.put(alu, torusArc(0.026, 0.002, Math.PI * 2, 6, 40), mat4([side * 0.0152, 0, 0], [0, Math.PI / 2, 0], [1, 1.2, 1]), CF, HF, F);
      // leather pad on the inner face, driver mesh disc inside the ring
      B.put(leatherBlack, new THREE.TorusGeometry(0.028, 0.011, 12, 36), mat4([-side * 0.02, 0, 0], [0, Math.PI / 2, 0], [1, 1.25, 1]), CF, HF, F);
      B.put(darkPlastic, cylinder(0.026, 0.026, 0.002, 32), mat4([-side * 0.015, 0, 0], [0, 0, Math.PI / 2], [1.25, 1, 1]), CF, HF, F);
    }
    B.name(cupPlastic, 'headphone-cups');
    B.name(leatherBlack, 'headphone-pads');
  }

  // Succulent in a concrete pot, left of the monitor.
  {
    const F = mat4([-0.43, TOP, -0.29], [0, jit(Math.PI), 0]);
    const concrete = M.concrete({ surface: [0.25, 0.08] });
    B.put(
      concrete,
      lathe(
        [
          [0, 0], [0.03, 0], [0.033, 0.002], [0.037, 0.028], [0.0395, 0.064], [0.04, 0.07], [0.036, 0.07],
          [0.035, 0.05], [0.033, 0.012], [0.02, 0.01], [0, 0.01],
        ],
        56,
      ),
      F,
    );
    B.name(concrete, 'pot');
    const soil = M.custom({ color: 0x2a201a, roughness: 1, metalness: 0 });
    B.put(soil, cylinder(0.0355, 0.0355, 0.003, 40), mat4([0, 0.0565, 0]), F);
    B.put(soil, cylinder(0.008, 0.01, 0.018, 12), mat4([0, 0.066, 0]), F); // stubby stem
    B.name(soil, 'soil');

    // rosette of leaves with vertex-coloured pink tips
    const leafMat = M.custom({
      color: 0xffffff, roughness: 0.55, metalness: 0, vertexColors: true,
      sheen: 0.4, sheenColor: new THREE.Color(0xdfe8d0), sheenRoughness: 0.7,
    });
    const base = new THREE.Color(0x6f9d70);
    const inner = new THREE.Color(0x9cc494);
    const tip = new THREE.Color(0xc35a66);
    const rings = [
      { n: 4, len: 0.016, wid: 0.009, thick: 0.005, tilt: 78, off: 0.0 },
      { n: 7, len: 0.026, wid: 0.014, thick: 0.0055, tilt: 55, off: 0.003 },
      { n: 10, len: 0.034, wid: 0.017, thick: 0.006, tilt: 32, off: 0.007 },
      { n: 12, len: 0.038, wid: 0.019, thick: 0.006, tilt: 12, off: 0.011 },
    ];
    const rosetteY = 0.074;
    const c = new THREE.Color();
    rings.forEach((ring, ri) => {
      for (let i = 0; i < ring.n; i++) {
        const yawL = (i / ring.n) * Math.PI * 2 + ri * 0.9 + jit(0.12);
        const tiltL = (ring.tilt + jit(6)) * DEG;
        const len = ring.len * (1 + jit(0.1));
        const g = new THREE.SphereGeometry(1, 12, 8);
        const pos = g.attributes.position;
        const colors = new Float32Array(pos.count * 3);
        for (let k = 0; k < pos.count; k++) {
          const tz = (pos.getZ(k) + 1) / 2; // 0 base .. 1 tip
          c.lerpColors(inner, base, smoothstep(0, 0.5, tz));
          c.lerp(tip, smoothstep(0.62, 1, tz) * (0.7 + (0.3 * ri) / 3));
          colors[k * 3] = c.r;
          colors[k * 3 + 1] = c.g;
          colors[k * 3 + 2] = c.b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const local = mat4([0, rosetteY, 0], [0, yawL, 0])
          .multiply(mat4([0, 0, ring.off], [-tiltL, 0, 0]))
          .multiply(mat4([0, 0, len / 2], [0, 0, 0], [ring.wid / 2, ring.thick / 2, len / 2]));
        B.put(leafMat, g, local, F);
      }
    });
    B.name(leafMat, 'succulent');
  }

  // Smartphone, face up, front-right.
  {
    // front-right corner on bare wood: clear of the mat (x ≤ 0.5, z ≤ 0.28) and the mug
    const F = mat4([0.56, TOP, 0.25], [0, -12 * DEG + jit(3 * DEG), 0]);
    // the camera island lifts the top end ~1.5 mm → slight tilt about x
    const tiltX = Math.atan(0.0015 / 0.12);
    const PF = mat4([0, 0.004 + 0.0007, 0], [tiltX, 0, 0]);
    B.put(alu, roundedBox(0.072, 0.008, 0.15, 0.002, 3), PF, F);
    B.put(alu, roundedBox(0.03, 0.0015, 0.03, 0.0007, 1), mat4([-0.019, -0.0045, -0.058]), PF, F);
    // side buttons
    B.put(alu, roundedBox(0.0016, 0.0032, 0.014, 0.0006, 1), mat4([0.0365, 0, -0.028]), PF, F);
    B.put(alu, roundedBox(0.0016, 0.0032, 0.01, 0.0006, 1), mat4([-0.0365, 0, -0.032]), PF, F);
    B.put(alu, roundedBox(0.0016, 0.0032, 0.01, 0.0006, 1), mat4([-0.0365, 0, -0.018]), PF, F);
    // glass with an always-on lock screen (canvas → emissive map)
    const lockTex = ctx.textures.canvas('deskAccessories:phoneLock', 256, 512, (g, w, h) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.88)';
      g.strokeStyle = 'rgba(255,255,255,0.88)';
      const lx = w / 2;
      const ly = 88;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(lx, ly - 2, 9, Math.PI, 0);
      g.stroke();
      g.beginPath();
      g.roundRect(lx - 13, ly - 2, 26, 20, 4);
      g.fill();
      g.textAlign = 'center';
      g.font = '200 78px "Helvetica Neue", Helvetica, Arial, sans-serif';
      g.fillText('21:47', w / 2, 196);
      g.font = '400 18px "Helvetica Neue", Helvetica, Arial, sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.fillText('Saturday, 19 September', w / 2, 226);
      g.fillStyle = 'rgba(255,255,255,0.16)';
      g.beginPath();
      g.roundRect(28, 262, w - 56, 44, 10);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.beginPath();
      g.roundRect(40, 274, 20, 20, 5);
      g.fill();
      g.textAlign = 'left';
      g.font = '500 13px "Helvetica Neue", Helvetica, Arial, sans-serif';
      g.fillText('Calendar', 70, 280);
      g.font = '400 12px "Helvetica Neue", Helvetica, Arial, sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillText('Standup in 15 min', 70, 297);
    });
    const glass = M.custom({
      color: 0x07080a,
      roughness: 0.1,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      emissive: 0xffffff,
      emissiveMap: lockTex,
      emissiveIntensity: 0.9,
    });
    B.put(glass, box(0.0665, 0.0006, 0.1445), mat4([0, 0.0041, 0]), PF, F);
    B.name(glass, 'phone-screen');
    ctx.lights.register({ name: 'phoneScreen', role: 'screen', emissives: [glass] });
  }

  // mains lead: over the cable tray's back rim (y = 0.6485, z = -0.35), down behind the desk to plug 2
  {
    const [approach, end] = plugEntry[1];
    const pts = [
      v3(0.41, 0.574, -0.27),
      v3(0.35, 0.575, -0.285),
      v3(0.3, 0.6, -0.315),
      v3(0.27, 0.635, -0.34),
      v3(0.245, 0.6535, -0.351),
      v3(0.215, 0.652, -0.372),
      v3(0.17, 0.62, -0.395),
      v3(0.05, 0.45, -0.412),
      v3(-0.12, 0.2, -0.412),
      v3(-0.27, 0.075, -0.402),
      v3(approach.x + 0.05, 0.056, approach.z - 0.02),
      approach,
      end,
    ];
    B.put(rubber, tube(pts, 0.0045, 8, 56));
  }
  B.name(rubber, 'rubber-parts');

  B.build(group);
  return group;
}
