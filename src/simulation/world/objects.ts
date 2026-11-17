import { Quaternion, Vector3 } from 'three';
import type { Quat, Vec3 } from './types.js';
import { random } from './random.js';
export type ShapeSpec =
  | { kind: 'cuboid'; size: [number, number, number] }
  | { kind: 'cylinder'; radius: number; height: number }
  | { kind: 'sphere'; radius: number };
export const OBJECT_COLORS = {
  red: '#ed7962',
  yellow: '#edc65e',
  teal: '#72b6b2',
  purple: '#a48cc4',
  green: '#9bc597',
  blue: '#82b6da',
} as const;
export type ObjectColor = keyof typeof OBJECT_COLORS;
export type ObjectSpec = {
  id: string;
  shape: ShapeSpec;
  color: ObjectColor;
  rotation: Quat;
  density: number;
  friction: number;
};
export type ResolvedObject = ObjectSpec & { position: Vec3 };
export type ResolvedScene = ResolvedObject[];
export type SceneSpec = {
  objects: ObjectSpec[];
  maxStackHeight: number;
  region: number[];
  clearance: boolean;
  maxAttempts: number;
};
export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
export function cubeObjects(count: number, size = 0.05, colorCounts?: number[]): ObjectSpec[] {
  const colors = Object.keys(OBJECT_COLORS) as ObjectColor[];
  const assigned = colorCounts?.flatMap((n, i) =>
    Array<ObjectColor>(n).fill(colors[i % colors.length]),
  );
  return Array.from({ length: count }, (_, i) => ({
    id: `object-${i}`,
    shape: { kind: 'cuboid', size: [size, size, size] },
    color: assigned?.[i] ?? colors[i % colors.length],
    rotation: { ...IDENTITY },
    density: 120,
    friction: 0.8,
  }));
}
export function sizedObjects(sizes: number[]) {
  return sizes.map((size, i) => ({ ...cubeObjects(1, size)[0], id: `object-${i}` }));
}
export function mixedObjects(): ObjectSpec[] {
  const shapes: ShapeSpec[] = [
    { kind: 'cuboid', size: [0.09, 0.09, 0.09] },
    { kind: 'cuboid', size: [0.18, 0.06, 0.06] },
    { kind: 'cuboid', size: [0.12, 0.04, 0.08] },
    { kind: 'cylinder', radius: 0.04, height: 0.1 },
    { kind: 'cylinder', radius: 0.03, height: 0.14 },
    { kind: 'sphere', radius: 0.04 },
  ];
  return shapes.map((shape, i) => ({ ...cubeObjects(shapes.length)[i], shape }));
}
export function randomSizedObjects(count: number, seed: number, maxHeight = 0.54): ObjectSpec[] {
  const rng = random(seed);
  const maximum = Math.min(0.095, maxHeight / count);
  return sizedObjects(Array.from({ length: count }, () => maximum * (0.68 + rng() * 0.32)));
}
export function randomMixedObjects(count: number, seed: number): ObjectSpec[] {
  const rng = random(seed);
  const between = (low: number, high: number) => low + rng() * (high - low);
  return cubeObjects(count).map((object) => {
    let shape: ShapeSpec;
    switch (Math.floor(rng() * 4)) {
      case 0: {
        const size = between(0.055, 0.095);
        shape = { kind: 'cuboid', size: [size, size, size] };
        break;
      }
      case 1:
        shape = {
          kind: 'cuboid',
          size: [between(0.09, 0.17), between(0.045, 0.075), between(0.045, 0.075)],
        };
        break;
      case 2:
        shape = { kind: 'cylinder', radius: between(0.025, 0.0425), height: between(0.06, 0.13) };
        break;
      default:
        shape = { kind: 'sphere', radius: between(0.0225, 0.04) };
    }
    return { ...object, shape };
  });
}
export function scaledObjects(objects: ObjectSpec[], scale: number): ObjectSpec[] {
  return objects.map((object) => {
    const shape = object.shape;
    const scaled: ShapeSpec =
      shape.kind === 'cuboid'
        ? { kind: 'cuboid', size: shape.size.map((v) => v * scale) as [number, number, number] }
        : shape.kind === 'cylinder'
          ? { kind: 'cylinder', radius: shape.radius * scale, height: shape.height * scale }
          : { kind: 'sphere', radius: shape.radius * scale };
    return { ...structuredClone(object), shape: scaled };
  });
}

export function dimensions(shape: ShapeSpec): [number, number, number] {
  if (shape.kind === 'cuboid') return shape.size;
  if (shape.kind === 'cylinder') return [shape.radius * 2, shape.height, shape.radius * 2];
  return [shape.radius * 2, shape.radius * 2, shape.radius * 2];
}
export function volume(shape: ShapeSpec) {
  if (shape.kind === 'cuboid') return shape.size.reduce((a, b) => a * b, 1);
  if (shape.kind === 'cylinder') return Math.PI * shape.radius ** 2 * shape.height;
  return (4 / 3) * Math.PI * shape.radius ** 3;
}
export function halfExtent(
  shape: ShapeSpec,
  rotation: Quat,
  direction: Vec3 = { x: 0, y: 1, z: 0 },
) {
  const d = new Vector3(direction.x, direction.y, direction.z).applyQuaternion(
    new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).invert(),
  );
  if (shape.kind === 'sphere') return shape.radius;
  if (shape.kind === 'cylinder')
    return (Math.abs(d.y) * shape.height) / 2 + Math.hypot(d.x, d.z) * shape.radius;
  return (
    (Math.abs(d.x) * shape.size[0] +
      Math.abs(d.y) * shape.size[1] +
      Math.abs(d.z) * shape.size[2]) /
    2
  );
}
export function isCube(shape: ShapeSpec) {
  return shape.kind === 'cuboid' && shape.size.every((v) => Math.abs(v - shape.size[0]) < 1e-8);
}
