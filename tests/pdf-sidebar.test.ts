import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPdfSidebarBroker } from "../src/background/pdf-sidebar";
import type { PdfNoteDraft } from "../src/pdf/PdfNote";
import type { PdfAnnotation } from "../src/pdf/types";
import type { PdfSidebarState } from "../src/pdf/sidebar-types";

const ID = "web-ink-id";
const HASH = "a".repeat(64);
const PAGE_URL = `urn:web-ink:pdf:${HASH}`;
const SESSION = "12345678-1234-4123-8123-123456789abc";
const NEXT_SESSION = "23456789-2345-4234-8234-23456789abcd";
const ownUrl = (path: string) => `chrome-extension://${ID}/${path}`;
let connect: (port: chrome.runtime.Port) => void;

function record(id = "note-1", pageUrl = PAGE_URL): PdfAnnotation {
  return {
    id, pageUrl, pageTitle: "Paper", kind: "pdf-text", color: "#facc15",
    note: "Original note", tags: ["research"], revision: 1,
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
    target: {
      documentHash: pageUrl.slice("urn:web-ink:pdf:".length), fileName: "paper.pdf",
      pageNumber: 1, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
      exact: "A selected passage", prefix: "", suffix: "",
    },
  };
}
function draft(base = record()): PdfNoteDraft {
  return { note: "Unsaved note", tags: "research, reading", color: "#38bdf8", base, editing: true };
}
function state(overrides: Partial<PdfSidebarState> = {}): PdfSidebarState {
  return {
    pageUrl: PAGE_URL, sessionId: SESSION, fileName: "paper.pdf", records: [record()], totalCount: 1,
    drafts: {}, conflicts: {}, locked: false, removing: false, ...overrides,
  };
}
function readerSender(tabId = 7): chrome.runtime.MessageSender {
  return {
    id: ID, url: ownUrl("pdf.html?source=paper#page=2"), frameId: 0,
    documentId: `reader-document-${tabId}`, tab: { id: tabId } as chrome.tabs.Tab,
  };
}
function fakePort(name: string, sender?: chrome.runtime.MessageSender) {
  const messages: unknown[] = [];
  const messageListeners = new Set<(message: unknown, port: chrome.runtime.Port) => void>();
  const disconnectListeners = new Set<(port: chrome.runtime.Port) => void>();
  let closed = false;
  const port = {
    name, sender,
    postMessage: (message: unknown) => {
      if (closed) throw Error("Port disconnected");
      messages.push(structuredClone(message));
    },
    // Chrome does not fire onDisconnect locally when disconnect() is called.
    disconnect: vi.fn(() => { closed = true; }),
    onMessage: { addListener: (listener: (message: unknown, port: chrome.runtime.Port) => void) => messageListeners.add(listener) },
    onDisconnect: { addListener: (listener: (port: chrome.runtime.Port) => void) => disconnectListeners.add(listener) },
  } as unknown as chrome.runtime.Port;
  return {
    port, messages,
    receive: (message: unknown) => {
      for (const listener of messageListeners) listener(structuredClone(message), port);
    },
    disconnectFromPeer: () => {
      closed = true;
      for (const listener of disconnectListeners) listener(port);
    },
    failPosts: () => { closed = true; },
  };
}
function reader(tabId = 7) {
  const result = fakePort("web-ink-pdf-reader", readerSender(tabId));
  connect(result.port);
  return result;
}
function sidebar(tabId?: number) {
  const result = fakePort("web-ink-pdf-sidebar", { id: ID, url: ownUrl("sidepanel.html") });
  connect(result.port);
  if (tabId !== undefined) result.receive({ type: "watch", tabId });
  return result;
}
function command(value: unknown, overrides: Record<string, unknown> = {}) {
  return { type: "command", commandId: "command-1", pageUrl: PAGE_URL, sessionId: SESSION, command: value, ...overrides };
}

beforeEach(() => {
  connect = () => {};
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: vi.fn(async () => undefined), id: ID, getURL: ownUrl, onConnect: { addListener: (listener: typeof connect) => { connect = listener; } } },
    storage: { local: { set: () => { throw Error("Broker must not persist state"); } }, session: { set: () => { throw Error("Broker must not persist state"); } } },
  });
  installPdfSidebarBroker();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("PDF sidebar sender trust", () => {
  it("accepts own exact reader and sidebar paths with query strings and fragments", () => {
    const pdf = reader(0);
    const panel = fakePort("web-ink-pdf-sidebar", { id: ID, url: ownUrl("sidepanel.html?mode=pdf#notes") });
    connect(panel.port);
    panel.receive({ type: "watch", tabId: 0 });
    pdf.receive({ type: "state", state: state() });
    expect(panel.messages.at(-1)).toEqual({ type: "state", state: state() });
    expect(pdf.messages.at(-1)).toEqual({ type: "attached", attached: true });
  });

  it.each([
    ["foreign extension ID", { id: "foreign-extension" }],
    ["ordinary website", { url: "https://example.test/pdf.html" }],
    ["foreign extension origin", { url: "chrome-extension://foreign-extension/pdf.html" }],
    ["nested reader path", { url: ownUrl("nested/pdf.html") }],
    ["reader path suffix", { url: ownUrl("pdf.html/extra") }],
    ["encoded reader filename", { url: ownUrl("%70df.html") }],
    ["missing sender URL", { url: undefined }],
    ["child frame", { frameId: 1 }],
    ["missing frame ID", { frameId: undefined }],
    ["negative tab ID", { tab: { id: -1 } }],
    ["fractional tab ID", { tab: { id: 7.5 } }],
    ["missing tab", { tab: undefined }],
    ["empty document ID", { documentId: "" }],
    ["missing document ID", { documentId: undefined }],
  ])("rejects a reader with %s", (_name, overrides) => {
    const pdf = fakePort("web-ink-pdf-reader", { ...readerSender(), ...overrides } as chrome.runtime.MessageSender);
    connect(pdf.port);
    const panel = sidebar(7);
    pdf.receive({ type: "state", state: state() });
    expect(pdf.port.disconnect).toHaveBeenCalledOnce();
    expect(panel.messages).toEqual([{ type: "unavailable" }]);
  });

  it.each([
    { id: "foreign-extension", url: ownUrl("sidepanel.html") },
    { id: ID, url: "https://example.test/sidepanel.html" },
    { id: ID, url: "chrome-extension://foreign-extension/sidepanel.html" },
    { id: ID, url: ownUrl("nested/sidepanel.html") },
    { id: ID, url: ownUrl("sidepanel.html/extra") },
    { id: ID, url: ownUrl("pdf.html") },
  ])("rejects an untrusted sidebar sender %j", (sender) => {
    const pdf = reader();
    const panel = fakePort("web-ink-pdf-sidebar", sender);
    connect(panel.port);
    panel.receive({ type: "watch", tabId: 7 });
    pdf.receive({ type: "state", state: state() });
    panel.receive(command({ type: "remove", id: "note-1" }));
    expect(panel.port.disconnect).toHaveBeenCalledOnce();
    expect(panel.messages).toEqual([]);
    expect(pdf.messages).toEqual([{ type: "attached", attached: false }]);
  });

  it("leaves unrelated runtime ports alone", () => {
    const port = fakePort("unrelated-port", readerSender());
    connect(port.port);
    expect(port.port.disconnect).not.toHaveBeenCalled();
    expect(port.messages).toEqual([]);
  });
});

describe("PDF sidebar routing and transient state", () => {
  it("announces a newly ready document so an already open sidebar refreshes its context", () => {
    const pdf = reader(7);
    pdf.receive({ type: "state", state: null });
    pdf.receive({ type: "state", state: state() });
    pdf.receive({ type: "state", state: state({ notice: "Saved" }) });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "pdf.reader.changed", tabId: 7 });
    pdf.receive({ type: "state", state: state({ sessionId: NEXT_SESSION }) });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("routes state and commands only to the watched tab", () => {
    const first = reader(7), second = reader(8);
    const one = sidebar(7), two = sidebar(8);
    first.receive({ type: "state", state: state() });
    const other = state({ records: [record("note-2")] });
    second.receive({ type: "state", state: other });
    one.receive(command({ type: "focus", id: "note-1" }));
    expect(one.messages).toEqual([{ type: "unavailable" }, { type: "state", state: state() }]);
    expect(two.messages).toEqual([{ type: "unavailable" }, { type: "state", state: other }]);
    expect(first.messages.at(-1)).toEqual(command({ type: "focus", id: "note-1" }));
    expect(second.messages).toEqual([{ type: "attached", attached: false }, { type: "attached", attached: true }]);
  });

  it("gives new watchers the latest state without replaying a previous command acknowledgement", () => {
    const pdf = reader();
    const one = sidebar(7);
    pdf.receive({ type: "state", state: state(), ack: "earlier-command" });
    const latest = state({ notice: "Saved" });
    pdf.receive({ type: "state", state: latest, ack: "command-1" });
    const two = sidebar(7);
    expect(one.messages.at(-1)).toEqual({ type: "state", state: latest, ack: "command-1" });
    expect(two.messages).toEqual([{ type: "state", state: latest }]);
  });

  it("clears old records on a null state and refuses commands until a document is available", () => {
    const pdf = reader(), panel = sidebar(7);
    pdf.receive({ type: "state", state: state() });
    pdf.receive({ type: "state", state: null });
    const next = sidebar(7);
    expect(panel.messages.at(-1)).toEqual({ type: "state", state: null });
    expect(next.messages).toEqual([{ type: "state", state: null }]);
    const count = pdf.messages.length;
    panel.receive(command({ type: "remove", id: "note-1" }));
    expect(pdf.messages).toHaveLength(count);
  });

  it("requires both the PDF key and document session for same-file replacement commands", () => {
    const pdf = reader(), panel = sidebar(7);
    pdf.receive({ type: "state", state: state({ sessionId: NEXT_SESSION }) });
    panel.receive(command({ type: "remove", id: "note-1" }));
    panel.receive(command({ type: "remove", id: "note-1" }, { sessionId: NEXT_SESSION }));
    expect(pdf.messages.filter((message) => (message as { type: string }).type === "command"))
      .toEqual([command({ type: "remove", id: "note-1" }, { sessionId: NEXT_SESSION })]);
  });

  it("sends unavailable for an unwatched or absent reader and rejects malformed watch requests", () => {
    const pdf = reader(), panel = sidebar();
    panel.receive({ type: "watch", tabId: 9 });
    expect(panel.messages).toEqual([{ type: "unavailable" }]);
    panel.receive({ type: "watch", tabId: 7 });
    pdf.receive({ type: "state", state: state() });
    for (const tabId of [-1, 0.5, "7", null]) panel.receive({ type: "watch", tabId });
    panel.receive(command({ type: "focus", id: "note-1" }));
    expect(pdf.messages.at(-1)).toEqual(command({ type: "focus", id: "note-1" }));
    panel.receive({ type: "watch", tabId: undefined });
    expect(panel.messages.at(-1)).toEqual({ type: "unavailable" });
    expect(pdf.messages.at(-1)).toEqual({ type: "attached", attached: false });
  });

  it("ignores invalid reader state without replacing the last valid snapshot", () => {
    const pdf = reader(), panel = sidebar(7);
    pdf.receive({ type: "state", state: state() });
    const count = panel.messages.length;
    for (const invalid of [
      state({ records: [record("note-2", `urn:web-ink:pdf:${"b".repeat(64)}`)] }),
      { ...state(), records: [{}] }, { ...state(), locked: "false" },
      { ...state(), sessionId: "" }, { ...state(), conflicts: { "note-1": "true" } },
    ]) pdf.receive({ type: "state", state: invalid });
    expect(panel.messages).toHaveLength(count);
    expect(sidebar(7).messages).toEqual([{ type: "state", state: state() }]);
  });
});

describe("PDF sidebar connection lifecycle", () => {
  it("updates attachment only when the first watcher joins or the last watcher leaves", () => {
    const pdf = reader(), one = sidebar(7), two = sidebar(7);
    one.receive({ type: "watch", tabId: 7 });
    one.disconnectFromPeer();
    expect(pdf.messages).toEqual([{ type: "attached", attached: false }, { type: "attached", attached: true }]);
    two.disconnectFromPeer();
    expect(pdf.messages.at(-1)).toEqual({ type: "attached", attached: false });
  });

  it("detaches the previous reader when a sidebar switches tabs", () => {
    const first = reader(7), second = reader(8), panel = sidebar(7);
    first.receive({ type: "state", state: state() });
    second.receive({ type: "state", state: state({ records: [record("note-2")] }) });
    panel.receive({ type: "watch", tabId: 8 });
    panel.receive(command({ type: "focus", id: "note-2" }));
    expect(first.messages.at(-1)).toEqual({ type: "attached", attached: false });
    expect(second.messages.at(-1)).toEqual(command({ type: "focus", id: "note-2" }));
    expect(panel.messages.at(-1)).toEqual({ type: "state", state: state({ records: [record("note-2")] }) });
  });

  it("attaches a reader that connects after its sidebar starts watching", () => {
    const panel = sidebar(7), pdf = reader();
    expect(panel.messages.at(-1)).toEqual({ type: "unavailable" });
    expect(pdf.messages).toEqual([{ type: "attached", attached: true }]);
    pdf.receive({ type: "state", state: state() });
    expect(panel.messages.at(-1)).toEqual({ type: "state", state: state() });
  });

  it("drops disconnected reader state and announces unavailable", () => {
    const pdf = reader(), panel = sidebar(7);
    pdf.receive({ type: "state", state: state() });
    pdf.disconnectFromPeer();
    expect(panel.messages.at(-1)).toEqual({ type: "unavailable" });
    expect(sidebar(7).messages).toEqual([{ type: "unavailable" }]);
    panel.receive(command({ type: "undo" }));
    expect(pdf.messages.filter((message) => (message as { type: string }).type === "command")).toEqual([]);
  });

  it("closes a replaced reader and prevents its late messages or cleanup from deleting the new reader", () => {
    const old = reader(), panel = sidebar(7);
    old.receive({ type: "state", state: state() });
    const next = reader();
    expect(old.port.disconnect).toHaveBeenCalledOnce();
    expect(panel.messages.at(-1)).toEqual({ type: "unavailable" });
    const fresh = state({ sessionId: NEXT_SESSION, notice: "New reader" });
    next.receive({ type: "state", state: fresh });
    const count = panel.messages.length;
    old.receive({ type: "state", state: state({ notice: "Old reader" }) });
    old.disconnectFromPeer();
    expect(panel.messages).toHaveLength(count);
    expect(sidebar(7).messages).toEqual([{ type: "state", state: fresh }]);
    panel.receive(command({ type: "focus", id: "note-1" }, { sessionId: NEXT_SESSION }));
    expect(next.messages.at(-1)).toEqual(command({ type: "focus", id: "note-1" }, { sessionId: NEXT_SESSION }));
  });

  it("continues broadcasting when a sidebar post fails and detaches it", () => {
    const pdf = reader(), broken = sidebar(7), healthy = sidebar(7);
    broken.failPosts();
    pdf.receive({ type: "state", state: state() });
    expect(healthy.messages.at(-1)).toEqual({ type: "state", state: state() });
    expect(broken.port.disconnect).toHaveBeenCalledOnce();
    healthy.disconnectFromPeer();
    expect(pdf.messages.at(-1)).toEqual({ type: "attached", attached: false });
  });

  it("clears a reader whose post fails without waiting for a disconnect event", () => {
    const pdf = reader(), panel = sidebar(7);
    pdf.receive({ type: "state", state: state() });
    pdf.failPosts();
    panel.receive(command({ type: "focus", id: "note-1" }));
    expect(panel.messages.at(-1)).toEqual({ type: "unavailable" });
    expect(sidebar(7).messages).toEqual([{ type: "unavailable" }]);
    expect(pdf.port.disconnect).toHaveBeenCalledOnce();
  });
});

describe("PDF sidebar command boundary", () => {
  it.each([
    ["stale PDF key", command({ type: "remove", id: "note-1" }, { pageUrl: `urn:web-ink:pdf:${"b".repeat(64)}` })],
    ["stale document session", command({ type: "remove", id: "note-1" }, { sessionId: NEXT_SESSION })],
    ["deleted record", command({ type: "remove", id: "missing" })],
    ["oversized draft", command({ type: "draft", id: "note-1", draft: { ...draft(), note: "n".repeat(10_001) } })],
  ])("acknowledges a rejected valid envelope with the current snapshot: %s", (_name, value) => {
    const pdf = reader(), panel = sidebar(7);
    pdf.receive({ type: "state", state: state() });
    const count = pdf.messages.length;
    panel.receive(value);
    expect(pdf.messages).toHaveLength(count);
    expect(panel.messages.at(-1)).toEqual({ type: "state", state: state(), ack: "command-1" });
  });

  it.each([
    { type: "focus", id: "note-1" }, { type: "draft", id: "note-1", draft: draft() },
    { type: "draft", id: "note-1" }, { type: "save", id: "note-1" },
    { type: "remove", id: "note-1" }, { type: "undo" }, { type: "more" },
  ])("forwards the valid command %j", (value) => {
    const pdf = reader(), panel = sidebar(7);
    pdf.receive({ type: "state", state: state({ drafts: { "note-1": draft() }, undoRecord: record("removed-note") }) });
    panel.receive(command(value));
    expect(pdf.messages.at(-1)).toEqual(command(value));
  });

  it.each([
    command({ type: "unknown" }), command({ type: "focus", id: "missing" }),
    command({ type: "remove", id: "note-1", tabId: 8 }),
    command({ type: "focus", id: "note-1" }, { commandId: "" }),
    command({ type: "focus", id: "note-1" }, { commandId: 1 }),
    command({ type: "focus", id: "note-1" }, { pageUrl: "https://example.test/other.pdf" }),
    command({ type: "focus", id: "note-1" }, { pageUrl: undefined }),
    command({ type: "focus", id: "note-1" }, { sessionId: undefined }),
    command({ type: "focus", id: "note-1" }, { tabId: 8 }),
    command({ type: "draft", id: "note-1", resolveConflict: "yes", draft: draft() }),
    command({ type: "draft", id: "note-1", draft: { ...draft(), note: 1 } }),
    command({ type: "draft", id: "note-1", draft: { ...draft(), tags: [] } }),
    command({ type: "draft", id: "note-1", draft: { ...draft(), color: "red" } }),
    command({ type: "draft", id: "note-1", draft: { ...draft(), editing: "true" } }),
    command({ type: "draft", id: "note-1", draft: draft(record("other-id")) }),
    command({ type: "draft", id: "note-1", draft: draft({ ...record(), revision: 2 }) }),
    command({ type: "draft", id: "note-1", draft: draft({ ...record(), target: { ...record().target, pageNumber: 2 } }) }),
    command({ type: "undo", id: "note-1" }),
  ])("does not route invalid command input %j", (value) => {
    const pdf = reader(), panel = sidebar(7);
    pdf.receive({ type: "state", state: state() });
    const count = pdf.messages.length;
    panel.receive(value);
    expect(pdf.messages).toHaveLength(count);
  });

  it("retains a disconnected draft from an older revision without allowing implicit conflict resolution", () => {
    const pdf = reader(), panel = sidebar(7);
    const newer = { ...record(), revision: 2, note: "Updated elsewhere" };
    pdf.receive({ type: "state", state: state({ records: [newer] }) });
    panel.receive(command({ type: "draft", id: "note-1", draft: draft() }));
    expect(pdf.messages.at(-1)).toEqual(command({ type: "draft", id: "note-1", draft: draft() }));
    const count = pdf.messages.length;
    panel.receive(command({ type: "draft", id: "note-1", draft: draft(), resolveConflict: true }));
    expect(pdf.messages).toHaveLength(count);
  });

  it("keeps an existing stale draft editable while requiring the current record for conflict resolution", () => {
    const pdf = reader(), panel = sidebar(7);
    const current = { ...record(), revision: 2, note: "Updated elsewhere" };
    pdf.receive({ type: "state", state: state({ records: [current], drafts: { "note-1": draft() }, conflicts: { "note-1": true } }) });
    const oldDraft = { ...draft(), note: "Still editing" };
    panel.receive(command({ type: "draft", id: "note-1", draft: oldDraft }));
    expect(pdf.messages.at(-1)).toEqual(command({ type: "draft", id: "note-1", draft: oldDraft }));
    const count = pdf.messages.length;
    panel.receive(command({ type: "draft", id: "note-1", draft: oldDraft, resolveConflict: true }));
    expect(pdf.messages).toHaveLength(count);
    panel.receive(command({ type: "draft", id: "note-1", draft: draft(current), resolveConflict: true }));
    expect(pdf.messages.at(-1)).toEqual(command({ type: "draft", id: "note-1", draft: draft(current), resolveConflict: true }));
  });

  it("allows clearing an orphaned draft but rejects saving or removing a deleted record", () => {
    const pdf = reader(), panel = sidebar(7);
    pdf.receive({ type: "state", state: state({ records: [], drafts: { "note-1": draft() } }) });
    panel.receive(command({ type: "draft", id: "note-1" }));
    expect(pdf.messages.at(-1)).toEqual(command({ type: "draft", id: "note-1" }));
    const count = pdf.messages.length;
    panel.receive(command({ type: "save", id: "note-1" }));
    panel.receive(command({ type: "remove", id: "note-1" }));
    panel.receive(command({ type: "undo" }));
    expect(pdf.messages).toHaveLength(count);
  });
});
