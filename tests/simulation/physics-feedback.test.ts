import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { resolveConfig } from '../../src/runtime/config';
import { worldConfig } from '../../src/simulation/scene';
import { Simulation } from '../../src/simulation/world/simulation';
import { jointLoads } from '../../src/simulation/world/dynamics';
import { timePath } from '../../src/simulation/control/body-planning';
import { GraspFeedback } from '../../src/simulation/control/grasp-feedback';
import type { Action16D } from '../../src/simulation/world/types';

test('sustained slip cannot wind up grasp force beyond the available motor budget', () => {
  const config = resolveConfig(),
    robot = config.environment.robot;
  const grip = new GraspFeedback(robot, config.teacher.grasp, 0.015, robot.home.gap);
  const contacts = [0, 1].map(() => ({
    normalForce: 0.2,
    frictionLimit: 0.16,
    slipSpeed: 0.02,
    friction: 0.8,
    points: 1,
  }));
  for (let i = 0; i < 1000; i++) grip.update(0.05, contacts, true);
  assert.equal(grip.targetForce, robot.fingerMotor.maxForce * 0.8);
  grip.update(0.05, contacts, false);
  assert(grip.targetForce < robot.fingerMotor.maxForce * 0.8);
  for (let i = 0; i < 20; i++) grip.update(0.05, contacts, false);
  assert.equal(grip.targetForce, config.teacher.grasp.minNormalForce);
  assert(grip.gap >= robot.gap[0] && grip.gap <= robot.gap[1]);
});

test('jaw velocity follows the prismatic anchor when its configured COM is offset', () => {
  const config = resolveConfig({
    environment: { robot: { inertials: { finger: { centerOfMass: [0.02, 0, 0] } } } },
  });
  const sim = new Simulation(worldConfig(config));
  try {
    const axis = new Vector3(0, 1, 0).applyQuaternion(
      new Quaternion().copy(sim.arms[0].rotation()),
    );
    sim.arms[0].fingers[0].setLinvel({ x: 0, y: 0, z: 0 });
    sim.arms[0].fingers[0].setAngvel(axis);
    assert(Math.abs(sim.arms[0].fingerDiagnostics()[0].velocity - 0.02) < 1e-6);
  } finally {
    sim.dispose();
  }
});

test('collision envelopes cannot silently change configured robot mass properties', () => {
  const original = resolveConfig();
  const altered = resolveConfig(original, {
    environment: { robot: { visual: { armRadius: 0.05, wristRadius: 0.03 }, gap: [0.003, 0.095] } },
  });
  const sims = [original, altered].map((config) => new Simulation(worldConfig(config)));
  try {
    const properties = (sim: Simulation) =>
      [sim.body.torso, ...sim.arms.flatMap((arm) => [...arm.bodies, ...arm.fingers])].map(
        (body) => [
          body.mass(),
          { ...body.localCom() },
          { ...body.principalInertia() },
          { ...body.principalInertiaLocalFrame() },
        ],
      );
    assert.deepEqual(properties(sims[0]), properties(sims[1]));
    assert(
      Math.abs(
        sims[0].arms[0].bodies[3].principalInertia().x -
          original.environment.robot.inertials.arms[3].principalInertia[0],
      ) < 1e-9,
    );
    assert(sims[0].arms[0].bodies[3].principalInertia().x < 0.0001);
  } finally {
    sims.forEach((sim) => sim.dispose());
  }
});

test('compliant jaw coupling reduces common displacement under an external load', () => {
  const centers = [0, 600].map((couplingStiffness) => {
    const sim = new Simulation(
      worldConfig(
        resolveConfig({
          environment: {
            robot: { fingerMotor: { couplingStiffness, couplingDamping: couplingStiffness / 15 } },
          },
        }),
      ),
    );
    try {
      for (let tick = 0; tick < 360; tick++) {
        const axis = new Vector3(0, 0, 1).applyQuaternion(
          new Quaternion().copy(sim.arms[0].rotation()),
        );
        for (const finger of sim.arms[0].fingers) {
          finger.resetForces();
          finger.addForce(axis.clone().multiplyScalar(0.5));
        }
        sim.step();
      }
      const fingers = sim.arms[0].fingerDiagnostics();
      assert(Math.abs(sim.arms[0].pose().gap - sim.config.environment.robot.home.gap) < 0.001);
      assert(
        fingers.every(
          (finger) =>
            Math.abs(finger.limitedForceEstimate) <=
            sim.config.environment.robot.fingerMotor.maxForce,
        ),
      );
      return Math.abs((fingers[0].position + fingers[1].position) / 2);
    } finally {
      sim.dispose();
    }
  });
  assert(centers[0] > 0.001);
  assert(centers[1] < centers[0] * 0.6);
});

test('load estimates slow torque-limited paths and reject a statically impossible payload', () => {
  const config = resolveConfig(),
    sim = new Simulation(worldConfig(config));
  try {
    const from = sim.targetState() as Action16D,
      to = [...from] as Action16D;
    to[3] += 0.1;
    const unloaded = timePath(sim, [from, to]);
    const model = jointLoads(config.environment.robot, from);
    sim.config.environment.robot.armMotor.maxTorque[1] = Math.abs(model[3].gravity) + 0.01;
    const limited = timePath(sim, [from, to]);
    assert(limited.duration > unloaded.duration);
    sim.bodies[0].setAdditionalMass(100);
    const overloaded = timePath(
      sim,
      [from, to],
      { side: 0, position: new Vector3(), rotation: new Quaternion() },
      0,
    );
    assert.equal(overloaded.feasible, false);
  } finally {
    sim.dispose();
  }
});

test('growing the native frame buffer preserves one physical step and immutable measurements', () => {
  const config = resolveConfig();
  const expected = new Simulation(worldConfig(config));
  const actual = new Simulation(worldConfig(config));
  try {
    const before = actual.frame;
    const snapshot = structuredClone(before);
    (actual as any).buffer = new Float64Array(8);
    actual.step();
    expected.step();
    assert.equal(actual.ticks, 1);
    assert.deepEqual(actual.frame, expected.frame);
    assert.deepEqual(before, snapshot);
  } finally {
    expected.dispose();
    actual.dispose();
  }
});

test('released fingers do not keep touching through recycled narrow-phase distances', () => {
  const config = resolveConfig(),
    sim = new Simulation(worldConfig(config));
  try {
    const object = sim.bodies[0],
      arm = sim.arms[0];
    object.setTranslation(arm.pose());
    object.setRotation(arm.rotation());
    object.setGravityScale(0);
    for (let i = 0; i < 120; i++) sim.step();
    assert(sim.touching(object));
    const action = sim.targetState() as Action16D;
    action[8] = config.environment.robot.gap[1];
    sim.apply(action);
    let separated = 0;
    for (let i = 0; i < 120; i++) {
      sim.step();
      const other = object.collider(0);
      const contacts = arm.fingers.map((finger) => {
        const collider = finger.collider(0);
        return collider.shape.contactShape(
          collider.translation(),
          collider.rotation(),
          other.shape,
          other.translation(),
          other.rotation(),
          0.2,
        );
      });
      if (contacts.every((contact) => contact === null || contact.distance > 0.001)) {
        assert.equal(sim.touching(object), false);
        separated++;
      }
    }
    assert(separated > 50);
  } finally {
    sim.dispose();
  }
});
