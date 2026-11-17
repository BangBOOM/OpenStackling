import type { Simulation } from '../world/simulation';
import { contact, inspectStructures } from './structures';
export const supported = contact;
export function stackIsStable(sim: Simulation, ids: number[]) {
  return inspectStructures(sim).some(
    (s) =>
      s.stable &&
      s.tower &&
      ids.length === s.ids.length &&
      ids.every((id, i) => s.tower![i] === id),
  );
}
