/** mulberry32. Returns [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const GRAD_COUNT = 32;
const GRAD_X = new Float32Array(GRAD_COUNT);
const GRAD_Y = new Float32Array(GRAD_COUNT);
for (let i = 0; i < GRAD_COUNT; i++) {
  const a = (i / GRAD_COUNT) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

/** Gradient noise in [-1, 1]. A non-zero `period` wraps the lattice so the result tiles. */
export function gradientNoise(x: number, y: number, seed = 0, period = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const wrap = (v: number) => (period > 0 ? ((v % period) + period) % period : v);

  const grad = (ix: number, iy: number, dx: number, dy: number) => {
    const g = (hash2(wrap(ix), wrap(iy), seed) * GRAD_COUNT) | 0;
    return GRAD_X[g] * dx + GRAD_Y[g] * dy;
  };

  const n00 = grad(x0, y0, fx, fy);
  const n10 = grad(x0 + 1, y0, fx - 1, fy);
  const n01 = grad(x0, y0 + 1, fx, fy - 1);
  const n11 = grad(x0 + 1, y0 + 1, fx - 1, fy - 1);
  const u = fade(fx);
  const v = fade(fy);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.4142;
}

/** Fractal Brownian motion, roughly in [-1, 1]. */
export function fbm(
  x: number,
  y: number,
  octaves = 5,
  seed = 0,
  period = 0,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += gradientNoise(x * freq, y * freq, seed + i * 101, period * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Cellular noise: the two nearest jittered-lattice distances, in lattice units. */
export function worley(x: number, y: number, seed = 0, period = 0): { f1: number; f2: number } {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 8;
  let f2 = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const wx = period > 0 ? ((cx % period) + period) % period : cx;
      const wy = period > 0 ? ((cy % period) + period) % period : cy;
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 7919);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2 };
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
