import { exportAnnotatedPdf } from "./export";
import { PdfExportError, type PdfExportRequest, type PdfExportReply } from "./export-contract";
const scope = globalThis as unknown as Pick<Worker, "postMessage" | "onmessage">;
scope.onmessage = async ({ data }: MessageEvent<PdfExportRequest>) => {
  try {
    const result = await exportAnnotatedPdf(data.bytes, data.sourceHash, data.records, new AbortController().signal);
    const reply: PdfExportReply = { ok: true, result };
    scope.postMessage(reply, [result.bytes.buffer as ArrayBuffer]);
  } catch (cause) {
    const reply: PdfExportReply = {
      ok: false, code: cause instanceof PdfExportError ? cause.code : "worker",
      message: cause instanceof Error ? cause.message : "The PDF export worker failed.",
    };
    scope.postMessage(reply);
  }
};