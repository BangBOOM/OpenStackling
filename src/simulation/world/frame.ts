import type { ShapeSpec } from './objects';
import type { BodyState, Vec3, Quat, WorldSnapshot } from './types';

export type BodyMetadata = {
  id: number;
  dynamic: boolean;
  colliders: number[];
  mass: number;
  localCom: Vec3;
  principalInertia: Vec3;
  inertiaFrame: Quat;
};
export type WorldMetadata = {
  bodies: BodyMetadata[];
  colliders: { id: number; shape: ShapeSpec; collisionGroups: number }[];
  table: number;
  objects: number[];
  torso: number;
  fixed: number;
  arms: { bodies: number[]; fingers: number[] }[];
  impulseJoints: number;
};
export type ContactManifold = {
  normal: Vec3;
  friction: number;
  points: { distance: number; impulse: number; p1: Vec3; p2: Vec3 }[];
};
export type MeasuredFrame = Pick<WorldSnapshot, 'state' | 'target' | 'tcps'> & {
  tick: number;
  bodies: (BodyState & { id: number; worldCom: Vec3 })[];
};
export type PhysicsFrame = MeasuredFrame &
  Pick<WorldSnapshot, 'actuators' | 'fingers' | 'contacts'> & {
    colliders: { id: number; position: Vec3; rotation: Quat }[];
    pairs: { a: number; b: number; manifolds: ContactManifold[] }[];
  };
