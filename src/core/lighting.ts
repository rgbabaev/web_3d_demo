import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { ROOM, type LightRegistry, type Quality, type RegisteredLight } from './types';

export type PresetName = 'day' | 'golden' | 'night';

export interface LightPreset {
  sunIntensity: number;
  sunColor: number;
  /** Sun position relative to the window centre. */
  sunOffset: [number, number, number];
  skyIntensity: number;
  skyColor: number;
  lamps: number;
  ceiling: number;
  screen: number;
  exposure: number;
  exterior: number;
  exteriorColor: number;
  hemisphere: number;
}

export const PRESETS: Record<PresetName, LightPreset> = {
  day: {
    sunIntensity: 3.6,
    sunColor: 0xfff3e0,
    sunOffset: [-2.5, 5.5, -7],
    skyIntensity: 3.2,
    skyColor: 0xcfe1ff,
    lamps: 0,
    ceiling: 0,
    screen: 1,
    exposure: 0.95,
    exterior: 1.6,
    exteriorColor: 0xffffff,
    hemisphere: 0.35,
  },
  golden: {
    sunIntensity: 4.2,
    sunColor: 0xffc27a,
    sunOffset: [-4.2, 2.6, -7],
    skyIntensity: 1.6,
    skyColor: 0xffd9c0,
    lamps: 0.26,
    ceiling: 0,
    screen: 1,
    exposure: 1.0,
    exterior: 1.1,
    exteriorColor: 0xffd6b0,
    hemisphere: 0.25,
  },
  night: {
    sunIntensity: 0,
    sunColor: 0xffffff,
    sunOffset: [-4, 3, -7],
    skyIntensity: 0.12,
    skyColor: 0x6f86c9,
    lamps: 1,
    ceiling: 1,
    screen: 1.3,
    exposure: 1.15,
    exterior: 0.05,
    exteriorColor: 0x3a4a80,
    hemisphere: 0.06,
  },
};

export class LightRegistryImpl implements LightRegistry {
  private entries: RegisteredLight[] = [];

  register(entry: Parameters<LightRegistry['register']>[0]): RegisteredLight {
    const full: RegisteredLight = {
      ...entry,
      baseIntensity: entry.baseIntensity ?? entry.light?.intensity ?? 0,
      baseEmissive: entry.baseEmissive ?? entry.emissives?.[0]?.emissiveIntensity ?? 0,
    };
    this.entries.push(full);
    return full;
  }
  all(): readonly RegisteredLight[] {
    return this.entries;
  }
}

export interface LightRig {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  sky: THREE.RectAreaLight;
  hemisphere: THREE.HemisphereLight;
  applyPreset(name: PresetName, renderer: THREE.WebGLRenderer, registry: LightRegistry): void;
  exteriorMaterials: THREE.MeshBasicMaterial[];
}

export function createLightRig(quality: Quality): LightRig {
  RectAreaLightUniformsLib.init();
  const group = new THREE.Group();
  group.name = 'lights';

  const winCx = ROOM.window.x;
  const winCy = (ROOM.window.sill + ROOM.window.top) / 2;
  const winZ = -ROOM.depth / 2;

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.name = 'sun';
  sun.castShadow = true;
  const mapSize = quality === 'high' ? 4096 : 2048;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 30;
  sun.shadow.camera.left = -5;
  sun.shadow.camera.right = 5;
  sun.shadow.camera.top = 4;
  sun.shadow.camera.bottom = -4;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.006;
  sun.shadow.radius = quality === "high" ? 3 : 2;
  sun.target.position.set(winCx + 1.2, 0, 0.2);
  group.add(sun, sun.target);

  const sky = new THREE.RectAreaLight(0xcfe1ff, 3, ROOM.window.width, ROOM.window.top - ROOM.window.sill);
  sky.name = 'skyFill';
  sky.position.set(winCx, winCy, winZ + 0.02);
  sky.lookAt(winCx, winCy, 0); // face into the room
  group.add(sky);

  const hemisphere = new THREE.HemisphereLight(0xbfd0e8, 0x6b5238, 0.3);
  hemisphere.name = 'hemisphere';
  group.add(hemisphere);

  const exteriorMaterials: THREE.MeshBasicMaterial[] = [];

  const applyPreset = (name: PresetName, renderer: THREE.WebGLRenderer, registry: LightRegistry): void => {
    const p = PRESETS[name];
    sun.intensity = p.sunIntensity;
    sun.color.set(p.sunColor);
    sun.visible = p.sunIntensity > 0;
    sun.position.set(winCx + p.sunOffset[0], winCy + p.sunOffset[1], winZ + p.sunOffset[2]);
    sky.intensity = p.skyIntensity;
    sky.color.set(p.skyColor);
    hemisphere.intensity = p.hemisphere;
    renderer.toneMappingExposure = p.exposure;
    for (const e of registry.all()) {
      const factor = { lamp: p.lamps, ceiling: p.ceiling, screen: p.screen }[e.role];
      if (e.light) {
        e.light.intensity = e.baseIntensity * factor;
        e.light.visible = e.light.intensity > 0.001;
      }
      for (const m of e.emissives ?? []) m.emissiveIntensity = e.baseEmissive * factor;
    }
    for (const m of exteriorMaterials) {
      m.color.set(p.exteriorColor).multiplyScalar(p.exterior);
    }
  };

  return { group, sun, sky, hemisphere, applyPreset, exteriorMaterials };
}
