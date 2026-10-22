import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ManagementApp } from "../src/ui/ManagementApp";
import { BuildInfo } from "../src/ui/BuildInfo";
import type { Annotation, PdfTabContext } from "../src/core/model";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const settings = {
  language: "zh-CN" as const,
  defaultColor: "#facc15",
  disabledOrigins: [],
  theme: "system" as const,
  reduceMotion: false,
  reduceTransparency: false,
};

const record: Annotation = {
  id: "web-1",
  kind: "text",
  pageUrl: "https://example.test/article",
  pageTitle: "Article",
  color: "#facc15",
  note: "",
  tags: ["research"],
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
  revision: 1,
  target: {
    exact: "A saved annotation",
    prefix: "",
    suffix: "",
    start: 0,
    end: 18,
    rootSelector: "body",
  },
};

let root: Root | undefined;
const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");

it("opens the shared preset editor from Settings without changing the annotation settings schema", async () => {
  installChrome((message) => {
    if (message.type === "settings.get") return { ok: true, data: settings };
    if (message.type === "annotations.query") return { ok: true, data: { items: [], total: 0 } };
    if (message.type === "storage.stats") return { ok: false, error: "Unavailable in this fixture" };
    return { ok: true, data: {} };
  });
  const set = vi.fn(async () => {});
  Object.assign(chrome, { storage: { local: { get: async () => ({}), set } } });
  const host = await mount("library");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "设置与数据")!.click());
  const launch = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "标注预设…");
  expect(launch).toBeTruthy();
  await act(async () => launch!.click());
  expect(host.querySelector('[role="dialog"]')).toBeTruthy();
  expect(set).not.toHaveBeenCalled();
});
type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
type TabUpdatedListener = (tabId: number, changeInfo: { url?: string; status?: string }) => void;
type TabActivatedListener = (activeInfo: { tabId: number; windowId: number }) => void;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  if (chromeDescriptor)
    Object.defineProperty(globalThis, "chrome", chromeDescriptor);
  else Reflect.deleteProperty(globalThis, "chrome");
});

function installChrome(
  sendMessage: (message: { type: string; [key: string]: unknown }) => unknown,
  tab: { id: number; windowId?: number; url?: string; title?: string } = {
    id: 7,
    url: "https://example.test/article",
    title: "Article",
  },
  onTabUpdated?: (listener: TabUpdatedListener) => void,
  ieeePermission: { contains: () => Promise<boolean>; request: () => Promise<boolean> } = {
    contains: async () => true,
    request: async () => true,
  },
  onTabActivated?: (listener: TabActivatedListener) => void,
) {
  const messages = { addListener: vi.fn(), removeListener: vi.fn() };
  const activated = {
    addListener: vi.fn((listener: TabActivatedListener) => onTabActivated?.(listener)),
    removeListener: vi.fn(),
  };
  const updated = {
    addListener: vi.fn((listener: TabUpdatedListener) => onTabUpdated?.(listener)),
    removeListener: vi.fn(),
  };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        sendMessage: vi.fn(sendMessage),
        onMessage: messages,
        getURL: (path: string) =>
          `chrome-extension://test/${path.replace(/^\//, "")}`,
      },
      permissions: {
        contains: ieeePermission.contains,
        request: ieeePermission.request,
      },
      tabs: { query: async () => [tab], create: vi.fn(async () => ({ id: 9 })), onActivated: activated, onUpdated: updated },
    },
  });
  return globalThis.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
}

async function mount(mode: "sidepanel" | "library") {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(ManagementApp, { mode })));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return host;
}

describe("sidebar context errors", () => {
  for (const code of ["PAGE_CHANGED", "CONTEXT_UNAVAILABLE"]) {
    it(`does not retain ${code} on a newly readable webpage`, async () => {
      let fail = true;
      let updated: TabUpdatedListener | undefined;
      const tab = { id: 7, url: "https://example.test/first", title: "First" };
      installChrome((message) => {
        if (message.type === "pdf.context.get") return fail
          ? { ok: false, code, error: "The tab or document changed. Try again on the current page." }
          : { ok: true, data: { tabId: 7, kind: "unavailable", currentReader: false, candidates: [] } };
        if (message.type === "settings.get") return { ok: true, data: settings };
        if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
        if (message.type === "page.state.get") return { ok: true, data: { states: [] } };
        if (message.type === "page.mode.get") return { ok: true, data: { enabled: false } };
        return { ok: true, data: true };
      }, tab, listener => { updated = listener; });
      const host = await mount("sidepanel");
      if (code === "PAGE_CHANGED") expect(host.querySelector('[role="alert"]')).toBeNull();
      else expect(host.querySelector('[role="alert"]')).not.toBeNull();
      fail = false;
      tab.url = "https://example.test/second";
      tab.title = "Second";
      await act(async () => { updated!(7, { url: tab.url, status: "complete" }); });
      expect(host.textContent).toContain("Second");
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });
  }

  it("keeps an explicit action failure when a passive context refresh succeeds", async () => {
    let updated: TabUpdatedListener | undefined;
    installChrome(message => {
      if (message.type === "page.action") return { ok: false, error: "Explicit action failed" };
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: { tabId: 7, kind: "unavailable", currentReader: false, candidates: [] } };
      if (message.type === "page.state.get") return { ok: true, data: { states: [] } };
      if (message.type === "page.mode.get") return { ok: true, data: { enabled: true } };
      return { ok: true, data: true };
    }, undefined, listener => { updated = listener; });
    const host = await mount("sidepanel");
    const draw = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "图片绘制")!;
    await act(async () => draw.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Explicit action failed");
    await act(async () => { updated!(7, { status: "complete" }); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Explicit action failed");
  });
});

it("updates the pencil size from Settings without changing annotation settings", async () => {
  const changes = new Set<StorageListener>();
  const stored: Record<string, unknown> = { "ui.paletteSize": 48 };
  installChrome(message => {
    if (message.type === "storage.stats") return { ok: false, error: "Unavailable in this fixture" };
    if (message.type === "settings.get") return { ok: true, data: settings };
    if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
    return { ok: true, data: {} };
  });
  Object.assign(chrome, { storage: {
    local: { get: async () => ({ ...stored }), set: async (patch: Record<string, unknown>) => { Object.assign(stored, patch); } },
    onChanged: { addListener: (fn: StorageListener) => changes.add(fn), removeListener: (fn: StorageListener) => changes.delete(fn) },
  } });
  const host = await mount("library");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "设置与数据")!.click());
  const slider = host.querySelector<HTMLInputElement>('input[aria-label="铅笔大小"]');
  expect(slider).not.toBeNull();
  expect(slider!.value).toBe("48");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "64");
    slider!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(stored["ui.paletteSize"]).toBe(64);
  expect(host.querySelector<HTMLElement>('[aria-label="铅笔大小预览"]')!.style.width).toBe("64px");
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "settings.put" }));
});

it("rolls back a failed pencil-size write to the latest external value", async () => {
  const changes = new Set<StorageListener>();
  let stored = 48;
  let fail!: (cause: Error) => void;
  installChrome(message => {
    if (message.type === "settings.get") return { ok: true, data: settings };
    if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
    return { ok: false, error: "Unavailable in this fixture" };
  });
  Object.assign(chrome, { storage: {
    local: { get: async () => ({ "ui.paletteSize": stored }), set: () => new Promise<void>((_, reject) => { fail = reject; }) },
    onChanged: { addListener: (fn: StorageListener) => changes.add(fn), removeListener: (fn: StorageListener) => changes.delete(fn) },
  } });
  const host = await mount("library");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "设置与数据")!.click());
  const slider = host.querySelector<HTMLInputElement>('input[aria-label="铅笔大小"]')!;
  expect(slider.value).toBe("48");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "64");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    stored = 56;
    for (const fn of changes) fn({ "ui.paletteSize": { newValue: 56 } }, "local");
    fail(Error("Size write failed"));
  });
  expect(slider.value).toBe("56");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Size write failed");
});

describe("management UI", () => {
  it("persists the webpage selection toolbar preference and accepts live storage updates", async () => {
    const changes = new Set<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void>();
    const stored: Record<string, unknown> = { "ui.selectionToolbarEnabled": true };
    let rejectWrites = false;
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: { tabId: 7, kind: "unavailable", currentReader: false, candidates: [] } };
      if (message.type === "page.state.get") return { ok: true, data: { states: [] } };
      if (message.type === "page.mode.get") return { ok: true, data: { enabled: false } };
      return { ok: true, data: true };
    });
    Object.assign(chrome, { storage: {
      local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (values: Record<string, unknown>) => {
          if (rejectWrites) throw Error("Preference storage denied");
          Object.assign(stored, values);
        },
      },
      onChanged: {
        addListener: (listener: (next: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => changes.add(listener),
        removeListener: (listener: (next: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => changes.delete(listener),
      },
    } });

    const host = await mount("sidepanel");
    const control = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动显示标注工具"]')!;
    expect(control.getAttribute("aria-checked")).toBe("true");
    await act(async () => control.click());
    expect(stored["ui.selectionToolbarEnabled"]).toBe(false);
    expect(control.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      for (const listener of changes)
        listener({ "ui.selectionToolbarEnabled": { newValue: true } as chrome.storage.StorageChange }, "local");
    });
    expect(control.getAttribute("aria-checked")).toBe("true");

    rejectWrites = true;
    await act(async () => {
      control.click();
      await Promise.resolve();
    });
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Preference storage denied");
  });

  it("keeps a newer storage change when the initial toolbar preference read resolves late", async () => {
    const changes = new Set<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void>();
    let finishRead: ((value: Record<string, unknown>) => void) | undefined;
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: { tabId: 7, kind: "unavailable", currentReader: false, candidates: [] } };
      if (message.type === "page.state.get") return { ok: true, data: { states: [] } };
      if (message.type === "page.mode.get") return { ok: true, data: { enabled: false } };
      return { ok: true, data: true };
    });
    Object.assign(chrome, { storage: {
      local: {
        get: () => new Promise<Record<string, unknown>>((resolve) => { finishRead = resolve; }),
        set: async () => {},
      },
      onChanged: {
        addListener: (listener: (next: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => changes.add(listener),
        removeListener: (listener: (next: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => changes.delete(listener),
      },
    } });

    const host = await mount("sidepanel");
    const control = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动显示标注工具"]')!;
    await act(async () => {
      for (const listener of changes)
        listener({ "ui.selectionToolbarEnabled": { newValue: false } as chrome.storage.StorageChange }, "local");
      finishRead!({ "ui.selectionToolbarEnabled": true });
      await Promise.resolve();
    });
    expect(control.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      for (const listener of changes)
        listener({ "ui.selectionToolbarEnabled": { oldValue: false } as chrome.storage.StorageChange }, "local");
    });
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("does not present a PDF welcome screen when the active tab URL is unavailable", async () => {
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: { tabId: 7, kind: "unavailable", currentReader: false, candidates: [], reason: "context-unavailable" } };
      return { ok: true, data: true };
    }, { id: 7, url: undefined, title: "Unknown tab" });

    const host = await mount("sidepanel");
    expect(host.textContent).toContain("无法读取当前页面");
    expect(host.textContent).not.toContain("在 Web Ink 中读 PDF");
    expect(host.textContent).toContain("打开资料库");
    expect(host.textContent).toContain("选择本地 PDF");
  });

  it("offers webpage access when an unknown tab has not been authorized", async () => {
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: { tabId: 7, kind: "unavailable", currentReader: false, candidates: [], reason: "context-unavailable" } };
      return { ok: true, data: true };
    }, { id: 7, url: undefined, title: "Unknown tab" }, undefined, {
      contains: async () => false,
      request: async () => true,
    });

    const host = await mount("sidepanel");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "启用网页访问")).toBe(true);
  });

  it("ignores completion updates from a background tab", async () => {
    let updated: TabUpdatedListener | undefined;
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: { tabId: 7, kind: "unavailable", currentReader: false, candidates: [] } };
      if (message.type === "page.state.get") return { ok: true, data: { states: [] } };
      if (message.type === "page.mode.get") return { ok: true, data: { enabled: false } };
      return { ok: true, data: true };
    }, undefined, (listener) => { updated = listener; });

    await mount("sidepanel");
    const before = sent.mock.calls.filter(([message]) => message.type === "pdf.context.get").length;
    await act(async () => {
      updated!(8, { status: "complete" });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(sent.mock.calls.filter(([message]) => message.type === "pdf.context.get")).toHaveLength(before);
  });

  it("opens and focuses the note editor after a sidepanel selection is saved", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const posted: Array<{ requestId: string }> = [];
    let saved = false;
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: saved ? [record] : [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: { tabId: 7, kind: "unavailable", currentReader: false, candidates: [] } };
      if (message.type === "page.state.get") return { ok: true, data: { states: [] } };
      if (message.type === "page.mode.get") return { ok: true, data: { enabled: false } };
      return { ok: true, data: true };
    });
    Object.assign(chrome.tabs, { connect: () => ({
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.add(listener), removeListener: (listener: (message: unknown) => void) => listeners.delete(listener) },
      onDisconnect: { addListener: () => {}, removeListener: () => {} },
      postMessage: (message: { requestId: string }) => posted.push(message),
      disconnect: () => {},
    }) });

    const host = await mount("sidepanel");
    const selected = { type: "selection" as const, pageUrl: record.pageUrl, status: "ready" as const, token: "selection", text: record.target.exact };
    await act(async () => { for (const listener of listeners) listener(selected); });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="添加笔记"]')!.click());
    await act(async () => {
      saved = true;
      for (const listener of listeners)
        listener({ type: "saved", requestId: posted[0]!.requestId, annotation: record });
    });

    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(editor).toBeTruthy();
    expect(document.activeElement).toBe(editor);
  });

  it("disables Focus for an unresolved linked annotation and shows its validated original link", async () => {
    const linked: Annotation = {
      ...record,
      note: "Keep this note",
      target: {
        ...record.target,
        rootSelector: 'a[href="https://content.example.test/original-story"]',
      },
    };
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [linked] } };
      if (message.type === "page.state.get") {
        return {
          ok: true,
          data: {
            pageUrl: linked.pageUrl,
            states: [{ id: linked.id, status: "unresolved", reason: "Original location is unavailable." }],
          },
        };
      }
      if (message.type === "page.mode.get") return { ok: true, data: { enabled: true } };
      if (message.type === "pdf.context.get") {
        return { ok: true, data: { tabId: 7, kind: "unavailable", currentReader: false, candidates: [], reason: "not-pdf" } };
      }
      return { ok: true, data: true };
    });

    const host = await mount("sidepanel");
    await act(async () => {
      (host.querySelector(".annotation-row") as HTMLButtonElement).click();
    });

    const focus = [...host.querySelectorAll<HTMLButtonElement>(".detail-actions button")]
      .find((button) => button.textContent === "定位");
    expect(focus?.disabled).toBe(true);
    const original = [...host.querySelectorAll<HTMLAnchorElement>(".detail-actions a")]
      .find((anchor) => anchor.textContent === "打开原内容");
    expect(original?.href).toBe("https://content.example.test/original-story");
    expect(original?.getAttribute("target")).toBe("_blank");
    expect(original?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(host.textContent).toContain("当前页面未能确认原标注位置。摘录和笔记仍已保留。");
    expect(host.textContent).toContain("Keep this note");
  });

  it("does not infer an original-content link from legacy or unsafe text targets", async () => {
    const legacy: Annotation = {
      ...record,
      target: { ...record.target, rootSelector: "body" },
    };
    const unsafe: Annotation = {
      ...record,
      id: "unsafe-link",
      target: { ...record.target, rootSelector: 'a[href="javascript:alert(1)"]' },
    };
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [legacy, unsafe] } };
      return { ok: true, data: true };
    });

    const host = await mount("library");
    await act(async () => {
      (host.querySelector(".annotation-row") as HTMLButtonElement).click();
    });
    expect([...host.querySelectorAll<HTMLAnchorElement>(".detail-actions a")]
      .some((anchor) => anchor.textContent === "打开原内容")).toBe(false);

    await act(async () => {
      (host.querySelectorAll<HTMLButtonElement>(".annotation-row")[1]!).click();
    });
    expect([...host.querySelectorAll<HTMLAnchorElement>(".detail-actions a")]
      .some((anchor) => anchor.textContent === "打开原内容")).toBe(false);
    expect([...host.querySelectorAll<HTMLAnchorElement>(".detail-actions a")]
      .some((anchor) => anchor.href.startsWith("javascript:"))).toBe(false);
  });

  it("Open PDF uses a learned DOI for a legacy IEEE record and carries its recovery target", async () => {
    const hash = "a".repeat(64);
    const pdf: Annotation = { ...record, id: "legacy-ieee", kind: "pdf-text", pageUrl: `urn:web-ink:pdf:${hash}`,
      pageTitle: "IEEE-11643626.pdf", target: { documentHash: hash, fileName: "IEEE-11643626.pdf",
        sourceUrl: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626&ticket=expired",
        pageNumber: 3, rects: [{ x: .1, y: .2, width: .3, height: .1 }], exact: "priors", prefix: "", suffix: "" } };
    installChrome(message => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [pdf] } };
      return { ok: true, data: true };
    });
    const preferences = { [`ui.pdfPaperIdentity.${hash}`]: { doi: "10.1109/TII.2026.3716639",
      paperUrl: "https://ieeexplore.ieee.org/document/11643626" } };
    const sessionValues: Record<string, unknown> = {};
    Object.assign(chrome, { storage: { local: { get: async () => preferences }, session: {
      set: async (entries: Record<string, unknown>) => Object.assign(sessionValues, entries),
    } } });
    Object.assign(chrome.runtime, { getContexts: async () => [] });
    const host = await mount("library");
    await act(async () => (host.querySelector(".annotation-row") as HTMLButtonElement).click());
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>(".detail-actions button")].find(button => button.textContent === "打开 PDF")!.click();
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://doi.org/10.1109/TII.2026.3716639" });
    expect(sessionValues["pdf.paperReopen.9"]).toEqual(expect.objectContaining({ documentHash: hash, pageNumber: 3 }));
    expect(pdf.target.sourceUrl).toContain("ticket=expired");
  });
  it("opens the previous PDF version's records as a scoped library and allows returning to all records", async () => {
    const originalUrl = location.href;
    history.replaceState(null, "", `/library.html?document=${"a".repeat(64)}`);
    try {
      const queries: Array<{ pageUrl?: string }> = [];
      installChrome(message => {
        if (message.type === "settings.get") return { ok: true, data: settings };
        if (message.type === "annotations.query") {
          queries.push(message.query as { pageUrl?: string });
          return { ok: true, data: { items: [] } };
        }
        return { ok: true, data: true };
      });
      const host = await mount("library");
      expect(queries.at(-1)?.pageUrl).toBe(`urn:web-ink:pdf:${"a".repeat(64)}`);
      expect(host.textContent).toContain("之前版本的标注");
      await act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "查看全部")!.click();
        await new Promise(resolve => setTimeout(resolve, 30));
      });
      expect(queries.at(-1)?.pageUrl).toBeUndefined();
      expect(host.textContent).not.toContain("之前版本的标注");
    } finally { history.replaceState(null, "", originalUrl); }
  });
  it("finishes management listener cleanup when Reload invalidates Chrome events", async () => {
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      return { ok: true, data: true };
    });
    await mount("library");
    const removes = [chrome.runtime.onMessage, chrome.tabs.onActivated, chrome.tabs.onUpdated]
      .map((event) => vi.mocked(event.removeListener));
    for (const remove of removes) remove.mockImplementation(() => { throw new Error("Extension context invalidated."); });
    const current = root!;
    root = undefined;
    await expect(act(async () => current.unmount())).resolves.toBeUndefined();
    for (const remove of removes) expect(remove).toHaveBeenCalled();
  });

  it("keeps the initial library records collapsed until the reader chooses one", async () => {
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query")
        return { ok: true, data: { items: [record] } };
      return { ok: true, data: true };
    });

    const host = await mount("library");

    expect(host.querySelector(".annotation-detail")).toBeNull();
    expect(host.querySelector(".annotation-row")?.getAttribute("aria-current")).toBeNull();

    await act(async () => {
      (host.querySelector(".annotation-row") as HTMLButtonElement).click();
    });
    expect(host.querySelector(".annotation-detail")).not.toBeNull();
  });

  it("restores the narrow library reading position after Back", async () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const scrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
    const scrollTo = Object.getOwnPropertyDescriptor(window, "scrollTo");
    const restored = vi.fn();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 1477 });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: restored });
    try {
      installChrome((message) => {
        if (message.type === "settings.get") return { ok: true, data: settings };
        if (message.type === "annotations.query")
          return { ok: true, data: { items: [record] } };
        return { ok: true, data: true };
      });
      const host = await mount("library");
      await act(async () => {
        (host.querySelector(".annotation-row") as HTMLButtonElement).click();
      });
      await act(async () => {
        (host.querySelector(".back-button") as HTMLButtonElement).click();
      });
      expect(restored).toHaveBeenCalledWith({ top: 1477, behavior: "auto" });
    } finally {
      if (width) Object.defineProperty(window, "innerWidth", width);
      if (scrollY) Object.defineProperty(window, "scrollY", scrollY);
      if (scrollTo) Object.defineProperty(window, "scrollTo", scrollTo);
    }
  });

  it("returns a narrow library to its list when the selected record is deleted", async () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const scrollTo = Object.getOwnPropertyDescriptor(window, "scrollTo");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    const second = { ...record, id: "web-2", target: { ...record.target, exact: "Another saved annotation" } };
    try {
      installChrome((message) => {
        if (message.type === "settings.get") return { ok: true, data: settings };
        if (message.type === "annotations.query") return { ok: true, data: { items: [record, second] } };
        if (message.type === "annotations.delete") return { ok: true, data: { id: message.id, deleted: true } };
        return { ok: true, data: true };
      });
      const host = await mount("library");
      await act(async () => {
        (host.querySelector(".annotation-row") as HTMLButtonElement).click();
      });
      await act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>(".detail-actions button")]
          .find((button) => button.textContent === "删除")!
          .click();
      });
      await act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>(".confirm-delete button")]
          .find((button) => button.textContent === "确认删除")!
          .click();
      });
      const browser = host.querySelector<HTMLElement>(".annotation-browser")!;
      expect(browser.classList.contains("detail-open")).toBe(false);
      expect(browser.querySelectorAll(".annotation-row")).toHaveLength(1);
    } finally {
      if (width) Object.defineProperty(window, "innerWidth", width);
      if (scrollTo) Object.defineProperty(window, "scrollTo", scrollTo);
    }
  });

  it("renders a library-specific empty state without an empty record frame", async () => {
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query")
        return { ok: true, data: { items: [] } };
      return { ok: true, data: true };
    });
    const host = await mount("library");
    expect(host.querySelector(".annotation-browser")).toBeNull();
    expect(host.textContent).toContain("还没有保存的标注");
    expect(host.textContent).toContain("当前页面");
  });

  it("uses the observed current-tab context and sends only a selected source to the background", async () => {
    const context: PdfTabContext = {
      tabId: 7,
      url: "https://example.test/reading",
      kind: "embedded",
      currentReader: false,
      candidates: [
        { url: "https://example.test/one.pdf", via: "iframe" },
        { url: "https://example.test/two.pdf", via: "object" },
      ],
    };
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query")
        return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: context };
      if (message.type === "pdf.openCurrent") {
        return {
          ok: true,
          data: {
            tabId: 7,
            readerUrl: "chrome-extension://test/pdf.html?handoff=token",
            navigation: "same-tab",
            token: "token",
            sourceUrl: message.candidateUrl,
          },
        };
      }
      return { ok: true, data: true };
    }, { id: 7, windowId: 1, url: "https://example.test/reading", title: "Reading" });

    const host = await mount("sidepanel");

    expect(sent).toHaveBeenCalledWith({
      type: "pdf.context.get",
      tabId: 7,
      windowId: 1,
      expectedUrl: "https://example.test/reading",
    });
    expect(host.querySelector('button[aria-label="打开 PDF"]')).toBeNull();
    expect(host.querySelector(".pdf-local-link")).toBeNull();
    const choices = [...host.querySelectorAll<HTMLButtonElement>(".pdf-source-choice")];
    expect(choices.map((button) => button.textContent)).toEqual([
      "https://example.test/one.pdf",
      "https://example.test/two.pdf",
    ]);

    await act(async () => choices[1]!.click());
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.openCurrent",
      tabId: 7,
      windowId: 1,
      expectedUrl: "https://example.test/reading",
      candidateUrl: "https://example.test/two.pdf",
    });
  });

  it("labels and opens an IEEE wrapper with the current IEEE sign-in", async () => {
    const ieee = "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123";
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") {
        return {
          ok: true,
          data: {
            tabId: 7,
            url: ieee,
            publisher: "ieee",
            kind: "wrapper",
            currentReader: false,
            candidates: [],
          },
        };
      }
      if (message.type === "pdf.openCurrent")
        return { ok: true, data: { tabId: 7, navigation: "same-tab", token: "token" } };
      return { ok: true, data: true };
    }, { id: 7, windowId: 1, url: ieee, title: "IEEE paper" });

    const host = await mount("sidepanel");
    const action = host.querySelector<HTMLButtonElement>(".pdf-open-current")!;
    expect(action.textContent).toContain("用 Web Ink 标注当前 PDF");

    await act(async () => action.click());
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.openCurrent",
      tabId: 7,
      windowId: 1,
      expectedUrl: ieee,
      accessMode: "site-session",
    });

    await act(async () => {
      (host.querySelector(".pdf-local-link") as HTMLButtonElement).click();
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://test/pdf.html?open=local",
    });
    expect(sent.mock.calls.some(([message]) => message.type === "ui.open")).toBe(false);
  });

  it("clears a previous PDF error while a new read is pending", async () => {
    const ieee = "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123";
    let attempts = 0;
    let finish: ((value: unknown) => void) | undefined;
    installChrome(message => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: { tabId: 7, url: ieee, publisher: "ieee", kind: "wrapper", currentReader: false, candidates: [] } };
      if (message.type === "pdf.openCurrent") {
        if (++attempts === 1) return { ok: false, error: "Previous PDF read failed" };
        return new Promise(resolve => { finish = resolve; });
      }
      return { ok: true, data: true };
    }, { id: 7, windowId: 1, url: ieee, title: "IEEE paper" });
    const host = await mount("sidepanel");
    const action = host.querySelector<HTMLButtonElement>(".pdf-open-current")!;
    await act(async () => { action.click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Previous PDF read failed");
    await act(async () => { action.click(); });
    expect(action.disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { finish!({ ok: true, data: { tabId: 7, navigation: "same-tab" } }); });
  });

  it("does not open an IEEE wrapper when the exact host permission is denied", async () => {
    const ieee = "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123";
    const contains = vi.fn(async () => false);
    const requestPermission = vi.fn(async () => false);
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") {
        return { ok: true, data: {
          tabId: 7,
          url: ieee,
          publisher: "ieee",
          kind: "wrapper",
          currentReader: false,
          candidates: [],
        } };
      }
      if (message.type === "pdf.openCurrent")
        return { ok: true, data: { tabId: 7, navigation: "same-tab", token: "token" } };
      return { ok: true, data: true };
    }, { id: 7, windowId: 1, url: ieee, title: "IEEE paper" }, undefined, {
      contains,
      request: requestPermission,
    });

    const host = await mount("sidepanel");
    await act(async () => {
      (host.querySelector(".pdf-open-current") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(contains).toHaveBeenCalledWith({ origins: ["https://ieeexplore.ieee.org/*"] });
    expect(requestPermission).toHaveBeenCalledWith({ origins: ["https://ieeexplore.ieee.org/*"] });
    expect(sent.mock.calls.some(([message]) => message.type === "pdf.openCurrent")).toBe(false);
    expect(host.textContent).toContain("IEEE 网站访问权限");
  });

  it("requires an explicit IEEE source selection when several candidates are observed", async () => {
    const ieee = "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123";
    const first = "https://ieeexplore.ieee.org/download?document=one";
    const second = "https://ieeexplore.ieee.org/download?document=two";
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") {
        return { ok: true, data: {
          tabId: 7,
          url: ieee,
          publisher: "ieee",
          kind: "wrapper",
          currentReader: false,
          candidates: [{ url: first, via: "iframe" }, { url: second, via: "iframe" }],
        } };
      }
      if (message.type === "pdf.openCurrent")
        return { ok: true, data: { tabId: 7, navigation: "same-tab", token: "token" } };
      return { ok: true, data: true };
    }, { id: 7, windowId: 1, url: ieee, title: "IEEE paper" });

    const host = await mount("sidepanel");
    const choices = host.querySelectorAll<HTMLButtonElement>(".pdf-source-choice");
    expect(choices).toHaveLength(2);
    expect(choices[1]!.textContent).toContain("用 Web Ink 标注当前 PDF");

    await act(async () => choices[1]!.click());
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.openCurrent",
      tabId: 7,
      windowId: 1,
      expectedUrl: ieee,
      candidateUrl: second,
      accessMode: "site-session",
    });
  });

  it("opens a cross-origin IEEE-wrapper candidate publicly without requesting IEEE access", async () => {
    const ieee = "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123";
    const second = "https://papers.example.test/second.pdf";
    const contains = vi.fn(async () => true);
    const requestPermission = vi.fn(async () => true);
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") {
        return { ok: true, data: {
          tabId: 7,
          url: ieee,
          publisher: "ieee",
          kind: "wrapper",
          currentReader: false,
          candidates: [{ url: second, via: "object" }],
        } };
      }
      if (message.type === "pdf.openCurrent")
        return { ok: true, data: { tabId: 7, navigation: "same-tab", token: "token" } };
      return { ok: true, data: true };
    }, { id: 7, windowId: 1, url: ieee, title: "IEEE paper" }, undefined, {
      contains,
      request: requestPermission,
    });

    const host = await mount("sidepanel");
    expect(host.querySelector<HTMLButtonElement>(".pdf-open-current")?.textContent)
      .toContain("用 Web Ink 标注当前 PDF");
    const publicChoice = host.querySelector<HTMLButtonElement>(".pdf-source-choice")!;
    expect(publicChoice.textContent).toContain(second);

    await act(async () => publicChoice.click());
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.openCurrent",
      tabId: 7,
      windowId: 1,
      expectedUrl: ieee,
      candidateUrl: second,
    });
    expect(requestPermission).not.toHaveBeenCalled();
    sent.mockClear();
    const header = host.querySelector<HTMLButtonElement>('.header-actions button[aria-label="用 Web Ink 标注当前 PDF"]')!;
    await act(async () => header.click());
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.openCurrent", tabId: 7, windowId: 1, expectedUrl: ieee, accessMode: "site-session",
    });
    expect(sent.mock.calls.some(([message]) => message.type === "pdf.openCurrent" && 'candidateUrl' in message)).toBe(false);
  });

  it("uses an authoritative reader URL when Chrome withholds the active Tab URL", async () => {
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query")
        return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") {
        return {
          ok: true,
          data: {
            tabId: 7,
            url: "chrome-extension://test/pdf.html?handoff=session-token",
            kind: "wrapper",
            currentReader: true,
            handoffToken: "session-token",
            candidates: [{ url: "https://example.test/paper.pdf", via: "viewer" }],
          },
        };
      }
      return { ok: true, data: true };
    }, { id: 7, title: "Paper" });

    const host = await mount("sidepanel");

    expect(host.textContent).toContain("正在连接 PDF");
    expect(host.querySelector(".pdf-open-current")).toBeNull();
    expect(host.querySelector(".pdf-local-link")).toBeNull();
    expect(host.querySelector('button[aria-label="打开 PDF"]')).toBeNull();
    expect(sent.mock.calls.filter(([message]) => message.type === "pdf.openCurrent")).toHaveLength(0);
  });

  it("does not let a late tab context refresh replace the latest window ID", async () => {
    const originalUrl = "https://example.test/reading";
    const updatedUrl = "https://example.test/updated-reading";
    let resolveInitialContext!: (value: unknown) => void;
    const initialContext = new Promise<unknown>((resolve) => {
      resolveInitialContext = resolve;
    });
    let contextRequestCount = 0;
    const initialTab = {
      id: 7,
      windowId: 1,
      url: originalUrl,
      title: "Reading",
    };
    let activeTab = initialTab;
    let fireTabUpdated: TabUpdatedListener | undefined;
    const contextFor = (url: string): PdfTabContext => ({
      tabId: 7,
      url,
      kind: "direct",
      currentReader: false,
      candidates: [{ url, via: "url" }],
    });
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query")
        return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") {
        contextRequestCount++;
        return contextRequestCount === 1
          ? initialContext
          : { ok: true, data: contextFor(updatedUrl) };
      }
      return { ok: true, data: true };
    }, initialTab, (listener) => {
      fireTabUpdated = listener;
    });
    Object.defineProperty(chrome.tabs, "query", {
      configurable: true,
      value: async () => [activeTab],
    });

    const host = await mount("sidepanel");
    expect(fireTabUpdated).toBeDefined();

    activeTab = { ...initialTab, windowId: 2, url: updatedUrl };
    await act(async () => {
      fireTabUpdated!(7, { url: updatedUrl });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    resolveInitialContext({ ok: true, data: contextFor(originalUrl) });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

    await act(async () => {
      (host.querySelector(".pdf-open-current") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.context.get",
      tabId: 7,
      windowId: 1,
      expectedUrl: originalUrl,
    });
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.context.get",
      tabId: 7,
      windowId: 2,
      expectedUrl: updatedUrl,
    });
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.openCurrent",
      tabId: 7,
      windowId: 2,
      expectedUrl: updatedUrl,
      candidateUrl: updatedUrl,
    });
  });

  it("keeps tab listeners subscribed while context changes and refreshes both updates and activations", async () => {
    const firstUrl = "https://example.test/reading";
    const ieeeUrl = "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123";
    const finalUrl = "https://example.test/final-reading";
    let activeTab = { id: 7, windowId: 1, url: firstUrl, title: "First" };
    let fireTabUpdated: TabUpdatedListener | undefined;
    let fireTabActivated: TabActivatedListener | undefined;
    const contextFor = (): PdfTabContext => activeTab.url === ieeeUrl
      ? {
          tabId: activeTab.id,
          url: activeTab.url,
          publisher: "ieee",
          kind: "wrapper",
          currentReader: false,
          candidates: [],
        }
      : {
          tabId: activeTab.id,
          url: activeTab.url,
          kind: "direct",
          currentReader: false,
          candidates: [{ url: activeTab.url, via: "url" }],
        };
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") return { ok: true, data: contextFor() };
      return { ok: true, data: true };
    }, activeTab, (listener) => {
      fireTabUpdated = listener;
    }, undefined, (listener) => {
      fireTabActivated = listener;
    });
    Object.defineProperty(chrome.tabs, "query", {
      configurable: true,
      value: async () => [activeTab],
    });

    const host = await mount("sidepanel");
    expect(host.querySelector(".pdf-open-current")?.textContent).toContain("用 Web Ink 标注当前 PDF");
    const updatedSubscriptions = vi.mocked(chrome.tabs.onUpdated.addListener).mock.calls.length;
    const activatedSubscriptions = vi.mocked(chrome.tabs.onActivated.addListener).mock.calls.length;
    const updatedRemovals = vi.mocked(chrome.tabs.onUpdated.removeListener).mock.calls.length;
    const activatedRemovals = vi.mocked(chrome.tabs.onActivated.removeListener).mock.calls.length;

    activeTab = { id: 8, windowId: 1, url: ieeeUrl, title: "IEEE" };
    await act(async () => {
      fireTabUpdated!(8, { url: ieeeUrl });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.querySelector(".pdf-open-current")?.textContent).toContain("用 Web Ink 标注当前 PDF");

    // Tab subscriptions must stay live across the context-driven render; otherwise an
    // activation that lands during listener replacement can leave stale UI indefinitely.
    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledTimes(updatedSubscriptions);
    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalledTimes(updatedRemovals);
    expect(chrome.tabs.onActivated.addListener).toHaveBeenCalledTimes(activatedSubscriptions);
    expect(chrome.tabs.onActivated.removeListener).toHaveBeenCalledTimes(activatedRemovals);

    activeTab = { id: 9, windowId: 1, url: finalUrl, title: "Final" };
    await act(async () => {
      fireTabActivated!({ tabId: 9, windowId: 1 });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.querySelector(".pdf-open-current")?.textContent).toContain("用 Web Ink 标注当前 PDF");
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.context.get",
      tabId: 9,
      windowId: 1,
      expectedUrl: finalUrl,
    });
  });

  it("closes the side-panel More menu with Escape and returns focus to its trigger", async () => {
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "pdf.context.get") {
        return {
          ok: true,
          data: {
            tabId: 7,
            kind: "unavailable",
            currentReader: false,
            candidates: [],
            reason: "not-pdf",
          },
        };
      }
      if (message.type === "annotations.query")
        return { ok: true, data: { items: [] } };
      if (message.type === "page.state.get")
        return { ok: true, data: { states: [] } };
      if (message.type === "page.mode.get")
        return { ok: true, data: { enabled: true } };
      return { ok: true, data: true };
    });

    const host = await mount("sidepanel");
    const menu = host.querySelector<HTMLDetailsElement>(".menu")!;
    const trigger = menu.querySelector<HTMLElement>("summary")!;

    await act(async () => trigger.click());
    expect(menu.open).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the background-reported running identity instead of a static build file", async () => {
    const sent = installChrome((message) => {
      if (message.type === "runtime.health") {
        return {
          ok: true,
          data: {
            generation: "1df9c7d0-4e35-4a24-b844-5c921f46b7a8",
            version: "0.3.2",
            commit: "abcdef1234567890",
            dirty: false,
          },
        };
      }
      return { ok: true, data: true };
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(createElement(BuildInfo, { language: "zh-CN" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(sent).toHaveBeenCalledWith({ type: "runtime.health" });
    expect(host.textContent).toContain("v0.3.2 · abcdef1");
    expect(host.textContent).toContain("1df9c7d0-4e35-4a24-b844-5c921f46b7a8");
  });

  it("offers labelled suggestions for the current partial tag without replacing earlier tags", async () => {
    installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query")
        return { ok: true, data: { items: [record] } };
      return { ok: true, data: true };
    });
    const host = await mount("library");
    await act(async () => {
      (host.querySelector(".annotation-row") as HTMLButtonElement).click();
    });
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "笔记")!
        .click();
    });
    const tagInput = [...host.querySelectorAll<HTMLInputElement>("input")]
      .find((input) => input.value === "research")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(tagInput, "already, res");
      tagInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector(".tag-suggestions")?.getAttribute("aria-label")).toBe("匹配的标签");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>(".tag-suggestions button")]
        .find((button) => button.textContent === "research")!
        .click();
    });
    expect(tagInput.value).toBe("already, research");
  });

  it("keeps current-result tag suggestions while a free tag filter has no match", async () => {
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query") {
        const query = message.query as { tag?: string } | undefined;
        return { ok: true, data: { items: query?.tag === "res" ? [] : [record] } };
      }
      return { ok: true, data: true };
    });
    const host = await mount("library");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("筛选"))!
        .click();
    });
    expect(host.querySelector(".filter-tag-suggestions")?.getAttribute("aria-label")).toBe("当前结果中的标签");
    expect(host.querySelector(".filter-tag-suggestions")?.textContent).toContain("research");
    const tagFilter = host.querySelector<HTMLInputElement>('input[aria-label="标签"]');
    expect(tagFilter).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(tagFilter, "res");
      tagFilter!.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector(".filter-tag-suggestions")?.textContent).toContain("research");
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({
      type: "annotations.query",
      query: expect.objectContaining({ tag: "res" }),
    }));
  });

  it("keeps a specific PDF opening error actionable without a false refresh hint", async () => {
    const sent = installChrome((message) => {
      if (message.type === "settings.get") return { ok: true, data: settings };
      if (message.type === "annotations.query")
        return { ok: true, data: { items: [] } };
      if (message.type === "pdf.context.get") {
        return {
          ok: true,
          data: {
            tabId: 7,
            url: "https://example.test/paper.pdf",
            kind: "direct",
            currentReader: false,
            candidates: [{ url: "https://example.test/paper.pdf", via: "url" }],
          },
        };
      }
      if (message.type === "pdf.openCurrent") {
        return { ok: false, code: "PDF_SOURCE_UNAVAILABLE", error: "Choose a source again." };
      }
      return { ok: true, data: true };
    }, { id: 7, url: "https://example.test/paper.pdf", title: "Paper" });
    const host = await mount("sidepanel");
    await act(async () => {
      (host.querySelector(".pdf-open-current") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.textContent).toContain("Choose a source again.");
    expect(host.textContent).not.toContain("刷新此页后重试。");
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.openCurrent",
      tabId: 7,
      expectedUrl: "https://example.test/paper.pdf",
      candidateUrl: "https://example.test/paper.pdf",
    });
  });
});
