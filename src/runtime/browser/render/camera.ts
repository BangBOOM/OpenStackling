import * as THREE from 'three';
import { makeCamera } from '../../../simulation/sensors/camera';
import type { CameraConfig } from '../../../simulation/sensors/config';
import { flipRows, unpackDepth } from './pixels';
import type { WorldScene } from './rendering';
export type RawFrame = { rgb: Uint8Array; depth?: Uint8Array };
// GL readback order: rows are bottom-up and depth is packed into RG.
export type PendingFrame = { rgba: Uint8Array; depthRgba?: Uint8Array };
export class SensorCamera {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private target: THREE.WebGLRenderTarget;
  private depthTarget?: THREE.WebGLRenderTarget;
  private depthScene?: THREE.Scene;
  private depthMaterial?: THREE.ShaderMaterial;
  private quad?: THREE.Mesh;
  private screen = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  renderMs = 0;
  readbackMs = 0;
  frames = 0;
  constructor(
    public worldScene: WorldScene,
    public config: CameraConfig,
  ) {
    this.camera = makeCamera(config, worldScene.sim.config.environment);
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(config.width, config.heightPixels, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.target = new THREE.WebGLRenderTarget(config.width, config.heightPixels);
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    if (config.depth) {
      this.target.depthTexture = new THREE.DepthTexture(
        config.width,
        config.heightPixels,
        THREE.UnsignedIntType,
      );
      this.depthTarget = new THREE.WebGLRenderTarget(config.width, config.heightPixels);
      this.depthScene = new THREE.Scene();
      this.depthMaterial = new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: {
          depthTexture: { value: this.target.depthTexture },
          near: { value: this.camera.near },
          far: { value: config.far },
        },
        vertexShader: 'varying vec2 uv0;void main(){uv0=uv;gl_Position=vec4(position.xy,0.,1.);}',
        fragmentShader:
          'varying vec2 uv0;uniform sampler2D depthTexture;uniform float near;uniform float far;void main(){float z=texture2D(depthTexture,uv0).x;float meters=near*far/(far-z*(far-near));float mm=z>=1.?0.:floor(meters*1000.+.5);gl_FragColor=vec4(mod(mm,256.)/255.,floor(mm/256.)/255.,0.,1.);}',
      });
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.depthMaterial);
      this.depthScene.add(this.quad);
    }
  }
  rebind(worldScene: WorldScene, config: CameraConfig) {
    this.worldScene = worldScene;
    this.config = config;
    this.camera.copy(makeCamera(config, worldScene.sim.config.environment));
    if (this.depthMaterial) {
      this.depthMaterial.uniforms.near.value = this.camera.near;
      this.depthMaterial.uniforms.far.value = config.far;
    }
    this.renderMs = 0;
    this.readbackMs = 0;
    this.frames = 0;
  }
  private renderRgb() {
    this.worldScene.sync();
    if (this.config.mount === 'head')
      this.camera.copy(
        makeCamera(
          this.config,
          this.worldScene.sim.config.environment,
          this.worldScene.sim.body.transform(),
        ),
      );
    this.renderer.setRenderTarget(this.target);
    this.worldScene.render(this.renderer, this.camera);
  }
  private renderDepth() {
    this.renderer.setRenderTarget(this.depthTarget!);
    this.renderer.render(this.depthScene!, this.screen);
  }
  capture(): RawFrame {
    const w = this.config.width,
      h = this.config.heightPixels,
      renderStart = performance.now();
    this.renderRgb();
    const readStart = performance.now();
    const rgba = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(this.target, 0, 0, w, h, rgba);
    this.renderMs += readStart - renderStart;
    this.readbackMs += performance.now() - readStart;
    let depthRgba: Uint8Array | undefined;
    if (this.depthTarget) {
      const depthRenderStart = performance.now();
      this.renderDepth();
      const depthReadStart = performance.now();
      depthRgba = new Uint8Array(w * h * 4);
      this.renderer.readRenderTargetPixels(this.depthTarget, 0, 0, w, h, depthRgba);
      this.renderMs += depthReadStart - depthRenderStart;
      this.readbackMs += performance.now() - depthReadStart;
    }
    this.renderer.setRenderTarget(null);
    this.frames++;
    const rgb = flipRows(rgba, w, h),
      depth = depthRgba && unpackDepth(depthRgba, w, h);
    return { rgb, depth };
  }
  // Issues the render and the PBO copies synchronously at the current tick, then
  // resolves once the GPU has filled the buffers. Callers must not await before
  // returning so the simulation can keep stepping while the readback completes.
  captureAsync(): Promise<PendingFrame> {
    const w = this.config.width,
      h = this.config.heightPixels,
      renderStart = performance.now();
    this.renderRgb();
    const rgba = new Uint8Array(w * h * 4),
      rgbWait = this.renderer.readRenderTargetPixelsAsync(this.target, 0, 0, w, h, rgba);
    this.renderMs += performance.now() - renderStart;
    let depthRgba: Uint8Array | undefined, depthWait: Promise<unknown> | undefined;
    if (this.depthTarget) {
      const depthRenderStart = performance.now();
      this.renderDepth();
      depthRgba = new Uint8Array(w * h * 4);
      depthWait = this.renderer.readRenderTargetPixelsAsync(
        this.depthTarget,
        0,
        0,
        w,
        h,
        depthRgba,
      );
      this.renderMs += performance.now() - depthRenderStart;
    }
    this.renderer.setRenderTarget(null);
    this.frames++;
    const issued = performance.now();
    return Promise.all(depthWait ? [rgbWait, depthWait] : [rgbWait])
      .then(() => {
        this.readbackMs += performance.now() - issued;
        return { rgba, depthRgba };
      })
      .catch((error: unknown) => {
        // three rejects with undefined when the context is lost; keep a truthy
        // error so the collector's error accounting cannot mistake it for none.
        throw error instanceof Error ? error : new Error('GPU readback failed');
      });
  }
  dispose() {
    this.worldScene.releaseRenderer(this.renderer);
    this.target.dispose();
    this.depthTarget?.dispose();
    this.quad?.geometry.dispose();
    this.depthMaterial?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
