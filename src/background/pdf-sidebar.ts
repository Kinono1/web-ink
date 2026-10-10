import { validateAnnotation } from "../core/validation";
import type { PdfNoteDraft } from "../pdf/PdfNote";
import type {
  PdfReaderRequest,
  PdfSidebarCommand,
  PdfSidebarCommandMessage,
  PdfSidebarState,
  PdfSidebarUpdate,
} from "../pdf/sidebar-types";
import type { PdfAnnotation } from "../pdf/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Reader = { port: chrome.runtime.Port; state?: PdfSidebarState | null };
type Sidebar = { port: chrome.runtime.Port; tabId?: number };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function text(value: unknown, max: number, empty = true): value is string {
  return typeof value === "string" && value.length <= max && (empty || value.trim().length > 0);
}
function identifier(value: unknown): value is string {
  return text(value, 128, false) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
function tabId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function ownPage(sender: chrome.runtime.MessageSender | undefined, path: string): boolean {
  if (sender?.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
  try {
    const url = new URL(sender.url), own = new URL(chrome.runtime.getURL(path));
    return !url.username && !url.password && url.protocol === own.protocol && url.host === own.host && url.pathname === own.pathname;
  } catch { return false; }
}
function pdfRecord(value: unknown, pageUrl: string): PdfAnnotation | undefined {
  try {
    const record = validateAnnotation(value);
    if ((record.kind === "pdf-text" || record.kind === "pdf-area") && record.pageUrl === pageUrl) return record;
  } catch { /* Malformed port input is ignored at this boundary. */ }
  return undefined;
}
function noteDraft(value: unknown, pageUrl: string, id: string): PdfNoteDraft | undefined {
  if (!object(value) || !onlyKeys(value, ["note", "tags", "color", "base", "editing"]) ||
    !text(value.note, 10_000) || !text(value.tags, 10_000) ||
    typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color) || typeof value.editing !== "boolean") return;
  const base = pdfRecord(value.base, pageUrl);
  if (!base || base.id !== id) return;
  return { note: value.note, tags: value.tags, color: value.color, base, editing: value.editing };
}
function sidebarState(value: unknown): PdfSidebarState | null | undefined {
  if (value === null) return null;
  if (!object(value) || !onlyKeys(value, [
    "pageUrl", "sessionId", "fileName", "records", "totalCount", "drafts", "conflicts", "locked",
    "noteSaving", "removing", "undoRecord", "error", "notice",
  ]) || typeof value.pageUrl !== "string" || !/^urn:web-ink:pdf:[0-9a-f]{64}$/.test(value.pageUrl) ||
    typeof value.sessionId !== "string" || !UUID.test(value.sessionId) || !text(value.fileName, 512, false) ||
    !Array.isArray(value.records) || !Number.isSafeInteger(value.totalCount) || (value.totalCount as number) < value.records.length ||
    !object(value.drafts) || !object(value.conflicts) || typeof value.locked !== "boolean" || typeof value.removing !== "boolean" ||
    (value.noteSaving !== undefined && !identifier(value.noteSaving)) ||
    (value.error !== undefined && !text(value.error, 20_000)) ||
    (value.notice !== undefined && !text(value.notice, 20_000))) return;
  const records: PdfAnnotation[] = [];
  const ids = new Set<string>();
  for (const input of value.records) {
    const record = pdfRecord(input, value.pageUrl);
    if (!record || ids.has(record.id)) return;
    records.push(record);
    ids.add(record.id);
  }
  const drafts: Record<string, PdfNoteDraft> = {};
  for (const [id, input] of Object.entries(value.drafts)) {
    const draft = identifier(id) ? noteDraft(input, value.pageUrl, id) : undefined;
    if (!draft) return;
    drafts[id] = draft;
  }
  for (const [id, conflict] of Object.entries(value.conflicts)) {
    if (!identifier(id) || typeof conflict !== "boolean") return;
  }
  const undoRecord = value.undoRecord === undefined ? undefined : pdfRecord(value.undoRecord, value.pageUrl);
  if (value.undoRecord !== undefined && !undoRecord) return;
  return { ...value, records, drafts, conflicts: { ...value.conflicts }, ...(undoRecord ? { undoRecord } : {}) } as PdfSidebarState;
}
function sidebarCommand(value: unknown, state: PdfSidebarState): PdfSidebarCommand | undefined {
  if (!object(value)) return;
  if (value.type === "more" && onlyKeys(value, ["type"])) return { type: "more" };
  if (value.type === "undo" && onlyKeys(value, ["type"]) && state.undoRecord) return { type: "undo" };
  if (!identifier(value.id)) return;
  const record = state.records.find((item) => item.id === value.id);
  if (value.type === "focus" || value.type === "save" || value.type === "remove") {
    if (record && onlyKeys(value, ["type", "id"])) return { type: value.type, id: value.id };
    return;
  }
  if (value.type !== "draft" || !onlyKeys(value, ["type", "id", "draft", "resolveConflict"]) ||
    (value.resolveConflict !== undefined && typeof value.resolveConflict !== "boolean")) return;
  const cachedDraft = Object.hasOwn(state.drafts, value.id) ? state.drafts[value.id] : undefined;
  if (!record && !cachedDraft) return;
  if (value.draft === undefined) return { type: "draft", id: value.id, ...(value.resolveConflict === undefined ? {} : { resolveConflict: value.resolveConflict }) };
  const draft = noteDraft(value.draft, state.pageUrl, value.id);
  if (!draft) return;
  // An existing stale draft keeps its original revision; resolving a conflict
  // must deliberately adopt the current reader-owned record instead.
  const base = JSON.stringify(draft.base);
  if (base !== JSON.stringify(record) && (value.resolveConflict || base !== JSON.stringify(cachedDraft?.base))) return;
  return { type: "draft", id: value.id, draft, ...(value.resolveConflict === undefined ? {} : { resolveConflict: value.resolveConflict }) };
}
function closePort(port: chrome.runtime.Port): void {
  try { port.disconnect(); } catch { /* The peer may already have disconnected. */ }
}

/** Ports own all lifetime and document scope; no annotation state enters storage. */
export function installPdfSidebarBroker(): void {
  const readers = new Map<number, Reader>();
  const sidebars = new Set<Sidebar>();
  const watchers = (id: number) => [...sidebars].filter((sidebar) => sidebar.tabId === id);

  function forgetReader(id: number, reader: Reader): void {
    if (readers.get(id) !== reader) return;
    readers.delete(id);
    for (const sidebar of watchers(id)) sendSidebar(sidebar, { type: "unavailable" });
  }
  function forgetSidebar(sidebar: Sidebar): void {
    if (!sidebars.delete(sidebar) || sidebar.tabId === undefined || watchers(sidebar.tabId).length) return;
    const reader = readers.get(sidebar.tabId);
    if (reader) sendReader(sidebar.tabId, reader, { type: "attached", attached: false });
  }
  function sendSidebar(sidebar: Sidebar, message: PdfSidebarUpdate): void {
    try { sidebar.port.postMessage(message); }
    catch { forgetSidebar(sidebar); closePort(sidebar.port); }
  }
  function sendReader(id: number, reader: Reader, message: PdfReaderRequest): void {
    try { reader.port.postMessage(message); }
    catch { forgetReader(id, reader); closePort(reader.port); }
  }
  function snapshot(sidebar: Sidebar): void {
    const reader = sidebar.tabId === undefined ? undefined : readers.get(sidebar.tabId);
    sendSidebar(sidebar, reader?.state === undefined ? { type: "unavailable" } : { type: "state", state: reader.state });
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "web-ink-pdf-reader") {
      const sender = port.sender;
      if (!ownPage(sender, "pdf.html") || !tabId(sender?.tab?.id) || sender?.frameId !== 0 || !text(sender.documentId, 128, false)) {
        closePort(port);
        return;
      }
      const id = sender.tab!.id!;
      const reader: Reader = { port };
      const previous = readers.get(id);
      // Replace before closing: a queued old disconnect cannot remove this reader.
      readers.set(id, reader);
      port.onMessage.addListener((message: unknown) => {
        if (readers.get(id) !== reader || !object(message) || message.type !== "state" ||
          !onlyKeys(message, ["type", "state", "ack"]) || (message.ack !== undefined && !text(message.ack, 128, false))) return;
        const state = sidebarState(message.state);
        if (state === undefined) return;
        const newlyReady = state && state.sessionId !== reader.state?.sessionId;
        reader.state = state;
        if (newlyReady) void chrome.runtime.sendMessage({ type: "pdf.reader.changed", tabId: id }).catch(() => undefined);
        const update: PdfSidebarUpdate = { type: "state", state, ...(message.ack === undefined ? {} : { ack: message.ack }) };
        for (const sidebar of watchers(id)) sendSidebar(sidebar, update);
      });
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; forgetReader(id, reader); });
      if (previous) {
        closePort(previous.port);
        for (const sidebar of watchers(id)) sendSidebar(sidebar, { type: "unavailable" });
      }
      sendReader(id, reader, { type: "attached", attached: watchers(id).length > 0 });
      return;
    }
    if (port.name !== "web-ink-pdf-sidebar") return;
    if (!ownPage(port.sender, "sidepanel.html")) { closePort(port); return; }
    const sidebar: Sidebar = { port };
    sidebars.add(sidebar);
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; forgetSidebar(sidebar); });
    port.onMessage.addListener((message: unknown) => {
      if (!sidebars.has(sidebar) || !object(message)) return;
      if (message.type === "watch") {
        if (!onlyKeys(message, ["type", "tabId"]) || (message.tabId !== undefined && !tabId(message.tabId))) return;
        const previous = sidebar.tabId;
        sidebar.tabId = message.tabId as number | undefined;
        if (previous !== sidebar.tabId) {
          const oldReader = previous === undefined ? undefined : readers.get(previous);
          if (oldReader && !watchers(previous!).length) sendReader(previous!, oldReader, { type: "attached", attached: false });
          const reader = sidebar.tabId === undefined ? undefined : readers.get(sidebar.tabId);
          if (reader && watchers(sidebar.tabId!).length === 1) sendReader(sidebar.tabId!, reader, { type: "attached", attached: true });
        }
        snapshot(sidebar);
        return;
      }
      if (message.type !== "command" || !onlyKeys(message, ["type", "commandId", "pageUrl", "sessionId", "command"]) ||
        !text(message.commandId, 128, false) || typeof message.pageUrl !== "string" || typeof message.sessionId !== "string") return;
      const reader = sidebar.tabId === undefined ? undefined : readers.get(sidebar.tabId);
      if (!reader?.state) { snapshot(sidebar); return; }
      const current = reader.state;
      const sameScope = message.pageUrl === current.pageUrl && message.sessionId === current.sessionId;
      const command = sameScope ? sidebarCommand(message.command, current) : undefined;
      if (!command) {
        // Reconcile pending UI even if its record or document changed before delivery.
        sendSidebar(sidebar, { type: "state", state: current, ack: message.commandId });
        return;
      }
      const request: PdfSidebarCommandMessage = {
        type: "command", commandId: message.commandId, pageUrl: message.pageUrl, sessionId: message.sessionId, command,
      };
      sendReader(sidebar.tabId!, reader, request);
    });
  });
}
