import type {
  Annotation,
  ImageAnnotation,
  TextAnnotation,
} from "../core/model";
import { clientToImage, type ImageGeometry } from "../core/geometry";

export type ActionableAnnotation = TextAnnotation | ImageAnnotation;

/** Pure selection overlap check; adjacent ranges intentionally do not match. */
export function matchingTextSelection(
  annotations: Annotation[],
  textRanges: ReadonlyMap<string, Range>,
  range: Range,
): TextAnnotation[] {
  return annotations.filter((record): record is TextAnnotation => {
    const target =
      record.kind === "text" ? textRanges.get(record.id) : undefined;
    if (!target?.startContainer.isConnected) return false;
    return (
      range.compareBoundaryPoints(Range.END_TO_START, target) < 0 &&
      range.compareBoundaryPoints(Range.START_TO_END, target) > 0
    );
  });
}

export function annotationsAtPoint(
  input: {
    annotations: Annotation[];
    textRanges: ReadonlyMap<string, Range>;
    images: ReadonlyMap<string, HTMLImageElement>;
    imageShape: (id: string) => SVGElement | undefined;
    geometryForImage: (image: HTMLImageElement) => ImageGeometry | null;
  },
  x: number,
  y: number,
): ActionableAnnotation[] {
  return input.annotations.filter((record): record is ActionableAnnotation => {
    if (record.kind === "text")
      return Array.from(
        input.textRanges.get(record.id)?.getClientRects() ?? [],
      ).some(
        (rect) =>
          rect.width > 0 &&
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom,
      );
    if (record.kind !== "image") return false;
    const image = input.images.get(record.id);
    const shape = input.imageShape(record.id);
    const geometry = image?.isConnected ? input.geometryForImage(image) : null;
    if (
      !geometry ||
      !clientToImage(x, y, geometry) ||
      !(shape instanceof SVGGeometryElement)
    )
      return false;
    const matrix = shape.getScreenCTM();
    const svg = shape.ownerSVGElement;
    if (!matrix || !svg) return false;
    // Chrome 120's SVG hit-test methods require a native SVGPoint. Creating it
    // through the owning SVG also works in browsers accepting DOMPointInit.
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = x;
    screenPoint.y = y;
    const point = screenPoint.matrixTransform(matrix.inverse());
    return shape.isPointInFill(point) || shape.isPointInStroke(point);
  });
}
