import { handleDataRequest } from "./data";
import { PageContextError } from "./content-page";
import { fail, observeBackgroundTask, ok, requestFailure } from "./request-result";
import { isWebPage, pageKey } from "../core/url";
import type { AnchorState, Annotation, PageMode, Request, Result, RuntimeHealth, Settings } from "../core/model";

export type PageState = { pageUrl?: string; states: AnchorState[] };
type Sender = chrome.runtime.MessageSender;

export interface RouterDeps {
  runtimeHealth: Promise<RuntimeHealth>;
  register: () => Promise<boolean>;
  resolveContentPage: (sender: Sender) => Promise<string>;
  handleFloatingAction: (raw: unknown, sender: Sender) => Promise<Result<unknown>>;
  handlePdfRequest: (raw: unknown, sender: Sender) => Promise<Result<unknown>>;
  broadcast: (message: object, pageUrl?: string) => Promise<void>;
  /** Transient display state only. The durable annotation database is owned by data.ts. */
  pageStates: Map<number, PageState>;
}

interface RouteContext {
  type: string;
  raw: unknown;
  sender: Sender;
  /** The sender is an extension page (side panel, library, PDF reader). */
  trusted: boolean;
  /** Canonical page of a top-frame content script, verified for page-gated types. */
  contentPage: string | undefined;
}

type Route = (context: RouteContext, deps: RouterDeps) => Promise<Result<unknown>>;

/** Requests a content script may only make about the page it is running in. */
const PAGE_GATED = new Set([
  "annotations.list", "annotations.query", "annotations.put", "annotations.restore", "annotations.delete",
  "page.states", "page.mode.get", "page.mode.put", "engine.ensure",
]);

const PDF_TYPES = new Set([
  "pdf.context.get", "pdf.openCurrent", "pdf.cancelCurrent", "pdf.handoff.get", "pdf.handoff.revoke",
  "pdf.returnOriginal", "pdf.prepared.claim", "pdf.prepared.chunk", "pdf.prepared.release",
]);

/** Notifications the worker sends itself; they are never requests. */
function isNotification(type: string): boolean {
  return type.endsWith(".changed") || type === "permissions.revoked" ||
    type === "permissions.restored" || type === "page.action.execute";
}

const STATUSES = ["located", "pending", "unresolved", "unsupported"];
const PAGE_ACTIONS = ["focus", "rebind", "refresh"];

/** Routes after the page gate. `trustedOnly` routes refuse content scripts. */
const ROUTES: Record<string, { trustedOnly?: true; handle: Route }> = {
  "engine.ensure": {
    handle: async ({ trusted, contentPage, sender }) => {
      if (trusted || !contentPage || sender.tab?.id === undefined || !sender.documentId)
        return fail("Invalid engine request");
      const scope = { trusted: false, pageUrl: contentPage };
      const mode = await handleDataRequest({ type: "page.mode.get", pageUrl: contentPage }, scope);
      const settings = await handleDataRequest({ type: "settings.get" }, scope);
      if (!mode.ok || !(mode.data as PageMode).enabled || !settings.ok ||
        (settings.data as Settings).disabledOrigins.includes(new URL(contentPage).origin))
        return { ok: false, code: "FORBIDDEN", error: "Annotations are disabled on this page." };
      await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, documentIds: [sender.documentId] }, files: ["engine.js"], world: "ISOLATED",
      });
      return { ok: true, data: true };
    },
  },
  "permissions.enable": {
    trustedOnly: true,
    handle: async (_context, deps) => ({ ok: true, data: await deps.register() }),
  },
  "page.states": {
    handle: async ({ raw, contentPage, sender }, deps) => {
      const msg = raw as Extract<Request, { type: "page.states" }>;
      if (!contentPage || sender.tab?.id === undefined || msg.pageUrl !== contentPage || !Array.isArray(msg.states))
        return fail("Invalid page state");
      const states = msg.states.slice(0, 5000)
        .filter((s) => s && typeof s.id === "string" && STATUSES.includes(s.status))
        .map((s) => ({ id: s.id.slice(0, 200), status: s.status, reason: typeof s.reason === "string" ? s.reason.slice(0, 500) : undefined }));
      deps.pageStates.set(sender.tab.id, { pageUrl: contentPage, states });
      void chrome.runtime.sendMessage({ type: "page.state.changed", tabId: sender.tab.id }).catch(() => undefined);
      return { ok: true, data: true };
    },
  },
  "page.state.get": {
    trustedOnly: true,
    handle: async ({ raw }, deps) => {
      const { tabId } = raw as Extract<Request, { type: "page.state.get" }>;
      // A worker restart loses the cache, so query the live content script.
      const state = await chrome.tabs.sendMessage(tabId, { type: "page.snapshot" }).catch(() => undefined);
      return { ok: true, data: state ?? deps.pageStates.get(tabId) ?? { states: [] } };
    },
  },
  "page.action": {
    trustedOnly: true,
    handle: async ({ raw }) => {
      const msg = raw as Extract<Request, { type: "page.action" }>;
      if (!Number.isInteger(msg.tabId) || !PAGE_ACTIONS.includes(msg.action)) return fail("Invalid page action");
      await chrome.tabs.sendMessage(msg.tabId, { type: "page.action.execute", action: msg.action, id: msg.id });
      return { ok: true, data: true };
    },
  },
};

/** Everything else goes to the storage authority, then tells open pages what changed. */
const dataRoute: Route = async ({ type, raw, sender, trusted, contentPage }, deps) => {
  const result = await handleDataRequest(raw, {
    trusted, pageUrl: contentPage,
    callerKey: `${sender.id}:${sender.tab?.id ?? "extension"}:${sender.frameId ?? 0}:${sender.documentId ?? sender.url ?? ""}`,
    annotationDeleted: (pageUrl, deletedId) => deps.broadcast({ type: "annotations.changed", pageUrl, deletedId }, pageUrl),
  });
  if (!result.ok) return result;
  const { broadcast } = deps;
  switch (type) {
    case "annotations.put":
    case "annotations.restore": {
      const annotation = result.data as Annotation;
      observeBackgroundTask(broadcast({ type: "annotations.changed", pageUrl: annotation.pageUrl, annotation }, annotation.pageUrl), "annotation notification");
      break;
    }
    case "backup.import":
      observeBackgroundTask(broadcast({ type: "annotations.changed" }), "import notification");
      break;
    case "library.clear":
      observeBackgroundTask(broadcast({ type: "annotations.changed" }), "library clear notification");
      break;
    case "settings.put":
      observeBackgroundTask(broadcast({ type: "settings.changed" }), "settings notification");
      break;
    case "page.mode.put": {
      const { pageUrl } = raw as Extract<Request, { type: "page.mode.put" }>;
      observeBackgroundTask(broadcast({ type: "page.mode.changed", pageUrl, enabled: (result.data as PageMode).enabled }, pageUrl), "page mode notification");
      break;
    }
  }
  return result;
};

function suppliedPageUrl(raw: unknown): unknown {
  const message = raw as { pageUrl?: unknown; annotation?: { pageUrl?: unknown }; query?: { pageUrl?: unknown } };
  return message.pageUrl ?? message.annotation?.pageUrl ?? message.query?.pageUrl;
}

/**
 * Build the worker's message handler. It returns `undefined` for messages that are
 * not requests, so the caller can let Chrome close the channel.
 */
export function createMessageRouter(deps: RouterDeps) {
  return (raw: unknown, sender: Sender): Promise<Result<unknown>> | undefined => {
    if (!raw || typeof raw !== "object" || !("type" in raw)) return undefined;
    const type = (raw as { type: unknown }).type;
    if (typeof type !== "string" || isNotification(type)) return undefined;
    const run = async (): Promise<Result<unknown>> => {
      // Health must not open the annotation database or probe the sending page.
      if (type === "runtime.health")
        return sender.id === chrome.runtime.id ? ok(await deps.runtimeHealth) : fail("Not allowed");
      // Keep the side panel request on Chrome's original activation turn.
      if (type === "ui.open") return deps.handleFloatingAction(raw, sender);
      if (PDF_TYPES.has(type)) return deps.handlePdfRequest(raw, sender);

      const trusted = sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""));
      const pageGated = !trusted && PAGE_GATED.has(type);
      const contentPage = pageGated
        ? await deps.resolveContentPage(sender)
        : sender.id === chrome.runtime.id && sender.frameId === 0 && isWebPage(sender.url) ? pageKey(sender.url!) : undefined;
      if (pageGated) {
        const supplied = suppliedPageUrl(raw);
        if (typeof supplied === "string" && pageKey(supplied) !== contentPage) throw new PageContextError();
      }
      const context: RouteContext = { type, raw, sender, trusted, contentPage };
      const route = Object.hasOwn(ROUTES, type) ? ROUTES[type] : undefined;
      if (!route) return dataRoute(context, deps);
      if (route.trustedOnly && !trusted) return fail("Not allowed");
      return route.handle(context, deps);
    };
    return run().catch((error: unknown) => requestFailure(error, "runtime request", "Extension request failed."));
  };
}
