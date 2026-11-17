import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { Simulation } from '../../src/simulation/world/simulation';
import { resolveConfig } from '../../src/runtime/config';
import { worldConfig } from '../../src/simulation/scene';

test('underpowered arm and waist motors cannot hold their loads through gravity feedforward', () => {
  for (const waist of [false, true]) {
    const config = resolveConfig({
      environment: {
        robot: waist
          ? { body: { motor: { maxTorque: [0.000001, 0.000001] } } }
          : { armMotor: { maxTorque: Array(6).fill(0.000001) } },
      },
    });
    // Load the waist forward, away from the mechanical lower stop that supports
    // the neutral robot's slightly rearward center of mass.
    if (waist) config.environment.robot.base[2] = -0.35;
    const sim = new Simulation(worldConfig(config));
    const initial = sim.state();
    try {
      for (let tick = 0; tick < 120 * 3; tick++) sim.step();
      const state = sim.state();
      const displacement = waist
        ? Math.abs(state[1] - initial[1])
        : Math.max(
            ...state.slice(2, 8).map((value, joint) => Math.abs(value - initial[joint + 2])),
          );
      assert(
        displacement > 0.1,
        `${waist ? 'Waist' : 'Arm'} held its load with an ineffective motor`,
      );
    } finally {
      sim.dispose();
    }
  }
});

function waistTracking(continuous: boolean) {
  const sim = new Simulation(worldConfig(resolveConfig()));
  const home = sim.targetState();
  let squared = 0,
    count = 0,
    maximum = 0;
  try {
    for (let tick = 0; tick < 120 * 8; tick++) {
      if (tick % 6 === 0) {
        const action = [...home] as typeof home;
        action[0] = 0.15 * Math.sin(2 * Math.PI * 0.3 * sim.time);
        sim.apply(action, continuous);
      }
      sim.step();
      if (sim.time > 1) {
        const error = sim.state()[0] - sim.targetState()[0];
        squared += error ** 2;
        maximum = Math.max(maximum, Math.abs(error));
        count++;
      }
    }
    return { rmse: Math.sqrt(squared / count), maximum };
  } finally {
    sim.dispose();
  }
}

test('continuous waist tracking reduces moving-target error at the same physics and control rates', () => {
  const waypoint = waistTracking(false),
    continuous = waistTracking(true);
  assert(continuous.rmse < 0.01, `Continuous waist RMSE ${continuous.rmse}`);
  assert(
    continuous.rmse < waypoint.rmse * 0.5,
    `${continuous.rmse} does not improve waypoint RMSE ${waypoint.rmse}`,
  );
  assert(continuous.maximum < waypoint.maximum * 0.5);
});

test('physical wrist envelopes cover the visible roll housing and pitch joint', () => {
  const sim = new Simulation(worldConfig(resolveConfig()));
  try {
    for (const arm of sim.arms) {
      for (const [index, points] of [
        [3, [new Vector3(0.01, 0.03, 0), new Vector3(0.11, 0.03, 0)]],
        [4, [new Vector3(-0.03, 0, 0), new Vector3(0, 0.03, 0)]],
      ] as const) {
        const body = arm.bodies[index];
        for (const point of points) {
          const worldPoint = point
            .clone()
            .applyQuaternion(new Quaternion().copy(body.rotation()))
            .add(body.translation());
          assert(
            body.collider(0).containsPoint(worldPoint),
            `Missing wrist surface ${index}: ${point.toArray()}`,
          );
        }
      }
    }
  } finally {
    sim.dispose();
  }
});
