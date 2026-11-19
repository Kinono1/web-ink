import { afterEach, expect, it, vi } from "vitest";
import { UIController, type UIControllerHost } from "../../../src/content/engine/UIController";
import { createView } from "../../../src/content/view-lite";
import { DEFAULT_SETTINGS, type ImageAnnotation } from "../../../src/core/model";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("leaves image selection without entering drawing when there is no current image rebind", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const view = createView();
  const commit = vi.fn();
  const engine = {
    view, settings: DEFAULT_SETTINGS, disposed: false,
    data: { commit },
  } as unknown as UIControllerHost;
  const mode = new UIController(engine);
  mode.mode = "choose-image";
  view.drawing.style.display = "flex";
  mode.chooseImage(document.createElement("img"));
  expect(mode.mode).toBe("idle");
  expect(view.drawing.style.display).toBe("none");
  expect(view.svg.style.pointerEvents).toBe("none");
  expect(commit).not.toHaveBeenCalled();
});

it("rebinds a saved image without changing its shape, note or revision", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const view = createView();
  const commit = vi.fn(async () => {});
  const toast = vi.fn();
  const mode = new UIController({
    view, settings: DEFAULT_SETTINGS, disposed: false, enabled: () => true,
    label: (_chinese: string, english: string) => english,
    data: { commit, imageLayers: { supports: (image: HTMLImageElement) => image.naturalWidth > 0 } },
    toast,
  } as unknown as UIControllerHost);
  const image = document.createElement("img");
  image.src = "https://example.test/replacement.png";
  image.alt = "Replacement";
  document.body.append(image);
  const original: ImageAnnotation = {
    id: "saved-image", revision: 7, kind: "image", note: "Keep this",
    pageUrl: location.href, pageTitle: "Image page", color: "#facc15", tags: [],
    createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z",
    target: { src: "https://example.test/old.png", sourceCandidates: [], alt: "", naturalWidth: 120,
      naturalHeight: 120, selector: "img", occurrence: 0, context: "" },
    shape: { kind: "rectangle", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], width: 0.01 },
  };
  mode.rebinding = original;
  mode.startImageRebind();
  expect(view.drawing.style.display).toBe("flex");
  mode.chooseImage(image);
  expect(mode.mode).toBe("choose-image");
  expect(commit).not.toHaveBeenCalled();
  expect(toast).toHaveBeenLastCalledWith(expect.stringContaining("not loaded"), true);

  view.drawing.querySelector<HTMLButtonElement>('button[aria-label="Done"]')!.click();
  expect(mode.rebinding).toBeUndefined();
  expect(mode.mode).toBe("idle");
  mode.rebinding = original;
  mode.startImageRebind();

  Object.defineProperties(image, { naturalWidth: { value: 120 }, naturalHeight: { value: 120 } });
  mode.chooseImage(image);
  expect(commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    id: original.id, shape: original.shape, note: original.note, revision: 7,
    target: expect.objectContaining({ src: image.src, alt: image.alt, naturalWidth: 120 }),
  }));
  expect(mode.mode).toBe("idle");
  expect(view.drawing.style.display).toBe("none");
});
