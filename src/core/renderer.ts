import * as THREE from 'three';
import type { Quality } from './types';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  quality: Quality;
  /** Keep the drawing buffer so screenshots can read it back. */
  preserveDrawingBuffer?: boolean;
  maxPixelRatio?: number;
}

export function createRenderer(opts: RendererOptions): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas: opts.canvas,
    antialias: false, // the composer's MSAA target does the anti-aliasing
    powerPreference: 'high-performance',
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    alpha: false,
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? (opts.quality === 'high' ? 2 : 1.25)));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x0b0a09, 1);
  return renderer;
}
