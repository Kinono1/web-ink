import { afterEach, beforeEach, expect, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS, type Annotation, type AnnotationPage, type AnnotationQuery, type PdfHandoff, type Request } from "../../src/core/model";
import type { PdfReadingPosition } from "../../src/pdf/reading-position";
import { exportIo, io, noteRenderMetrics, pageRenderMetrics } from "./pdf-reader-mocks";

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

type PdfReaderFixture = {
  root: Root | undefined;
  host: HTMLDivElement;
  records: Annotation[];
  messages: Request[];
  previousRecords: Annotation[];
  previousQuery?: (query: AnnotationQuery) => Promise<AnnotationPage>;
  handoff: PdfHandoff | null;
  writes: Record<string, unknown>[];
  readKeys: string[];
  storedPosition?: PdfReadingPosition;
  readGate?: ReturnType<typeof deferred<Record<string, unknown>>>;
  putGate?: ReturnType<typeof deferred<unknown>>;
  putError: string;
  returnError: string;
  returnErrorCode?: string;
  prefFailure: boolean;
  frames: Map<number, FrameRequestCallback>;
  downloads: Array<{ blob: Blob; fileName: string }>;
};

let reader: PdfReaderFixture;
let frameId = 0;

const objectUrlDescriptors = ["createObjectURL", "revokeObjectURL"].map((name) => [name, Object.getOwnPropertyDescriptor(URL, name)] as const);
const baseRecord = () => ({
  id: "saved-highlight", kind: "pdf-text" as const, pageUrl: `urn:web-ink:pdf:${HASH}`,
  pageTitle: "fixture.pdf", color: "#facc15", note: "", tags: [], revision: 3,
  createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
  target: { documentHash: HASH, fileName: "fixture.pdf", pageNumber: 1,
    rects: [{ x: 0.1, y: 0.7, width: 0.2, height: 0.05 }], exact: "saved passage", prefix: "", suffix: "" },
});

beforeEach(() => {
  pageRenderMetrics.renders.length = 0;
  noteRenderMetrics.renders.length = 0;
  const host = document.createElement("div");
  document.body.append(host);
  history.replaceState(null, "", "/pdf.html");
  io.hash = HASH;
  io.pageCount = 1000;
  io.remoteReads = [];
  io.ieeeReads = [];
  io.ieeeFailure = undefined;
  io.pagesRead = [];
  io.documentOptions = [];
  io.rejectOversizedImage = false;
  io.renderGates = {};
  io.parseGate = undefined;
  io.metadataTitle = "";
  io.metadataDoi = "";
  io.metadataFailure = false;
  io.annotationsRead = [];
  io.renderedPages = [];
  io.nativeByPage = {};
  io.annotationGates = {};
  io.dataReads = 0;
  reader = {
    root: undefined,
    host,
    records: [],
    messages: [],
    previousRecords: [],
    handoff: { token: TOKEN, tabId: 8, returnUrl: publicSource, sourceUrl: publicSource },
    writes: [],
    readKeys: [],
    putError: "",
    returnError: "",
    returnErrorCode: "CONTEXT_UNAVAILABLE",
    prefFailure: false,
    frames: new Map(),
    downloads: [],
  };
  exportIo.writer.mockReset().mockImplementation(async (_bytes, _hash, snapshot) => ({ bytes: new Uint8Array([37, 80, 68, 70, 45]), fileName: "fixture-annotated.pdf", count: snapshot.length }));
  exportIo.verify.mockReset().mockImplementation(async (_source, _output, sourceHash, snapshot) => ({ count: snapshot.length, sourceHash, outputHash: "c".repeat(64) }));
  const blobs = new Map<string, Blob>();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn((blob: Blob) => {
    const url = `blob:export-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn((url: string) => blobs.delete(url)) });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (blob) reader.downloads.push({ blob, fileName: this.download });
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameId;
    reader.frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => reader.frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
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
    tabs: { getCurrent: async () => ({ id: 8 }) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    storage: { local: {
      get: async (key: string) => { reader.readKeys.push(key); return reader.readGate ? reader.readGate.promise : { [key]: reader.storedPosition }; },
      set: async (entries: Record<string, unknown>) => { reader.writes.push(entries); if (reader.prefFailure) throw Error("bookmark unavailable"); },
    } },
    runtime: {
      getURL: (path: string) => new URL(path, "http://localhost/").href,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async (message: Request) => {
        reader.messages.push(message);
        switch (message.type) {
          case "settings.get": return { ok: true, data: DEFAULT_SETTINGS };
          case "annotations.list": return { ok: true, data: reader.records };
          case "annotations.get": return { ok: true, data: [...reader.records, ...reader.previousRecords].find(record => record.id === message.id) ?? null };
          case "annotations.query": {
            if (reader.previousQuery) return { ok: true, data: await reader.previousQuery(message.query) };
            const matching = reader.previousRecords.filter(record => JSON.stringify(record).toLowerCase().includes(message.query.text?.toLowerCase() ?? ""));
            const start = message.query.cursor ? matching.findIndex(record => record.id === message.query.cursor!.id) + 1 : 0;
            const items = matching.slice(start, start + (message.query.limit ?? 25));
            const last = items.at(-1);
            return { ok: true, data: { items, ...(last && start + items.length < matching.length
              ? { nextCursor: { updatedAt: last.updatedAt, id: last.id } } : {}) } };
          }
          case "page.mode.get": return { ok: true, data: { enabled: false } };
          case "pdf.handoff.get": return { ok: true, data: reader.handoff };
          case 'pdf.prepared.claim': {
            if (io.ieeeFailure) return { ok: false, error: 'Prepared PDF unavailable. Return to IEEE and open again.', code: 'PDF_SOURCE_UNAVAILABLE' };
            if (!reader.handoff) return { ok: false, error: 'Missing prepared file' };
            io.ieeeReads.push({ pageUrl: reader.handoff.returnUrl, ...(reader.handoff.sourceUrl ? { sourceUrl: reader.handoff.sourceUrl } : {}) });
            return { ok: true, data: { token: message.token, byteLength: 5, chunks: 1, hash: io.hash } };
          }
          case 'pdf.prepared.chunk': return { ok: true, data: 'JVBERi0=' };
          case 'pdf.prepared.release': return { ok: true, data: undefined };
          case "pdf.returnOriginal": return reader.returnError ? { ok: false, error: reader.returnError, code: reader.returnErrorCode } : { ok: true, data: { tabId: 8, url: publicSource } };
          case "annotations.put": {
            if (reader.putGate) return reader.putGate.promise;
            if (reader.putError) return { ok: false, error: reader.putError, code: "CONFLICT" };
            const saved = { ...message.annotation, revision: message.expectedRevision + 1 };
            reader.records = [...reader.records.filter((record) => record.id !== saved.id), saved];
            return { ok: true, data: saved };
          }
          default: return { ok: true, data: true };
        }
      },
    },
  });
  const sessionValues: Record<string, unknown> = {};
  Object.assign(chrome.storage, { session: {
    get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, sessionValues[key]])),
    set: async (entries: Record<string, unknown>) => Object.assign(sessionValues, entries),
    remove: async (key: string) => { delete sessionValues[key]; },
  } });
});

afterEach(async () => {
  await act(async () => reader.root?.unmount());
  reader.root = undefined;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [name, descriptor] of objectUrlDescriptors) {
    if (descriptor) Object.defineProperty(URL, name, descriptor);
    else Reflect.deleteProperty(URL, name);
  }
});

async function settle() {
  for (let round = 0; round < 12; round++) {
    await act(async () => {
      await Promise.resolve();
      const callbacks = [...reader.frames.values()];
      reader.frames.clear();
      for (const callback of callbacks) callback(0);
    });
  }
}

async function mount(query = "", local = true) {
  history.replaceState(null, "", `/pdf.html${query}`);
  const { PdfReader } = await import("../../src/pdf/PdfReader");
  reader.root = createRoot(reader.host);
  await act(async () => reader.root!.render(createElement(PdfReader)));
  await settle();
  if (local) await chooseLocalPdf(new File(["%PDF-"], "fixture.pdf", { type: "application/pdf" }));
}

async function chooseLocalPdf(file: File) {
  const input = reader.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
}

function button(label: string) {
  const result = [...reader.host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
  expect(result, `action ${label}`).toBeTruthy();
  return result!;
}

async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}

async function openNotes() {
  await click("更多");
  await click("查看标注");
}

async function selectPage(number = 1) {
  const page = reader.host.querySelector<HTMLElement>(`[data-page="${number}"] .pdf-page`)!;
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

function puts() { return reader.messages.filter((message) => message.type === "annotations.put"); }

function unloadBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function editNote(value: string) {
  await openNotes();
  await click("编辑");
  const textarea = reader.host.querySelector<HTMLTextAreaElement>(".pdf-note-editor textarea")!;
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

function sidebarPort() {
  const outgoing: any[] = [];
  const listeners = new Set<(message: any) => void>();
  Object.assign(chrome.runtime, { id: "test", connect: () => ({
    postMessage: (message: any) => outgoing.push(message),
    onMessage: { addListener: (listener: (message: any) => void) => listeners.add(listener), removeListener: (listener: (message: any) => void) => listeners.delete(listener) },
    onDisconnect: { addListener() {} }, disconnect() {},
  }) });
  return {
    outgoing,
    listeners,
    state: () => outgoing.filter((message) => message.type === "state").at(-1)?.state,
    command: async (command: object) => {
      const state = outgoing.filter((message) => message.type === "state").at(-1).state;
      await act(async () => { for (const listener of listeners) listener({ type: "command", commandId: crypto.randomUUID(), pageUrl: state.pageUrl, sessionId: state.sessionId, command }); });
      await settle();
    },
  };
}

export {
  HASH, TOKEN, publicSource, bookmark, baseRecord, reader,
  deferred, settle, mount, chooseLocalPdf, button, click, openNotes, selectPage, puts,
  unloadBlocked, editNote, runtimeListeners, sidebarPort,
  exportIo, io, noteRenderMetrics, pageRenderMetrics,
};
