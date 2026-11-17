import type { SensorCamera } from './render/camera';
import { FrameEncoder, type EncodedFrame } from './encoder';
// One capture and encoding per observation tick, shared by inference and recording.
// Video encoding is episode-scoped: startEpisode/endEpisode bracket a recorded run.
export class FramePipeline {
  readonly encoder = new FrameEncoder();
  private tick = -1;
  private revision = -1;
  private frame?: Promise<EncodedFrame>;
  private previous?: Promise<unknown>;
  constructor(
    private sensor: SensorCamera,
    private rates: { physicsHz: number; observationHz: number },
    private options: { video?: boolean; png?: boolean } = {},
  ) {}
  startEpisode() {
    this.tick = -1;
    this.revision = -1;
    this.frame = undefined;
    this.previous = undefined;
    const { width, heightPixels } = this.sensor.config;
    const { observationHz } = this.rates;
    if (!this.options.video) return Promise.resolve(undefined);
    return this.encoder.startEpisode({
      width,
      height: heightPixels,
      gop: observationHz,
      framerate: observationHz,
      bitrate: Math.round(width * heightPixels * observationHz * 0.15),
    });
  }
  endEpisode() {
    return this.encoder.finish();
  }
  sample(tick: number) {
    if (this.tick !== tick || this.revision !== this.sensor.worldScene.visualRevision) {
      this.tick = tick;
      this.revision = this.sensor.worldScene.visualRevision;
      const capture = this.sensor.captureAsync(),
        previous = this.previous;
      this.previous = capture;
      // Captures are issued in tick order, but their fences resolve out of
      // order. Chain the encodes so the encoder always sees increasing ticks.
      this.frame = (previous ?? Promise.resolve())
        .catch(() => {})
        .then(() => capture)
        .then((frame) =>
          this.encoder.encode(
            tick,
            frame,
            this.sensor.config.width,
            this.sensor.config.heightPixels,
            this.options.png === true,
            this.rates.physicsHz,
            this.rates.observationHz,
            this.rates.observationHz,
          ),
        );
    }
    return this.frame!;
  }
  abortEpisode() {
    this.encoder.abort();
  }
  dispose() {
    this.encoder.dispose();
  }
}
