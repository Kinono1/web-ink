import type { PdfRect } from "../core/model";
export interface PdfViewport {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}
/** Store unrotated PDF coordinates, not CSS pixels or the current zoom. */
export function toPdfRect(
  rect: { left: number; top: number; right: number; bottom: number },
  viewport: PdfViewport,
  box: number[],
): PdfRect | undefined {
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  const a = viewport.convertToPdfPoint(rect.left, rect.top),
    b = viewport.convertToPdfPoint(rect.right, rect.bottom);
  const x = Math.max(0, Math.min(1, (Math.min(a[0]!, b[0]!) - x0) / (x1 - x0)));
  const y = Math.max(0, Math.min(1, (Math.min(a[1]!, b[1]!) - y0) / (y1 - y0)));
  const right = Math.max(
    0,
    Math.min(1, (Math.max(a[0]!, b[0]!) - x0) / (x1 - x0)),
  );
  const top = Math.max(
    0,
    Math.min(1, (Math.max(a[1]!, b[1]!) - y0) / (y1 - y0)),
  );
  if (
    ![x, y, right, top].every(Number.isFinite) ||
    right - x < 0.00001 ||
    top - y < 0.00001
  )
    return undefined;
  return { x, y, width: right - x, height: top - y };
}
export function fromPdfRect(
  rect: PdfRect,
  viewport: PdfViewport,
  box: number[],
): { x: number; y: number; width: number; height: number } {
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  const converted = [
    ...viewport.convertToViewportPoint(
      x0 + rect.x * (x1 - x0),
      y0 + rect.y * (y1 - y0),
    ),
    ...viewport.convertToViewportPoint(
      x0 + (rect.x + rect.width) * (x1 - x0),
      y0 + (rect.y + rect.height) * (y1 - y0),
    ),
  ];
  return {
    x: Math.min(converted[0]!, converted[2]!),
    y: Math.min(converted[1]!, converted[3]!),
    width: Math.abs(converted[2]! - converted[0]!),
    height: Math.abs(converted[3]! - converted[1]!),
  };
}
