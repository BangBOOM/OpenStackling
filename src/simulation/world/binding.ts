import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { physicsSourceHash, type PhysicsBuild } from './physics-build';

type World = {
  metadata(): string;
  frame(output: Float64Array): number;
  apply(action: number[], continuous: boolean): void;
  step(output: Float64Array): number;
  setBody(command: string): void;
  setCollider(command: string): void;
  dispose(): void;
};
type Binding = {
  NativeWorld: new (config: string) => World;
  shapeContact(query: Float64Array): number;
  shapeContains(query: string): boolean;
};
const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = path.join(root, '.tmp/physics/stackling_physics.node');
let binding: Binding | undefined;
function load(): Binding {
  if (binding) return binding;
  const build = JSON.parse(
    readFileSync(path.join(root, '.tmp/physics/build.json'), 'utf8'),
  ) as PhysicsBuild;
  if (
    build.sourceHash !== physicsSourceHash(root) ||
    build.binarySha256 !== createHash('sha256').update(readFileSync(binary)).digest('hex')
  )
    throw new Error('Physics artifact is stale. Run bun run build:physics.');
  return (binding = createRequire(import.meta.url)(binary) as Binding);
}
export const physicsBinding: Binding = {
  get NativeWorld() {
    return load().NativeWorld;
  },
  shapeContact: (query) => load().shapeContact(query),
  shapeContains: (query) => load().shapeContains(query),
};
