import type { PdfAnnotation } from "./types";
import { pdfHash } from "./source";
import { PdfExportError, checkExportBytes, validateExportRecords } from "./export-contract";

type NativeAnnotation = {
  id: string; subtype: string; rect: number[] | null; annotationFlags: number;
  quadPoints?: Float32Array; color?: Uint8ClampedArray; contentsObj?: { str: string };
  creationDate?: string; modificationDate?: string; hasAppearance: boolean;
  opacity?: number; borderStyle?: { width: number }; popupRef?: string; inReplyTo?: string;
  [key: string]: unknown;
};
type PageReadback = { view: number[]; rotation: number; annotations: NativeAnnotation[] };

function failed(message: string): never { throw new PdfExportError("verification", message); }

// Object numbers and derived extracted text are deliberately outside the
// fingerprint. Relationship IDs are checked after matching the original nodes.
const semanticFields = [
  "subtype", "rect", "quadPoints", "annotationFlags", "color", "backgroundColor", "borderColor",
  "contentsObj", "titleObj", "creationDate", "modificationDate", "opacity", "hasAppearance",
  "borderStyle", "parentRect", "replyType", "name", "open", "state", "stateModel",
  "inkLists", "vertices", "lineCoordinates", "interiorColor", "fieldName", "fieldType",
  "fieldValue", "defaultFieldValue", "buttonValue", "alternativeText", "exportValues", "dest", "url", "unsafeUrl",
] as const;

function canonical(value: unknown): unknown {
  if (typeof value === "number") return Math.round(value * 10_000) / 10_000;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, canonical);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])]));
  }
  return value ?? null;
}
function fingerprint(annotation: NativeAnnotation): string {
  return JSON.stringify(semanticFields.map(field => canonical(annotation[field])));
}

async function readPdf(bytes: Uint8Array, signal: AbortSignal): Promise<PageReadback[]> {
  signal.throwIfAborted();
  // The reader configures its PDF.js worker asset. This import shares that
  // configuration and never imports the writer or changes GlobalWorkerOptions.
  const api = await import("pdfjs-dist/legacy/build/pdf.mjs");
  signal.throwIfAborted();
  const task = api.getDocument({ data: bytes.slice(), stopAtErrors: true,
    enableXfa: false, disableFontFace: true, verbosity: api.VerbosityLevel.ERRORS });
  const cancel = () => { void task.destroy().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const document = await task.promise, permissions = await document.getPermissions();
    if (permissions && !permissions.has(api.PermissionFlag.MODIFY_ANNOTATIONS))
      throw new PdfExportError("permissions", "This PDF does not permit annotations.");
    const pages: PageReadback[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      signal.throwIfAborted();
      const page = await document.getPage(pageNumber);
      pages.push({ view: page.view.slice(), rotation: page.rotate,
        annotations: await page.getAnnotations({ intent: "any" }) as NativeAnnotation[] });
      page.cleanup();
    }
    signal.throwIfAborted();
    return pages;
  } catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof PdfExportError) throw cause;
    failed("PDF.js could not independently read the exported PDF structure.");
  } finally {
    signal.removeEventListener("abort", cancel);
    await task.destroy().catch(() => undefined);
  }
}

function coordinatesMatch(actual: ArrayLike<number> | null | undefined, expected: number[]): boolean {
  return !!actual && actual.length === expected.length && expected.every((value, index) =>
    Number.isFinite(actual[index]) && Math.abs(actual[index]! - value) <= 0.0001);
}

function checkAdded(annotation: NativeAnnotation, record: PdfAnnotation, view: number[]): boolean {
  const [x0, y0, x1, y1] = view as [number, number, number, number];
  const rects = record.target.rects.map(rect => [x0 + rect.x * (x1 - x0), y0 + rect.y * (y1 - y0),
    x0 + (rect.x + rect.width) * (x1 - x0), y0 + (rect.y + rect.height) * (y1 - y0)]);
  const bounds = [Math.min(...rects.map(rect => rect[0]!)), Math.min(...rects.map(rect => rect[1]!)),
    Math.max(...rects.map(rect => rect[2]!)), Math.max(...rects.map(rect => rect[3]!))];
  const highlight = record.kind === "pdf-text";
  const colors = [1, 3, 5].map(start => Number.parseInt(record.color.slice(start, start + 2), 16));
  const date = (iso: string) => `D:${new Date(iso).toISOString().slice(0, 19).replace(/[-:T]/g, "")}Z`;
  if (annotation.subtype !== (highlight ? "Highlight" : "Square") || annotation.contentsObj?.str !== record.note ||
      annotation.annotationFlags !== 4 || !annotation.hasAppearance || !coordinatesMatch(annotation.rect, bounds) ||
      !coordinatesMatch(annotation.color, colors) || annotation.creationDate !== date(record.createdAt) ||
      annotation.modificationDate !== date(record.updatedAt)) return false;
  if (!highlight) return annotation.borderStyle?.width === 2;
  const quads = rects.flatMap(rect => [rect[0]!, rect[3]!, rect[2]!, rect[3]!, rect[0]!, rect[1]!, rect[2]!, rect[1]!]).map(Math.fround);
  return annotation.opacity === 0.42 && coordinatesMatch(annotation.quadPoints, quads);
}

export async function verifyPdfExport(
  sourceBytes: Uint8Array, outputBytes: Uint8Array, sourceHash: string,
  records: readonly PdfAnnotation[], signal: AbortSignal,
): Promise<{ count: number; sourceHash: string; outputHash: string }> {
  signal.throwIfAborted();
  checkExportBytes(sourceBytes); checkExportBytes(outputBytes);
  const snapshot = validateExportRecords(sourceHash, records);
  if (await pdfHash(sourceBytes) !== sourceHash) throw new PdfExportError("hash-mismatch", "The source PDF changed before verification.");
  const outputHash = await pdfHash(outputBytes);
  if (outputHash === sourceHash) failed("The export is not a distinct PDF revision.");
  const before = await readPdf(sourceBytes, signal), after = await readPdf(outputBytes, signal);
  if (after.length !== before.length) failed("The export changed the PDF page count.");
  const expectedByPage = new Map<number, PdfAnnotation[]>();
  for (const record of snapshot) {
    if (record.target.pageNumber > before.length) failed("The snapshot references a missing PDF page.");
    const pageRecords = expectedByPage.get(record.target.pageNumber) ?? [];
    pageRecords.push(record); expectedByPage.set(record.target.pageNumber, pageRecords);
  }
  for (const [index, originalPage] of before.entries()) {
    signal.throwIfAborted();
    const outputPage = after[index]!, expected = expectedByPage.get(index + 1) ?? [];
    if (originalPage.rotation !== outputPage.rotation || !coordinatesMatch(outputPage.view, originalPage.view))
      failed("The export changed a PDF page view or rotation.");
    if (outputPage.annotations.length !== originalPage.annotations.length + expected.length)
      failed("The exported annotation count does not match the complete snapshot.");
    const buckets = new Map<string, { records: NativeAnnotation[]; next: number }>();
    for (const annotation of outputPage.annotations) {
      const key = fingerprint(annotation), bucket = buckets.get(key) ?? { records: [], next: 0 };
      bucket.records.push(annotation); buckets.set(key, bucket);
    }
    const matched = new Map<string, NativeAnnotation>(), consumed = new Set<NativeAnnotation>();
    for (const original of originalPage.annotations) {
      const bucket = buckets.get(fingerprint(original)), candidate = bucket?.records[bucket.next];
      if (!candidate) failed("An original PDF annotation changed or disappeared.");
      bucket!.next++; consumed.add(candidate); matched.set(original.id, candidate);
    }
    for (const original of originalPage.annotations) {
      const candidate = matched.get(original.id)!;
      for (const relationship of ["popupRef", "inReplyTo"] as const) {
        const target = original[relationship], expectedId = target ? matched.get(target)?.id ?? target : null;
        if ((candidate[relationship] ?? null) !== expectedId) failed("An original Popup or reply relationship changed.");
      }
    }
    const added = outputPage.annotations.filter(annotation => !consumed.has(annotation));
    for (const record of expected) {
      const position = added.findIndex(annotation => checkAdded(annotation, record, originalPage.view));
      if (position < 0) failed("A new annotation has incorrect geometry, appearance metadata, color or contents.");
      added.splice(position, 1);
    }
    if (added.length) failed("The export contains unexpected new annotations.");
  }
  return { count: snapshot.length, sourceHash, outputHash };
}
