import { afterEach, expect, it, vi } from "vitest";
import { UIController, type UIControllerHost } from "../../../src/content/engine/UIController";
import { createView } from "../../../src/content/view-lite";
import { DEFAULT_SETTINGS } from "../../../src/core/model";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("releases DOM and Chrome storage callbacks even if extension APIs are invalidated", () => {
  let paints = 0;
  let storageListener: unknown;
  const resize = { observe() {}, disconnect() {} };
  vi.stubGlobal("ResizeObserver", class { observe = resize.observe; disconnect = resize.disconnect; });
  vi.stubGlobal("chrome", { storage: { onChanged: {
    addListener: (listener: unknown) => { storageListener = listener; },
    removeListener: (listener: unknown) => { expect(listener).toBe(storageListener); throw Error("Extension context invalidated."); },
  } } });
  const engine = {
    view: createView(), enabled: () => false, settings: DEFAULT_SETTINGS,
    data: { schedulePaint: () => { paints++; }, queueRefresh() {} },
  } as unknown as UIControllerHost;
  const events = new UIController(engine);
  events.start();
  window.dispatchEvent(new Event("resize"));
  expect(paints).toBe(1);
  expect(() => events.stop()).not.toThrow();
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("scroll"));
  expect(paints).toBe(1);
});
