import { describe, expect, it } from "vitest";
import { fromPdfRect, toPdfRect, type PdfViewport } from "../src/pdf/geometry";
import { MAX_PDF_BYTES, pdfSourceUrl, verifyPdf } from "../src/pdf/source";
function viewport(rotation: number, scale: number): PdfViewport {
  const transform = (x: number, y: number): number[] =>
    rotation === 0
      ? [x * scale, (800 - y) * scale]
      : rotation === 90
        ? [y * scale, x * scale]
        : rotation === 180
          ? [(600 - x) * scale, y * scale]
          : [(800 - y) * scale, (600 - x) * scale];
  const inverse = (x: number, y: number): number[] =>
    rotation === 0
      ? [x / scale, 800 - y / scale]
      : rotation === 90
        ? [y / scale, x / scale]
        : rotation === 180
          ? [600 - x / scale, y / scale]
          : [600 - y / scale, 800 - x / scale];
  return {
    width: (rotation % 180 ? 800 : 600) * scale,
    height: (rotation % 180 ? 600 : 800) * scale,
    convertToViewportPoint: transform,
    convertToPdfPoint: inverse,
  };
}
describe("PDF coordinate identity", () => {
  for (const rotation of [0, 90, 180, 270])
    for (const scale of [0.5, 1, 2.5])
      it(`restores original coordinates at ${rotation} degrees / ${scale} scale`, () => {
        const stored = { x: 0.17, y: 0.29, width: 0.34, height: 0.21 };
        const v = viewport(rotation, scale),
          view = fromPdfRect(stored, v, [0, 0, 600, 800]);
        const back = toPdfRect(
          {
            left: view.x,
            top: view.y,
            right: view.x + view.width,
            bottom: view.y + view.height,
          },
          v,
          [0, 0, 600, 800],
        )!;
        for (const k of ["x", "y", "width", "height"] as const)
          expect(back[k]).toBeCloseTo(stored[k], 8);
      });
  it("rejects empty rectangles and clamps selection outside the page", () => {
    const v = viewport(0, 1);
    expect(
      toPdfRect({ left: 0, top: 0, right: 0, bottom: 0 }, v, [0, 0, 600, 800]),
    ).toBeUndefined();
    expect(
      toPdfRect(
        { left: -10, top: -10, right: 700, bottom: 900 },
        v,
        [0, 0, 600, 800],
      ),
    ).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});
describe("PDF source boundary", () => {
  it("accepts public HTTPS and strips view fragments only", () => {
    expect(
      pdfSourceUrl("https://example.com/p.pdf?version=2#page=3").href,
    ).toBe("https://example.com/p.pdf?version=2");
  });
  it.each([
    "http://example.com/p.pdf",
    "file:///private/p.pdf",
    "javascript:alert(1)",
    "https://user:secret@example.com/p.pdf",
  ])("rejects unsafe source %s", (source) =>
    expect(() => pdfSourceUrl(source)).toThrow(),
  );
  it("rejects HTML login responses and files over the byte limit", () => {
    expect(() =>
      verifyPdf(new TextEncoder().encode("<html>Sign in</html>")),
    ).toThrow("not a PDF");
    expect(() => verifyPdf(new Uint8Array(MAX_PDF_BYTES + 1))).toThrow(
      "50 MiB",
    );
    expect(
      verifyPdf(new TextEncoder().encode("%PDF-1.7\nfixture")).length,
    ).toBeGreaterThan(0);
  });
});
