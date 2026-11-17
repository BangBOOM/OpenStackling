import type { WorldSnapshot } from '../../simulation/world/types';

export const DIAGNOSTIC_FIELDS = {
  actuators: [
    'reference',
    'referenceVelocity',
    'velocity',
    'gravityTorque',
    'requestedTorqueEstimate',
    'limitedTorqueEstimate',
    'torqueLimit',
    'trackingError',
    'anchorError',
  ],
  fingers: [
    'position',
    'velocity',
    'reference',
    'referenceVelocity',
    'requestedForceEstimate',
    'limitedForceEstimate',
  ],
  contacts: ['normalForce', 'frictionLimit', 'slipSpeed', 'friction', 'points'],
  tcp: ['x', 'y', 'z', 'gap', 'qx', 'qy', 'qz', 'qw'],
  blocks: ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz', 'wx', 'wy', 'wz'],
} as const;

export function diagnosticShapes(rows: number, blocks: number) {
  return {
    actuators: [rows, 14, DIAGNOSTIC_FIELDS.actuators.length],
    fingers: [rows, 2, 2, DIAGNOSTIC_FIELDS.fingers.length],
    contacts: [rows, 2, blocks, 2, DIAGNOSTIC_FIELDS.contacts.length],
    tcp: [rows, 2, DIAGNOSTIC_FIELDS.tcp.length],
    blocks: [rows, blocks, DIAGNOSTIC_FIELDS.blocks.length],
  };
}

export function diagnosticValues(snapshot: WorldSnapshot) {
  return {
    actuators: snapshot.actuators.flatMap((row) =>
      DIAGNOSTIC_FIELDS.actuators.map((key) => row[key]),
    ),
    fingers: snapshot.fingers
      .flat(1)
      .flatMap((row) => DIAGNOSTIC_FIELDS.fingers.map((key) => row[key])),
    contacts: snapshot.contacts
      .flat(2)
      .flatMap((row) => DIAGNOSTIC_FIELDS.contacts.map((key) => row[key])),
    tcp: snapshot.tcps.flatMap((tcp) => [
      tcp.x,
      tcp.y,
      tcp.z,
      tcp.gap,
      tcp.rotation.x,
      tcp.rotation.y,
      tcp.rotation.z,
      tcp.rotation.w,
    ]),
    blocks: snapshot.blocks.flatMap((body) => [
      body.position.x,
      body.position.y,
      body.position.z,
      body.rotation.x,
      body.rotation.y,
      body.rotation.z,
      body.rotation.w,
      body.velocity.x,
      body.velocity.y,
      body.velocity.z,
      body.angularVelocity.x,
      body.angularVelocity.y,
      body.angularVelocity.z,
    ]),
  };
}
