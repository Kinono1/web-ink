import type { PDFDocumentProxy, TextContent, TextItem } from "pdfjs-dist/types/src/display/api";

// One million text code units needs roughly 14 MB before Map/object overhead:
// UTF-16 text plus three Int32 source-coordinate mappings.
const MAX_CACHED_CHARS = 1_000_000;
const MAX_VISIBLE_MATCHES = 10_000;
const YIELD_EVERY_PAGES = 16;

export type PdfSearchMatch = {
  pageNumber: number;
  itemRanges: { itemIndex: number; start: number; end: number }[];
};

export type PdfSearchResult = {
  matches: PdfSearchMatch[];
  total: number;
  scannedPages: number;
  failedPages: number;
  textPages: number;
  limited: boolean;
};

export type PdfSearchProgress = Omit<PdfSearchResult, "matches">;

type SearchOptions = {
  signal: AbortSignal;
  onProgress?: (progress: PdfSearchProgress) => void;
};

type SourcePosition = { itemIndex: number; start: number; end: number };
type PageTextIndex = {
  text: string;
  itemIndexes: Int32Array;
  starts: Int32Array;
  ends: Int32Array;
  chars: number;
};

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const CJK_CONTINUATION = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const CJK_LINE_BREAK = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])\r?\n(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;

function abortError(): DOMException {
  return new DOMException("PDF search was cancelled.", "AbortError");
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item &&
    typeof (item as { str?: unknown }).str === "string";
}

class FoldedTextBuilder {
  #parts: string[] = [];
  #itemIndexes: number[] = [];
  #starts: number[] = [];
  #ends: number[] = [];
  #pendingWhitespace?: SourcePosition;
  #pendingLineBreak = false;
  #lastNonWhitespace = "";

  appendItem(value: string, itemIndex: number): void {
    for (const { segment, index } of segmenter.segment(value)) {
      const folded = segment.normalize("NFC").toLocaleLowerCase("und");
      if (/^\s+$/u.test(folded)) {
        this.#pendingWhitespace ??= {
          itemIndex,
          start: index,
          end: index + segment.length,
        };
        continue;
      }
      if (
        this.#pendingLineBreak &&
        !this.#pendingWhitespace &&
        CJK_CONTINUATION.test(this.#lastNonWhitespace) &&
        CJK_CONTINUATION.test(Array.from(folded)[0] ?? "")
      ) {
        this.#pendingLineBreak = false;
      } else {
        this.#flushWhitespace();
      }
      this.#append(folded, { itemIndex, start: index, end: index + segment.length });
      this.#lastNonWhitespace = Array.from(folded).at(-1) ?? this.#lastNonWhitespace;
    }
  }

  appendEndOfLine(): void {
    // PDF.js represents a visual line break separately from a text item.
    if (!this.#pendingWhitespace) this.#pendingLineBreak = true;
  }

  finish(): PageTextIndex {
    this.#flushWhitespace();
    const text = this.#parts.join("");
    return {
      text,
      itemIndexes: Int32Array.from(this.#itemIndexes),
      starts: Int32Array.from(this.#starts),
      ends: Int32Array.from(this.#ends),
      chars: text.length,
    };
  }

  #flushWhitespace(): void {
    if (this.#pendingWhitespace)
      this.#append(" ", this.#pendingWhitespace);
    else if (this.#pendingLineBreak)
      this.#append(" ", { itemIndex: -1, start: -1, end: -1 });
    this.#pendingWhitespace = undefined;
    this.#pendingLineBreak = false;
  }

  #append(value: string, position: SourcePosition): void {
    this.#parts.push(value);
    for (let index = 0; index < value.length; index++) {
      this.#itemIndexes.push(position.itemIndex);
      this.#starts.push(position.start);
      this.#ends.push(position.end);
    }
  }
}

function foldQuery(value: string): string {
  const builder = new FoldedTextBuilder();
  builder.appendItem(value.replace(CJK_LINE_BREAK, "$1"), 0);
  return builder.finish().text;
}

function itemRanges(index: PageTextIndex, start: number, end: number): PdfSearchMatch["itemRanges"] {
  const ranges: PdfSearchMatch["itemRanges"] = [];
  for (let offset = start; offset < end; offset++) {
    const itemIndex = index.itemIndexes[offset]!;
    if (itemIndex < 0) continue;
    const sourceStart = index.starts[offset]!;
    const sourceEnd = index.ends[offset]!;
    const previous = ranges.at(-1);
    if (previous && previous.itemIndex === itemIndex && sourceStart <= previous.end) {
      previous.end = Math.max(previous.end, sourceEnd);
    } else {
      ranges.push({ itemIndex, start: sourceStart, end: sourceEnd });
    }
  }
  return ranges;
}

function matchesForPage(
  pageNumber: number,
  index: PageTextIndex,
  query: string,
  remaining: number,
): { total: number; matches: PdfSearchMatch[] } {
  const matches: PdfSearchMatch[] = [];
  let total = 0;
  let start = 0;
  while (start <= index.text.length - query.length) {
    const found = index.text.indexOf(query, start);
    if (found < 0) break;
    total++;
    if (matches.length < remaining) {
      matches.push({
        pageNumber,
        itemRanges: itemRanges(index, found, found + query.length),
      });
    }
    start = found + query.length;
  }
  return { total, matches };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A cancellable, session-only text index. It never creates canvases or cleans PDF.js pages. */
export class PdfTextSearchIndex {
  #document: PDFDocumentProxy;
  #cache = new Map<number, PageTextIndex>();
  #cachedChars = 0;
  #generation = 0;
  #activeAbort?: AbortController;
  #disposed = false;

  constructor(document: PDFDocumentProxy) {
    this.#document = document;
  }

  async search(query: string, { signal, onProgress }: SearchOptions): Promise<PdfSearchResult> {
    this.#activeAbort?.abort();
    const controller = new AbortController();
    this.#activeAbort = controller;
    const generation = ++this.#generation;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();

    const result: PdfSearchResult = {
      matches: [], total: 0, scannedPages: 0, failedPages: 0, textPages: 0, limited: false,
    };
    const foldedQuery = foldQuery(query);
    try {
      this.#assertActive(generation, controller.signal);
      if (!foldedQuery.trim()) return result;

      for (let pageNumber = 1; pageNumber <= this.#document.numPages; pageNumber++) {
        this.#assertActive(generation, controller.signal);
        let pageIndex = this.#getCached(pageNumber);
        try {
          pageIndex ??= await this.#readPage(pageNumber, generation, controller.signal);
          this.#assertActive(generation, controller.signal);
          if (!this.#cache.has(pageNumber)) this.#cachePage(pageNumber, pageIndex);
          if (pageIndex.text.trim()) result.textPages++;
          const pageMatches = matchesForPage(
            pageNumber,
            pageIndex,
            foldedQuery,
            MAX_VISIBLE_MATCHES - result.matches.length,
          );
          result.total += pageMatches.total;
          result.matches.push(...pageMatches.matches);
        } catch (cause) {
          if (controller.signal.aborted || this.#disposed || generation !== this.#generation) throw abortError();
          result.failedPages++;
        }
        result.scannedPages++;
        result.limited ||= result.total > result.matches.length;
        onProgress?.(this.#progress(result));
        if (pageNumber % YIELD_EVERY_PAGES === 0) await yieldToBrowser();
      }
      this.#assertActive(generation, controller.signal);
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.#activeAbort === controller) this.#activeAbort = undefined;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation++;
    this.#activeAbort?.abort();
    this.#activeAbort = undefined;
    this.#cache.clear();
    this.#cachedChars = 0;
  }

  #progress(result: PdfSearchResult): PdfSearchProgress {
    const { matches: _matches, ...progress } = result;
    return progress;
  }

  #assertActive(generation: number, signal: AbortSignal): void {
    if (this.#disposed || signal.aborted || generation !== this.#generation)
      throw abortError();
  }

  #getCached(pageNumber: number): PageTextIndex | undefined {
    const value = this.#cache.get(pageNumber);
    if (!value) return undefined;
    this.#cache.delete(pageNumber);
    this.#cache.set(pageNumber, value);
    return value;
  }

  #cachePage(pageNumber: number, value: PageTextIndex): void {
    if (value.chars > MAX_CACHED_CHARS) return;
    this.#cache.set(pageNumber, value);
    this.#cachedChars += value.chars;
    while (this.#cachedChars > MAX_CACHED_CHARS) {
      const oldest = this.#cache.entries().next().value as [number, PageTextIndex] | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest[0]);
      this.#cachedChars -= oldest[1].chars;
    }
  }

  async #readPage(pageNumber: number, generation: number, signal: AbortSignal): Promise<PageTextIndex> {
    const page = await this.#document.getPage(pageNumber);
    this.#assertActive(generation, signal);
    const reader = page.streamTextContent({ disableNormalization: false }).getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    const builder = new FoldedTextBuilder();
    let itemIndex = 0;
    try {
      while (true) {
        this.#assertActive(generation, signal);
        const chunk = await reader.read() as ReadableStreamReadResult<TextContent>;
        this.#assertActive(generation, signal);
        if (chunk.done) break;
        for (const item of chunk.value.items) {
          if (!isTextItem(item)) continue;
          builder.appendItem(item.str, itemIndex);
          if (item.hasEOL) builder.appendEndOfLine();
          itemIndex++;
        }
      }
      return builder.finish();
    } finally {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
      reader.releaseLock();
    }
  }
}
