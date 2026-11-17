import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveConfig, validateConfig } from '../../runtime/config';
import { atomicJson } from '../../runtime/recording/storage';
import { provenance, hash, type Provenance } from '../../runtime/provenance';
import { random } from '../../simulation/world/random';
import {
  DEFAULT_TEACHER_POLICY,
  type TeacherPolicy,
} from '../../simulation/control/teacher-policy';
import {
  MOTION_METRICS_VERSION,
  evaluateTeacherCase,
  summarizeTeacherTrials,
  compareTeacherQuality,
  noTaskRegression,
  type TeacherCase,
  type TeacherTrial,
  type CaseQuality,
} from '../../runtime/runs/teacher-evaluation';

export type TeacherSplits = { train: number[]; validation: number[]; test: number[] };
export type TuneTeacherOptions = {
  cases: TeacherCase[];
  splits: TeacherSplits;
  baseline: TeacherPolicy;
  candidateCount: number;
  searchSeed: number;
  workers: number;
  out: string;
};
type Candidate = { id: string; policy: TeacherPolicy };
type Job = {
  candidate: Candidate;
  split: keyof TeacherSplits;
  seeds: number[];
  cases: TeacherCase[];
  source: Provenance;
  out: string;
};
type JobResult = {
  candidate: Candidate;
  split: keyof TeacherSplits;
  quality: CaseQuality[];
  episodes: { file: string; hash: string }[];
};
const seedValid = (seed: number) => Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff;

export function validateTeacherSplits(splits: TeacherSplits) {
  const used = new Set<number>();
  for (const name of ['train', 'validation', 'test'] as const) {
    const seeds = splits[name];
    if (!Array.isArray(seeds) || !seeds.length)
      throw new Error(`Teacher ${name} split must contain seeds`);
    for (const seed of seeds) {
      if (!seedValid(seed)) throw new Error('Teacher seeds must be uint32 values');
      if (used.has(seed))
        throw new Error('Teacher splits must be disjoint and contain no duplicate seeds');
      used.add(seed);
    }
  }
}

export function teacherCandidates(
  baseline: TeacherPolicy,
  count: number,
  searchSeed: number,
): Candidate[] {
  const rng = random(searchSeed);
  const keys = Object.keys(DEFAULT_TEACHER_POLICY) as (keyof TeacherPolicy)[];
  return Array.from({ length: count }, (_, index) => {
    const policy = { ...baseline };
    if (index > 0) {
      const key = keys[Math.floor((index - 1) / 2) % keys.length];
      const factor = index % 2 ? 1.25 + rng() * 0.4 : 0.55 + rng() * 0.2;
      policy[key] = Math.min(10, Math.max(0, (policy[key] || 0.05) * factor));
    }
    return { id: `candidate-${String(index).padStart(3, '0')}`, policy };
  });
}

export function selectTeacherCandidate(results: JobResult[], baselineId = 'candidate-000') {
  const baseline = results.find((result) => result.candidate.id === baselineId)!;
  return results
    .filter((result) => noTaskRegression(result.quality, baseline.quality))
    .sort(
      (a, b) =>
        compareTeacherQuality(a.quality, b.quality) || a.candidate.id.localeCompare(b.candidate.id),
    )[0];
}

async function worker(job: Job) {
  const source = await provenance();
  if (source.sourceHash !== job.source.sourceHash)
    throw new Error('Source changed after the tuning plan was created');
  const trials: TeacherTrial[] = [];
  const episodes: JobResult['episodes'] = [];
  for (const entry of job.cases)
    for (const seed of job.seeds) {
      const result = await evaluateTeacherCase(entry, seed, job.candidate.policy);
      const file = `episode-${String(trials.length).padStart(6, '0')}.json`;
      const record =
        JSON.stringify({ metricsVersion: MOTION_METRICS_VERSION, source, ...result }, null, 2) +
        '\n';
      await writeFile(path.join(job.out, file), record);
      episodes.push({ file, hash: hash(record) });
      trials.push(result);
    }
  const result: JobResult = {
    candidate: job.candidate,
    split: job.split,
    quality: summarizeTeacherTrials(trials),
    episodes,
  };
  await atomicJson(path.join(job.out, 'result.json'), result);
}

async function executeJobs(jobs: Job[], workers: number): Promise<JobResult[]> {
  const output: JobResult[] = Array(jobs.length);
  let next = 0;
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(workers, jobs.length) }, async () => {
      while (next < jobs.length) {
        const index = next++,
          job = jobs[index];
        await mkdir(job.out, { recursive: true });
        const file = path.join(job.out, 'job.json');
        await atomicJson(file, job);
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [fileURLToPath(import.meta.url), '--worker', file],
            {
              cwd: process.cwd(),
              stdio: ['ignore', 'ignore', 'pipe'],
            },
          );
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
          });
          child.once('error', reject);
          child.once('close', (code) => {
            if (code === 0) resolve();
            else
              reject(
                new Error(
                  `${job.candidate.id}/${job.split} worker failed (${code}): ${stderr.trim()}`,
                ),
              );
          });
        });
        output[index] = JSON.parse(await readFile(path.join(job.out, 'result.json'), 'utf8'));
        process.stderr.write(
          `${job.candidate.id} ${job.split}: ${output[index].episodes.length} episodes retained\n`,
        );
      }
    }),
  );
  const failures = settled.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      'Teacher tuning workers failed',
    );
  return output;
}

export async function tuneTeacher(options: TuneTeacherOptions) {
  validateTeacherSplits(options.splits);
  if (
    !Number.isInteger(options.candidateCount) ||
    options.candidateCount < 1 ||
    options.candidateCount > 17
  )
    throw new Error('Teacher candidateCount must be between 1 and 17');
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 4)
    throw new Error('Teacher workers must be between 1 and 4');
  if (!seedValid(options.searchSeed)) throw new Error('Teacher searchSeed must be uint32');
  for (const key of Object.keys(DEFAULT_TEACHER_POLICY) as (keyof TeacherPolicy)[])
    if (
      !Number.isFinite(options.baseline[key]) ||
      options.baseline[key] < 0 ||
      options.baseline[key] > 10
    )
      throw new Error(`Explicit baseline requires a finite policy parameter in [0, 10]: ${key}`);
  if (
    !options.cases.length ||
    new Set(options.cases.map((entry) => entry.name)).size !== options.cases.length
  )
    throw new Error('Teacher cases require unique nonempty names');
  for (const entry of options.cases) {
    validateConfig(entry.config);
    if (!entry.name || !entry.config.environment.robot.body)
      throw new Error('Teacher tuning requires named whole-body cases');
    if (entry.config.environment.physicsHz % 10 !== 0)
      throw new Error('Teacher motion metrics require a physics frequency divisible by 10');
    resolveConfig(entry.config, { teacher: { policy: options.baseline } });
  }
  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out);
  const source = await provenance();
  const candidates = teacherCandidates(
    options.baseline,
    options.candidateCount,
    options.searchSeed,
  );
  const manifest = {
    schemaVersion: 1,
    metricsVersion: MOTION_METRICS_VERSION,
    source,
    options: { ...options, out },
    candidates,
    status: 'running',
  };
  await atomicJson(path.join(out, 'plan.json'), manifest);
  const jobs = (selected: Candidate[], split: keyof TeacherSplits): Job[] =>
    selected.map((candidate) => ({
      candidate,
      split,
      seeds: options.splits[split],
      cases: options.cases,
      source,
      out: path.join(out, candidate.id, split),
    }));
  try {
    const train = await executeJobs(jobs(candidates, 'train'), options.workers);
    const baseline = train[0];
    const shortlist = train
      .filter(
        (result) =>
          result.candidate.id !== baseline.candidate.id &&
          noTaskRegression(result.quality, baseline.quality),
      )
      .sort(
        (a, b) =>
          compareTeacherQuality(a.quality, b.quality) ||
          a.candidate.id.localeCompare(b.candidate.id),
      )
      .slice(0, 2)
      .map((result) => result.candidate);
    const validation = await executeJobs(
      jobs([baseline.candidate, ...shortlist], 'validation'),
      options.workers,
    );
    const winner = selectTeacherCandidate(validation);
    // The sealed split is opened once, after candidate selection, and never feeds back into it.
    const [test] = await executeJobs(jobs([winner.candidate], 'test'), 1);
    const result = {
      schemaVersion: 1,
      source,
      selected: winner.candidate,
      train,
      validation,
      test,
    };
    await atomicJson(path.join(out, 'selected-policy.json'), {
      teacher: { policy: winner.candidate.policy },
    });
    await atomicJson(path.join(out, 'summary.json'), result);
    manifest.status = 'complete';
    await atomicJson(path.join(out, 'plan.json'), manifest);
    return result;
  } catch (error) {
    manifest.status = 'failed';
    await atomicJson(path.join(out, 'plan.json'), manifest);
    await atomicJson(path.join(out, 'error.json'), { message: String(error) });
    throw error;
  }
}

export async function tuneTeacherCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      plan: { type: 'string' },
      out: { type: 'string' },
      workers: { type: 'string' },
    },
  });
  if (!values.plan)
    throw new Error('Usage: tune-teacher --plan FILE --out DIRECTORY [--workers 1..4]');
  const input = JSON.parse(await readFile(values.plan, 'utf8')) as TuneTeacherOptions;
  const options = {
    ...input,
    out: values.out ?? input.out,
    workers: values.workers === undefined ? input.workers : Number(values.workers),
    cases: input.cases.map((entry) => ({ ...entry, config: resolveConfig(entry.config) })),
  };
  if (!options.out) throw new Error('Teacher tuning requires an output directory');
  const result = await tuneTeacher(options);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--worker')
      await worker(JSON.parse(await readFile(process.argv[3], 'utf8')));
    else await tuneTeacherCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
