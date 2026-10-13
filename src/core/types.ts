import type * as THREE from 'three';
import type { MaterialLibrary } from './materials';
import type { TextureLibrary } from './textures';

export type LightRole = 'ceiling' | 'lamp' | 'screen';

export interface RegisteredLight {
  name: string;
  role: LightRole;
  light?: THREE.Light;
  /** Materials whose emissiveIntensity follows the light. */
  emissives?: THREE.MeshStandardMaterial[];
  /** Full-power values; presets scale these. */
  baseIntensity: number;
  baseEmissive: number;
}

export interface LightRegistry {
  register(entry: Omit<RegisteredLight, 'baseIntensity' | 'baseEmissive'> & Partial<Pick<RegisteredLight, 'baseIntensity' | 'baseEmissive'>>): RegisteredLight;
  all(): readonly RegisteredLight[];
}

export type Quality = 'low' | 'high';

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  textures: TextureLibrary;
  materials: MaterialLibrary;
  lights: LightRegistry;
  quality: Quality;
  seed: number;
}

export const ROOM = {
  width: 6.2, // x
  depth: 4.6, // z
  height: 2.75, // y
  wallThickness: 0.2,
  window: {
    /** centre x on the back wall (z = -depth/2) */
    x: -1.2,
    width: 2.2,
    sill: 0.85,
    top: 2.5,
  },
  door: {
    /** on the left wall (x = -width/2) */
    z: 1.45,
    width: 0.9,
    height: 2.1,
  },
} as const;

export type ModuleFactory = (ctx: SceneContext) => THREE.Group;
