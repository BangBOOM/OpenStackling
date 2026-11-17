import defaults from '../../../configs/default.json' with { type: 'json' };
export const CAMERA_POSITIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type CameraPosition = (typeof CAMERA_POSITIONS)[number];
export type CameraMount = 'external' | 'head';
export type HeadCameraConfig = typeof defaults.camera.head;
export const HEAD_CAMERA_DEFAULTS: Readonly<HeadCameraConfig> = Object.freeze({
  ...defaults.camera.head,
});
export type CameraConfig = Omit<typeof defaults.camera, 'mount' | 'head'> & {
  mount: CameraMount;
  head: HeadCameraConfig;
};
