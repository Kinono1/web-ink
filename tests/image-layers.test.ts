import { describe, expect, it } from "vitest";
import type { ImageAnnotation } from "../src/core/model";
import { ImageLayerManager } from "../src/content/image-layers";

function imageFixture(): { image: HTMLImageElement; svg: SVGSVGElement } {
  document.body.innerHTML =
    '<div id="clip" style="overflow-x:hidden;overflow-y:hidden"><img id="image"></div>';
  const image = document.querySelector("#image") as HTMLImageElement;
  const parent = document.querySelector("#clip") as HTMLDivElement;
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 400 },
    naturalHeight: { configurable: true, value: 200 },
  });
  image.getBoundingClientRect = () => new DOMRect(10, 20, 200, 100);
  parent.getBoundingClientRect = () => new DOMRect(20, 30, 100, 50);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  document.body.append(svg);
  return { image, svg };
}

function annotation(): ImageAnnotation {
  return {
    id: "image-1",
    pageUrl: "https://example.test/article",
    pageTitle: "Example",
    color: "#facc15",
    note: "",
    tags: [],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    revision: 1,
    kind: "image",
    target: {
      src: "https://example.test/image.png",
      sourceCandidates: ["https://example.test/image.png"],
      alt: "example",
      naturalWidth: 400,
      naturalHeight: 200,
      selector: "img#image",
      occurrence: 0,
      context: "",
    },
    shape: {
      kind: "rectangle",
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.8, y: 0.8 },
      ],
      width: 0.02,
    },
  };
}

describe("ImageLayerManager", () => {
  it("clips, caches, hides, reconciles, and clears persistent SVG layers", () => {
    const { image, svg } = imageFixture();
    const manager = new ImageLayerManager(svg);
    const record = annotation();
    expect(manager.clippedGeometry(image)?.clipRect).toMatchObject({
      x: 20,
      y: 30,
      width: 100,
      height: 50,
    });

    manager.draw(record, image, record.id);
    const group = svg.querySelector(
      '[data-annotation-id="image-1"]',
    ) as SVGGElement;
    expect(group).toBeTruthy();
    expect(manager.shapeFor(record.id)).toBeTruthy();
    expect(manager.shapeFor(record.id)?.getAttribute("opacity")).toBe("0.6");

    manager.hide(record.id);
    expect(group.style.display).toBe("none");
    manager.draw(record, image);
    expect(group.style.display).toBe("");
    expect(manager.shapeFor(record.id)?.getAttribute("opacity")).toBeNull();

    manager.reconcile(new Set());
    expect(svg.querySelector('[data-annotation-id="image-1"]')).toBeNull();
    expect(manager.shapeFor(record.id)).toBeUndefined();

    manager.draw(record, image);
    manager.clear();
    expect(svg.childElementCount).toBe(0);
  });

  it("calculates shared image geometry once per paint frame", () => {
    const { image, svg } = imageFixture();
    const manager = new ImageLayerManager(svg);
    const record = annotation();
    let imageRectReads = 0;
    image.getBoundingClientRect = () => {
      imageRectReads++;
      return new DOMRect(10, 20, 200, 100);
    };

    manager.beginPaint();
    manager.draw(record, image);
    manager.draw({ ...record, id: "image-2" }, image);
    expect(imageRectReads).toBe(1);

    manager.beginPaint();
    manager.draw(record, image);
    expect(imageRectReads).toBe(2);
  });
});
