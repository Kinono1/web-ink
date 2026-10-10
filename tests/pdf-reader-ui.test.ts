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
  documentOptions: [] as Record<string, unknown>[],
  rejectOversizedImage: false,
  renderGates: {} as Record<number, Promise<unknown> | undefined>,
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
  getDocument: (options: Record<string, unknown>) => {
    io.documentOptions.push(options);
    return {
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
            render: () => {
              // Model the strict stream error after the build-time PDF.js fix.
              const oversizedImage = number === 1 && io.rejectOversizedImage && options.stopAtErrors === true;
              const promise = io.renderGates[number] ?? (oversizedImage
                ? Promise.reject(new Error("Image exceeded maximum allowed size and was removed."))
                : Promise.resolve());
              return { promise, cancel: () => undefined };
            },
            streamTextContent: () => undefined,
            cleanup: () => undefined,
          };
        },
      }),
    };
  },
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
let returnErrorCode: string | undefined;
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
  io.documentOptions = [];
  io.rejectOversizedImage = false;
  io.renderGates = {};
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
  returnErrorCode = "CONTEXT_UNAVAILABLE";
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
          case "pdf.returnOriginal": return returnError ? { ok: false, error: returnError, code: returnErrorCode } : { ok: true, data: { tabId: 8, url: publicSource } };
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
function runtimeListeners() {
  const listeners = new Set<(message: object) => void>();
  chrome.runtime.onMessage.addListener = ((listener: (message: object) => void) => listeners.add(listener)) as typeof chrome.runtime.onMessage.addListener;
  chrome.runtime.onMessage.removeListener = ((listener: (message: object) => void) => listeners.delete(listener)) as typeof chrome.runtime.onMessage.removeListener;
  return listeners;
}

describe("PDF reader workspace", () => {
  it("keeps sidebar edits in the reader leave guard and rejects an old document command", async () => {
    records = [baseRecord()];
    const outgoing: any[] = [];
    const listeners = new Set<(message: any) => void>();
    Object.assign(chrome.runtime, {
      id: "test",
      connect: () => ({
        postMessage: (message: any) => outgoing.push(message),
        onMessage: { addListener: (listener: (message: any) => void) => listeners.add(listener), removeListener: (listener: (message: any) => void) => listeners.delete(listener) },
        onDisconnect: { addListener() {} }, disconnect() {},
      }),
    });
    await mount(`?handoff=${TOKEN}`);
    const state = outgoing.filter((message) => message.type === "state").at(-1).state;
    const draft = { note: "sidebar draft", tags: "", color: "#facc15", base: records[0], editing: true };
    const command = { type: "command", commandId: "draft-1", pageUrl: state.pageUrl, sessionId: "expired", command: { type: "draft", id: "saved-highlight", draft } };
    await act(async () => { for (const listener of listeners) listener(command); });
    expect(unloadBlocked()).toBe(false);
    await act(async () => { for (const listener of listeners) listener({ ...command, sessionId: state.sessionId }); });
    await settle();
    expect(unloadBlocked()).toBe(true);
    await click("返回原阅读器");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("未保存");
    expect(messages.some((message) => message.type === "pdf.returnOriginal")).toBe(false);
    await click("继续编辑");
    putError = "changed elsewhere";
    await act(async () => { for (const listener of listeners) listener({ ...command, commandId: "save-1", sessionId: state.sessionId, command: { type: "save", id: "saved-highlight" } }); });
    await settle();
    const failed = outgoing.filter((message) => message.type === "state").at(-1).state;
    expect(failed.drafts["saved-highlight"].note).toBe("sidebar draft");
    expect(failed.conflicts["saved-highlight"]).toBe(true);
    expect(records[0]!.note).toBe("");
    expect(unloadBlocked()).toBe(true);
  });

  it("opens the existing Chrome sidebar instead of a second notes rail", async () => {
    records = [baseRecord()];
    const openedPanels: number[] = [];
    Object.assign(chrome, {
      tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) },
      sidePanel: { open: async ({ tabId }: { tabId: number }) => { openedPanels.push(tabId); } },
    });
    await mount();
    await click("笔记");
    expect(openedPanels).toEqual([8]);
    expect(host.querySelector(".pdf-workspace")?.classList.contains("notes-open")).toBe(false);
    expect(host.querySelector<HTMLElement>(".pdf-notes")?.hidden ?? true).toBe(true);
    expect(records).toHaveLength(1);
  });

  it("opens the sidebar on the Add note gesture before the asynchronous save", async () => {
    const openedPanels: number[] = [];
    Object.assign(chrome, {
      tabs: { getCurrent: async () => ({ id: 8 }) },
      sidePanel: { open: async ({ tabId }: { tabId: number }) => { openedPanels.push(tabId); } },
    });
    await mount();
    await selectPage();
    putGate = deferred<unknown>();
    await click("添加笔记");
    expect(openedPanels).toEqual([8]);
    expect(host.querySelector(".pdf-workspace")?.classList.contains("notes-open")).toBe(false);
    const pending = puts().at(-1)!;
    if (pending.type !== "annotations.put") throw Error("Missing highlight write");
    putGate.resolve({ ok: true, data: { ...pending.annotation, revision: 1 } });
    await settle();
    expect(host.querySelector(".pdf-workspace")?.classList.contains("notes-open")).toBe(false);
  });

  it.each(["open", "closed"])("restores orphan draft focus after Keep editing when Notes was %s", async (notes) => {
    const listeners = runtimeListeners();
    records = [baseRecord()];
    await mount(`?handoff=${TOKEN}`);
    await editNote("recover editor focus");
    await act(async () => {
      records = [];
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`, deletedId: "saved-highlight" });
    });
    await settle();
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    if (notes === "closed") await click("笔记");
    await click("返回原阅读器");
    const keep = button("继续编辑");
    keep.focus();
    expect(document.activeElement).toBe(keep);
    await click("继续编辑");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector(".pdf-notes")?.hasAttribute("hidden")).toBe(false);
    expect(document.activeElement).toBe(textarea);
  });

  it("keeps focus inside an open leave dialog when its dirty annotation is deleted", async () => {
    const listeners = runtimeListeners();
    records = [baseRecord()];
    await mount(`?handoff=${TOKEN}`);
    await editNote("retain modal focus");
    await click("返回原阅读器");
    const keep = button("继续编辑");
    keep.focus();
    await act(async () => {
      records = [];
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`, deletedId: "saved-highlight" });
    });
    await settle();
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.activeElement).toBe(keep);
    await click("继续编辑");
    expect(document.activeElement).toBe(host.querySelector("textarea"));
  });

  it("preserves an explicit local file after delayed initial settings", async () => {
    const settingsGate = deferred<unknown>();
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "settings.get"
      ? settingsGate.promise : send(message)) as typeof send;
    await mount(`?source=${encodeURIComponent(publicSource)}`, false);
    io.hash = "b".repeat(64);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["%PDF-"], "local-b.pdf")] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    expect(host.querySelector(".pdf-name")?.textContent).toBe("local-b.pdf");
    await act(async () => settingsGate.resolve({ ok: true, data: DEFAULT_SETTINGS }));
    await settle();
    expect(host.querySelector(".pdf-name")?.textContent).toBe("local-b.pdf");
    expect(io.remoteReads).toHaveLength(0);
    expect(new URL(location.href).searchParams.get("document")).toBe("b".repeat(64));
    expect(new URL(location.href).searchParams.has("source")).toBe(false);
  });

  it.each(["deletedId", "list refresh"])("keeps a dirty deleted note editable after %s without resurrecting its record", async (route) => {
    const listeners = runtimeListeners();
    records = [baseRecord(), ...Array.from({ length: 55 }, (_, index) => ({
      ...baseRecord(), id: `other-saved-${index}`,
      target: { ...baseRecord().target, pageNumber: 2, exact: "other passage" },
    }))];
    await mount(`?handoff=${TOKEN}`);
    await editNote("preserve this orphan draft");
    await act(async () => {
      records = records.filter((record) => record.id !== "saved-highlight");
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`,
        ...(route === "deletedId" ? { deletedId: "saved-highlight" } : {}) });
    });
    await settle();
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("preserve this orphan draft");
    expect(host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    const orphan = host.querySelector('[data-pdf-note="saved-highlight"]');
    expect(orphan?.textContent).toContain("saved passage");
    expect(orphan?.textContent).toContain("原标注已被删除");
    expect(orphan?.textContent).not.toContain("载入最新版本");
    expect(host.querySelector(".pdf-notes h2 span")?.textContent).toBe("55");
    await click("笔记");
    await click("返回原阅读器");
    await click("继续编辑");
    expect(host.querySelector(".pdf-notes")?.hasAttribute("hidden")).toBe(false);
    await click("返回原阅读器");
    await click("保存并继续");
    expect(puts()).toHaveLength(0);
    expect(messages.some((message) => message.type === "pdf.returnOriginal")).toBe(false);
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    await click("继续编辑");
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("preserve this orphan draft");
    expect(textarea.disabled).toBe(false);
    textarea.select();
    expect(textarea.selectionEnd - textarea.selectionStart).toBe(textarea.value.length);
    expect(unloadBlocked()).toBe(true);
    await click("放弃草稿");
    expect(unloadBlocked()).toBe(false);
    expect(records).toHaveLength(55);
    expect(records.some((record) => record.id === "saved-highlight")).toBe(false);
    expect(puts()).toHaveLength(0);
    expect(messages.some((message) => message.type === "annotations.restore" || message.type === "annotations.delete")).toBe(false);
  });

  it("does not re-add a deleted note from a save response that arrives after deletion", async () => {
    const listeners = runtimeListeners();
    records = [baseRecord()];
    await mount();
    await editNote("draft being saved");
    putGate = deferred();
    await click("保存");
    await act(async () => {
      records = [];
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`, deletedId: "saved-highlight" });
      putGate!.resolve({ ok: true, data: { ...baseRecord(), note: "draft being saved", revision: 4 } });
    });
    await settle();
    expect(host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("draft being saved");
    expect(unloadBlocked()).toBe(true);
    expect(puts()).toHaveLength(1);
  });

  it("returns focus only when Escape closes an open More menu", async () => {
    await mount();
    const trigger = button("更多");
    await click("更多");
    const item = button("旋转页面");
    item.focus();
    expect(document.activeElement).toBe(item);
    await act(async () => item.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true,
    })));
    await settle();
    expect(host.querySelector(".pdf-more-menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    const pages = host.querySelector<HTMLElement>(".pdf-pages")!;
    pages.focus();
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true,
    })));
    expect(document.activeElement).toBe(pages);
  });

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

  it.each(["NAVIGATION_FAILED", "STORAGE_UNAVAILABLE", "CONTEXT_UNAVAILABLE", "PAGE_CHANGED", undefined])(
    "keeps the original return action retryable after %s", async code => {
      await mount(`?handoff=${TOKEN}`);
      const readerUrl = location.href;
      returnError = "Temporary return failure";
      returnErrorCode = code;
      await click("返回原阅读器");
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Temporary return failure");
      expect(location.href).toBe(readerUrl);
      expect(button("返回原阅读器").disabled).toBe(false);

      returnError = "";
      await click("返回原阅读器");
      expect(messages.filter(message => message.type === "pdf.returnOriginal")).toEqual([
        { type: "pdf.returnOriginal", token: TOKEN }, { type: "pdf.returnOriginal", token: TOKEN },
      ]);
    },
  );

  it.each(["PDF_SOURCE_UNAVAILABLE", "FORBIDDEN"])("replaces an invalid return session with explicit recovery after %s", async code => {
    await mount(`?handoff=${TOKEN}`);
    returnError = "Return session is invalid";
    returnErrorCode = code;
    await click("返回原阅读器");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Return session is invalid");
    expect([...host.querySelectorAll("button")].some(node => node.getAttribute("aria-label") === "返回原阅读器" || node.textContent?.trim() === "返回原阅读器")).toBe(false);
    await click("重新选择 PDF");
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("打开其他 PDF");
    expect(messages.filter(message => message.type === "pdf.returnOriginal")).toEqual([{ type: "pdf.returnOriginal", token: TOKEN }]);
  });

  it("shows an oversized-image failure on its page while preserving notes and the return path", async () => {
    io.pageCount = 2;
    io.rejectOversizedImage = true;
    records = [{ ...baseRecord(), note: "keep this saved note" }];

    await mount(`?handoff=${TOKEN}`);

    expect(io.documentOptions.at(-1)).toMatchObject({
      maxImageSize: 16777216,
      canvasMaxAreaInBytes: 67108864,
      stopAtErrors: true,
    });
    const failedPage = host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')!;
    const healthyPage = host.querySelector<HTMLElement>('[data-page="2"] .pdf-page')!;
    expect(failedPage.dataset.ready).toBe("false");
    expect(failedPage.querySelector('[role="alert"]')?.textContent).toContain("第 1 页");
    expect(failedPage.querySelector('[role="alert"]')?.textContent).toContain("图片过大");
    expect(failedPage.querySelector("svg")).toBeNull();
    expect(failedPage.querySelector(".pdf-area-capture")).toBeNull();
    expect(healthyPage.dataset.ready).toBe("true");

    await click("笔记");
    expect(host.querySelector(".pdf-notes")?.textContent).toContain("keep this saved note");
    expect(button("返回原阅读器")).toBeTruthy();
    expect(records.map((record) => record.id)).toEqual(["saved-highlight"]);
    expect(puts()).toHaveLength(0);
  });

  it("clears old selectable text and reports an ordinary zoom render failure", async () => {
    await mount();
    const page = host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')!;
    expect(page.dataset.ready).toBe("true");
    expect(page.querySelector(".textLayer span")).toBeTruthy();

    const rerender = deferred<void>();
    io.renderGates[1] = rerender.promise;
    await click("放大");
    expect(page.dataset.ready).toBe("false");
    expect(page.querySelector(".textLayer span")).toBeNull();

    const technicalError = "internal PDF.js raster worker failure";
    await act(async () => rerender.reject(new Error(technicalError)));
    await settle();

    const alert = page.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("第 1 页");
    expect(alert?.textContent).toMatch(/失败|无法|错误/);
    expect(alert?.textContent).not.toContain(technicalError);
    expect(page.dataset.ready).toBe("false");
    expect(page.querySelector("canvas")?.width).toBe(0);
    expect(page.querySelector("canvas")?.height).toBe(0);
    expect(page.querySelector(".textLayer")?.childElementCount).toBe(0);
  });

  it("waits for page rendering before showing the area capture layer", async () => {
    io.pageCount = 1;
    const render = deferred<void>();
    io.renderGates[1] = render.promise;

    await mount();
    const page = host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')!;
    expect(page.dataset.ready).toBe("false");
    await click("更多");
    await click("区域标注");
    expect(page.querySelector(".pdf-area-capture")).toBeNull();

    await act(async () => render.resolve());
    await settle();
    expect(page.dataset.ready).toBe("true");
    expect(page.querySelector(".pdf-area-capture")).toBeTruthy();
  });

  it("saves an area from pointerup coordinates before a preview render or pointermove", async () => {
    io.pageCount = 1;
    await mount();
    await click("更多");
    await click("区域标注");
    const page = host.querySelector<HTMLElement>('.pdf-page')!;
    page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 } as DOMRect);
    const capture = page.querySelector<HTMLElement>('.pdf-area-capture')!;
    capture.setPointerCapture = vi.fn();
    capture.hasPointerCapture = () => true;
    capture.releasePointerCapture = vi.fn();
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      capture.dispatchEvent(event);
    };
    await act(async () => {
      pointer('pointerdown', 60, 80);
      pointer('pointerup', 180, 240);
    });
    await settle();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'pdf-area', target: {
      pageNumber: 1, rects: [{ x: expect.closeTo(0.1), y: expect.closeTo(0.7), width: expect.closeTo(0.2), height: expect.closeTo(0.2) }],
    } });
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(7);
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
