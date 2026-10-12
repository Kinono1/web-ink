import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS, type Annotation, type PdfHandoff, type Request } from "../src/core/model";
import type { PdfReadingPosition } from "../src/pdf/reading-position";
import { rememberPdfPaperReopen } from "../src/pdf/paper-reopen";

const io = vi.hoisted(() => ({
  hash: "a".repeat(64),
  pageCount: 1000,
  remoteReads: [] as string[],
  ieeeReads: [] as Array<{ pageUrl: string; sourceUrl?: string }>,
  ieeeFailure: undefined as "network" | "login-required" | undefined,
  pagesRead: [] as number[],
  documentOptions: [] as Record<string, unknown>[],
  rejectOversizedImage: false,
  renderGates: {} as Record<number, Promise<unknown> | undefined>,
  parseGate: undefined as Promise<unknown> | undefined,
  metadataTitle: "",
  metadataDoi: "",
  metadataFailure: false,
  annotationsRead: [] as number[],
  renderedPages: [] as number[],
  nativeByPage: {} as Record<number, unknown[]>,
  annotationGates: {} as Record<number, Promise<unknown[]> | undefined>,
  dataReads: 0,
}));
const exportIo = vi.hoisted(() => ({
  writer: vi.fn(), verify: vi.fn(),
}));
vi.mock("../src/pdf/export-client", () => ({ exportPdfInWorker: exportIo.writer }));
vi.mock("../src/pdf/export-verify", () => ({ verifyPdfExport: exportIo.verify }));
vi.mock('../src/pdf/ieee', async (original) => {
  const actual = await original<typeof import('../src/pdf/ieee')>();
  return { ...actual, readIeeePdf: async (input: { pageUrl: string; sourceUrl?: string }) => {
    throw Error('Reader must consume prepared bytes, not download IEEE again');
  } };
});
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
  VerbosityLevel: { ERRORS: 0 },
  getDocument: (options: Record<string, unknown>) => {
    io.documentOptions.push(options);
    return {
      destroy: async () => undefined,
      promise: (io.parseGate ?? Promise.resolve()).then(() => ({
        numPages: io.pageCount,
        getData: async () => { io.dataReads++; return new Uint8Array([37, 80, 68, 70]); },
        getMetadata: async () => {
          if (io.metadataFailure) throw Error("metadata unavailable");
          return { info: { Title: io.metadataTitle }, metadata: {
            get: (name: string) => name === "dc:title" ? io.metadataTitle : name === "prism:doi" ? io.metadataDoi : null,
          } };
        },
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
              clone() { return { ...this }; },
            }),
            render: () => {
              io.renderedPages.push(number);
              // Model the strict stream error after the build-time PDF.js fix.
              const oversizedImage = number === 1 && io.rejectOversizedImage && options.stopAtErrors === true;
              const promise = io.renderGates[number] ?? (oversizedImage
                ? Promise.reject(new Error("Image exceeded maximum allowed size and was removed."))
                : Promise.resolve());
              return { promise, cancel: () => undefined };
            },
            streamTextContent: () => new ReadableStream({ start(controller) {
              controller.enqueue({ items: [{ str: "A selected scientific passage." }] });
              controller.close();
            } }),
            cleanup: () => undefined,
            getAnnotations: async () => { io.annotationsRead.push(number); return io.annotationGates[number] ?? io.nativeByPage[number] ?? []; },
          };
        },
      })),
    };
  },
  TextLayer: class {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    constructor(private options: { container: HTMLElement }) {}
    async render() {
      const span = document.createElement("span");
      span.textContent = "A selected scientific passage.";
      this.options.container.append(span);
      this.textDivs = [span];
      this.textContentItemsStr = [span.textContent!];
    }
    cancel() {}
  },
  AnnotationType: { TEXT: 1, HIGHLIGHT: 9, SQUARE: 5 },
  AnnotationLayer: class { async render() {} destroy() {} },
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
let downloads: Array<{ blob: Blob; fileName: string }>;
const objectUrlDescriptors = ["createObjectURL", "revokeObjectURL"].map((name) => [name, Object.getOwnPropertyDescriptor(URL, name)] as const);
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
  exportIo.writer.mockReset().mockImplementation(async (_bytes, _hash, snapshot) => ({ bytes: new Uint8Array([37, 80, 68, 70, 45]), fileName: "fixture-annotated.pdf", count: snapshot.length }));
  exportIo.verify.mockReset().mockImplementation(async (_source, _output, sourceHash, snapshot) => ({ count: snapshot.length, sourceHash, outputHash: "c".repeat(64) }));
  downloads = [];
  const blobs = new Map<string, Blob>();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn((blob: Blob) => {
    const url = `blob:export-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn((url: string) => blobs.delete(url)) });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (blob) downloads.push({ blob, fileName: this.download });
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
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
          case 'pdf.prepared.claim': {
            if (io.ieeeFailure) return { ok: false, error: 'Prepared PDF unavailable. Return to IEEE and open again.', code: 'PDF_SOURCE_UNAVAILABLE' };
            if (!handoff) return { ok: false, error: 'Missing prepared file' };
            io.ieeeReads.push({ pageUrl: handoff.returnUrl, ...(handoff.sourceUrl ? { sourceUrl: handoff.sourceUrl } : {}) });
            return { ok: true, data: { token: message.token, byteLength: 5, chunks: 1, hash: io.hash } };
          }
          case 'pdf.prepared.chunk': return { ok: true, data: 'JVBERi0=' };
          case 'pdf.prepared.release': return { ok: true, data: undefined };
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
  const sessionValues: Record<string, unknown> = {};
  Object.assign(chrome.storage, { session: {
    get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, sessionValues[key]])),
    set: async (entries: Record<string, unknown>) => Object.assign(sessionValues, entries),
    remove: async (key: string) => { delete sessionValues[key]; },
  } });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
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

it('consumes the prepared IEEE session without downloading again or persisting a ticket', async () => {
  const pageUrl = 'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=11643626';
  const download = 'https://ieeexplore.ieee.org/download?ticket=private';
  handoff = { token: TOKEN, tabId: 8, returnUrl: pageUrl, sourceUrl: download, accessMode: 'site-session', allowedOrigin: 'https://ieeexplore.ieee.org', expiresAt: Date.now() + 600_000 };
  await mount(`?handoff=${TOKEN}`, false);
  expect(io.ieeeReads).toEqual([{ pageUrl, sourceUrl: download }]);
  expect(io.remoteReads).toEqual([]);
  expect(host.querySelector('.pdf-page')).not.toBeNull();
  expect(location.href).not.toContain('private');
  expect(new URL(location.href).searchParams.get('source')).toBe('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626');
  expect(messages.filter(m => m.type === 'pdf.handoff.get')).toHaveLength(3);
});

it('does not reuse IEEE credentials for a different manually opened source on refresh', async () => {
  handoff = { token: TOKEN, tabId: 8, returnUrl: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1', accessMode: 'site-session', allowedOrigin: 'https://ieeexplore.ieee.org', expiresAt: Date.now() + 60000 };
  await mount(`?handoff=${TOKEN}&source=${encodeURIComponent('https://papers.example.test/other.pdf')}&document=${HASH}`, false);
  expect(io.ieeeReads).toEqual([]);
  expect(io.remoteReads).toEqual(['https://papers.example.test/other.pdf']);
  expect(host.querySelector('.pdf-name')?.textContent).toBe('other.pdf');
});

it('keeps IEEE access explicit when permission is missing or rejected', async () => {
  handoff = { token: TOKEN, tabId: 8, returnUrl: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1', accessMode: 'site-session', allowedOrigin: 'https://ieeexplore.ieee.org', expiresAt: Date.now() + 60000 };
  vi.mocked(chrome.permissions.contains as (details: chrome.permissions.Permissions) => Promise<boolean>).mockResolvedValue(false);
  vi.mocked(chrome.permissions.request as (details: chrome.permissions.Permissions) => Promise<boolean>).mockResolvedValue(false);
  await mount(`?handoff=${TOKEN}`, false);
  expect(chrome.permissions.request).not.toHaveBeenCalled();
  expect(io.ieeeReads).toEqual([]);
  await click('允许访问 IEEE 并重试');
  expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://ieeexplore.ieee.org/*'] });
  expect(io.ieeeReads).toEqual([]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('未授予');
  expect([...host.querySelectorAll('button')].some(b => b.textContent === '返回原阅读器')).toBe(true);
});

it('rechecks IEEE expiry after a permission prompt before fetching', async () => {
  handoff = { token: TOKEN, tabId: 8, returnUrl: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1', accessMode: 'site-session', allowedOrigin: 'https://ieeexplore.ieee.org', expiresAt: Date.now() + 60000 };
  vi.mocked(chrome.permissions.contains as (details: chrome.permissions.Permissions) => Promise<boolean>).mockResolvedValue(false);
  vi.mocked(chrome.permissions.request as (details: chrome.permissions.Permissions) => Promise<boolean>).mockImplementation(async () => { handoff!.expiresAt = 0; return true; });
  await mount(`?handoff=${TOKEN}`, false);
  await click('允许访问 IEEE 并重试');
  expect(io.ieeeReads).toEqual([]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('登录读取授权已过期');
});

it('revokes IEEE session access before opening a manually selected local file', async () => {
  handoff = { token: TOKEN, tabId: 8, returnUrl: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1', accessMode: 'site-session', allowedOrigin: 'https://ieeexplore.ieee.org', expiresAt: Date.now() + 60000 };
  await mount(`?handoff=${TOKEN}`, false);
  await click('更多');
  await click('打开其他文件');
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File(['%PDF-'], 'manual.pdf')] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
  expect(messages).toContainEqual({ type: 'pdf.handoff.revoke', token: TOKEN });
  expect(host.querySelector('.pdf-name')?.textContent).toBe('manual.pdf');
});

it('does not try public fetch when an IEEE reader loses its session handoff', async () => {
  handoff = null;
  await mount(`?handoff=${TOKEN}&source=${encodeURIComponent('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1')}&document=${HASH}`, false);
  expect(io.ieeeReads).toEqual([]);
  expect(io.remoteReads).toEqual([]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('返回 IEEE');
});

it.each([['network', '返回 IEEE'], ['login-required', '返回 IEEE']] as const)('returns to IEEE after a prepared session becomes unavailable (%s)', async (failure, label) => {
  handoff = { token: TOKEN, tabId: 8, returnUrl: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1', accessMode: 'site-session', allowedOrigin: 'https://ieeexplore.ieee.org', expiresAt: Date.now() + 60000 };
  io.ieeeFailure = failure;
  await mount(`?handoff=${TOKEN}`, false);
  expect([...host.querySelectorAll('button')].some(b => b.textContent === label)).toBe(true);
  expect([...host.querySelectorAll('button')].some(b => b.textContent === '允许访问 IEEE 并重试')).toBe(false);
});

it('revokes an IEEE grant on pagehide while retaining saved annotations', async () => {
  handoff = { token: TOKEN, tabId: 8, returnUrl: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1', accessMode: 'site-session', allowedOrigin: 'https://ieeexplore.ieee.org', expiresAt: Date.now() + 60000 };
  await mount(`?handoff=${TOKEN}`, false);
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  await settle();
  expect(messages).toContainEqual({ type: 'pdf.handoff.revoke', token: TOKEN });
  expect(messages.some(m => m.type === 'annotations.delete')).toBe(false);
});

it('opens the IEEE paper source instead of pretending a library wrapper is a public PDF', async () => {
  handoff = null;
  await mount(`?source=${encodeURIComponent('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1')}&document=${HASH}`, false);
  expect(io.remoteReads).toEqual([]);
  expect(io.ieeeReads).toEqual([]);
  expect([...host.querySelectorAll('button')].some(b => b.textContent === '返回 IEEE')).toBe(true);
});

it('does not read an expired IEEE session but keeps the return action', async () => {
  handoff = { token: TOKEN, tabId: 8, returnUrl: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1', accessMode: 'site-session', allowedOrigin: 'https://ieeexplore.ieee.org', expiresAt: Date.now() - 1 };
  await mount(`?handoff=${TOKEN}`, false);
  expect(io.ieeeReads).toEqual([]);
  expect(host.textContent).toContain('登录读取授权已过期');
  expect(host.textContent).toContain('返回原阅读器');
});

it('keeps the local-file entry focused on choosing a file without asking for a URL', async () => {
  await mount('?open=local', false);
  expect(host.querySelector('input[type="file"]')).not.toBeNull();
  expect(host.querySelector('input[type="url"]')).toBeNull();
  expect(host.querySelector('h1')?.textContent).toBe('选择电脑上的 PDF');
  expect(io.remoteReads).toEqual([]);
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['%PDF-'], 'local.pdf', { type: 'application/pdf' })] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
  expect(host.querySelector('.pdf-name')?.textContent).toBe('local.pdf');
  expect(io.remoteReads).toEqual([]);
});

it('retains URL input in the generic PDF entry', async () => {
  await mount('', false);
  expect(host.querySelector('input[type="file"]')).not.toBeNull();
  expect(host.querySelector('input[type="url"]')).not.toBeNull();
});
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
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
it("uses PDF metadata for the reader and new annotations without renaming old records", async () => {
  io.metadataTitle = "A scientific paper";
  io.metadataDoi = "10.1109/TII.2026.3716639";
  records = [baseRecord()];
  await mount();
  const display = "A scientific paper — DOI: 10.1109/TII.2026.3716639";
  expect(host.querySelector(".pdf-name")?.textContent).toBe(display);
  await selectPage();
  await click("高亮 #facd5a");
  const write = puts().at(-1)!;
  if (write.type !== "annotations.put") throw Error("Missing annotation write");
  expect(write.annotation.pageTitle).toBe(display);
  if (write.annotation.kind !== "pdf-text") throw Error("Not a text annotation");
  expect(write.annotation.target.fileName).toBe(display);
  expect(records.find(record => record.id === "saved-highlight")?.pageTitle).toBe("fixture.pdf");
});
it("keeps a PDF usable when reading its metadata fails", async () => {
  io.metadataFailure = true;
  await mount();
  expect(host.querySelector(".pdf-name")?.textContent).toBe("fixture.pdf");
  await selectPage();
  expect(host.querySelector(".pdf-selection")).not.toBeNull();
});
function unloadBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
async function editNote(value: string) {
  await openNotes();
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

function sidebarPort() {
  const outgoing: any[] = [];
  const listeners = new Set<(message: any) => void>();
  Object.assign(chrome.runtime, { id: "test", connect: () => ({
    postMessage: (message: any) => outgoing.push(message),
    onMessage: { addListener: (listener: (message: any) => void) => listeners.add(listener), removeListener: (listener: (message: any) => void) => listeners.delete(listener) },
    onDisconnect: { addListener() {} }, disconnect() {},
  }) });
  return {
    state: () => outgoing.filter((message) => message.type === "state").at(-1)?.state,
    command: async (command: object) => {
      const state = outgoing.filter((message) => message.type === "state").at(-1).state;
      await act(async () => { for (const listener of listeners) listener({ type: "command", commandId: crypto.randomUUID(), pageUrl: state.pageUrl, sessionId: state.sessionId, command }); });
      await settle();
    },
  };
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("PDF annotation export and original notes", () => {
  it.each(["导出带标注的 PDF…", "导出给 AI"])("reveals a dirty Web Ink editor after Keep editing from Original while requesting %s", async (label) => {
    io.pageCount = 2;
    records = [baseRecord()];
    await mount();
    await editNote("Keep this Web Ink draft");
    await click("原文件");
    expect(host.querySelector("textarea")).toBeNull();
    await click("更多");
    await click(label);
    await click("继续编辑");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this Web Ink draft");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(host.querySelector('.pdf-annotation-filters button[aria-pressed="true"]')?.textContent).toBe("Web Ink");
    expect(unloadBlocked()).toBe(true);
    expect(puts()).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it("reveals an orphan editor and keeps its conflict state after failed Save and continue from Original", async () => {
    io.pageCount = 2;
    records = [baseRecord()];
    const listeners = runtimeListeners();
    const port = sidebarPort();
    await mount();
    await editNote("Keep this conflicted draft");
    await click("原文件");
    await click("更多");
    await click("导出给 AI");
    putError = "changed elsewhere";
    await click("保存并继续");
    expect(puts()).toHaveLength(1);
    await act(async () => {
      records = [];
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`, deletedId: "saved-highlight" });
    });
    await settle();
    await click("继续编辑");
    const note = host.querySelector('[data-pdf-note="saved-highlight"]')!;
    expect(note?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this conflicted draft");
    expect(note?.textContent).toContain("原标注已被删除");
    expect(port.state().conflicts["saved-highlight"]).toBe(true);
    expect(unloadBlocked()).toBe(true);
    expect(records).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it.each([2, 1, 0])("accounts for exact JSON array bytes and advances past a native record of cap minus %i", async (remainingBytes) => {
    const cap = 4 * 1024 * 1024;
    const original = { key: `${HASH}:1:parent`, documentHash: HASH, pageNumber: 1, id: "parent", subtype: "Text", contents: "",
      replies: Array.from({ length: 5 }, (_, i) => ({ id: `reply-${i}`, subtype: "Text", contents: "", inReplyTo: "parent", replyType: "R" })) };
    let bodyBytes = cap - remainingBytes - new TextEncoder().encode(JSON.stringify(original)).byteLength;
    for (const reply of original.replies) {
      const length = Math.min(1_000_000, bodyBytes);
      reply.contents = "n".repeat(length);
      bodyBytes -= length;
    }
    expect(bodyBytes).toBe(0);
    expect(new TextEncoder().encode(JSON.stringify(original)).byteLength).toBe(cap - remainingBytes);
    io.pageCount = 2;
    io.nativeByPage[1] = [
      { id: "parent", subtype: "Text", contentsObj: { str: "" } },
      ...original.replies.map((reply) => ({ id: reply.id, subtype: reply.subtype, contentsObj: { str: reply.contents },
        inReplyTo: reply.inReplyTo, replyType: reply.replyType })),
      { id: "following", subtype: "Text", contentsObj: { str: "Following original note" } },
    ];
    const port = sidebarPort();
    await mount();
    expect(port.state().nativeTotalCount).toBe(2);
    expect(port.state().nativePageEnd).toBe(1);
    if (remainingBytes === 2) {
      expect(port.state().nativeRecords.map((record: any) => record.id)).toEqual(["parent"]);
      expect(new TextEncoder().encode(JSON.stringify(port.state().nativeRecords)).byteLength).toBe(cap);
      expect(port.state().nativeError).toBe("");
    } else {
      expect(port.state().nativeRecords).toHaveLength(0);
      expect(port.state().nativeError).toContain("超过侧栏显示上限");
    }
    await port.command({ type: "more-native" });
    expect(port.state().nativeOffset).toBe(1);
    expect(port.state().nativePageEnd).toBe(2);
    expect(port.state().nativeRecords.map((record: any) => record.id)).toEqual(["following"]);
    expect(port.state().nativeError).toBe("");
  });

  it("publishes at most 50 original cards per page and retains the complete count for navigation", async () => {
    io.pageCount = 3;
    io.nativeByPage[1] = Array.from({ length: 60 }, (_, i) => ({ id: `original-${i}`, subtype: "Text", contentsObj: { str: `Original ${i}` } }));
    const port = sidebarPort();
    await mount();
    expect(port.state().nativeRecords).toHaveLength(50);
    expect(port.state().nativeTotalCount).toBe(60);
    expect(port.state().nativeLimit).toBe(50);
    await port.command({ type: "more-native" });
    expect(port.state().nativeRecords).toHaveLength(10);
    expect(port.state().nativeRecords[0].id).toBe("original-50");
    expect(port.state().nativeOffset).toBe(50);
    await port.command({ type: "previous-native" });
    expect(port.state().nativeRecords).toHaveLength(50);
    expect(port.state().nativeRecords[0].id).toBe("original-0");
  });

  it("refuses an AI snapshot over the combined 50k annotation limit without emitting a file", async () => {
    io.pageCount = 25;
    records = Array.from({ length: 50_000 }, (_, i) => ({ ...baseRecord(), id: `saved-${i}`, target: { ...baseRecord().target, pageNumber: 25 } }));
    io.nativeByPage[1] = [{ id: "original", subtype: "Text", contentsObj: { str: "Original note" } }];
    await mount();
    await click("更多");
    await click("导出给 AI");
    expect(downloads).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("50,000");
  });

  it("refuses an AI snapshot over 20 MiB instead of downloading JSON the adapter cannot read", async () => {
    io.pageCount = 25;
    records = Array.from({ length: 2100 }, (_, i) => ({ ...baseRecord(), id: `saved-${i}`, note: "n".repeat(9999), target: { ...baseRecord().target, pageNumber: 25 } }));
    await mount();
    await click("更多");
    await click("导出给 AI");
    expect(downloads).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("20 MiB");
  });

  it("freezes the complete saved PDF snapshot at click and starts a download only after independent verification", async () => {
    records = Array.from({ length: 65 }, (_, i) => ({ ...baseRecord(), id: `saved-${i}`, note: `Saved ${i}` }));
    records.push({ ...baseRecord(), id: "other-file", pageUrl: `urn:web-ink:pdf:${"b".repeat(64)}`,
      target: { ...baseRecord().target, documentHash: "b".repeat(64) } });
    const writing = deferred<any>();
    const verification = deferred<any>();
    exportIo.writer.mockReturnValue(writing.promise);
    exportIo.verify.mockReturnValue(verification.promise);
    await mount();
    expect(io.dataReads).toBe(0);
    expect(exportIo.writer).not.toHaveBeenCalled();
    await click("更多");
    await click("导出带标注的 PDF…");
    expect(io.dataReads).toBe(1);
    expect(host.textContent).toContain("正在写入");
    const [sourceBytes, hash, snapshot, signal, fileName] = exportIo.writer.mock.calls[0]!;
    expect(Array.from(sourceBytes)).toEqual([37, 80, 68, 70]);
    expect(hash).toBe(HASH);
    expect(fileName).toBe("fixture.pdf");
    expect(snapshot).toHaveLength(65);
    records[0]!.note = "Changed after click";
    expect(snapshot[0]).toMatchObject({ id: "saved-0", revision: 3, note: "Saved 0" });
    expect(signal.aborted).toBe(false);
    await click("更多");
    expect(button("导出带标注的 PDF…").disabled).toBe(true);
    await act(async () => writing.resolve({ bytes: new Uint8Array([37, 80, 68, 70, 45]), fileName: "fixture-annotated.pdf", count: 65 }));
    await settle();
    expect(exportIo.verify).toHaveBeenCalledWith(sourceBytes, new Uint8Array([37, 80, 68, 70, 45]), HASH, snapshot, signal);
    expect(downloads).toHaveLength(0);
    expect(host.textContent).toContain("正在校验");
    await act(async () => verification.resolve({ count: 65, sourceHash: HASH, outputHash: "c".repeat(64) }));
    await settle();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.fileName).toBe("fixture-annotated.pdf");
    expect(downloads[0]!.blob.type).toBe("application/pdf");
    expect(host.textContent).toContain("已生成并开始下载");
    expect(puts()).toHaveLength(0);
  });

  it.each(["writer", "verification"])("keeps saved notes and refuses a PDF download after %s failure", async (stage) => {
    records = [baseRecord()];
    if (stage === "writer") exportIo.writer.mockRejectedValue(Error("PDF export was refused"));
    else exportIo.verify.mockRejectedValue(Error("PDF preservation check failed"));
    await mount();
    await click("更多");
    await click("导出带标注的 PDF…");
    expect(downloads).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(stage === "writer" ? "PDF export was refused" : "PDF preservation check failed");
    expect(records).toEqual([baseRecord()]);
    expect(puts()).toHaveLength(0);
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it.each(["cancel", "leave", "pagehide", "unmount"])("aborts the owned export on %s and ignores a late worker result", async (action) => {
    const writing = deferred<any>();
    exportIo.writer.mockReturnValue(writing.promise);
    await mount();
    await click("更多");
    await click("导出带标注的 PDF…");
    const signal = exportIo.writer.mock.calls[0]![3] as AbortSignal;
    if (action === "cancel") await click("取消导出");
    else if (action === "leave") await click("重新选择 PDF");
    else if (action === "pagehide") await act(async () => window.dispatchEvent(new Event("pagehide")));
    else { await act(async () => root!.unmount()); root = undefined; }
    expect(signal.aborted).toBe(true);
    await act(async () => writing.resolve({ bytes: new Uint8Array([37, 80, 68, 70, 45]), fileName: "late.pdf", count: 0 }));
    await settle();
    expect(exportIo.verify).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
  });

  it("exports the saved revision after Save and continue rather than the stale draft base", async () => {
    records = [baseRecord()];
    await mount();
    await editNote("Saved for PDF export");
    await click("更多");
    await click("导出带标注的 PDF…");
    expect(exportIo.writer).not.toHaveBeenCalled();
    await click("保存并继续");
    expect(exportIo.writer.mock.calls[0]![2]).toEqual([{ ...baseRecord(), note: "Saved for PDF export", revision: 4,
      updatedAt: records[0]!.updatedAt }]);
    expect(host.querySelector('[aria-label="未保存的内容"]')).toBeNull();
    expect(downloads).toHaveLength(1);
  });

  it("downloads a standalone AI snapshot of all saved current-file notes and original notes without database writes", async () => {
    io.pageCount = 25;
    records = Array.from({ length: 65 }, (_, i) => ({ ...baseRecord(), id: `saved-${i}`, note: `Saved ${i}` }));
    records.push({ ...baseRecord(), id: "other-file", pageUrl: `urn:web-ink:pdf:${"b".repeat(64)}`,
      target: { ...baseRecord().target, documentHash: "b".repeat(64) } });
    io.nativeByPage[24] = [{ id: "24R", subtype: "Text", contentsObj: { str: "Original late-page note" } }];
    await mount();
    await click("更多");
    await click("导出给 AI");
    expect(downloads).toHaveLength(1);
    const exported = JSON.parse(await blobText(downloads[0]!.blob));
    expect(Object.keys(exported).sort()).toEqual(["annotations", "document", "exportedAt", "format", "nativeAnnotations", "schemaVersion"]);
    expect(exported).toMatchObject({ format: "web-ink-pdf-notes", schemaVersion: 1,
      document: { documentHash: HASH, fileName: "fixture.pdf" } });
    expect(exported.annotations).toHaveLength(65);
    expect(exported.annotations.at(-1)).toMatchObject({ id: "saved-64", revision: 3, note: "Saved 64" });
    expect(exported.nativeAnnotations).toEqual([{ key: `${HASH}:24:24R`, documentHash: HASH, pageNumber: 24,
      id: "24R", subtype: "Text", contents: "Original late-page note" }]);
    expect(io.dataReads).toBe(0);
    expect(puts()).toHaveLength(0);
    expect(messages.some((message) => /backup|export|import/.test(message.type))).toBe(false);
    expect(host.textContent).toContain("已生成并开始下载");
  });

  it("cancels AI export before its final original-note batch and never downloads a partial snapshot", async () => {
    io.pageCount = 25;
    const reading = deferred<unknown[]>();
    io.annotationGates[12] = reading.promise;
    await mount();
    await click("更多");
    await click("导出给 AI");
    expect(host.textContent).toContain("正在准备");
    await click("取消导出");
    await act(async () => reading.resolve([{ id: "late", subtype: "Text", contentsObj: { str: "Late original note" } }]));
    await settle();
    expect(downloads).toHaveLength(0);
    expect(puts()).toHaveLength(0);
    expect(host.textContent).toContain("已取消导出");
  });

  it.each(["导出带标注的 PDF…", "导出给 AI"])("guards a dirty note before %s and retains failed saves", async (label) => {
    records = [baseRecord()];
    await mount();
    await editNote("draft for export");
    await click("更多");
    await click(label);
    expect(host.querySelector('[aria-label="未保存的内容"]')).toBeTruthy();
    expect(io.dataReads).toBe(0);
    putError = "cannot save export draft";
    await click("保存并继续");
    expect(host.querySelector("textarea")?.value).toBe("draft for export");
    expect(host.querySelector('[aria-label="未保存的内容"]')).toBeTruthy();
    expect(io.dataReads).toBe(0);
  });

  it("reads original notes lazily without rendering canvases for the remaining pages", async () => {
    io.pageCount = 25;
    io.nativeByPage[2] = [{ id: "10R", subtype: "Text", contentsObj: { str: "Visible original note" } }];
    io.nativeByPage[24] = [{ id: "24R", subtype: "Text", contentsObj: { str: "Last original note" } }];
    const port = sidebarPort();
    await mount();
    expect(port.state().nativeFilter).toBe("web-ink");
    expect(io.annotationsRead.length).toBeLessThan(8);
    expect(port.state().nativeRecords.some((record: any) => record.contents === "Visible original note")).toBe(true);
    const renders = io.renderedPages.slice();
    await port.command({ type: "filter", filter: "original" });
    for (let round = 0; round < 10 && port.state().nativeProgress?.completed !== 25; round++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      await settle();
    }
    expect(port.state().nativeRecords.some((record: any) => record.contents === "Last original note")).toBe(true);
    expect(port.state().nativeProgress).toEqual({ completed: 25, total: 25 });
    expect(io.renderedPages).toEqual(renders);
    expect(puts()).toHaveLength(0);
  });

  it("cancels an original-note scan and rejects its late state after a document change", async () => {
    io.pageCount = 25;
    const reading = deferred<unknown[]>();
    io.annotationGates[12] = reading.promise;
    const port = sidebarPort();
    await mount();
    await port.command({ type: "filter", filter: "all" });
    expect(port.state().nativeLoading).toBe(true);
    await port.command({ type: "cancel-native" });
    expect(port.state().nativeLoading).toBe(false);
    await click("更多");
    await click("打开其他文件");
    io.hash = "b".repeat(64);
    io.annotationGates = {};
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["%PDF-"], "replacement.pdf")] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    await act(async () => reading.resolve([{ id: "late", subtype: "Text", contentsObj: { str: "Old file note" } }]));
    await settle();
    expect(port.state().pageUrl).toBe(`urn:web-ink:pdf:${"b".repeat(64)}`);
    expect(port.state().nativeRecords.some((record: any) => record.contents === "Old file note")).toBe(false);
  });
});

describe("PDF reader workspace", () => {
  it("cancels a pending focus entry when opening annotations", async () => {
    const closeGate = deferred<void>();
    const close = vi.fn(() => closeGate.promise);
    Object.assign(chrome, { tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) }, sidePanel: { open: async () => {}, close } });
    await mount();
    await click("更多");
    await click("专注阅读");
    expect(close).toHaveBeenCalledWith({ windowId: 1 });
    await click("查看标注");
    await act(async () => closeGate.resolve());
    await settle();
    expect(host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    await click("更多");
    expect(button("旋转页面").disabled).toBe(false);
  });

  it("cancels a pending focus entry when Escape closes More", async () => {
    const closeGate = deferred<void>();
    Object.assign(chrome, { tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) }, sidePanel: { open: async () => {}, close: () => closeGate.promise } });
    await mount();
    await click("更多");
    await click("专注阅读");
    const pages = host.querySelector<HTMLElement>(".pdf-pages")!;
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await settle();
    expect(host.querySelector(".pdf-more-menu")).toBeNull();
    expect(host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    await act(async () => closeGate.resolve());
    await settle();
    expect(host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    await click("更多");
    expect(button("旋转页面").disabled).toBe(false);
  });

  it("cancels a pending focus entry before opening another source", async () => {
    const closeGate = deferred<void>();
    Object.assign(chrome, { tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) }, sidePanel: { open: async () => {}, close: () => closeGate.promise } });
    await mount();
    await click("更多");
    await click("专注阅读");
    await click("打开其他文件");
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("打开其他 PDF");
    await act(async () => closeGate.resolve());
    await settle();
    expect(host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    expect(host.querySelector(".pdf-focus-controls")).toBeNull();
  });

  it("enters focus without changing zoom or saved records and exits by Escape", async () => {
    await mount();
    const pages = host.querySelector<HTMLElement>(".pdf-pages")!;
    pages.scrollTop = 240;
    await click("更多");
    await click("专注阅读");
    expect(host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("true");
    expect(host.querySelector<HTMLElement>(".pdf-toolbar")?.hidden).toBe(true);
    expect(host.querySelector(".pdf-focus-controls")).toBeTruthy();
    expect(pages.scrollTop).toBe(240);
    expect(puts()).toHaveLength(0);
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    expect(host.querySelector<HTMLElement>(".pdf-toolbar")?.hidden).toBe(false);
    expect(host.querySelector(".pdf-focus-controls")).toBeNull();
  });

  it("requests closing only this window's panel and offers a manual hint on failure", async () => {
    const close = vi.fn(async () => { throw Error("close unavailable"); });
    Object.assign(chrome, { tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) }, sidePanel: { open: async () => {}, close } });
    await mount();
    await click("更多");
    await click("专注阅读");
    expect(close).toHaveBeenCalledWith({ windowId: 1 });
    expect(host.querySelector(".pdf-focus-hint")?.textContent).toContain("手动");
    await click("退出专注");
    expect(host.querySelector(".pdf-focus-controls")).toBeNull();
  });

  it("saves a preset with its label tag only on explicit action and rejects a collapsed stale shortcut", async () => {
    await mount();
    await selectPage();
    expect(puts()).toHaveLength(0);
    await click("重要");
    expect(puts()[0]!.annotation.color).toBe("#facd5a");
    expect(puts()[0]!.annotation.tags).toEqual(["重要"]);
    await selectPage();
    getSelection()?.removeAllRanges();
    const pages = host.querySelector<HTMLElement>(".pdf-pages")!;
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", { key: "!", code: "Digit1", altKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    expect(puts()).toHaveLength(1);
    await selectPage();
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", { key: "@", code: "Digit2", altKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    await settle();
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.annotation.tags).toEqual(["疑问"]);
  });

  it("updates shared preset choices from local preference changes without writing records", async () => {
    let listener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;
    const removeListener = vi.fn();
    Object.assign(chrome.storage, { onChanged: { addListener: (next: typeof listener) => { listener = next; }, removeListener } });
    await mount();
    await selectPage();
    await act(async () => listener?.({ "ui.annotationPresets": { newValue: [{ id: "review", label: "待复核", color: "#69b0f1" }] } }, "local"));
    await settle();
    expect(button("待复核")).toBeTruthy();
    expect(puts()).toHaveLength(0);
    await act(async () => root!.unmount()); root = undefined;
    expect(removeListener).toHaveBeenCalled();
  });

  it("restores a pending stored preset after cancelling its editor and writes its tag", async () => {
    const initialRead = deferred<Record<string, unknown>>();
    Object.assign(chrome.storage.local, { get: async (key: string) => {
      readKeys.push(key);
      return key === "ui.annotationPresets" ? initialRead.promise : { [key]: storedPosition };
    } });
    await mount();
    expect(readKeys).toContain("ui.annotationPresets");
    await click("更多");
    await click("标注预设…");
    await click("取消");
    await act(async () => initialRead.resolve({ "ui.annotationPresets": [{ id: "review", label: "待复核", color: "#69b0f1" }] }));
    await settle();
    await selectPage();
    expect(button("待复核")).toBeTruthy();
    await click("待复核");
    expect(puts()[0]!.annotation.tags).toEqual(["待复核"]);
  });

  it("keeps an explicitly saved preset when an older initial read resolves later", async () => {
    const initialRead = deferred<Record<string, unknown>>();
    Object.assign(chrome.storage.local, { get: async (key: string) => {
      readKeys.push(key);
      return key === "ui.annotationPresets" ? initialRead.promise : { [key]: storedPosition };
    } });
    await mount();
    await click("更多");
    await click("标注预设…");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="名称 1"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "已保存");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("保存");
    await act(async () => initialRead.resolve({ "ui.annotationPresets": [{ id: "stale", label: "过期", color: "#69b0f1" }] }));
    await settle();
    await selectPage();
    expect(button("已保存")).toBeTruthy();
    expect([...host.querySelectorAll("button")].some((node) => node.textContent?.trim() === "过期")).toBe(false);
    await click("已保存");
    expect(puts()[0]!.annotation.tags).toEqual(["已保存"]);
  });

  it("saves the explicit metadata DOI as the source for new signed-in IEEE annotations", async () => {
    io.metadataDoi = "10.1109/TII.2026.3716639";
    handoff = { token: TOKEN, tabId: 8, returnUrl: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626",
      accessMode: "site-session", allowedOrigin: "https://ieeexplore.ieee.org", expiresAt: Date.now() + 60000 };
    await mount(`?handoff=${TOKEN}`, false);
    await selectPage();
    await click("高亮 #facd5a");
    const saved = puts()[0]?.annotation;
    expect(saved?.kind === "pdf-text" && saved.target.sourceUrl).toBe("https://doi.org/10.1109/TII.2026.3716639");
  });
  it("restores the selected legacy record page after a fresh IEEE login handoff", async () => {
    const original = baseRecord();
    const saved = { ...original, target: { ...original.target, pageNumber: 3,
      sourceUrl: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626" } };
    records = [saved];
    await rememberPdfPaperReopen(saved.target, undefined, 8);
    handoff = { token: TOKEN, tabId: 8, returnUrl: saved.target.sourceUrl,
      accessMode: "site-session", allowedOrigin: "https://ieeexplore.ieee.org", expiresAt: Date.now() + 60000 };
    await mount(`?handoff=${TOKEN}`, false);
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("3");
    expect(host.querySelector('[data-pdf-annotation="saved-highlight"]')).not.toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it("offers previous annotations without overlaying them on a changed IEEE download", async () => {
    const original = baseRecord();
    const saved = { ...original, target: { ...original.target,
      sourceUrl: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626" } };
    await rememberPdfPaperReopen(saved.target, undefined, 8);
    io.hash = "b".repeat(64);
    handoff = { token: TOKEN, tabId: 8, returnUrl: saved.target.sourceUrl,
      accessMode: "site-session", allowedOrigin: "https://ieeexplore.ieee.org", expiresAt: Date.now() + 60000 };
    await mount(`?handoff=${TOKEN}`, false);
    expect(host.textContent).toContain("旧标注已保留");
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "查看之前的标注")).toBe(true);
    expect(host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    expect(puts()).toHaveLength(0);
  });
  it("refreshes the early annotation snapshot after subscribing to the parsed document", async () => {
    const listeners = runtimeListeners();
    const parsing = deferred<unknown>();
    io.parseGate = parsing.promise;
    const initial = baseRecord();
    records = [initial];
    const send = chrome.runtime.sendMessage;
    let reads = 0;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && ++reads === 1
      ? Promise.resolve({ ok: true, data: [initial] }) : send(message)) as typeof send;
    await mount();
    const changed = { ...initial, id: "imported-during-parse", color: "#7cc868" };
    records = [changed];
    await act(async () => {
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: initial.pageUrl });
      parsing.resolve(undefined);
    });
    await settle();
    expect(host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    expect(host.querySelector('[data-pdf-annotation="imported-during-parse"]')?.getAttribute("fill")).toBe("#7cc868");
  });

  it("does not replace live notification updates with a late refresh snapshot", async () => {
    const listeners = runtimeListeners();
    const refreshGate = deferred<unknown>();
    const initial = baseRecord();
    records = [initial];
    const send = chrome.runtime.sendMessage;
    let reads = 0;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && ++reads === 2
      ? refreshGate.promise : send(message)) as typeof send;
    await mount();
    expect(reads).toBe(2);
    const changed = { ...initial, id: "live-replacement", revision: 2 };
    records = [changed];
    await act(async () => {
      for (const listener of listeners) {
        listener({ type: "annotations.changed", pageUrl: initial.pageUrl, deletedId: initial.id });
        listener({ type: "annotations.changed", pageUrl: initial.pageUrl, annotation: changed });
      }
      refreshGate.resolve({ ok: true, data: [initial] });
    });
    await settle();
    expect(host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    expect(host.querySelector('[data-pdf-annotation="live-replacement"]')).toBeTruthy();
    expect(reads).toBe(3);
  });

  it("rechecks the latest snapshot when an obsolete refresh fails", async () => {
    const listeners = runtimeListeners();
    const refreshGate = deferred<unknown>();
    const initial = baseRecord();
    records = [initial];
    const send = chrome.runtime.sendMessage;
    let reads = 0;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && ++reads === 2
      ? refreshGate.promise : send(message)) as typeof send;
    await mount();
    const changed = { ...initial, color: "#7cc868", revision: 2 };
    records = [changed];
    await act(async () => {
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: initial.pageUrl, annotation: changed });
      refreshGate.reject(new Error("obsolete snapshot failed"));
    });
    await settle();
    expect(reads).toBe(3);
    expect(host.textContent).not.toContain("obsolete snapshot failed");
    expect(host.querySelector('[data-pdf-annotation="saved-highlight"]')?.getAttribute("fill")).toBe("#7cc868");
  });

  it("does not reread a disposed document after a queued notification and late refresh", async () => {
    const listeners = runtimeListeners();
    const refreshGate = deferred<unknown>();
    const initial = baseRecord();
    records = [initial];
    const send = chrome.runtime.sendMessage;
    let reads = 0;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && ++reads === 2
      ? refreshGate.promise : send(message)) as typeof send;
    await mount();
    const queuedListeners = [...listeners];
    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => {
      for (const listener of queuedListeners) listener({ type: "annotations.changed", pageUrl: initial.pageUrl, annotation: initial });
      refreshGate.resolve({ ok: true, data: [initial] });
    });
    await settle();
    expect(reads).toBe(2);
  });

  it("uses a changed default color for the next annotation without recoloring saved marks", async () => {
    const listeners = runtimeListeners();
    records = [baseRecord()];
    await mount();
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "settings.get"
      ? Promise.resolve({ ok: true, data: { ...DEFAULT_SETTINGS, defaultColor: "#7cc868" } }) : send(message)) as typeof send;
    await act(async () => { for (const listener of listeners) listener({ type: "settings.changed" }); });
    await settle();
    await selectPage();
    await click("添加笔记");
    expect(puts()[0]?.annotation.color).toBe("#7cc868");
    expect(records.find(record => record.id === "saved-highlight")?.color).toBe("#facc15");
  });

  it("loads saved annotations while PDF parsing is pending, and publishes both together", async () => {
    const parsing = deferred<unknown>();
    const annotations = deferred<unknown>();
    io.parseGate = parsing.promise;
    records = [baseRecord()];
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list"
      ? (messages.push(message), annotations.promise) : send(message)) as typeof send;
    await mount();
    expect(messages.some(message => message.type === "annotations.list")).toBe(true);
    expect(host.querySelector(".pdf-page")).toBeNull();
    await act(async () => parsing.resolve(undefined));
    await settle();
    // A document must not become editable before its existing records are known.
    expect(host.querySelector(".pdf-page")).toBeNull();
    await act(async () => annotations.resolve({ ok: true, data: records }));
    await settle();
    expect(host.querySelector('.pdf-page[data-ready="true"]')).toBeTruthy();
    expect(host.querySelector(".pdf-marks rect")).toBeTruthy();
  });

  it("ignores a replaced document's late parse and annotation results", async () => {
    const parsing = deferred<unknown>();
    const annotations = deferred<unknown>();
    io.parseGate = parsing.promise;
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && message.pageUrl === `urn:web-ink:pdf:${HASH}`
      ? annotations.promise : send(message)) as typeof send;
    await mount();
    await act(async () => root!.unmount());
    root = undefined;
    io.parseGate = undefined;
    io.hash = "b".repeat(64);
    await mount("", false);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["%PDF-"], "replacement.pdf")] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    await act(async () => {
      parsing.resolve(undefined);
      annotations.resolve({ ok: true, data: [baseRecord()] });
    });
    await settle();
    expect(host.querySelector(".pdf-name")?.textContent).toBe("replacement.pdf");
    expect(host.querySelector(".pdf-marks rect")).toBeNull();
    expect(new URL(location.href).searchParams.get("document")).toBe("b".repeat(64));
  });

  it("keeps a document closed when annotation loading fails before parsing completes", async () => {
    const parsing = deferred<unknown>();
    io.parseGate = parsing.promise;
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list"
      ? Promise.resolve({ ok: false, error: "Saved records unavailable" }) : send(message)) as typeof send;
    await mount();
    expect(host.textContent).toContain("Saved records unavailable");
    await act(async () => parsing.resolve(undefined));
    await settle();
    expect(host.querySelector(".pdf-page")).toBeNull();
  });

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

  it("preserves an older sidebar draft as a conflict before any database write", async () => {
    const old = baseRecord();
    records = [{ ...old, revision: 4, note: "Updated elsewhere" }];
    const outgoing: any[] = [];
    const listeners = new Set<(message: any) => void>();
    Object.assign(chrome.runtime, { id: "test", connect: () => ({
      postMessage: (message: any) => outgoing.push(message),
      onMessage: { addListener: (listener: (message: any) => void) => listeners.add(listener), removeListener: (listener: (message: any) => void) => listeners.delete(listener) },
      onDisconnect: { addListener() {} }, disconnect() {},
    }) });
    await mount();
    const state = outgoing.filter((message) => message.type === "state").at(-1).state;
    await act(async () => { for (const listener of listeners) listener({ type: "command", commandId: "replayed", pageUrl: state.pageUrl, sessionId: state.sessionId,
      command: { type: "draft", id: old.id, draft: { note: "Recovered typed input", color: old.color, tags: "", base: old, editing: true } } }); });
    await settle();
    const recovered = outgoing.filter((message) => message.type === "state").at(-1).state;
    expect(recovered.drafts[old.id].note).toBe("Recovered typed input");
    expect(recovered.conflicts[old.id]).toBe(true);
    expect(unloadBlocked()).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it("opens the existing Chrome sidebar instead of a second notes rail", async () => {
    records = [baseRecord()];
    const openedPanels: number[] = [];
    const listeners = new Set<(message: any) => void>();
    Object.assign(chrome.runtime, { id: "test", connect: () => ({
      postMessage() {},
      onMessage: { addListener: (listener: (message: any) => void) => listeners.add(listener), removeListener: (listener: (message: any) => void) => listeners.delete(listener) },
      onDisconnect: { addListener() {} }, disconnect() {},
    }) });
    Object.assign(chrome, {
      tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) },
      sidePanel: { open: async ({ tabId }: { tabId: number }) => { openedPanels.push(tabId); } },
    });
    await mount();
    expect(host.querySelector('.pdf-toolbar button[aria-label="笔记"]')).toBeNull();
    await click("更多");
    await click("查看标注");
    expect(openedPanels).toEqual([8]);
    await act(async () => { for (const listener of listeners) listener({ type: "attached", attached: true }); });
    await click("更多");
    expect(host.querySelector(".pdf-more-menu")?.textContent).not.toContain("查看标注");
    await act(async () => { for (const listener of listeners) listener({ type: "attached", attached: false }); });
    expect(button("查看标注")).toBeTruthy();
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
    if (notes === "closed") await click("关闭笔记");
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
    await click("关闭笔记");
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
    await click("高亮 #facd5a");
    expect(puts()).toHaveLength(1);
    expect(messages.some((message) => message.type === "page.mode.put")).toBe(false);
    expect(host.querySelector("[data-pdf-annotation]")).toBeNull();
  });

  it("retains a failed selection and retries the same durable identity without a viewport anchor", async () => {
    await mount();
    await selectPage();
    putGate = deferred();
    await click("高亮 #facd5a");
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
    await openNotes();
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
      verbosity: 0,
    });
    const failedPage = host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')!;
    const healthyPage = host.querySelector<HTMLElement>('[data-page="2"] .pdf-page')!;
    expect(failedPage.dataset.ready).toBe("false");
    expect(failedPage.querySelector('[role="alert"]')?.textContent).toContain("第 1 页");
    expect(failedPage.querySelector('[role="alert"]')?.textContent).toContain("图片过大");
    expect(failedPage.querySelector("svg")).toBeNull();
    expect(failedPage.querySelector(".pdf-area-capture")).toBeNull();
    expect(healthyPage.dataset.ready).toBe("true");

    await openNotes();
    expect(host.querySelector(".pdf-notes")?.textContent).toContain("keep this saved note");
    expect(button("返回原阅读器")).toBeTruthy();
    expect(records.map((record) => record.id)).toEqual(["saved-highlight"]);
    expect(puts()).toHaveLength(0);
  });

  it("handles tab lookup invalidation during reader startup without an unhandled promise", async () => {
    Object.defineProperty(chrome, "tabs", { configurable: true, value: {
      getCurrent: async () => { throw new Error("Extension context invalidated."); },
    } });
    await mount("", false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Extension context invalidated");
  });

  it("reports a failed initial settings request instead of leaving an unhandled Reload rejection", async () => {
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "settings.get"
      ? Promise.reject(new Error("Extension context invalidated.")) : send(message)) as typeof send;
    await mount("", false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Extension context invalidated");
  });

  it("releases reader listeners and canvas resources when Reload invalidates listener cleanup", async () => {
    await mount();
    const canvas = host.querySelector("canvas")!;
    chrome.runtime.onMessage.removeListener = () => { throw new Error("Extension context invalidated."); };
    const current = root!;
    root = undefined;
    await expect(act(async () => current.unmount())).resolves.toBeUndefined();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("opens PDF search with Cmd+F and closes it with Escape", async () => {
    await mount();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true })));
    await settle();
    const input = host.querySelector<HTMLInputElement>('[aria-label="搜索 PDF 文字"]');
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    await act(async () => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(host.querySelector('[aria-label="搜索 PDF 文字"]')).toBeNull();
  });

  it("searches document text and navigates matches without saving annotations", async () => {
    vi.useFakeTimers();
    io.pageCount = 3;
    await mount();
    await click("搜索 PDF");
    const input = host.querySelector<HTMLInputElement>('[aria-label="搜索 PDF 文字"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "scientific");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
    });
    await settle();
    expect(host.querySelector('.pdf-find-count')?.textContent).toBe("1 / 3");
    expect(host.querySelectorAll(".pdf-search-match")).toHaveLength(1);
    await click("下一处");
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("2");
    await click("上一处");
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("1");
    expect(puts()).toHaveLength(0);
  });

  it("offers bounded previous and next page actions", async () => {
    io.pageCount = 3;
    await mount();
    expect(button("上一页").disabled).toBe(true);
    await click("下一页");
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("2");
    await click("下一页");
    expect(button("下一页").disabled).toBe(true);
    await click("上一页");
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("2");
  });

  it("keeps the requested last page when browser scroll clamping leaves a preceding page gap visible", async () => {
    io.pageCount = 3;
    await mount();
    await click("下一页");
    await click("下一页");
    const scroller = host.querySelector<HTMLElement>(".pdf-pages")!;
    await act(async () => { scroller.scrollTop = 1632; scroller.dispatchEvent(new Event("scroll")); });
    await settle();
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("3");
    expect(button("下一页").disabled).toBe(true);
  });

  it("accepts an explicit percentage and rejects invalid zoom without changing the document", async () => {
    await mount();
    const input = host.querySelector<HTMLInputElement>('[aria-label="缩放比例"]');
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "231%");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(input!.value).toBe("231%");
    expect(host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')?.style.width).toBe("1386px");
    await act(async () => {
      setter.call(input, "900%");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(input!.value).toBe("231%");
    expect(puts()).toHaveLength(0);
  });

  it("fits the current page width and rotates from More", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 300 });
    await mount();
    await click("适合宽度");
    expect(host.querySelector<HTMLInputElement>('[aria-label="缩放比例"]')?.value).toBe("50%");
    expect(host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')?.style.width).toBe("300px");
    await click("更多");
    expect(host.querySelector('.pdf-toolbar [aria-label="旋转页面"]')).toBeTruthy();
    await click("旋转页面");
    expect(host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')?.style.width).toBe("300px");
  });

  it("keeps rotation out of the closed toolbar and toggles it from More", async () => {
    await mount();
    const toolbar = host.querySelector(".pdf-toolbar")!;
    const trigger = button("更多");

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(toolbar.querySelector('[aria-label="旋转页面"]')).toBeNull();
    expect(host.querySelector(".pdf-more-menu")).toBeNull();

    await click("更多");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="group"][aria-label="阅读"] [aria-label="旋转页面"]')).toBeTruthy();

    await click("更多");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".pdf-more-menu")).toBeNull();
  });

  it("shows the five area-color swatches only while area annotation is active", async () => {
    await mount();
    await click("更多");
    expect(host.querySelector('[aria-label="标注颜色"]')).toBeNull();
    expect(host.querySelectorAll('[aria-label^="标注颜色 #"]')).toHaveLength(0);

    await click("区域标注");
    await click("更多");
    const colors = [...host.querySelectorAll<HTMLButtonElement>('[aria-label^="标注颜色 #"]')]
      .map((swatch) => swatch.getAttribute("aria-label"));
    expect(colors).toEqual([
      "标注颜色 #facd5a",
      "标注颜色 #7cc868",
      "标注颜色 #69b0f1",
      "标注颜色 #fb5c89",
      "标注颜色 #c885da",
    ]);

    await click("文字选择");
    await click("更多");
    expect(host.querySelectorAll('[aria-label^="标注颜色 #"]')).toHaveLength(0);
  });

  it("retains the same page and relative reading position during zoom", async () => {
    io.pageCount = 3;
    await mount();
    const scroller = host.querySelector<HTMLElement>(".pdf-pages")!;
    await act(async () => { scroller.scrollTop = 400; scroller.dispatchEvent(new Event("scroll")); });
    await settle();
    await click("放大");
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("1");
    expect(scroller.scrollTop).toBeCloseTo(500);
  });

  it("keeps the previous zoom frame while rendering and blocks a failed page", async () => {
    await mount();
    const page = host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')!;
    expect(page.dataset.ready).toBe("true");
    expect(page.querySelector(".textLayer span")).toBeTruthy();

    const rerender = deferred<void>();
    io.renderGates[1] = rerender.promise;
    await click("放大");
    expect(page.dataset.ready).toBe("false");
    expect(page.querySelector(".textLayer span")).toBeTruthy();
    expect(page.dataset.rendering).toBe("true");
    expect(page.querySelector("canvas")!.width).toBeGreaterThan(0);

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
    // The toolbar shows the most visible page; the scroll anchor remains at
    // the preceding page's end while the storage read is still pending.
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("2");
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
    expect(host.querySelector<HTMLInputElement>(".pdf-zoom")?.value).toBe("150%");
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
    expect(host.querySelector<HTMLInputElement>(".pdf-zoom")?.value).toBe(intent === "zoom" ? "125%" : "100%");
  });

  it("uses the matching historical target page at top, retaining same-hash zoom/rotation", async () => {
    storedPosition = bookmark;
    await mount(`?document=${HASH}&page=4`);
    expect(host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("4");
    expect(host.querySelector<HTMLInputElement>(".pdf-zoom")?.value).toBe("150%");
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
