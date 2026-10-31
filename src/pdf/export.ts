import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, PDFStream, fill, popGraphicsState, pushGraphicsState,
  rectangle, setFillingRgbColor, setGraphicsState, setLineWidth, setStrokingRgbColor, stroke, type PDFPage, } from "pdf-lib";
import type { PdfAnnotation } from "../core/pdf-types";
import { pdfHash } from "../core/pdf-source";
import { PdfExportError, checkExportBytes, validateExportRecords, type PdfExportResult, } from "./export-contract";
export { PdfExportError, type PdfExportResult } from "./export-contract";
function checkCapabilities(document: PDFDocument): void {
  // Any encrypted input is rejected by load; no password/permission bypass exists.
  if (document.isEncrypted) throw new PdfExportError("encrypted", "Encrypted PDFs cannot be exported.");
  const permissions = document.catalog.get(PDFName.of("Perms"));
  if (permissions) throw new PdfExportError("permissions", "This PDF contains signature or usage-rights permissions.");
  const form = document.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (form?.has(PDFName.of("XFA"))) throw new PdfExportError("xfa", "XFA PDFs cannot be exported.");
  const seen = new Set<PDFDict | PDFArray | PDFStream>();
  const inspect = (object: unknown): void => {
    if (!(object instanceof PDFDict || object instanceof PDFArray || object instanceof PDFStream) || seen.has(object)) return;
    seen.add(object);
    if (object instanceof PDFStream) { inspect(object.dict); return; }
    if (object instanceof PDFArray) {
      for (let index = 0; index < object.size(); index++) inspect(object.get(index));
      return;
    }
    const type = object.get(PDFName.of("Type")), fieldType = object.get(PDFName.of("FT"));
    if (type === PDFName.of("Sig") || object.has(PDFName.of("ByteRange")) ||
        (fieldType === PDFName.of("Sig") && object.has(PDFName.of("V"))))
      throw new PdfExportError("signed", "Digitally signed PDFs cannot be exported.");
    for (const [, value] of object.entries()) inspect(value);
  };
  // Include direct field/signature dictionaries nested in the parsed objects.
  for (const [, object] of document.context.enumerateIndirectObjects()) inspect(object);
}

/** PDF.js page.view is the intersection of inherited MediaBox and CropBox. */
function pageView(page: PDFPage): [number, number, number, number] {
  const media = page.getMediaBox(), crop = page.getCropBox();
  const values = [media.x, media.y, media.width, media.height, crop.x, crop.y, crop.width, crop.height];
  if (!values.every(Number.isFinite) || media.width <= 0 || media.height <= 0 || crop.width <= 0 || crop.height <= 0)
    throw new PdfExportError("parse", "The PDF has an invalid page box.");
  const view: [number, number, number, number] = [
    Math.max(media.x, crop.x), Math.max(media.y, crop.y),
    Math.min(media.x + media.width, crop.x + crop.width),
    Math.min(media.y + media.height, crop.y + crop.height),
  ];
  // Empty/disjoint page boxes are outside this bounded writer contract.
  if (view[2] <= view[0] || view[3] <= view[1]) throw new PdfExportError("parse", "The PDF has an empty page view.");
  return view;
}
function pdfDate(iso: string): PDFString {
  return PDFString.of(`D:${new Date(iso).toISOString().slice(0, 19).replace(/[-:T]/g, "")}Z`);
}

export async function exportAnnotatedPdf(
  sourceBytes: Uint8Array,
  sourceHash: string,
  records: readonly PdfAnnotation[],
  signal: AbortSignal) : Promise<PdfExportResult> {
  signal.throwIfAborted();
  checkExportBytes(sourceBytes);
  const snapshot = validateExportRecords(sourceHash, records);
  if (await pdfHash(sourceBytes) !== sourceHash)
    throw new PdfExportError("hash-mismatch", "The original PDF bytes no longer match this snapshot.");
  signal.throwIfAborted();
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(sourceBytes, { updateMetadata: false, throwOnInvalidObject: true });
    checkCapabilities(document);
  } catch (cause) {
    if (cause instanceof PdfExportError) throw cause;
    // v1.17.1's ES5 error subclass has no restored prototype/name. Match its
    // reviewed load-error message; instanceof EncryptedPDFError is false.
    const message = typeof cause === "object" && cause !== null && "message" in cause ? String(cause.message) : "";
    if (message.startsWith("Input document to `PDFDocument.load` is encrypted."))
      throw new PdfExportError("encrypted", "Encrypted PDFs cannot be exported.");
    throw new PdfExportError("parse", "The PDF structure could not be safely read.");
  }
  signal.throwIfAborted();
  const pages = document.getPages(), context = document.context;
  // Validate every page target before mutating any document dictionary.
  const views = snapshot.map(record => {
    const page = pages[record.target.pageNumber - 1];
    if (!page) throw new PdfExportError("invalid-input", "An annotation references a missing PDF page.");
    return pageView(page);
  });
  for (const [index, record] of snapshot.entries()) {
    signal.throwIfAborted();
    const page = pages[record.target.pageNumber - 1]!, [x0, y0, x1, y1] = views[index]!;
    const rects = record.target.rects.map(rect => [
      x0 + rect.x * (x1 - x0), y0 + rect.y * (y1 - y0),
      x0 + (rect.x + rect.width) * (x1 - x0), y0 + (rect.y + rect.height) * (y1 - y0),
    ] as const);
    const left = Math.min(...rects.map(rect => rect[0])), bottom = Math.min(...rects.map(rect => rect[1]));
    const right = Math.max(...rects.map(rect => rect[2])), top = Math.max(...rects.map(rect => rect[3]));
    const width = right - left, height = top - bottom, highlight = record.kind === "pdf-text";
    const color = [1, 3, 5].map(start => Number.parseInt(record.color.slice(start, start + 2), 16) / 255) as [number, number, number];
    const operators = [pushGraphicsState(), setGraphicsState("Style")];
    if (highlight) {
      operators.push(setFillingRgbColor(...color));
      for (const rect of rects) operators.push(rectangle(rect[0] - left, rect[1] - bottom, rect[2] - rect[0], rect[3] - rect[1]));
      // A single nonzero-winding fill paints the union once. Fragment overlap
      // within one saved highlight must not compound its transparency.
      operators.push(fill());
    } else {
      const inset = Math.min(1, width / 2, height / 2);
      operators.push(setStrokingRgbColor(...color), setLineWidth(2), rectangle(inset, inset, width - 2 * inset, height - 2 * inset), stroke());
    }
    operators.push(popGraphicsState());
    const appearance = context.register(context.formXObject(operators, {
      BBox: [0, 0, width, height],
      Resources: { ExtGState: { Style: { Type: "ExtGState", ca: highlight ? 0.42 : 1, CA: 1, BM: highlight ? "Multiply" : "Normal" } } },
    }));
    const annotation = context.register(context.obj({
      Type: "Annot", Subtype: highlight ? "Highlight" : "Square", P: page.ref,
      Rect: [left, bottom, right, top], C: color, CA: highlight ? 0.42 : 1, F: 4,
      QuadPoints: highlight ? rects.flatMap(rect => [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]]) : undefined,
      BS: { Type: "Border", W: highlight ? 0 : 2, S: "S" },
      Contents: PDFHexString.fromText(record.note), NM: PDFHexString.fromText(`web-ink:${record.id}`),
      Subj: PDFHexString.fromText("Web Ink"), CreationDate: pdfDate(record.createdAt), M: pdfDate(record.updatedAt),
      AP: { N: appearance },
    }));
    // addAnnot() normalizes existing Contents/Resources. Append directly so only
    // /Annots changes; appearance resources stay local to the new Form XObject.
    let annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annotations) { annotations = context.obj([]); page.node.set(PDFName.of("Annots"), annotations); }
    annotations.push(annotation);
  }
  signal.throwIfAborted();
  const identifiers = context.lookup(context.trailerInfo.ID);
  if (identifiers !== undefined && (!(identifiers instanceof PDFArray) || identifiers.size() !== 2))
    throw new PdfExportError("parse", "The PDF has an invalid trailer identifier.");
  const firstId = identifiers instanceof PDFArray ? identifiers.get(0) : PDFHexString.of(sourceHash.slice(0, 32));
  const revisionId = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
  // Preserve the permanent identifier; a fresh second ID marks the new file
  // revision even when a user exports after deleting all local annotations.
  context.trailerInfo.ID = context.obj([firstId, PDFHexString.of(revisionId)]);
  let bytes: Uint8Array;
  try { bytes = await document.save({ updateFieldAppearances: false, addDefaultPage: false }); }
  catch { throw new PdfExportError("parse", "The annotated PDF could not be serialized."); }
  signal.throwIfAborted();
  checkExportBytes(bytes);
  return { bytes, fileName: "web-ink-annotated.pdf", count: snapshot.length };
}