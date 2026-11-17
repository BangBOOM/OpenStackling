import type { WorldView } from '../../simulation/world/view';
import type { ActionRow, ActionSource } from '../episode-types';
export class ReplaySource implements ActionSource {
  readonly name = 'replay';
  private index = 0;
  constructor(
    private sim: Pick<WorldView, 'ticks' | 'targetState'>,
    private rows: ActionRow[],
  ) {}
  reset() {
    this.index = 0;
  }
  next() {
    const row = this.rows[this.index];
    if (!row)
      return {
        action: this.sim.targetState(),
        valid: true,
        reason: '',
        phase: 'replay-hold',
      };
    if (row.tick !== this.sim.ticks)
      throw new Error(`Replay action timestamp mismatch at ${this.sim.ticks}`);
    this.index++;
    return {
      action: row.executed_action,
      valid: true,
      reason: '',
      phase: 'replay',
      continuous: row.continuous,
    };
  }
  end() {}
}
