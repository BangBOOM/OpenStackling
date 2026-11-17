import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { flipRows, unpackDepth } from './render/pixels';

type StartMessage = {
  id: number;
  kind: 'episode';
  op: 'start';
  width: number;
  height: number;
  gop: number;
  framerate: number;
  bitrate: number;
};
type FrameMessage = {
  id: number;
  kind: 'frame';
  tick: number;
  width: number;
  height: number;
  gop: number;
  rgba: Uint8Array;
  depthRgba?: Uint8Array;
  wantPng: boolean;
  physicsHz: number;
  observationHz: number;
};
type EndMessage = { id: number; kind: 'episode'; op: 'end' };
type AbortMessage = { id: number; kind: 'episode'; op: 'abort' };
type Message = StartMessage | FrameMessage | EndMessage | AbortMessage;

let encoder: VideoEncoder | undefined;
let muxer: Muxer<ArrayBufferTarget> | undefined;
let failure: string | undefined;
// The first output chunk must carry decoderConfig; without it the mp4 cannot
// be built. Chrome intermittently omits it when many encoders initialize at
// once, so track it and fail with a stable marker before muxing.
let sawDecoderConfig = false;
let frameIndex = 0;
let videoWidth = 0;
let videoHeight = 0;
// H.264 first (preferred by consumers), VP9 last as the always-available open fallback.
const CODECS: { encoder: string; container: 'avc' | 'vp9'; label: string }[] = [
  { encoder: 'avc1.42001f', container: 'avc', label: 'h264-yuv420' },
  { encoder: 'avc1.42002A', container: 'avc', label: 'h264-yuv420' },
  { encoder: 'vp09.00.10.08', container: 'vp9', label: 'vp9-yuv420' },
];

async function startEpisode(message: StartMessage) {
  if (encoder) throw new Error('Episode already active');
  failure = undefined;
  sawDecoderConfig = false;
  videoWidth = message.width & ~1;
  videoHeight = message.height & ~1;
  const base = {
    width: videoWidth,
    height: videoHeight,
    framerate: message.framerate,
    bitrate: message.bitrate,
  };
  let chosen: (typeof CODECS)[number] | undefined;
  for (const candidate of CODECS) {
    const config: VideoEncoderConfig = { ...base, codec: candidate.encoder };
    if (candidate.container === 'avc') config.avc = { format: 'avc' };
    if ((await VideoEncoder.isConfigSupported(config)).supported) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen)
    throw new Error(
      'No supported video encoder (tried avc1.42001f, avc1.42002A, vp09.00.10.08); use Google Chrome or a codec-enabled Chromium',
    );
  muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',
    video: { codec: chosen.container, width: videoWidth, height: videoHeight },
  });
  encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) sawDecoderConfig = true;
      muxer!.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      failure = String(e);
    },
  });
  const config: VideoEncoderConfig = { ...base, codec: chosen.encoder };
  if (chosen.container === 'avc') config.avc = { format: 'avc' };
  encoder.configure(config);
  frameIndex = 0;
  return chosen.label;
}

async function gzipBytes(data: Uint8Array) {
  const stream = new Response(data.buffer as ArrayBuffer).body!.pipeThrough(
    new CompressionStream('gzip'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodeFrame(message: FrameMessage) {
  if (failure) throw new Error(failure);
  const start = performance.now();
  let png: Uint8Array | undefined;
  let gzDepth: Uint8Array | undefined;
  const rgb = flipRows(message.rgba, message.width, message.height);
  if (encoder && muxer) {
    if (encoder.encodeQueueSize > 4)
      await new Promise<void>((resolve) => {
        encoder!.ondequeue = () => resolve();
      });
    const crop = (message.width & ~1) !== videoWidth || (message.height & ~1) !== videoHeight;
    let videoRgb = rgb;
    if (crop) {
      videoRgb = new Uint8Array(videoWidth * videoHeight * 4);
      for (let row = 0; row < videoHeight; row++)
        videoRgb.set(
          rgb.subarray(row * message.width * 4, row * message.width * 4 + videoWidth * 4),
          row * videoWidth * 4,
        );
    }
    const frame = new VideoFrame(videoRgb.buffer as ArrayBuffer, {
      format: 'RGBA',
      codedWidth: videoWidth,
      codedHeight: videoHeight,
      timestamp: Math.round((message.tick * 1e6) / message.physicsHz),
      duration: Math.round(1e6 / message.observationHz),
    });
    encoder.encode(frame, { keyFrame: frameIndex % message.gop === 0 });
    frame.close();
    frameIndex++;
  }
  if (message.wantPng) {
    const canvas = new OffscreenCanvas(message.width, message.height),
      context = canvas.getContext('2d')!;
    context.putImageData(
      new ImageData(
        new Uint8ClampedArray(rgb.buffer as ArrayBuffer),
        message.width,
        message.height,
      ),
      0,
      0,
    );
    png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  }
  if (message.depthRgba)
    gzDepth = await gzipBytes(unpackDepth(message.depthRgba, message.width, message.height));
  const buffers: Transferable[] = [];
  if (png) buffers.push(png.buffer);
  if (gzDepth) buffers.push(gzDepth.buffer);
  self.postMessage(
    { id: message.id, png, gzDepth, encodeMs: performance.now() - start },
    { transfer: buffers },
  );
}

async function run(message: Message): Promise<Record<string, unknown> | undefined> {
  if (message.kind === 'episode' && message.op === 'start') {
    const label = await startEpisode(message);
    return { id: message.id, codec: label };
  }
  if (message.kind === 'frame') {
    await encodeFrame(message);
    return undefined;
  }
  if (message.kind === 'episode' && message.op === 'end') {
    if (!encoder || !muxer) throw new Error('No active episode');
    if (failure) throw new Error(failure);
    await encoder.flush();
    if (!sawDecoderConfig)
      throw new Error(
        `encoder-no-decoder-config frames=${frameIndex} failure=${failure ?? 'none'}`,
      );
    muxer.finalize();
    const mp4 = new Uint8Array(muxer.target.buffer);
    encoder.close();
    encoder = undefined;
    muxer = undefined;
    frameIndex = 0;
    return { id: message.id, mp4 };
  }
  encoder?.close();
  encoder = undefined;
  muxer = undefined;
  frameIndex = 0;
  return { id: message.id };
}

// Messages must be handled one at a time: VideoEncoder state is shared, frames
// have to keep their order, and `ondequeue` has a single handler slot.
let chain: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<Message>) => {
  chain = chain.then(async () => {
    const { id } = event.data;
    try {
      const reply = await run(event.data);
      self.postMessage(reply ? { ...reply, id } : { id });
    } catch (error) {
      self.postMessage({ id, error: String(error) });
    }
  });
};
