import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Annotation, Settings } from "../src/core/model";
import { ManagementApp } from "../src/ui/ManagementApp";

// These wrappers execute the original production functions, including all hooks
// and descendants. Counts measure function executions, not Profiler commits.
const renders = vi.hoisted(() => ({ library: 0, settings: 0, page: 0 }));
vi.mock("../src/ui/screens/LibraryScreen", async (original) => {
  const actual = await original<typeof import("../src/ui/screens/LibraryScreen")>();
  return { ...actual, LibraryScreen: (props: Parameters<typeof actual.LibraryScreen>[0]) => {
    renders.library++;
    return actual.LibraryScreen(props);
  } };
});
vi.mock("../src/ui/screens/SettingsScreen", async (original) => {
  const actual = await original<typeof import("../src/ui/screens/SettingsScreen")>();
  return { ...actual, SettingsScreen: (props: Parameters<typeof actual.SettingsScreen>[0]) => {
    renders.settings++;
    return actual.SettingsScreen(props);
  } };
});
vi.mock("../src/ui/screens/PageScreen", async (original) => {
  const actual = await original<typeof import("../src/ui/screens/PageScreen")>();
  return { ...actual, PageScreen: (props: Parameters<typeof actual.PageScreen>[0]) => {
    renders.page++;
    return actual.PageScreen(props);
  } };
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
let root: Root | undefined;
const settings: Settings = { language: "zh-CN", defaultColor: "#facc15", disabledOrigins: [] };
const record: Annotation = {
  id: "dependency-note", kind: "text", pageUrl: "https://example.test/article", pageTitle: "Article",
  color: "#facc15", note: "", tags: ["research"], revision: 1,
  createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z",
  target: { exact: "A saved annotation", prefix: "", suffix: "", start: 0, end: 18, rootSelector: "body" },
};
function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return {
    addListener: vi.fn((listener: (...args: any[]) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (...args: any[]) => void) => listeners.delete(listener)),
    emit: (...args: any[]) => { for (const listener of [...listeners]) listener(...args); },
    listeners,
  };
}
async function setup(mode: "library" | "sidepanel" = "library") {
  let activeTab = { id: 7, windowId: 1, url: "https://example.test/article", title: "Article" };
  let currentSettings = settings;
  const pageModes = new Map<string, boolean>();
  const messages = event(), activated = event(), updated = event(), storage = event();
  const ports: Array<{ onMessage: ReturnType<typeof event>; onDisconnect: ReturnType<typeof event>; postMessage: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const connect = vi.fn(() => {
    const port = { onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn() };
    ports.push(port); return port;
  });
  const send = vi.fn(async (message: any) => {
    if (message.type === "pdf.context.get") return { ok: true, data: {
      tabId: activeTab.id, url: activeTab.url, kind: activeTab.url.endsWith(".pdf") ? "wrapper" : "unavailable",
      currentReader: activeTab.url.endsWith(".pdf"), candidates: [],
    } };
    if (message.type === "page.state.get") return { ok: true, data: { pageUrl: activeTab.url, states: [] } };
    if (message.type === "page.mode.get") return { ok: true, data: { enabled: pageModes.get(message.pageUrl) ?? false } };
    if (message.type === "page.action") return { ok: false, error: "Focus unavailable" };
    if (message.type === "settings.get") return { ok: true, data: currentSettings };
    if (message.type === "annotations.query") return { ok: true, data: { items: [record] } };
    if (message.type === "backup.export") return { ok: false, error: "Export unavailable" };
    if (message.type === "storage.stats") return { ok: false, error: "Stats unavailable" };
    return { ok: true, data: {} };
  });
  const sendToPage = vi.fn(async (
    tabId: number,
    message: { type: string; expectedUrl: string; enabled: boolean },
    options: { frameId: number },
  ) => {
    if (tabId !== activeTab.id || message.expectedUrl !== activeTab.url ||
        message.type !== "page.mode.set" || typeof message.enabled !== "boolean" || options.frameId !== 0)
      return { ok: false, error: "The target page changed." };
    pageModes.set(message.expectedUrl, message.enabled);
    return { ok: true, data: true };
  });
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "test", connect, sendMessage: send, onMessage: messages, getURL: (path: string) => `chrome-extension://test/${path}` },
    tabs: { connect, sendMessage: sendToPage, query: vi.fn(async () => [activeTab]), create: vi.fn(), onActivated: activated, onUpdated: updated },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: storage },
  } });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(ManagementApp, { mode })));
  await settle();
  return { host, send, sendToPage, messages, activated, updated, storage, connect, ports,
    navigate: async (next: typeof activeTab) => {
      const previousId = activeTab.id; activeTab = next;
      await act(async () => {
        if (next.id === previousId) updated.emit(next.id, { url: next.url, status: "complete" });
        else activated.emit({ tabId: next.id, windowId: next.windowId });
      });
      await settle();
    },
    changeSettings: async (patch: Partial<Settings>) => {
      currentSettings = { ...currentSettings, ...patch };
      await act(async () => messages.emit({ type: "settings.changed" }));
    },
  };
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); }
async function click(host: HTMLElement, text: string, selector = "button") {
  const button = [...host.querySelectorAll<HTMLElement>(selector)].find(item => item.textContent?.trim() === text);
  expect(button, text).toBeTruthy(); await act(async () => button!.click());
}
function resetRenders() { renders.library = 0; renders.settings = 0; renders.page = 0; }
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren();
  if (chromeDescriptor) Object.defineProperty(globalThis, "chrome", chromeDescriptor);
  else Reflect.deleteProperty(globalThis, "chrome");
});
it("does not execute the library function for an unrelated theme update", async () => {
  const fixture = await setup(); resetRenders();
  const subscriptions = fixture.messages.addListener.mock.calls.length;
  const queryCount = fixture.send.mock.calls.filter(([message]) => message.type === "annotations.query").length;
  const started = performance.now(); await fixture.changeSettings({ theme: "dark" });
  console.info("management dependency workload: theme", { ...renders, elapsedMs: performance.now() - started });
  expect(fixture.host.querySelector("main")?.getAttribute("data-theme")).toBe("dark");
  expect(fixture.host.querySelector(".annotation-row")?.textContent).toContain("A saved annotation");
  expect(renders.library).toBe(0);
  expect(fixture.messages.addListener.mock.calls.length).toBe(subscriptions);
  expect(fixture.send.mock.calls.filter(([message]) => message.type === "annotations.query").length).toBe(queryCount);
});
it("does not execute settings for annotation draft changes and keeps the latest draft", async () => {
  const { host, messages, send } = await setup();
  await act(async () => host.querySelector<HTMLButtonElement>(".annotation-row")!.click());
  await click(host, "笔记", ".detail-actions button");
  resetRenders(); const listeners = messages.addListener.mock.calls.length, reads = send.mock.calls.length;
  const editor = host.querySelector("textarea")!;
  const started = performance.now();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Fresh unsaved note");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  console.info("management dependency workload: draft", { ...renders, elapsedMs: performance.now() - started });
  expect(host.querySelector("textarea")?.value).toBe("Fresh unsaved note");
  expect(renders.settings).toBe(0); expect(renders.library).toBe(1);
  expect(messages.addListener.mock.calls.length).toBe(listeners); expect(send.mock.calls.length).toBe(reads);
});
it("does not execute either screen for an export error or its dismissal", async () => {
  const { host, messages, send } = await setup();
  await click(host, "设置与数据", ".segmented-control button"); await settle(); resetRenders();
  const listeners = messages.addListener.mock.calls.length;
  const started = performance.now(); await click(host, "下载 JSON");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Export unavailable");
  await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  console.info("management dependency workload: error", { ...renders, elapsedMs: performance.now() - started });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(renders).toEqual({ library: 0, settings: 0, page: 0 });
  expect(messages.addListener.mock.calls.length).toBe(listeners);
  expect(send.mock.calls.filter(([message]) => message.type === "annotations.query")).toHaveLength(1);
});
it("keeps one annotation subscription across filters and reads the newest filter in notifications", async () => {
  const { host, messages, send } = await setup();
  const subscriptions = messages.addListener.mock.calls.length;
  await click(host, "筛选");
  const input = host.querySelector<HTMLInputElement>('input[aria-label="标签"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "other");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  const before = send.mock.calls.filter(([message]) => message.type === "annotations.query").length;
  await act(async () => messages.emit({ type: "annotations.changed", annotation: record }));
  expect(host.querySelector(".annotation-row")).toBeNull();
  expect(send.mock.calls.filter(([message]) => message.type === "annotations.query").length).toBe(before);
  await act(async () => messages.emit({ type: "annotations.changed", annotation: { ...record, tags: ["other"] } }));
  expect(send.mock.calls.filter(([message]) => message.type === "annotations.query").length).toBe(before + 1);
  expect(send.mock.calls.filter(([message]) => message.type === "annotations.query").at(-1)?.[0].query.tag).toBe("other");
  expect(messages.addListener.mock.calls.length).toBe(subscriptions);
});

it("does not execute PageScreen or reconnect selection for an unrelated action error", async () => {
  const { host, send, messages, connect } = await setup("sidepanel");
  await act(async () => host.querySelector<HTMLButtonElement>(".annotation-row")!.click());
  resetRenders(); const listeners = messages.addListener.mock.calls.length, connections = connect.mock.calls.length;
  const reads = send.mock.calls.length;
  await click(host, "定位", ".detail-actions button");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Focus unavailable");
  expect(renders.page).toBe(0); expect(connect.mock.calls.length).toBe(connections);
  expect(messages.addListener.mock.calls.length).toBe(listeners);
  expect(send.mock.calls.slice(reads).map(([message]) => message.type)).toEqual(["page.action"]);
});
it("keeps callbacks current across URL changes, tab activation, language and PDF reader contexts", async () => {
  const { host, send, sendToPage, navigate, changeSettings, connect, ports } = await setup("sidepanel");
  for (const next of [
    { id: 7, windowId: 1, url: "https://example.test/new", title: "New URL" },
    { id: 8, windowId: 2, url: "https://example.test/other", title: "Other tab" },
  ]) {
    await navigate(next); expect(host.textContent).toContain(next.title);
    expect(send.mock.calls.filter(([message]) => message.type === "annotations.query").at(-1)?.[0].query.pageUrl).toBe(next.url);
    const control = host.querySelector<HTMLButtonElement>('.page-header button[role="switch"]')!;
    expect(control.getAttribute("aria-checked")).toBe("false");
    const requests = sendToPage.mock.calls.length;
    await act(async () => control.click());
    expect(sendToPage).toHaveBeenCalledTimes(requests + 1);
    expect(sendToPage).toHaveBeenLastCalledWith(next.id,
      { type: "page.mode.set", expectedUrl: next.url, enabled: true }, { frameId: 0 });
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "page.mode.put" }));
    await act(async () => host.querySelector<HTMLButtonElement>(".annotation-row")!.click());
    await click(host, "定位", ".detail-actions button");
    expect(send).toHaveBeenCalledWith({ type: "page.action", tabId: next.id, action: "focus", id: "dependency-note" });
  }
  await changeSettings({ language: "en" }); expect(host.textContent).toContain("Show annotations");
  await navigate({ id: 9, windowId: 2, url: "chrome-extension://test/reader.pdf", title: "Reader" });
  await act(async () => ports.at(-1)!.onMessage.emit({ type: "state", state: {
    pageUrl: "urn:web-ink:pdf:" + "a".repeat(64), sessionId: "reader-session", fileName: "Paper.pdf",
    records: [], totalCount: 0, drafts: {}, conflicts: {}, locked: false, removing: false,
  } }));
  expect(host.querySelectorAll(".pdf-sidebar")).toHaveLength(1);
  expect(host.querySelector(".web-selection")).toBeNull();
  const connections = connect.mock.calls.length;
  await changeSettings({ theme: "dark" });
  expect(connect.mock.calls.length).toBe(connections);
  expect(ports.at(-1)?.postMessage).toHaveBeenCalledWith({ type: "watch", tabId: 9 });
});

it("releases management subscriptions and selection ports on unmount", async () => {
  const fixture = await setup("sidepanel");
  await act(async () => root!.unmount()); root = undefined;
  for (const source of [fixture.messages, fixture.activated, fixture.updated, fixture.storage])
    expect(source.listeners.size).toBe(0);
  expect(fixture.ports.length).toBeGreaterThan(0);
  for (const port of fixture.ports) expect(port.disconnect).toHaveBeenCalledOnce();
});
