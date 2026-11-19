import { isReaderRequest, navigationChanged, ownPage, pageUrl, PdfNavigationError, returnUrl, type Input } from "./contract";

type Sender = chrome.runtime.MessageSender;
export type Actor = {
  kind: "sidebar" | "content" | "reader"; tabId: number; windowId?: number; activationEpoch?: number;
  documentId?: string; contextDocumentId?: string; contextId?: string; sender: chrome.runtime.MessageSender;
};
export type Snapshot = { url?: string; epoch: number; documentId?: string; readerDocumentId?: string; cancelEpoch?: number };

/** Bind PDF operations to Chrome's current tab, extension context and document. */
export function createPdfTabContext(cancellationEpoch: (tabId: number) => number) {
  const epochs = new Map<number, number>();
  const activations = new Map<number, number>();
  const epoch = (tabId: number) => epochs.get(tabId) ?? 0;
  const activation = (windowId: number) => activations.get(windowId) ?? 0;

  const getTab = async (tabId: number) => {
    try { return await chrome.tabs.get(tabId); } catch { throw navigationChanged(); }
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
      if (readers.length > 1) throw navigationChanged();
      if (readers[0]) {
        const observed = pageUrl(readers[0].documentUrl!);
        if (url && url !== observed) throw navigationChanged();
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
      const samePage = name === "pdf.html" && documentId ? ownPage(item.documentUrl, name) : item.documentUrl === sender.url;
      return item.documentId && item.contextId && samePage &&
        (!documentId || item.documentId === documentId) &&
        (!pinned || item.contextId === pinned.contextId) && (topTab || sidePanel);
    });
    if (matches.length !== 1) throw navigationChanged();
    const context = matches[0]!;
    if (sender.tab?.id !== undefined && sender.tab.id !== context.tabId) throw new PdfNavigationError("FORBIDDEN", "This return session belongs to another tab.");
    return context;
  };
  const activeTab = async (windowId: number) => {
    try {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      if (tabs.length !== 1 || tabs[0]!.id === undefined) throw navigationChanged();
      return tabs[0]!.id!;
    } catch (error) {
      if (error instanceof PdfNavigationError) throw error;
      throw new PdfNavigationError("CONTEXT_UNAVAILABLE", "The current browser tab is unavailable.");
    }
  };
  async function sidebarActor(input: Input, sender: Sender): Promise<Actor> {
    const context = await ownContext(sender, "sidepanel.html");
    // Native SIDE_PANEL contexts can report windowId -1. Bind the UI's
    // observed tab/window pair instead of guessing the last focused window.
    let windowId = context.windowId;
    if (windowId === -1 && context.contextType === "SIDE_PANEL") {
      if (input.tabId === undefined || input.windowId === undefined)
        throw new PdfNavigationError("CONTEXT_UNAVAILABLE", "Refresh the sidebar to identify the current tab.");
      windowId = input.windowId;
    } else if (windowId < 0) throw navigationChanged();
    if (input.windowId !== undefined && input.windowId !== windowId) throw navigationChanged();
    const activationEpoch = activation(windowId);
    const tabId = await activeTab(windowId);
    if (activation(windowId) !== activationEpoch) throw navigationChanged();
    if (input.tabId !== undefined && input.tabId !== tabId) throw navigationChanged();
    if ((await getTab(tabId)).windowId !== windowId) throw navigationChanged();
    return { kind: "sidebar", tabId, windowId, activationEpoch, contextDocumentId: context.documentId, contextId: context.contextId, sender };
  }

  async function readerActor(input: Input, sender: Sender): Promise<Actor> {
    const context = await ownContext(sender, "pdf.html");
    if (context.contextType !== "TAB" || context.tabId < 0) throw navigationChanged();
    if (input.tabId !== undefined && input.tabId !== context.tabId) throw new PdfNavigationError("FORBIDDEN", "This return session belongs to another tab.");
    return { kind: "reader", tabId: context.tabId, documentId: context.documentId, contextDocumentId: context.documentId, contextId: context.contextId, sender };
  }

  function contentActor(input: Input, sender: Sender): Actor {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.documentId ||
      sender.tab?.id === undefined || !returnUrl(sender.url) ||
      (sender.documentLifecycle && sender.documentLifecycle !== "active"))
      throw new PdfNavigationError("FORBIDDEN", "This PDF action is not available from this page.");
    if (input.tabId !== undefined && input.tabId !== sender.tab.id) throw new PdfNavigationError("FORBIDDEN", "This PDF action belongs to another tab.");
    if (input.windowId !== undefined && input.windowId !== sender.tab.windowId) throw new PdfNavigationError("FORBIDDEN", "This PDF action belongs to another window.");
    return { kind: "content", tabId: sender.tab.id, documentId: sender.documentId, sender };
  }

  async function actorFor(input: Input, sender: Sender): Promise<Actor> {
    if (isReaderRequest(input.type) && !ownPage(sender.url, "pdf.html"))
      throw new PdfNavigationError("FORBIDDEN", "Return to the original page from its PDF reader.");
    if (ownPage(sender.url, "sidepanel.html")) return sidebarActor(input, sender);
    if (ownPage(sender.url, "pdf.html")) return readerActor(input, sender);
    return contentActor(input, sender);
  }

  async function capture(actor: Actor): Promise<Snapshot> {
    const snapshot: Snapshot = { epoch: epoch(actor.tabId), documentId: actor.documentId };
    const observed = await observeTab(actor.tabId);
    snapshot.url = observed.url;
    snapshot.readerDocumentId = observed.readerDocumentId;
    return snapshot;
  }

  function checkCancelled(actor: Actor, snapshot: Snapshot): void {
    if (snapshot.cancelEpoch !== undefined && snapshot.cancelEpoch !== cancellationEpoch(actor.tabId))
      throw new DOMException('读取已取消，原 PDF 已保留 / Reading cancelled; original PDF retained.', 'AbortError');
  }

  function checkEpoch(actor: Actor, snapshot: Snapshot): void {
    if (epoch(actor.tabId) !== snapshot.epoch) throw navigationChanged();
    if (actor.kind === "sidebar" && activation(actor.windowId!) !== actor.activationEpoch) throw navigationChanged();
  }

  function checkObservedTab(actor: Actor, snapshot: Snapshot, observed: Awaited<ReturnType<typeof observeTab>>) {
    if (actor.kind === "sidebar" && observed.tab.windowId !== actor.windowId) throw navigationChanged();
    if (observed.url !== snapshot.url || (observed.tab.pendingUrl && pageUrl(observed.tab.pendingUrl) !== snapshot.url))
      throw navigationChanged();
    if (snapshot.readerDocumentId && snapshot.readerDocumentId !== observed.readerDocumentId)
      throw navigationChanged();
  }

  async function verifyDocument(tabId: number, documentId: string, url: string | undefined) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, documentIds: [documentId] },
        func: () => ({ href: location.href, top: window === window.top }),
      });
      const result = results.find(item => item.frameId === 0 && item.documentId === documentId);
      if (!result?.result?.top || pageUrl(result.result.href) !== url) throw navigationChanged();
    } catch { throw navigationChanged(); }
  }

  async function guard(actor: Actor, snapshot: Snapshot): Promise<void> {
    checkCancelled(actor, snapshot);
    checkEpoch(actor, snapshot);
    if (actor.kind === "sidebar") {
      const context = await ownContext(actor.sender, "sidepanel.html", actor);
      if (context.windowId !== actor.windowId && !(context.contextType === "SIDE_PANEL" && context.windowId === -1))
        throw navigationChanged();
      if (await activeTab(actor.windowId!) !== actor.tabId) throw navigationChanged();
    } else if (actor.kind === "reader") {
      await ownContext(actor.sender, "pdf.html", actor);
    }
    checkObservedTab(actor, snapshot, await observeTab(actor.tabId));
    if (snapshot.documentId && !snapshot.readerDocumentId && actor.kind !== "reader")
      await verifyDocument(actor.tabId, snapshot.documentId, snapshot.url);
    checkEpoch(actor, snapshot);
    checkCancelled(actor, snapshot);
  }

  return {
    actorFor, capture, guard,
    tabChanged: (tabId: number) => { epochs.set(tabId, epoch(tabId) + 1); },
    tabActivated: (windowId: number) => { activations.set(windowId, activation(windowId) + 1); },
  };
}
