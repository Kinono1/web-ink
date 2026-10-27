import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startBootstrap } from "../src/content/bootstrap";
import { TextAnchorSession } from "../src/core/text-anchor";
import { DEFAULT_SETTINGS, type TextAnnotation } from "../src/core/model";
import { SELECTION_PORT_NAME, type WebSelectionReply, type WebSelectionState } from "../src/core/selection-toolbar";

const ID = "web-ink-test";
const HEALTH = { generation: "selection-a", version: "0.3.8", commit: "test", dirty: true };
const ownUrl = (path: string) => `chrome-extension://${ID}/${path}`;
const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
type Listener = (message: any, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
let dispose: (() => void) | undefined;

beforeEach(() => {
  window.history.replaceState(null, "", "/selection-page");
  document.body.innerHTML = '<main><p id="source">before chosen after</p></main>';
  vi.stubGlobal("defineUnlistedScript", (value: unknown) => value);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 10, bottom: 20 }) });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  window.__webInkBootstrap?.dispose();
  delete window.__webInkBootstrap;
  delete window.__webInkEngine;
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  document.querySelectorAll("style[data-web-ink]").forEach((node) => node.remove());
  if (rangeRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRect);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
});

function select(start = 7, end = 13, source = document.querySelector("#source")!) {
  const range = document.createRange();
  range.setStart(source.firstChild!, start);
  range.setEnd(source.firstChild!, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  return range;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(options: { enabled?: boolean; paused?: boolean; auto?: boolean; records?: TextAnnotation[]; write?: (record: TextAnnotation) => Promise<TextAnnotation> } = {}) {
  const connections = new Set<(port: chrome.runtime.Port) => void>();
  const listeners = new Set<Listener>();
  const storageListeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const messages: any[] = [];
  let enabled = options.enabled ?? false;
  let paused = options.paused ?? false;
  let automatic = options.auto ?? false;
  let manualTools = enabled;
  vi.stubGlobal("chrome", {
    runtime: {
      id: ID, getURL: ownUrl,
      onConnect: { addListener: (fn: (port: chrome.runtime.Port) => void) => connections.add(fn), removeListener: (fn: (port: chrome.runtime.Port) => void) => connections.delete(fn) },
      onMessage: { addListener: (fn: Listener) => listeners.add(fn), removeListener: (fn: Listener) => listeners.delete(fn) },
      sendMessage: async (message: any) => {
        messages.push(message);
        if (message.type === "settings.get") return { ok: true, data: { ...DEFAULT_SETTINGS, language: "en", disabledOrigins: paused ? [location.origin] : [] } };
        if (message.type === "page.mode.put") {
          enabled = message.enabled;
          manualTools = enabled && message.selectionTools !== false;
        }
        if (message.type.startsWith("page.mode."))
          return { ok: true, data: { enabled, selectionToolsEnabled: enabled && (automatic || manualTools) } };
        if (message.type === "engine.ensure") {
          const engine = (await import("../entrypoints/engine")).default;
          (engine as unknown as { main: () => void }).main();
          return { ok: true, data: true };
        }
        if (message.type === "annotations.list") return { ok: true, data: options.records ?? [] };
        if (message.type === "annotations.put") {
          try {
            const record = options.write ? await options.write(message.annotation) : { ...message.annotation, revision: 1 };
            return { ok: true, data: record };
          } catch (cause) {
            return { ok: false, error: (cause as Error).message };
          }
        }
        return { ok: true, data: true };
      },
    },
    storage: {
      local: { get: async () => ({ "ui.selectionToolbarEnabled": automatic }), set: async () => {} },
      onChanged: { addListener: (fn: any) => storageListeners.add(fn), removeListener: (fn: any) => storageListeners.delete(fn) },
    },
  });
  dispose = startBootstrap(HEALTH);
  await vi.waitFor(() => expect(window.__webInkBootstrap!.view.root.querySelector<HTMLButtonElement>(".web-ink-palette-toggle")!.disabled).toBe(false));
  const connect = (sender: chrome.runtime.MessageSender = { id: ID, url: ownUrl("sidepanel.html") }) => {
    const replies: WebSelectionReply[] = [];
    const incoming = new Set<(message: unknown) => void>();
    const disconnected = new Set<() => void>();
    const port = {
      name: SELECTION_PORT_NAME, sender,
      postMessage: (message: WebSelectionReply) => replies.push(message),
      onMessage: { addListener: (fn: (message: unknown) => void) => incoming.add(fn), removeListener: (fn: (message: unknown) => void) => incoming.delete(fn) },
      onDisconnect: { addListener: (fn: () => void) => disconnected.add(fn), removeListener: (fn: () => void) => disconnected.delete(fn) },
      disconnect: vi.fn(() => { for (const fn of [...disconnected]) fn(); }),
    };
    for (const fn of connections) fn(port as unknown as chrome.runtime.Port);
    return {
      replies, port,
      state: () => replies.filter((reply): reply is WebSelectionState => reply.type === "selection").at(-1),
      send: (message: unknown) => { for (const fn of [...incoming]) fn(message); },
      save: (token: string, requestId = "save-1", color = "#69b0f1") => { for (const fn of [...incoming]) fn({ type: "annotate", token, requestId, color }); },
    };
  };
  return {
    messages, connect,
    emit: (type: string) => { for (const fn of [...listeners]) fn({ type }, { id: ID }, () => {}); },
    pause: () => { paused = true; },
    setAuto: (value: boolean) => { automatic = value; for (const fn of storageListeners) fn({ "ui.selectionToolbarEnabled": { newValue: value } }, "local"); },
  };
}

it("does not index or load the engine for a selection until an explicit sidebar save", async () => {
  const capture = vi.spyOn(TextAnchorSession.prototype, "capture");
  const f = await fixture();
  select();
  expect(f.messages.some((message) => message.type === "engine.ensure")).toBe(false);
  const p = f.connect();
  expect(p.state()).toMatchObject({ type: "selection", status: "ready", text: "chosen", pageUrl: location.href });
  expect(capture).not.toHaveBeenCalled();
  expect(f.messages.some((message) => message.type === "annotations.list")).toBe(false);
  p.save(p.state()!.token!);
  await vi.waitFor(() => expect(p.replies.some((reply) => reply.type === "saved")).toBe(true));
  expect(f.messages).toContainEqual({ type: "page.mode.put", pageUrl: location.href, enabled: true, selectionTools: false });
  expect(f.messages.filter((message) => message.type === "annotations.put")[0].annotation).toMatchObject({ kind: "text", color: "#69b0f1", target: { exact: "chosen" } });
  expect(p.state()?.status).toBe("empty");
});

it("keeps the page palette quiet after a sidebar-only save with automatic reminders off", async () => {
  const f = await fixture();
  select();
  const port = f.connect();
  port.save(port.state()!.token!);
  await vi.waitFor(() => expect(port.replies.some(reply => reply.type === "saved")).toBe(true));
  const view = window.__webInkBootstrap!.view;
  select();
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  expect(view.selection.style.display).not.toBe("flex");
});

it("shows selection colors on an enabled page while retaining the preset shortcut", async () => {
  const f = await fixture({ enabled: true });
  const view = window.__webInkBootstrap!.view;
  await vi.waitFor(() => expect(f.messages.some((message) => message.type === "annotations.list")).toBe(true));
  const capture = vi.spyOn(TextAnchorSession.prototype, "capture");
  select();
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  expect(view.selection.style.display).toBe("flex");
  expect(capture).toHaveBeenCalled();
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "!", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(f.messages.filter((message) => message.type === "annotations.put")).toHaveLength(1));
  expect(f.messages.find((message) => message.type === "annotations.put").annotation.tags).toEqual(["Important"]);
});

it("keeps the page palette after a failed sidebar save and closes it after a successful retry", async () => {
  let attempts = 0;
  const f = await fixture({ enabled: true, write: async record => {
    if (++attempts === 1) throw Error("write failed");
    return { ...record, revision: 1 };
  } });
  await vi.waitFor(() => expect(f.messages.some(message => message.type === "annotations.list")).toBe(true));
  const view = window.__webInkBootstrap!.view;
  select();
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  expect(view.selection.style.display).toBe("flex");
  const port = f.connect();
  const token = port.state()!.token!;
  port.save(token);
  await vi.waitFor(() => expect(port.replies.some(reply => reply.type === "error")).toBe(true));
  expect(view.selection.style.display).toBe("flex");
  port.save(token, "retry-2");
  await vi.waitFor(() => expect(port.replies.some(reply => reply.type === "saved")).toBe(true));
  expect(view.selection.style.display).toBe("none");
  expect(f.messages.filter(message => message.type === "annotations.put")).toHaveLength(2);
});

it("hides an open automatic palette when the preference changes", async () => {
  const f = await fixture({ enabled: true, auto: true });
  await vi.waitFor(() => expect(f.messages.some((message) => message.type === "annotations.list")).toBe(true));
  select();
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  const view = window.__webInkBootstrap!.view;
  expect(view.selection.style.display).toBe("flex");
  f.setAuto(false);
  expect(view.selection.style.display).toBe("none");
  window.dispatchEvent(new Event("scroll"));
  expect(view.selection.style.display).toBe("none");
});

it("keeps a saved range valid after focus moves into the sidebar", async () => {
  const f = await fixture();
  select();
  const p = f.connect();
  const token = p.state()!.token!;
  vi.mocked(document.hasFocus).mockReturnValue(false);
  document.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  expect(p.state()?.token).toBe(token);
  p.save(token);
  await vi.waitFor(() => expect(p.replies.some((reply) => reply.type === "saved")).toBe(true));
});

it("waits for durable saving, rejects a busy request, and preserves retry after storage failure", async () => {
  const pending = deferred<TextAnnotation>();
  let attempts = 0;
  const f = await fixture({ write: async (record) => { if (++attempts === 1) return pending.promise; return { ...record, revision: 1 }; } });
  select();
  const p = f.connect();
  const token = p.state()!.token!;
  p.save(token);
  await vi.waitFor(() => expect(attempts).toBe(1));
  expect(p.state()?.status).toBe("saving");
  expect(p.replies.some((reply) => reply.type === "saved")).toBe(false);
  p.save(token, "busy");
  expect(p.replies).toContainEqual({ type: "error", requestId: "busy", error: expect.stringMatching(/saving|progress|busy/i) });
  pending.reject(Error("Storage quota exceeded"));
  await vi.waitFor(() => expect(p.replies).toContainEqual({ type: "error", requestId: "save-1", error: "Storage quota exceeded" }));
  expect(p.state()).toMatchObject({ status: "ready", token, text: "chosen" });
  expect(document.getSelection()!.toString()).toBe("chosen");
  p.save(token, "retry");
  await vi.waitFor(() => expect(p.replies.some((reply) => reply.type === "saved" && reply.requestId === "retry")).toBe(true));
  p.save(token, "repeated");
  expect(p.replies.some((reply) => reply.type === "error" && reply.requestId === "repeated")).toBe(true);
  expect(attempts).toBe(2);
});

it.each([
  { id: "foreign", url: ownUrl("sidepanel.html") },
  { id: ID, url: ownUrl("library.html") },
  { id: ID, url: "https://example.test/sidepanel.html" },
  { id: ID },
])("refuses a port from an unauthorized sender %j", async (sender) => {
  const f = await fixture();
  select();
  const p = f.connect(sender);
  expect(p.port.disconnect).toHaveBeenCalledTimes(1);
  expect(p.replies).toEqual([]);
  p.save("forged");
  expect(f.messages.some((message) => message.type === "annotations.put")).toBe(false);
});

it("rejects malformed commands and wrong tokens before enabling the page", async () => {
  const f = await fixture();
  select();
  const p = f.connect();
  const token = p.state()!.token!;
  p.save("wrong", "wrong-token");
  p.save(token, "wrong-color", "red");
  p.send({ type: "annotate", token, color: "#69b0f1", requestId: "extra", pageUrl: "https://foreign.test" });
  expect(p.replies.filter((reply) => reply.type === "error")).toHaveLength(3);
  expect(f.messages.some((message) => message.type === "page.mode.put")).toBe(false);
  expect(p.state()?.token).toBe(token);
});

it("invalidates old tokens on new selection, DOM drift, and route change", async () => {
  const f = await fixture();
  select();
  const p = f.connect();
  const old = p.state()!.token!;
  select(0, 6);
  expect(p.state()?.token).not.toBe(old);
  p.save(old, "old");
  const changed = p.state()!.token!;
  document.querySelector("#source")!.firstChild!.textContent = "before chosen changed";
  p.save(changed, "drift");
  select();
  const routed = p.state()!.token!;
  window.history.pushState(null, "", "/other-page");
  p.save(routed, "route");
  expect(p.replies.filter((reply) => reply.type === "error")).toHaveLength(3);
  expect(f.messages.some((message) => message.type === "annotations.put")).toBe(false);
});

it.each(["paused", "editable", "revoked"])("does not bypass %s content", async (kind) => {
  const f = await fixture({ paused: kind === "paused" });
  if (kind === "editable") document.querySelector("#source")!.setAttribute("contenteditable", "true");
  select();
  const p = f.connect();
  if (kind === "revoked") f.emit("permissions.revoked");
  expect(p.state()?.status).toBe(kind === "editable" ? "unsupported" : "paused");
  p.save("forged");
  expect(f.messages.some((message) => message.type === "annotations.put" || message.type === "page.mode.put")).toBe(false);
});

it("bounds the preview without extracting the full selection", async () => {
  const f = await fixture();
  document.querySelector("#source")!.textContent = "x".repeat(2000);
  select(0, 2000);
  const toString = vi.spyOn(Range.prototype, "toString");
  const p = f.connect();
  expect(p.state()?.status).toBe("ready");
  expect(p.state()!.text!.length).toBeLessThanOrEqual(281);
  expect(toString).not.toHaveBeenCalled();
  expect(f.messages.some((message) => message.type === "engine.ensure")).toBe(false);
});

it("releases the old selection when the last port disconnects and on runtime disposal", async () => {
  const f = await fixture();
  select();
  const p = f.connect();
  const count = p.replies.length;
  p.port.disconnect();
  select(0, 6);
  expect(p.replies).toHaveLength(count);
  document.getSelection()!.removeAllRanges();
  const next = f.connect();
  expect(next.state()?.status).toBe("empty");
  dispose!();
  expect(next.port.disconnect).toHaveBeenCalledTimes(1);
  select();
  next.save("released");
  expect(f.messages.some((message) => message.type === "annotations.put")).toBe(false);
});

it("retains explicit Rebind palette actions when automatic selection tools are disabled", async () => {
  const record: TextAnnotation = {
    id: "original", kind: "text", pageUrl: location.href, pageTitle: "Original",
    color: "#69b0f1", note: "Keep note", tags: ["Existing"], revision: 2,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    target: { exact: "chosen", prefix: "before ", suffix: " after", start: 7, end: 13, rootSelector: "main", containerId: "source" },
  };
  const f = await fixture({ enabled: true, records: [record] });
  await vi.waitFor(() => expect(f.messages.some((message) => message.type === "annotations.list")).toBe(true));
  window.__webInkEngine!.dispatch("rebind", record.id, HEALTH.generation);
  select(0, 6);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  const palette = window.__webInkBootstrap!.view.selection;
  expect(palette.style.display).toBe("flex");
  palette.querySelector<HTMLButtonElement>(".preset")!.click();
  await vi.waitFor(() => expect(f.messages.some((message) => message.type === "annotations.put")).toBe(true));
  expect(f.messages.find((message) => message.type === "annotations.put").annotation).toMatchObject({ id: "original", color: "#69b0f1", note: "Keep note", tags: ["Existing"], target: { exact: "before" } });
});

it("rechecks a newly paused site before enabling a page for explicit save", async () => {
  const f = await fixture();
  select();
  const p = f.connect();
  f.pause();
  p.save(p.state()!.token!);
  await vi.waitFor(() => expect(p.replies.some((reply) => reply.type === "error")).toBe(true));
  expect(p.state()?.status).toBe("paused");
  expect(p.replies).toContainEqual({ type: "error", requestId: "save-1", error: expect.stringMatching(/paused|unavailable/i) });
  expect(f.messages.some((message) => message.type === "page.mode.put" || message.type === "annotations.put")).toBe(false);
});

it("rejects disconnected DOM boundaries before a queued observer callback runs", async () => {
  const f = await fixture();
  select();
  const p = f.connect();
  const token = p.state()!.token!;
  document.querySelector("#source")!.remove();
  p.save(token);
  expect(p.replies).toContainEqual({ type: "error", requestId: "save-1", error: expect.stringMatching(/selection changed/i) });
  expect(p.state()?.status).toBe("empty");
  expect(f.messages.some((message) => message.type === "annotations.put")).toBe(false);
});

it("publishes keyboard selections without automatic toolbar indexing", async () => {
  const f = await fixture();
  const p = f.connect();
  expect(p.state()?.status).toBe("empty");
  const capture = vi.spyOn(TextAnchorSession.prototype, "capture");
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("#source")!);
  document.getSelection()!.addRange(range);
  document.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true }));
  expect(p.state()).toMatchObject({ status: "ready", text: "before chosen after" });
  expect(capture).not.toHaveBeenCalled();
});

it("does not report success in a new route after the original save commits", async () => {
  const pending = deferred<TextAnnotation>();
  let saved!: TextAnnotation;
  const f = await fixture({ write: async (record) => { saved = record; return pending.promise; } });
  select();
  const p = f.connect();
  p.save(p.state()!.token!);
  await vi.waitFor(() => expect(saved).toBeDefined());
  window.history.pushState(null, "", "/new-document-route");
  pending.resolve({ ...saved, revision: 1 });
  await vi.waitFor(() => expect(p.replies.some((reply) => reply.type === "error")).toBe(true));
  expect(p.replies.some((reply) => reply.type === "saved")).toBe(false);
  expect(p.replies).toContainEqual({ type: "error", requestId: "save-1", error: expect.stringMatching(/was saved.*changed/i) });
  expect(p.state()?.status).toBe("empty");
});

it("disconnects old-generation ports and ignores their in-flight completion", async () => {
  const pending = deferred<TextAnnotation>();
  let saved!: TextAnnotation;
  const f = await fixture({ write: async (record) => { saved = record; return pending.promise; } });
  select();
  const p = f.connect();
  p.save(p.state()!.token!);
  await vi.waitFor(() => expect(saved).toBeDefined());
  dispose = startBootstrap({ ...HEALTH, generation: "selection-b" });
  expect(p.port.disconnect).toHaveBeenCalledTimes(1);
  pending.resolve({ ...saved, revision: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(p.replies.some((reply) => reply.type === "saved")).toBe(false);
});

it("releases observers and the view even when Chrome invalidates port listeners first", async () => {
  const disconnectObserver = vi.spyOn(MutationObserver.prototype, "disconnect");
  const f = await fixture();
  select();
  const p = f.connect();
  p.port.onMessage.removeListener = () => { throw Error("Extension context invalidated"); };
  p.port.onDisconnect.removeListener = () => { throw Error("Extension context invalidated"); };
  expect(() => dispose!()).not.toThrow();
  expect(disconnectObserver).toHaveBeenCalled();
  expect(document.querySelector("web-ink-ui")).toBeNull();
  const count = p.replies.length;
  select(0, 6);
  p.save("disposed");
  expect(p.replies).toHaveLength(count);
});

it("rejects an old token when an interior selected node is removed without moving either endpoint", async () => {
  const f = await fixture();
  const source = document.querySelector("#source")!;
  source.innerHTML = '<span>alpha </span><span id="middle">BRAVO </span><span>charlie</span>';
  const range = document.createRange();
  range.setStart(source.firstChild!.firstChild!, 0);
  range.setEnd(source.lastChild!.firstChild!, 7);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  const p = f.connect();
  expect(p.state()).toMatchObject({ status: "ready", text: "alpha BRAVO charlie" });
  const token = p.state()!.token!;
  document.querySelector("#middle")!.remove();
  p.save(token);
  await vi.waitFor(() => expect(p.replies.some((reply) => reply.type === "error")).toBe(true));
  expect(p.state()?.status).toBe("empty");
  expect(f.messages.some((message) => message.type === "annotations.put")).toBe(false);
});

it("starts bounded Element previews at the selected child instead of walking an unselected prefix", async () => {
  const f = await fixture();
  const source = document.querySelector("#source")!;
  source.innerHTML = `${"<span>ignored</span>".repeat(100)}<span>chosen</span>`;
  const range = document.createRange();
  range.setStart(source, 100);
  range.setEnd(source, 101);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  const p = f.connect();
  expect(p.state()).toMatchObject({ status: "ready", text: "chosen" });
  expect(f.messages.some((message) => message.type === "engine.ensure")).toBe(false);
});
