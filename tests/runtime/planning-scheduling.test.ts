import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { Episode } from '../../src/runtime/episode';
import { type EpisodeSink } from '../../src/runtime/episode-types';
import { TeacherSource } from '../../src/runtime/host/teacher-source';
import { WholeBodyTeacher } from '../../src/simulation/control/teachers/whole-body';

test(
  'yielding planning preserves every tick, action, observation and decision',
  { timeout: 120_000 },
  async () => {
    const config = resolveConfig();
    const run = async (cooperative: boolean) => {
      const rows: unknown[] = [];
      const record = (row: unknown) => {
        rows.push(row);
      };
      const sink: EpisodeSink = { action: record, observation: record, diagnostic: record };
      let checkpoints = 0,
        yields = 0;
      const episode = new Episode(
        config,
        (sim, config) => {
          const source = new TeacherSource(sim, config);
          if (!cooperative)
            source.afterStep = () => {
              source.teacher.update();
            };
          return source;
        },
        sink,
        undefined,
        () => {
          if (++checkpoints % 127 !== 0) return;
          const snapshot = episode.sim.inspect();
          yields++;
          return new Promise<void>((resolve) =>
            setTimeout(() => {
              assert.deepEqual(episode.sim.inspect(), snapshot);
              resolve();
            }, 0),
          );
        },
      );
      try {
        for (let i = 0; i < 180; i++) {
          await episode.step();
          rows.push(episode.sim.inspect());
        }
        const teacher = (episode.source as TeacherSource).teacher as WholeBodyTeacher;
        assert.equal(teacher.decisions.length, 1);
        if (cooperative) assert(yields > 1);
        return { rows, decisions: teacher.decisions, rejected: teacher.rejected };
      } finally {
        episode.dispose();
      }
    };
    assert.deepEqual(await run(true), await run(false));
  },
);

for (const stop of [false, true]) {
  test(`planning ${stop ? 'stop closes pending work' : 'pause freezes work until resume'}`, async () => {
    let reached!: () => void, release!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let advanced = false,
      closed = false;
    const episode = new Episode(
      resolveConfig(),
      (sim) => ({
        name: 'test',
        reset() {},
        end() {},
        next: () => ({ action: sim.targetState(), valid: true, reason: '', phase: 'test' }),
        *afterStep() {
          try {
            yield;
            advanced = true;
          } finally {
            closed = true;
          }
        },
      }),
      undefined,
      undefined,
      () => {
        reached();
        return gate;
      },
    );
    try {
      const stepping = episode.step();
      await checkpoint;
      const snapshot = episode.sim.inspect();
      if (stop) episode.finish('stopped', 'test stop');
      else episode.pause();
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(advanced, false);
      assert.deepEqual(episode.sim.inspect(), snapshot);
      if (!stop) episode.resume();
      await stepping;
      assert.equal(advanced, !stop);
      assert.equal(closed, true);
      assert.equal(episode.sim.ticks, 1);
    } finally {
      episode.dispose();
    }
  });
}
