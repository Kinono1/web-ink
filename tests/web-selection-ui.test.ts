import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WebSelection } from "../src/ui/WebSelection";
import type { TextAnnotation } from "../src/core/model";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

type Listener = (message: unknown) => void;

function selection(text = "Selected webpage text") {
  return {
    type: "selection" as const,
    pageUrl: "https://example.test/article",
    status: "ready" as const,
    token: "selection-token",
    text,
  };
}

function annotation(): TextAnnotation {
  return {
    id: "selection-1",
    kind: "text",
    pageUrl: "https://example.test/article",
    pageTitle: "Article",
    color: "#facd5a",
    note: "",
    tags: [],
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    revision: 1,
    target: { exact: "Selected webpage text", prefix: "", suffix: "", start: 0, end: 21, rootSelector: "body" },
  };
}

function installChrome() {
  const ports: Array<{ messages: unknown[]; listeners: Set<Listener>; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal("chrome", {
    tabs: {
      connect: vi.fn(() => {
        const port = { messages: [] as unknown[], listeners: new Set<Listener>(), disconnect: vi.fn() };
        ports.push(port);
        return {
          onMessage: { addListener: (listener: Listener) => port.listeners.add(listener), removeListener: (listener: Listener) => port.listeners.delete(listener) },
          onDisconnect: { addListener: () => {}, removeListener: () => {} },
          postMessage: (message: unknown) => port.messages.push(message),
          disconnect: port.disconnect,
        } as unknown as chrome.runtime.Port;
      }),
    },
  });
  return {
    ports,
    send(index: number, message: unknown) {
      for (const listener of ports[index]?.listeners ?? []) listener(message);
    },
  };
}

let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount(props: Partial<React.ComponentProps<typeof WebSelection>> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(WebSelection, {
    tabId: 7,
    pageUrl: "https://example.test/article",
    language: "zh-CN",
    defaultColor: "#facd5a",
    onSaved: vi.fn(),
    onError: vi.fn(),
    ...props,
  })));
  return host;
}

describe("WebSelection", () => {
  it("keeps a manual selection visible and only sends an annotation after a color is chosen", async () => {
    const { ports, send } = installChrome();
    const host = await mount();

    await act(async () => send(0, selection()));
    const region = host.querySelector<HTMLElement>('[role="region"][aria-label="当前选区"]')!;
    expect(region.textContent).toContain("Selected webpage text");
    expect(ports[0]?.messages).toEqual([]);

    await act(async () => region.querySelector<HTMLButtonElement>('[aria-label="高亮 #facd5a"]')!.click());
    expect(ports[0]?.messages).toEqual([expect.objectContaining({ type: "annotate", token: "selection-token", color: "#facd5a" })]);

    await act(async () => send(0, { ...selection(), status: "saving" }));
    expect(region.textContent).toContain("Selected webpage text");
    expect(region.querySelector<HTMLButtonElement>('[aria-label="高亮 #facd5a"]')!.disabled).toBe(true);
  });

  it("opens the note editor only after the selection save succeeds", async () => {
    const { ports, send } = installChrome();
    const onSaved = vi.fn();
    const host = await mount({ onSaved });
    await act(async () => send(0, selection()));

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="添加笔记"]')!.click());
    expect(onSaved).not.toHaveBeenCalled();
    const request = ports[0]?.messages[0] as { requestId: string };
    await act(async () => send(0, { type: "saved", requestId: request.requestId, annotation: annotation() }));
    expect(onSaved).toHaveBeenCalledWith(annotation(), true);
  });

  it("recovers controls when a reconnected port reports saving then ready without a local request", async () => {
    const { send } = installChrome();
    const host = await mount();
    const color = () => host.querySelector<HTMLButtonElement>('[aria-label="高亮 #facd5a"]')!;

    await act(async () => send(0, { ...selection(), status: "saving" }));
    expect(color().disabled).toBe(true);
    await act(async () => send(0, selection()));
    expect(color().disabled).toBe(false);
  });

  it("disconnects and ignores stale replies after a tab changes", async () => {
    const { ports, send } = installChrome();
    const onSaved = vi.fn();
    const host = await mount({ onSaved });
    await act(async () => send(0, selection()));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="添加笔记"]')!.click());
    await act(async () => root!.render(createElement(WebSelection, {
      tabId: 8,
      pageUrl: "https://example.test/next",
      language: "zh-CN",
      defaultColor: "#facd5a",
      onSaved,
      onError: vi.fn(),
    })));

    expect(ports[0]?.disconnect).toHaveBeenCalledOnce();
    const request = ports[0]?.messages[0] as { requestId: string };
    await act(async () => send(0, { type: "saved", requestId: request.requestId, annotation: annotation() }));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
