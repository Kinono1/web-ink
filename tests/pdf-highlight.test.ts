import { describe, expect, it } from "vitest";
import { fromPdfRect, mergePdfTextRects, toPdfRect, type PdfViewport } from "../src/pdf/geometry";
import type { PdfRect } from "../src/core/model";

const box = [0, 0, 600, 800];
const rect = (x: number, y: number, width: number, height = 12): PdfRect =>
  ({ x: x / 600, y: y / 800, width: width / 600, height: height / 800 });

function viewport(rotation: number, scale = 1): PdfViewport {
  const transform = (x: number, y: number) =>
    rotation === 0 ? [x * scale, (800 - y) * scale]
      : rotation === 90 ? [y * scale, x * scale]
        : rotation === 180 ? [(600 - x) * scale, y * scale]
          : [(800 - y) * scale, (600 - x) * scale];
  const inverse = (x: number, y: number) =>
    rotation === 0 ? [x / scale, 800 - y / scale]
      : rotation === 90 ? [y / scale, x / scale]
        : rotation === 180 ? [600 - x / scale, y / scale]
          : [600 - y / scale, 800 - x / scale];
  return {
    width: (rotation % 180 ? 800 : 600) * scale,
    height: (rotation % 180 ? 600 : 800) * scale,
    convertToViewportPoint: transform,
    convertToPdfPoint: inverse,
  };
}

function capturedRect(x: number, y: number, width: number, height: number, view: PdfViewport): PdfRect {
  return toPdfRect({ left: x, top: y, right: x + width, bottom: y + height }, view, box)!;
}

function expectBounds(rect: PdfRect, view: PdfViewport, expected: number[]) {
  const bounds = fromPdfRect(rect, view, box);
  for (const [i, key] of (["x", "y", "width", "height"] as const).entries())
    expect(bounds[key]).toBeCloseTo(expected[i]!, 8);
}

describe("PDF text highlight geometry", () => {
  it("merges duplicate, overlapping and adjacent fragments within one text line", () => {
    const fragments = [rect(20, 100, 30), rect(20, 100, 30), rect(48, 100.5, 25), rect(74, 100, 20)];
    const merged = mergePdfTextRects(fragments, box);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.x).toBeCloseTo(20 / 600);
    expect(merged[0]?.width).toBeCloseTo(74 / 600);
    expect(merged[0]?.height).toBeCloseTo(12.5 / 800);
    expect(fragments).toHaveLength(4);
  });

  it("keeps separate lines and columns separate instead of highlighting their whitespace", () => {
    const fragments = [rect(20, 100, 30), rect(200, 100, 30), rect(20, 120, 30)];
    expect(mergePdfTextRects(fragments, box)).toHaveLength(3);
  });

  it("keeps a real formula gap instead of joining all tokens on a baseline", () => {
    expect(mergePdfTextRects([rect(20, 100, 20), rect(45, 100, 20)], box)).toHaveLength(2);
  });

  it("does not enlarge gap tolerance for large lettering or narrow table columns", () => {
    expect(mergePdfTextRects([rect(20, 100, 20, 40), rect(43, 100, 20, 40)], box)).toHaveLength(2);
  });

  it("retains superscript and subscript extents without stretching the whole formula", () => {
    const fragments = [rect(20, 100, 20), rect(41, 100, 20), rect(35, 111, 5, 6), rect(55, 96, 5, 6)];
    const merged = mergePdfTextRects(fragments, box);
    expect(merged).toHaveLength(3);
    expect(merged.some(r => Math.abs(r.width * 600 - 41) < 0.001 && Math.abs(r.height * 800 - 12) < 0.001)).toBe(true);
    expect(merged).toContainEqual(fragments[2]);
    expect(merged).toContainEqual(fragments[3]);
  });

  it("finds the original baseline when a small fragment is interleaved", () => {
    const fragments = [rect(20, 100, 20, 20), rect(35, 100.2, 5, 6), rect(41, 100.4, 20, 20)];
    expect(mergePdfTextRects(fragments, box)).toHaveLength(2);
  });

  it("does not let consecutive small vertical offsets join distinct baselines", () => {
    const fragments = Array.from({ length: 12 }, (_, i) => rect(20 + 9 * i, 100 + i, 10));
    expect(mergePdfTextRects(fragments, box).length).toBeGreaterThan(1);
  });

  it("tolerates unsorted rectangles without depending on the active zoom or rotation", () => {
    const fragments = [rect(41, 100, 20), rect(20, 100, 20)];
    expect(mergePdfTextRects(fragments, box)).toEqual(mergePdfTextRects([...fragments].reverse(), box));
  });

  for (const rotation of [0, 180]) {
    it(`keeps the original geometry path for native ${rotation} degrees`, () => {
      const fragments = [rect(20, 100, 20), rect(41, 100, 20), rect(200, 100, 20)];
      const merged = mergePdfTextRects(fragments, box, rotation);
      expect(merged).toHaveLength(2);
      expectBounds(merged[0]!, viewport(0), [20, 688, 41, 12]);
      expectBounds(merged[1]!, viewport(0), [200, 688, 20, 12]);
    });
  }

  for (const intrinsicRotation of [90, 270]) {
    describe(`native ${intrinsicRotation}-degree upright text`, () => {
      const view = viewport(intrinsicRotation);
      const capture = (x: number, y: number, width: number, height = 12) => capturedRect(x, y, width, height, view);

      it("merges duplicates, overlaps and adjacency in stored PDF coordinates without mutating inputs", () => {
        const fragments = [capture(20, 100, 30), capture(20, 100, 30), capture(48, 100.5, 25), capture(74, 100, 20)];
        const before = fragments.map(r => ({ ...r }));
        const merged = mergePdfTextRects(fragments, box, intrinsicRotation);
        expect(merged).toHaveLength(1);
        expectBounds(merged[0]!, view, [20, 100, 74, 12.5]);
        expect(fragments).toEqual(before);
      });

      it("keeps separate paragraphs and columns while merging each line", () => {
        const fragments = [capture(20, 100, 30), capture(49, 100, 25), capture(200, 100, 30),
          capture(229, 100, 25), capture(20, 160, 30), capture(49, 160, 25)];
        const merged = mergePdfTextRects(fragments, box, intrinsicRotation);
        expect(merged).toHaveLength(3);
        expectBounds(merged[0]!, view, [20, 100, 54, 12]);
        expectBounds(merged[1]!, view, [200, 100, 54, 12]);
        expectBounds(merged[2]!, view, [20, 160, 54, 12]);
      });

      it("retains superscript and subscript bounds without stretching the baseline", () => {
        const fragments = [capture(20, 100, 20), capture(41, 100, 20), capture(35, 89, 5, 6), capture(55, 110, 5, 6)];
        const merged = mergePdfTextRects(fragments, box, intrinsicRotation);
        expect(merged).toHaveLength(3);
        expectBounds(merged[0]!, view, [35, 89, 5, 6]);
        expectBounds(merged[1]!, view, [20, 100, 41, 12]);
        expectBounds(merged[2]!, view, [55, 110, 5, 6]);
      });

      it("keeps formula gaps and the one-point limit in physical page units", () => {
        expect(mergePdfTextRects([capture(20, 100, 20), capture(45, 100, 20)], box, intrinsicRotation)).toHaveLength(2);
        expect(mergePdfTextRects([capture(20, 100, 20, 40), capture(41.1, 100, 20, 40)], box, intrinsicRotation)).toHaveLength(2);
        expect(mergePdfTextRects([capture(20, 100, 20, 6), capture(40.95, 100, 20, 6)], box, intrinsicRotation)).toHaveLength(2);
        expect(mergePdfTextRects([capture(20, 100, 20), capture(40.9, 100, 20)], box, intrinsicRotation)).toHaveLength(1);
      });

      it("finds the baseline past an interleaved small fragment", () => {
        const fragments = [capture(20, 100, 20, 20), capture(35, 100.2, 5, 6), capture(41, 100.4, 20, 20)];
        const merged = mergePdfTextRects(fragments, box, intrinsicRotation);
        expect(merged).toHaveLength(2);
        expectBounds(merged[0]!, view, [20, 100, 41, 20.4]);
        expectBounds(merged[1]!, view, [35, 100.2, 5, 6]);
      });
    });
  }

  for (const rotation of [0, 90, 180, 270]) {
    for (const scale of [0.5, 1, 2.5]) {
      it(`keeps normal stored-horizontal text merged after UI ${rotation} degrees at ${scale} zoom`, () => {
        const view = viewport(rotation, scale);
        const fragments = [rect(20, 100, 30), rect(48, 100.5, 25), rect(74, 100, 20)].map(r => {
          const b = fromPdfRect(r, view, box);
          return capturedRect(b.x, b.y, b.width, b.height, view);
        });
        // Only native page rotation belongs in this argument, even after UI rotation.
        const merged = mergePdfTextRects(fragments, box, 0);
        expect(merged).toHaveLength(1);
        expectBounds(merged[0]!, viewport(0), [20, 687.5, 74, 12.5]);
      });
    }
  }
});
