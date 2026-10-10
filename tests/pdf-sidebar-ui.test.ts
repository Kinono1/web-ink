import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PdfSidebar } from "../src/ui/PdfSidebar";
import type { PdfAnnotation } from "../src/pdf/types";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PAGE_A = `urn:web-ink:pdf:${HASH_A}`;
const PAGE_B = `urn:web-ink:pdf:${HASH_B}`;

type Listener = (message: unknown) => void;

class PortEvent {
  private listeners = new Set<Listener>();

  addListener = (listener: Listener) => this.listeners.add(listener);
  removeListener = (listener: Listener) => this.listeners.delete(listener);

  emit(message: unknown) {
    for (const listener of this.listeners) listener(message);
  }
}

class FakePort {
  readonly onMessage = new PortEvent();
  readonly onDisconnect = new PortEvent();
  readonly postMessage = vi.fn();

  deliver(message: unknown) {
    this.onMessage.emit(message);
  }

  disconnect() {
    this.onDisconnect.emit(undefined);
  }
}

let root: Root | undefined;
let ports: FakePort[];
const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");

function annotation(
  id = "pdf-note-a",
  pageUrl = PAGE_A,
  hash = HASH_A,
): PdfAnnotation {
  return {
    id,
    kind: "pdf-text",
    pageUrl,
    pageTitle: hash === HASH_A ? "first.pdf" : "second.pdf",
    color: "#facc15",
    note: "Saved note",
    tags: ["research"],
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    revision: 3,
    target: {
      documentHash: hash,
      fileName: hash === HASH_A ? "first.pdf" : "second.pdf",
      pageNumber: 4,
      rects: [],
      exact: "The selected PDF text",
      prefix: "",
      suffix: "",
    },
  };
}

function draft(record: PdfAnnotation, note = record.note) {
  return {
    note,
    tags: record.tags.join(", "),
    color: record.color,
    base: record,
    editing: true,
  };
}

function state(overrides: Record<string, unknown> = {}) {
  const record = annotation();
  return {
    sessionId: "reader-session-a",
    pageUrl: PAGE_A,
    fileName: "first.pdf",
    records: [record],
    totalCount: 1,
    drafts: {},
    conflicts: {},
    locked: false,
    removing: false,
    noteSaving: undefined,
    undoRecord: undefined,
    error: "",
    notice: "",
    ...overrides,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(PdfSidebar, { tabId: 7, language: "zh-CN" })));
  await settle();
  return host;
}

async function sendState(port: FakePort, next: Record<string, unknown>, ack?: string) {
  await act(async () => {
    port.deliver({ type: "state", state: next, ...(ack ? { ack } : {}) });
  });
  await settle();
}

function lastCommand(port: FakePort) {
  const message = [...port.postMessage.mock.calls]
    .map(([value]) => value)
    .reverse()
    .find((value) => (value as { type?: string }).type === "command");
  expect(message).toBeTruthy();
  return message as {
    type: "command";
    commandId: string;
    pageUrl: string;
    sessionId: string;
    command: Record<string, unknown>;
  };
}

beforeEach(() => {
  ports = [];
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        id: "web-ink-test",
        connect: vi.fn(() => {
          const port = new FakePort();
          ports.push(port);
          return port;
        }),
      },
    },
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  if (chromeDescriptor)
    Object.defineProperty(globalThis, "chrome", chromeDescriptor);
  else Reflect.deleteProperty(globalThis, "chrome");
});

describe("PDF sidebar", () => {
  it("renders the current reader document notes through the sidebar port", async () => {
    const host = await mount();
    const port = ports[0]!;

    expect(port.postMessage).toHaveBeenCalledWith({ type: "watch", tabId: 7 });
    await sendState(port, state());

    expect(host.querySelector(".pdf-sidebar-context strong")?.textContent).toBe("first.pdf");
    expect(host.querySelector('[data-pdf-note="pdf-note-a"]')?.textContent).toContain("The selected PDF text");
    expect(host.textContent).toContain("Saved note");
  });

  it("renders an orphan PDF draft and keeps its deletion warning actionable", async () => {
    const host = await mount();
    const port = ports[0]!;
    const record = annotation();

    await sendState(port, state({ records: [], drafts: { [record.id]: draft(record, "Keep this orphan draft") } }));

    const note = host.querySelector(`[data-pdf-note="${record.id}"]`);
    expect(note?.textContent).toContain("Keep this orphan draft");
    expect(note?.querySelector('[role="alert"]')?.textContent).toContain("原标注已被删除");
    expect([...note!.querySelectorAll("button")].some((button) => button.textContent === "放弃草稿")).toBe(true);
  });

  it("sends draft commands with the reader scope and does not let an older snapshot overwrite fast input", async () => {
    const host = await mount();
    const port = ports[0]!;
    const current = state();
    await sendState(port, current);

    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "编辑")!
        .click();
    });
    const openEditor = lastCommand(port);
    expect(openEditor).toMatchObject({
      pageUrl: PAGE_A,
      sessionId: "reader-session-a",
      command: { type: "draft", id: "pdf-note-a", resolveConflict: true },
    });

    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Fast local input");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const typed = lastCommand(port);
    expect(typed).toMatchObject({
      pageUrl: PAGE_A,
      sessionId: "reader-session-a",
      command: {
        type: "draft",
        id: "pdf-note-a",
        draft: expect.objectContaining({ note: "Fast local input" }),
      },
    });

    await sendState(port, current);
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Fast local input");

    await sendState(port, state({
      drafts: { "pdf-note-a": draft(annotation(), "Reader acknowledged input") },
    }), typed.commandId);
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Reader acknowledged input");
  });

  it("clears a pending draft when a different reader session and file become current", async () => {
    const host = await mount();
    const port = ports[0]!;
    await sendState(port, state());

    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "编辑")!
        .click();
    });
    expect(host.querySelector("textarea")).toBeTruthy();

    const nextRecord = annotation("pdf-note-b", PAGE_B, HASH_B);
    await sendState(port, state({
      sessionId: "reader-session-b",
      pageUrl: PAGE_B,
      fileName: "second.pdf",
      records: [nextRecord],
      drafts: {},
    }));

    expect(host.querySelector('[data-pdf-note="pdf-note-a"]')).toBeNull();
    expect(host.querySelector('[data-pdf-note="pdf-note-b"]')).toBeTruthy();
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("asks the reader for more records instead of locally expanding a truncated snapshot", async () => {
    const host = await mount();
    const port = ports[0]!;
    const records = Array.from({ length: 50 }, (_, index) =>
      annotation(`pdf-note-${index}`),
    );
    await sendState(port, state({ records, totalCount: 51 }));

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".load-more")!.click();
    });
    expect(lastCommand(port)).toMatchObject({
      pageUrl: PAGE_A,
      sessionId: "reader-session-a",
      command: { type: "more" },
    });
  });

  it("locks a saving draft until its reader ACK, then preserves it after a failed save", async () => {
    const host = await mount();
    const port = ports[0]!;
    const record = annotation();
    const pendingDraft = draft(record, "Keep this while save is pending");
    await sendState(port, state({ drafts: { [record.id]: pendingDraft } }));

    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.disabled).toBe(false);
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "保存")!
        .click();
    });
    const save = lastCommand(port);
    expect(save).toMatchObject({
      pageUrl: PAGE_A,
      sessionId: "reader-session-a",
      command: { type: "save", id: record.id },
    });

    // A delayed stale state cannot reopen the editor before this command resolves.
    await sendState(port, state({ drafts: { [record.id]: pendingDraft } }));
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "保存")?.disabled).toBe(true);

    await sendState(port, state({
      drafts: { [record.id]: pendingDraft },
      conflicts: { [record.id]: true },
      error: "Annotation changed in another tab.",
    }), save.commandId);
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this while save is pending");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Annotation changed in another tab.");
    expect(host.textContent).toContain("其他窗口已修改");
  });

  it("bounds pasted note input before sending it so a rejection cannot replace it with the old note", async () => {
    const host = await mount();
    const port = ports[0]!;
    const original = annotation();
    await sendState(port, state({ drafts: { "pdf-note-a": draft(original) } }));
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    const pasted = "x".repeat(10001);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, pasted);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sent = lastCommand(port);
    expect((sent.command.draft as { note: string }).note).toBe("x".repeat(10000));
    expect(textarea.value).toBe("x".repeat(10000));
    await sendState(port, state({ drafts: { "pdf-note-a": draft(original, "x".repeat(10000)) } }), sent.commandId);
    expect(textarea.value).toBe("x".repeat(10000));
    expect(host.textContent).toContain("10,000");
  });

  it("recovers when a command races a disconnected Chrome port", async () => {
    const host = await mount();
    const port = ports[0]!;
    await sendState(port, state());
    port.postMessage.mockImplementation(() => { throw Error("Attempting to use a disconnected port object"); });
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "编辑")!.click();
    });
    expect(host.querySelector('[data-pdf-note="pdf-note-a"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("正在连接 PDF");
  });

  it("replays the latest unacknowledged draft after reconnecting to the same reader", async () => {
    vi.useFakeTimers();
    const host = await mount();
    const first = ports[0]!;
    await sendState(first, state());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "编辑")!.click());
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Latest unacknowledged input");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => first.disconnect());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const reconnected = ports[1]!;
    await sendState(reconnected, state());
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Latest unacknowledged input");
    expect(lastCommand(reconnected).command).toMatchObject({ type: "draft", draft: { note: "Latest unacknowledged input" } });
  });

  it("drops old records on disconnect and renders only the replay from the reconnected port", async () => {
    vi.useFakeTimers();
    const host = await mount();
    const first = ports[0]!;
    await sendState(first, state());
    expect(host.querySelector('[data-pdf-note="pdf-note-a"]')).toBeTruthy();

    await act(async () => first.disconnect());
    expect(host.querySelector('[data-pdf-note="pdf-note-a"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("正在连接 PDF");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const second = ports[1]!;
    expect(second.postMessage).toHaveBeenCalledWith({ type: "watch", tabId: 7 });

    const nextRecord = annotation("pdf-note-b", PAGE_B, HASH_B);
    await sendState(second, state({
      sessionId: "reader-session-b",
      pageUrl: PAGE_B,
      fileName: "second.pdf",
      records: [nextRecord],
    }));
    expect(host.querySelector('[data-pdf-note="pdf-note-a"]')).toBeNull();
    expect(host.querySelector('[data-pdf-note="pdf-note-b"]')).toBeTruthy();
  });
});
