import { headMount } from '../world/mount';
import * as THREE from 'three';
import type { EnvironmentConfig } from '../world/config';
import { CAMERA_POSITIONS, type CameraConfig } from './config';
export function cameraPose(config: CameraConfig, tableTop: number) {
  const index = CAMERA_POSITIONS.indexOf(config.position as (typeof CAMERA_POSITIONS)[number]),
    angle = (index * Math.PI) / 4;
  return [
    Math.sin(angle) * config.distance,
    tableTop + config.height,
    -Math.cos(angle) * config.distance,
  ] as [number, number, number];
}
export function makeCamera(
  config: CameraConfig,
  environment: EnvironmentConfig,
  root?: { position: THREE.Vector3; rotation: THREE.Quaternion },
) {
  const head = config.head;
  const mounted = config.mount === 'head';
  const c = new THREE.PerspectiveCamera(
    mounted ? head.fov : config.fov,
    config.width / config.heightPixels,
    mounted ? head.near : config.near,
    config.far,
  );
  if (mounted) {
    const mount = headMount(environment.robot, head.pitch);
    c.position.copy(mount.lens);
    c.quaternion
      .copy(mount.opticalRotation)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    if (root) {
      c.position.applyQuaternion(root.rotation).add(root.position);
      c.quaternion.premultiply(root.rotation);
    }
  } else {
    c.position.fromArray(cameraPose(config, environment.tableTop));
    c.lookAt(new THREE.Vector3(...(config.target as [number, number, number])));
  }
  c.updateMatrixWorld(true);
  return c;
}
export function calibration(config: CameraConfig, environment: EnvironmentConfig) {
  const c = makeCamera(config, environment),
    fy = config.heightPixels / (2 * Math.tan((c.fov * Math.PI) / 360));
  return {
    width: config.width,
    height: config.heightPixels,
    intrinsics: [
      [fy, 0, config.width / 2],
      [0, fy, config.heightPixels / 2],
      [0, 0, 1],
    ],
    cameraToWorld: c.matrixWorld.toArray(),
    position: c.position.toArray(),
    target:
      config.mount === 'head'
        ? c.getWorldDirection(new THREE.Vector3()).add(c.position).toArray()
        : config.target,
    near: c.near,
    far: config.far,
    pixelOrigin: 'top-left',
    pixelCenters: 'half-integers',
    cameraAxes: 'right, up, backward (Three.js); depth is positive optical-axis distance',
    depthScaleMeters: 0.001,
    depthInvalid: 0,
  };
}
