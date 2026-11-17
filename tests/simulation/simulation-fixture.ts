import type { Config } from '../../src/runtime/config';
import { worldConfig } from '../../src/simulation/scene';
import { Simulation } from '../../src/simulation/world/simulation';
const configurations = new WeakMap<Simulation, Config>();
export function createSimulation(config: Config) {
  const sim = new Simulation(worldConfig(config));
  configurations.set(sim, config);
  return sim;
}
export function fixtureConfig(sim: Simulation) {
  return configurations.get(sim)!;
}
