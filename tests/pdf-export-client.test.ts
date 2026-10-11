import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PdfAnnotation } from "../src/pdf/types";
import type { PdfExportReply, PdfExportRequest } from "../src/pdf/export-contract";
import { exportPdfInWorker } from "../src/pdf/export-client";
import { MAX_PDF_BYTES } from "../src/pdf/source";

const bytes = () => new TextEncoder().encode("%PDF-1.7\nworker-boundary fixture");
const hash = "a".repeat(64);
const record: PdfAnnotation = {
  id: "worker-mark", revision: 1, kind: "pdf-text", color: "#facd5a", note: "中文 😀", tags: [],
  pageUrl: `urn:web-ink:pdf:${hash}`, pageTitle: "Worker fixture",
  createdAt: "2026-10-11T08:09:10Z", updatedAt: "2026-10-12T09:10:11Z",
  target: { documentHash: hash, fileName: "worker.pdf", pageNumber: 1,
    rects: [{ x: 0.1, y: 0.7, width: 0.2, height: 0.05 }], exact: "Selected text", prefix: "", suffix: "" },
};

/** jsdom has no browser Worker; this double models structured-clone transfer. */
class ExportWorkerDouble {
  static instances: ExportWorkerDouble[] = [];
  onmessage: ((event: MessageEvent<PdfExportReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  input?: PdfExportRequest;
  terminated = false;
  constructor() { ExportWorkerDouble.instances.push(this); }
  postMessage(request: PdfExportRequest, transfer: Transferable[]) {
    this.input = structuredClone(request, { transfer });
  }
  terminate() { this.terminated = true; }
  reply(reply: unknown) { this.onmessage?.({ data: reply } as MessageEvent<PdfExportReply>); }
}

beforeEach(() => { ExportWorkerDouble.instances = []; vi.stubGlobal("Worker", ExportWorkerDouble); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("PDF export worker ownership", () => {
  it("transfers an isolated source copy and releases its one worker after a valid result", async () => {
    const source = bytes(), original = source.slice(), abort = new AbortController();
    const pending = exportPdfInWorker(source, hash, [record], abort.signal, "paper.pdf");
    expect(ExportWorkerDouble.instances).toHaveLength(1);
    const worker = ExportWorkerDouble.instances[0]!;
    expect(worker.input!.bytes).toEqual(original);
    worker.reply({ ok: true, result: { bytes: bytes(), fileName: "web-ink-annotated.pdf", count: 1 } });
    await expect(pending).resolves.toMatchObject({ count: 1, fileName: "paper-annotated.pdf" });
    expect(source).toEqual(original);
    expect(source.buffer.byteLength).toBeGreaterThan(0);
    expect(worker.terminated).toBe(true);
  });

  it("terminates on cancel and allows the next export to acquire a fresh worker", async () => {
    const firstAbort = new AbortController();
    const first = exportPdfInWorker(bytes(), hash, [record], firstAbort.signal);
    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(ExportWorkerDouble.instances[0]!.terminated).toBe(true);
    const secondAbort = new AbortController(), second = exportPdfInWorker(bytes(), hash, [], secondAbort.signal);
    secondAbort.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(ExportWorkerDouble.instances).toHaveLength(2);
  });

  it("rejects a concurrent export without creating a second worker", async () => {
    const abort = new AbortController(), pending = exportPdfInWorker(bytes(), hash, [], abort.signal);
    await expect(exportPdfInWorker(bytes(), hash, [], new AbortController().signal)).rejects.toMatchObject({ code: "busy" });
    expect(ExportWorkerDouble.instances).toHaveLength(1);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects at 60 seconds and terminates the timed-out worker", async () => {
    vi.useFakeTimers();
    const pending = exportPdfInWorker(bytes(), hash, [], new AbortController().signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(ExportWorkerDouble.instances[0]!.terminated).toBe(true);
  });

  it("checks source limits and snapshot schema before allocating a worker", async () => {
    await expect(exportPdfInWorker(new Uint8Array(MAX_PDF_BYTES + 1), hash, [], new AbortController().signal)).rejects.toMatchObject({ code: "size-limit" });
    await expect(exportPdfInWorker(bytes(), hash, [{ ...record, revision: 0 }], new AbortController().signal)).rejects.toMatchObject({ code: "invalid-input" });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(exportPdfInWorker(bytes(), hash, [], cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(ExportWorkerDouble.instances).toHaveLength(0);
  });

  it.each([
    ["oversized", { ok: true, result: { bytes: new Uint8Array(MAX_PDF_BYTES + 1), fileName: "bad.pdf", count: 1 } }, "size-limit"],
    ["wrong-count", { ok: true, result: { bytes: bytes(), fileName: "bad.pdf", count: 0 } }, "worker"],
    ["malformed", { ok: true, result: null }, "worker"],
    ["capability", { ok: false, code: "signed", message: "Signed PDF" }, "signed"],
  ] as const)("cleans up after %s worker output", async (_name, reply, code) => {
    const pending = exportPdfInWorker(bytes(), hash, [record], new AbortController().signal);
    const worker = ExportWorkerDouble.instances[0]!;
    worker.reply(reply);
    await expect(pending).rejects.toMatchObject({ code });
    expect(worker.terminated).toBe(true);
  });

  it("handles worker script errors with resource cleanup", async () => {
    const pending = exportPdfInWorker(bytes(), hash, [], new AbortController().signal);
    const worker = ExportWorkerDouble.instances[0]!;
    worker.onerror?.({ preventDefault() {} } as ErrorEvent);
    await expect(pending).rejects.toMatchObject({ code: "worker" });
    expect(worker.terminated).toBe(true);
  });
});
