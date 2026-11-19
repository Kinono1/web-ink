import type { PdfViewport } from "../../src/pdf/geometry";

export function pdfViewport(rotation: number, scale = 1): PdfViewport {
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
