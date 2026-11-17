import { ConfigEdit } from './config-edit';
import { PolicyConnection } from './policy-connection';
import { isManualKey } from '../../simulation/control/manual-keys';
import { scenePatch, type SceneRequest } from '../../simulation/scene';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { validateTheme } from '../../runtime/theme-catalog';
import { resolveConfig, type DeepPartial, type Config } from '../../runtime/config';
import { WorldScene } from '../../runtime/browser/render/rendering';
import { SensorCamera, type RawFrame } from '../../runtime/browser/render/camera';
import { makeCamera } from '../../simulation/sensors/camera';
import { EpisodeClient } from '../../runtime/client/episode-client';
import { PolicySession, type ConnectionOptions } from '../../runtime/policy/session';
import { assertCompatible } from '../../runtime/policy/contract';
import { ExternalPolicySource } from '../../runtime/policy/source';
import { FramePipeline } from '../../runtime/browser/frame-pipeline';
import i18n from './i18n';
import {
  TASK_PRESETS,
  taskPreset,
  presetPatch,
  generationForPreset,
  type TaskPreset,
} from '../../runtime/presets';
import { JointOverlay } from './joints';
import {
  useUI,
  permissions,
  DEFAULT_DISPLAY,
  TEACHER_RATES,
  type TeacherRate,
  type Mode,
  type Viewport,
} from './store';
export type Preview = { frame: RawFrame; width: number; height: number };
type WorldView = {
  episode: EpisodeClient;
  scene: WorldScene;
  sensor: SensorCamera;
  frames?: FramePipeline;
};
export class Runtime {
  readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  readonly camera = new THREE.PerspectiveCamera(36, 1, 0.05, 40);
  private readonly headView = new THREE.PerspectiveCamera();
  readonly orbit: OrbitControls;
  private connection = new PolicyConnection<WorldView>(
    () => this.disposed,
    (error) => this.policyFault(error),
  );
  private get policy() {
    return this.connection.session;
  }
  private frames?: FramePipeline;
  private stepping?: Promise<void>;
  episode!: EpisodeClient;
  sensor!: SensorCamera;
  scene!: WorldScene;
  private overlay!: JointOverlay;
  private keys = new Set<string>();
  private listeners = new Set<(frame: Preview) => void>();
  private latest?: Preview;
  private resize: ResizeObserver;
  private cleanup: () => void;
  private disposed = false;
  private busy = false;
  private dirty = true;
  private edit = new ConfigEdit<WorldView>();
  private viewRevision = 0;
  private accumulator = 0;
  private playbackRevision = 0;
  private workDeadline = 0;
  private last = performance.now();
  private lastPreview = -1;
  private lastCapture = -Infinity;
  private lastTelemetry = -Infinity;
  private raf = 0;
  private pending?: { config: Config; teacher: boolean; start: boolean; fallback: Mode };
  config: Config;
  private sceneRequest: SceneRequest;
  static async create(host: HTMLElement) {
    const runtime = new Runtime(host, __STACKLING_CONFIG__);
    try {
      await runtime.rebuild(__STACKLING_CONFIG__, false);
      runtime.raf = requestAnimationFrame(runtime.frame);
      return runtime;
    } catch (error) {
      runtime.cleanup();
      runtime.resize.disconnect();
      runtime.orbit.dispose();
      runtime.renderer.dispose();
      runtime.renderer.forceContextLoss();
      runtime.renderer.domElement.remove();
      throw error;
    }
  }
  private constructor(host: HTMLElement, config: Config) {
    this.config = config;
    this.sceneRequest = generationForPreset(taskPreset(config), config.scene.objects.length);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.tabIndex = 0;
    host.append(this.renderer.domElement);
    this.camera.layers.enable(1);
    this.camera.position.set(3.6, 2.7, 4.6);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(-0.1, 0.45, -0.05);
    this.orbit.enableDamping = true;
    this.orbit.minDistance = 1.0;
    this.orbit.maxDistance = 9;
    this.orbit.maxPolarAngle = Math.PI * 0.8;
    this.orbit.addEventListener('change', () => {
      this.dirty = true;
    });
    this.resize = new ResizeObserver(() => {
      const w = host.clientWidth,
        h = host.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.zoom = Math.min(1, w / h / 0.95);
      this.camera.updateProjectionMatrix();
      this.headView.aspect = w / h;
      this.headView.updateProjectionMatrix();
      this.overlay?.labels.setSize(w, h);
      this.dirty = true;
    });
    this.resize.observe(host);
    const down = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof Element &&
          event.target.closest(
            'input,select,textarea,[contenteditable=true],[role=dialog],[data-settings]',
          )) ||
        !isManualKey(event.code)
      )
        return;
      if (
        !permissions(
          this.mode,
          this.episode.source.kind === 'teacher',
          useUI.getState().policyStatus,
        ).manual ||
        this.episode.result
      )
        return;
      event.preventDefault();
      if (this.mode === 'idle') this.setMode('running');
      this.keys.add(event.code);
    };
    const up = (event: KeyboardEvent) => {
      if (this.keys.delete(event.code) && this.episode.source.kind === 'manual')
        this.episode.source.holdSerial++;
    };
    const blur = () => {
      this.keys.clear();
      if (this.episode.source.kind === 'manual') this.episode.source.holdSerial++;
    };
    const visibility = () => {
      if (document.hidden) {
        if (this.mode === 'running') this.setMode('paused');
        blur();
        this.publish();
      }
    };
    let pointer: { x: number; y: number } | undefined;
    const pointerDown = (e: PointerEvent) => {
      pointer = e.button === 0 ? { x: e.clientX, y: e.clientY } : undefined;
    };
    const pointerUp = (e: PointerEvent) => {
      if (
        useUI.getState().viewport === 'head' ||
        !pointer ||
        Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 5
      )
        return;
      pointer = undefined;
      const bounds = this.renderer.domElement.getBoundingClientRect(),
        ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - bounds.left) / bounds.width) * 2 - 1,
          1 - ((e.clientY - bounds.top) / bounds.height) * 2,
        ),
        this.camera,
      );
      if (ray.intersectObjects(this.scene.pickables, true).length)
        useUI.setState((s) => ({ annotations: !s.annotations }));
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    this.renderer.domElement.addEventListener('pointerdown', pointerDown);
    this.renderer.domElement.addEventListener('pointerup', pointerUp);
    const unsubscribe = useUI.subscribe((state, previous) => {
      if (state.viewport !== previous.viewport) {
        this.orbit.enabled = state.viewport === 'orbit';
        this.overlay?.setAnnotations(state.annotations && state.viewport === 'orbit');
        this.dirty = true;
      }
      if (state.markers !== previous.markers) {
        this.overlay?.setMarkers(state.markers);
        this.dirty = true;
      }
      if (state.annotations !== previous.annotations) {
        this.overlay?.setAnnotations(state.annotations && state.viewport === 'orbit');
        this.dirty = true;
      }
    });
    this.cleanup = () => {
      unsubscribe();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
      this.renderer.domElement.removeEventListener('pointerdown', pointerDown);
      this.renderer.domElement.removeEventListener('pointerup', pointerUp);
    };
  }
  get mode() {
    return useUI.getState().mode;
  }
  private setMode(mode: Mode) {
    this.playbackRevision++;
    this.last = performance.now();
    this.accumulator = 0;
    this.keys.clear();
    if (mode === 'paused') this.episode.pause();
    else if (mode === 'running') this.episode.resume();
    useUI.setState({ mode });
    this.publish();
  }
  private async createView(
    config: Config,
    teacher = false,
    policy?: PolicySession,
  ): Promise<WorldView> {
    let frames: FramePipeline | undefined;
    const episode = await EpisodeClient.create(
      config,
      policy
        ? {
            kind: 'client',
            name: 'external-policy',
            create: (sim, applied) =>
              new ExternalPolicySource(sim, policy, (tick) => frames!.sample(tick), applied),
          }
        : teacher
          ? { kind: 'teacher' }
          : { kind: 'manual', keys: this.keys },
    );
    let scene: WorldScene | undefined;
    try {
      scene = new WorldScene(episode.sim, config.appearance.theme, config.camera.head.pitch);
      const sensor = new SensorCamera(scene, config.camera);
      if (policy)
        frames = new FramePipeline(
          sensor,
          { physicsHz: config.environment.physicsHz, observationHz: config.run.observationHz },
          { png: true },
        );
      return { episode, scene, sensor, frames };
    } catch (error) {
      scene?.dispose();
      episode.dispose();
      throw error;
    }
  }
  private currentView(): WorldView {
    return { episode: this.episode, scene: this.scene, sensor: this.sensor, frames: this.frames };
  }
  private disposeView(view: WorldView) {
    view.frames?.dispose();
    view.sensor.dispose();
    view.scene.dispose();
    view.episode.dispose();
  }
  private activate(view: WorldView, config: Config) {
    this.overlay?.dispose();
    this.episode = view.episode;
    this.scene = view.scene;
    this.sensor = view.sensor;
    this.frames = view.frames;
    this.updateHeadView(config);
    this.overlay = new JointOverlay(this.scene, this.renderer.domElement.parentElement!);
    this.overlay.labels.setSize(
      this.renderer.domElement.clientWidth,
      this.renderer.domElement.clientHeight,
    );
    this.overlay.setMarkers(useUI.getState().markers);
    this.overlay.setAnnotations(
      useUI.getState().annotations && useUI.getState().viewport === 'orbit',
    );
    this.accumulator = 0;
    this.keys.clear();
    this.lastPreview = -1;
    this.dirty = true;
    useUI.setState({ previewConfig: structuredClone(config) });
  }
  private async rebuild(config: Config, teacher: boolean, start = teacher) {
    config = this.instructionConfig(config);
    const revision = ++this.viewRevision;
    const previousMode = this.mode;
    if (this.episode) this.setMode('resetting');
    try {
      const next = await this.createView(config, teacher);
      if (revision !== this.viewRevision || this.disposed) {
        this.disposeView(next);
        return;
      }
      const old = this.episode ? this.currentView() : undefined;
      this.activate(next, config);
      if (old) this.disposeView(old);
      this.config = structuredClone(config);
      useUI.setState({ config: structuredClone(config), error: '' });
      this.setMode(start ? 'running' : 'idle');
    } catch (error) {
      if (this.episode) this.setMode(previousMode);
      throw error;
    }
  }
  private instructionConfig(config: Config) {
    return resolveConfig(config, {
      task: { language: i18n.resolvedLanguage === 'zh' ? 'zh' : 'en' },
    });
  }
  setViewport(viewport: Viewport) {
    const state = useUI.getState();
    if (
      !permissions(this.mode, state.telemetry.teacher, state.policyStatus).view ||
      !['orbit', 'head'].includes(viewport)
    )
      return false;
    useUI.setState({ viewport });
    return true;
  }
  private updateHeadView(config: Config) {
    this.headView.copy(
      makeCamera(
        { ...config.camera, mount: 'head' },
        this.scene.sim.config.environment,
        this.scene.sim.body.transform(),
      ),
    );
    this.headView.aspect = this.camera.aspect;
    this.headView.updateProjectionMatrix();
  }
  openSettings() {
    const state = useUI.getState();
    const allowed = permissions(this.mode, state.telemetry.teacher, state.policyStatus);
    if (!allowed.viewSettings) return false;
    if (allowed.edit) return this.beginEdit();
    useUI.setState({
      settingsViewOpen: true,
      policyOpen: false,
      shortcutsOpen: false,
      draftSceneSeed: state.sceneSeed,
      draftError: '',
    });
    return true;
  }
  closeSettings() {
    if (this.mode === 'editing') return this.cancelEdit();
    useUI.setState({ settingsViewOpen: false, draftError: '' });
    return true;
  }
  async beginEdit() {
    if (
      !permissions(this.mode, this.episode.source.kind === 'teacher', useUI.getState().policyStatus)
        .edit
    )
      return false;
    const originalMode = this.mode as 'idle' | 'finished';
    try {
      // A pristine idle scene can be displayed until the first draft edit needs isolation.
      if (this.episode.sim.ticks !== 0) this.setMode('resetting');
      const preview = this.episode.sim.ticks === 0 ? undefined : await this.createView(this.config);
      this.edit.begin(this.currentView(), originalMode, this.config, this.sceneRequest);
      if (preview) this.activate(preview, this.config);
      this.setMode('editing');
      return true;
    } catch (error) {
      this.setMode(originalMode);
      useUI.setState({ error: String(error) });
      return false;
    }
  }
  async selectTask(selection: TaskPreset) {
    const state = useUI.getState();
    const allowed = permissions(this.mode, state.telemetry.teacher, state.policyStatus);
    if (this.stepping || this.pending || !allowed.edit || !TASK_PRESETS.includes(selection))
      return false;
    try {
      const seed = state.sceneSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];
      const config = resolveConfig(this.config, presetPatch(selection, seed), { run: { seed } });
      if (state.policyStatus === 'bound') assertCompatible(this.policy!.manifest.profile, config);
      await this.rebuild(config, false);
      this.sceneRequest = generationForPreset(selection, config.scene.objects.length);
      useUI.setState({
        settingsViewOpen: false,
        policyOpen: false,
        shortcutsOpen: false,
        draftError: '',
      });
      return true;
    } catch (error) {
      useUI.setState({ error: String(error) });
      return false;
    }
  }
  updateDraft(patch: DeepPartial<Config>) {
    return this.edit.updateDraft(patch, this.config, this.policy);
  }
  updateSceneSeed(seed: number | null) {
    const state = useUI.getState();
    if (this.mode === 'editing') {
      useUI.setState({ draftSceneSeed: seed });
      const resolvedSeed = seed ?? state.draft!.run.seed;
      return this.updateDraft({
        ...scenePatch(state.draft!, resolvedSeed, this.edit.draftSceneRequest!),
        run: { seed: resolvedSeed },
      });
    }
    if (
      !state.settingsViewOpen ||
      state.policyStatus !== 'bound' ||
      !permissions(this.mode, state.telemetry.teacher, state.policyStatus).shuffle
    )
      return false;
    useUI.setState({ draftSceneSeed: seed });
    try {
      resolveConfig(this.config, { run: { seed: seed ?? this.config.run.seed } });
      useUI.setState({ draftError: '' });
      return true;
    } catch (error) {
      useUI.setState({ draftError: String(error).replace(/^Error: /, '') });
      return false;
    }
  }
  async applySceneSeed() {
    const state = useUI.getState();
    if (
      !state.settingsViewOpen ||
      state.policyStatus !== 'bound' ||
      !permissions(this.mode, state.telemetry.teacher, state.policyStatus).shuffle ||
      this.stepping
    )
      return false;
    try {
      const config = resolveConfig(this.config, {
        run: { seed: state.draftSceneSeed ?? crypto.getRandomValues(new Uint32Array(1))[0] },
      });
      await this.rebuild(config, false);
      useUI.setState({ sceneSeed: state.draftSceneSeed, settingsViewOpen: false, draftError: '' });
      return true;
    } catch (error) {
      useUI.setState({ draftError: String(error).replace(/^Error: /, '') });
      return false;
    }
  }
  restoreDefaults() {
    const state = useUI.getState();
    if (!['disconnected', 'bound'].includes(state.policyStatus)) return false;
    const patch = presetPatch(taskPreset(this.config), this.config.run.seed);
    if (
      !this.updateDraft(
        state.policyStatus === 'bound'
          ? patch
          : resolveConfig({ appearance: this.config.appearance }, patch),
      )
    )
      return false;
    useUI.setState({ ...DEFAULT_DISPLAY, draftSceneSeed: null });
    return true;
  }
  setTheme(id: string) {
    const state = useUI.getState();
    if (
      !permissions(this.mode, state.telemetry.teacher, state.policyStatus).theme ||
      this.stepping ||
      this.pending
    )
      return false;
    try {
      validateTheme(id);
      if (id === this.config.appearance.theme) return true;
      this.scene.setTheme(id);
      if (this.mode === 'idle') this.episode.setAppearance(id);
      this.config = { ...this.config, appearance: { theme: id } };
      useUI.setState({
        config: structuredClone(this.config),
        previewConfig: structuredClone(this.config),
        error: '',
      });
      this.lastPreview = -1;
      this.dirty = true;
      return true;
    } catch (error) {
      useUI.setState({ error: String(error) });
      return false;
    }
  }
  private async previewDraft(config: Config) {
    const revision = ++this.viewRevision;
    const previous = useUI.getState().previewConfig;
    const worldChanged =
      JSON.stringify([previous.environment, previous.scene, previous.task, previous.run.seed]) !==
      JSON.stringify([config.environment, config.scene, config.task, config.run.seed]);
    const opticsChanged = previous.camera.head.pitch !== config.camera.head.pitch;
    if (worldChanged || opticsChanged || this.episode === this.edit.saved!.view.episode) {
      const next = await this.createView(config);
      if (revision !== this.viewRevision || this.mode !== 'editing' || this.disposed) {
        this.disposeView(next);
        return;
      }
      const old = this.currentView();
      this.activate(next, config);
      if (old.episode !== this.edit.saved!.view.episode) this.disposeView(old);
    } else {
      const a = previous.camera,
        b = config.camera;
      if (a.width !== b.width || a.heightPixels !== b.heightPixels || a.depth !== b.depth) {
        const sensor = new SensorCamera(this.scene, b);
        this.sensor.dispose();
        this.sensor = sensor;
      } else this.sensor.rebind(this.scene, b);
      this.updateHeadView(config);
      this.lastPreview = -1;
      this.dirty = true;
      useUI.setState({ previewConfig: structuredClone(config) });
    }
    useUI.setState({ draftError: '' });
    this.publish();
  }
  async applyEdit() {
    const state = useUI.getState();
    if (this.mode !== 'editing' || !state.draft || !this.edit.saved) return false;
    this.edit.pendingPreview = undefined;
    const revision = ++this.viewRevision;
    try {
      if (state.policyStatus === 'bound')
        assertCompatible(this.policy!.manifest.profile, state.draft);
      // Build successfully before committing or releasing the previous scene.
      const config = this.instructionConfig(this.edit.resolve(state.draft, state.draftSceneSeed));
      this.setMode('resetting');
      const next = await this.createView(config);
      if (revision !== this.viewRevision || this.disposed) {
        this.disposeView(next);
        return false;
      }
      const preview = this.currentView(),
        original = this.edit.saved.view;
      this.activate(next, config);
      if (preview.episode !== original.episode) this.disposeView(preview);
      this.disposeView(original);
      this.config = structuredClone(config);
      this.sceneRequest = this.edit.commit(config, state.draftSceneSeed);
      this.setMode('idle');
      return true;
    } catch (error) {
      this.setMode('editing');
      useUI.setState({ draftError: String(error).replace(/^Error: /, '') });
      return false;
    }
  }
  cancelEdit() {
    if (this.mode !== 'editing' || !this.edit.saved) return false;
    ++this.viewRevision;
    const saved = this.edit.cancel(),
      preview = this.currentView();
    if (preview.episode !== saved.view.episode) {
      this.activate(saved.view, this.config);
      this.disposeView(preview);
    }
    this.setMode(saved.mode);
    return true;
  }
  request(config = this.config, teacher = false, start = teacher) {
    const allowed = permissions(
      this.mode,
      this.episode.source.kind === 'teacher',
      useUI.getState().policyStatus,
    );
    if (
      !allowed.reset ||
      ((teacher || start) && !allowed.edit) ||
      (JSON.stringify(config) !== JSON.stringify(this.config) && !allowed.edit)
    )
      return false;
    if (useUI.getState().policyStatus === 'bound') {
      if (teacher || start || JSON.stringify(config) !== JSON.stringify(this.config)) return false;
      void this.resetPolicy();
      return true;
    }
    const resolved = this.instructionConfig(resolveConfig(config)),
      fallback = this.mode === 'running' ? 'paused' : this.mode;
    if (this.stepping) this.episode.finish('stopped', 'Reset requested');
    this.pending = { config: resolved, teacher, start, fallback };
    this.setMode('resetting');
    return true;
  }
  async toggle() {
    const policyStatus = useUI.getState().policyStatus;
    if (!permissions(this.mode, this.episode.source.kind === 'teacher', policyStatus).play)
      return false;
    if (policyStatus === 'bound' && (this.mode === 'idle' || this.mode === 'finished')) {
      if (this.stepping) return false;
      try {
        const config = this.instructionConfig(this.config);
        assertCompatible(this.policy!.manifest.profile, config);
        this.setMode('resetting');
        const next = await this.createView(config, false, this.policy),
          old = this.currentView();
        this.activate(next, config);
        this.disposeView(old);
        this.config = structuredClone(config);
        useUI.setState({ config: structuredClone(config) });
        this.setMode('running');
        return true;
      } catch (e) {
        this.policyFault(e);
        return false;
      }
    }
    if (this.mode === 'finished') return this.request(this.config, false, true);
    if (
      this.mode === 'idle' &&
      this.instructionConfig(this.config).task.language !== this.config.task.language
    )
      return this.request(this.config, false, true);
    if (
      !permissions(this.mode, this.episode.source.kind === 'teacher', useUI.getState().policyStatus)
        .play ||
      this.episode.result
    )
      return false;
    this.setMode(this.mode === 'running' ? 'paused' : 'running');
    return true;
  }
  teacher() {
    if (
      !permissions(this.mode, this.episode.source.kind === 'teacher', useUI.getState().policyStatus)
        .teacher
    )
      return false;
    if (this.mode === 'idle' || this.mode === 'finished') return this.request(this.config, true);
    this.episode.finish('stopped', 'user stopped teacher');
    this.setMode('finished');
    return true;
  }
  setTeacherRate(rate: number) {
    if (
      !permissions(this.mode, this.episode.source.kind === 'teacher', useUI.getState().policyStatus)
        .rate ||
      !TEACHER_RATES.includes(rate as TeacherRate)
    )
      return false;
    useUI.setState({ teacherRate: rate as TeacherRate });
    return true;
  }
  async shuffle() {
    if (
      !permissions(this.mode, this.episode.source.kind === 'teacher', useUI.getState().policyStatus)
        .shuffle ||
      this.stepping
    )
      return false;
    try {
      const seed = useUI.getState().sceneSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];
      const config = resolveConfig(this.config, {
        ...scenePatch(this.config, seed, this.sceneRequest),
        run: { seed },
      });
      await this.rebuild(config, false);
      return true;
    } catch (error) {
      useUI.setState({ error: String(error) });
      return false;
    }
  }
  connectPolicy(options: ConnectionOptions) {
    return this.connection.connect(options, this.config, Boolean(this.stepping));
  }
  bindPolicy() {
    return this.connection.bind(
      this.config,
      (config) => this.instructionConfig(config),
      (config) => this.createView(config),
      (candidate, config) => {
        const old = this.currentView();
        this.activate(candidate, config);
        this.disposeView(old);
        this.config = config;
        this.setMode('idle');
      },
      (view) => this.disposeView(view),
    );
  }
  private policyFault(error: unknown) {
    if (this.disposed) return;
    this.policy?.close();
    if (this.episode.source.kind === 'client' && !this.episode.result)
      this.episode.finish('stopped', 'Policy connection failed');
    useUI.setState({ policyStatus: 'fault', error: String(error) });
    if (this.mode === 'running' || this.mode === 'paused' || this.mode === 'resetting')
      this.setMode('finished');
  }
  private async resetPolicy() {
    const episode = this.episode;
    useUI.setState({ policyStatus: 'draining' });
    this.setMode('resetting');
    episode.finish('stopped', 'Policy reset requested');
    try {
      await episode.settled();
      await this.stepping;
      if (this.disposed || useUI.getState().policyStatus !== 'draining') return;
      await this.rebuild(this.config, false);
      useUI.setState({ policyStatus: 'bound' });
    } catch (error) {
      this.policyFault(error);
    }
  }
  async disconnectPolicy() {
    if (
      ['connecting', 'binding', 'draining', 'disconnected'].includes(useUI.getState().policyStatus)
    )
      return false;

    useUI.setState({ policyStatus: 'draining' });
    this.connection.close();
    if (this.episode.source.kind === 'client' && !this.episode.result)
      this.episode.finish('stopped', 'Policy disconnected');
    await this.stepping;
    if (this.disposed) return false;
    await this.rebuild(this.config, false);
    useUI.setState({
      policyStatus: 'disconnected',
      policyManifest: null,
      policyDiff: [],
      error: '',
    });
    return true;
  }
  private pump() {
    const episode = this.episode,
      revision = this.playbackRevision;
    this.workDeadline = performance.now() + 8;
    this.stepping = (async () => {
      try {
        while (
          this.accumulator >= episode.sim.dt &&
          !episode.result &&
          this.mode === 'running' &&
          revision === this.playbackRevision &&
          !this.disposed
        ) {
          if (episode.source.kind === 'teacher') {
            const ticks = Math.floor(this.accumulator / episode.sim.dt);
            this.accumulator -= ticks * episode.sim.dt;
            const advanced = await episode.advance(ticks);
            if (this.mode === 'running' && revision === this.playbackRevision)
              this.accumulator += (ticks - advanced) * episode.sim.dt;
          } else {
            this.accumulator -= episode.sim.dt;
            await episode.step();
          }
          this.dirty = true;
          // Host teacher batches yield through RPC and own their work budget.
          if (!(episode.source.kind === 'teacher') && performance.now() >= this.workDeadline) break;
        }
        if (
          episode.result &&
          episode.source.kind === 'client' &&
          useUI.getState().policyStatus === 'bound'
        ) {
          useUI.setState({ policyStatus: 'draining' });
          this.setMode('finished');
          await episode.settled();
          if (useUI.getState().policyStatus === 'draining')
            useUI.setState({ policyStatus: 'bound' });
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'CANCELLED') return;
        if (episode.source.kind === 'client') this.policyFault(error);
        else {
          if (this.mode === 'running') this.setMode('paused');
          useUI.setState({ error: String(error) });
        }
      }
    })().finally(() => {
      this.stepping = undefined;
      if (this.disposed && !this.busy) this.release();
    });
  }
  subscribePreview(listener: (preview: Preview) => void) {
    this.listeners.add(listener);
    if (this.latest) listener(this.latest);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish() {
    const episode = this.episode,
      result = episode.result;
    useUI.setState({
      telemetry: {
        teacher: episode.source.kind === 'teacher',
        time: episode.sim.time,
        state: episode.sim.state(),
        target: episode.sim.targetState(),
        phase:
          !result && episode.phase === 'success'
            ? episode.score.task.mode === 'deadline'
              ? 'waiting'
              : 'verify'
            : episode.phase,
        stacked: episode.score.evaluation.completed,
        heightMeters: episode.score.evaluation.heightMeters,
        heightTask: episode.config.task.kind === 'max-height',
        total: episode.score.evaluation.total,
        status:
          this.mode === 'editing' || this.mode === 'resetting'
            ? this.mode
            : (result?.outcome ?? this.mode),
      },
    });
    if (
      result &&
      result.outcome !== 'success' &&
      result.outcome !== 'completed' &&
      result.outcome !== 'stopped'
    )
      useUI.setState({ error: result.reason });
  }
  private frame = async (now: number) => {
    if (this.disposed) return;
    this.busy = true;
    try {
      if (this.pending && !this.stepping) {
        const next = this.pending;
        this.pending = undefined;
        try {
          await this.rebuild(next.config, next.teacher, next.start);
        } catch (error) {
          this.setMode(next.fallback);
          throw error;
        }
      }
      if (this.mode === 'editing' && this.edit.pendingPreview) {
        const config = this.edit.pendingPreview;
        this.edit.pendingPreview = undefined;
        try {
          await this.previewDraft(config);
        } catch (error) {
          useUI.setState({ draftError: String(error).replace(/^Error: /, '') });
        }
      }
      // A rebuild can start playback after this RAF timestamp; retain the newer clock anchor.
      const elapsed = Math.max(0, (now - this.last) / 1000),
        dt = Math.min(elapsed, 0.1);
      this.last = Math.max(this.last, now);
      const tick = this.episode.sim.ticks;
      if (this.mode === 'running') {
        const rate = this.episode.source.kind === 'teacher' ? useUI.getState().teacherRate : 1;
        // Speed changes wall-time pacing only. Every fixed physics tick still runs through EpisodeClient.
        if (this.episode.source.kind === 'teacher') this.accumulator += elapsed * rate;
        else if (this.episode.source.kind !== 'client' || !this.stepping)
          this.accumulator = Math.min(this.accumulator + dt * rate, 0.15 * rate);
        if (!this.stepping && !this.episode.result && this.accumulator >= this.episode.sim.dt)
          this.pump();
      }
      if (this.disposed) return;
      if (this.episode.result && (this.mode === 'running' || this.mode === 'paused'))
        this.setMode('finished');
      if (useUI.getState().viewport === 'orbit') this.orbit.update();
      this.scene.sync();
      this.updateHeadView(this.config);
      const view = useUI.getState().viewport === 'head' ? this.headView : this.camera;
      this.dirty = this.overlay.update(view, dt) || this.dirty || tick !== this.episode.sim.ticks;
      if (this.dirty) {
        this.scene.render(this.renderer, view);
        this.dirty = false;
      }
      if (
        this.lastPreview < 0 ||
        (this.listeners.size &&
          this.episode.sim.ticks !== this.lastPreview &&
          now - this.lastCapture > 100)
      ) {
        this.latest = {
          frame: this.sensor.capture(),
          width: this.sensor.config.width,
          height: this.sensor.config.heightPixels,
        };
        this.listeners.forEach((listener) => listener(this.latest!));
        this.lastPreview = this.episode.sim.ticks;
        this.lastCapture = now;
      }
      if (now - this.lastTelemetry > 100) {
        this.publish();
        this.lastTelemetry = now;
      }
    } catch (error) {
      if (this.mode === 'running') this.setMode('paused');
      useUI.setState({ error: String(error) });
      this.publish();
    } finally {
      this.busy = false;
      if (this.disposed && !this.stepping) this.release();
      else this.raf = requestAnimationFrame(this.frame);
    }
  };
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cleanup();
    this.resize.disconnect();
    this.policy?.close();
    this.episode.finish('stopped', 'Runtime disposed');
    if (!this.busy && !this.stepping) this.release();
  }
  private release() {
    this.overlay.dispose();
    this.disposeView(this.currentView());
    if (this.edit.saved && this.edit.saved.view.episode !== this.episode)
      this.disposeView(this.edit.saved.view);
    this.orbit.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.listeners.clear();
  }
}
