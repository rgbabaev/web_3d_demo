import * as THREE from 'three';

export interface RoomEnvironment {
  /** Re-probe; the result is only valid for the lighting that was in place. */
  refresh(): void;
  dispose(): void;
}

export function createRoomEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  probePosition: THREE.Vector3,
  options: { bounces?: number; size?: number; intensity?: number } = {},
): RoomEnvironment {
  const bounces = options.bounces ?? 2;
  const size = options.size ?? 256;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  let current: THREE.WebGLRenderTarget | null = null;

  const refresh = (): void => {
    const savedBg = scene.background;
    const savedEnv = scene.environment;
    scene.background = null;
    scene.environment = null;
    // Objects tagged `probeHidden` (e.g. the exterior backdrop's dark side) are
    // still rendered — the probe should see exactly what the camera sees.
    for (let i = 0; i < bounces; i++) {
      const next = pmrem.fromScene(scene, 0.02, 0.05, 40, { size, position: probePosition });
      if (current) current.dispose();
      current = next;
      scene.environment = current.texture;
    }
    scene.background = savedBg;
    scene.environmentIntensity = options.intensity ?? 1;
    void savedEnv;
  };

  return {
    refresh,
    dispose() {
      current?.dispose();
      pmrem.dispose();
    },
  };
}
