import { afterEach, expect, it, vi } from "vitest";
import { UIController, type UIControllerHost } from "../../../src/content/engine/UIController";
import { createView } from "../../../src/content/view-lite";
import { DEFAULT_SETTINGS } from "../../../src/core/model";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("leaves image selection without entering drawing when there is no current image rebind", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const view = createView();
  const engine = {
    view, settings: DEFAULT_SETTINGS, disposed: false,
    data: { schedulePaint: () => {}, imageLayers: { supports: () => true } },
  } as unknown as UIControllerHost;
  const mode = new UIController(engine);
  mode.mode = "choose-image";
  view.drawing.style.display = "flex";
  mode.chooseImage(document.createElement("img"));
  expect(mode.mode).toBe("idle");
  expect(view.drawing.style.display).toBe("none");
  expect(view.svg.style.pointerEvents).toBe("none");
  expect(mode.selectedImage).toBeUndefined();
});
