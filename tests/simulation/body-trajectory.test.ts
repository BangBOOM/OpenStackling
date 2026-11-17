import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { worldConfig } from '../../src/simulation/scene';
import { Simulation } from '../../src/simulation/world/simulation';
import type { Action16D } from '../../src/simulation/world/types';
import {
  bodyKin,
  bodyClear,
  timePath,
  samplePath,
} from '../../src/simulation/control/body-planning';
import { kinematics } from '../../src/simulation/control/kinematics';
import { Quaternion, Vector3 } from 'three';

test('IK tool-only forward evaluation preserves the exact full-frame tool pose', () => {
  const config = resolveConfig();
  const sim = new Simulation(worldConfig(config));
  try {
    const solvers = [
      kinematics(resolveConfig().environment),
      ...[0, 1].flatMap((side) =>
        [
          [0, 0],
          [-0.35, 0.4],
          [0.6, 0.15],
        ].map((waist) => bodyKin(sim, side, waist)),
      ),
    ];
    for (const kin of solvers) {
      const straight = Array(6).fill(0),
        pose = kin.forward(straight);
      const nearReach = pose.position
        .clone()
        .add(new Vector3(0.0000005, 0, 0).applyQuaternion(pose.rotation));
      const nearRotation = pose.rotation
        .clone()
        .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.004));
      assert.deepEqual(kin.inverse(nearReach, straight, nearRotation), straight);
      for (let sample = 0; sample < 100; sample++) {
        const q = config.environment.robot.limits.map(
          ([low, high], joint) => low + ((high - low) * ((sample * (joint + 1)) % 100)) / 100,
        );
        const full = kin.forward(q),
          tool = kin.toolPose(q);
        assert.deepEqual(tool.position, full.position);
        assert.deepEqual(tool.rotation, full.rotation);
        assert.equal(full.frames.length, 6);
        assert.deepEqual(kin.inverse(full.position, q, full.rotation), q);
      }
    }
  } finally {
    sim.dispose();
  }
});

test('straight joint motion timing is independent of redundant path sampling density', () => {
  const sim = new Simulation(worldConfig(resolveConfig()));
  try {
    const home = sim.targetState() as Action16D;
    const paths = [2, 5, 10, 31, 100].map((count) =>
      timePath(
        sim,
        Array.from(
          { length: count },
          (_, i) =>
            home.map((value, joint) => value + (joint === 3 ? i / (count - 1) : 0)) as Action16D,
        ),
      ),
    );
    for (const path of paths) {
      assert(path.duration < 5, `One radian straight move takes ${path.duration}s`);
      assert(Math.abs(path.duration - paths[0].duration) < 1e-9);
      for (let sample = 0; sample <= 20; sample++)
        assert.deepEqual(
          samplePath(path, (path.duration * sample) / 20),
          samplePath(paths[0], (paths[0].duration * sample) / 20),
        );
    }
  } finally {
    sim.dispose();
  }
});

function fixture() {
  const sim = new Simulation(worldConfig(resolveConfig()));
  const home = sim.targetState() as Action16D;
  const changes = [
    [0, 0, 0, 0, 0.045],
    [0.0001, 0.0001, 0.0002, 0, 0.045],
    [0.1, 0.12, 0.22, -0.1, 0.08],
    [0.11, 0.12, 0.23, -0.32, 0.08],
    [-0.2, 0.3, -0.05, -0.34, 0.025],
    [-0.21, 0.31, -0.06, -0.34, 0.025],
  ];
  const samples = changes.map(([yaw, pitch, first, second, gap]) => {
    const state = [...home] as Action16D;
    state[0] = yaw;
    state[1] = pitch;
    state[9] += first;
    state[10] += second;
    state[8] = gap;
    state[15] = 0.105 - gap;
    return state;
  });
  return { sim, samples };
}

test('uneven joint samples and Cartesian corners respect local speed, acceleration and jerk limits', () => {
  const { sim, samples } = fixture();
  try {
    const path = timePath(sim, samples),
      robot = sim.config.environment.robot;
    const count = 24000,
      dt = path.duration / count;
    let previous = samplePath(path, 0),
      previousVelocity: number[] | undefined,
      previousAcceleration: number[] | undefined;
    const speeds = Array(16).fill(0),
      accelerations = Array(16).fill(0),
      jerks = Array(16).fill(0);
    for (let i = 1; i <= count; i++) {
      const current = samplePath(path, dt * i);
      const velocity = current.map((v, j) => (v - previous[j]) / dt);
      const acceleration =
        previousVelocity && velocity.map((v, j) => (v - previousVelocity![j]) / dt);
      for (let j = 0; j < current.length; j++) {
        speeds[j] = Math.max(speeds[j], Math.abs(velocity[j]));
        if (previousVelocity)
          accelerations[j] = Math.max(
            accelerations[j],
            Math.abs(velocity[j] - previousVelocity[j]) / dt,
          );
        if (acceleration && previousAcceleration)
          jerks[j] = Math.max(jerks[j], Math.abs(acceleration[j] - previousAcceleration[j]) / dt);
      }
      previous = current;
      previousVelocity = velocity;
      previousAcceleration = acceleration;
    }
    for (let j = 0; j < 16; j++) {
      const gap = j === 8 || j === 15;
      const speed = gap ? robot.speed.gap : j < 2 ? robot.body!.speed : robot.jointSpeed * 0.65;
      assert(speeds[j] <= speed + 1e-6, `axis ${j} speed ${speeds[j]} exceeds ${speed}`);
      if (!gap) {
        const acceleration = j < 2 ? robot.body!.acceleration : robot.jointAcceleration * 0.65;
        assert(
          accelerations[j] <= acceleration + 1e-4,
          `axis ${j} acceleration ${accelerations[j]} exceeds ${acceleration}`,
        );
        const jerk = j < 2 ? robot.body.jerk : robot.jointJerk * 0.65;
        assert(jerks[j] <= jerk + 0.01, `axis ${j} jerk ${jerks[j]} exceeds ${jerk}`);
      }
    }
  } finally {
    sim.dispose();
  }
});

test('quintic retiming has continuous knot velocities and accelerations without overshoot', () => {
  const { sim, samples } = fixture();
  try {
    const path = timePath(sim, samples);
    assert.deepEqual(samplePath(path, -1), samples[0]);
    assert.deepEqual(samplePath(path, path.duration + 1), samples.at(-1));
    for (let segment = 0; segment < path.samples.length - 1; segment++)
      for (let step = 0; step <= 40; step++) {
        const t =
          path.knots[segment] + ((path.knots[segment + 1] - path.knots[segment]) * step) / 40;
        const state = samplePath(path, t * path.duration);
        state.forEach((value, j) => {
          assert(value >= Math.min(path.samples[segment][j], path.samples[segment + 1][j]) - 1e-12);
          assert(value <= Math.max(path.samples[segment][j], path.samples[segment + 1][j]) + 1e-12);
        });
      }
    const epsilon = path.duration * 1e-7;
    for (const knot of path.knots.slice(1, -1)) {
      const at = knot * path.duration,
        before = samplePath(path, at - epsilon),
        center = samplePath(path, at),
        after = samplePath(path, at + epsilon);
      center.forEach((value, j) => {
        const left = (value - before[j]) / epsilon,
          right = (after[j] - value) / epsilon;
        assert(Math.abs(left - right) < 1e-4, `axis ${j} jumps in velocity at ${knot}`);
      });
    }
    const extended = { ...path, duration: path.duration * 2 };
    assert.deepEqual(
      samplePath(extended, path.duration * 0.74),
      samplePath(path, path.duration * 0.37),
    );
  } finally {
    sim.dispose();
  }
});

test('holding trajectories and replacing grasp gaps cannot introduce interpolated gap overshoot', () => {
  const { sim, samples } = fixture();
  try {
    const hold = timePath(sim, [samples[0], [...samples[0]], [...samples[0]]]);
    assert.deepEqual(samplePath(hold, hold.duration / 2), samples[0]);
    const path = timePath(sim, samples);
    for (const state of path.samples) state[8] = state[15] = sim.config.environment.robot.gap[0];
    for (let i = 0; i <= 100; i++) {
      const state = samplePath(path, (path.duration * i) / 100);
      assert.equal(state[8], sim.config.environment.robot.gap[0]);
      assert.equal(state[15], sim.config.environment.robot.gap[0]);
    }
  } finally {
    sim.dispose();
  }
});

test('release collision previews use the placed object without mutating measured physics', () => {
  const sim = new Simulation(worldConfig(resolveConfig()));
  try {
    const home = sim.targetState() as Action16D;
    const before = sim.inspect();
    assert(bodyClear(sim, home, -1));
    const wrist = bodyKin(sim, 0, home.slice(0, 2)).forward(home.slice(2, 8)).frames[4];
    const placement = {
      object: 0,
      support: null,
      position: wrist.position,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    assert(!bodyClear(sim, home, -1, undefined, undefined, placement));
    assert.deepEqual(sim.inspect(), before);
    assert(bodyClear(sim, home, -1));
  } finally {
    sim.dispose();
  }
});
