import * as THREE from 'three';
import type { TextureLibrary, TextureSet, WoodKind } from './textures';

export interface SurfaceOptions {
  /** Physical size of the UV 0..1 square in metres → texture repeat. */
  surface?: [number, number];
  /** Rotate the texture 90° (grain across instead of along). */
  rotate?: boolean;
  /** Random-looking UV offset so adjacent boards don't show identical grain. */
  offset?: [number, number];
}

export type MetalKind = 'chrome' | 'brushedSteel' | 'aluminum' | 'blackMatte' | 'blackGloss' | 'brass' | 'copper' | 'gunmetal';
export type Sheen = 'matte' | 'satin' | 'gloss';

function applySet(mat: THREE.MeshPhysicalMaterial, set: TextureSet, opts: SurfaceOptions = {}): void {
  const [sw, sh] = opts.surface ?? set.tile;
  const rx = sw / set.tile[0];
  const ry = sh / set.tile[1];
  const [ox, oy] = opts.offset ?? [0, 0];
  const prep = (t: THREE.Texture): THREE.Texture => {
    const c = t.clone();
    c.repeat.set(rx, ry);
    c.offset.set(ox, oy);
    if (opts.rotate) {
      c.center.set(0.5, 0.5);
      c.rotation = Math.PI / 2;
    }
    c.needsUpdate = true;
    return c;
  };
  mat.map = prep(set.map);
  if (set.normalMap) mat.normalMap = prep(set.normalMap);
  if (set.roughnessMap) {
    mat.roughnessMap = prep(set.roughnessMap);
    mat.roughness = 1; // the map carries the value
  }
}

const keyOf = (parts: unknown[]): string => parts.map((p) => (Array.isArray(p) ? p.join('x') : String(p))).join('|');

export class MaterialLibrary {
  private cache = new Map<string, THREE.Material>();

  constructor(readonly textures: TextureLibrary) {}

  private memo<T extends THREE.Material>(key: string, build: () => T): T {
    let m = this.cache.get(key) as T | undefined;
    if (!m) {
      m = build();
      m.name = key;
      this.cache.set(key, m);
    }
    return m;
  }

  /** Varnished oak planks. `surface` is the floor size, so boards come out 0.16 m wide. */
  floorOak(surface: [number, number]): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['floorOak', surface]), () => {
      const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0 });
      applySet(m, this.textures.floorPlanks(), { surface });
      m.normalScale.set(0.6, 0.6);
      m.clearcoat = 0.35;
      m.clearcoatRoughness = 0.35;
      m.envMapIntensity = 0.9;
      return m;
    });
  }

  wallPlaster(color: number, surface: [number, number] = [3, 3]): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['plaster', color, surface]), () => {
      const m = new THREE.MeshPhysicalMaterial({ color, metalness: 0 });
      applySet(m, this.textures.plaster(), { surface });
      m.normalScale.set(0.5, 0.5);
      m.envMapIntensity = 0.7;
      return m;
    });
  }

  /** Painted wood: keeps the grain relief but drops the grain colour. */
  paintedWood(color: number, sheen: Sheen = 'satin', opts: SurfaceOptions = {}): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['painted', color, sheen, opts.surface ?? '', opts.rotate ?? false]), () => {
      const m = new THREE.MeshPhysicalMaterial({ color, metalness: 0 });
      applySet(m, this.textures.wood('ash'), opts);
      m.map = null; // keep paint color, but leave the subtle grain relief
      m.normalScale.set(0.15, 0.15);
      const rough = { matte: 0.8, satin: 0.45, gloss: 0.2 }[sheen];
      m.roughnessMap = null;
      m.roughness = rough;
      if (sheen !== 'matte') {
        m.clearcoat = sheen === 'gloss' ? 0.6 : 0.25;
        m.clearcoatRoughness = sheen === 'gloss' ? 0.15 : 0.4;
      }
      return m;
    });
  }

  wood(kind: WoodKind = 'walnut', opts: SurfaceOptions & { finish?: Sheen } = {}): THREE.MeshPhysicalMaterial {
    const finish = opts.finish ?? 'satin';
    return this.memo(keyOf(['wood', kind, finish, opts.surface ?? '', opts.rotate ?? false, opts.offset ?? '']), () => {
      const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0 });
      applySet(m, this.textures.wood(kind), opts);
      m.normalScale.set(0.5, 0.5);
      if (finish === 'gloss') {
        m.clearcoat = 0.8;
        m.clearcoatRoughness = 0.12;
      } else if (finish === 'satin') {
        m.clearcoat = 0.3;
        m.clearcoatRoughness = 0.4;
      }
      m.envMapIntensity = 0.9;
      return m;
    });
  }

  metal(kind: MetalKind): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['metal', kind]), () => {
      const m = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: 0.3 });
      switch (kind) {
        case 'chrome':
          m.color.set(0xf4f4f4);
          m.roughness = 0.08;
          break;
        case 'brushedSteel':
          m.color.set(0xd8d9dc);
          applySet(m, this.textures.brushedMetal(), { surface: [0.5, 0.5] });
          m.normalScale.set(0.3, 0.3);
          break;
        case 'aluminum':
          m.color.set(0xcfd2d6);
          m.roughness = 0.38;
          break;
        case 'blackMatte':
          m.color.set(0x1b1b1d);
          m.metalness = 0.9;
          m.roughness = 0.62;
          break;
        case 'blackGloss':
          m.color.set(0x111113);
          m.metalness = 0.85;
          m.roughness = 0.18;
          m.clearcoat = 0.6;
          m.clearcoatRoughness = 0.1;
          break;
        case 'brass':
          m.color.set(0xd9b06c);
          m.roughness = 0.32;
          break;
        case 'copper':
          m.color.set(0xc97a52);
          m.roughness = 0.3;
          break;
        case 'gunmetal':
          m.color.set(0x4a4d52);
          m.roughness = 0.42;
          break;
      }
      return m;
    });
  }

  /** Upholstery, with sheen for the rim light soft fibres give. */
  fabric(color: number, opts: SurfaceOptions & { boucle?: boolean; scale?: number } = {}): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['fabric', color, opts.boucle ?? false, opts.scale ?? 1, opts.surface ?? '']), () => {
      const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0 });
      applySet(m, this.textures.fabric(color, { boucle: opts.boucle, scale: opts.scale }), opts);
      m.normalScale.set(0.7, 0.7);
      m.sheen = 0.6;
      m.sheenRoughness = 0.8;
      m.sheenColor.set(color).lerp(new THREE.Color(0xffffff), 0.5);
      m.envMapIntensity = 0.6;
      return m;
    });
  }

  /** Linen, double-sided for hanging cloth. */
  linen(color: number, opts: SurfaceOptions = {}): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['linen', color, opts.surface ?? '']), () => {
      const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, side: THREE.DoubleSide });
      applySet(m, this.textures.linen(color), opts);
      m.normalScale.set(0.4, 0.4);
      m.sheen = 0.5;
      m.sheenRoughness = 0.9;
      m.sheenColor.set(0xffffff);
      return m;
    });
  }

  leather(color: number, opts: SurfaceOptions = {}): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['leather', color, opts.surface ?? '']), () => {
      const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0 });
      applySet(m, this.textures.leather(color), opts);
      m.normalScale.set(0.6, 0.6);
      m.clearcoat = 0.15;
      m.clearcoatRoughness = 0.5;
      m.sheen = 0.2;
      m.sheenColor.set(color);
      return m;
    });
  }

  plastic(color: number, roughness = 0.45): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['plastic', color, roughness]), () => {
      const m = new THREE.MeshPhysicalMaterial({ color, metalness: 0, roughness });
      m.clearcoat = roughness < 0.3 ? 0.5 : 0;
      m.clearcoatRoughness = 0.2;
      m.specularIntensity = 0.7;
      return m;
    });
  }

  rubber(color = 0x1a1a1a): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['rubber', color]), () =>
      new THREE.MeshPhysicalMaterial({ color, metalness: 0, roughness: 0.85, specularIntensity: 0.4 }),
    );
  }

  ceramic(color: number, gloss = true): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['ceramic', color, gloss]), () => {
      const m = new THREE.MeshPhysicalMaterial({ color, metalness: 0, roughness: gloss ? 0.12 : 0.6 });
      if (gloss) {
        m.clearcoat = 1;
        m.clearcoatRoughness = 0.08;
      }
      return m;
    });
  }

  /** Thin glass. Alpha rather than transmission, so a large pane costs no second scene render. */
  glass(opts: { tint?: number; opacity?: number; roughness?: number } = {}): THREE.MeshPhysicalMaterial {
    const { tint = 0xf2f7fa, opacity = 0.12, roughness = 0.03 } = opts;
    return this.memo(keyOf(['glass', tint, opacity, roughness]), () => {
      const m = new THREE.MeshPhysicalMaterial({
        color: tint,
        metalness: 0,
        roughness,
        transparent: true,
        opacity,
        ior: 1.5,
        specularIntensity: 1,
        envMapIntensity: 1.2,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      return m;
    });
  }

  /** Solid glass: real refraction, so only for small objects. */
  solidGlass(tint = 0xffffff): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['solidGlass', tint]), () =>
      new THREE.MeshPhysicalMaterial({
        color: tint,
        metalness: 0,
        roughness: 0.05,
        transmission: 1,
        thickness: 0.05,
        ior: 1.5,
        attenuationColor: new THREE.Color(0xdfe9e6),
        attenuationDistance: 0.4,
        specularIntensity: 1,
      }),
    );
  }

  paper(color = 0xf4f1ea, opts: SurfaceOptions = {}): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['paper', color, opts.surface ?? '']), () => {
      const m = new THREE.MeshPhysicalMaterial({ color, metalness: 0 });
      applySet(m, this.textures.paper(), opts);
      m.normalScale.set(0.3, 0.3);
      return m;
    });
  }

  concrete(opts: SurfaceOptions = {}): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['concrete', opts.surface ?? '']), () => {
      const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0 });
      applySet(m, this.textures.concrete(), opts);
      m.normalScale.set(0.5, 0.5);
      return m;
    });
  }

  /** Not cached: callers mutate emissiveIntensity per instance. */
  emissive(color: number, intensity = 4, base = 0x111111): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color: base, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
  }

  /** Screen panel; the emissive map carries the picture. */
  screen(kind: 'ide' | 'desktop' | 'off' = 'ide', intensity = 1.6): THREE.MeshPhysicalMaterial {
    return this.memo(keyOf(['screen', kind, intensity]), () => {
      const tex = this.textures.screen(kind);
      const m = new THREE.MeshPhysicalMaterial({
        color: 0x050505,
        roughness: 0.25,
        metalness: 0,
        emissive: 0xffffff,
        emissiveMap: tex,
        emissiveIntensity: kind === 'off' ? 0 : intensity,
        clearcoat: 0.8,
        clearcoatRoughness: 0.08,
      });
      return m;
    });
  }

  custom(params: THREE.MeshPhysicalMaterialParameters): THREE.MeshPhysicalMaterial {
    return new THREE.MeshPhysicalMaterial(params);
  }
}
