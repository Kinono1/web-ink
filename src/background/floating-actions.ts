import { PageContextError, createContentPageResolver } from "./content-page";
import { isWebPage } from "../core/url";
import type { Request, Result } from "../core/model";

type UiOpenRequest = Extract<Request, { type: "ui.open" }>;
type ContentPageResolver = (sender: chrome.runtime.MessageSender) => Promise<string>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function uiOpenRequest(value: unknown): value is UiOpenRequest {
  return record(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "type") && Object.hasOwn(value, "target") &&
    value.type === "ui.open" &&
    (value.target === "sidebar" || value.target === "library" || value.target === "local-pdf");
}

function contentSender(sender: chrome.runtime.MessageSender): sender is chrome.runtime.MessageSender & {
  tab: chrome.tabs.Tab & { id: number };
  documentId: string;
  url: string;
} {
  const tabId = sender.tab?.id;
  return sender.id === chrome.runtime.id &&
    sender.frameId === 0 &&
    sender.documentLifecycle === "active" &&
    typeof sender.documentId === "string" && sender.documentId.length > 0 &&
    typeof tabId === "number" && Number.isSafeInteger(tabId) && tabId >= 0 &&
    isWebPage(sender.url);
}

function failure(error: unknown): Result<true> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof PageContextError ? { code: error.code } : {}),
  };
}

/** Opens only extension-owned destinations requested by the page floating menu. */
export function createFloatingActionHandler(
  resolveContentPage: ContentPageResolver = createContentPageResolver(),
) {
  return async (raw: unknown, sender: chrome.runtime.MessageSender): Promise<Result<true>> => {
    if (!uiOpenRequest(raw) || !contentSender(sender)) {
      return { ok: false, error: "Invalid floating action" };
    }
    try {
      // Opening the existing panel for this sending tab must start in the click's
      // message turn. It neither reads data nor grants the document data access.
      // A later-replaced document may still expose this tab's existing panel.
      if (raw.target === "sidebar") {
        await chrome.sidePanel.open({ tabId: sender.tab.id });
        return { ok: true, data: true };
      }

      // Re-probe the exact document before creating a tab. A stale page must not navigate.
      await resolveContentPage(sender);
      const url = raw.target === "library"
        ? chrome.runtime.getURL("library.html")
        : chrome.runtime.getURL("pdf.html");
      await chrome.tabs.create({ url });
      return { ok: true, data: true };
    } catch (error) {
      return failure(error);
    }
  };
}
