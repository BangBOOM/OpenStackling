import { matchesFormat, DATASET_FORMAT } from '../../runtime/recording/format';
import { collectProgress } from './progress';
import { teacherSource } from '../../runtime/host/teacher-source';
import { generatedObjects } from '../../simulation/scene';
import { evaluate } from '../../runtime/runs/evaluate';
import { report } from '../../runtime/runs/report';
import { buildEpisodePlan } from '../../runtime/plan';
import {
  TASK_PRESETS,
  presetPatch,
  collectionGeneration,
  type TaskPreset,
} from '../../runtime/presets';
import { cubeObjects, dimensions } from '../../simulation/world/objects';
import { parseArgs } from 'node:util';
import { appearanceIdentity, sameAppearance } from '../../runtime/appearance';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { resolveConfig, type Config, type DeepPartial } from '../../runtime/config';
import { Episode } from '../../runtime/episode';
import { environmentFingerprint } from '../../runtime/provenance';
import {
  makeProfile,
  assertCompatible,
  configForProfile,
  digest,
  PolicyError,
  type Manifest,
} from '../../runtime/policy/contract';
import { collect } from '../../runtime/runs/collect';
import { inspect } from '../../runtime/runs/inspect';
import { replay, episodeRows } from '../../runtime/recording/replay';
import { atomicJson, EpisodeWriter, type EpisodeMetadata } from '../../runtime/recording/storage';
import { provenance } from '../../runtime/provenance';
import { BrowserHost } from '../../runtime/runs/browser-host';
if (process.argv[2] === 'tune-teacher') {
  try {
    const { tuneTeacherCommand } = await import('./tune-teacher');
    await tuneTeacherCommand(process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}
const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    theme: { type: 'string' },
    'task-preset': { type: 'string' },
    'task-suite': { type: 'string' },
    config: { type: 'string' },
    url: { type: 'string' },
    policy: { type: 'string' },
    'profile-id': { type: 'string' },
    'timeout-ms': { type: 'string' },
    'initialization-timeout-ms': { type: 'string' },
    'strict-environment': { type: 'boolean' },
    seed: { type: 'string' },
    seeds: { type: 'string' },
    episodes: { type: 'string' },
    blocks: { type: 'string' },
    size: { type: 'string' },
    out: { type: 'string' },
    workers: { type: 'string' },
    resume: { type: 'boolean' },
    refresh: { type: 'boolean' },
    visual: { type: 'boolean' },
    depth: { type: 'boolean' },
    'no-depth': { type: 'boolean' },
    'observation-hz': { type: 'string' },
    'control-hz': { type: 'string' },
    'physics-hz': { type: 'string' },
    seconds: { type: 'string' },
    camera: { type: 'string' },
    positions: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    'camera-height': { type: 'string' },
    'camera-distance': { type: 'string' },
    fov: { type: 'string' },
    target: { type: 'string' },
    port: { type: 'string' },
    suite: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const command = positionals[0] ?? 'help';
// Per-episode metrics stay in summary.json; terminal output keeps aggregates only.
const printSummary = (summary: Awaited<ReturnType<typeof collect>>) => {
  const { metrics: _metrics, ...aggregate } = summary;
  console.log(JSON.stringify(aggregate));
};
async function main() {
  if (v.help || command === 'help') {
    console.log(
      `Stackling\n  bun run cli -- world [--config FILE]\n  bun run cli -- policy-profile --config FILE --out PROFILE.json\n  bun run cli -- policy-demo [--seed 42] [--out data/replay-demo] [--refresh] [--port 8000]\n  bun run cli -- policy --url ws://HOST:PORT/policy [--seed 42] [--out DATASET]\n  bun run cli -- collect --policy ws://HOST:PORT/policy --out DATASET --seeds 42,2026\n  bun run cli -- teacher [--seeds 0,1,2] [--blocks 5] [--visual]\n  bun run cli -- evaluate [--policy ws://HOST:PORT/policy] --task-preset max-height --blocks 8 --out data/eval\n  bun run cli -- tune-teacher --plan FILE --out DIRECTORY [--workers 2]\n  bun run cli -- report RUN_DIRECTORY\n  bun run cli -- collect --out data/run --episodes 100 [--workers 2] [--resume]\n  bun run cli -- replay DATASET/episodes/000000 [--visual]\n  bun run cli -- inspect DATASET\n  bun run cli -- check [--suite core|teacher|browser|data|all]\n  bun run cli -- benchmark --out data/benchmark\n\nTheme: --theme island|studio\nTask: --task-preset stack-all|partition-count|partition-color|stack-sized|stack-ordered|max-height\nSuite: --task-suite FILE (cases × seeds)\nHeight collection: --task-preset max-height --blocks N randomizes objects per episode seed.\nCommon: --seed --blocks --size --physics-hz --control-hz --observation-hz --seconds\nCamera: --camera N|NE|E|SE|S|SW|W|NW --positions N,SE --width --height\n        --camera-height --camera-distance --fov --target x,y,z --depth --no-depth\nConfig file < explicit CLI options. Rates must divide physicsHz.\nBrowser: STACKLING_CHROME overrides Chrome path; otherwise installed Chrome or Playwright Chromium.`,
    );
    return;
  }
  if (v['task-preset'] && !TASK_PRESETS.includes(v['task-preset'] as TaskPreset))
    throw new Error('Unknown task preset');
  const suiteFile = v['task-suite']
    ? JSON.parse(await readFile(v['task-suite'], 'utf8'))
    : undefined;
  if (suiteFile && (!Array.isArray(suiteFile.cases) || !suiteFile.cases.length))
    throw new Error('Task suite requires nonempty cases');
  const patch: DeepPartial<Config> = v.config ? JSON.parse(await readFile(v.config, 'utf8')) : {};
  const preset = v['task-preset']
    ? presetPatch(v['task-preset'] as TaskPreset, Number(v.seed ?? patch.run?.seed ?? 42))
    : {};
  const cli: DeepPartial<Config> = { environment: {}, task: {}, camera: {}, run: {} };
  if (v.theme !== undefined) cli.appearance = { theme: v.theme as Config['appearance']['theme'] };
  if (command === 'replay' && (v.theme !== undefined || patch.appearance !== undefined))
    throw new Error('Replay uses the recorded theme; appearance overrides are not supported');
  const number = (key: keyof typeof v) => Number(v[key]);
  if (v.seed !== undefined) cli.run!.seed = number('seed');
  if (v.blocks !== undefined || v.size !== undefined) {
    const defaults = resolveConfig();
    const objects = patch.scene?.objects ?? preset.scene?.objects ?? defaults.scene.objects;
    const maxStackHeight =
      patch.scene?.maxStackHeight ?? preset.scene?.maxStackHeight ?? defaults.scene.maxStackHeight;
    const count = v.blocks !== undefined ? number('blocks') : objects.length;
    if (!Number.isInteger(count) || count < 1) throw new Error('Invalid object count');
    const seed = v.seed !== undefined ? number('seed') : (patch.run?.seed ?? defaults.run.seed);
    const selectedTask = patch.task?.kind ?? preset.task?.kind;
    const varied =
      v.size === undefined &&
      (v['task-preset'] === 'stack-sized' || v['task-preset'] === 'stack-ordered');
    cli.scene = {
      objects:
        selectedTask === 'max-height' && v.size === undefined
          ? generatedObjects({ kind: 'random-mixed', version: 2, count }, seed, maxStackHeight)
          : varied
            ? generatedObjects({ kind: 'random-sized', version: 2, count }, seed, maxStackHeight)
            : cubeObjects(
                count,
                v.size !== undefined
                  ? number('size')
                  : dimensions((objects[0] ?? defaults.scene.objects[0]).shape)[0],
              ),
    };
  }
  if (v['physics-hz']) cli.environment!.physicsHz = number('physics-hz');
  if (v['control-hz']) cli.run!.controlHz = number('control-hz');
  if (v['observation-hz']) cli.run!.observationHz = number('observation-hz');
  if (v.seconds) cli.run!.maxSeconds = number('seconds');
  if (v.camera) cli.camera!.position = v.camera;
  if (v.width) cli.camera!.width = number('width');
  if (v.height) cli.camera!.heightPixels = number('height');
  if (v.fov) cli.camera!.fov = number('fov');
  if (v['camera-height']) cli.camera!.height = number('camera-height');
  if (v['camera-distance']) cli.camera!.distance = number('camera-distance');
  if (v.target) cli.camera!.target = v.target.split(',').map(Number);
  if (v.depth) cli.camera!.depth = true;
  if (v['no-depth']) cli.camera!.depth = false;
  const external =
    command === 'policy' || (['collect', 'evaluate'].includes(command) && Boolean(v.policy));
  const config = external ? resolveConfig() : resolveConfig(preset, patch, cli);
  const sceneGeneration = (c: Config) =>
    collectionGeneration(c, {
      fixedSize: v.size !== undefined,
      fixedObjects: patch.scene?.objects !== undefined,
      suite: Boolean(suiteFile),
      count: v.blocks !== undefined,
    });
  const suiteCases: Config[] | undefined = external
    ? undefined
    : suiteFile?.cases.map((entry: DeepPartial<Config>) => resolveConfig(config, entry, cli));
  const seeds = v.seeds
    ? v.seeds.split(',').map(Number)
    : Array.from(
        { length: v.episodes ? number('episodes') : 1 },
        (_, i) => (config.run.seed + i) >>> 0,
      );
  const abort = new AbortController(),
    onSignal = () => abort.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    if (command === 'policy-profile') {
      if (!v.out) throw new Error('policy-profile requires --out');
      await atomicJson(
        v.out,
        makeProfile(
          config,
          await environmentFingerprint(),
          v['profile-id'],
          suiteCases ?? [config],
        ),
      );
      console.log(JSON.stringify({ profile: v.out }));
      return;
    }
    if (command === 'policy-demo') {
      const out = v.out ?? 'data/replay-demo';
      if (!existsSync(path.join('policy', '.venv')))
        throw new Error(
          'policy-demo requires the Python environment; run: uv sync --project policy --locked',
        );
      const episodeDir = path.join(out, 'episodes', '000000');
      if (v.refresh || !existsSync(path.join(episodeDir, 'metadata.json'))) {
        if (v.refresh) await rm(out, { recursive: true, force: true });
        await mkdir(path.dirname(out), { recursive: true });
        printSummary(
          await collect(config, {
            out,
            seeds: [config.run.seed],
            workers: 1,
            signal: abort.signal,
            progress: collectProgress,
          }),
        );
      }
      const meta: EpisodeMetadata = JSON.parse(
        await readFile(path.join(episodeDir, 'metadata.json'), 'utf8'),
      );
      if (
        !matchesFormat(meta, DATASET_FORMAT) ||
        meta.provenance.sourceHash !== (await provenance()).sourceHash ||
        (await digest(meta.config)) !== (await digest(config))
      )
        throw new Error(
          'Demo recording belongs to another build or configuration; use --refresh or a new --out',
        );
      if (meta.result.outcome !== 'success')
        throw new Error(
          `Demo recording did not succeed: ${meta.result.outcome} (${meta.result.reason}); delete ${out} or pass --out to record again`,
        );
      const profilePath = path.join(out, 'profile.json');
      await atomicJson(
        profilePath,
        makeProfile(config, await environmentFingerprint(), 'replay-demo'),
      );
      const revision = `replay-${meta.files['data.npz'].slice(0, 12)}`;
      console.error(
        `Replay demo policy: ws://127.0.0.1:${v.port ?? 8000}/policy (revision ${revision})`,
      );
      console.error('UI: External Policy connect, Scene Seed 42, Apply & Reset, then Run');
      const child = spawn(
        'uv',
        [
          'run',
          '--project',
          'policy',
          'stackling-policy',
          'serve',
          '--profile',
          profilePath,
          '--factory',
          'stackling_policy.examples.replay:create',
          '--policy-id',
          'replay-demo',
          '--model-revision',
          revision,
          ...(v.port ? ['--port', v.port] : []),
        ],
        { env: { ...process.env, STACKLING_REPLAY_EPISODE: episodeDir }, stdio: 'inherit' },
      );
      abort.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
      const code = await new Promise<number>((resolve) =>
        child.once('exit', (c, s) => resolve(c ?? (s ? 1 : 0))),
      );
      if (code !== 0 && !abort.signal.aborted)
        throw new Error(`policy demo server exited with code ${code}`);
      return;
    }
    if (command === 'policy' || (['collect', 'evaluate'].includes(command) && v.policy)) {
      const url = command === 'policy' ? v.url : v.policy;
      if (!url) throw new Error('policy requires --url');
      if (Number(v.workers ?? 1) !== 1 || v.positions)
        throw new Error('External policy requires one worker and a fixed camera');
      const host = new BrowserHost();
      try {
        await host.start(v.visual, Number(v.port ?? 0));
        const page = await host.newPage();
        const manifest = (await page.evaluate(
          async (options) => (window as any).stackling.connectPolicy(options),
          {
            url,
            token: process.env.STACKLING_POLICY_TOKEN,
            timeoutMs: v['timeout-ms'] ? Number(v['timeout-ms']) : undefined,
            initializationTimeoutMs: v['initialization-timeout-ms']
              ? Number(v['initialization-timeout-ms'])
              : undefined,
          },
        )) as Manifest;
        if (manifest.profile.environmentFingerprint !== (await environmentFingerprint())) {
          if (v['strict-environment']) throw new PolicyError('ENVIRONMENT_MISMATCH');
          console.error(
            'Warning: the policy profile comes from another environment build; results are not comparable with that build',
          );
        }
        const baseline = configForProfile(manifest.profile, config);
        const resolved = resolveConfig(baseline, preset, patch, cli);
        try {
          assertCompatible(manifest.profile, resolved);
        } catch (error) {
          throw new Error(`Explicit configuration conflicts with policy profile: ${String(error)}`);
        }
        await page.evaluate(async (c) => (window as any).stackling.bindPolicy(c), resolved);
        const policySeeds = v.seeds
          ? v.seeds.split(',').map(Number)
          : Array.from(
              { length: v.episodes ? Number(v.episodes) : 1 },
              (_, i) => (resolved.run.seed + i) >>> 0,
            );
        const out = v.out ?? `data/policy-${Date.now()}`;
        await mkdir(path.dirname(out), { recursive: true });
        printSummary(
          await (command === 'evaluate' ? evaluate : collect)(resolved, {
            out,
            seeds: policySeeds,
            sceneGeneration: sceneGeneration(resolved),
            cases: suiteFile?.cases.map((entry: DeepPartial<Config>) =>
              resolveConfig(resolved, entry, cli),
            ),
            workers: 1,
            resume: v.resume,
            signal: abort.signal,
            progress: collectProgress,
            policy: { manifest, host, page },
          }),
        );
      } finally {
        await host.close();
      }
      return;
    }
    if (command === 'world') {
      const server = await createServer({
        server: { host: '127.0.0.1', port: Number(v.port ?? 5173) },
        logLevel: 'warn',
        define: { __STACKLING_CONFIG__: JSON.stringify(config) },
      });
      await server.listen();
      console.log(JSON.stringify({ urls: server.resolvedUrls?.local }));
      if (!abort.signal.aborted)
        await new Promise<void>((r) =>
          abort.signal.addEventListener('abort', () => r(), { once: true }),
        );
      await server.close();
      return;
    }
    if (command === 'teacher' && !v.visual) {
      const results = [];
      for (const entry of buildEpisodePlan(config, {
        seeds,
        cases: suiteCases,
        positions: v.positions?.split(','),
        sceneGeneration: sceneGeneration(config),
      })) {
        const seed = entry.config.run.seed;
        if (abort.signal.aborted) break;
        const episode = new Episode(entry.config, teacherSource, undefined, entry);
        const stop = () => episode.finish('stopped', 'user interrupted');
        abort.signal.addEventListener('abort', stop);
        try {
          results.push({ seed, ...(await episode.run()) });
        } finally {
          abort.signal.removeEventListener('abort', stop);
          episode.dispose();
        }
      }
      if (v.out) await atomicJson(v.out, results);
      console.log(JSON.stringify(results));
      return;
    }
    if (command === 'collect' || command === 'teacher' || command === 'evaluate') {
      const out = v.out ?? `data/${command}-${Date.now()}`;
      await mkdir(path.dirname(out), { recursive: true });
      printSummary(
        await (command === 'evaluate' ? evaluate : collect)(config, {
          out,
          seeds,
          sceneGeneration: sceneGeneration(config),
          cases: suiteCases,
          workers: Number(v.workers ?? 1),
          resume: v.resume,
          visible: v.visual,
          positions: v.positions?.split(','),
          signal: abort.signal,
          progress: collectProgress,
        }),
      );
      return;
    }
    if (command === 'report') {
      if (!positionals[1]) throw new Error('report requires a run directory');
      console.log(JSON.stringify(await report(positionals[1])));
      return;
    }
    if (command === 'inspect') {
      if (!positionals[1]) throw new Error('inspect requires a dataset/episode directory');
      console.log(JSON.stringify(await inspect(positionals[1]), null, 2));
      return;
    }
    if (command === 'replay') {
      const root = positionals[1];
      if (!root) throw new Error('replay requires an episode directory');
      console.log(JSON.stringify(await replay(root)));
      if (v.visual) {
        const meta: EpisodeMetadata = JSON.parse(
          await readFile(path.join(root, 'metadata.json'), 'utf8'),
        );
        if (!sameAppearance(meta.appearance, appearanceIdentity(meta.config.appearance.theme)))
          throw new Error('Recorded theme content is unavailable in this build');
        const out = v.out ?? `data/replay-${Date.now()}`;
        await mkdir(out, { recursive: true });
        const writer = new EpisodeWriter(
          out,
          '000000',
          meta.config,
          await provenance(),
          undefined,
          meta.resolvedScene,
        );
        await writer.begin();
        const host = new BrowserHost();
        try {
          await host.start(true);
          const page = await host.newPage();
          const result = await host.run(
            page,
            meta.config,
            writer,
            (await episodeRows(root, meta)).actions,
            {
              config: meta.config,
              resolvedScene: meta.resolvedScene,
              task: meta.result.task,
              appearance: meta.appearance,
            },
          );
          await writer.finish(result.result, result.metrics);
        } finally {
          await host.close();
        }
      }
      return;
    }
    if (command === 'check') {
      const suites: Record<string, string[]> = {
        core: ['test', '--timeout', '120000', './tests/simulation/core.test.ts'],
        teacher: ['./tests/simulation/teacher.ts'],
        browser: ['./tests/web/browser.ts'],
        data: ['./tests/cli/data.ts'],
      };
      const names = v.suite === 'all' ? Object.keys(suites) : [v.suite ?? 'core'];
      for (const name of names) {
        if (!suites[name]) throw new Error('Unknown suite');
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [...suites[name]], {
            stdio: ['inherit', process.stderr, process.stderr],
          });
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`${name} failed (${code})`)),
          );
        });
      }
      console.log(JSON.stringify({ passed: names }));
      return;
    }
    if (command === 'benchmark') {
      const out = v.out ?? `data/benchmark-${Date.now()}`;
      await mkdir(path.dirname(out), { recursive: true });
      await mkdir(out, { recursive: false });
      const benchmarkSeeds = v.seeds ? seeds : [42, 2026];

      const physics = [];
      for (const seed of benchmarkSeeds) {
        const cc = structuredClone(config);
        cc.run.seed = seed;
        const episode = new Episode(cc, teacherSource);
        try {
          physics.push(await episode.run());
        } finally {
          episode.dispose();
        }
      }
      const cases = [
        { name: 'rgb-320-single', width: 320, heightPixels: 240, depth: false, workers: 1 },
        { name: 'rgb-640-single', width: 640, heightPixels: 480, depth: false, workers: 1 },
        { name: 'rgbd-320-single', width: 320, heightPixels: 240, depth: true, workers: 1 },
        { name: 'rgb-320-dual', width: 320, heightPixels: 240, depth: false, workers: 2 },
      ];
      const reports = [];
      for (const item of cases) {
        if (abort.signal.aborted) break;
        const cfg = structuredClone(config);
        Object.assign(cfg.camera, {
          width: item.width,
          heightPixels: item.heightPixels,
          depth: item.depth,
        });
        reports.push({
          name: item.name,
          ...(await collect(cfg, {
            out: path.join(out, item.name),
            seeds: benchmarkSeeds,
            workers: item.workers,
            signal: abort.signal,
            progress: collectProgress,
          })),
        });
      }
      const report = {
        config,
        source: await provenance(),
        hardware: {
          platform: process.platform,
          arch: process.arch,
          cpu: os.cpus()[0]?.model,
          logicalCpus: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
        },
        physics,
        cases: reports,
      };
      await atomicJson(path.join(out, 'benchmark.json'), report);
      console.log(JSON.stringify(report));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
