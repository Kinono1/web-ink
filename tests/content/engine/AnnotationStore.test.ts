import { afterEach, expect, it } from "vitest";
import { DataEngine, type DataEngineHost } from "../../../src/content/engine/DataEngine";
import { createView } from "../../../src/content/view-lite";
import type { ImageAnnotation } from "../../../src/core/model";

const image = (revision: number): ImageAnnotation => ({
  id: "image-one", revision, kind: "image", color: "#ffff00", pageUrl: location.href,
  pageTitle: "Test", note: "", tags: [], createdAt: "2026-10-26", updatedAt: "2026-10-26",
  target: { src: "https://example.test/image.png", sourceCandidates: ["https://example.test/image.png"], alt: "", naturalWidth: 100, naturalHeight: 100, selector: "img", occurrence: 0, context: "" },
  shape: { kind: "rectangle", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], width: .01 },
});
afterEach(() => { document.body.replaceChildren(); });
it("keeps a delete tombstone against an older delivery and admits a newer restoration", () => {
  const engine = {
    enabled: () => true, currentUrl: location.href, disposed: true,
    view: createView(), ui: { actionRecords: [] },
  } as unknown as DataEngineHost;
  const store = new DataEngine(engine);
  // State publication is the Chrome boundary; the state/revision logic stays real.
  store.publishStates = () => {};
  store.prepareRestore([image(3)]);
  store.applyAnnotationDelta(undefined, "image-one", location.href);
  expect(store.annotations).toEqual([]);
  store.applyAnnotationDelta(image(3), undefined, location.href);
  expect(store.annotations).toEqual([]);
  store.applyAnnotationDelta(image(4), undefined, location.href);
  expect(store.annotations.map(record => record.revision)).toEqual([4]);
  store.prepareRestore([image(4)]);
  expect(store.annotations.map(record => record.revision)).toEqual([4]);
});

it("ignores changes from another page and duplicate revisions", () => {
  const engine = {
    enabled: () => true, currentUrl: location.href, disposed: true, view: createView(),
  } as unknown as DataEngineHost;
  const store = new DataEngine(engine);
  store.prepareRestore([image(3)]);
  store.applyAnnotationDelta({ ...image(4), pageUrl: "https://elsewhere.test/" });
  store.applyAnnotationDelta(image(3));
  expect(store.annotations.map(record => record.revision)).toEqual([3]);
});
