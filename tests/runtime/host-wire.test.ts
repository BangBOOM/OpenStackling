import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/runtime/config';
import { worldConfig } from '../../src/simulation/scene';
import { Simulation } from '../../src/simulation/world/simulation';
import { encodeHostMessage, decodeHostMessage } from '../../src/runtime/host-wire';
import { measuredFrameValues, readMeasuredFrame } from '../../src/simulation/world/frame-buffer';
import { HostRecording } from '../../src/runtime/host/recording';
import type { PacketRow } from '../../src/runtime/recording/protocol';

test('binary host packets preserve measurements and exclude solver diagnostics', () => {
  const sim = new Simulation(worldConfig(resolveConfig()));
  try {
    sim.step();
    const {
      colliders: _,
      pairs: _pairs,
      actuators: _actuators,
      fingers: _fingers,
      contacts: _contacts,
      ...measured
    } = sim.frame;
    for (const value of [
      sim.frame,
      { physics: sim.frame },
      { metadata: sim.metadata, frame: { physics: sim.frame } },
    ]) {
      const encoded = encodeHostMessage({ id: 1, value });
      assert(encoded instanceof Uint8Array);
      const unaligned = Buffer.alloc(encoded.length + 1);
      unaligned.set(encoded, 1);
      assert.deepEqual(decodeHostMessage(unaligned.subarray(1)), decodeHostMessage(encoded));
      const decoded = decodeHostMessage(encoded) as any;
      assert.deepEqual(
        decoded.value.physics ?? decoded.value.frame?.physics ?? decoded.value,
        measured,
      );
    }
    const header = encodeHostMessage({
      id: -1,
      method: 'sink.observation',
      payload: { frame: { physics: sim.frame }, data: { tick: sim.ticks } },
    });
    const callback = decodeHostMessage(header) as any;
    assert.deepEqual(callback.payload.frame.physics, measured);
    assert(header.length < new TextEncoder().encode(JSON.stringify(sim.frame)).length);
    const malformed = measuredFrameValues(measured);
    malformed[1] = Number.MAX_SAFE_INTEGER;
    assert.throws(() => readMeasuredFrame(malformed), /frame count/);
  } finally {
    sim.dispose();
  }
});

test('host recording snapshots action arrays and drains its final partial batch', async () => {
  const rows: PacketRow[] = [];
  const recording = new HostRecording(async (values) => {
    rows.push(...values);
  });
  const action = Array(16).fill(0) as any;
  recording.action({
    tick: 0,
    time: 0,
    executed_action: action,
    controller: 'client',
    continuous: true,
  });
  action[0] = 1;
  assert.equal(rows.length, 0);
  await recording.flush();
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as any).row.executed_action[0], 0);
});

import { session } from '../../src/runtime/host/session';
import { resolveEpisode } from '../../src/runtime/plan';
import { HOST_PROTOCOL_VERSION } from '../../src/runtime/host-protocol';

test('visual-only host runs send observations without action or diagnostic callbacks', async () => {
  const callbacks: string[] = [];
  let final: any;
  const runtime = session((data) => {
    const message = decodeHostMessage(data);
    if ('method' in message) {
      callbacks.push(message.method);
      void runtime.receive(JSON.stringify({ id: message.id, value: null }));
    } else if (!message.error) final = message.value;
    else throw new Error(message.error.message);
  });
  const config = resolveConfig({ run: { maxSeconds: 0.2 } });
  try {
    await runtime.receive(
      JSON.stringify({
        id: 1,
        method: 'open',
        payload: {
          version: HOST_PROTOCOL_VERSION,
          config,
          plan: resolveEpisode(config),
          source: 'teacher',
          name: 'teacher',
          sink: ['observation'],
        },
      }),
    );
    await runtime.receive(JSON.stringify({ id: 2, method: 'run', payload: null }));
    assert.deepEqual(callbacks, ['sink.observation', 'sink.observation']);
    assert.equal(final.physics.tick, 24);
    assert.equal(final.observations, 2);
    assert.equal(final.actions, 4);
  } finally {
    await runtime.close();
  }
});
