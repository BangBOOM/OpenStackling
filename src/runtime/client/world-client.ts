import { BodyView, WorldView } from '../../simulation/world/view';
import type { WorldConfig } from '../../simulation/world/config';
import type { WorldMetadata, MeasuredFrame } from '../../simulation/world/frame';
import type { Action, Vec3, Quat } from '../../simulation/world/types';
import { Connection } from './rpc';
import { HOST_PROTOCOL_VERSION } from '../host-protocol';

export class WorldClient extends WorldView {
  private constructor(
    private connection: Connection,
    config: WorldConfig,
    opened: { metadata: WorldMetadata; frame: MeasuredFrame },
  ) {
    super(config, opened.metadata, opened.frame, (view, id) => new BodyView(view, id));
  }
  static async create(config: WorldConfig) {
    const connection = await Connection.connect();
    try {
      const opened = await connection.request<{ metadata: WorldMetadata; frame: MeasuredFrame }>(
        'world.open',
        { version: HOST_PROTOCOL_VERSION, config },
      );
      return new WorldClient(connection, config, opened);
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  async step() {
    this.frame = await this.connection.request<MeasuredFrame>('world.step');
  }
  async apply(action: Action, continuous = false) {
    this.frame = await this.connection.request<MeasuredFrame>('world.apply', {
      action,
      continuous,
    });
  }
  async setBody(
    index: number,
    values: { position?: Vec3; rotation?: Quat; velocity?: Vec3; angularVelocity?: Vec3 },
  ) {
    this.frame = await this.connection.request<MeasuredFrame>('world.body', { index, values });
  }
  async dispose() {
    try {
      await this.connection.request('world.dispose');
    } finally {
      this.connection.close();
    }
  }
}
