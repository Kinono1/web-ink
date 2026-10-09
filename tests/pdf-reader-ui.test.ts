import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS, type Annotation, type PdfHandoff, type Request } from "../src/core/model";
import type { PdfReadingPosition } from "../src/pdf/reading-position";

const io = vi.hoisted(() => ({
  hash: "a".repeat(64),
  pageCount: 1000,
  remoteReads: [] as string[],
  pagesRead: [] as number[],
}));
vi.mock("../src/pdf/source", async (original) => {
  const actual = await original<typeof import("../src/pdf/source")>();
  return {
    ...actual,
    readLocalPdf: async () => new Uint8Array([37, 80, 68, 70]),
    readRemotePdf: async (url: string) => {
      io.remoteReads.push(url);
      return new Uint8Array([37, 80, 68, 70]);
    },
    pdfHash: async () => io.hash,
  };
});
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    destroy: async () => undefined,
    promise: Promise.resolve({
      numPages: io.pageCount,
      getPage: async (number: number) => {
        io.pagesRead.push(number);
        const width = 600;
        const height = number === 500 ? 480 : 800;
        return {
          rotate: 0,
          view: [0, 0, width, height],
          getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => ({
            width: (rotation % 180 ? height : width) * scale,
            height: (rotation % 180 ? width : height) * scale,
            scale,
            convertToPdfPoint: (x: number, y: number) => [x / scale, height - y / scale],
            convertToViewportPoint: (x: number, y: number) => [x * scale, (height - y) * scale],
          }),
          render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
          streamTextContent: () => undefined,
          cleanup: () => undefined,
        };
      },
    }),
  }),
  TextLayer: class {
    constructor(private options: { container: HTMLElement }) {}
    async render() {
      const span = document.createElement("span");
      span.textContent = "A selected scientific passage.";
      this.options.container.append(span);
    }
    cancel() {}
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const HASH = "a".repeat(64);
const TOKEN = "d385568d-5f2e-4e29-ae6d-f740d0bb423b";
const publicSource = "https://papers.example.test/paper.pdf";
const bookmark: PdfReadingPosition = { version: 1, pageNumber: 500, pageOffsetRatio: 0.5, zoom: 1.5, rotation: 90 };
let root: Root | undefined;
let host: HTMLDivElement;
let records: Annotation[];
let messages: Request[];
let handoff: PdfHandoff | null;
let writes: Record<string, unknown>[];
let readKeys: string[];
let storedPosition: PdfReadingPosition | undefined;
let readGate: ReturnType<typeof deferred<Record<string, unknown>>> | undefined;
let putGate: ReturnType<typeof deferred<unknown>> | undefined;
let putError = "";
let returnError = "";
let prefFailure = false;
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
const baseRecord = () => ({
  id: "saved-highlight", kind: "pdf-text" as const, pageUrl: `urn:web-ink:pdf:${HASH}`,
  pageTitle: "fixture.pdf", color: "#facc15", note: "", tags: [], revision: 3,
  createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
  target: { documentHash: HASH, fileName: "fixture.pdf", pageNumber: 1,
    rects: [{ x: 0.1, y: 0.7, width: 0.2, height: 0.05 }], exact: "saved passage", prefix: "", suffix: "" },
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  history.replaceState(null, "", "/pdf.html");
  io.hash = HASH;
  io.pageCount = 1000;
  io.remoteReads = [];
  io.pagesRead = [];
  records = [];
  messages = [];
  writes = [];
  readKeys = [];
  handoff = { token: TOKEN, tabId: 8, returnUrl: publicSource, sourceUrl: publicSource };
  storedPosition = undefined;
  readGate = undefined;
  putGate = undefined;
  putError = "";
  returnError = "";
  prefFailure = false;
  frames = new Map();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("pdf-selection") ? 300 : 600;
    const height = this.classList.contains("pdf-selection") ? 48 : 800;
    return { x: 40, y: 80, left: 40, top: 80, right: 40 + width, bottom: 80 + height, width, height, toJSON() {} };
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: function (options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
    this.dispatchEvent(new Event("scroll"));
  } });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [
    { left: 100, top: 180, right: 240, bottom: 200, width: 140, height: 20 },
  ] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 100, top: 180, right: 240, bottom: 200, width: 140, height: 20 }) });
  vi.stubGlobal("chrome", {
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    storage: { local: {
      get: async (key: string) => { readKeys.push(key); return readGate ? readGate.promise : { [key]: storedPosition }; },
      set: async (entries: Record<string, unknown>) => { writes.push(entries); if (prefFailure) throw Error("bookmark unavailable"); },
    } },
    runtime: {
      getURL: (path: string) => new URL(path, "http://localhost/").href,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async (message: Request) => {
        messages.push(message);
        switch (message.type) {
          case "settings.get": return { ok: true, data: DEFAULT_SETTINGS };
          case "annotations.list": return { ok: true, data: records };
          case "annotations.query": return { ok: true, data: { items: [] } };
          case "page.mode.get": return { ok: true, data: { enabled: false } };
          case "pdf.handoff.get": return { ok: true, data: handoff };
          case "pdf.returnOriginal": return returnError ? { ok: false, error: returnError, code: "CONTEXT_UNAVAILABLE" } : { ok: true, data: { tabId: 8, url: publicSource } };
          case "annotations.put": {
            if (putGate) return putGate.promise;
            if (putError) return { ok: false, error: putError, code: "CONFLICT" };
            const saved = { ...message.annotation, revision: message.expectedRevision + 1 };
            records = [...records.filter((record) => record.id !== saved.id), saved];
            return { ok: true, data: saved };
          }
          default: return { ok: true, data: true };
        }
      },
    },
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function settle() {
  for (let round = 0; round < 12; round++) {
    await act(async () => {
      await Promise.resolve();
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    });
  }
}
async function mount(query = "", local = true) {
  history.replaceState(null, "", `/pdf.html${query}`);
  const { PdfReader } = await import("../src/pdf/PdfReader");
  root = createRoot(host);
  await act(async () => root!.render(createElement(PdfReader)));
  await settle();
  if (local) {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["%PDF-"], "fixture.pdf", { type: "application/pdf" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
  }
}
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
  expect(result, `action ${label}`).toBeTruthy();
  return result!;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}
async function selectPage(number = 1) {
  const page = host.querySelector<HTMLElement>(`[data-page="${number}"] .pdf-page`)!;
  expect(page).toBeTruthy();
  const node = page.querySelector(".textLayer span")!.firstChild!;
  const range = document.createRange();
  range.setStart(node, 2);
  range.setEnd(node, 10);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => page.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 120, clientY: 190 })));
  await settle();
}
function puts() { return messages.filter((message) => message.type === "annotations.put"); }
function unloadBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
async function editNote(value: string) {
  await click("笔记");
  await click("编辑");
  const textarea = host.querySelector<HTMLTextAreaElement>(".pdf-note-editor textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

describe("PDF reader workspace", () => {
  it("offers selection actions immediately, keeps copying inert and separates overlay visibility", async () => {
    await mount();
    expect(host.querySelector(".pdf-notes")?.hasAttribute("hidden")).toBe(true);
    await selectPage();
    expect(host.querySelector(".pdf-selection")).toBeTruthy();
    await act(async () => document.dispatchEvent(new Event("copy", { bubbles: true })));
    expect(puts()).toHaveLength(0);
    expect(unloadBlocked()).toBe(false);
    await click("更多");
    await click("隐藏标注");
    await selectPage();
    await click("高亮 #facc15");
    expect(puts()).toHaveLength(1);
    expect(messages.some((message) => message.type === "page.mode.put")).toBe(false);
    expect(host.querySelector("[data-pdf-annotation]")).toBeNull();
  });

  it("retains a failed selection and retries the same durable identity without a viewport anchor", async () => {
    await mount();
    await selectPage();
    putGate = deferred();
    await click("高亮 #facc15");
    expect(host.querySelector(".pdf-selection")).toBeTruthy();
    expect(unloadBlocked()).toBe(true);
    const sent = puts()[0]!;
    expect(Object.keys(sent.annotation.target).sort()).toEqual(["documentHash", "exact", "fileName", "pageNumber", "prefix", "rects", "suffix"]);
    await act(async () => putGate!.resolve({ ok: false, error: "disk full", code: "STORAGE_ERROR" }));
    await settle();
    expect(host.querySelector(".pdf-selection")).toBeTruthy();
    putGate = undefined;
    await click("重试保存");
    expect(puts()[1]!.annotation.id).toBe(sent.annotation.id);
    expect(host.querySelector(".pdf-selection")).toBeNull();
    expect(window.getSelection()!.rangeCount).toBe(0);
    expect(unloadBlocked()).toBe(false);
  });

  it("saves the highlight before opening and focusing its note draft", async () => {
    await mount();
    await selectPage();
    putGate = deferred();
    await click("添加笔记");
    expect(host.querySelector("textarea")).toBeNull();
    const annotation = puts()[0]!.annotation;
    await act(async () => putGate!.resolve({ ok: true, data: { ...annotation, revision: 7 } }));
    await settle();
    expect(host.querySelector(".pdf-notes")?.hasAttribute("hidden")).toBe(false);
    const textarea = host.querySelector(".pdf-note-editor textarea");
    expect(textarea).toBeTruthy();
    expect(document.activeElement).toBe(textarea);
    expect(unloadBlocked()).toBe(false);
  });

  it("rejects a cross-page selection explicitly without keeping a partial previous selection", async () => {
    await mount();
    await selectPage();
    const first = host.querySelector('[data-page="1"] .textLayer span')!.firstChild!;
    const last = host.querySelector('[data-page="2"] .textLayer span')!.firstChild!;
    const range = document.createRange();
    range.setStart(first, 2);
    range.setEnd(last, 10);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => host.querySelector('[data-page="2"] .pdf-page')!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    expect(host.querySelector('[role="alert"]')?.textContent ?? "").toContain("一页");
    expect(host.querySelector(".pdf-selection")).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it("guards changed note return, stays after failed save and uses the saved base revision", async () => {
    records = [baseRecord()];
    await mount(`?handoff=${TOKEN}`);
    await editNote("retain this draft");
    expect(unloadBlocked()).toBe(true);
    await click("返回原阅读器");
    expect(host.querySelector('[role="dialog"][aria-label="未保存的内容"]')).toBeTruthy();
    putError = "changed elsewhere";
    await click("保存并继续");
    expect(host.querySelector("textarea")?.value).toBe("retain this draft");
    expect(messages.some((message) => message.type === "pdf.returnOriginal")).toBe(false);
    expect(puts()[0]!.expectedRevision).toBe(3);
    await click("继续编辑");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector("textarea")?.value).toBe("retain this draft");
    putError = "";
    await click("返回原阅读器");
    await click("保存并继续");
    expect(messages.filter((message) => message.type === "pdf.returnOriginal")).toEqual([{ type: "pdf.returnOriginal", token: TOKEN }]);
  });

  it("keeps clean editors and bookmark timers out of beforeunload, but observes note writes in flight", async () => {
    records = [baseRecord()];
    await mount();
    await click("笔记");
    await click("编辑");
    expect(unloadBlocked()).toBe(false);
    putGate = deferred();
    await click("保存");
    expect(unloadBlocked()).toBe(true);
    await act(async () => putGate!.resolve({ ok: true, data: { ...baseRecord(), revision: 4 } }));
    await settle();
    expect(unloadBlocked()).toBe(false);
  });

  it("preserves a dirty note when changing file until discard is chosen", async () => {
    records = [baseRecord()];
    await mount();
    await editNote("draft");
    await click("更多");
    await click("打开其他文件");
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    await click("继续编辑");
    expect(host.querySelector("textarea")?.value).toBe("draft");
    await click("更多");
    await click("打开其他文件");
    await click("放弃并继续");
    expect(host.querySelector('[aria-label="打开其他 PDF"]')).toBeTruthy();
    expect(unloadBlocked()).toBe(false);
  });

  it("autoloads an allowed public source on refresh without the consumed open flag", async () => {
    await mount(`?source=${encodeURIComponent(publicSource)}&document=${HASH}`, false);
    expect(io.remoteReads).toEqual([publicSource]);
    expect(host.querySelector(".pdf-name")?.textContent).toBe("paper.pdf");
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it("does not reopen handoff A over a locally selected B after refresh", async () => {
    await mount(`?handoff=${TOKEN}&document=${HASH}`, false);
    expect(io.remoteReads).toHaveLength(0);
    expect(host.textContent).toContain("重新选择");
    expect(messages).toContainEqual({ type: "pdf.handoff.get", token: TOKEN });
  });

  it("keeps the last local document URL as fallback truth after another source fails", async () => {
    handoff = null;
    await mount(`?handoff=${TOKEN}&source=${encodeURIComponent(publicSource)}`, false);
    await click("更多");
    await click("打开其他文件");
    io.hash = "b".repeat(64);
    const file = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(file, "files", { value: [new File(["%PDF-"], "local-b.pdf")], configurable: true });
    await act(async () => file.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    expect(new URL(location.href).searchParams.has("source")).toBe(false);
    await click("更多");
    await click("打开其他文件");
    const input = host.querySelector<HTMLInputElement>('input[type="url"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "http://invalid.example.test/a.pdf");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(host.querySelector('button[aria-label="打开 PDF 来源"]')).toBeNull();
    expect(host.textContent).not.toContain("打开 PDF 来源");
    expect(host.textContent).toContain("重新选择原来的 PDF");
    expect(new URL(location.href).searchParams.get("document")).toBe("b".repeat(64));
  });

  it("offers an accurate public fallback when the original session has expired", async () => {
    handoff = null;
    await mount(`?handoff=${TOKEN}&source=${encodeURIComponent(publicSource)}`, false);
    expect(host.textContent).toContain("打开 PDF 来源");
    expect(messages.some((message) => message.type === "pdf.returnOriginal")).toBe(false);
  });
});

describe("PDF reading position integration", () => {
  it("keeps the content anchor stable when container padding reaches the next estimated page", async () => {
    readGate = deferred();
    await mount();
    const scroller = host.querySelector<HTMLElement>(".pdf-pages")!;
    scroller.style.paddingTop = "24px";
    scroller.scrollTop = 827;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    await settle();
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("1");
    await click("放大");
    expect(scroller.scrollTop).toBe(827);
  });
  it("waits for initial read and a real target height, then restores without scanning all pages", async () => {
    readGate = deferred();
    await mount();
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(writes).toHaveLength(0);
    await act(async () => readGate!.resolve({ [`ui.pdfReadingPosition.${HASH}`]: bookmark }));
    await settle();
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("500");
    expect(host.querySelector(".pdf-zoom")?.textContent).toBe("150%");
    expect(new Set(io.pagesRead).size).toBeLessThan(20);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const latest = writes.at(-1)?.[`ui.pdfReadingPosition.${HASH}`] as PdfReadingPosition;
    expect(latest).toMatchObject({ pageNumber: 500, zoom: 1.5, rotation: 90 });
    expect(latest.pageOffsetRatio).toBeCloseTo(0.5);
  });

  it.each(["wheel", "key", "zoom", "area"])("does not apply late saved values after %s intent", async (intent) => {
    readGate = deferred();
    await mount();
    expect(readKeys).toContain(`ui.pdfReadingPosition.${HASH}`);
    const scroller = host.querySelector<HTMLElement>(".pdf-pages")!;
    if (intent === "wheel") await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 80 })));
    if (intent === "key") await act(async () => scroller.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageDown" })));
    if (intent === "zoom") await click("放大");
    if (intent === "area") { await click("更多"); await click("区域标注"); }
    await act(async () => readGate!.resolve({ [`ui.pdfReadingPosition.${HASH}`]: bookmark }));
    await settle();
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("1");
    expect(host.querySelector(".pdf-zoom")?.textContent).toBe(intent === "zoom" ? "125%" : "100%");
  });

  it("uses the matching historical target page at top, retaining same-hash zoom/rotation", async () => {
    storedPosition = bookmark;
    await mount(`?document=${HASH}&page=4`);
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("4");
    expect(host.querySelector(".pdf-zoom")?.textContent).toBe("150%");
    expect(new URL(location.href).searchParams.has("page")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(writes.at(-1)?.[`ui.pdfReadingPosition.${HASH}`]).toMatchObject({ pageNumber: 4, pageOffsetRatio: 0 });
  });

  it("does not apply an old annotation page to changed document bytes", async () => {
    io.hash = "b".repeat(64);
    await mount(`?document=${HASH}&page=4`);
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("1");
    expect(host.textContent).toContain("文档版本已变化");
  });

  it("keeps bookmark failure recoverable without blocking a clean return", async () => {
    await mount(`?handoff=${TOKEN}`);
    prefFailure = true;
    await click("返回原阅读器");
    expect(messages).toContainEqual({ type: "pdf.returnOriginal", token: TOKEN });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
