import { physicsBinding } from './binding';
import type { ShapeSpec as ShapeDefinition } from './objects';
import type { Vec3, Quat } from './types';

const query = new Float64Array(23);
export class Shape {
  private readonly encoded: number[];
  constructor(readonly definition: ShapeDefinition) {
    this.encoded =
      definition.kind === 'cuboid'
        ? [0, ...definition.size]
        : definition.kind === 'cylinder'
          ? [1, definition.height, definition.radius, 0]
          : [2, definition.radius, 0, 0];
  }
  contactShape(
    position: Vec3,
    rotation: Quat,
    other: Shape,
    otherPosition: Vec3,
    otherRotation: Quat,
    prediction: number,
  ): { distance: number } | null {
    query.set(this.encoded, 0);
    query.set(other.encoded, 4);
    query[8] = position.x;
    query[9] = position.y;
    query[10] = position.z;
    query[11] = rotation.x;
    query[12] = rotation.y;
    query[13] = rotation.z;
    query[14] = rotation.w;
    query[15] = otherPosition.x;
    query[16] = otherPosition.y;
    query[17] = otherPosition.z;
    query[18] = otherRotation.x;
    query[19] = otherRotation.y;
    query[20] = otherRotation.z;
    query[21] = otherRotation.w;
    query[22] = prediction;
    const distance = physicsBinding.shapeContact(query);
    return Number.isNaN(distance) ? null : { distance };
  }
}
export class Cuboid extends Shape {
  constructor(x: number, y: number, z: number) {
    super({ kind: 'cuboid', size: [x * 2, y * 2, z * 2] });
  }
}
export class Ball extends Shape {
  constructor(radius: number) {
    super({ kind: 'sphere', radius });
  }
}
export class Cylinder extends Shape {
  constructor(halfHeight: number, radius: number) {
    super({ kind: 'cylinder', height: halfHeight * 2, radius });
  }
}
