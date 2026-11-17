// The caller owns scheduling; yielding never advances simulation time.
export type PlanningWork<T = void> = Generator<void, T, void>;

export function finishPlanning<T>(work: PlanningWork<T>): T {
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}
