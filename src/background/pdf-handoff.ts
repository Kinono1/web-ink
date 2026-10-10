import type {
  PdfHandoff,
  PdfNavigationErrorCode,
  PdfOpenResult,
  PdfTabContext,
  Result,
} from "../core/model";
import {
  buildPdfOpenUrl,
  classifyPdfTab,
  getPdfContext,
  isKnownPdfViewer,
  isIeeePdfWrapper,
  probePdfDocument,
  publicPdfSource,
} from "../pdf/context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class PdfNavigationError extends Error {
  constructor(readonly code: PdfNavigationErrorCode, message: string) {
    super(message);
  }
}
type Input = {
  type: string;
  tabId?: number;
  windowId?: number;
  expectedUrl?: string;
  candidateUrl?: string;
  token?: string;
};
type Actor = {
  kind: "sidebar" | "content" | "reader";
  tabId: number;
  windowId?: number;
  activationEpoch?: number;
  documentId?: string;
  contextDocumentId?: string;
  contextId?: string;
  sender: chrome.runtime.MessageSender;
};
type Snapshot = {
  url?: string;
  epoch: number;
  documentId?: string;
  readerDocumentId?: string;
};

function pageUrl(raw: string): string {
  try { return new URL(raw).href; } catch { throw new PdfNavigationError("INVALID_INPUT", "Invalid page URL."); }
}
function ownPage(raw: string | undefined, name: string): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const own = new URL(chrome.runtime.getURL(name));
    return url.protocol === own.protocol && url.host === own.host && url.pathname === own.pathname;
  } catch { return false; }
}
function returnUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return undefined;
    if (["http:", "https:", "file:"].includes(url.protocol) || isKnownPdfViewer(raw)) return url.href;
    return undefined;
  } catch { return undefined; }
}
function parseInput(raw: unknown): Input {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PdfNavigationError("INVALID_INPUT", "Invalid PDF request.");
  const input = { ...raw } as Input;
  const reader = input.type === "pdf.handoff.get" || input.type === "pdf.returnOriginal";
  const fields = reader ? ["type", "token"] : ["type", "tabId", "windowId", "expectedUrl"];
  if (input.type === "pdf.openCurrent") fields.push("candidateUrl");
  if (Object.keys(raw).some(key => !fields.includes(key))) throw new PdfNavigationError("INVALID_INPUT", "Invalid PDF request fields.");
  if (reader) {
    if (typeof input.token !== "string" || !UUID.test(input.token)) throw new PdfNavigationError("INVALID_INPUT", "Invalid return session.");
  } else {
    if (input.tabId !== undefined && (!Number.isInteger(input.tabId) || input.tabId < 0)) throw new PdfNavigationError("INVALID_INPUT", "Invalid tab.");
    if (input.windowId !== undefined && (!Number.isInteger(input.windowId) || input.windowId < 0)) throw new PdfNavigationError("INVALID_INPUT", "Invalid window.");
    if (input.expectedUrl !== undefined) {
      if (typeof input.expectedUrl !== "string" || input.expectedUrl.length > 8192) throw new PdfNavigationError("INVALID_INPUT", "Invalid page URL.");
      input.expectedUrl = pageUrl(input.expectedUrl);
    }
    if (input.candidateUrl !== undefined) {
      if (typeof input.candidateUrl !== "string" || input.candidateUrl.length > 8192 || !publicPdfSource(input.candidateUrl))
        throw new PdfNavigationError("INVALID_INPUT", "Choose a public HTTPS PDF source.");
      input.candidateUrl = publicPdfSource(input.candidateUrl);
    }
  }
  return input;
}

/** Background-owned source observation and session navigation; never reads PDF bytes. */
export function createPdfHandoffHandler() {
  const epochs = new Map<number, number>();
  const activations = new Map<number, number>();
  const flights = new Map<number, { key: string; task: Promise<unknown> }>();
  const epoch = (tabId: number) => epochs.get(tabId) ?? 0;
  const activation = (windowId: number) => activations.get(windowId) ?? 0;
  const removeTabHandoffs = async (tabId: number) => {
    const entries = await chrome.storage.session.get(null);
    const keys = Object.keys(entries).filter(key => {
      const value = entries[key];
      return key.startsWith("pdf.handoff.") && value !== null && typeof value === "object" &&
        "tabId" in value && value.tabId === tabId;
    });
    if (keys.length) await chrome.storage.session.remove(keys);
  };
  // Native PDF viewers cannot be probed. Loading events also catch same-URL refreshes.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url || change.status === "loading") epochs.set(tabId, epoch(tabId) + 1);
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    epochs.set(tabId, epoch(tabId) + 1);
    void removeTabHandoffs(tabId).catch(() => undefined);
  });
  chrome.tabs.onActivated.addListener(({ windowId }) => { activations.set(windowId, activation(windowId) + 1); });
  const changed = () => new PdfNavigationError("PAGE_CHANGED", "The tab or document changed. Try again on the current page.");
  const getTab = async (tabId: number) => {
    try { return await chrome.tabs.get(tabId); } catch { throw changed(); }
  };
  const observeTab = async (tabId: number) => {
    const tab = await getTab(tabId);
    let url = tab.url ? pageUrl(tab.url) : undefined;
    let readerDocumentId: string | undefined;
    // Own extension pages can have no Tab.url without the tabs permission.
    if (!url || ownPage(url, "pdf.html")) {
      let contexts: chrome.runtime.ExtensionContext[];
      try { contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], tabIds: [tabId] }); }
      catch { throw new PdfNavigationError("CONTEXT_UNAVAILABLE", "The PDF context is unavailable. Try again."); }
      const readers = contexts.filter(item => item.tabId === tabId && item.frameId === 0 && item.documentId && ownPage(item.documentUrl, "pdf.html"));
      if (readers.length > 1) throw changed();
      if (readers[0]) {
        const observed = pageUrl(readers[0].documentUrl!);
        if (url && url !== observed) throw changed();
        url = observed;
        readerDocumentId = readers[0].documentId;
      }
    }
    return { tab, url, readerDocumentId };
  };
  const ownContext = async (sender: chrome.runtime.MessageSender, name: string, pinned?: Actor): Promise<chrome.runtime.ExtensionContext> => {
    if (
      sender.id !== chrome.runtime.id || !ownPage(sender.url, name) ||
      (sender.frameId !== undefined && sender.frameId !== 0 && !(name === "sidepanel.html" && sender.frameId === -1)) ||
      (sender.documentLifecycle && sender.documentLifecycle !== "active")
    )
      throw new PdfNavigationError("FORBIDDEN", "This PDF action is not available from this page.");
    let contexts: chrome.runtime.ExtensionContext[];
    // Native side panels may omit sender document/frame metadata. Resolve once
    // from Chrome's contexts, then retain that document across asynchronous work.
    const documentId = pinned?.contextDocumentId ?? sender.documentId;
    try { contexts = await chrome.runtime.getContexts(documentId ? { documentIds: [documentId] } : { documentUrls: [sender.url!] }); }
    catch { throw new PdfNavigationError("CONTEXT_UNAVAILABLE", "The PDF context is unavailable. Try again."); }
    const matches = contexts.filter(item => {
      const topTab = item.contextType === "TAB" && item.frameId === 0 && item.tabId >= 0;
      const sidePanel = name === "sidepanel.html" && item.contextType === "SIDE_PANEL" && (item.frameId === -1 || item.frameId === 0);
      // Chrome keeps MessageSender.url at the loaded URL after replaceState.
      // Readers add document/position parameters without replacing the document.
      const samePage = name === "pdf.html" && documentId
        ? ownPage(item.documentUrl, name) : item.documentUrl === sender.url;
      return item.documentId && item.contextId && samePage &&
        (!documentId || item.documentId === documentId) &&
        (!pinned || item.contextId === pinned.contextId) && (topTab || sidePanel);
    });
    if (matches.length !== 1) throw changed();
    const context = matches[0]!;
    if (sender.tab?.id !== undefined && sender.tab.id !== context.tabId) throw new PdfNavigationError("FORBIDDEN", "This return session belongs to another tab.");
    return context;
  };
  const activeTab = async (windowId: number) => {
    try {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      if (tabs.length !== 1 || tabs[0]!.id === undefined) throw changed();
      return tabs[0]!.id!;
    } catch (error) {
      if (error instanceof PdfNavigationError) throw error;
      throw new PdfNavigationError("CONTEXT_UNAVAILABLE", "The current browser tab is unavailable.");
    }
  };
  const actorFor = async (input: Input, sender: chrome.runtime.MessageSender): Promise<Actor> => {
    if ((input.type === "pdf.handoff.get" || input.type === "pdf.returnOriginal") && !ownPage(sender.url, "pdf.html"))
      throw new PdfNavigationError("FORBIDDEN", "Return to the original page from its PDF reader.");
    if (ownPage(sender.url, "sidepanel.html")) {
      const context = await ownContext(sender, "sidepanel.html");
      // Native SIDE_PANEL contexts can report windowId -1. Bind the UI's
      // observed tab/window pair instead of guessing the last focused window.
      let windowId = context.windowId;
      if (windowId === -1 && context.contextType === "SIDE_PANEL") {
        if (input.tabId === undefined || input.windowId === undefined)
          throw new PdfNavigationError("CONTEXT_UNAVAILABLE", "Refresh the sidebar to identify the current tab.");
        windowId = input.windowId;
      } else if (windowId < 0) throw changed();
      if (input.windowId !== undefined && input.windowId !== windowId) throw changed();
      const activationEpoch = activation(windowId);
      const tabId = await activeTab(windowId);
      if (activation(windowId) !== activationEpoch) throw changed();
      if (input.tabId !== undefined && input.tabId !== tabId) throw changed();
      if ((await getTab(tabId)).windowId !== windowId) throw changed();
      return { kind: "sidebar", tabId, windowId, activationEpoch, contextDocumentId: context.documentId, contextId: context.contextId, sender };
    }
    if (ownPage(sender.url, "pdf.html")) {
      const context = await ownContext(sender, "pdf.html");
      if (context.contextType !== "TAB" || context.tabId < 0) throw changed();
      if (input.tabId !== undefined && input.tabId !== context.tabId) throw new PdfNavigationError("FORBIDDEN", "This return session belongs to another tab.");
      return { kind: "reader", tabId: context.tabId, documentId: context.documentId, contextDocumentId: context.documentId, contextId: context.contextId, sender };
    }
    if (
      sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.documentId ||
      sender.tab?.id === undefined || !returnUrl(sender.url) ||
      (sender.documentLifecycle && sender.documentLifecycle !== "active")
    )
      throw new PdfNavigationError("FORBIDDEN", "This PDF action is not available from this page.");
    if (input.tabId !== undefined && input.tabId !== sender.tab.id) throw new PdfNavigationError("FORBIDDEN", "This PDF action belongs to another tab.");
    if (input.windowId !== undefined && input.windowId !== sender.tab.windowId) throw new PdfNavigationError("FORBIDDEN", "This PDF action belongs to another window.");
    return { kind: "content", tabId: sender.tab.id, documentId: sender.documentId, sender };
  };
  const guard = async (actor: Actor, snapshot: Snapshot) => {
    if (epoch(actor.tabId) !== snapshot.epoch) throw changed();
    if (actor.kind === "sidebar" && activation(actor.windowId!) !== actor.activationEpoch) throw changed();
    if (actor.kind === "sidebar") {
      const context = await ownContext(actor.sender, "sidepanel.html", actor);
      if (context.windowId !== actor.windowId && !(context.contextType === "SIDE_PANEL" && context.windowId === -1)) throw changed();
      if (await activeTab(actor.windowId!) !== actor.tabId) throw changed();
    } else if (actor.kind === "reader") await ownContext(actor.sender, "pdf.html", actor);
    const observed = await observeTab(actor.tabId);
    if (actor.kind === "sidebar" && observed.tab.windowId !== actor.windowId) throw changed();
    if (observed.url !== snapshot.url || (observed.tab.pendingUrl && pageUrl(observed.tab.pendingUrl) !== snapshot.url)) throw changed();
    if (snapshot.readerDocumentId && snapshot.readerDocumentId !== observed.readerDocumentId) throw changed();
    if (snapshot.documentId && !snapshot.readerDocumentId && actor.kind !== "reader") {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: actor.tabId, documentIds: [snapshot.documentId] },
          func: () => ({ href: location.href, top: window === window.top }),
        });
        const result = results.find(item => item.frameId === 0 && item.documentId === snapshot.documentId);
        if (!result?.result?.top || pageUrl(result.result.href) !== snapshot.url) throw changed();
      } catch { throw changed(); }
    }
    if (epoch(actor.tabId) !== snapshot.epoch) throw changed();
    if (actor.kind === "sidebar" && activation(actor.windowId!) !== actor.activationEpoch) throw changed();
  };
  const readHandoff = async (token: string, tabId: number): Promise<PdfHandoff | null> => {
    let stored: unknown;
    try { stored = (await chrome.storage.session.get(`pdf.handoff.${token}`))[`pdf.handoff.${token}`]; }
    catch { throw new PdfNavigationError("STORAGE_UNAVAILABLE", "Return context is unavailable. Open the source or choose a local PDF."); }
    if (!stored) return null;
    const handoff = stored as PdfHandoff;
    if (handoff.token !== token || handoff.tabId !== tabId) throw new PdfNavigationError("FORBIDDEN", "This return session belongs to another tab.");
    const original = returnUrl(handoff.returnUrl);
    if (!original || (handoff.sourceUrl !== undefined && !publicPdfSource(handoff.sourceUrl))) return null;
    return { token, tabId, returnUrl: original, ...(handoff.sourceUrl ? { sourceUrl: handoff.sourceUrl } : {}) };
  };
  const inspect = async (actor: Actor, input: Input) => {
    const snapshot: Snapshot = { epoch: epoch(actor.tabId), documentId: actor.documentId };
    const observed = await observeTab(actor.tabId);
    snapshot.url = observed.url;
    snapshot.readerDocumentId = observed.readerDocumentId;
    if (input.expectedUrl !== undefined && input.expectedUrl !== snapshot.url) throw changed();
    let context = classifyPdfTab(actor.tabId, snapshot.url);
    if (ownPage(snapshot.url, "pdf.html")) {
      const url = new URL(snapshot.url!);
      const token = url.searchParams.get("handoff") ?? undefined;
      const source = publicPdfSource(url.searchParams.get("source") ?? "");
      context = {
        tabId: actor.tabId,
        url: snapshot.url,
        kind: "wrapper",
        currentReader: true,
        candidates: source ? [{ url: source, via: "viewer" }] : [],
        ...(token && UUID.test(token) ? { handoffToken: token } : {}),
      };
      if (context.handoffToken) {
        try { if (!(await readHandoff(context.handoffToken, actor.tabId))) context.reason = "session-unavailable"; }
        catch (error) {
          if (error instanceof PdfNavigationError && error.code === "FORBIDDEN") throw error;
          context.reason = "session-unavailable";
        }
      }
    } else if (snapshot.url && !getPdfContext(snapshot.url) && !isKnownPdfViewer(snapshot.url)) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: actor.tabId, ...(actor.documentId ? { documentIds: [actor.documentId] } : {}) },
          func: probePdfDocument,
        });
        const result = results.find(item => item.frameId === 0 && (!actor.documentId || item.documentId === actor.documentId));
        if (!result?.documentId || !result.result?.top || pageUrl(result.result.href) !== snapshot.url) throw changed();
        snapshot.documentId = result.documentId;
        context = classifyPdfTab(actor.tabId, snapshot.url, Array.isArray(result.result.candidates) ? result.result.candidates : []);
      } catch (error) {
        if (actor.kind === "content" || error instanceof PdfNavigationError) throw changed();
        context = { ...context, reason: "permission-denied" };
      }
    }
    await guard(actor, snapshot);
    return { context, snapshot };
  };
  const singleFlight = (actor: Actor, input: Input, run: () => Promise<unknown>) => {
    const key = JSON.stringify([input.type, actor.kind, actor.windowId, actor.contextDocumentId ?? actor.sender.documentId, input.expectedUrl, input.candidateUrl, input.token]);
    const existing = flights.get(actor.tabId);
    if (existing) {
      if (existing.key !== key) throw changed();
      return existing.task;
    }
    const task = Promise.resolve().then(run);
    flights.set(actor.tabId, { key, task });
    void task.finally(() => {
      if (flights.get(actor.tabId)?.task === task) flights.delete(actor.tabId);
    }).catch(() => undefined);
    return task;
  };
  const open = async (actor: Actor, input: Input): Promise<PdfOpenResult> => {
    const { context, snapshot } = await inspect(actor, input);
    if (context.currentReader) return {
      tabId: actor.tabId,
      readerUrl: context.url!,
      navigation: "current-reader",
      ...(context.handoffToken ? { token: context.handoffToken } : {}),
      ...(context.candidates[0] ? { sourceUrl: context.candidates[0].url } : {}),
    };
    let source = context.candidates[0]?.url;
    if (input.candidateUrl) {
      source = context.candidates.find(item => item.url === input.candidateUrl)?.url;
      if (!source) throw new PdfNavigationError("PDF_SOURCE_UNAVAILABLE", "This PDF source is no longer available. Choose a source again.");
    } else if (context.candidates.length > 1) throw new PdfNavigationError("PDF_CHOICE_REQUIRED", "Choose which PDF to open.");
    const original = returnUrl(snapshot.url);
    const base = chrome.runtime.getURL("pdf.html");
    if (!original || context.kind === "unavailable") {
      await guard(actor, snapshot);
      try {
        const tab = await chrome.tabs.create({ url: base });
        if (tab.id === undefined) throw Error("Missing reader tab");
        return { tabId: tab.id, readerUrl: base, navigation: "new-tab" };
      } catch { throw new PdfNavigationError("NAVIGATION_FAILED", "The manual PDF reader could not be opened."); }
    }
    const token = crypto.randomUUID();
    const handoff: PdfHandoff = { token, tabId: actor.tabId, returnUrl: original, ...(source ? { sourceUrl: source } : {}) };
    const reader = new URL(buildPdfOpenUrl(base, source ? { kind: "remote", sourceUrl: source } : undefined));
    reader.searchParams.set("handoff", token);
    await guard(actor, snapshot);
    try {
      // A new source document cannot use an older return token for this tab.
      // Bound retained recovery state to one handoff per live tab.
      await removeTabHandoffs(actor.tabId);
      await chrome.storage.session.set({ [`pdf.handoff.${token}`]: handoff });
    }
    catch { throw new PdfNavigationError("STORAGE_UNAVAILABLE", "Return context could not be saved. Reader navigation was not started."); }
    try { await guard(actor, snapshot); }
    catch (error) {
      await chrome.storage.session.remove(`pdf.handoff.${token}`).catch(() => undefined);
      throw error;
    }
    try { await chrome.tabs.update(actor.tabId, { url: reader.href }); }
    catch { throw new PdfNavigationError("NAVIGATION_FAILED", "Reader navigation could not be confirmed. Saved return context is retained for recovery."); }
    return { tabId: actor.tabId, readerUrl: reader.href, navigation: "same-tab", token, ...(source ? { sourceUrl: source } : {}) };
  };
  const readerHandoff = async (actor: Actor, token: string) => {
    if (actor.kind !== "reader") throw new PdfNavigationError("FORBIDDEN", "Return to the original page from its PDF reader.");
    const snapshot: Snapshot = { epoch: epoch(actor.tabId), documentId: actor.documentId };
    const observed = await observeTab(actor.tabId);
    snapshot.url = observed.url;
    snapshot.readerDocumentId = observed.readerDocumentId;
    if (!ownPage(snapshot.url, "pdf.html") || new URL(snapshot.url!).searchParams.get("handoff") !== token)
      throw new PdfNavigationError("FORBIDDEN", "This return session does not belong to this reader.");
    const handoff = await readHandoff(token, actor.tabId);
    await guard(actor, snapshot);
    return { handoff, snapshot };
  };
  return async (raw: unknown, sender: chrome.runtime.MessageSender): Promise<Result<unknown>> => {
    try {
      const input = parseInput(raw);
      const actor = await actorFor(input, sender);
      if (input.type === "pdf.context.get") return { ok: true, data: (await inspect(actor, input)).context };
      if (input.type === "pdf.openCurrent") return { ok: true, data: await singleFlight(actor, input, () => open(actor, input)) };
      if (input.type === "pdf.handoff.get") return { ok: true, data: (await readerHandoff(actor, input.token!)).handoff };
      if (input.type === "pdf.returnOriginal") {
        const data = await singleFlight(actor, input, async () => {
          const { handoff, snapshot } = await readerHandoff(actor, input.token!);
          if (!handoff) throw new PdfNavigationError("PDF_SOURCE_UNAVAILABLE", "Return context expired. Open the source or choose a local PDF.");
          await guard(actor, snapshot);
          try { await chrome.tabs.update(actor.tabId, { url: handoff.returnUrl }); }
          catch { throw new PdfNavigationError("NAVIGATION_FAILED", "Return navigation could not be confirmed. Saved return context is retained for recovery."); }
          await chrome.storage.session.remove(`pdf.handoff.${handoff.token}`).catch(() => undefined);
          return { tabId: actor.tabId, url: handoff.returnUrl };
        });
        return { ok: true, data };
      }
      throw new PdfNavigationError("INVALID_INPUT", "Unsupported PDF request.");
    } catch (error) {
      return {
        ok: false,
        code: error instanceof PdfNavigationError ? error.code : "CONTEXT_UNAVAILABLE",
        error: error instanceof Error ? error.message : "PDF context is unavailable.",
      };
    }
  };
}
