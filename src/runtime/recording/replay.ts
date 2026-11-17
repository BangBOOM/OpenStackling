import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Episode } from '../episode';
import { type ActionRow } from '../episode-types';
import type { Action } from '../../simulation/world/types';
import { ReplaySource } from './replay-source';
import { type EpisodeMetadata } from './storage';
import { provenance, runtimeId } from '../provenance';
import { readNpz } from './npz';
import { inspectEpisode } from './inspect';
import { diagnosticValues } from './diagnostics';

export async function episodeRows(root: string, meta: EpisodeMetadata) {
  const width = 16;
  const z = readNpz(await readFile(path.join(root, 'data.npz')));
  const data = (name: string) => z[name].data as Float64Array;
  const tick = (name: string, i: number) => Number((z[name].data as BigInt64Array)[i]);
  const vec = (name: string, i: number, at: number) =>
    Array.from(data(name).subarray(i * width + at, i * width + at + width)) as Action;
  const actions: ActionRow[] = Array.from({ length: meta.counts.actions }, (_, i) => ({
    tick: tick('act.tick', i),
    time: data('act.time')[i],
    executed_action: vec('act.executed', i, 0),
    controller: meta.format.controllers[data('act.controller')[i]],
    ...(data('act.controller')[i] === 0 ? { teacher_action: vec('act.teacher_action', i, 0) } : {}),
    label_valid: Boolean(data('act.label_valid')[i]),
    continuous: Boolean(data('act.continuous')[i]),
  }));
  const observations = Array.from({ length: meta.counts.observations }, (_, i) => ({
    tick: tick('obs.tick', i),
    state: Array.from(data('obs.state').subarray(i * width, i * width + width)),
    cameraToWorld: Array.from(
      { length: 16 },
      (_, j) => data('obs.camera_to_world')[i * 16 + (j % 4) * 4 + Math.floor(j / 4)],
    ),
  }));
  const blocks = meta.format.npz['diag.blocks'].shape[1];
  const blockPositions = new Map<number, { x: number; y: number; z: number }[]>();
  for (let i = 0; i < meta.counts.diagnostics; i++)
    blockPositions.set(
      tick('diag.tick', i),
      Array.from({ length: blocks }, (_, b) => ({
        x: data('diag.blocks')[i * blocks * 13 + b * 13],
        y: data('diag.blocks')[i * blocks * 13 + b * 13 + 1],
        z: data('diag.blocks')[i * blocks * 13 + b * 13 + 2],
      })),
    );
  const diagnostics = new Map(
    Array.from({ length: meta.counts.diagnostics }, (_, i) => [
      tick('diag.tick', i),
      Object.fromEntries(
        Object.keys(meta.format.diagnostics).map((key) => {
          const stride = data(`diag.${key}`).length / meta.counts.diagnostics;
          return [key, data(`diag.${key}`).subarray(i * stride, (i + 1) * stride)];
        }),
      ),
    ]),
  );
  return { actions, observations, blockPositions, diagnostics };
}
export async function replay(root: string) {
  try {
    await readFile(path.join(root, 'result.json'));
    throw new Error(
      'Evaluation results contain no action recording; use collect for replayable data',
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  await inspectEpisode(root);
  const meta: EpisodeMetadata = JSON.parse(
    await readFile(path.join(root, 'metadata.json'), 'utf8'),
  );
  const current = await provenance();
  const sourceMatches = current.sourceHash === meta.provenance.sourceHash;
  const { actions, observations, blockPositions, diagnostics } = await episodeRows(root, meta);

  let index = 0,
    maxJoint = 0,
    maxGap = 0,
    maxCamera = 0,
    maxPosition = 0,
    maxDiagnostic = 0;
  const e = new Episode(
    meta.config,
    (s) => new ReplaySource(s, actions),
    {
      observation(row) {
        const expected = observations[index++];
        if (!expected || expected.tick !== row.tick)
          throw new Error('Replay observation clock mismatch');
        row.state.forEach((v, i) => {
          const d = Math.abs(v - expected.state[i]);
          if (![8, 15].includes(i)) maxJoint = Math.max(maxJoint, d);
          else maxGap = Math.max(maxGap, d);
        });
        row.cameraToWorld.forEach((v, i) => {
          maxCamera = Math.max(maxCamera, Math.abs(v - expected.cameraToWorld[i]));
        });
      },
      action() {},
      diagnostic(row) {
        const recorded = diagnostics.get(row.tick)!;
        for (const [key, values] of Object.entries(diagnosticValues(row.snapshot)))
          values.forEach((value, i) => {
            maxDiagnostic = Math.max(maxDiagnostic, Math.abs(value - recorded[key][i]));
          });
        const expected = blockPositions.get(row.tick);
        if (expected)
          row.snapshot.blocks.forEach((b, i) => {
            const p = expected[i];
            maxPosition = Math.max(
              maxPosition,
              Math.hypot(b.position.x - p.x, b.position.y - p.y, b.position.z - p.z),
            );
          });
      },
    },
    {
      config: meta.config,
      resolvedScene: meta.resolvedScene,
      task: meta.result.task,
      appearance: meta.appearance,
    },
  );
  try {
    while (!e.result && e.sim.ticks < meta.result.ticks) await e.step();
    if (!e.result) e.finish(meta.result.outcome, meta.result.reason);
    e.sim.inspect().blocks.forEach((b, i) => {
      const p = meta.result.final.blocks[i].position;
      maxPosition = Math.max(
        maxPosition,
        Math.hypot(b.position.x - p.x, b.position.y - p.y, b.position.z - p.z),
      );
    });
    const physicalResultMatches =
      meta.result.outcome === 'success'
        ? e.score.success
        : e.result!.outcome === meta.result.outcome &&
          (meta.result.outcome !== 'completed' ||
            Math.abs(e.score.evaluation.heightMeters - meta.result.evaluation.heightMeters) < 1e-3);
    if (
      maxJoint > 1e-3 ||
      maxGap > 1e-4 ||
      maxPosition > 1e-3 ||
      maxCamera > 1e-4 ||
      maxDiagnostic > 1e-5 ||
      !physicalResultMatches ||
      index !== observations.length
    )
      throw new Error(
        `Replay mismatch: ${JSON.stringify({ maxJoint, maxGap, maxPosition, maxCamera, maxDiagnostic, physicalResultMatches, index })}`,
      );
    return {
      sourceMatches,
      runtime: {
        recordedBrowser: meta.provenance.browserVersion ?? null,
        replayRuntime: runtimeId(),
      },
      outcome: e.result!.outcome,
      maxJoint,
      maxGap,
      maxPosition,
      maxCamera,
      maxDiagnostic,
      observations: index,
    };
  } finally {
    e.dispose();
  }
}
