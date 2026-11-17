import type { ActionSource, EpisodeResult, ObservationRow } from '../episode-types';
import type { WorldView } from '../../simulation/world/view';
import type { Config } from '../config';

import { PolicyError } from './contract';
import type { PolicySession } from './session';
export class ExternalPolicySource implements ActionSource {
  readonly name = 'external-policy';
  private cancelled = false;
  constructor(
    private sim: Pick<WorldView, 'ticks'>,
    readonly session: PolicySession,
    private sample: (tick: number) => Promise<{ png?: Uint8Array; gzDepth?: Uint8Array }>,
    private config: Config,
  ) {}
  reset() {}
  initialize() {
    return this.session.start(this.config);
  }
  async observe(row: ObservationRow) {
    const frame = await this.sample(row.tick);
    if (this.cancelled) throw new PolicyError('CANCELLED');
    await this.session.observe(row, { rgb: frame.png!, depth: frame.gzDepth });
  }
  async next(dt: number) {
    return {
      ...(await this.session.act(this.sim.ticks, dt)),
      valid: true,
      reason: '',
      phase: 'external-policy',
    };
  }
  cancel() {
    this.cancelled = true;
    this.session.cancelPending();
  }
  end(result: EpisodeResult) {
    const { outcome, reason, ticks, seconds } = result;
    return this.session.end({ outcome, reason, ticks, seconds });
  }
}
