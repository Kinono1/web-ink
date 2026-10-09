import { disposeContentRuntime, startBootstrap } from "../src/content/bootstrap";
import { request } from "../src/core/client";
import type { RuntimeHealth } from "../src/core/model";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  registration: "runtime",
  runAt: "document_idle",
  allFrames: false,
  main(ctx) {
    let invalidated = false;
    let dispose: (() => void) | undefined;
    const previous = window.__webInkBootstrap;
    let owner = previous;
    ctx.onInvalidated(() => {
      invalidated = true;
      // WXT also invalidates on a duplicate injection within a healthy runtime.
      // Let the incoming health response decide whether that owner needs replacing.
      try {
        if (chrome.runtime.id) return;
      } catch {
        // Chrome can throw while checking a context left behind by Reload.
      }
      if (window.__webInkBootstrap === owner) {
        dispose?.();
        if (window.__webInkBootstrap === owner) disposeContentRuntime();
      }
    });
    void request<RuntimeHealth>({ type: "runtime.health" })
      .then((health) => {
        if (invalidated) return;
        if (
          !health ||
          typeof health.generation !== "string" ||
          !health.generation ||
          typeof health.version !== "string" ||
          typeof health.commit !== "string" ||
          typeof health.dirty !== "boolean"
        )
          throw new Error("Invalid runtime health");
        dispose = startBootstrap(health);
        owner = window.__webInkBootstrap;
      })
      .catch(() => {
        if (!invalidated && window.__webInkBootstrap === previous)
          disposeContentRuntime();
      });
  },
});
