import type { EpisodeSink, ActionRow, DiagnosticRow } from '../episode-types';
import type { PacketRow } from '../recording/protocol';

// Action and diagnostic rows stay on the host. Batches bound memory and retain
// backpressure from the owning writer without involving the browser.
export class HostRecording implements Pick<EpisodeSink, 'action' | 'diagnostic'> {
  private rows: PacketRow[] = [];
  private pending = Promise.resolve();
  constructor(private readonly write: (rows: PacketRow[]) => Promise<void>) {}
  action(row: ActionRow) {
    return this.append({
      kind: 'action',
      row: { ...row, executed_action: [...row.executed_action] },
    });
  }
  diagnostic(row: DiagnosticRow) {
    return this.append({ kind: 'diagnostic', row });
  }
  private append(row: PacketRow) {
    this.rows.push(row);
    if (this.rows.length >= 128) return this.flush();
  }
  flush() {
    if (this.rows.length) {
      const rows = this.rows;
      this.rows = [];
      this.pending = this.pending.then(() => this.write(rows));
    }
    return this.pending;
  }
}
