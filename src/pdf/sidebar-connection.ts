import type { PdfReaderRequest, PdfSidebarUpdate } from "./sidebar-types";

const contextInvalidated = (cause: unknown) =>
  cause instanceof Error && /Extension context invalidated/i.test(cause.message);
const disconnectedPort = (cause: unknown) =>
  cause instanceof Error && /disconnected port/i.test(cause.message);

/** Reconnect transient views after a worker restart; never write annotations here. */
export function connectPdfSidebar(
  name: "web-ink-pdf-reader" | "web-ink-pdf-sidebar",
  receive: (message: PdfReaderRequest | PdfSidebarUpdate) => void,
  connected: () => void,
) {
  let port: chrome.runtime.Port | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runtimeAvailable = () => {
    try {
      return Boolean(chrome.runtime.id);
    } catch (cause) {
      if (contextInvalidated(cause)) return false;
      throw cause;
    }
  };
  const removeMessageListener = (current: chrome.runtime.Port) => {
    try {
      current.onMessage.removeListener(receive);
    } catch (cause) {
      if (!contextInvalidated(cause)) throw cause;
    }
  };
  const reconnect = () => {
    if (disposed || !runtimeAvailable()) return;
    timer = setTimeout(connect, 1000);
  };
  const disconnected = (previous: chrome.runtime.Port, retry = true) => {
    if (port !== previous || disposed) return;
    port = undefined;
    removeMessageListener(previous);
    receive({ type: "unavailable" });
    if (retry) reconnect();
  };
  const connect = () => {
    timer = undefined;
    if (disposed) return;
    if (!runtimeAvailable()) {
      receive({ type: "unavailable" });
      return;
    }
    try {
      const next = chrome.runtime.connect({ name });
      port = next;
      next.onMessage.addListener(receive);
      next.onDisconnect.addListener(() => {
        // Reading lastError also consumes Chrome's disconnect diagnostic.
        let invalidated = false;
        try {
          void chrome.runtime.lastError;
        } catch (cause) {
          if (!contextInvalidated(cause)) throw cause;
          invalidated = true;
        }
        disconnected(next, !invalidated);
      });
      connected();
    } catch (cause) {
      if (!contextInvalidated(cause)) throw cause;
      receive({ type: "unavailable" });
    }
  };
  const connection = {
    send(message: object) {
      const current = port;
      try { current?.postMessage(message); }
      catch (cause) {
        if (!contextInvalidated(cause) && !disconnectedPort(cause)) throw cause;
        if (current) disconnected(current, !contextInvalidated(cause));
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      const old = port;
      port = undefined;
      if (!old) return;
      removeMessageListener(old);
      try {
        old.disconnect();
      } catch (cause) {
        if (!contextInvalidated(cause)) throw cause;
      }
    },
  };
  // Let the caller store the connection before the first state replay.
  queueMicrotask(connect);
  return connection;
}
