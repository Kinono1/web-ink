import type { PdfAnnotation } from "../core/pdf-types";
import { MAX_BACKUP_ANNOTATIONS, validateAnnotation } from "../core/validation";
import { MAX_PDF_BYTES, verifyPdf } from "../core/pdf-source";

export type PdfExportResult = { bytes: Uint8Array; fileName: string; count: number };
export type PdfExportErrorCode =
  | "invalid-input" | "hash-mismatch" | "encrypted" | "signed" | "xfa"
  | "permissions" | "parse" | "size-limit" | "busy" | "timeout" | "worker"
  | "verification";

export class PdfExportError extends Error {
  constructor(readonly code: PdfExportErrorCode, message: string) {
    super(message);
    this.name = "PdfExportError";
  }
}

export type PdfExportRequest = { bytes: Uint8Array; sourceHash: string; records: readonly PdfAnnotation[]; };
export type PdfExportReply =
  | { ok: true; result: PdfExportResult }
  | { ok: false; code: PdfExportErrorCode; message: string };

export function checkExportBytes(bytes: Uint8Array): void {
  if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== "[object Uint8Array]" || bytes.length === 0)
    throw new PdfExportError("invalid-input", "PDF bytes are required.");
  if (bytes.length > MAX_PDF_BYTES)
    throw new PdfExportError("size-limit", "PDF exceeds the 50 MiB export limit.");
  try { verifyPdf(bytes); }
  catch { throw new PdfExportError("parse", "The file is not a PDF."); }
}

/** Recheck the complete durable schema; revision zero is never an export snapshot. */
export function validateExportRecords(sourceHash: string, records: readonly PdfAnnotation[]): PdfAnnotation[] {
  if (!/^[0-9a-f]{64}$/.test(sourceHash) || !Array.isArray(records) || records.length > MAX_BACKUP_ANNOTATIONS)
    throw new PdfExportError("invalid-input", "Invalid PDF hash or annotation snapshot.");
  const ids = new Set<string>();
  return records.map(raw => {
    let record;
    try { record = validateAnnotation(raw); }
    catch (cause) { throw new PdfExportError("invalid-input", cause instanceof Error ? cause.message : "Invalid annotation."); }
    if ((record.kind !== "pdf-text" && record.kind !== "pdf-area") || record.revision < 1 || ids.has(record.id))
      throw new PdfExportError("invalid-input", "Export requires unique, saved PDF annotations.");
    if (record.target.documentHash !== sourceHash)
      throw new PdfExportError("hash-mismatch", "An annotation belongs to another PDF version.");
    ids.add(record.id);
    return record;
  });
}