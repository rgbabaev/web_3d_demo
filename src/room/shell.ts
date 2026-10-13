import * as THREE from 'three';
import { box, mesh, roundedBox } from '../core/geometry';
import { ROOM, type SceneContext } from '../core/types';

export interface Shell {
  group: THREE.Group;
  exteriorMaterials: THREE.MeshBasicMaterial[];
}

export function createShell(ctx: SceneContext): Shell {
  const { materials } = ctx;
  const g = new THREE.Group();
  g.name = 'shell';
  const W = ROOM.width;
  const D = ROOM.depth;
  const H = ROOM.height;
  const T = ROOM.wallThickness;

  const floor = mesh(new THREE.PlaneGeometry(W, D), materials.floorOak([W, D]), [0, 0, 0], { cast: false, name: 'floor' });
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);

  const ceilingMat = materials.wallPlaster(0xf3efe8, [W, D]);
  const ceiling = mesh(new THREE.PlaneGeometry(W, D), ceilingMat, [0, H, 0], { cast: false, name: 'ceiling' });
  ceiling.rotation.x = Math.PI / 2;
  g.add(ceiling);

  const wallMat = materials.wallPlaster(0xe9e3d8, [3, 3]);
  const accentMat = materials.wallPlaster(0x56645b, [3, 3]); // muted sage behind the sofa (right wall)

  const wall = (w: number, h: number, d: number, x: number, y: number, z: number, mat = wallMat, name = 'wall'): THREE.Mesh =>
    mesh(box(w, h, d), mat, [x, y, z], { name });

  // Back wall (z = -D/2) with the window opening.
  const win = ROOM.window;
  const wz = -D / 2 - T / 2;
  const winL = win.x - win.width / 2;
  const winR = win.x + win.width / 2;
  const leftW = winL - -W / 2;
  const rightW = W / 2 - winR;
  g.add(wall(leftW, H, T, -W / 2 + leftW / 2, H / 2, wz));
  g.add(wall(rightW, H, T, winR + rightW / 2, H / 2, wz));
  g.add(wall(win.width, win.sill, T, win.x, win.sill / 2, wz));
  g.add(wall(win.width, H - win.top, T, win.x, win.top + (H - win.top) / 2, wz));
  // Front wall (z = +D/2), plain.
  g.add(wall(W, H, T, 0, H / 2, D / 2 + T / 2));
  // Right wall (x = +W/2), accent colour.
  g.add(wall(T, H, D + 2 * T, W / 2 + T / 2, H / 2, 0, accentMat, 'accentWall'));
  // Left wall (x = -W/2) with the door opening.
  const door = ROOM.door;
  const openZ0 = door.z - door.width / 2;
  const openZ1 = door.z + door.width / 2;
  const lx = -W / 2 - T / 2;
  const seg = (z0: number, z1: number, y0: number, y1: number): THREE.Mesh =>
    wall(T, y1 - y0, z1 - z0, lx, (y0 + y1) / 2, (z0 + z1) / 2);
  g.add(seg(-D / 2 - T, openZ0, 0, H));
  g.add(seg(openZ1, D / 2 + T, 0, H));
  g.add(seg(openZ0, openZ1, door.height, H));

  const skirtMat = materials.paintedWood(0xf4f1ea, 'satin');
  const skirtH = 0.1;
  const skirtT = 0.016;
  const skirt = (len: number, x: number, z: number, rotY: number): void => {
    const m = mesh(roundedBox(len, skirtH, skirtT, 0.003, 2), skirtMat, [x, skirtH / 2, z], { name: 'skirting' });
    m.rotation.y = rotY;
    g.add(m);
  };
  skirt(W, 0, -D / 2 + skirtT / 2, 0);
  skirt(W, 0, D / 2 - skirtT / 2, 0);
  skirt(D, W / 2 - skirtT / 2, 0, Math.PI / 2);
  // Left wall skirting stops at the door.
  skirt(openZ0 - -D / 2, -W / 2 + skirtT / 2, (-D / 2 + openZ0) / 2, Math.PI / 2);
  skirt(D / 2 - openZ1, -W / 2 + skirtT / 2, (openZ1 + D / 2) / 2, Math.PI / 2);

  const frameMat = materials.paintedWood(0xf6f4ef, 'satin');
  const fw = 0.07; // frame width
  const fd = 0.1; // frame depth
  const wy0 = win.sill;
  const wy1 = win.top;
  const wh = wy1 - wy0;
  const wcz = -D / 2 - T / 2 + 0.02; // frame sits just inside the wall thickness
  const frame = new THREE.Group();
  frame.name = 'windowFrame';
  frame.add(mesh(roundedBox(win.width + fw * 2, fw, fd, 0.004), frameMat, [win.x, wy1 + fw / 2, wcz]));
  frame.add(mesh(roundedBox(win.width + fw * 2, fw, fd, 0.004), frameMat, [win.x, wy0 - fw / 2, wcz]));
  frame.add(mesh(roundedBox(fw, wh, fd, 0.004), frameMat, [winL - fw / 2, wy0 + wh / 2, wcz]));
  frame.add(mesh(roundedBox(fw, wh, fd, 0.004), frameMat, [winR + fw / 2, wy0 + wh / 2, wcz]));
  // Two vertical mullions + one transom → six panes.
  const mw = 0.045;
  for (let i = 1; i <= 2; i++) {
    const x = winL + (win.width * i) / 3;
    frame.add(mesh(roundedBox(mw, wh, fd * 0.8, 0.003), frameMat, [x, wy0 + wh / 2, wcz]));
  }
  frame.add(mesh(roundedBox(win.width, mw, fd * 0.8, 0.003), frameMat, [win.x, wy0 + wh * 0.62, wcz]));
  // Window reveal (inner faces of the opening).
  const revealMat = materials.wallPlaster(0xf1ede6, [1, 1]);
  const rd = T;
  frame.add(mesh(box(win.width, 0.02, rd), revealMat, [win.x, wy1 + 0.01, -D / 2 - T / 2], { cast: false }));
  frame.add(mesh(box(0.02, wh, rd), revealMat, [winL - 0.01, wy0 + wh / 2, -D / 2 - T / 2], { cast: false }));
  frame.add(mesh(box(0.02, wh, rd), revealMat, [winR + 0.01, wy0 + wh / 2, -D / 2 - T / 2], { cast: false }));
  // Glass — a single thin pane; shadows pass through it.
  const glass = mesh(new THREE.PlaneGeometry(win.width, wh), materials.glass(), [win.x, wy0 + wh / 2, wcz], { cast: false, receive: false, name: 'windowGlass' });
  glass.renderOrder = 10;
  frame.add(glass);
  // Sill: a deeper board inside the room.
  const sillMat = materials.paintedWood(0xf6f4ef, 'gloss');
  frame.add(mesh(roundedBox(win.width + 0.24, 0.035, 0.22, 0.005), sillMat, [win.x, wy0 - 0.0175, -D / 2 + 0.06], { name: 'windowSill' }));
  g.add(frame);

  const exteriorMaterials: THREE.MeshBasicMaterial[] = [];

  const doorMat = materials.paintedWood(0xf4f1ea, 'satin');
  const dg = new THREE.Group();
  dg.name = 'door';
  const dz0 = door.z - door.width / 2;
  const dz1 = door.z + door.width / 2;

  // Lining through the wall thickness. Without it the opening is a hole that
  // leaks background through the gap beside the slab.
  const liningX = -W / 2 - T / 2;
  dg.add(mesh(box(T, 0.02, door.width), doorMat, [liningX, door.height + 0.01, door.z], { cast: false }));
  dg.add(mesh(box(T, door.height, 0.02), doorMat, [liningX, door.height / 2, dz0 - 0.01], { cast: false }));
  dg.add(mesh(box(T, door.height, 0.02), doorMat, [liningX, door.height / 2, dz1 + 0.01], { cast: false }));

  // Architrave on the room side.
  const archD = 0.022;
  const archW = 0.07;
  const archX = -W / 2 + archD / 2;
  dg.add(mesh(roundedBox(archD, archW, door.width + archW * 2, 0.003), doorMat, [archX, door.height + archW / 2, door.z]));
  dg.add(mesh(roundedBox(archD, door.height + archW, archW, 0.003), doorMat, [archX, (door.height + archW) / 2, dz0 - archW / 2]));
  dg.add(mesh(roundedBox(archD, door.height + archW, archW, 0.003), doorMat, [archX, (door.height + archW) / 2, dz1 + archW / 2]));

  // Slab: stiles and rails around two recessed panels. A flush slab with
  // applied panels reads as a blank rectangle; the groove is what makes a
  // panelled door legible across the room.
  const slabT = 0.045;
  const slabX = -W / 2 - slabT / 2 - 0.004;
  const faceX = slabX + slabT / 2;
  const dh = door.height - 0.012;
  const dw = door.width - 0.012;
  const sw = 0.105;
  const midY = 0.92;
  const member = (h: number, w: number, y: number, z: number): THREE.Mesh =>
    mesh(roundedBox(slabT, h, w, 0.003), doorMat, [slabX, y, z]);
  dg.add(member(dh, sw, dh / 2, door.z - dw / 2 + sw / 2));
  dg.add(member(dh, sw, dh / 2, door.z + dw / 2 - sw / 2));
  const innerW = dw - sw * 2;
  dg.add(member(sw, innerW, sw / 2, door.z));
  dg.add(member(0.15, innerW, midY, door.z));
  dg.add(member(sw * 1.5, innerW, dh - sw * 0.75, door.z));
  const panelT = 0.022;
  const panelX = faceX - 0.011 - panelT / 2;
  const lower: [number, number] = [midY - 0.075 - sw, (sw + midY - 0.075) / 2];
  const upper: [number, number] = [dh - sw * 1.5 - (midY + 0.075), (midY + 0.075 + dh - sw * 1.5) / 2];
  for (const [ph, py] of [lower, upper]) {
    dg.add(mesh(roundedBox(panelT, ph, innerW + 0.016, 0.004), doorMat, [panelX, py, door.z]));
  }

  const handleZ = dz0 + 0.085;
  const handle = mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.12, 16), materials.metal('brushedSteel'), [faceX + 0.065, 1.02, handleZ]);
  handle.rotation.x = Math.PI / 2;
  dg.add(handle);
  dg.add(mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.012, 24), materials.metal('brushedSteel'), [faceX + 0.006, 1.02, handleZ]).rotateZ(Math.PI / 2));
  g.add(dg);

  return { group: g, exteriorMaterials };
}
