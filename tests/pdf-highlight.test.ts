import { describe, expect, it } from "vitest";
import { mergePdfTextRects } from "../src/pdf/geometry";
import type { PdfRect } from "../src/core/model";

const box = [0, 0, 600, 800];
const rect = (x: number, y: number, width: number, height = 12): PdfRect =>
  ({ x: x / 600, y: y / 800, width: width / 600, height: height / 800 });

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
});
