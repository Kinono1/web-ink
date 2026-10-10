import type { PdfReaderRequest, PdfSidebarUpdate } from "./sidebar-types";

/** Reconnect transient views after a worker restart; never write annotations here. */
export function connectPdfSidebar(
  name: "web-ink-pdf-reader" | "web-ink-pdf-sidebar",
  receive: (message: PdfReaderRequest | PdfSidebarUpdate) => void,
  connected: () => void,
) {
  let port: chrome.runtime.Port | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disconnected = (previous: chrome.runtime.Port) => {
    if (port !== previous || disposed) return;
    port = undefined;
    previous.onMessage.removeListener(receive);
    receive({ type: "unavailable" });
    timer = setTimeout(connect, 1000);
  };
  const connect = () => {
    if (disposed || !chrome.runtime.id) return;
    try {
      const next = chrome.runtime.connect({ name });
      port = next;
      next.onMessage.addListener(receive);
      next.onDisconnect.addListener(() => {
        // Reading lastError also consumes Chrome's disconnect diagnostic.
        void chrome.runtime.lastError;
        disconnected(next);
      });
      connected();
    } catch {
      receive({ type: "unavailable" });
      timer = setTimeout(connect, 1000);
    }
  };
  const connection = {
    send(message: object) {
      const current = port;
      try { current?.postMessage(message); }
      catch { if (current) disconnected(current); }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      const old = port;
      port = undefined;
      old?.onMessage.removeListener(receive);
      old?.disconnect();
    },
  };
  // Let the caller store the connection before the first state replay.
  queueMicrotask(connect);
  return connection;
}
