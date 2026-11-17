import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { EpisodeHost } from '../../src/runtime/host/episode-host';
import {
  HOST_PROTOCOL_VERSION,
  type EpisodeFrame,
  type EpisodeOpened,
} from '../../src/runtime/host-protocol';
import { resolveEpisode } from '../../src/runtime/plan';

async function open(host: EpisodeHost) {
  const config = resolveConfig();
  return host.request<EpisodeOpened>('open', {
    version: HOST_PROTOCOL_VERSION,
    config,
    plan: resolveEpisode(config),
    source: 'teacher',
    name: 'teacher',
    sink: [],
  });
}

test('batched teacher steps preserve measured frames, action/observation counts and decisions', async () => {
  const single = new EpisodeHost(),
    batch = new EpisodeHost();
  try {
    await open(single);
    let frame = (await open(batch)).frame;
    for (const target of [1, 60, 120, 240]) {
      let expected!: EpisodeFrame;
      for (let tick = frame.physics.tick; tick < target; tick++)
        expected = await single.request<EpisodeFrame>('step', {});
      while (frame.physics.tick < target)
        frame = await batch.request<EpisodeFrame>('advance', {
          ticks: target - frame.physics.tick,
        });
      assert.equal(frame.physics.tick, target);
      assert.deepEqual(frame, expected);
    }
    for (const ticks of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await assert.rejects(batch.request('advance', { ticks }), /Invalid advance ticks/);
  } finally {
    await single.close();
    await batch.close();
  }
});

test('batched teacher steps honor pause, resume and stop', async () => {
  const host = new EpisodeHost();
  try {
    await open(host);
    const advancing = host.request<EpisodeFrame>('advance', { ticks: 120 });
    const paused = await host.request<EpisodeFrame>('pause');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await host.request('settled'), paused);
    await host.request('resume');
    await advancing;
    const resumed = await host.request<EpisodeFrame>('advance', { ticks: 120 });
    assert(resumed.physics.tick > paused.physics.tick);
    const acknowledged = await host.request<EpisodeFrame>('pause');
    assert.deepEqual(await host.request('advance', { ticks: 120 }), acknowledged);
    await host.request('resume');
    const pendingBatch = host.request<EpisodeFrame>('advance', { ticks: 120 });
    const stopped = await host.request<EpisodeFrame>('finish', {
      outcome: 'stopped',
      reason: 'test stop',
    });
    assert.equal(stopped.result?.outcome, 'stopped');
    // The batch reply can precede finish; both must describe the same physical boundary.
    assert.deepEqual((await pendingBatch).physics, stopped.physics);
    assert.deepEqual(await host.request('advance', { ticks: 120 }), stopped);
  } finally {
    await host.close();
  }
});

test('host-run pause and stop acknowledge a frozen physical boundary', async () => {
  const host = new EpisodeHost();
  try {
    await open(host);
    const running = host.request<EpisodeFrame>('run');
    const paused = await host.request<EpisodeFrame>('pause');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await host.request('settled'), paused);
    await host.request('resume');
    const stopped = await host.request<EpisodeFrame>('finish', {
      outcome: 'stopped',
      reason: 'run stop',
    });
    const result = await running;
    assert.deepEqual(result.physics, stopped.physics);
    assert.equal(result.result?.outcome, 'stopped');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await host.request('settled'), stopped);
  } finally {
    await host.close();
  }
});
