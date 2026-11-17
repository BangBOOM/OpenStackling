import * as shapes from '../world/shape';
import { Quaternion, Vector3 } from 'three';
import { armPartsCollide, linkCollider, forward } from '../world/geometry';
import type { Simulation } from '../world/simulation';
import type { Quat } from '../world/types';
export function objectShape(sim: Simulation, id: number) {
  const shape = sim.objects[id].shape;
  return shape.kind === 'cuboid'
    ? new shapes.Cuboid(shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2)
    : shape.kind === 'cylinder'
      ? new shapes.Cylinder(shape.height / 2, shape.radius)
      : new shapes.Ball(shape.radius);
}
export function robotObjectClearance(
  sim: Simulation,
  joints: number[],
  source: number,
  gap: number,
) {
  const config = sim.config.environment.robot,
    fk = forward(config, joints);
  const clear = (shape: shapes.Shape, position: Vector3, rotation: Quat) =>
    sim.bodies.every(
      (body, id) => id === source || !body.collider(0).intersectsShape(shape, position, rotation),
    );
  const parts: { shape: shapes.Shape; position: Vector3; rotation: Quat; link: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const frame = fk.frames[i],
      descriptor = linkCollider(config, i);
    const [x, y, z] = descriptor.size;
    const shape =
      descriptor.kind === 'sphere' ? new shapes.Ball(x) : new shapes.Cuboid(x / 2, y / 2, z / 2);
    const center = new Vector3(descriptor.x, 0, 0)
      .applyQuaternion(frame.rotation)
      .add(frame.position);
    if (!clear(shape, center, frame.rotation)) return false;
    parts.push({ shape, position: center, rotation: frame.rotation, link: i });
  }
  const frame = fk.frames[5];
  for (const sign of [-1, 1]) {
    const center = new Vector3(
      config.links[5] + config.toolLength - config.fingerLength / 2,
      0,
      (sign * (gap + config.fingerWidth)) / 2,
    )
      .applyQuaternion(frame.rotation)
      .add(frame.position);
    const shape = new shapes.Cuboid(
      config.fingerLength / 2,
      config.fingerDepth / 2,
      config.fingerWidth / 2,
    );
    if (!clear(shape, center, frame.rotation)) return false;
    parts.push({ shape, position: center, rotation: frame.rotation, link: 6 });
  }
  // Connected joints allow contact, and links 3–5 form one overlapping wrist
  // housing. Remaining separated links must clear the open tool's swept volume.
  for (const [i, a] of parts.entries())
    for (const b of parts.slice(i + 1)) {
      if (!armPartsCollide(a.link, b.link)) continue;
      if (a.shape.contactShape(a.position, a.rotation, b.shape, b.position, b.rotation, 0.003))
        return false;
    }
  return true;
}
export function heldObjectClearance(
  sim: Simulation,
  id: number,
  position: Vector3,
  rotation: Quaternion,
  support: number | null,
) {
  const shape = objectShape(sim, id);
  return (
    sim.bodies.every(
      (body, other) =>
        other === id ||
        other === support ||
        !body.collider(0).intersectsShape(shape, position, rotation),
    ) && !sim.table.intersectsShape(shape, position, rotation)
  );
}
