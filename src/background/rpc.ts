import type { Annotation, AnchorState, PageMode, Request, Result, RuntimeHealth, Settings } from "../core/model";
import { isWebPage, pageKey } from "../core/url";
import { PageContextError, type createContentPageResolver } from "./content-page";
import { handleDataRequest } from "./data";
import { createFloatingActionHandler } from "./floating-actions";
import { fail, invalid, observeBackgroundTask, ok, requestFailure } from "./request-result";

const PAGE_GATED = new Set([
  "annotations.list", "annotations.query", "annotations.put", "annotations.restore", "annotations.delete",
  "page.states", "page.mode.get", "page.mode.put", "engine.ensure",
]);
const TRUSTED_REQUESTS = new Set(["page.state.get", "page.action", "permissions.enable"]);
const PDF_REQUESTS = new Set([
  "pdf.context.get", "pdf.openCurrent", "pdf.cancelCurrent",
  "pdf.handoff.get", "pdf.handoff.revoke", "pdf.returnOriginal",
  "pdf.prepared.claim", "pdf.prepared.chunk", "pdf.prepared.release",
]);
const NOTIFICATIONS = new Set(["permissions.revoked", "permissions.restored", "page.action.execute"]);

export type PageState = { pageUrl?: string; states: AnchorState[] };
type Message = { type: string };
type Sender = chrome.runtime.MessageSender;
type ContentPageResolver = ReturnType<typeof createContentPageResolver>;
type Broadcast = (message: object, pageUrl?: string) => Promise<void>;

interface BackgroundRpc {
  runtimeHealth: Promise<RuntimeHealth>;
  register(): Promise<boolean>;
  broadcast: Broadcast;
  pageStates: Map<number, PageState>;
  resolveContentPage: ContentPageResolver;
  handlePdfRequest(message: unknown, sender: Sender): Promise<Result<unknown>>;
}

export function installBackgroundRpc(runtime: BackgroundRpc): void {
  const handleFloatingAction = createFloatingActionHandler(runtime.resolveContentPage);

  async function dispatch(message: Message, sender: Sender): Promise<Result<unknown>> {
    try {
      const { type } = message;
      // Health cannot depend on IndexedDB or the content document probe.
      if (type === "runtime.health")
        return sender.id === chrome.runtime.id ? ok(await runtime.runtimeHealth) : fail("Not allowed", "FORBIDDEN");
      // Side panel opening needs Chrome's activation from the original message turn.
      if (type === "ui.open") return await handleFloatingAction(message, sender);
      if (PDF_REQUESTS.has(type)) return await runtime.handlePdfRequest(message, sender);
      const trusted = sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""));
      const pageGated = !trusted && PAGE_GATED.has(type);
      const contentPage = pageGated ? await runtime.resolveContentPage(sender) : senderPage(sender);
      if (pageGated) checkRequestedPage(message, contentPage);
      if (TRUSTED_REQUESTS.has(type) && !trusted) return fail("Not allowed", "FORBIDDEN");
      switch (type) {
        case "permissions.enable":
          return ok(await runtime.register());
        case "engine.ensure":
          return await ensureEngine(sender, trusted, contentPage);
        case "page.states":
          return publishPageState(runtime.pageStates, sender, contentPage, message as Extract<Request, { type: "page.states" }>);
        case "page.state.get":
          return await readPageState(runtime.pageStates, (message as Extract<Request, { type: "page.state.get" }>).tabId);
        case "page.action":
          return await sendPageAction(message as Extract<Request, { type: "page.action" }>);
        default:
          return await handleStorageRpc(message, trusted, contentPage, sender, runtime.broadcast);
      }
    } catch (error) {
      return requestFailure(error, "runtime request", "Extension request failed.");
    }
  }

  chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
    if (!raw || typeof raw !== "object" || !("type" in raw)) return false;
    if (typeof raw.type !== "string" || raw.type.endsWith(".changed") || NOTIFICATIONS.has(raw.type)) return false;
    void dispatch(raw as Message, sender).then(respond);
    return true;
  });
}

function senderPage(sender: Sender): string | undefined {
  return sender.id === chrome.runtime.id && sender.frameId === 0 && isWebPage(sender.url)
    ? pageKey(sender.url!) : undefined;
}

function checkRequestedPage(message: Message, pageUrl: string | undefined): void {
  const input = message as Message & {
    pageUrl?: unknown; annotation?: { pageUrl?: unknown }; query?: { pageUrl?: unknown };
  };
  const supplied = input.pageUrl ?? input.annotation?.pageUrl ?? input.query?.pageUrl;
  if (typeof supplied === "string" && pageKey(supplied) !== pageUrl) throw new PageContextError();
}

async function ensureEngine(sender: Sender, trusted: boolean, pageUrl?: string): Promise<Result<unknown>> {
  if (trusted || !pageUrl || sender.tab?.id === undefined || !sender.documentId)
    return invalid("Invalid engine request");
  const context = { trusted: false, pageUrl };
  const mode = await handleDataRequest({ type: "page.mode.get", pageUrl }, context);
  const settings = await handleDataRequest({ type: "settings.get" }, context);
  if (!mode.ok || !(mode.data as PageMode).enabled || !settings.ok ||
    (settings.data as Settings).disabledOrigins.includes(new URL(pageUrl).origin))
    return fail("Annotations are disabled on this page.", "FORBIDDEN");
  await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
    files: ["engine.js"],
    world: "ISOLATED",
  });
  return ok(true);
}

function publishPageState(
  cache: Map<number, PageState>, sender: Sender, pageUrl: string | undefined,
  message: Extract<Request, { type: "page.states" }>,
): Result<unknown> {
  const tabId = sender.tab?.id;
  if (!pageUrl || tabId === undefined || message.pageUrl !== pageUrl || !Array.isArray(message.states))
    return invalid("Invalid page state");
  const states = message.states.slice(0, 5000)
    .filter(state => state && typeof state.id === "string" && ["located", "pending", "unresolved", "unsupported"].includes(state.status))
    .map(state => ({ id: state.id.slice(0, 200), status: state.status,
      reason: typeof state.reason === "string" ? state.reason.slice(0, 500) : undefined }));
  cache.set(tabId, { pageUrl, states });
  void chrome.runtime.sendMessage({ type: "page.state.changed", tabId }).catch(() => undefined);
  return ok(true);
}

async function readPageState(cache: Map<number, PageState>, tabId: number): Promise<Result<unknown>> {
  // A worker restart loses the cache, so query the live content script.
  const state = await chrome.tabs.sendMessage(tabId, { type: "page.snapshot" }).catch(() => undefined);
  return ok(state ?? cache.get(tabId) ?? { states: [] });
}

async function sendPageAction(message: Extract<Request, { type: "page.action" }>): Promise<Result<unknown>> {
  if (!Number.isInteger(message.tabId) || !["focus", "rebind", "refresh"].includes(message.action))
    return invalid("Invalid page action");
  await chrome.tabs.sendMessage(message.tabId, { type: "page.action.execute", action: message.action, id: message.id });
  return ok(true);
}

async function handleStorageRpc(message: Message, trusted: boolean, pageUrl: string | undefined, sender: Sender, broadcast: Broadcast) {
  const result = await handleDataRequest(message, {
    trusted, pageUrl,
    callerKey: `${sender.id}:${sender.tab?.id ?? "extension"}:${sender.frameId ?? 0}:${sender.documentId ?? sender.url ?? ""}`,
    annotationDeleted: (pageUrl, deletedId) => broadcast({ type: "annotations.changed", pageUrl, deletedId }, pageUrl),
  });
  if (result.ok) notifyStorageChange(message, result.data, broadcast);
  return result;
}

function notifyStorageChange(message: Message, data: unknown, broadcast: Broadcast): void {
  switch (message.type) {
    case "annotations.put":
    case "annotations.restore": {
      const annotation = data as Annotation;
      observeBackgroundTask(broadcast({ type: "annotations.changed", pageUrl: annotation.pageUrl, annotation }, annotation.pageUrl), "annotation notification");
      break;
    }
    case "backup.import":
      observeBackgroundTask(broadcast({ type: "annotations.changed" }), "import notification");
      break;
    case "settings.put":
      observeBackgroundTask(broadcast({ type: "settings.changed" }), "settings notification");
      break;
    case "page.mode.put": {
      const { pageUrl } = message as Extract<Request, { type: "page.mode.put" }>;
      observeBackgroundTask(broadcast({ type: "page.mode.changed", pageUrl, enabled: (data as PageMode).enabled }, pageUrl), "page mode notification");
      break;
    }
  }
}
