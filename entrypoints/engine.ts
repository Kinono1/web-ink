import { startEngine, type ContentEngine } from '../src/content/controller';

export default defineUnlistedScript({
  main() {
    let instance: ContentEngine | undefined;
    const bridge = window.__webInkEngine ?? {
      start: () => {
        const bootstrap = window.__webInkBootstrap;
        if (!bootstrap?.isEnabled() || instance) return;
        instance = startEngine(bootstrap.view);
      },
      stop: () => { instance?.stop(); instance = undefined; },
      dispatch: (action: 'focus' | 'rebind' | 'draw' | 'refresh', id?: string) => instance?.dispatch(action, id),
      snapshot: () => instance?.snapshot() ?? { pageUrl: location.href, states: [], enabled: false },
      canStop: () => instance?.canStop() ?? true,
    };
    window.__webInkEngine = bridge;
    bridge.start();
  },
});
