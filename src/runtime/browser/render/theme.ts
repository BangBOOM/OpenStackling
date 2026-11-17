import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { ThemeId } from '../../theme-catalog';
export type SceneLayout = Readonly<{
  tableTop: number;
  tableSize: number;
  tableDepth: number;
  tableThickness: number;
  blockSize: number;
  blockCount: number;
  objects?: readonly Readonly<import('../../../simulation/world/objects').ObjectSpec>[];
  robot: Readonly<{
    base: readonly number[];
    links: readonly number[];
    toolLength: number;
    fingerLength: number;
    fingerWidth: number;
    fingerDepth: number;
  }>;
}>;
export const MATERIAL_SLOTS = [
  'table',
  'surface',
  'grid',
  'mount',
  'plate',
  'shell',
  'accent',
  'arm',
  'fingers',
  'mechanism',
  'metal',
  'pads',
  'visor',
] as const;
export type MaterialSlot = (typeof MATERIAL_SLOTS)[number];
type MaterialSpec =
  | string
  | {
      color: string;
      roughness: number;
      metalness: number;
      emissive?: string;
      emissiveIntensity?: number;
    };
export type ThemePalette = Record<MaterialSlot, MaterialSpec> & { blocks: string[] };
// The robot keeps its material identity under each environment's lighting.
export const ROBOT_PALETTE = {
  mount: { color: '#24282b', roughness: 0.6, metalness: 0.25 },
  plate: { color: '#b0b9b9', roughness: 0.36, metalness: 0.65 },
  shell: { color: '#dce3e2', roughness: 0.36, metalness: 0.12 },
  arm: { color: '#bfc9ca', roughness: 0.46, metalness: 0.15 },
  accent: {
    color: '#dc9168',
    roughness: 0.3,
    metalness: 0.1,
    emissive: '#000000',
    emissiveIntensity: 0,
  },
  fingers: { color: '#b5bfc0', roughness: 0.4, metalness: 0.65 },
  mechanism: { color: '#171b1e', roughness: 0.46, metalness: 0.25 },
  metal: { color: '#aab5b7', roughness: 0.32, metalness: 0.7 },
  pads: { color: '#191d20', roughness: 0.9, metalness: 0 },
  visor: { color: '#171f25', roughness: 0.23, metalness: 0.3 },
} satisfies Partial<ThemePalette>;
export type ThemeEnvironment = {
  background: string;
  sky: string;
  ground: string;
  ambient: number;
  sun: string;
  sunIntensity: number;
  sunOffset: [number, number, number];
};
export type ThemeInstance = {
  materials: Record<MaterialSlot, THREE.MeshStandardMaterial>;
  blocks: THREE.MeshStandardMaterial[];
  environment: ThemeEnvironment;
  decorations: THREE.Group;
  dispose(): void;
};
export interface ThemePlugin {
  readonly id: ThemeId;
  readonly version: string;
  create(layout: SceneLayout): ThemeInstance;
}
type Builder = {
  root: THREE.Group;
  mesh(geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number): THREE.Mesh;
  box(
    w: number,
    h: number,
    d: number,
    color: string,
    x: number,
    y: number,
    z: number,
    radius?: number,
  ): THREE.Mesh;
};
export function createTheme(
  palette: ThemePalette,
  environment: ThemeEnvironment,
  build: (builder: Builder) => void,
): ThemeInstance {
  const root = new THREE.Group(),
    geometries = new Set<THREE.BufferGeometry>(),
    owned = new Set<THREE.Material>();
  const material = (spec: MaterialSpec) => {
    const value = new THREE.MeshStandardMaterial(
      typeof spec === 'string' ? { color: spec, roughness: 0.85 } : spec,
    );
    owned.add(value);
    return value;
  };
  const materials = Object.fromEntries(
    MATERIAL_SLOTS.map((slot) => [slot, material(palette[slot])]),
  ) as ThemeInstance['materials'];
  const blocks = palette.blocks.map(material);
  const mesh: Builder['mesh'] = (geometry, color, x, y, z) => {
    geometries.add(geometry);
    const object = new THREE.Mesh(geometry, material(color));
    object.position.set(x, y, z);
    object.castShadow = object.receiveShadow = true;
    root.add(object);
    return object;
  };
  const dispose = () => {
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry);
        for (const value of Array.isArray(object.material) ? object.material : [object.material])
          owned.add(value);
      }
    });
    geometries.forEach((value) => value.dispose());
    owned.forEach((value) => value.dispose());
    root.clear();
  };
  try {
    build({
      root,
      mesh,
      box: (w, h, d, color, x, y, z, radius = 0.08) =>
        mesh(new RoundedBoxGeometry(w, h, d, 3, radius), color, x, y, z),
    });
    return { materials, blocks, environment, decorations: root, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
