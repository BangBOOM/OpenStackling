import { PolicySession, type ConnectionOptions } from '../../runtime/policy/session';
import { configForProfile, configurationDiff, profileConfig } from '../../runtime/policy/contract';
import type { Config } from '../../runtime/config';
import { useUI } from './store';

export class PolicyConnection<V> {
  session?: PolicySession;
  constructor(
    private disposed: () => boolean,
    private fault: (error: unknown) => void,
  ) {}
  async connect(options: ConnectionOptions, config: Config, stepping: boolean) {
    if (
      !['idle', 'finished'].includes(useUI.getState().mode) ||
      useUI.getState().policyStatus !== 'disconnected' ||
      stepping
    )
      return false;
    useUI.setState({ policyStatus: 'connecting', error: '' });
    try {
      const session = await PolicySession.connect(options);
      if (this.disposed()) {
        session.close();
        return false;
      }
      this.session = session;
      session.onFault = (error) => this.fault(error);
      useUI.setState({
        policyStatus: 'review',
        policyManifest: session.manifest,
        policyDiff: configurationDiff(profileConfig(config), session.manifest.profile.config),
      });
      return true;
    } catch (error) {
      useUI.setState({ policyStatus: 'disconnected', error: String(error) });
      return false;
    }
  }
  async bind(
    current: Config,
    instructionConfig: (config: Config) => Config,
    createView: (config: Config) => Promise<V>,
    commit: (candidate: V, config: Config) => void,
    disposeView: (view: V) => void,
  ) {
    if (
      useUI.getState().policyStatus !== 'review' ||
      !this.session ||
      !['idle', 'finished'].includes(useUI.getState().mode)
    )
      return false;
    useUI.setState({ policyStatus: 'binding', error: '' });
    let candidate: V | undefined;
    try {
      const config = instructionConfig(configForProfile(this.session.manifest.profile, current));
      candidate = await createView(config);
      await this.session.bind(config);
      commit(candidate, config);
      candidate = undefined;
      useUI.setState({ config: structuredClone(config), policyStatus: 'bound', policyDiff: [] });
      return true;
    } catch (error) {
      if (candidate) disposeView(candidate);
      this.fault(error);
      return false;
    }
  }
  close() {
    const session = this.session;
    this.session = undefined;
    session?.close();
  }
}
