import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { PdfFind } from "../src/pdf/PdfFind";
import type { OpenDocument } from "../src/pdf/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function documentFixture() {
  const reads: ReturnType<typeof deferred<PDFPageProxy>>[] = [];
  const document = {
    numPages: 1,
    getPage: async () => {
      const read = deferred<PDFPageProxy>();
      reads.push(read);
      return read.promise;
    },
  } as unknown as PDFDocumentProxy;
  const opened = { document, fileName: "search.pdf", hash: "a".repeat(64), api: {} } as OpenDocument;
  return { opened, reads };
}

const page = {
  streamTextContent: () => new ReadableStream({
    start(controller) {
      controller.enqueue({
        items: [{ str: "target target", hasEOL: true, dir: "ltr", width: 80, height: 12,
          transform: [1, 0, 0, 1, 0, 0], fontName: "f1" }],
        styles: { f1: { fontFamily: "sans-serif", vertical: false } },
        lang: "en",
      });
      controller.close();
    },
  }),
} as unknown as PDFPageProxy;

let root: Root;
let host: HTMLDivElement;
let props: ComponentProps<typeof PdfFind>;
let fixture: ReturnType<typeof documentFixture>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture = documentFixture();
  props = { opened: fixture.opened, language: "en", blocked: false, onMatch: vi.fn(), onNavigate: vi.fn() };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(overrides: Partial<ComponentProps<typeof PdfFind>> = {}) {
  props = { ...props, ...overrides };
  await act(async () => root.render(createElement(PdfFind, props)));
}

async function click(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  await act(async () => button.click());
}

async function startSearch() {
  await render();
  await click("Search PDF");
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search PDF text"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "target");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(180);
  });
  return fixture.reads[0]!;
}

async function finish(read: ReturnType<typeof deferred<PDFPageProxy>>) {
  await act(async () => read.resolve(page));
}

describe("PDF find navigation guards", () => {
  it("ignores a late result while blocked and searches again after the guard clears", async () => {
    const first = await startSearch();
    await render({ blocked: true });
    await finish(first);

    expect(props.onNavigate).not.toHaveBeenCalled();
    expect(host.querySelector(".pdf-find-count")?.textContent).not.toContain("1 / 2");

    await render({ blocked: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    await finish(fixture.reads[1]!);

    expect(props.onNavigate).toHaveBeenCalledWith(1);
    expect(host.querySelector(".pdf-find-count")?.textContent).toBe("1 / 2");
  });

  it("does not navigate on Enter or Shift+Enter while a guard is active", async () => {
    await finish(await startSearch());
    vi.mocked(props.onNavigate).mockClear();
    await render({ blocked: true });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search PDF text"]')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    });

    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("ignores pending results after the search panel closes", async () => {
    const pending = await startSearch();
    await click("Close search");
    await finish(pending);

    expect(props.onNavigate).not.toHaveBeenCalled();
    expect(host.querySelector('[role="search"]')).toBeNull();
  });

  it("ignores the old document result while searching the replacement document", async () => {
    const pending = await startSearch();
    const replacement = documentFixture();
    await render({ opened: replacement.opened });
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    await finish(pending);
    expect(props.onNavigate).not.toHaveBeenCalled();

    await finish(replacement.reads[0]!);
    expect(props.onNavigate).toHaveBeenCalledWith(1);
    expect(host.querySelector(".pdf-find-count")?.textContent).toBe("1 / 2");
  });
});
