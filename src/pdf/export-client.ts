import type { PdfAnnotation } from "../core/pdf-types";
import { PdfExportError, checkExportBytes, validateExportRecords, type PdfExportReply, type PdfExportRequest, type PdfExportResult, } from "./export-contract";
let activeWorker: Worker | undefined;
function annotatedPdfFileName(sourceName = "web-ink.pdf"): string {
  const base = sourceName.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/\.pdf$/i, "").replace(/^\.+/, "").trim();
  return `${Array.from(base).slice(0, 180).join("") || "web-ink"}-annotated.pdf`;
}

export async function exportPdfInWorker(
  bytes: Uint8Array, sourceHash: string, records: readonly PdfAnnotation[],
  signal: AbortSignal, fileName?: string) : Promise<PdfExportResult> {
  signal.throwIfAborted();
  checkExportBytes(bytes);
  const snapshot = validateExportRecords(sourceHash, records);
  if (activeWorker) throw new PdfExportError("busy", "A PDF export is already running.");
  let worker: Worker;
  try { worker = new Worker(new URL("./export-worker.ts", import.meta.url), { type: "module" }); }
  catch { throw new PdfExportError("worker", "The PDF export worker could not be started."); }
  activeWorker = worker;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (cause?: unknown, result?: PdfExportResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      if (activeWorker === worker) activeWorker = undefined;
      if (cause) reject(cause);
      else resolve({ ...result!, fileName: annotatedPdfFileName(fileName) });
    };
    const cancel = () => finish(new DOMException("PDF export cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(new PdfExportError("timeout", "PDF export exceeded 60 seconds.")), 60_000);
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = ({ data }: MessageEvent<PdfExportReply>) => {
      try {
        if (!data || typeof data.ok !== "boolean") throw new PdfExportError("worker", "Invalid PDF export worker response.");
        if (!data.ok) { finish(new PdfExportError(data.code, data.message)); return; }
        if (!data.result || data.result.count !== snapshot.length)
          throw new PdfExportError("worker", "The PDF export worker returned an incomplete snapshot.");
        checkExportBytes(data.result.bytes);
        finish(undefined, data.result);
      } catch (cause) { finish(cause); }
    };
    worker.onerror = event => { event.preventDefault(); finish(new PdfExportError("worker", "The PDF export worker failed.")); };
    worker.onmessageerror = () => finish(new PdfExportError("worker", "The PDF export worker response could not be read."));
    if (signal.aborted) { cancel(); return; }
    try {
      // Transfer only the copy: the reader's H0 bytes remain available for retry
      // and repeated exports. The worker returns its output buffer by transfer.
      const transferred = bytes.slice();
      const request: PdfExportRequest = { bytes: transferred, sourceHash, records: snapshot };
      worker.postMessage(request, [transferred.buffer]);
    } catch { finish(new PdfExportError("worker", "The PDF export request could not be transferred.")); }
  });
}