import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { createCameraRig, type ViewName, VIEWS } from './core/camera';
import { createRoomEnvironment } from './core/environment';
import { createLightRig, LightRegistryImpl, PRESETS, type PresetName } from './core/lighting';
import { MaterialLibrary } from './core/materials';
import { createPostFX } from './core/postfx';
import { createRenderer } from './core/renderer';
import { TextureLibrary } from './core/textures';
import { ROOM, type Quality, type SceneContext } from './core/types';
import { buildLayout, PLACEMENTS } from './room/layout';
import { createExterior } from './room/exterior';
import { createShell } from './room/shell';

declare global {
  interface Window {
    __scene?: {
      ready: boolean;
      setView(name: ViewName): void;
      setPreset(name: PresetName): void;
      capture(): string;
      stats(): { drawCalls: number; triangles: number; textures: number; programs: number; bbox: number[] | null; self: { meshes: number; triangles: number; drawCalls: number } | null; lights: string[] };
    };
  }
}

const params = new URLSearchParams(location.search);
const shotMode = params.get('shot') === '1';
const quality: Quality = (params.get('quality') as Quality) ?? 'high';
const initialView = (params.get('view') as ViewName) in VIEWS ? (params.get('view') as ViewName) : 'overview';
const initialPreset = (params.get('preset') as PresetName) in PRESETS ? (params.get('preset') as PresetName) : 'day';
const dprParam = params.get('dpr');
const moduleName = params.get('module');
const moduleY = Number(params.get('y') ?? '0');

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const loadingText = document.getElementById('loading-text')!;
const loadingPanel = document.getElementById('loading')!;
const hud = document.getElementById('hud')!;

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const status = async (text: string): Promise<void> => {
  loadingText.textContent = text;
  await nextFrame();
};

async function boot(): Promise<void> {
  await status('Starting renderer…');
  const renderer = createRenderer({ canvas, quality, preserveDrawingBuffer: shotMode, maxPixelRatio: dprParam ? Number(dprParam) : undefined });
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0a09);

  const textures = new TextureLibrary(renderer.capabilities.getMaxAnisotropy());
  const materials = new MaterialLibrary(textures);
  const lights = new LightRegistryImpl();
  const ctx: SceneContext = { renderer, textures, materials, lights, quality, seed: 1337 };

  await status('Plastering the walls…');
  const shell = createShell(ctx);
  scene.add(shell.group);
  const exterior = createExterior(ctx);
  scene.add(exterior.group);

  await status('Moving in the furniture…');
  let previewed: THREE.Group | null = null;
  if (moduleName) {
    const placement = PLACEMENTS.find((p) => p.name === moduleName);
    if (!placement) throw new Error(`Unknown module "${moduleName}". Known: ${PLACEMENTS.map((p) => p.name).join(', ')}`);
    previewed = placement.factory(ctx);
    previewed.name = moduleName;
    previewed.position.y = moduleY;
    scene.add(previewed);
  } else {
    scene.add(buildLayout(ctx));
  }

  await status('Hanging the lights…');
  const rig = createLightRig(quality);
  rig.exteriorMaterials.push(...shell.exteriorMaterials, ...exterior.materials);
  scene.add(rig.group);
  rig.applyPreset(initialPreset, renderer, lights);

  const cameraRig = createCameraRig(canvas, window.innerWidth / window.innerHeight);
  cameraRig.setView(initialView, false);
  if (previewed) {
    previewed.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(previewed);
    const center = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.3);
    const azimuth = THREE.MathUtils.degToRad(Number(params.get('az') ?? '35'));
    const elevation = THREE.MathUtils.degToRad(Number(params.get('el') ?? '18'));
    const dist = radius * Number(params.get('zoom') ?? '1.5');
    const pos = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)).multiplyScalar(dist).add(center);
    cameraRig.camera.position.copy(pos);
    cameraRig.controls.target.copy(center);
    cameraRig.controls.update();
    console.log(`[module] ${moduleName}: size ${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)} m, min y ${bb.min.y.toFixed(3)}, centre (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`);
  }

  const roomBounds = new THREE.Box3(
    new THREE.Vector3(-ROOM.width / 2, 0, -ROOM.depth / 2),
    new THREE.Vector3(ROOM.width / 2, ROOM.height, ROOM.depth / 2),
  );
  const fx = createPostFX(renderer, scene, cameraRig.camera, quality, roomBounds);

  await status('Bouncing light around the room…');
  // Warm the shadow maps once so the probe sees shadows, then probe.
  renderer.render(scene, cameraRig.camera);
  const env = createRoomEnvironment(renderer, scene, new THREE.Vector3(0.2, 1.35, 0.1), { bounces: 2, size: 256, intensity: 1.0 });
  env.refresh();

  // GUI ---------------------------------------------------------------------
  const settings = {
    preset: initialPreset as PresetName,
    exposure: PRESETS[initialPreset].exposure,
    ambientOcclusion: true,
    bloom: 0.22,
    view: initialView as ViewName,
  };
  const gui = new GUI({ title: 'Room', width: 240 });
  gui.add(settings, 'preset', { 'Midday': 'day', 'Golden hour': 'golden', 'Night': 'night' }).name('Time of day').onChange((v: PresetName) => {
    rig.applyPreset(v, renderer, lights);
    settings.exposure = renderer.toneMappingExposure;
    exposureCtl.updateDisplay();
    env.refresh();
  });
  const exposureCtl = gui.add(settings, 'exposure', 0.3, 2.5, 0.01).name('Exposure').onChange((v: number) => {
    renderer.toneMappingExposure = v;
  });
  gui.add(settings, 'ambientOcclusion').name('Ambient occlusion').onChange((v: boolean) => fx.setAO(v));
  gui.add(settings, 'bloom', 0, 1, 0.01).name('Bloom').onChange((v: number) => fx.setBloom(v));
  gui.add(settings, 'view', Object.keys(VIEWS) as ViewName[]).name('View').onChange((v: ViewName) => setView(v));
  if (shotMode) gui.hide();

  const viewButtons = Array.from(hud.querySelectorAll<HTMLButtonElement>('button[data-view]'));
  const setView = (name: ViewName): void => {
    settings.view = name;
    cameraRig.setView(name, !shotMode);
    for (const b of viewButtons) b.classList.toggle('active', b.dataset.view === name);
  };
  for (const b of viewButtons) b.addEventListener('click', () => setView(b.dataset.view as ViewName));
  for (const b of viewButtons) b.classList.toggle('active', b.dataset.view === initialView);

  // Resize ------------------------------------------------------------------
  const onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    cameraRig.camera.aspect = w / h;
    cameraRig.camera.updateProjectionMatrix();
    fx.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  // Loop --------------------------------------------------------------------
  const timer = new THREE.Timer();
  renderer.info.autoReset = false;
  let frames = 0;
  const api = {
    ready: false,
    setView,
    setPreset(name: PresetName) {
      settings.preset = name;
      rig.applyPreset(name, renderer, lights);
      env.refresh();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    },
    capture() {
      cameraRig.update(0);
      renderer.info.reset();
      fx.render();
      return renderer.domElement.toDataURL('image/png');
    },
    stats() {
      const i = renderer.info;
      let bbox: number[] | null = null;
      let self: { meshes: number; triangles: number; drawCalls: number } | null = null;
      if (previewed) {
        const bb = new THREE.Box3().setFromObject(previewed);
        bbox = [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].map((v) => Math.round(v * 1000) / 1000);
        // The renderer's counters cover the whole preview page (room shell and
        // post passes included), so count the module's own cost separately.
        let meshes = 0;
        let triangles = 0;
        let drawCalls = 0;
        previewed.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !m.geometry) return;
          meshes++;
          const instances = (m as unknown as THREE.InstancedMesh).isInstancedMesh ? (m as unknown as THREE.InstancedMesh).count : 1;
          const groups = Array.isArray(m.material) ? Math.max(1, m.geometry.groups.length) : 1;
          drawCalls += groups;
          const index = m.geometry.getIndex();
          const pos = m.geometry.getAttribute('position');
          const verts = index ? index.count : (pos?.count ?? 0);
          triangles += (verts / 3) * instances;
        });
        self = { meshes, triangles: Math.round(triangles), drawCalls };
      }
      return { drawCalls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, programs: i.programs?.length ?? 0, bbox, self, lights: lights.all().map((l) => `${l.name}:${l.role}`) };
    },
  };
  window.__scene = api;

  const animate = (): void => {
    requestAnimationFrame(animate);
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    cameraRig.update(dt);
    renderer.info.reset();
    fx.render();
    frames++;
    if (frames === 3) {
      loadingPanel.classList.add('hidden');
      if (!shotMode) hud.classList.remove('hidden');
      api.ready = true;
    }
  };
  await status('Focusing…');
  animate();
}

boot().catch((err: unknown) => {
  console.error(err);
  loadingText.textContent = 'Could not start the scene: ' + (err instanceof Error ? err.message : String(err));
});
