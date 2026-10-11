import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import type { PDFLinkService } from "pdfjs-dist/types/web/pdf_link_service";
import type { PdfApi } from "./types";
import { pdfSourceUrl } from "./source";
import { nativePdfDate } from "./native-annotations";

const interactiveSubtypes = new Set([
  "Text", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine",
  "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink", "Popup",
]);
const iconNames = new Set(["Note", "Comment", "Key", "Help", "NewParagraph", "Paragraph", "Insert"]);

function safeLink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw)) return;
  try {
    pdfSourceUrl(raw);
    return new URL(raw).href;
  } catch { return; }
}
function coordinates(raw: unknown, length?: number): number[] | undefined {
  if (!Array.isArray(raw) && !ArrayBuffer.isView(raw)) return;
  const values = Array.from(raw as ArrayLike<number>);
  if ((length !== undefined && values.length !== length) || values.length > 200_000 ||
    values.some(value => typeof value !== "number" || !Number.isFinite(value))) return;
  return values;
}
function plainText(raw: unknown): { str: string; dir: "ltr" | "rtl" } {
  const value = raw && typeof raw === "object" ? raw as { str?: unknown; dir?: unknown } : undefined;
  return { str: typeof value?.str === "string" && value.str.length <= 1_000_000 ? value.str : "",
    dir: value?.dir === "rtl" ? "rtl" : "ltr" };
}

/** Only inert markup and explicitly clicked HTTPS links reach PDF.js's DOM layer. */
function safeAnnotations(api: PdfApi, annotations: unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== "object") continue;
    const raw = annotation as Record<string, unknown>;
    const { id, subtype } = raw;
    if (typeof id !== "string" || !id || id.length > 512 || typeof subtype !== "string") continue;
    const rect = coordinates(raw.rect, 4);
    if (!rect && subtype !== "Popup") continue;
    const annotationType = api.AnnotationType[subtype.toUpperCase() as keyof typeof api.AnnotationType];
    if (!annotationType) continue;
    const common = {
      id, subtype, annotationType, rect: rect ?? null,
      rotation: [0, 90, 180, 270].includes(Number(raw.rotation)) ? Number(raw.rotation) : 0,
      borderStyle: { width: 0, style: 1, horizontalCornerRadius: 0, verticalCornerRadius: 0 },
      noRotate: raw.noRotate === true, hidden: raw.hidden === true, noHTML: raw.noHTML === true,
      hasAppearance: raw.hasAppearance === true, hasOwnCanvas: false, isEditable: false,
    };
    if (subtype === "Link") {
      const url = safeLink(raw.url);
      if (url) result.push({ ...common, url });
      continue;
    }
    if (!interactiveSubtypes.has(subtype)) continue;
    const color = coordinates(raw.color, 3);
    const contents = plainText(raw.contentsObj);
    if (!contents.str) contents.str = plainText(raw.richText).str;
    const quadPoints = coordinates(raw.quadPoints);
    const data: Record<string, unknown> = {
      ...common, contentsObj: contents, titleObj: plainText(raw.titleObj),
      color: color?.every(value => value >= 0 && value <= 255) ? color : null,
      modificationDate: nativePdfDate(raw.modificationDate) ? raw.modificationDate : null,
      creationDate: nativePdfDate(raw.creationDate) ? raw.creationDate : null,
      parentRect: coordinates(raw.parentRect, 4) ?? null,
      popupRef: typeof raw.popupRef === "string" && raw.popupRef.length <= 512 ? raw.popupRef : null,
      name: typeof raw.name === "string" && iconNames.has(raw.name) ? raw.name : "Note",
      // Shape paths remain transparent hit regions; canvas owns their appearance.
      lineCoordinates: coordinates(raw.lineCoordinates, 4),
      vertices: coordinates(raw.vertices),
      quadPoints: quadPoints ? Float32Array.from(quadPoints) : undefined,
      inkLists: Array.isArray(raw.inkLists) ? raw.inkLists.map(value => coordinates(value) ?? []) : [],
      open: false,
    };
    result.push(data);
  }
  return result;
}

export async function createNativeLayer(
  api: PdfApi, page: PDFPageProxy, viewport: PageViewport, annotations: unknown[], imageResourcesPath: string,
): Promise<{ div: HTMLDivElement; destroy(): void }> {
  const div = document.createElement("div");
  div.className = "annotationLayer";
  const linkService = {
    addLinkAttributes(link: HTMLAnchorElement, raw: unknown) {
      const url = safeLink(raw);
      if (!url) return;
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    },
  } as unknown as PDFLinkService;
  const annotationViewport = viewport.clone({ dontFlip: true });
  const layer = new api.AnnotationLayer({
    div, page, viewport: annotationViewport, linkService,
    accessibilityManager: null, annotationCanvasMap: undefined, annotationEditorUIManager: null,
    annotationStorage: undefined, structTreeLayer: null, commentManager: null,
  });
  try {
    const data = safeAnnotations(api, annotations);
    await layer.render({ div, page, viewport: annotationViewport, linkService, annotations: data,
      imageResourcesPath, renderForms: false, enableScripting: false, hasJSActions: false,
      fieldObjects: null });
    const paintedIcons = new Set(data.filter(annotation => annotation.subtype === "Text" && annotation.hasAppearance)
      .map(annotation => annotation.id));
    // A Text AP already paints its icon. Keep its official popup hit target.
    for (const element of div.querySelectorAll<HTMLElement>(".textAnnotation")) {
      if (paintedIcons.has(element.dataset.annotationId)) element.querySelector("img")?.remove();
    }
    return { div, destroy: () => layer.destroy() };
  } catch (error) {
    layer.destroy();
    throw error;
  }
}
