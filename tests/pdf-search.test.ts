import { describe, expect, it } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { PdfTextSearchIndex } from "../src/pdf/search";

type Item = { str: string; hasEOL?: boolean };
type MarkedContent = { type: "beginMarkedContent" | "endMarkedContent" };
type PageSpec = { chunks: Array<Array<Item | MarkedContent>> } | { error: Error } | { stream: () => ReadableStream<unknown> };

function textStream(chunks: Array<Array<Item | MarkedContent>>): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const items of chunks) controller.enqueue({ items });
      controller.close();
    },
  });
}

function documentFrom(pages: PageSpec[]) {
  const reads = new Array<number>(pages.length).fill(0);
  const document = {
    numPages: pages.length,
    async getPage(number: number) {
      reads[number - 1] = reads[number - 1]! + 1;
      const spec = pages[number - 1]!;
      if ("error" in spec) throw spec.error;
      return {
        streamTextContent: () => "stream" in spec ? spec.stream() : textStream(spec.chunks),
      };
    },
  } as unknown as PDFDocumentProxy;
  return { document, reads };
}

describe("PdfTextSearchIndex", () => {
  it("matches case-folded Unicode over item and line boundaries with source offsets", async () => {
    const { document } = documentFrom([{
      chunks: [[
        { str: "CAFÉ" },
        { str: " 文本", hasEOL: true },
        { str: "第二行" },
      ]],
    }]);
    const index = new PdfTextSearchIndex(document);

    const result = await index.search("café 文本\n第二行", { signal: new AbortController().signal });

    expect(result).toMatchObject({ total: 1, scannedPages: 1, failedPages: 0, textPages: 1, limited: false });
    expect(result.matches).toEqual([{
      pageNumber: 1,
      itemRanges: [
        { itemIndex: 0, start: 0, end: 4 },
        { itemIndex: 1, start: 0, end: 3 },
        { itemIndex: 2, start: 0, end: 3 },
      ],
    }]);
  });

  it("preserves UTF-16 source offsets when NFC merges a combining sequence", async () => {
    const { document } = documentFrom([{ chunks: [[{ str: "cafe\u0301" }]] }]);
    const index = new PdfTextSearchIndex(document);

    const result = await index.search("CAFÉ", { signal: new AbortController().signal });

    expect(result.matches).toEqual([{
      pageNumber: 1,
      itemRanges: [{ itemIndex: 0, start: 0, end: 5 }],
    }]);
  });

  it("matches Chinese split across PDF.js text items without inserting a false space", async () => {
    const { document } = documentFrom([{ chunks: [[{ str: "中文" }, { str: "论文" }]] }]);
    const index = new PdfTextSearchIndex(document);

    const result = await index.search("中文论文", { signal: new AbortController().signal });

    expect(result.matches).toEqual([{
      pageNumber: 1,
      itemRanges: [
        { itemIndex: 0, start: 0, end: 2 },
        { itemIndex: 1, start: 0, end: 2 },
      ],
    }]);
  });

  it("does not insert a space at a visual CJK line break", async () => {
    const { document } = documentFrom([{
      chunks: [[{ str: "中文", hasEOL: true }, { str: "论文" }]],
    }]);
    const index = new PdfTextSearchIndex(document);

    const result = await index.search("中文论文", { signal: new AbortController().signal });

    expect(result.matches).toEqual([{
      pageNumber: 1,
      itemRanges: [
        { itemIndex: 0, start: 0, end: 2 },
        { itemIndex: 1, start: 0, end: 2 },
      ],
    }]);
  });

  it("keeps an English visual line break as a word separator", async () => {
    const { document } = documentFrom([{
      chunks: [[{ str: "alpha", hasEOL: true }, { str: "beta" }]],
    }]);
    const index = new PdfTextSearchIndex(document);

    const spaced = await index.search("alpha beta", { signal: new AbortController().signal });
    const joined = await index.search("alphabeta", { signal: new AbortController().signal });

    expect(spaced.matches).toEqual([{
      pageNumber: 1,
      itemRanges: [
        { itemIndex: 0, start: 0, end: 5 },
        { itemIndex: 1, start: 0, end: 4 },
      ],
    }]);
    expect(joined.total).toBe(0);
  });

  it("preserves real CJK whitespace across a visual line break", async () => {
    const { document } = documentFrom([{
      chunks: [[{ str: "中文 ", hasEOL: true }, { str: "论文" }]],
    }]);
    const index = new PdfTextSearchIndex(document);

    const spaced = await index.search("中文 论文", { signal: new AbortController().signal });
    const joined = await index.search("中文论文", { signal: new AbortController().signal });

    expect(spaced.matches).toEqual([{
      pageNumber: 1,
      itemRanges: [
        { itemIndex: 0, start: 0, end: 3 },
        { itemIndex: 1, start: 0, end: 2 },
      ],
    }]);
    expect(joined.total).toBe(0);
  });

  it("uses PDF.js text-layer item indexes and skips marked-content sentinels", async () => {
    const { document } = documentFrom([{
      chunks: [[
        { str: "first" },
        { type: "beginMarkedContent" },
        { str: "second" },
        { type: "endMarkedContent" },
      ]],
    }]);
    const index = new PdfTextSearchIndex(document);

    const result = await index.search("firstsecond", { signal: new AbortController().signal });

    expect(result.matches).toEqual([{
      pageNumber: 1,
      itemRanges: [
        { itemIndex: 0, start: 0, end: 5 },
        { itemIndex: 1, start: 0, end: 6 },
      ],
    }]);
  });

  it("does not count an empty text stream as a searchable page", async () => {
    const { document } = documentFrom([{ chunks: [[]] }]);
    const index = new PdfTextSearchIndex(document);

    const result = await index.search("anything", { signal: new AbortController().signal });

    expect(result).toMatchObject({ scannedPages: 1, textPages: 0, failedPages: 0, total: 0 });
  });

  it("uses cached page text for a later query without reading PDF.js again", async () => {
    const { document, reads } = documentFrom([{ chunks: [[{ str: "alpha beta" }]] }]);
    const index = new PdfTextSearchIndex(document);

    await index.search("alpha", { signal: new AbortController().signal });
    await index.search("beta", { signal: new AbortController().signal });

    expect(reads).toEqual([1]);
  });

  it("does not start extraction for an already-aborted request", async () => {
    const { document, reads } = documentFrom([{ chunks: [[{ str: "unused" }]] }]);
    const index = new PdfTextSearchIndex(document);
    const controller = new AbortController();
    controller.abort();

    await expect(index.search("unused", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toEqual([0]);
  });

  it("reports an extraction failure while returning matches from other pages", async () => {
    const { document } = documentFrom([
      { chunks: [[{ str: "available" }]] },
      { error: new Error("broken text stream") },
    ]);
    const index = new PdfTextSearchIndex(document);

    const result = await index.search("available", { signal: new AbortController().signal });

    expect(result).toMatchObject({ total: 1, scannedPages: 2, failedPages: 1, textPages: 1 });
  });

  it("caps retained matches but counts every literal occurrence", async () => {
    const { document } = documentFrom([{ chunks: [[{ str: "x ".repeat(10_001) }]] }]);
    const index = new PdfTextSearchIndex(document);

    const result = await index.search("x", { signal: new AbortController().signal });

    expect(result.total).toBe(10_001);
    expect(result.matches).toHaveLength(10_000);
    expect(result.limited).toBe(true);
  });

  it("cancels the active text stream and rejects without a stale result", async () => {
    let cancelCalled = false;
    let releasePull!: () => void;
    const pull = new Promise<void>((resolve) => { releasePull = resolve; });
    const { document } = documentFrom([{
      stream: () => new ReadableStream({
        pull: () => pull,
        cancel: () => { cancelCalled = true; releasePull(); },
      }),
    }]);
    const index = new PdfTextSearchIndex(document);
    const controller = new AbortController();
    const pending = index.search("pending", { signal: controller.signal });

    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelCalled).toBe(true);
  });

  it("dispose cancels an in-flight stream and clears the session index", async () => {
    let cancelCalled = false;
    let releasePull!: () => void;
    const pull = new Promise<void>((resolve) => { releasePull = resolve; });
    const { document } = documentFrom([{
      stream: () => new ReadableStream({
        pull: () => pull,
        cancel: () => { cancelCalled = true; releasePull(); },
      }),
    }]);
    const index = new PdfTextSearchIndex(document);
    const pending = index.search("pending", { signal: new AbortController().signal });

    await Promise.resolve();
    index.dispose();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelCalled).toBe(true);
  });

  it("supersedes an old query before it can return a stale result", async () => {
    let streamCalls = 0;
    let releasePull!: () => void;
    const pull = new Promise<void>((resolve) => { releasePull = resolve; });
    const document = {
      numPages: 1,
      async getPage() {
        return {
          streamTextContent: () => {
            streamCalls++;
            if (streamCalls > 1) return textStream([[{ str: "new query" }]]);
            return new ReadableStream({
              pull: () => pull,
              cancel: () => releasePull(),
            });
          },
        };
      },
    } as unknown as PDFDocumentProxy;
    const index = new PdfTextSearchIndex(document);
    const old = index.search("old", { signal: new AbortController().signal });

    await Promise.resolve();
    const replacement = await index.search("new", { signal: new AbortController().signal });

    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(replacement.total).toBe(1);
  });
});
