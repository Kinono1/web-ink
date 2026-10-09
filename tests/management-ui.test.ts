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
  tab: { id: number; url?: string; title?: string } = {
    id: 7,
    url: "https://example.test/article",
    title: "Article",
  },
) {
  const events = { addListener: vi.fn(), removeListener: vi.fn() };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        sendMessage: vi.fn(sendMessage),
        onMessage: events,
        getURL: (path: string) =>
          `chrome-extension://test/${path.replace(/^\//, "")}`,
      },
      permissions: { contains: async () => true },
      tabs: { query: async () => [tab], onActivated: events, onUpdated: events },
    },
  });
  return globalThis.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
}

async function mount(mode: "sidepanel" | "library") {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(ManagementApp, { mode }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return host;
}

describe("management UI", () => {
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
    }, { id: 7, url: "https://example.test/reading", title: "Reading" });

    const host = await mount("sidepanel");

    expect(sent).toHaveBeenCalledWith({
      type: "pdf.context.get",
      tabId: 7,
      expectedUrl: "https://example.test/reading",
    });
    const choices = [...host.querySelectorAll<HTMLButtonElement>(".pdf-source-choice")];
    expect(choices.map((button) => button.textContent)).toEqual([
      "https://example.test/one.pdf",
      "https://example.test/two.pdf",
    ]);

    await act(async () => choices[1]!.click());
    expect(sent).toHaveBeenCalledWith({
      type: "pdf.openCurrent",
      tabId: 7,
      expectedUrl: "https://example.test/reading",
      candidateUrl: "https://example.test/two.pdf",
    });
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

    expect(host.textContent).toContain("正在阅读");
    expect(host.querySelector(".pdf-open-current")).toBeNull();
    expect(host.querySelector(".pdf-local-link")).toBeNull();
    expect(sent.mock.calls.filter(([message]) => message.type === "pdf.openCurrent")).toHaveLength(0);
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
});
