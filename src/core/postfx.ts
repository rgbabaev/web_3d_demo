import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Quality } from './types';

export interface PostFX {
  composer: EffectComposer;
  gtao: GTAOPass;
  bloom: UnrealBloomPass;
  setSize(width: number, height: number): void;
  setAO(enabled: boolean): void;
  setBloom(strength: number): void;
  render(): void;
}

export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: Quality,
  bounds: THREE.Box3,
): PostFX {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
    type: THREE.HalfFloatType,
    samples: quality === 'high' ? 4 : 2,
  });
  const composer = new EffectComposer(renderer, target);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const gtao = new GTAOPass(scene, camera, size.x, size.y);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 1.0;
  gtao.updateGtaoMaterial({
    radius: 0.28,
    distanceExponent: 1.5,
    thickness: 1.0,
    scale: 1.1,
    samples: quality === 'high' ? 16 : 8,
    distanceFallOff: 1.0,
    screenSpaceRadius: false,
  });
  gtao.updatePdMaterial({
    lumaPhi: 10,
    depthPhi: 2,
    normalPhi: 3,
    radius: 4,
    radiusExponent: 1,
    rings: 2,
    samples: quality === 'high' ? 16 : 8,
  });
  gtao.setSceneClipBox(bounds);
  composer.addPass(gtao);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.55, 1.0);
  composer.addPass(bloom);

  composer.addPass(new OutputPass());

  return {
    composer,
    gtao,
    bloom,
    setSize(width, height) {
      composer.setSize(width, height);
      gtao.setSize(width, height);
      bloom.setSize(width, height);
    },
    setAO(enabled) {
      gtao.enabled = enabled;
    },
    setBloom(strength) {
      bloom.strength = strength;
      bloom.enabled = strength > 0;
    },
    render() {
      composer.render();
    },
  };
}
