import type { PdfRect } from "../core/model";
/** Join default-upright text fragments; return unrotated PDF coordinates. */
export function mergePdfTextRects(rects: PdfRect[], box: number[], intrinsicRotation = 0): PdfRect[] {
  // Use the native page frame, never UI rotation, to keep line grouping stable.
  if (intrinsicRotation === 90 || intrinsicRotation === 270) {
    const transpose = (rect: PdfRect): PdfRect => ({
      x: intrinsicRotation === 90 ? rect.y : 1 - rect.y - rect.height,
      y: intrinsicRotation === 90 ? rect.x : 1 - rect.x - rect.width,
      width: rect.height,
      height: rect.width,
    });
    // This mapping is its own inverse. Swap point dimensions for gap tolerance.
    return mergePdfTextRects(rects.map(transpose), [box[1]!, box[0]!, box[3]!, box[2]!]).map(transpose);
  }
  const rows: { anchor: PdfRect; fragments: PdfRect[] }[] = [];
  for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let row: typeof rows[number] | undefined;
    // Anchors are sorted by y; earlier lines beyond this window cannot match.
    for (let i = rows.length - 1; i >= 0; i--) {
      const candidate = rows[i]!, anchor = candidate.anchor;
      if (rect.y - anchor.y > rect.height * 0.12) break;
      const tolerance = Math.min(anchor.height, rect.height) * 0.12;
      if (Math.abs(anchor.y - rect.y) <= tolerance &&
        Math.abs(anchor.height - rect.height) <= tolerance) {
        row = candidate;
        break;
      }
    }
    if (row) row.fragments.push(rect);
    else rows.push({ anchor: rect, fragments: [rect] });
  }
  const pageWidth = box[2]! - box[0]!, pageHeight = box[3]! - box[1]!;
  return rows.flatMap(({ anchor, fragments }) => {
    const merged: PdfRect[] = [];
    for (const rect of fragments.sort((a, b) => a.x - b.x)) {
      const previous = merged.at(-1);
      // Use the original line height, not the growing envelope, to avoid
      // gradually bridging distinct lines or increasing whitespace tolerance.
      const gap = Math.min(1, Math.min(anchor.height, rect.height) * pageHeight * 0.15) / pageWidth;
      if (previous && rect.x <= previous.x + previous.width + gap) {
        previous.width = Math.max(previous.x + previous.width, rect.x + rect.width) - previous.x;
        const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
        previous.y = Math.min(previous.y, rect.y);
        previous.height = bottom - previous.y;
      } else merged.push({ ...rect });
    }
    return merged;
  });
}
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
