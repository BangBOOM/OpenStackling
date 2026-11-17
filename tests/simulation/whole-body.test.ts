import { teacherSource } from '../../src/runtime/host/teacher-source';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { resolveConfig } from '../../src/runtime/config';
import { Simulation } from '../../src/simulation/world/simulation';
import { actionLimits } from '../../src/simulation/world/actions';
import { cubeObjects } from '../../src/simulation/world/objects';
import { worldConfig } from '../../src/simulation/scene';
import { makeCamera } from '../../src/simulation/sensors/camera';
import {
  bodyKin,
  bodyClear,
  graspOrientation,
  jointPath,
  cartesianPath,
  samplePath,
  type Path,
} from '../../src/simulation/control/body-planning';
import { Episode } from '../../src/runtime/episode';
import { TeacherSource } from '../../src/runtime/host/teacher-source';
import { WholeBodyTeacher } from '../../src/simulation/control/teachers/whole-body';
import type { Action16D } from '../../src/simulation/world/types';

test(
  'the default pair completes within ten seconds and retains released stability',
  { timeout: 120_000 },
  async () => {
    for (const seed of [42, 2026]) {
      const forces: number[] = [];
      const episode = new Episode(resolveConfig({ run: { seed } }), teacherSource, {
        diagnostic(row) {
          if (row.phase !== 'carry') return;
          for (const contacts of row.snapshot.contacts.flat())
            if (contacts.every((contact) => contact.normalForce > 0))
              forces.push(...contacts.map((contact) => contact.normalForce));
        },
      });
      const teacher = (episode.source as TeacherSource).teacher;
      let endpoints = 0;
      try {
        assert.equal(episode.config.task.stableSeconds, 1);
        while (!episode.result) {
          const path = (teacher as unknown as { path?: Path }).path;
          await episode.step();
          if (path && path !== (teacher as unknown as { path?: Path }).path) {
            // A phase may advance only after its final joint targets reached the actuator boundary.
            const target = episode.sim.targetState(),
              expected = path.samples.at(-1)!;
            target.forEach((value, joint) => {
              if (joint !== 8 && joint !== 15) assert(Math.abs(value - expected[joint]) <= 1e-9);
            });
            endpoints++;
          }
        }
        const result = episode.result;
        assert.equal(result.outcome, 'success', result.reason);
        assert.equal(teacher.decisions.length, 1);
        assert(result.seconds < 10, `Seed ${seed} took ${result.seconds} simulated seconds`);
        assert(result.stableSeconds + 1e-9 >= episode.config.task.stableSeconds);
        assert(endpoints >= 3);
        assert(forces.length > 20);
        forces.sort((a, b) => a - b);
        assert(forces[Math.floor(forces.length / 2)] < 3);
        for (let i = 0; i < episode.config.environment.physicsHz * 10; i++) {
          episode.sim.step();
          episode.score.update();
          assert(episode.score.stable);
        }
      } finally {
        episode.dispose();
      }
    }
  },
);

test('whole-body actions require sixteen in-range targets', () => {
  const config = resolveConfig();
  assert.equal(actionLimits(config.environment.robot).length, 16);
  assert.equal(resolveConfig().environment.version, 'stackling-v5.4');
  assert.throws(
    () => resolveConfig({ environment: { version: 'unknown-environment' } }),
    /environment version/,
  );
  assert.equal(resolveConfig(config, { task: { kind: 'max-height' } }).task.kind, 'max-height');
  assert.throws(
    () => resolveConfig(config, { teacher: { policy: { waistTravel: -1 } } }),
    /teacher policy/,
  );
  const sim = new Simulation(worldConfig(config));
  try {
    assert.throws(() => sim.apply([0, 0, 0, 0, 0, 0, 0.05] as any), /sixteen/);
    const invalid = sim.targetState() as Action16D;
    invalid[1] = 0.8;
    assert.throws(() => sim.apply(invalid), /in-range/);
  } finally {
    sim.dispose();
  }
});

test('physical waist carries both shoulders and the head sensor while the pedestal stays fixed', () => {
  const config = resolveConfig({ camera: { mount: 'head' } });
  const sim = new Simulation(worldConfig(config));
  try {
    assert.equal(sim.arms.length, 2);
    assert.equal(
      sim.arms.every((arm) => arm.bodies.every((body) => body.isDynamic())),
      true,
    );
    const fixed = { ...sim.body!.fixed.translation() };
    const camera = makeCamera(config.camera, config.environment, sim.body!.transform());
    const target = sim.targetState() as Action16D;
    target[0] = 0.2;
    target[1] = 0.2;
    assert.equal(bodyClear(sim, target, -1), true);
    sim.apply(target);
    for (let i = 0; i < 720; i++) sim.step();
    assert(Math.abs(sim.state()[0] - 0.2) < 10 ** -3);
    assert(Math.abs(sim.state()[1] - 0.2) < 10 ** -2);
    assert.deepEqual({ ...sim.body!.fixed.translation() }, fixed);
    for (const side of [0, 1]) {
      const fk = bodyKin(sim, side, sim.state().slice(0, 2)).forward(sim.arms[side].angles());
      assert(fk.position.distanceTo(new Vector3().copy(sim.arms[side].pose())) < 0.002);
    }
    const moved = makeCamera(config.camera, config.environment, sim.body!.transform());
    assert(camera.position.distanceTo(moved.position) > 0.08);
    assert(camera.quaternion.angleTo(moved.quaternion) > 0.2);
    // A commanded body motion cannot pick up objects without finger contact.
    assert.equal(
      sim.bodies.every((_, i) => Math.abs(sim.bottom(i) - config.environment.tableTop) < 0.001),
      true,
    );
  } finally {
    sim.dispose();
  }
});

test('the second gripper has independent physical control', () => {
  const sim = new Simulation(worldConfig(resolveConfig()));
  try {
    const target = sim.targetState() as Action16D;
    target[8] = 0.025;
    target[15] = 0.08;
    sim.apply(target);
    for (let i = 0; i < 360; i++) sim.step();
    assert(Math.abs(sim.arms[0].pose().gap - 0.025) < 10 ** -3);
    assert(Math.abs(sim.arms[1].pose().gap - 0.08) < 10 ** -3);
  } finally {
    sim.dispose();
  }
});

test('a horizontal grasp lifts a cube through bilateral friction without attachment joints', () => {
  const config = resolveConfig(),
    world = worldConfig(config);
  world.scene[0].position = { x: -0.28, y: 0.775, z: -0.1 };
  world.scene[1].position = { x: 0.28, y: 0.775, z: 0.1 };
  const sim = new Simulation(world);
  try {
    const count = sim.metadata.impulseJoints,
      kin = bodyKin(sim, 0, [0, 0.25]);
    const rotation = graspOrientation(new Vector3(0, 0, 1), new Vector3(1, 0, 0));
    const grip = new Vector3(-0.28, 0.787, -0.068),
      pre = grip.clone().add(new Vector3(0, 0.06, -0.09));
    const at = sim.targetState() as Action16D;
    at[1] = 0.25;
    at[8] = 0.08;
    const q = kin.inverse(pre, at.slice(2, 8), rotation);
    assert(q);
    at.splice(2, 6, ...q);
    const move = (path: Path) => {
      const begin = sim.time;
      while (sim.time - begin < path.duration + 1) {
        if (sim.ticks % 6 === 0) sim.apply(samplePath(path, sim.time - begin), true);
        sim.step();
      }
    };
    const approach = jointPath(sim, sim.targetState() as Action16D, at, 0);
    assert(approach);
    move(approach);
    const insert = cartesianPath(sim, at, 0, [grip], rotation, 0.08, 0);
    assert(insert);
    move(insert);
    const close = sim.targetState() as Action16D;
    close[8] = 0.003;
    sim.apply(close);
    for (let i = 0; i < 120; i++) sim.step();
    assert(sim.arms[0].contact(sim.bodies[0]).every(Boolean));
    const lift = cartesianPath(
      sim,
      sim.targetState() as Action16D,
      0,
      [grip.clone().add(new Vector3(0, 0.12, 0))],
      rotation,
      sim.arms[0].pose().gap,
      0,
    );
    assert(lift);
    lift.duration = 3;
    for (const sample of lift.samples) sample[8] = 0.003;
    move(lift);
    assert(sim.bottom(0) > config.environment.tableTop + 0.1);
    assert(sim.arms[0].contact(sim.bodies[0]).every(Boolean));
    assert.equal(sim.metadata.impulseJoints, count);
  } finally {
    sim.dispose();
  }
});

test(
  'five-cube releases and post-grasp planning complete without premature failure',
  { timeout: 120_000 },
  async () => {
    for (const seed of [1, 14, 18]) {
      const episode = new Episode(
        resolveConfig({
          scene: { objects: cubeObjects(5) },
          run: { seed },
        }),
        teacherSource,
      );
      try {
        const joints = episode.sim.metadata.impulseJoints;
        const result = await episode.run();
        assert.equal(result.outcome, 'success', `Seed ${seed}: ${result.reason}`);
        assert.equal(result.evaluation.completed, 5);
        assert(result.stableSeconds + 1e-9 >= episode.config.task.stableSeconds);
        assert.equal(episode.sim.metadata.impulseJoints, joints);
        for (let tick = 0; tick < episode.config.environment.physicsHz * 10; tick++) {
          episode.sim.step();
          episode.score.update();
          assert(episode.score.success, `Seed ${seed} lost released stability`);
        }
      } finally {
        episode.dispose();
      }
    }
  },
);
