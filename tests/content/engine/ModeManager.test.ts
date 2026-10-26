import { afterEach, expect, it, vi } from "vitest";
import { ModeManager } from "../../../src/content/engine/ModeManager";
import type { AnnotationController } from "../../../src/content/engine/AnnotationController";
import { createView } from "../../../src/content/view-lite";
import { DEFAULT_SETTINGS } from "../../../src/core/model";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("leaves image selection without entering drawing when there is no current image rebind", () => {
  const view = createView();
  const engine = { view, settings: DEFAULT_SETTINGS, render: { imageLayers: { supports: () => true }, schedulePaint: () => {} } } as unknown as AnnotationController;
  const mode = new ModeManager(engine);
  mode.mode = "choose-image";
  view.drawing.style.display = "flex";
  mode.chooseImage(document.createElement("img"));
  expect(mode.mode).toBe("idle");
  expect(view.drawing.style.display).toBe("none");
  expect(view.svg.style.pointerEvents).toBe("none");
  expect(mode.selectedImage).toBeUndefined();
});
