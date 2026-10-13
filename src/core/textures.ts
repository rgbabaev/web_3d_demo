import * as THREE from 'three';
import { clamp01, createRng, fbm, gradientNoise, lerp, smoothstep, worley } from './noise';

export interface TextureSet {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  /** Metres covered by one repeat in (u, v). */
  tile: [number, number];
}

interface Sample {
  r: number; // sRGB 0..1
  g: number;
  b: number;
  h: number; // height 0..1
  rough: number; // roughness 0..1
}

type Shader = (u: number, v: number, out: Sample) => void;

interface GenerateOptions {
  size: number;
  tile: [number, number];
  normalStrength?: number;
  anisotropy: number;
  /** Skip the normal map. */
  flat?: boolean;
}

function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function heightToNormal(height: Float32Array, size: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const s = strength * size * 0.02;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      // Sobel-lite central differences with wrap-around so the map tiles.
      const dx = (height[y * size + xp] - height[y * size + xm]) * s;
      const dy = (height[yp * size + x] - height[ym * size + x]) * s;
      const len = Math.hypot(dx, dy, 1);
      const nx = -dx / len;
      const ny = -dy / len;
      const nz = 1 / len;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

function makeDataTexture(
  data: Uint8ClampedArray,
  size: number,
  srgb: boolean,
  anisotropy: number,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function generate(shader: Shader, opts: GenerateOptions): TextureSet {
  const { size } = opts;
  const color = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const s: Sample = { r: 0, g: 0, b: 0, h: 0.5, rough: 0.5 };
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      s.h = 0.5;
      s.rough = 0.5;
      shader(x * inv, y * inv, s);
      const i = (y * size + x) * 4;
      color[i] = clamp01(s.r) * 255;
      color[i + 1] = clamp01(s.g) * 255;
      color[i + 2] = clamp01(s.b) * 255;
      color[i + 3] = 255;
      const rv = clamp01(s.rough) * 255;
      rough[i] = rv;
      rough[i + 1] = rv;
      rough[i + 2] = rv;
      rough[i + 3] = 255;
      height[y * size + x] = s.h;
    }
  }
  const set: TextureSet = {
    map: makeDataTexture(color, size, true, opts.anisotropy),
    roughnessMap: makeDataTexture(rough, size, false, opts.anisotropy),
    tile: opts.tile,
  };
  if (!opts.flat) {
    set.normalMap = makeDataTexture(
      heightToNormal(height, size, opts.normalStrength ?? 1),
      size,
      false,
      opts.anisotropy,
    );
  }
  return set;
}

export type WoodKind = 'walnut' | 'oak' | 'ash' | 'black' | 'birch';

const WOOD_COLORS: Record<WoodKind, { light: number; dark: number; ring: number }> = {
  walnut: { light: 0x6b4a30, dark: 0x3a2517, ring: 0x2b1a10 },
  oak: { light: 0xc7a675, dark: 0x9a7448, ring: 0x7a5731 },
  ash: { light: 0xdcc7a4, dark: 0xb69c74, ring: 0x9c8058 },
  black: { light: 0x232120, dark: 0x141312, ring: 0x0c0b0b },
  birch: { light: 0xe6d3ae, dark: 0xcdb687, ring: 0xb89c6c },
};

function woodGrain(
  u: number,
  v: number,
  seed: number,
  kind: WoodKind,
  out: Sample,
  streakScale = 1,
): void {
  const c = WOOD_COLORS[kind];
  const light = hexToRgb(c.light);
  const dark = hexToRgb(c.dark);
  const ring = hexToRgb(c.ring);

  // Growth rings are circles around the log's pith, which lies outside the board
  // and wanders along its length; the saw cuts them into arcs. Modulating a ring
  // term in v alone instead would draw dead-straight parallel lines at any size.
  const wander = fbm(u * 1.3, 0.5, 3, seed + 5);
  const pithDepth = 0.30 + (wander * 0.5 + 0.5) * 0.3;
  const wobble = fbm(u * 5, v * 5, 3, seed + 3) * 0.018;
  const radius = Math.hypot(v + 0.3, pithDepth) + wobble;
  const rings = Math.sin(radius * 32 * Math.PI * 2);
  const figure = fbm(u * 3, v * 3, 2, seed + 9) * 0.5 + 0.5;
  const ringT = smoothstep(0.15, 0.95, rings) * (0.5 + 0.5 * figure);

  const streak = fbm(u * 5 * streakScale, v * 38 * streakScale, 4, seed + 11) * 0.5 + 0.5;
  const tone = fbm(u * 0.8, v * 2, 2, seed + 17) * 0.5 + 0.5;
  const pores = gradientNoise(u * 40, v * 420, seed + 23);

  const t = clamp01(streak * 0.42 + ringT * 0.3 + tone * 0.2 + 0.04);
  out.r = lerp(light[0], dark[0], t);
  out.g = lerp(light[1], dark[1], t);
  out.b = lerp(light[2], dark[2], t);
  const rt = ringT * 0.3;
  out.r = lerp(out.r, ring[0], rt);
  out.g = lerp(out.g, ring[1], rt);
  out.b = lerp(out.b, ring[2], rt);
  out.h = 0.5 + (streak - 0.5) * 0.2 - ringT * 0.08 + pores * 0.03;
  out.rough = 0.48 + ringT * 0.08 + (streak - 0.5) * 0.1 + pores * 0.03;
}

export class TextureLibrary {
  private cache = new Map<string, TextureSet>();
  private canvasCache = new Map<string, THREE.CanvasTexture>();

  constructor(private readonly anisotropy: number) {}

  private memo(key: string, build: () => TextureSet): TextureSet {
    let t = this.cache.get(key);
    if (!t) {
      t = build();
      this.cache.set(key, t);
    }
    return t;
  }

  /** One repeat is 1.6 m square: ten staggered 0.16 m boards. */
  floorPlanks(): TextureSet {
    return this.memo('floorPlanks', () => {
      const tile = 1.6;
      const plankW = 0.16;
      const gap = 0.0018;
      const rows = Math.round(tile / plankW);
      const rowOffset = new Float32Array(rows);
      const rowSeed = new Float32Array(rows);
      const rng = createRng(4242);
      for (let i = 0; i < rows; i++) {
        rowOffset[i] = rng() * tile;
        rowSeed[i] = Math.floor(rng() * 1000);
      }
      return generate(
        (u, v, out) => {
          const y = v * tile;
          const x = u * tile;
          const row = Math.min(rows - 1, Math.floor(y / plankW));
          const lx = (x + rowOffset[row]) % tile; // position along this plank
          const ly = y - row * plankW;
          const seed = rowSeed[row];
          const shade = (createRng(seed + 17)() - 0.5) * 0.16;
          woodGrain(lx / tile + seed * 0.37, (ly / plankW) * 0.45, seed, 'oak', out, 1);
          out.r *= 1 + shade;
          out.g *= 1 + shade * 0.95;
          out.b *= 1 + shade * 0.85;
          // Bevelled edges and dark seams between boards.
          const edgeV = Math.min(ly, plankW - ly);
          const edgeU = Math.min(lx, tile - lx);
          const edge = Math.min(edgeV, edgeU);
          const seam = 1 - smoothstep(gap, gap + 0.004, edge);
          const bevel = 1 - smoothstep(0.0, 0.012, edge);
          out.r *= 1 - seam * 0.65;
          out.g *= 1 - seam * 0.65;
          out.b *= 1 - seam * 0.65;
          out.h -= bevel * 0.35 + seam * 0.3;
          out.rough = clamp01(out.rough * 0.8 + 0.05 + seam * 0.3);
          // Broad wear/dust variation so the floor isn't uniformly glossy.
          out.rough += fbm(u * 3, v * 3, 2, 909) * 0.06;
        },
        { size: 1024, tile: [tile, tile], normalStrength: 1.6, anisotropy: this.anisotropy },
      );
    });
  }

  /** Near-white; tint it from the material. */
  plaster(): TextureSet {
    return this.memo('plaster', () =>
      generate(
        (u, v, out) => {
          const n = fbm(u * 6, v * 6, 4, 77, 6) * 0.5 + 0.5;
          const grain = gradientNoise(u * 400, v * 400, 78, 400);
          const roller = fbm(u * 60, v * 60, 2, 79, 60);
          const l = 0.94 + (n - 0.5) * 0.06 + grain * 0.012;
          out.r = l;
          out.g = l;
          out.b = l;
          out.h = 0.5 + (n - 0.5) * 0.3 + grain * 0.12 + roller * 0.08;
          out.rough = 0.88 + (n - 0.5) * 0.06 + grain * 0.02;
        },
        { size: 512, tile: [1.5, 1.5], normalStrength: 0.35, anisotropy: this.anisotropy },
      ),
    );
  }

  /** One repeat is 1 m square, grain running along u. */
  wood(kind: WoodKind = 'walnut'): TextureSet {
    return this.memo(`wood:${kind}`, () =>
      generate(
        (u, v, out) => {
          woodGrain(u, v, 300 + kind.length * 7, kind, out, 1);
        },
        { size: 512, tile: [1, 1], normalStrength: 0.7, anisotropy: this.anisotropy },
      ),
    );
  }

  /** One repeat is 0.3 m. `boucle` adds looped bumps for a chunkier yarn. */
  fabric(color: number, opts: { boucle?: boolean; scale?: number } = {}): TextureSet {
    const scale = opts.scale ?? 1;
    const boucle = opts.boucle ?? false;
    return this.memo(`fabric:${color}:${scale}:${boucle}`, () => {
      const base = hexToRgb(color);
      const threads = Math.round(110 * scale);
      return generate(
        (u, v, out) => {
          const tx = u * threads;
          const ty = v * threads;
          const cx = Math.floor(tx);
          const cy = Math.floor(ty);
          const over = (cx + cy) & 1; // plain weave: alternate over/under
          const fx = tx - cx - 0.5;
          const fy = ty - cy - 0.5;
          const thread = over ? 1 - Math.abs(fy) * 2 : 1 - Math.abs(fx) * 2;
          const bump = smoothstep(0, 0.9, thread);
          const fuzz = gradientNoise(u * 700, v * 700, 501, 700) * 0.5;
          const shade = fbm(u * 5, v * 5, 3, 502, 5) * 0.12;
          let b = boucle ? 0 : 0;
          if (boucle) {
            const w = worley(u * 60, v * 60, 503, 60);
            b = 1 - smoothstep(0.15, 0.55, w.f1);
          }
          const l = 0.82 + bump * 0.25 + shade + fuzz * 0.08 + b * 0.15;
          out.r = base[0] * l;
          out.g = base[1] * l;
          out.b = base[2] * l;
          out.h = 0.4 + bump * 0.35 + b * 0.4 + fuzz * 0.06;
          out.rough = 0.92 - bump * 0.05 + fuzz * 0.03;
        },
        { size: 512, tile: [0.3, 0.3], normalStrength: 0.6, anisotropy: this.anisotropy },
      );
    });
  }

  /** One repeat is 0.5 m. */
  leather(color: number): TextureSet {
    return this.memo(`leather:${color}`, () => {
      const base = hexToRgb(color);
      return generate(
        (u, v, out) => {
          const w = worley(u * 90, v * 90, 601, 90);
          const crease = smoothstep(0.02, 0.14, w.f2 - w.f1);
          const w2 = worley(u * 28, v * 28, 602, 28);
          const crease2 = smoothstep(0.02, 0.2, w2.f2 - w2.f1);
          const shade = fbm(u * 4, v * 4, 3, 603, 4) * 0.15;
          const l = 0.75 + crease * 0.2 + crease2 * 0.1 + shade;
          out.r = base[0] * l;
          out.g = base[1] * l;
          out.b = base[2] * l;
          out.h = 0.3 + crease * 0.45 + crease2 * 0.25;
          out.rough = 0.62 - crease * 0.18 + shade * 0.5;
        },
        { size: 512, tile: [0.5, 0.5], normalStrength: 0.8, anisotropy: this.anisotropy },
      );
    });
  }

  /** Non-repeating: one repeat covers the whole rug, so pass the rug's size. */
  rug(size: [number, number], palette: { base: number; border: number; accent: number; accent2: number }): TextureSet {
    return this.memo(`rug:${size.join('x')}:${palette.base}:${palette.border}:${palette.accent}:${palette.accent2}`, () => {
      const base = hexToRgb(palette.base);
      const border = hexToRgb(palette.border);
      const acc = hexToRgb(palette.accent);
      const acc2 = hexToRgb(palette.accent2);
      const [w, h] = size;
      return generate(
        (u, v, out) => {
          const x = u * w;
          const y = v * h;
          const ex = Math.min(x, w - x);
          const ey = Math.min(y, h - y);
          const edge = Math.min(ex, ey);
          const pile = gradientNoise(u * 900, v * 900 * (h / w), 701, 900) * 0.5;
          const wear = fbm(u * 3, v * 3, 3, 702) * 0.08;
          let r = base[0];
          let g = base[1];
          let b = base[2];
          // Border bands.
          const band1 = edge > 0.10 && edge < 0.17;
          const band2 = edge > 0.20 && edge < 0.23;
          if (band1) [r, g, b] = border;
          if (band2) [r, g, b] = acc;
          // Diamond lattice in the field.
          if (edge > 0.3) {
            const cell = 0.5;
            const dx = ((x % cell) + cell) % cell - cell / 2;
            const dy = ((y % cell) + cell) % cell - cell / 2;
            const d = Math.abs(dx) + Math.abs(dy);
            if (d < 0.11) [r, g, b] = acc2;
            else if (d > 0.19 && d < 0.235) [r, g, b] = acc;
          }
          // Thread-level noise so flat areas still read as fibre.
          const l = 0.92 + pile * 0.16 + wear;
          out.r = r * l;
          out.g = g * l;
          out.b = b * l;
          out.h = 0.5 + pile * 0.5;
          out.rough = 0.95;
        },
        { size: 1024, tile: [w, h], normalStrength: 0.7, anisotropy: this.anisotropy },
      );
    });
  }

  /** Near-white; the detail is in the streaked roughness. */
  brushedMetal(): TextureSet {
    return this.memo('brushedMetal', () =>
      generate(
        (u, v, out) => {
          const streak = fbm(u * 3, v * 600, 3, 801) * 0.5;
          const l = 0.97 + streak * 0.05;
          out.r = l;
          out.g = l;
          out.b = l;
          out.h = 0.5 + streak * 0.2;
          out.rough = 0.36 + streak * 0.25;
        },
        { size: 512, tile: [0.5, 0.5], normalStrength: 0.25, anisotropy: this.anisotropy },
      ),
    );
  }

  concrete(): TextureSet {
    return this.memo('concrete', () =>
      generate(
        (u, v, out) => {
          const n = fbm(u * 5, v * 5, 5, 901, 5) * 0.5 + 0.5;
          const speck = gradientNoise(u * 500, v * 500, 902, 500);
          const w = worley(u * 40, v * 40, 903, 40);
          const pit = 1 - smoothstep(0.0, 0.12, w.f1);
          const l = 0.62 + (n - 0.5) * 0.18 + speck * 0.05 - pit * 0.25;
          out.r = l * 0.98;
          out.g = l * 0.97;
          out.b = l * 0.95;
          out.h = 0.5 + (n - 0.5) * 0.3 - pit * 0.5 + speck * 0.05;
          out.rough = 0.55 + (n - 0.5) * 0.15 + pit * 0.3;
        },
        { size: 512, tile: [1, 1], normalStrength: 0.6, anisotropy: this.anisotropy },
      ),
    );
  }

  paper(): TextureSet {
    return this.memo('paper', () =>
      generate(
        (u, v, out) => {
          const fibre = gradientNoise(u * 600, v * 600, 1101, 600) * 0.5;
          const cloud = fbm(u * 8, v * 8, 3, 1102, 8) * 0.03;
          const l = 0.96 + fibre * 0.04 + cloud;
          out.r = l;
          out.g = l;
          out.b = l * 0.99;
          out.h = 0.5 + fibre * 0.3;
          out.rough = 0.9 + fibre * 0.05;
        },
        { size: 256, tile: [0.3, 0.3], normalStrength: 0.25, anisotropy: this.anisotropy },
      ),
    );
  }

  /** Looser, lighter weave than upholstery. */
  linen(color: number): TextureSet {
    return this.memo(`linen:${color}`, () => {
      const base = hexToRgb(color);
      return generate(
        (u, v, out) => {
          const threads = 160;
          const wx = Math.sin(u * threads * Math.PI * 2) * 0.5 + 0.5;
          const wy = Math.sin(v * threads * Math.PI * 2) * 0.5 + 0.5;
          const weave = wx * wy;
          const slub = smoothstep(0.75, 1, fbm(u * 40, v * 2, 2, 1201, 40) * 0.5 + 0.5) * 0.15;
          const shade = fbm(u * 4, v * 4, 3, 1202, 4) * 0.06;
          const l = 0.86 + weave * 0.18 + slub + shade;
          out.r = base[0] * l;
          out.g = base[1] * l;
          out.b = base[2] * l;
          out.h = 0.45 + weave * 0.3 + slub;
          out.rough = 0.9;
        },
        { size: 512, tile: [0.25, 0.25], normalStrength: 0.35, anisotropy: this.anisotropy },
      );
    });
  }

  /** Cached by `key`. Use `srgb` for colour and emissive maps, not data maps. */
  canvas(
    key: string,
    width: number,
    height: number,
    draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    srgb = true,
  ): THREE.CanvasTexture {
    let tex = this.canvasCache.get(key);
    if (tex) return tex;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    draw(ctx, width, height);
    tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = this.anisotropy;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.canvasCache.set(key, tex);
    return tex;
  }

  /** 16:9 screen content. */
  screen(kind: 'ide' | 'desktop' | 'off' = 'ide'): THREE.CanvasTexture {
    return this.canvas(`screen:${kind}`, 1600, 900, (ctx, w, h) => {
      if (kind === 'off') {
        ctx.fillStyle = '#0b0c0e';
        ctx.fillRect(0, 0, w, h);
        return;
      }
      if (kind === 'desktop') {
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#1b2a4a');
        grad.addColorStop(0.5, '#3b4c7a');
        grad.addColorStop(1, '#c4737a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, h - 56, w, 56);
        for (let i = 0; i < 9; i++) {
          ctx.fillStyle = `hsl(${(i * 40) % 360} 60% 60%)`;
          ctx.beginPath();
          ctx.roundRect(w / 2 - 250 + i * 56, h - 46, 36, 36, 8);
          ctx.fill();
        }
        return;
      }
      const rng = createRng(2026);
      ctx.fillStyle = '#1e1f24';
      ctx.fillRect(0, 0, w, h);
      // Activity bar + explorer sidebar.
      ctx.fillStyle = '#17181c';
      ctx.fillRect(0, 0, 56, h);
      ctx.fillStyle = '#212227';
      ctx.fillRect(56, 0, 264, h);
      ctx.fillStyle = '#9aa0ad';
      ctx.font = '600 15px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText('EXPLORER', 76, 34);
      const files = ['src', 'core', 'renderer.ts', 'postfx.ts', 'textures.ts', 'room', 'shell.ts', 'layout.ts', 'furniture', 'desk.ts', 'sofa.ts', 'chair.ts', 'main.ts', 'index.html', 'package.json'];
      files.forEach((f, i) => {
        ctx.fillStyle = f.includes('.') ? '#c9ced8' : '#e0b56a';
        const indent = f.includes('.') && !['main.ts', 'index.html', 'package.json'].includes(f) ? 30 : 12;
        ctx.fillText(f, 76 + indent, 66 + i * 26);
      });
      // Tabs.
      ctx.fillStyle = '#26272d';
      ctx.fillRect(320, 0, w - 320, 40);
      ctx.fillStyle = '#1e1f24';
      ctx.fillRect(320, 0, 170, 40);
      ctx.fillStyle = '#e8e8ea';
      ctx.fillText('main.ts', 342, 26);
      ctx.fillStyle = '#7d8290';
      ctx.fillText('postfx.ts', 512, 26);
      ctx.fillText('textures.ts', 660, 26);
      // Code lines.
      const kw = ['const', 'let', 'import', 'export', 'function', 'return', 'await', 'new', 'if', 'for'];
      const ident = ['scene', 'camera', 'renderer', 'composer', 'light', 'material', 'geometry', 'mesh', 'texture', 'group', 'options', 'controls', 'shadow', 'intensity', 'position', 'update'];
      const colors = { kw: '#c586c0', id: '#9cdcfe', fn: '#dcdcaa', str: '#ce9178', num: '#b5cea8', punc: '#d4d4d4', cm: '#6a9955', ty: '#4ec9b0' };
      ctx.font = '16px ui-monospace, Menlo, Consolas, monospace';
      const lineH = 24;
      const lines = Math.floor((h - 40 - 32) / lineH);
      for (let i = 0; i < lines; i++) {
        const y = 66 + i * lineH;
        ctx.fillStyle = '#5a5f6b';
        ctx.fillText(String(i + 1).padStart(3, ' '), 332, y);
        let x = 392 + Math.floor(rng() * 3) * 24;
        if (rng() < 0.12) {
          ctx.fillStyle = colors.cm;
          ctx.fillText('// ' + ident[Math.floor(rng() * ident.length)] + ' is rebuilt every frame', x, y);
          continue;
        }
        if (rng() < 0.1) continue; // blank line
        const tokens = 3 + Math.floor(rng() * 6);
        for (let t = 0; t < tokens; t++) {
          const roll = rng();
          let text: string;
          let color: string;
          if (roll < 0.18) { text = kw[Math.floor(rng() * kw.length)]; color = colors.kw; }
          else if (roll < 0.5) { text = ident[Math.floor(rng() * ident.length)]; color = colors.id; }
          else if (roll < 0.62) { text = ident[Math.floor(rng() * ident.length)] + '()'; color = colors.fn; }
          else if (roll < 0.72) { text = "'" + ident[Math.floor(rng() * ident.length)] + "'"; color = colors.str; }
          else if (roll < 0.8) { text = String((rng() * 100).toFixed(rng() < 0.5 ? 0 : 2)); color = colors.num; }
          else if (roll < 0.88) { text = 'THREE.' + ident[Math.floor(rng() * ident.length)]; color = colors.ty; }
          else { text = ['=', '=>', '{', '}', ';', ',', '(', ')'][Math.floor(rng() * 8)]; color = colors.punc; }
          ctx.fillStyle = color;
          ctx.fillText(text, x, y);
          x += ctx.measureText(text).width + 9;
          if (x > w - 260) break;
        }
      }
      // Minimap + status bar.
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(w - 120, 40, 120, h - 72);
      for (let i = 0; i < 90; i++) {
        ctx.fillStyle = `rgba(${150 + rng() * 80},${150 + rng() * 80},${170 + rng() * 60},0.35)`;
        ctx.fillRect(w - 110, 48 + i * 8, 20 + rng() * 80, 3);
      }
      ctx.fillStyle = '#2f5fbf';
      ctx.fillRect(0, h - 32, w, 32);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('⎇ main   ✓ 0 problems   Ln 128, Col 14   UTF-8   TypeScript', 16, h - 11);
    });
  }
}
