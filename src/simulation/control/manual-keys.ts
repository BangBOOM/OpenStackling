export const directions: Record<string, ['x' | 'y' | 'z' | 'gap', number]> = {
  KeyW: ['z', -1],
  KeyS: ['z', 1],
  KeyA: ['x', -1],
  KeyD: ['x', 1],
  KeyU: ['y', 1],
  KeyJ: ['y', -1],
  KeyH: ['gap', 1],
  KeyK: ['gap', -1],
};

export const isManualKey = (key: string) => Object.hasOwn(directions, key);
