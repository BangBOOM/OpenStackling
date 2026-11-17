import { matchesFormat, DATASET_FORMAT } from './format';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validate,
  digest,
  actualConfig,
  validateAction,
  PROTOCOL,
  assertCompatible,
} from '../policy/contract';
import { type EpisodeMetadata } from './storage';
import { hash } from '../provenance';
import { readNpz } from './npz';
import { validateConfig } from '../config';
import { resolveTask } from '../../simulation/tasks/registry';
import { DIAGNOSTIC_FIELDS, diagnosticShapes } from './diagnostics';

// Minimal mp4 box walk: video track dimensions from avc1 and the sample count
// from stsz. Enough to bind video.mp4 to the episode without decoding frames.
function assertVideoMatches(
  bytes: Uint8Array,
  width: number,
  height: number,
  samples: number,
  expectedCodec: string,
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let videoWidth = 0,
    videoHeight = 0,
    sampleCount = 0,
    codec = '';
  const walk = (start: number, end: number, depth: number) => {
    let at = start;
    while (at + 8 <= end) {
      let size = view.getUint32(at);
      let header = 8;
      if (size === 1) {
        size = Number(view.getBigUint64(at + 8));
        header = 16;
      } else if (size === 0) size = end - at;
      if (size < header || at + size > end) throw new Error('Invalid mp4 box');
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type))
        walk(at + header, at + size, depth + 1);
      else if (type === 'stsd') {
        const entry = at + header + 8;
        codec = String.fromCharCode(...bytes.subarray(entry + 4, entry + 8));
        videoWidth = view.getUint16(entry + 32);
        videoHeight = view.getUint16(entry + 34);
      } else if (type === 'stsz') sampleCount = view.getUint32(at + header + 8);
      at += size;
    }
  };
  walk(0, bytes.length, 0);
  if (codec !== expectedCodec) throw new Error(`Invalid video codec: ${codec}`);
  if (videoWidth !== (width & ~1) || videoHeight !== (height & ~1))
    throw new Error('Invalid video dimensions');
  if (sampleCount !== samples) throw new Error('Video sample count mismatch');
}

export async function inspectEpisode(root: string) {
  const m: EpisodeMetadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));
  if (!matchesFormat(m, DATASET_FORMAT))
    throw new Error('Unsupported dataset schema; expected version 10');
  const physics = m.provenance.physics;
  if (
    !/^[a-f0-9]{64}$/.test(m.provenance.environmentFingerprint) ||
    !physics ||
    physics.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(physics.binarySha256) ||
    !/^[a-f0-9]{64}$/.test(physics.sourceHash) ||
    !physics.rustc ||
    !physics.rustflags ||
    !physics.platform ||
    !physics.arch
  )
    throw new Error('Missing or invalid physics provenance');
  validateConfig(m.config);
  if ((await digest(m.result.task)) !== (await digest(resolveTask(m.config))))
    throw new Error('Task prompt/rules metadata mismatch');
  if (
    (await digest(m.resolvedScene.map(({ position: _position, ...object }) => object))) !==
      (await digest(m.config.scene.objects)) ||
    m.resolvedScene.some((o) =>
      [o.position.x, o.position.y, o.position.z].some((v) => !Number.isFinite(v)),
    )
  )
    throw new Error('Resolved scene metadata mismatch');
  validate('appearance', m.appearance);
  if (
    m.config.appearance.theme !== m.appearance.id ||
    m.provenance.files[`src/runtime/browser/render/themes/${m.appearance.id}.ts`] !==
      m.appearance.contentHash
  )
    throw new Error('Appearance metadata mismatch');
  if (m.policy) {
    validate('profile', m.policy.profile);
    assertCompatible(m.policy.profile, m.config);
    if (
      m.policy.protocol !== PROTOCOL ||
      (await digest(m.policy.profile)) !== m.policy.profileHash ||
      (await digest(actualConfig(m.config, m.appearance))) !== m.policy.configHash ||
      (await digest(actualConfig(m.config, m.appearance).configuration)) !==
        (await digest(m.policy.profile.config))
    )
      throw new Error('Policy metadata mismatch');
  }
  for (const [name, digest] of Object.entries(m.files)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..'))
      throw new Error('Invalid episode path');
    if (hash(await readFile(path.join(root, name))) !== digest)
      throw new Error(`Checksum mismatch: ${name}`);
  }
  const npz = readNpz(await readFile(path.join(root, 'data.npz'))),
    c = m.config;
  const expect = (name: string, descr: string, shape: number[]) => {
    const member = npz[name];
    if (!member) throw new Error(`Missing npz member: ${name}`);
    if (
      member.descr !== descr ||
      member.shape.length !== shape.length ||
      member.shape.some((v, i) => v !== shape[i])
    )
      throw new Error(`Invalid npz member: ${name}`);
    return member.data;
  };
  const expectedCodec = m.format.video.codec.startsWith('vp9') ? 'vp09' : 'avc1';
  assertVideoMatches(
    await readFile(path.join(root, 'video.mp4')),
    c.camera.width,
    c.camera.heightPixels,
    m.counts.observations,
    expectedCodec,
  );
  const width = 16;
  const n = m.counts.observations,
    physicsHz = c.environment.physicsHz;
  const obsTick = expect('obs.tick', '<i8', [n]) as BigInt64Array,
    obsTime = expect('obs.time', '<f8', [n]) as Float64Array,
    obsState = expect('obs.state', '<f8', [n, width]) as Float64Array;
  for (let i = 0; i < n; i++) {
    const tick = Number(obsTick[i]);
    if (
      tick !== (i * physicsHz) / c.run.observationHz ||
      Math.abs(obsTime[i] - tick / physicsHz) > 1e-9 ||
      tick >= m.result.ticks ||
      obsState.subarray(i * width, i * width + width).some((v) => !Number.isFinite(v))
    )
      throw new Error('Invalid observation clock/state');
  }
  {
    const poses = expect('obs.camera_to_world', '<f8', [n, 4, 4]) as Float64Array;
    if (poses.some((v) => !Number.isFinite(v))) throw new Error('Invalid camera poses');
    for (let i = 0; i < n; i++)
      if (
        [12, 13, 14].some((j) => Math.abs(poses[i * 16 + j]) > 1e-8) ||
        Math.abs(poses[i * 16 + 15] - 1) > 1e-8
      )
        throw new Error('Camera matrices must be row-major homogeneous transforms');
  }
  if (c.camera.depth) {
    const depth = expect('obs.depth', '<u2', [
      n,
      c.camera.heightPixels,
      c.camera.width,
    ]) as Uint16Array;
    if (depth.length !== n * c.camera.width * c.camera.heightPixels)
      throw new Error('Invalid depth');
  }
  const a = m.counts.actions,
    controlHz = c.run.controlHz;
  const actTick = expect('act.tick', '<i8', [a]) as BigInt64Array,
    actTime = expect('act.time', '<f8', [a]) as Float64Array,
    actExecuted = expect('act.executed', '<f8', [a, width]) as Float64Array,
    actController = expect('act.controller', '|u1', [a]) as Uint8Array,
    actLabelValid = expect('act.label_valid', '|u1', [a]) as Uint8Array,
    actContinuous = expect('act.continuous', '|u1', [a]) as Uint8Array;
  const hasTeacher = 'act.teacher_action' in npz;
  for (let i = 0; i < a; i++) {
    if (m.policy) {
      if (
        actController[i] !==
          m.format.controllers.indexOf(
            Number(actTick[i]) >= m.result.controlTicks && m.result.validationTicks > 0
              ? 'evaluation-hold'
              : 'external-policy',
          ) ||
        hasTeacher
      )
        throw new Error('Invalid policy action provenance');
      validateAction(
        Array.from(
          actExecuted.subarray(i * width, i * width + width),
        ) as import('../../simulation/world/types').Action16D,
        m.policy.profile.config,
      );
    }
    const tick = Number(actTick[i]);
    if (
      tick !== (i * physicsHz) / controlHz ||
      Math.abs(actTime[i] - tick / physicsHz) > 1e-9 ||
      actExecuted.subarray(i * width, i * width + width).some((v) => !Number.isFinite(v)) ||
      actLabelValid[i] > 1 ||
      actContinuous[i] > 1
    )
      throw new Error('Invalid action clock/state');
  }
  if (hasTeacher) {
    const labels = expect('act.teacher_action', '<f8', [a, width]) as Float64Array;
    for (let i = 0; i < a; i++) {
      const teacher = actController[i] === m.format.controllers.indexOf('teacher');
      if (Boolean(actLabelValid[i]) !== teacher) throw new Error('Invalid teacher label mask');
      for (let j = 0; j < width; j++)
        if (labels[i * width + j] !== actExecuted[i * width + j])
          throw new Error('Invalid teacher target alignment');
    }
  }
  if (m.policy && hasTeacher) throw new Error('Invalid policy action provenance');
  const d = m.counts.diagnostics,
    blocks = c.scene.objects.length;
  const diagTick = expect('diag.tick', '<i8', [d]) as BigInt64Array,
    diagTime = expect('diag.time', '<f8', [d]) as Float64Array;
  expect('diag.target', '<f8', [d, width]);
  if ((await digest(m.format.diagnostics)) !== (await digest(DIAGNOSTIC_FIELDS)))
    throw new Error('Invalid diagnostic field definitions');
  for (const [key, shape] of Object.entries(diagnosticShapes(d, blocks))) {
    const values = expect(`diag.${key}`, '<f8', shape) as Float64Array;
    if (values.some((value) => !Number.isFinite(value)))
      throw new Error(`Invalid diagnostic ${key}`);
  }
  expect('diag.state', '<f8', [d, width]);
  expect('diag.phase', '|u1', [d]);
  for (let i = 0; i < d; i++) {
    const tick = Number(diagTick[i]);
    if (Math.abs(diagTime[i] - tick / physicsHz) > 1e-9 || tick >= m.result.ticks)
      throw new Error('Invalid diagnostic clock');
  }
  return {
    episode: path.basename(root),
    outcome: m.result.outcome,
    observations: n,
    actions: a,
    seconds: m.result.seconds,
  };
}
