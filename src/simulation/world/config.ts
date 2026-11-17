import { dimensions, OBJECT_COLORS, type ObjectSpec, type ResolvedScene } from './objects.js';
import type { Vec3 } from './types.js';
import robot from '../../../configs/robot.json' with { type: 'json' };
import { positive, integer, finiteTree } from '../validation.js';
export type BodyConfig = typeof robot.body;
export type RobotConfig = typeof robot & { body: BodyConfig };
export type EnvironmentConfig = {
  version: string;
  physicsHz: number;
  solver: { iterations: number; internalPgsIterations: number };
  tableSize: number;
  tableDepth: number;
  tableSupport: 'legs' | 'sled';
  tableTop: number;
  tableThickness: number;
  friction: number;
  robot: RobotConfig;
};
export type WorldConfig = { environment: EnvironmentConfig; scene: ResolvedScene };
export function validateEnvironment(environment: EnvironmentConfig) {
  const c = { environment };
  finiteTree(environment);
  if (environment.version !== 'stackling-v5.4') throw new Error('Unsupported environment version');
  integer(environment.physicsHz, 'physicsHz');
  integer(environment.solver.iterations, 'solver iterations');
  integer(environment.solver.internalPgsIterations, 'solver PGS iterations');
  for (const key of ['tableSize', 'tableTop', 'tableThickness'] as const)
    positive(c.environment[key], key);
  if (!Number.isFinite(c.environment.friction) || c.environment.friction < 0)
    throw new Error('Negative friction');
  if (!['legs', 'sled'].includes(environment.tableSupport))
    throw new Error('Unsupported table support');
  positive(environment.tableDepth, 'tableDepth');
  const r = c.environment.robot;
  if (!r.body || typeof r.body !== 'object') throw new Error('An articulated body is required');
  for (const key of ['yawLimit', 'pitchLimit', 'speed', 'acceleration', 'jerk'] as const)
    positive(r.body[key], `body ${key}`);
  if (r.body.yawLimit > 0.8 || r.body.pitchLimit > 0.55) throw new Error('Invalid waist limits');
  if (r.mount.type !== 'human-scale-upper-body-v1') throw new Error('Unsupported robot mount');
  const { column, topPlate, neck, beam } = r.mount;
  if (beam.from.length !== 3 || beam.to.length !== 3)
    throw new Error('Mount beam requires two three-dimensional endpoints');
  for (const [name, value] of Object.entries({
    columnWidth: column.width,
    columnDepth: column.depth,
    columnHeight: column.top - column.bottom,
    plateWidth: topPlate.width,
    plateDepth: topPlate.depth,
    plateThickness: topPlate.thickness,
    neckRadius: neck.radius,
    neckHeight: neck.top - neck.bottom,
    beamWidth: beam.width,
    beamHeight: beam.height,
    beamLength: Math.hypot(...beam.to.map((v, i) => v - beam.from[i])),
  }))
    positive(value, name);
  if (
    r.links.length !== 6 ||
    r.axes.length !== 6 ||
    r.limits.length !== 6 ||
    r.homeJoints.length !== 6 ||
    r.base.length !== 3 ||
    r.gap.length !== 2 ||
    r.gap[0] < 0 ||
    r.gap[1] <= r.gap[0]
  )
    throw new Error('Invalid robot dimensions');
  for (const key of [
    'toolLength',
    'fingerLength',
    'fingerWidth',
    'fingerDepth',
    'jointSpeed',
    'jointAcceleration',
    'jointJerk',
    'keyboardSpeed',
  ] as const)
    positive(r[key], key);
  for (const speed of Object.values(r.speed)) positive(speed, 'motion speed');
  if (
    r.links[0] !== 0 ||
    r.links[1] <= 0.08 ||
    r.links[2] <= 0.08 ||
    r.links.slice(3).some((v) => v <= 0)
  )
    throw new Error('Unsupported link geometry');
  for (const value of [
    r.armMotor.stiffness,
    r.armMotor.damping,
    ...r.armMotor.maxTorque,
    r.fingerMotor.stiffness,
    r.fingerMotor.damping,
    r.fingerMotor.maxForce,
    r.body.motor.stiffness,
    r.body.motor.damping,
    ...r.body.motor.maxTorque,
  ])
    positive(value, 'motor parameter');
  for (const value of [r.fingerMotor.couplingStiffness, r.fingerMotor.couplingDamping])
    if (value < 0) throw new Error('Negative finger coupling parameter');
  if (!r.inertials.source.trim() || r.inertials.arms.length !== 6)
    throw new Error('Invalid inertial source or link count');
  for (const inertial of [
    ...r.inertials.arms,
    r.inertials.finger,
    r.inertials.yaw,
    r.inertials.torso,
  ]) {
    positive(inertial.mass, 'body mass');
    if (
      inertial.centerOfMass.length !== 3 ||
      inertial.principalInertia.length !== 3 ||
      inertial.inertiaFrame.length !== 4
    )
      throw new Error('Invalid mass property dimensions');
    inertial.principalInertia.forEach((value) => positive(value, 'principal inertia'));
    const sum = inertial.principalInertia.reduce((a, b) => a + b);
    if (
      inertial.principalInertia.some((value) => 2 * value > sum + 1e-9) ||
      Math.abs(Math.hypot(...inertial.inertiaFrame) - 1) > 1e-6
    )
      throw new Error('Nonphysical principal inertia or invalid inertia frame');
  }
  if (
    r.armMotor.maxTorque.length !== 6 ||
    r.body.motor.maxTorque.length !== 2 ||
    r.home.gap < r.gap[0] ||
    r.home.gap > r.gap[1]
  )
    throw new Error('Invalid motor count or home gap');
  r.axes.forEach((a) => {
    if (a.length !== 3 || Math.abs(Math.hypot(...a) - 1) > 1e-6)
      throw new Error('Joint axis must be unit length');
  });
  r.limits.forEach((b, i) => {
    if (b.length !== 2 || b[0] >= b[1] || r.homeJoints[i] < b[0] || r.homeJoints[i] > b[1])
      throw new Error('Invalid joint limits/home');
  });
}

export function validateObjects(objects: ObjectSpec[]) {
  integer(objects.length, 'object count');
  const ids = new Set<string>();
  for (const object of objects) {
    if (typeof object.id !== 'string' || !object.id || ids.has(object.id))
      throw new Error('Duplicate or empty object ID');
    ids.add(object.id);
    if (!Object.hasOwn(OBJECT_COLORS, object.color)) throw new Error('Invalid object color');
    if (!['cuboid', 'cylinder', 'sphere'].includes(object.shape.kind))
      throw new Error('Invalid shape');
    if (
      object.shape.kind === 'cuboid' &&
      (!Array.isArray(object.shape.size) || object.shape.size.length !== 3)
    )
      throw new Error('Cuboid size requires three dimensions');
    dimensions(object.shape).forEach((v) => positive(v, 'object dimension'));
    positive(object.density, 'density');
    if (!Number.isFinite(object.friction) || object.friction < 0)
      throw new Error('Negative friction');
    const q = object.rotation;
    if (
      [q.x, q.y, q.z, q.w].some((v) => !Number.isFinite(v)) ||
      Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 1e-6
    )
      throw new Error('Invalid object rotation');
  }
}
export function validateWorldConfig(config: WorldConfig) {
  validateEnvironment(config.environment);
  validateObjects(config.scene);
  for (const object of config.scene) {
    const p: Vec3 = object.position;
    if ([p.x, p.y, p.z].some((v) => !Number.isFinite(v)))
      throw new Error('Invalid object position');
  }
}
