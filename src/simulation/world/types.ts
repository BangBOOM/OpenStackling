export type ArmState = [number, number, number, number, number, number, number];
export type Action16D = [number, number, ...ArmState, ...ArmState];
export type Action = Action16D;
export type State = Action16D;
export type Vec3 = { x: number; y: number; z: number };
export type Quat = Vec3 & { w: number };
export type BodyState = { position: Vec3; rotation: Quat; velocity: Vec3; angularVelocity: Vec3 };
export type ActuatorDiagnostic = {
  reference: number;
  referenceVelocity: number;
  velocity: number;
  gravityTorque: number;
  requestedTorqueEstimate: number;
  limitedTorqueEstimate: number;
  torqueLimit: number;
  trackingError: number;
  anchorError: number;
};
export type FingerDiagnostic = {
  position: number;
  velocity: number;
  reference: number;
  referenceVelocity: number;
  requestedForceEstimate: number;
  limitedForceEstimate: number;
};
export type ContactDiagnostic = {
  normalForce: number;
  frictionLimit: number;
  slipSpeed: number;
  friction: number;
  points: number;
};
export type WorldMeasurements = {
  tick: number;
  time: number;
  state: State;
  target: Action;
  tcps: (Vec3 & { gap: number; rotation: Quat })[];
  blocks: BodyState[];
};
export type WorldSnapshot = WorldMeasurements & {
  actuators: ActuatorDiagnostic[];
  fingers: FingerDiagnostic[][];
  contacts: ContactDiagnostic[][][];
};

export type Outcome = 'success' | 'completed' | 'timeout' | 'teacher-failed' | 'stopped';
