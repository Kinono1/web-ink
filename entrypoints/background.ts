import { handleDataRequest } from "../src/background/data";
import { isWebPage, pageKey } from "../src/core/url";
import { getDatabase } from "../src/background/database";
import type {
  Annotation,
  AnchorState,
  PageMode,
  Request,
  Result,
  Settings,
} from "../src/core/model";
import {
  createContentPageResolver,
  PageContextError,
} from "../src/background/content-page";

const ORIGINS = ["http://*/*", "https://*/*"];
const CONTENT_ID = "web-ink-pages";
type PageState = { pageUrl?: string; states: AnchorState[] };

export default defineBackground(() => {
  // Transient display state only. The durable annotation database is owned by data.ts.
  const pageStates = new Map<number, PageState>();
  const resolveContentPage = createContentPageResolver();
  const broadcast = async (message: object, pageUrl?: string) => {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
      tabs
        .filter(
          (t) =>
            t.id !== undefined &&
            ((message as { type?: string }).type === "permissions.revoked" ||
              isWebPage(t.url)) &&
            (!pageUrl || pageKey(t.url!) === pageUrl),
        )
        .map((t) => chrome.tabs.sendMessage(t.id!, message)),
    );
  };
  const performRegistration = async () => {
    const granted = await chrome.permissions.contains({ origins: ORIGINS });
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [CONTENT_ID],
    });
    if (!granted) {
      if (existing.length)
        await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_ID] });
      return false;
    }
    if (!existing.length)
      await chrome.scripting.registerContentScripts([
        {
          id: CONTENT_ID,
          matches: ORIGINS,
          js: ["content-scripts/content.js"],
          runAt: "document_idle",
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    // Inject into already-open pages too; the content controller guards against duplicates.
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
      tabs
        .filter((t) => t.id !== undefined && isWebPage(t.url))
        .map((t) =>
          chrome.scripting.executeScript({
            target: { tabId: t.id! },
            files: ["content-scripts/content.js"],
          }),
        ),
    );
    await Promise.allSettled(
      tabs
        .filter((t) => t.id !== undefined && isWebPage(t.url))
        .map((t) =>
          chrome.tabs.sendMessage(t.id!, { type: "permissions.restored" }),
        ),
    );
    return true;
  };
  // onAdded and the onboarding response can arrive together. Serialize registration
  // to prevent duplicate content-script IDs and replay later revocation changes.
  let registrationTask: Promise<boolean> = Promise.resolve(false);
  const register = () => {
    registrationTask = registrationTask
      .catch(() => false)
      .then(performRegistration);
    return registrationTask;
  };
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    void register();
  });
  chrome.runtime.onStartup.addListener(() => {
    void register();
  });
  chrome.permissions.onAdded.addListener(() => {
    void register();
  });
  chrome.permissions.onRemoved.addListener(() => {
    pageStates.clear();
    void register();
    void broadcast({ type: "permissions.revoked" });
  });
  chrome.tabs.onRemoved.addListener((id) => {
    pageStates.delete(id);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) {
      pageStates.delete(tabId);
      void chrome.tabs
        .sendMessage(tabId, { type: "page.action.execute", action: "refresh" })
        .catch(() => undefined);
    }
  });

  chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
    if (!raw || typeof raw !== "object" || !("type" in raw)) return false;
    const type = (raw as { type: unknown }).type;
    if (
      typeof type !== "string" ||
      type.endsWith(".changed") ||
      type === "permissions.revoked" ||
      type === "permissions.restored" ||
      type === "page.action.execute"
    )
      return false;
    const trusted =
      sender.id === chrome.runtime.id &&
      !!sender.url?.startsWith(chrome.runtime.getURL(""));
    let contentPage =
      sender.id === chrome.runtime.id &&
      sender.frameId === 0 &&
      isWebPage(sender.url)
        ? pageKey(sender.url!)
        : undefined;
    const process = async (): Promise<Result<unknown>> => {
      try {
        if (
          !trusted &&
          [
            "annotations.list",
            "annotations.query",
            "annotations.put",
            "annotations.restore",
            "annotations.delete",
            "page.states",
            "page.mode.get",
            "page.mode.put",
            "engine.ensure",
          ].includes(type)
        ) {
          contentPage = await resolveContentPage(sender);
          const suppliedPage =
            (raw as { pageUrl?: unknown; annotation?: { pageUrl?: unknown } })
              .pageUrl ??
            (raw as { annotation?: { pageUrl?: unknown } }).annotation
              ?.pageUrl ??
            (raw as { query?: { pageUrl?: unknown } }).query?.pageUrl;
          if (
            typeof suppliedPage === "string" &&
            pageKey(suppliedPage) !== contentPage
          ) {
            return {
              ok: false,
              code: "PAGE_CHANGED",
              error: "The page changed. Please retry on the current page.",
            };
          }
        }
        if (type === "engine.ensure") {
          if (
            trusted ||
            !contentPage ||
            sender.tab?.id === undefined ||
            !sender.documentId
          )
            throw new Error("Invalid engine request");
          const mode = await handleDataRequest(
            { type: "page.mode.get", pageUrl: contentPage },
            { trusted: false, pageUrl: contentPage },
          );
          const settings = await handleDataRequest(
            { type: "settings.get" },
            { trusted: false, pageUrl: contentPage },
          );
          if (
            !mode.ok ||
            !(mode.data as PageMode).enabled ||
            !settings.ok ||
            (settings.data as Settings).disabledOrigins.includes(
              new URL(contentPage).origin,
            )
          ) {
            return {
              ok: false,
              code: "FORBIDDEN",
              error: "Annotations are disabled on this page.",
            };
          }
          await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
            files: ["engine.js"],
            world: "ISOLATED",
          });
          return { ok: true, data: true };
        }
        if (type === "permissions.enable") {
          if (!trusted) throw new Error("Not allowed");
          return { ok: true, data: await register() };
        }
        if (type === "page.states") {
          const msg = raw as Extract<Request, { type: "page.states" }>;
          if (
            !contentPage ||
            sender.tab?.id === undefined ||
            msg.pageUrl !== contentPage ||
            !Array.isArray(msg.states)
          )
            throw new Error("Invalid page state");
          const states = msg.states
            .slice(0, 5000)
            .filter(
              (s) =>
                s &&
                typeof s.id === "string" &&
                ["located", "pending", "unresolved", "unsupported"].includes(
                  s.status,
                ),
            )
            .map((s) => ({
              id: s.id.slice(0, 200),
              status: s.status,
              reason:
                typeof s.reason === "string"
                  ? s.reason.slice(0, 500)
                  : undefined,
            }));
          pageStates.set(sender.tab.id, { pageUrl: contentPage, states });
          void chrome.runtime
            .sendMessage({ type: "page.state.changed", tabId: sender.tab.id })
            .catch(() => undefined);
          return { ok: true, data: true };
        }
        if (type === "page.state.get") {
          if (!trusted) throw new Error("Not allowed");
          const { tabId } = raw as Extract<Request, { type: "page.state.get" }>;
          // A worker restart loses the cache, so query the live content script.
          const state = await chrome.tabs
            .sendMessage(tabId, { type: "page.snapshot" })
            .catch(() => undefined);
          return {
            ok: true,
            data: state ?? pageStates.get(tabId) ?? { states: [] },
          };
        }
        if (type === "page.action") {
          if (!trusted) throw new Error("Not allowed");
          const msg = raw as Extract<Request, { type: "page.action" }>;
          if (
            !Number.isInteger(msg.tabId) ||
            !["focus", "rebind", "draw", "refresh"].includes(msg.action)
          )
            throw new Error("Invalid page action");
          await chrome.tabs.sendMessage(msg.tabId, {
            type: "page.action.execute",
            action: msg.action,
            id: msg.id,
          });
          return { ok: true, data: true };
        }
        const deleted =
          type === "annotations.delete" &&
          typeof (raw as { id?: unknown }).id === "string"
            ? await getDatabase().annotations.get(
                (raw as unknown as { id: string }).id,
              )
            : undefined;
        const result = await handleDataRequest(raw, {
          trusted,
          pageUrl: contentPage,
          callerKey: `${sender.id}:${sender.tab?.id ?? "extension"}:${sender.frameId ?? 0}:${sender.documentId ?? sender.url ?? ""}`,
        });
        if (
          result.ok &&
          (type === "annotations.put" || type === "annotations.restore")
        ) {
          const annotation = result.data as Annotation;
          void broadcast(
            {
              type: "annotations.changed",
              pageUrl: annotation.pageUrl,
              annotation,
            },
            annotation.pageUrl,
          );
        }
        if (result.ok && type === "annotations.delete") {
          void broadcast(
            {
              type: "annotations.changed",
              pageUrl: deleted?.pageUrl,
              deletedId: deleted?.id,
            },
            deleted?.pageUrl,
          );
        }
        if (result.ok && type === "backup.import")
          void broadcast({ type: "annotations.changed" });
        if (result.ok && type === "settings.put") {
          void broadcast({ type: "settings.changed" });
        }
        if (result.ok && type === "page.mode.put") {
          const modePage = (raw as Extract<Request, { type: "page.mode.put" }>)
            .pageUrl;
          void broadcast(
            {
              type: "page.mode.changed",
              pageUrl: modePage,
              enabled: (result.data as PageMode).enabled,
            },
            modePage,
          );
        }
        return result;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof PageContextError ? { code: error.code } : {}),
        };
      }
    };
    void process().then(respond);
    return true;
  });
});
