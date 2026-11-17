import { merge, resolveConfig, type DeepPartial, type Config } from '../../runtime/config';
import { scenePatch, type SceneRequest } from '../../simulation/scene';
import { assertCompatible } from '../../runtime/policy/contract';
import type { PolicySession } from '../../runtime/policy/session';
import { useUI, type Viewport } from './store';

export class ConfigEdit<V> {
  draftSceneRequest?: SceneRequest;
  saved?: {
    view: V;
    mode: 'idle' | 'finished';
    markers: boolean;
    annotations: boolean;
    viewport: Viewport;
    error: string;
  };
  pendingPreview?: Config;
  begin(view: V, originalMode: 'idle' | 'finished', config: Config, sceneRequest: SceneRequest) {
    const state = useUI.getState();
    this.draftSceneRequest = structuredClone(sceneRequest);
    this.saved = {
      view: view,
      mode: originalMode,
      markers: state.markers,
      annotations: state.annotations,
      viewport: state.viewport,
      error: state.error,
    };
    useUI.setState({
      draft: structuredClone(config),
      draftError: '',
      error: '',
      shortcutsOpen: false,
      policyOpen: false,
      settingsViewOpen: false,
      draftSceneSeed: state.sceneSeed,
    });
  }
  updateDraft(patch: DeepPartial<Config>, config: Config, policy?: PolicySession) {
    const state = useUI.getState();
    if (state.mode !== 'editing' || !state.draft) return false;
    if (patch.appearance && patch.appearance.theme !== config.appearance.theme) return false;
    const draft = merge(state.draft, patch);
    const generation = this.draftSceneRequest!;
    if (patch.scene?.objects && generation.kind !== 'fixed')
      this.draftSceneRequest = { ...generation, count: patch.scene.objects.length };
    if (state.policyStatus === 'bound') {
      try {
        assertCompatible(policy!.manifest.profile, draft);
      } catch (error) {
        useUI.setState({ draftError: String(error) });
        return false;
      }
    }
    useUI.setState({ draft });
    this.pendingPreview = undefined;
    try {
      this.pendingPreview = resolveConfig(draft);
      useUI.setState({ draftError: '' });
      return true;
    } catch (error) {
      useUI.setState({ draftError: String(error).replace(/^Error: /, '') });
      return false;
    }
  }
  resolve(draft: Config, sceneSeed: number | null) {
    const seed = sceneSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];
    return resolveConfig(draft, {
      ...scenePatch(draft, seed, this.draftSceneRequest!),
      run: { seed },
    });
  }
  commit(config: Config, sceneSeed: number | null) {
    this.saved = undefined;
    const generation = this.draftSceneRequest!;
    this.draftSceneRequest = undefined;
    useUI.setState({
      config: structuredClone(config),
      sceneSeed: sceneSeed,
      draft: null,
      draftError: '',
      error: '',
    });
    return generation;
  }
  cancel() {
    this.draftSceneRequest = undefined;
    const saved = this.saved!;
    this.pendingPreview = undefined;
    this.saved = undefined;
    useUI.setState({
      markers: saved.markers,
      annotations: saved.annotations,
      viewport: saved.viewport,
      draft: null,
      draftError: '',
      error: saved.error,
    });
    return saved;
  }
}
