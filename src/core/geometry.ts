import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export { mergeGeometries };

/** Box with softly rounded edges. */
export function roundedBox(w: number, h: number, d: number, radius = 0.01, segments = 3): THREE.BufferGeometry {
  const r = Math.min(radius, w / 2, h / 2, d / 2);
  return new RoundedBoxGeometry(w, h, d, segments, r);
}

export function box(w: number, h: number, d: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/** Mesh that casts and receives shadows unless told otherwise. */
export function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  position?: [number, number, number],
  options: { cast?: boolean; receive?: boolean; name?: string } = {},
): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = options.cast ?? true;
  m.receiveShadow = options.receive ?? true;
  if (position) m.position.set(...position);
  if (options.name) m.name = options.name;
  return m;
}

export function enableShadows(root: THREE.Object3D, cast = true, receive = true): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
}

export function cylinder(rTop: number, rBottom: number, height: number, segments = 32, open = false): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, height, segments, 1, open);
}

/** Lathe from a (radius, y) profile. */
export function lathe(profile: Array<[number, number]>, segments = 48): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );
}

/** Tube following a smooth curve through `points`. */
export function tube(points: THREE.Vector3[], radius: number, radialSegments = 8, tubularSegments = 32, closed = false): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.5);
  return new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, closed);
}

/** Extrude an XY outline along Z. */
export function extrudeOutline(points: Array<[number, number]>, depth: number, bevel = 0.004): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 12,
  });
}

/** Symmetric jitter in [-amount, amount]. */
export function jitter(rng: () => number, amount: number): number {
  return (rng() - 0.5) * 2 * amount;
}
