import type { TextAnnotation } from "../core/model";
import { pageKey } from "../core/url";
import {
  SELECTION_PORT_NAME,
  type WebSelectionCommand,
  type WebSelectionReply,
  type WebSelectionState,
} from "../core/selection-toolbar";

type SelectionSnapshot = {
  range: Range;
  pageUrl: string;
  token: string;
  text: string;
  start: Node;
  startOffset: number;
  end: Node;
  endOffset: number;
};

const excluded = 'input,textarea,select,option,button,[contenteditable],script,style,noscript,web-ink-ui,[data-web-ink-ui]';
const elementFor = (node: Node) => node instanceof Element ? node : node.parentElement;
const unsupportedRange = (range: Range) => [range.startContainer, range.endContainer, range.commonAncestorContainer]
  .some((node) => Boolean(elementFor(node)?.closest(excluded)));

/** Read only a short prefix of the selected range; anchoring waits for Save. */
function selectionExcerpt(range: Range): string {
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = range.startContainer;
  if (!(node instanceof Text)) {
    const child = node.childNodes[range.startOffset];
    if (child) node = child;
    else {
      // A boundary at the end of an element continues after its subtree.
      while (node && node !== root && !node.nextSibling) node = node.parentNode;
      node = node && node !== root ? node.nextSibling : null;
    }
  }
  if (!node) return "";
  walker.currentNode = node;
  let text = "";
  for (let visited = 0; node && visited < 80 && text.length < 281; visited++) {
    if (node instanceof Text && range.intersectsNode(node) && !elementFor(node)?.closest(excluded)) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      text += node.data.slice(start, Math.min(end, start + 281 - text.length));
    }
    if (node instanceof Text && node === range.endContainer) break;
    node = walker.nextNode();
    if (node && range.comparePoint(node, 0) === 1) break;
  }
  return text.length > 280 ? `${text.slice(0, 280).trim()}…` : text.trim();
}

function sameBoundaries(snapshot: SelectionSnapshot): boolean {
  const { range } = snapshot;
  return snapshot.start.isConnected && snapshot.end.isConnected && !range.collapsed &&
    range.startContainer === snapshot.start && range.startOffset === snapshot.startOffset &&
    range.endContainer === snapshot.end && range.endOffset === snapshot.endOffset &&
    snapshot.start.ownerDocument === document && snapshot.end.ownerDocument === document &&
    !unsupportedRange(range);
}

/** Owns no document listeners or saved DOM ranges while the sidebar is closed. */
export function createWebSelection(options: {
  host: HTMLElement;
  availability: () => "ready" | "paused" | "unsupported";
  save: (range: Range, color: string, isCurrent: () => boolean) => Promise<TextAnnotation>;
}) {
  const clients = new Map<chrome.runtime.Port, () => void>();
  let snapshot: SelectionSnapshot | undefined;
  let unavailable: "empty" | "unsupported" = "empty";
  let observer: MutationObserver | undefined;
  let events: AbortController | undefined;
  let disposed = false;
  let saving = false;
  const url = () => pageKey(location.href);
  const state = (): WebSelectionState => {
    const availability = options.availability();
    if (availability !== "ready") return { type: "selection", pageUrl: url(), status: availability };
    if (snapshot && (!sameBoundaries(snapshot) || snapshot.pageUrl !== url())) snapshot = undefined;
    return snapshot
      ? { type: "selection", pageUrl: snapshot.pageUrl, status: saving ? "saving" : "ready", token: snapshot.token, text: snapshot.text }
      : { type: "selection", pageUrl: url(), status: unavailable };
  };
  const post = (port: chrome.runtime.Port, reply: WebSelectionReply) => {
    try { port.postMessage(reply); } catch { clients.get(port)?.(); }
  };
  const publish = () => {
    const next = state();
    for (const port of clients.keys()) post(port, next);
  };
  const clear = () => {
    snapshot = undefined;
    unavailable = "empty";
  };
  const inspectMutations = (mutations: MutationRecord[]) => {
    if (!snapshot) return;
    const range = snapshot.range;
    const touches = (node: Node) => {
      if (node instanceof Element && (node === options.host || node.matches("[data-web-ink], [data-web-ink-ui]"))) return false;
      if (node.contains(snapshot!.start) || node.contains(snapshot!.end)) return true;
      return node.isConnected && range.intersectsNode(node);
    };
    if (!sameBoundaries(snapshot) || mutations.some((mutation) => {
      if (options.host.contains(mutation.target) || elementFor(mutation.target)?.closest("[data-web-ink]")) return false;
      if (mutation.type !== "childList") return touches(mutation.target);
      const changed = [...mutation.addedNodes, ...mutation.removedNodes].filter((node) =>
        !(node instanceof Element && (node === options.host || node.matches("[data-web-ink], [data-web-ink-ui]"))),
      );
      // Removed interior nodes are already detached, so checking their current
      // intersection or just the two endpoints cannot prove an unchanged range.
      return changed.length > 0 && (touches(mutation.target) || changed.some(touches));
    })) {
      clear();
      publish();
    }
  };
  const flush = () => {
    const records = observer?.takeRecords();
    if (records?.length) inspectMutations(records);
  };
  const capture = () => {
    if (disposed || !clients.size) return;
    flush();
    if (options.availability() !== "ready") { clear(); publish(); return; }
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) {
      // Moving focus to Chrome's sidebar may collapse the document selection.
      if (!document.hasFocus() && snapshot && sameBoundaries(snapshot) && snapshot.pageUrl === url()) { publish(); return; }
      clear(); publish(); return;
    }
    const range = selection.getRangeAt(0);
    if (!range.startContainer.isConnected || !range.endContainer.isConnected || unsupportedRange(range)) {
      clear(); unavailable = "unsupported"; publish(); return;
    }
    if (snapshot && snapshot.pageUrl === url() && sameBoundaries(snapshot) &&
      range.startContainer === snapshot.start && range.startOffset === snapshot.startOffset &&
      range.endContainer === snapshot.end && range.endOffset === snapshot.endOffset) { publish(); return; }
    const text = selectionExcerpt(range);
    clear();
    if (text) snapshot = {
      range: range.cloneRange(), pageUrl: url(), token: crypto.randomUUID(), text,
      start: range.startContainer, startOffset: range.startOffset,
      end: range.endContainer, endOffset: range.endOffset,
    };
    publish();
  };
  const stopWatching = () => {
    events?.abort(); events = undefined;
    observer?.disconnect(); observer = undefined;
    clear();
  };
  const startWatching = () => {
    events = new AbortController();
    const signal = events.signal;
    document.addEventListener("selectionchange", capture, { signal });
    document.addEventListener("mouseup", capture, { signal });
    document.addEventListener("keyup", capture, { signal });
    document.addEventListener("pointerdown", (event) => {
      if (!event.composedPath().includes(options.host)) { clear(); publish(); }
    }, { signal });
    const route = () => { clear(); publish(); };
    window.addEventListener("popstate", route, { signal });
    window.addEventListener("hashchange", route, { signal });
    window.addEventListener("pagehide", route, { signal });
    observer = new MutationObserver(inspectMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["contenteditable"] });
  };
  const connect = (port: chrome.runtime.Port) => {
    if (port.name !== SELECTION_PORT_NAME || disposed) return;
    let authorized = false;
    try {
      const sender = new URL(port.sender?.url ?? "");
      const own = new URL(chrome.runtime.getURL("sidepanel.html"));
      authorized = port.sender?.id === chrome.runtime.id && sender.protocol === own.protocol && sender.host === own.host && sender.pathname === own.pathname;
    } catch { /* Missing or malformed sender URLs are unauthorized. */ }
    if (!authorized) { port.disconnect(); return; }
    const requests = new Set<string>();
    const disconnect = () => {
      if (!clients.delete(port)) return;
      try { port.onMessage.removeListener(onMessage); } catch { /* Reload can invalidate the port before DOM cleanup. */ }
      try { port.onDisconnect.removeListener(disconnect); } catch { /* Continue releasing document resources. */ }
      if (!clients.size) stopWatching();
    };
    const onMessage = (raw: unknown) => {
      if (disposed || !clients.has(port)) return;
      const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const requestId = typeof value.requestId === "string" && value.requestId.length <= 128 ? value.requestId : "";
      const error = (message: string) => post(port, { type: "error", requestId, error: message });
      if (Object.keys(value).some((key) => !["type", "requestId", "token", "color"].includes(key)) ||
        value.type !== "annotate" || !requestId || typeof value.token !== "string" || !value.token || value.token.length > 128 ||
        typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color)) {
        error("Invalid selection annotation request."); return;
      }
      if (saving) { error("A selection save is already in progress."); return; }
      if (requests.has(requestId)) { error("This save request was already processed."); return; }
      flush();
      if (options.availability() !== "ready") { error("Webpage annotations are paused or unavailable."); publish(); return; }
      const selected = snapshot;
      if (!selected || selected.token !== value.token || !sameBoundaries(selected) || selected.pageUrl !== url()) {
        if (selected?.token === value.token) clear();
        error("The selection changed. Select the text again."); publish(); return;
      }
      const command = value as WebSelectionCommand;
      requests.add(requestId);
      if (requests.size > 64) requests.delete(requests.values().next().value!);
      saving = true;
      publish();
      const isCurrent = () => {
        flush();
        return !disposed && clients.has(port) && snapshot === selected && options.availability() === "ready" && selected.pageUrl === url() && sameBoundaries(selected);
      };
      void (async () => {
        try {
          const annotation = await options.save(selected.range, command.color.toLowerCase(), isCurrent);
          if (!isCurrent()) throw Error("The annotation was saved, but the page or selection changed. Check the library before retrying.");
          clear();
          document.getSelection()?.removeAllRanges();
          post(port, { type: "saved", requestId, annotation });
        } catch (cause) {
          if (!disposed && clients.has(port)) error(cause instanceof Error ? cause.message : String(cause));
        } finally {
          saving = false;
          if (!disposed) publish();
        }
      })();
    };
    const first = !clients.size;
    clients.set(port, disconnect);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(disconnect);
    if (first) startWatching();
    capture();
  };
  chrome.runtime.onConnect?.addListener(connect);
  return {
    refresh: () => {
      if (!clients.size || disposed) return;
      if (options.availability() !== "ready" || (snapshot && snapshot.pageUrl !== url())) clear();
      flush(); publish();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try { chrome.runtime.onConnect?.removeListener(connect); } catch { /* Extension reload invalidates Chrome listeners first. */ }
      for (const [port, disconnect] of [...clients]) {
        disconnect();
        try { port.disconnect(); } catch { /* The peer may already be gone. */ }
      }
      stopWatching();
    },
  };
}
