import * as THREE from 'three';
import type { ModuleFactory, SceneContext } from '../core/types';
import { ROOM } from '../core/types';
import { create as bookshelf } from '../furniture/bookshelf';
import { create as chair } from '../furniture/chair';
import { create as coffeeTable } from '../furniture/coffeeTable';
import { create as curtains } from '../furniture/curtains';
import { create as desk } from '../furniture/desk';
import { create as deskAccessories } from '../furniture/deskAccessories';
import { create as floorLamp } from '../furniture/floorLamp';
import { create as monitor } from '../furniture/monitor';
import { create as pendant } from '../furniture/pendant';
import { create as plant } from '../furniture/plant';
import { create as rug } from '../furniture/rug';
import { create as sideTable } from '../furniture/sideTable';
import { create as sofa } from '../furniture/sofa';
import { create as tvConsole } from '../furniture/tvConsole';
import { create as wallArt } from '../furniture/wallArt';

export interface Placement {
  name: string;
  factory: ModuleFactory;
  position: [number, number, number];
  /** Y rotation in degrees. 0 = facing +Z, -90 = facing -X, 90 = facing +X. */
  rotation?: number;
}

const DESK: [number, number, number] = [-1.2, 0, -1.7];

export const PLACEMENTS: Placement[] = [
  { name: 'desk', factory: desk, position: DESK },
  { name: 'monitor', factory: monitor, position: DESK },
  { name: 'deskAccessories', factory: deskAccessories, position: DESK },
  { name: 'chair', factory: chair, position: [-1.0, 0, -0.98], rotation: 192 },
  { name: 'bookshelf', factory: bookshelf, position: [1.3, 0, -2.12] },
  { name: 'rug', factory: rug, position: [1.65, 0, 0.3] },
  { name: 'sofa', factory: sofa, position: [2.58, 0, 0.3], rotation: -90 },
  { name: 'coffeeTable', factory: coffeeTable, position: [1.45, 0, 0.3], rotation: -90 },
  { name: 'sideTable', factory: sideTable, position: [2.6, 0, 1.78] },
  { name: 'tvConsole', factory: tvConsole, position: [-2.85, 0, 0.1], rotation: 90 },
  { name: 'floorLamp', factory: floorLamp, position: [2.52, 0, -1.55] },
  { name: 'plant', factory: plant, position: [2.62, 0, -1.95] },
  { name: 'curtains', factory: curtains, position: [ROOM.window.x, 0, -ROOM.depth / 2 + 0.1] },
  { name: 'wallArt', factory: wallArt, position: [ROOM.width / 2 - 0.002, 0, 0.3], rotation: -90 },
  { name: 'pendant', factory: pendant, position: [1.45, ROOM.height, 0.3] },
];

export function buildLayout(ctx: SceneContext): THREE.Group {
  const root = new THREE.Group();
  root.name = 'furniture';
  for (const p of PLACEMENTS) {
    const obj = p.factory(ctx);
    obj.name = p.name;
    obj.position.set(...p.position);
    obj.rotation.y = THREE.MathUtils.degToRad(p.rotation ?? 0);
    root.add(obj);
  }
  return root;
}
