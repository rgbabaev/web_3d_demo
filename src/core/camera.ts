import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ROOM } from './types';

export type ViewName = 'overview' | 'desk' | 'sofa' | 'window';

interface View {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export const VIEWS: Record<ViewName, View> = {
  overview: { position: [2.35, 1.52, 2.0], target: [-0.5, 1.12, -1.0], fov: 58 },
  desk: { position: [0.55, 1.45, 0.35], target: [-1.25, 0.95, -1.7], fov: 50 },
  sofa: { position: [-0.75, 1.4, 1.95], target: [2.3, 0.8, 0.1], fov: 54 },
  window: { position: [-2.7, 1.5, 1.7], target: [-0.9, 1.3, -2.1], fov: 55 },
};

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  setView(name: ViewName, animate?: boolean): void;
  update(dt: number): void;
}

const INSET = 0.18;
const bounds = new THREE.Box3(
  new THREE.Vector3(-ROOM.width / 2 + INSET, 0.25, -ROOM.depth / 2 + INSET),
  new THREE.Vector3(ROOM.width / 2 - INSET, ROOM.height - INSET, ROOM.depth / 2 - INSET),
);

export function createCameraRig(canvas: HTMLCanvasElement, aspect: number): CameraRig {
  const camera = new THREE.PerspectiveCamera(55, aspect, 0.05, 60);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.4;
  controls.maxDistance = 6;
  controls.maxPolarAngle = Math.PI * 0.53;
  controls.minPolarAngle = Math.PI * 0.12;
  controls.zoomSpeed = 0.8;
  controls.rotateSpeed = 0.6;
  controls.panSpeed = 0.6;
  controls.screenSpacePanning = true;

  let tween: { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; fromFov: number; toFov: number; t: number } | null = null;

  const setView = (name: ViewName, animate = true): void => {
    const v = VIEWS[name];
    const to = new THREE.Vector3(...v.position);
    const toT = new THREE.Vector3(...v.target);
    if (!animate) {
      tween = null;
      camera.position.copy(to);
      controls.target.copy(toT);
      camera.fov = v.fov;
      camera.updateProjectionMatrix();
      controls.update();
      return;
    }
    tween = { from: camera.position.clone(), to, fromT: controls.target.clone(), toT, fromFov: camera.fov, toFov: v.fov, t: 0 };
  };

  const update = (dt: number): void => {
    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 1.1);
      const e = 1 - Math.pow(1 - tween.t, 3);
      camera.position.lerpVectors(tween.from, tween.to, e);
      controls.target.lerpVectors(tween.fromT, tween.toT, e);
      camera.fov = tween.fromFov + (tween.toFov - tween.fromFov) * e;
      camera.updateProjectionMatrix();
      if (tween.t >= 1) tween = null;
    }
    controls.update();
    // Stay inside the walls.
    camera.position.clamp(bounds.min, bounds.max);
    controls.target.clamp(bounds.min, bounds.max);
  };

  return { camera, controls, setView, update };
}
