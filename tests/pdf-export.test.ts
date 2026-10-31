import { webcrypto } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  PDFDocument, PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream,
  PDFString, PDFStream, decodePDFRawStream,
} from "pdf-lib";
import type { PdfAnnotation } from "../src/core/pdf-types";
import { COLORS } from "../src/core/model";
import { exportAnnotatedPdf } from "../src/pdf/export";
import { verifyPdfExport } from "../src/pdf/export-verify";
import { MAX_PDF_BYTES, pdfHash } from "../src/core/pdf-source";
import {
  createNativePdfFixture, NATIVE_FIXTURE_ANNOTATION_COUNT, NATIVE_FIXTURE_NOTES,
} from "./pdf-native-fixture";

let api: typeof import("pdfjs-dist");
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const workerModule = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  vi.stubGlobal("pdfjsWorker", await import(workerModule));
  api = await import("pdfjs-dist/legacy/build/pdf.mjs");
});
afterAll(() => vi.unstubAllGlobals());

export function exportTestRecord(hash: string, pageNumber = 1, kind: PdfAnnotation["kind"] = "pdf-text"): PdfAnnotation {
  return {
    id: `mark-${pageNumber}-${kind}`, revision: 1, kind,
    pageUrl: `urn:web-ink:pdf:${hash}`, pageTitle: "Synthetic native PDF",
    color: COLORS[(pageNumber - 1) % COLORS.length]!, note: "中文笔记 😀\n第二行 (安全文本)", tags: [],
    createdAt: "2026-10-11T08:09:10Z", updatedAt: "2026-10-12T09:10:11Z",
    target: {
      documentHash: hash, fileName: "native-fixture.pdf", pageNumber,
      rects: kind === "pdf-text"
        ? [{ x: 0.1, y: 0.7, width: 0.25, height: 0.04 }, { x: 0.1, y: 0.63, width: 0.2, height: 0.035 }]
        : [{ x: 0.55, y: 0.3, width: 0.2, height: 0.15 }],
      exact: kind === "pdf-text" ? "A synthetic multiline selection" : "", prefix: "", suffix: "",
    },
  };
}

async function readAnnotations(bytes: Uint8Array) {
  const task = api.getDocument({ data: bytes.slice(), stopAtErrors: true, verbosity: api.VerbosityLevel.ERRORS });
  try {
    const document = await task.promise, pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      pages.push({ view: page.view, rotation: page.rotate, records: await page.getAnnotations() });
    }
    return pages;
  } finally { await task.destroy(); }
}

const signal = () => new AbortController().signal;
describe("native editable PDF export", () => {
  it("writes one annotation per saved record while preserving original semantic fingerprints", async () => {
    const source = await createNativePdfFixture(), untouched = source.slice(), hash = await pdfHash(source);
    const records = Array.from({ length: 4 }, (_, i) => [exportTestRecord(hash, i + 1), exportTestRecord(hash, i + 1, "pdf-area")]).flat();
    const snapshot = structuredClone(records), before = await readAnnotations(source);
    const result = await exportAnnotatedPdf(source, hash, records, signal()), after = await readAnnotations(result.bytes);
    expect(after.flatMap(page => page.records)).toHaveLength(NATIVE_FIXTURE_ANNOTATION_COUNT + 8);
    expect(result.count).toBe(8);
    expect(source).toEqual(untouched);
    expect(records).toEqual(snapshot);
    expect(await pdfHash(result.bytes)).not.toBe(hash);
    for (const [index, page] of before.entries()) {
      expect(after[index]!.view).toEqual(page.view);
      expect(after[index]!.rotation).toBe(index * 90);
      for (const original of page.records) {
        expect(after[index]!.records.find(record => record.id === original.id)).toEqual(original);
      }
      const added = after[index]!.records.filter(record => !page.records.some(original => original.id === record.id));
      expect(added).toHaveLength(2);
      const [highlight, square] = added;
      expect(highlight!.subtype).toBe("Highlight");
      expect(highlight!.contentsObj.str).toBe(records[index * 2]!.note);
      expect(highlight!.hasAppearance).toBe(true);
      expect(highlight!.quadPoints).toHaveLength(16);
      expect(highlight!.opacity).toBe(0.42);
      expect(square!.subtype).toBe("Square");
      expect(square!.contentsObj.str).toBe(records[index * 2 + 1]!.note);
      expect(square!.hasAppearance).toBe(true);
      expect(square!.borderStyle.width).toBe(2);
      expect(highlight!.creationDate).toBe("D:20261011080910Z");
      expect(highlight!.modificationDate).toBe("D:20261012091011Z");
    }
    // Hand-derived CropBox geometry for page 1: [20,30,580,770].
    const added = after[0]!.records.filter(record => !before[0]!.records.some(original => original.id === record.id));
    expect(added[0]!.rect).toEqual([76, 496.2, 216, 577.6]);
    expect(Array.from(added[0]!.quadPoints)).toEqual(expect.arrayContaining([76, 548, 216]));
    expect(Array.from(added[0]!.color)).toEqual([250, 205, 90]);
    expect(added[1]!.rect).toEqual([328, 252, 440, 363]);
    expect(after[0]!.records.find(record => record.contentsObj.str === NATIVE_FIXTURE_NOTES.reply)!.inReplyTo)
      .toBe(after[0]!.records.find(record => record.subtype === "Text" && record.contentsObj.str === NATIVE_FIXTURE_NOTES.text)!.id);
  });

  it("retains custom appearance stream bytes and uses operator-built Multiply highlights without text injection", async () => {
    const source = await createNativePdfFixture(), hash = await pdfHash(source), record = exportTestRecord(hash);
    record.note = "笔记 😀\n) /Fake gs BT <DEAD> Tj ET (";
    const output = (await exportAnnotatedPdf(source, hash, [record, exportTestRecord(hash, 1, "pdf-area")], signal())).bytes;
    const original = await PDFDocument.load(source, { updateMetadata: false });
    const document = await PDFDocument.load(output, { updateMetadata: false });
    const annotations = document.getPage(0).node.Annots()!;
    const dictionaries = Array.from({ length: annotations.size() }, (_, index) => annotations.lookup(index, PDFDict));
    const oldAp = original.getPage(0).node.Annots()!.lookup(0, PDFDict).lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"), PDFStream) as PDFRawStream;
    const newAp = dictionaries[0]!.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"), PDFStream) as PDFRawStream;
    expect(newAp.getContents()).toEqual(oldAp.getContents());
    const highlight = dictionaries.find(dict => dict.lookupMaybe(PDFName.of("NM"), PDFHexString)?.decodeText() === `web-ink:${record.id}`)!;
    expect(highlight).toBeTruthy();
    expect(highlight.lookup(PDFName.of("Contents"), PDFHexString).decodeText()).toBe(record.note);
    expect(highlight.lookup(PDFName.of("Subj"), PDFHexString).decodeText()).toBe("Web Ink");
    const appearance = highlight.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"), PDFStream) as PDFRawStream;
    const style = appearance.dict.lookup(PDFName.of("Resources"), PDFDict).lookup(PDFName.of("ExtGState"), PDFDict).lookup(PDFName.of("Style"), PDFDict);
    expect(style.lookup(PDFName.of("BM"), PDFName).decodeText()).toBe("Multiply");
    expect(style.lookup(PDFName.of("ca"), PDFNumber).asNumber()).toBe(0.42);
    const operators = new TextDecoder().decode(decodePDFRawStream(appearance).decode());
    expect(operators).not.toContain("Fake");
    expect(operators.match(/\bre\b/g)).toHaveLength(2);
    const square = dictionaries.find(dict => dict.lookupMaybe(PDFName.of("NM"), PDFHexString)?.decodeText().endsWith("pdf-area"))!;
    const squareAppearance = square.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"), PDFStream) as PDFRawStream;
    expect(new TextDecoder().decode(decodePDFRawStream(squareAppearance).decode())).not.toMatch(/\bf\b/);
    expect(square.lookup(PDFName.of("BS"), PDFDict).lookup(PDFName.of("W"), PDFNumber).asNumber()).toBe(2);
  });

  it.each(COLORS)("preserves exact RGB channels for %s", async color => {
    const source = await createNativePdfFixture(1), hash = await pdfHash(source), record = exportTestRecord(hash);
    record.color = color;
    const result = await exportAnnotatedPdf(source, hash, [record], signal());
    const added = (await readAnnotations(result.bytes))[0]!.records.find(item => item.contentsObj.str === record.note)!;
    expect(Array.from(added.color)).toEqual([1, 3, 5].map(start => Number.parseInt(color.slice(start, start + 2), 16)));
  });

  it("regenerates from H0 after editing or deleting without accumulating old exports", async () => {
    const source = await createNativePdfFixture(1), hash = await pdfHash(source), record = exportTestRecord(hash);
    const first = await exportAnnotatedPdf(source, hash, [record], signal());
    record.note = "编辑后的笔记"; record.revision = 2;
    const second = await exportAnnotatedPdf(source, hash, [record], signal());
    const notes = (await readAnnotations(second.bytes))[0]!.records.map(item => item.contentsObj.str);
    expect(notes).toContain("编辑后的笔记");
    expect(notes).not.toContain("中文笔记 😀\n第二行 (安全文本)");
    expect((await readAnnotations(first.bytes))[0]!.records).toHaveLength(6);
    const deleted = await exportAnnotatedPdf(source, hash, [], signal());
    expect((await readAnnotations(deleted.bytes))[0]!.records).toHaveLength(5);
    expect(await pdfHash(deleted.bytes)).not.toBe(hash);
    const h1 = await pdfHash(first.bytes), fresh = exportTestRecord(h1);
    const reexport = await exportAnnotatedPdf(first.bytes, h1, [fresh], signal());
    expect((await readAnnotations(reexport.bytes))[0]!.records).toHaveLength(7);
    await expect(exportAnnotatedPdf(first.bytes, h1, [record], signal())).rejects.toMatchObject({ code: "hash-mismatch" });
  });

  it("paints overlapping fragments once so a highlight does not darken itself", async () => {
    const source = await createNativePdfFixture(1), hash = await pdfHash(source), record = exportTestRecord(hash);
    const first = record.target.rects[0]!;
    record.target.rects = [first, { ...first }, { ...first, x: 0.15 }];
    const output = (await exportAnnotatedPdf(source, hash, [record], signal())).bytes;
    const fillCount = async (bytes: Uint8Array) => {
      const task = api.getDocument({ data: bytes.slice(), verbosity: api.VerbosityLevel.ERRORS,
        standardFontDataUrl: `${path.resolve("node_modules/pdfjs-dist/standard_fonts")}/` });
      try {
        const page = await (await task.promise).getPage(1), operators = await page.getOperatorList();
        return operators.fnArray.reduce((count: number, operation: number, index: number) => count +
          Number(operation === api.OPS.fill || (operation === api.OPS.constructPath && operators.argsArray[index]?.[0] === api.OPS.fill)), 0);
      } finally { await task.destroy(); }
    };
    expect(await fillCount(output) - await fillCount(source)).toBe(1);
    expect((await readAnnotations(output))[0]!.records.find(item => item.contentsObj.str === record.note)!.quadPoints).toHaveLength(24);
  });

  it("updates only the trailer revision ID while preserving the first ID and original page streams", async () => {
    const initial = await PDFDocument.load(await createNativePdfFixture(1), { updateMetadata: false });
    initial.context.trailerInfo.ID = initial.context.obj([PDFHexString.of("0123456789abcdef"), PDFHexString.of("fedcba9876543210")]);
    const source = await initial.save({ updateFieldAppearances: false }), hash = await pdfHash(source);
    const output = (await exportAnnotatedPdf(source, hash, [exportTestRecord(hash)], signal())).bytes;
    const before = await PDFDocument.load(source, { updateMetadata: false }), after = await PDFDocument.load(output, { updateMetadata: false });
    const oldId = before.context.lookup(before.context.trailerInfo.ID, PDFArray), newId = after.context.lookup(after.context.trailerInfo.ID, PDFArray);
    expect(newId.get(0).toString()).toBe(oldId.get(0).toString());
    expect(newId.get(1).toString()).not.toBe(oldId.get(1).toString());
    for (const key of ["Contents", "Resources"]) expect(after.getPage(0).node.get(PDFName.of(key))!.toString()).toBe(before.getPage(0).node.get(PDFName.of(key))!.toString());
    const oldStreams = before.getPage(0).node.Contents() as PDFArray, newStreams = after.getPage(0).node.Contents() as PDFArray;
    expect(newStreams.size()).toBe(oldStreams.size());
    for (let index = 0; index < oldStreams.size(); index++) expect(newStreams.lookup(index, PDFRawStream).getContents()).toEqual(oldStreams.lookup(index, PDFRawStream).getContents());
  });

  it.each([
    ["unsaved", (record: PdfAnnotation) => { record.revision = 0; }],
    ["outside", (record: PdfAnnotation) => { record.target.rects[0]!.x = 1; }],
    ["NaN", (record: PdfAnnotation) => { record.target.rects[0]!.x = NaN; }],
    ["unknown-page", (record: PdfAnnotation) => { record.target.pageNumber = 9; }],
    ["wrong-kind", (record: PdfAnnotation) => { (record as {kind:string}).kind = "text"; }],
  ] as const)("rejects %s records at the writer boundary", async (_name, corrupt) => {
    const source = await createNativePdfFixture(1), hash = await pdfHash(source), record = exportTestRecord(hash);
    corrupt(record);
    await expect(exportAnnotatedPdf(source, hash, [record], signal())).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects a changed source hash, duplicate identities, oversize source and pre-aborted operation", async () => {
    const source = await createNativePdfFixture(1), hash = await pdfHash(source), record = exportTestRecord(hash);
    await expect(exportAnnotatedPdf(source, "0".repeat(64), [record], signal())).rejects.toMatchObject({ code: "hash-mismatch" });
    await expect(exportAnnotatedPdf(source, hash, [record, record], signal())).rejects.toMatchObject({ code: "invalid-input" });
    await expect(exportAnnotatedPdf(new Uint8Array(MAX_PDF_BYTES + 1), hash, [], signal())).rejects.toMatchObject({ code: "size-limit" });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(exportAnnotatedPdf(source, hash, [record], cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["encrypted", "signed", "xfa", "permissions"] as const)("blocks %s capability without rewriting input", async capability => {
    const document = await PDFDocument.load(await createNativePdfFixture(1), { updateMetadata: false });
    const context = document.context;
    if (capability === "encrypted") context.trailerInfo.Encrypt = context.register(context.obj({ Filter: "Standard", V: 1, R: 2, P: -32 }));
    if (capability === "signed") context.register(context.obj({ Type: "Sig", ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of("00") }));
    if (capability === "xfa") document.catalog.set(PDFName.of("AcroForm"), context.register(context.obj({ Fields: [], XFA: PDFString.of("synthetic") })));
    if (capability === "permissions") document.catalog.set(PDFName.of("Perms"), context.obj({ UR3: context.register(context.obj({ Type: "Sig" })) }));
    const bytes = await document.save({ updateFieldAppearances: false }), hash = await pdfHash(bytes), untouched = bytes.slice();
    await expect(exportAnnotatedPdf(bytes, hash, [], signal())).rejects.toMatchObject({ code: capability });
    expect(bytes).toEqual(untouched);
  });

  it("rejects broken input instead of pretending a header is a parseable PDF", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nnot a PDF object graph"), hash = await pdfHash(bytes);
    await expect(exportAnnotatedPdf(bytes, hash, [], signal())).rejects.toMatchObject({ code: "parse" });
  });

  it("rejects a direct signature dictionary nested in an AcroForm field", async () => {
    const document = await PDFDocument.load(await createNativePdfFixture(1), { updateMetadata: false }), context = document.context;
    document.catalog.set(PDFName.of("AcroForm"), context.obj({ Fields: [{ FT: "Sig", T: PDFString.of("Signature"),
      V: { Type: "Sig", ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of("00") } }] }));
    const source = await document.save({ updateFieldAppearances: false });
    await expect(exportAnnotatedPdf(source, await pdfHash(source), [], signal())).rejects.toMatchObject({ code: "signed" });
  });

  it("allows an unsigned signature field whose value is null", async () => {
    const document = await PDFDocument.load(await createNativePdfFixture(1), { updateMetadata: false }), context = document.context;
    const field = context.register(context.obj({ FT: "Sig", T: PDFString.of("Empty signature"), V: PDFNull }));
    document.catalog.set(PDFName.of("AcroForm"), context.obj({ Fields: [field] }));
    const source = await document.save({ updateFieldAppearances: false });
    await expect(exportAnnotatedPdf(source, await pdfHash(source), [], signal())).resolves.toMatchObject({ count: 0 });
  });

  it.skipIf(!process.env.WEB_INK_EXPORT_BENCHMARK)("records five adapter exports for 10-page and 100-page synthetic PDFs", async () => {
    const runs = [];
    for (const pageCount of [10, 100]) {
      const source = await createNativePdfFixture(pageCount), hash = await pdfHash(source);
      const records = Array.from({ length: pageCount }, (_, index) => [exportTestRecord(hash, index + 1), exportTestRecord(hash, index + 1, "pdf-area")]).flat();
      for (let run = 1; run <= 5; run++) {
        const start = performance.now(), output = await exportAnnotatedPdf(source, hash, records, signal());
        const durationMs = performance.now() - start;
        await verifyPdfExport(source, output.bytes, hash, records, signal());
        runs.push({ pageCount, run, sourceBytes: source.length, outputBytes: output.bytes.length,
          count: output.count, durationMs, sourceHash: hash, outputHash: await pdfHash(output.bytes) });
      }
    }
    const directory = ".local-install/evidence";
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/pdf-export-performance.json`, JSON.stringify({
      measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
      writer: "pdf-lib 1.17.1", reader: "PDF.js 6.3.289", measurement: "adapter hash/load/append/save; excludes worker startup and independent verification", runs,
    }, null, 2) + "\n");
    expect(runs).toHaveLength(10);
  }, 30_000);

  it.skipIf(!process.env.WEB_INK_PREVIEW_FIXTURE)("preserves the synthetic Preview-authored file through independent readback", async () => {
    const sourcePath = process.env.WEB_INK_PREVIEW_FIXTURE!, source = new Uint8Array(await readFile(sourcePath)), hash = await pdfHash(source);
    const records = [exportTestRecord(hash), exportTestRecord(hash, 1, "pdf-area")];
    const before = await readAnnotations(source), output = await exportAnnotatedPdf(source, hash, records, signal());
    const verified = await verifyPdfExport(source, output.bytes, hash, records, signal()), after = await readAnnotations(output.bytes);
    expect(after.flatMap(page => page.records)).toHaveLength(before.flatMap(page => page.records).length + 2);
    expect(await pdfHash(new Uint8Array(await readFile(sourcePath)))).toBe(hash);
    await mkdir(".local-install/evidence", { recursive: true });
    await writeFile(".local-install/evidence/preview-writer-export.pdf", output.bytes);
    await writeFile(".local-install/evidence/preview-writer-readback.json", JSON.stringify({
      sourcePath, ...verified, sourceBytes: source.length, outputBytes: output.bytes.length,
      originalCount: before.flatMap(page => page.records).length, outputCount: after.flatMap(page => page.records).length,
      originalNotes: before.flatMap((page, index) => page.records.map(record => ({ pageNumber: index + 1, subtype: record.subtype, contents: record.contentsObj.str }))),
    }, null, 2) + "\n");
  });
});
