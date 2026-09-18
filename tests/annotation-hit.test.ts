import { afterEach, expect, it, vi } from "vitest";
import { annotationsAtPoint } from "../src/content/annotation-hit";
import type { ImageAnnotation } from "../src/core/model";

afterEach(() => vi.unstubAllGlobals());

it("passes the owning SVG's native point to legacy geometry hit-test methods", () => {
  document.body.innerHTML =
    '<img id="image"><svg><rect width="100" height="100" /></svg>';
  vi.stubGlobal("SVGGeometryElement", SVGElement);
  const image = document.querySelector("img")!;
  const svg = document.querySelector("svg")!;
  const shape = document.querySelector("rect")!;
  const inverse = {};
  const localPoint = { x: 20, y: 30 };
  const screenPoint = { x: 0, y: 0, matrixTransform: vi.fn(() => localPoint) };
  Object.defineProperty(svg, "createSVGPoint", { value: () => screenPoint });
  Object.defineProperty(shape, "getScreenCTM", {
    value: () => ({ inverse: () => inverse }),
  });
  Object.defineProperty(shape, "isPointInFill", {
    value: (point: unknown) => {
      if (point !== localPoint) throw TypeError("Expected the native SVGPoint");
      return true;
    },
  });
  const record = { id: "image-mark", kind: "image" } as ImageAnnotation;
  const matches = annotationsAtPoint(
    {
      annotations: [record],
      textRanges: new Map(),
      images: new Map([[record.id, image]]),
      imageShape: () => shape,
      geometryForImage: () => ({
        imageRect: { x: 100, y: 200, width: 100, height: 100 },
        clipRect: { x: 100, y: 200, width: 100, height: 100 },
      }),
    },
    120,
    230,
  );
  expect(matches).toEqual([record]);
  expect(screenPoint).toMatchObject({ x: 120, y: 230 });
  expect(screenPoint.matrixTransform).toHaveBeenCalledWith(inverse);
});
