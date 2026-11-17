import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { resolveConfig } from '../../src/runtime/config';
import { cubeObjects, halfExtent } from '../../src/simulation/world/objects';
import { Simulation } from '../../src/simulation/world/simulation';
import { placementSettled } from '../../src/simulation/control/placement-verification';
import type { Placement } from '../../src/simulation/control/teachers/types';

function fixture(gap = 0) {
  const objects = cubeObjects(2);
  objects[0].shape = { kind: 'cuboid', size: [0.05, 0.0287, 0.0274] };
  objects[1].shape = { kind: 'cuboid', size: [0.0758, 0.0291, 0.02663] };
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  objects[1].rotation = { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w };
  const config = resolveConfig({ task: { kind: 'max-height' }, scene: { objects } });
  const target = {
    x: -0.2,
    y: config.environment.tableTop + 0.0287 + halfExtent(objects[1].shape, objects[1].rotation),
    z: -0.1,
  };
  const sim = new Simulation({
    environment: config.environment,
    scene: objects.map((object, index) => ({
      ...object,
      position: index
        ? { ...target, x: target.x + 0.00488, y: target.y + gap }
        : { x: target.x, y: config.environment.tableTop + 0.0287 / 2, z: target.z },
    })),
  });
  for (let i = 0; i < (gap ? 1 : 180); i++) sim.step();
  const goal: Placement = {
    object: 1,
    support: 0,
    position: target,
    rotation: objects[1].rotation,
  };
  return { sim, goal };
}

test('a released narrow bar may settle 4.88 mm off-center on its actual support', () => {
  const { sim, goal } = fixture();
  try {
    const p = sim.bodies[1].translation();
    assert(Math.hypot(p.x - goal.position.x, p.z - goal.position.z) > 0.02663 * 0.15);
    assert(placementSettled(sim, goal, false));
    assert(!placementSettled(sim, goal, true), 'An unreleased placement must not pass');
    assert(
      !placementSettled(
        sim,
        { ...goal, position: { ...goal.position, y: goal.position.y + 0.02 } },
        false,
      ),
    );
    assert(!placementSettled(sim, { ...goal, rotation: { x: 0, y: 0, z: 0, w: 1 } }, false));
    sim.bodies[1].setAngvel({ x: 0, y: 0.1, z: 0 });
    assert(!placementSettled(sim, goal, false), 'A rotating object must not pass');
  } finally {
    sim.dispose();
  }
});

test('matching pose without real support contact cannot verify a placement', () => {
  const { sim, goal } = fixture(0.03);
  try {
    sim.bodies[1].setLinvel({ x: 0, y: 0, z: 0 });
    sim.bodies[1].setAngvel({ x: 0, y: 0, z: 0 });
    const hoveringGoal = { ...goal, position: { ...sim.bodies[1].translation() } };
    assert(!placementSettled(sim, hoveringGoal, false));
  } finally {
    sim.dispose();
  }
});
