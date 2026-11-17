import { assertCompatible } from '../policy/contract';
import { validateRecord } from '../recording/record-validation';
import type { Config } from '../config';
import type { EpisodePlan } from '../plan';
import type { EpisodeRecord, ResultStore } from '../recording/result-store';
import { atomicJson, acquireDatasetLock } from '../recording/storage';
import { provenance, hash } from '../provenance';
import { summarizeRun } from './summary';
import { appearanceIdentity, sameAppearance } from '../appearance';
import { canonicalize } from 'json-canonicalize';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunExecutor } from './contracts';
import { memorySampler } from './memory';
import type { RunOptions } from './contracts';
import { readManifest, type RunManifest } from './manifest';
export async function executePlan(
  config: Config,
  plan: EpisodePlan[],
  options: RunOptions,
  store: ResultStore,
  executor: RunExecutor,
) {
  if (options.policy && (options.workers !== 1 || options.positions))
    throw new Error('External policy requires one worker and a fixed camera');
  if (!Number.isInteger(options.workers) || options.workers < 1)
    throw new Error('workers must be a positive integer');
  if (options.policy)
    for (const entry of plan) assertCompatible(options.policy.manifest.profile, entry.config);
  const sceneGeneration = options.sceneGeneration;
  const positions = options.positions ?? [config.camera.position];
  const root = path.resolve(options.out),
    source = await provenance(),
    identity = hash(
      canonicalize({
        kind: store.header.kind,
        config,
        appearance: appearanceIdentity(config.appearance.theme),
        plan,
        ...(sceneGeneration ? { sceneGeneration } : {}),
        positions,
        sourceHash: source.sourceHash,
        policy: options.policy?.manifest,
      }),
    );
  let manifest: RunManifest;
  if (options.resume) {
    manifest = await readManifest(root, store.header);
    if (
      manifest.identity !== identity ||
      canonicalize(manifest.sceneGeneration ?? null) !== canonicalize(sceneGeneration ?? null) ||
      canonicalize(manifest.plan) !== canonicalize(plan) ||
      !sameAppearance(manifest.appearance, appearanceIdentity(config.appearance.theme))
    )
      throw new Error('Resume configuration/source mismatch');
  } else {
    await mkdir(root, { recursive: false });
    manifest = {
      ...store.header,
      appearance: appearanceIdentity(config.appearance.theme),
      identity,
      config,
      sourceHash: source.sourceHash,
      seeds: options.seeds,
      plan,
      ...(sceneGeneration ? { sceneGeneration } : {}),
      positions,
      completed: {},
      checksums: {},
      ...(options.policy ? { policy: options.policy.manifest } : {}),
      status: 'running',
      browserVersion: '',
      interruptions: 0,
    };
  }
  const plannedConfig = (index: number) => structuredClone(plan[index].config);
  const unlock = await acquireDatasetLock(root);
  try {
    const manifestPath = path.join(root, 'manifest.json');
    await mkdir(path.join(root, 'episodes'), { recursive: true });
    const previousEntries = manifest.completed;
    const previousChecksums = manifest.checksums;
    manifest.checksums = {};
    const previouslyCompleted = Object.keys(previousEntries);
    manifest.completed = {};
    // Recover an episode committed before the process could update the manifest.
    for (const name of await readdir(path.join(root, 'episodes'))) {
      if (name.startsWith('.')) continue;
      const index = Number(name),
        seed = plan[index]?.config.run.seed;
      if (!/^\d{6}$/.test(name) || seed === undefined)
        throw new Error('Unexpected episode directory');
      const m = await store.read(root, name);
      await validateRecord(m, plan[index], source.sourceHash, options.policy?.manifest);
      const recordHash = hash(canonicalize(m));
      if (Object.hasOwn(previousEntries, name) && previousChecksums[name] !== recordHash)
        throw new Error('Committed result checksum mismatch');
      manifest.checksums[name] = recordHash;
      manifest.completed[name] = {
        seed,
        outcome: m.result.outcome,
        taskKind: m.result.evaluation.kind,
        caseIndex: plan[index].caseIndex,
        evaluation: m.result.evaluation,
      };
    }
    if (previouslyCompleted.some((id) => !manifest.completed[id]))
      throw new Error('A committed episode is missing');
    manifest.status = 'running';
    await atomicJson(manifestPath, manifest);
    const stamp = () => `[${new Date().toTimeString().slice(0, 8)}]`,
      progress = options.progress?.(
        plan.length,
        Object.keys(manifest.completed).length,
        Object.values(manifest.completed).filter((e) =>
          ['success', 'completed'].includes(e.outcome),
        ).length,
        store.header.kind === 'evaluation' ? 'evaluate' : 'collect',
      ),
      started = performance.now();
    let next = 0,
      stopped = options.signal?.aborted ?? false,
      manifestChain = Promise.resolve();
    const onAbort = () => {
      stopped = true;
      progress?.event(`${stamp()} interrupt received; finishing active episodes`);
      void executor.stop();
    };
    options.signal?.addEventListener('abort', onAbort);
    const memory = memorySampler();
    let memoryMetrics: Awaited<ReturnType<typeof memory.stop>>;
    const results: EpisodeRecord[] = [];
    try {
      await executor.start(Math.min(options.workers, plan.length));
      if (
        manifest.browserVersion !== executor.browserVersion &&
        Object.keys(manifest.completed).length
      )
        throw new Error('Resume browser version mismatch');
      manifest.browserVersion = executor.browserVersion;
      const loop = async (worker: number) => {
        const workerExecutor = await executor.worker(worker);
        // One episode's export may overlap the next episode's browser run, so
        // the page is not idle while Node decompresses depth and builds the npz.
        let finishing: Promise<void> = Promise.resolve(),
          commitError: unknown;
        try {
          for (;;) {
            if (commitError) throw commitError;
            if (stopped) return;
            const index = next++;
            if (index >= plan.length) return;
            const id = String(index).padStart(6, '0');
            if (manifest.completed[id]) continue;
            const c = plannedConfig(index);
            progress?.worker(1);
            try {
              // A page whose episode failed on the transient encoder defect is
              // recreated rather than reused, so the retry starts from clean state.
              for (let attempt = 1; ; attempt++) {
                const { writer, sink } = store.create(
                  root,
                  plan[index],
                  { ...source, browserVersion: executor.browserVersion },
                  options.policy?.manifest,
                );
                await writer.begin();
                try {
                  if (stopped) {
                    await finishing;
                    await writer.interrupt('User interrupted');
                    return;
                  }
                  const output = await workerExecutor.run(plan[index], sink);
                  if (output.result.outcome === 'stopped') {
                    await finishing;
                    await writer.interrupt('User interrupted');
                    return;
                  }
                  finishing = finishing.then(async () => {
                    try {
                      const metadata = await writer.finish(output.result, output.metrics);
                      results.push(metadata);
                      manifest.checksums[id] = hash(canonicalize(metadata));
                      manifest.completed[id] = {
                        seed: c.run.seed,
                        outcome: output.result.outcome,
                        taskKind: output.result.evaluation.kind,
                        caseIndex: plan[index].caseIndex,
                        evaluation: output.result.evaluation,
                      };
                      manifestChain = manifestChain.then(() => atomicJson(manifestPath, manifest));
                      await manifestChain;
                      progress?.episode(['success', 'completed'].includes(output.result.outcome));
                      if (!['success', 'completed'].includes(output.result.outcome))
                        progress?.event(
                          `${stamp()} episode ${id} seed=${c.run.seed} ${output.result.outcome} ${output.result.seconds.toFixed(2)}s`,
                        );
                    } catch (error) {
                      // Keep the chain alive so the failure is surfaced at the next
                      // loop iteration instead of silently skipping later exports.
                      commitError = error;
                      stopped = true;
                      await writer.interrupt(String(error));
                      await executor.stop();
                    }
                  });
                  void finishing.catch(() => {});
                  break;
                } catch (error) {
                  await writer.interrupt(String(error));
                  if (attempt === 1 && (await workerExecutor.retry(error))) {
                    progress?.event(`${stamp()} retry episode ${id}: ${String(error).slice(-90)}`);
                    continue;
                  }
                  throw error;
                }
              }
            } finally {
              progress?.worker(-1);
            }
          }
        } finally {
          await finishing;
          if (commitError) throw commitError;
        }
      };
      const tasks = Array.from({ length: Math.min(options.workers, plan.length) }, (_, i) =>
        loop(i).catch(async (e) => {
          stopped = true;
          await executor.stop();
          throw e;
        }),
      );
      const outcomes = await Promise.allSettled(tasks);
      const failure = outcomes.find((o) => o.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      manifest.status = stopped ? 'stopped' : 'complete';
      if (stopped) manifest.interruptions++;
    } catch (e) {
      manifest.status = 'error';
      await writeFile(path.join(root, 'error.txt'), String(e));
      throw e;
    } finally {
      memoryMetrics = await memory.stop();
      options.signal?.removeEventListener('abort', onAbort);
      await executor.close();
      await manifestChain;
      await atomicJson(manifestPath, manifest);
      progress?.stop();
    }
    const wallSeconds = (performance.now() - started) / 1000,
      simSeconds = results.reduce((n, m) => n + m.result.seconds, 0),
      observations = results.reduce((n, m) => n + m.result.observations, 0),
      frames = results.reduce(
        (n, m) =>
          n + (m.kind === 'dataset' ? m.counts.observations : (m.metrics.sensorFrames ?? 0)),
        0,
      ),
      successes = results.filter((m) => m.result.outcome === 'success').length,
      mean = (values: number[]) =>
        values.length ? values.reduce((n, v) => n + v, 0) / values.length : 0,
      perFrame = (key: string) =>
        mean(results.map((m) => (m.metrics[key] ?? 0) / m.result.observations));
    const { byTask, byCase } = summarizeRun(plan, manifest.completed);
    const summary = {
      byTask,
      byCase,
      status: manifest.status,
      totalCompleted: Object.keys(manifest.completed).length,
      completedThisRun: results.length,
      successesThisRun: successes,
      wallSeconds,
      simSeconds,
      simSecondsPerSecond: simSeconds / wallSeconds,
      observations,
      frames,
      framesPerSecond: frames / wallSeconds,
      successesPerHour: (successes / wallSeconds) * 3600,
      perFrame: {
        renderMs: perFrame('renderMs'),
        readbackMs: perFrame('readbackMs'),
        encodeMs: perFrame('encodeMs'),
        networkMs: perFrame('networkMs'),
      },
      perEpisode: {
        finishMs: mean(results.map((m) => m.metrics.finishMs ?? 0)),
        writeMs: mean(results.map((m) => m.metrics.writeMs ?? 0)),
      },
      ...memoryMetrics!,
      metrics: results.map((m) => ({
        ...m.metrics,
        physicsMs: m.result.physicsMs,
        controlMs: m.result.controlMs,
        observationMs: m.result.observationMs,
        recordMs: m.result.recordMs,
      })),
    };
    await atomicJson(path.join(root, 'summary.json'), summary);
    return summary;
  } finally {
    await unlock();
  }
}
