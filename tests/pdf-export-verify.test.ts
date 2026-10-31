import { webcrypto } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFDict, PDFHexString, PDFName } from "pdf-lib";
import type { PdfAnnotation } from "../src/core/pdf-types";
import { verifyPdfExport } from "../src/pdf/export-verify";
import { exportAnnotatedPdf } from "../src/pdf/export";
import { pdfHash } from "../src/core/pdf-source";
import { createNativePdfFixture } from "./pdf-native-fixture";

beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const workerPath = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  vi.stubGlobal("pdfjsWorker", await import(workerPath));
});
afterAll(() => vi.unstubAllGlobals());

async function caseData() {
  const source = await createNativePdfFixture(), hash = await pdfHash(source);
  const record: PdfAnnotation = {
    id: "verified-mark", revision: 1, kind: "pdf-text", color: "#facd5a", note: "中文 😀\n第二行", tags: [],
    pageUrl: `urn:web-ink:pdf:${hash}`, pageTitle: "Verification fixture",
    createdAt: "2026-10-11T08:09:10Z", updatedAt: "2026-10-12T09:10:11Z",
    target: { documentHash: hash, fileName: "verify.pdf", pageNumber: 1,
      rects: [{ x: 0.1, y: 0.7, width: 0.2, height: 0.05 }], exact: "Selected text", prefix: "", suffix: "" },
  };
  return { source, hash, record };
}
const signal = () => new AbortController().signal;

describe("independent PDF.js export gate", () => {
  it("rejects a parseable output that omitted the new saved record", async () => {
    const { source, hash, record } = await caseData();
    await expect(verifyPdfExport(source, source.slice(), hash, [record], signal())).rejects.toMatchObject({ code: "verification" });
  });
  it("accepts a valid output after checking geometry, original relations, contents and a new hash", async () => {
    const { source, hash, record } = await caseData(), output = await exportAnnotatedPdf(source, hash, [record], signal());
    await expect(verifyPdfExport(source, output.bytes, hash, [record], signal())).resolves.toEqual({ count: 1, sourceHash: hash, outputHash: await pdfHash(output.bytes) });
  });
  it.each(["original-note", "new-note", "original-reply", "new-rect", "missing-appearance"] as const)("rejects %s semantic damage", async damage => {
    const { source, hash, record } = await caseData();
    const document = await PDFDocument.load((await exportAnnotatedPdf(source, hash, [record], signal())).bytes, { updateMetadata: false });
    const annotations = document.getPage(0).node.Annots()!, first = annotations.lookup(0, PDFDict), last = annotations.lookup(5, PDFDict);
    if (damage === "original-note") first.set(PDFName.of("Contents"), PDFHexString.fromText("lost original"));
    if (damage === "new-note") last.set(PDFName.of("Contents"), PDFHexString.fromText("lost new"));
    if (damage === "original-reply") annotations.lookup(4, PDFDict).delete(PDFName.of("IRT"));
    if (damage === "new-rect") last.set(PDFName.of("Rect"), document.context.obj([50, 50, 200, 100]));
    if (damage === "missing-appearance") last.delete(PDFName.of("AP"));
    const output = await document.save({ updateFieldAppearances: false });
    await expect(verifyPdfExport(source, output, hash, [record], signal())).rejects.toMatchObject({ code: "verification" });
  });
  it("rejects extra annotations even when all expected contents are present", async () => {
    const { source, hash, record } = await caseData();
    const extra = { ...record, id: "unexpected-extra" };
    const output = await exportAnnotatedPdf(source, hash, [record, extra], signal());
    await expect(verifyPdfExport(source, output.bytes, hash, [record], signal())).rejects.toMatchObject({ code: "verification" });
  });
  it("honors cancellation before any verification task starts", async () => {
    const { source, hash } = await caseData(), abort = new AbortController(); abort.abort();
    await expect(verifyPdfExport(source, source, hash, [], abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
