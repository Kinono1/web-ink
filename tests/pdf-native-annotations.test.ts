import { describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createNativePdfFixture, NATIVE_FIXTURE_NOTES } from "./pdf-native-fixture";
import {
  NativePdfAnnotations, createNativeLayer,
  nativePdfAnnotationKey,
  nativePdfRect,
  parseNativePdfAnnotations,
} from "../src/pdf/native-annotations";

const hash = "a".repeat(64);
const note = (id: string, extra: Record<string, unknown> = {}) => ({
  id, subtype: "Text", contentsObj: { str: `note ${id}`, dir: "ltr" },
  titleObj: { str: "Original author", dir: "ltr" }, rect: [10, 20, 30, 40], ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function countRootLookups(annotations: unknown[]) {
  const originalGet = Map.prototype.get;
  let lookups = 0;
  let records: ReturnType<typeof parseNativePdfAnnotations> | undefined;
  let error: unknown;
  Map.prototype.get = function (key) { lookups++; return originalGet.call(this, key); };
  try { records = parseNativePdfAnnotations(annotations, hash, 1); }
  catch (cause) { error = cause; }
  finally { Map.prototype.get = originalGet; }
  return { lookups, records, error };
}

describe("original PDF note metadata", () => {
  it("uses the document, page and parser id without inventing a load-time date or excerpt", () => {
    const records = parseNativePdfAnnotations([note("42R")], hash, 2);
    expect(records).toEqual([{
      key: `${hash}:2:42R`, documentHash: hash, pageNumber: 2, id: "42R", subtype: "Text",
      contents: "note 42R", author: "Original author", rect: [10, 20, 30, 40],
    }]);
    expect(nativePdfAnnotationKey(hash, 2, "parser:id")).toBe(`${hash}:2:parser:id`);
  });

  it("merges a PDF.js 6 Popup by its parent's popupRef and retains a separate reply", () => {
    const records = parseNativePdfAnnotations([
      note("parent", { subtype: "Highlight", popupRef: "popup" }),
      note("popup", { subtype: "Popup", contentsObj: { str: "note parent" } }),
      note("reply", { inReplyTo: "parent", replyType: "R", contentsObj: { str: "Reply body" } }),
    ], hash, 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "parent", contents: "note parent", replies: [
      { id: "reply", contents: "Reply body", inReplyTo: "parent", replyType: "R" },
    ] });
  });

  it("uses Popup content when the parent has no body and preserves nested or orphan replies", () => {
    const records = parseNativePdfAnnotations([
      note("parent", { popupRef: "popup", contentsObj: { str: "" } }),
      note("popup", { subtype: "Popup", contentsObj: { str: "Popup-only body" } }),
      note("reply", { inReplyTo: "parent" }),
      note("nested", { inReplyTo: "reply" }),
      note("orphan", { inReplyTo: "missing" }),
    ], hash, 1);
    expect(records.map(record => record.id)).toEqual(["parent", "orphan"]);
    expect(records[0]?.contents).toBe("Popup-only body");
    expect(records[0]?.replies?.map(reply => [reply.id, reply.inReplyTo])).toEqual([
      ["reply", "parent"], ["nested", "reply"],
    ]);
  });

  it("deduplicates a grouped annotation without losing a genuinely distinct body", () => {
    const records = parseNativePdfAnnotations([
      note("parent"),
      note("group", { inReplyTo: "parent", replyType: "Group", contentsObj: { str: "note parent" } }),
      note("different", { inReplyTo: "parent", replyType: "Group" }),
    ], hash, 1);
    expect(records).toHaveLength(1);
    expect(records[0]?.replies?.map(reply => reply.id)).toEqual(["different"]);
  });

  it("keeps an orphan Popup and a reply cycle readable", () => {
    const records = parseNativePdfAnnotations([
      note("orphan-popup", { subtype: "Popup" }),
      note("cycle-a", { inReplyTo: "cycle-b" }),
      note("cycle-b", { inReplyTo: "cycle-a" }),
    ], hash, 1);
    expect(records.map(record => record.id)).toEqual(["orphan-popup", "cycle-a", "cycle-b"]);
  });

  it("rejects an oversized nested reply chain with a linear number of root lookups", () => {
    const count = 3_000;
    const chain = Array.from({ length: count }, (_, i) => note(String(i), i ? {
      inReplyTo: String(i - 1), replyType: "R",
    } : {}));
    const result = countRootLookups(chain);
    expect(result.error).toMatchObject({ message: "An original PDF annotation exceeds 500 replies." });
    expect(result.records).toBeUndefined();
    expect(result.lookups).toBeLessThan(count * 8);
  });

  it("resolves a reversed valid chain once and preserves every direct reply relationship", () => {
    const count = 501;
    const chain = Array.from({ length: count }, (_, i) => note(String(i), i ? {
      inReplyTo: String(i - 1), replyType: "R",
    } : {})).reverse();
    const result = countRootLookups(chain);
    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(1);
    expect(result.records?.[0]?.id).toBe("0");
    expect(result.records?.[0]?.replies).toHaveLength(500);
    expect(result.records?.[0]?.replies?.[0]).toMatchObject({ id: "500", inReplyTo: "499" });
    expect(result.records?.[0]?.replies?.at(-1)).toMatchObject({ id: "1", inReplyTo: "0" });
    expect(result.lookups).toBeLessThan(count * 8);
  });

  it("keeps every node leading to a cycle independent while grouping descendants of an orphan", () => {
    const records = parseNativePdfAnnotations([
      note("cycle-a", { inReplyTo: "cycle-b" }),
      note("cycle-b", { inReplyTo: "cycle-a" }),
      note("tail", { inReplyTo: "cycle-a" }),
      note("tail-child", { inReplyTo: "tail" }),
      note("orphan-child", { inReplyTo: "orphan" }),
      note("orphan", { inReplyTo: "missing" }),
    ], hash, 1);
    expect(records.map(record => record.id)).toEqual(["cycle-a", "cycle-b", "tail", "tail-child", "orphan"]);
    expect(records.slice(0, 4).every(record => !record.replies)).toBe(true);
    expect(records.at(-1)?.replies?.map(reply => [reply.id, reply.inReplyTo])).toEqual([["orphan-child", "orphan"]]);
  });

  it("validates PDF dates including leap days and explicit offsets", () => {
    const records = parseNativePdfAnnotations([
      note("valid", { creationDate: "D:20240229090102+08'00'", modificationDate: "D:20261011090102Z" }),
      note("invalid", { creationDate: "D:20230229090102Z", modificationDate: "D:20261311090102Z" }),
      note("partial", { creationDate: "D:2024" }),
    ], hash, 1);
    expect(records[0]?.createdAt).toBe("2024-02-29T01:01:02.000Z");
    expect(records[0]?.updatedAt).toBe("2026-10-11T09:01:02.000Z");
    expect(records[1]?.createdAt).toBeUndefined();
    expect(records[1]?.updatedAt).toBeUndefined();
    expect(records[2]?.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it.each(["D:00000101000000Z", "D:00010101000000+01'00'", "D:99991231235959-01'00'"])(
    "keeps PDF date %s unknown when UTC cannot fit the four-digit ISO calendar", date => {
      const records = parseNativePdfAnnotations([note("date", { creationDate: date, modificationDate: date })], hash, 1);
      expect(records[0]?.createdAt).toBeUndefined();
      expect(records[0]?.updatedAt).toBeUndefined();
    },
  );

  it("rejects malformed identities and omits invalid geometry or colors without modifying source data", () => {
    const raw = note("good", { rect: [0, 1, Infinity, 2], color: [255, -1, 0], creationDate: "unknown" });
    expect(parseNativePdfAnnotations([null, {}, note(""), note("x".repeat(513)), raw], hash, 1)).toEqual([
      { key: `${hash}:1:good`, documentHash: hash, pageNumber: 1, id: "good", subtype: "Text",
        contents: "note good", author: "Original author" },
    ]);
    expect(raw.rect).toEqual([0, 1, Infinity, 2]);
    expect(() => nativePdfAnnotationKey(hash, 0, "id")).toThrow();
    expect(() => nativePdfAnnotationKey("other document", 1, "id")).toThrow();
    expect(() => nativePdfAnnotationKey(hash, 1, 42 as unknown as string)).toThrow();
  });

  it("does not turn navigation links or form values into original-file note cards", () => {
    expect(parseNativePdfAnnotations([
      { id: "link", subtype: "Link", url: "https://example.test/paper", contentsObj: { str: "" } },
      { id: "form", subtype: "Widget", fieldValue: "form data", contentsObj: { str: "" } },
    ], hash, 1)).toEqual([]);
  });

  it("preserves the body of rich-text-only notes without retaining active HTML", () => {
    const records = parseNativePdfAnnotations([note("rich-only", {
      contentsObj: { str: "" }, richText: { str: "Original rich-only body", html: { name: "img", attributes: { src: "https://example.test/track" } } },
    })], hash, 1);
    expect(records[0]?.contents).toBe("Original rich-only body");
    expect(records[0]).not.toHaveProperty("richText");
  });

  it("normalizes raw page coordinates and clips them without depending on zoom or rotation", () => {
    const normalized = nativePdfRect([30, 40, 10, 20], [0, 0, 100, 200])!;
    expect(normalized.x).toBeCloseTo(0.1);
    expect(normalized.y).toBeCloseTo(0.1);
    expect(normalized.width).toBeCloseTo(0.2);
    expect(normalized.height).toBeCloseTo(0.1);
    expect(nativePdfRect([-20, -20, 150, 250], [0, 0, 100, 200])).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(nativePdfRect([10, 20, 10, 30], [0, 0, 100, 200])).toBeUndefined();
    expect(nativePdfRect([0, 0, 10, 20], [0, 0, 0, 200])).toBeUndefined();
    expect(nativePdfRect([0, NaN, 10, 20], [0, 0, 100, 200])).toBeUndefined();
  });
});

describe("session-only lazy original note index", () => {
  it("reads real PDF.js metadata and the official layer from the synthetic original annotation fixture", async () => {
    vi.stubGlobal("DOMMatrix", class {});
    const api = await import("pdfjs-dist/legacy/build/pdf.mjs");
    vi.unstubAllGlobals();
    api.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
    const bytes = await createNativePdfFixture();
    const task = api.getDocument({ data: bytes.slice(), verbosity: api.VerbosityLevel.ERRORS });
    let layer: Awaited<ReturnType<typeof createNativeLayer>> | undefined;
    let index: NativePdfAnnotations | undefined;
    try {
      const document = await task.promise;
      const page = await document.getPage(1);
      const render = vi.spyOn(page, "render");
      index = new NativePdfAnnotations(document, hash);
      const records = await index.readPage(1);
      expect(records.map(record => record.contents)).toEqual([
        NATIVE_FIXTURE_NOTES.highlight, NATIVE_FIXTURE_NOTES.square, NATIVE_FIXTURE_NOTES.text,
      ]);
      const text = records.find(record => record.subtype === "Text")!;
      expect(text.replies?.map(reply => reply.contents)).toEqual([NATIVE_FIXTURE_NOTES.reply]);
      expect(text.createdAt).toBe("2026-01-02T12:34:56.000Z");
      expect(text.updatedAt).toBe("2026-01-03T12:34:56.000Z");
      expect(text.author).toBe("Synthetic author");
      expect(text.key).toBe(`${hash}:1:${text.id}`);
      const normalized = nativePdfRect(records[0]?.rect, page.view)!;
      expect(normalized.x).toBeCloseTo(30 / 560);
      expect(normalized.y).toBeCloseTo(610 / 740);
      expect(normalized.width).toBeCloseTo(300 / 560);
      expect(normalized.height).toBeCloseTo(17 / 740);
      expect(await index.loadAll()).toEqual(records);
      expect(render).not.toHaveBeenCalled();
      const annotations = await page.getAnnotations({ intent: "display" });
      expect(annotations.find(item => item.subtype === "Highlight")?.hasAppearance).toBe(true);
      layer = await createNativeLayer(api, page, page.getViewport({ scale: 1 }), annotations, "/pdfjs/images/");
      expect(layer.div.querySelectorAll(".textAnnotation img")).toHaveLength(2);
      expect(layer.div.querySelector(".squareAnnotation rect")?.getAttribute("stroke")).toBe("transparent");
      expect(layer.div.querySelectorAll("canvas, iframe, input, textarea, select")).toHaveLength(0);
    } finally {
      layer?.destroy();
      index?.dispose();
      await task.destroy();
    }
  });

  it("shares visible-page reads and never renders a canvas for metadata", async () => {
    const getAnnotations = vi.fn(async () => [note("one")]);
    const render = vi.fn();
    const getPage = vi.fn(async () => ({ getAnnotations, render }));
    const index = new NativePdfAnnotations({ numPages: 3, getPage } as unknown as PDFDocumentProxy, hash);
    const [a, b] = await Promise.all([index.readPage(2), index.readPage(2)]);
    expect(a).toBe(b);
    expect(index.records).toHaveLength(1);
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(getAnnotations).toHaveBeenCalledWith({ intent: "display" });
    expect(render).not.toHaveBeenCalled();
  });

  it("scans only missing pages in batches of eight and can resume after cancellation", async () => {
    const firstBatch = deferred<unknown[]>();
    const requested: number[] = [];
    const getPage = vi.fn(async (pageNumber: number) => {
      requested.push(pageNumber);
      return { getAnnotations: () => pageNumber === 1 ? Promise.resolve([note("one")]) : firstBatch.promise };
    });
    const index = new NativePdfAnnotations({ numPages: 20, getPage } as unknown as PDFDocumentProxy, hash);
    await index.readPage(1);
    const signal = new AbortController();
    const progress = vi.fn();
    const scan = index.loadAll(signal.signal, progress);
    const rejected = expect(scan).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    await Promise.resolve();
    expect(requested).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    signal.abort();
    await rejected;
    firstBatch.resolve([]);
    await Promise.resolve();
    expect(progress).toHaveBeenCalledTimes(1);
    expect(requested).toHaveLength(9);
    await index.loadAll();
    expect(requested).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(index.records[0]?.pageNumber).toBe(1);
  });

  it("disposal clears the old document session and rejects a late page without publishing it", async () => {
    const gate = deferred<unknown[]>();
    const oldIndex = new NativePdfAnnotations({ numPages: 1, getPage: async () => ({ getAnnotations: () => gate.promise }) } as unknown as PDFDocumentProxy, hash);
    const read = oldIndex.readPage(1);
    const rejection = expect(read).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    oldIndex.dispose();
    gate.resolve([note("old")]);
    await rejection;
    expect(oldIndex.records).toEqual([]);
    await expect(oldIndex.readPage(1)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("can retry a failed page and rejects pages outside the current document", async () => {
    const getAnnotations = vi.fn().mockRejectedValueOnce(new Error("parse failed")).mockResolvedValueOnce([note("recovered")]);
    const index = new NativePdfAnnotations({ numPages: 1, getPage: async () => ({ getAnnotations }) } as unknown as PDFDocumentProxy, hash);
    await expect(index.readPage(1)).rejects.toThrow("parse failed");
    expect((await index.readPage(1))[0]?.id).toBe("recovered");
    await expect(index.readPage(2)).rejects.toThrow();
  });

  it("rejects a page exceeding 20 MiB in serialized UTF-8 without publishing a partial result", async () => {
    const body = "原".repeat(333_334);
    const annotations = Array.from({ length: 21 }, (_, i) => note(`large-${i}`, { contentsObj: { str: body } }));
    const index = new NativePdfAnnotations({ numPages: 1, getPage: async () => ({ getAnnotations: async () => annotations }) } as unknown as PDFDocumentProxy, hash);
    await expect(index.readPage(1).then(() => undefined)).rejects.toThrow("20 MiB");
    expect(index.records).toEqual([]);
  });

  it("rejects aggregate metadata above 20 MiB and keeps the earlier valid page usable", async () => {
    const body = "a".repeat(1_000_000);
    const getPage = async (pageNumber: number) => ({ getAnnotations: async () => Array.from({ length: 11 }, (_, i) =>
      note(`page-${pageNumber}-${i}`, { contentsObj: { str: body } })) });
    const index = new NativePdfAnnotations({ numPages: 2, getPage } as unknown as PDFDocumentProxy, hash);
    const first = await index.readPage(1);
    await expect(index.readPage(2).then(() => undefined)).rejects.toThrow("20 MiB");
    expect(index.records).toEqual(first);
    expect(await index.readPage(1)).toBe(first);
  });

  it("rejects more than 50,000 parent records atomically across cached pages", async () => {
    const getPage = async (pageNumber: number) => ({ getAnnotations: async () => Array.from({ length: pageNumber === 1 ? 1 : 50_000 }, (_, i) =>
      ({ id: `page-${pageNumber}-${i}`, subtype: "Text", contentsObj: { str: "" } })) });
    const index = new NativePdfAnnotations({ numPages: 2, getPage } as unknown as PDFDocumentProxy, hash);
    const first = await index.readPage(1);
    await expect(index.readPage(2).then(() => undefined)).rejects.toThrow("50,000");
    expect(index.records).toEqual(first);
  });

  it("rejects a parent with more than 500 replies without truncating its thread or replacing prior pages", async () => {
    const replies = Array.from({ length: 501 }, (_, i) => note(`reply-${i}`, { inReplyTo: "parent", replyType: "R" }));
    const getPage = async (pageNumber: number) => ({ getAnnotations: async () => pageNumber === 1 ? [note("valid")]
      : [note("parent"), ...replies] });
    const index = new NativePdfAnnotations({ numPages: 2, getPage } as unknown as PDFDocumentProxy, hash);
    const first = await index.readPage(1);
    await expect(index.readPage(2).then(() => undefined)).rejects.toThrow("500 replies");
    expect(index.records).toEqual(first);
  });
});
