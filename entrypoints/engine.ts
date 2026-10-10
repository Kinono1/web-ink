import { startEngine, type ContentEngine } from "../src/content/controller";
import type { EngineBridge } from "../src/content/bootstrap";

export default defineUnlistedScript({
  main() {
    const bootstrap = window.__webInkBootstrap;
    const previous = window.__webInkEngine;
    if (
      bootstrap?.health &&
      previous?.generation === bootstrap.health.generation
    ) {
      previous.start(bootstrap.health.generation);
      return;
    }
    try {
      previous?.stop(previous.generation);
    } catch {
      // An older extension context can throw while removing its Chrome listener.
    } finally {
      if (window.__webInkEngine === previous) delete window.__webInkEngine;
    }
    if (!bootstrap?.health || !bootstrap.isEnabled()) return;
    let instance: ContentEngine | undefined;
    const bridge: EngineBridge = {
      generation: bootstrap.health.generation,
      // Legacy handlers lack the generation token and cannot mutate this engine.
      start: (generation) => {
        if (
          generation !== bridge.generation ||
          window.__webInkBootstrap !== bootstrap ||
          !bootstrap.isEnabled() ||
          instance
        )
          return;
        instance = startEngine(bootstrap.view);
      },
      stop: (generation) => {
        if (generation !== bridge.generation) return;
        try {
          instance?.stop();
        } finally {
          instance = undefined;
        }
      },
      dispatch: (
        action: "focus" | "rebind" | "draw" | "refresh",
        id?: string,
        generation?: string,
      ) => {
        if (generation === bridge.generation) instance?.dispatch(action, id);
      },
      snapshot: () =>
        instance?.snapshot() ?? {
          pageUrl: location.href,
          states: [],
          enabled: false,
        },
      canStop: (generation) =>
        generation !== bridge.generation || (instance?.canStop() ?? true),
    };
    window.__webInkEngine = bridge;
    bridge.start(bridge.generation);
  },
});
