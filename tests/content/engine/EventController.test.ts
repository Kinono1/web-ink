import { afterEach, expect, it, vi } from "vitest";
import { EventController } from "../../../src/content/engine/EventController";
import type { AnnotationController } from "../../../src/content/engine/AnnotationController";
import { createView } from "../../../src/content/view-lite";

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
    view: createView(), enabled: () => false,
    render: { schedulePaint: () => { paints++; } },
    mode: { onPointerDown() {}, onPointerMove() {}, onPointerUp() {}, onPointerCancel() {} },
    interactions: { onPointerDown() {}, onMouseUp() {}, onKeyDown() {}, onScroll() {}, selectedRange: undefined, hideSelection() {} },
    sync: { queueRefresh() {} },
  } as unknown as AnnotationController;
  const events = new EventController(engine);
  events.start();
  window.dispatchEvent(new Event("resize"));
  expect(paints).toBe(1);
  expect(() => events.stop()).not.toThrow();
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("scroll"));
  expect(paints).toBe(1);
});
