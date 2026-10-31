import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import type { PdfRect } from "../../core/model";
import type { PdfAnnotation } from "../../core/pdf-types";
import { fromPdfRect, mergePdfTextRects } from "../geometry";

type Props = {
  geometry: { viewport: PageViewport; box: number[]; intrinsicRotation: number };
  records: PdfAnnotation[];
  preview?: PdfRect;
  color: string;
};

export function PdfMarks({ geometry, records, preview, color }: Props) {
  return <>{(["pdf-text", "pdf-area"] as const).map((kind) => (
        <svg
          key={kind}
          className="pdf-marks"
          // The outer SVG must blend with the canvas; groups blend records
          // within it. Keep area outlines outside that compositing boundary.
          style={kind === "pdf-text" ? { mixBlendMode: "multiply" } : undefined}
          width={geometry.viewport.width}
          height={geometry.viewport.height}
          aria-hidden="true"
        >
          {records.filter((r) => r.kind === kind).map((r) => (
            <g key={r.id} style={r.kind === "pdf-text" ? { mixBlendMode: "multiply" } : undefined}>
              {(r.kind === "pdf-text" ? mergePdfTextRects(r.target.rects, geometry.box, geometry.intrinsicRotation) : r.target.rects).map((rect, i) => (
                <rect
                  key={`${r.id}-${i}`}
                  data-pdf-annotation={r.id}
                  {...fromPdfRect(rect, geometry.viewport, geometry.box)}
                  fill={r.kind === "pdf-text" ? r.color : "none"}
                  stroke={r.kind === "pdf-area" ? r.color : "none"}
                  strokeWidth="2"
                />
              ))}
            </g>
          ))}
          {kind === "pdf-area" && preview && (
            <rect
              {...fromPdfRect(preview, geometry.viewport, geometry.box)}
              fill="none"
              stroke={color}
              strokeWidth="2"
            />
          )}
        </svg>
      ))}</>;
}

export function PdfSearchMarks({ geometry, rects }: { geometry: Props["geometry"]; rects: PdfRect[] }) {
  return <svg className="pdf-search-marks"
    width={geometry.viewport.width} height={geometry.viewport.height} aria-hidden="true">
    {rects.map((rect, index) => <rect key={index} className="pdf-search-match"
      {...fromPdfRect(rect, geometry.viewport, geometry.box)} />)}
  </svg>;
}
