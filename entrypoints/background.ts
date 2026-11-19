import { isWebPage, pageKey } from "../src/core/url";
import { createPdfHandoffHandler } from "../src/background/pdf-handoff";
import { installPdfSidebarBroker } from "../src/background/pdf-sidebar";
import { initializeRuntime, RUNTIME_REGISTRATION_KEY } from "../src/background/runtime";
import { createContentPageResolver } from "../src/background/content-page";
import { observeBackgroundTask } from "../src/background/request-result";
import { installBackgroundRpc, type PageState } from "../src/background/rpc";

const ORIGINS = ["http://*/*", "https://*/*"];
const CONTENT_ID = "web-ink-pages";
export default defineBackground(() => {
  installPdfSidebarBroker();
  // Transient display state only. The durable annotation database is owned by data.ts.
  const pageStates = new Map<number, PageState>();
  const resolveContentPage = createContentPageResolver();
  const handlePdfRequest = createPdfHandoffHandler(async () => (await runtimeHealth).generation);
  const webTabs = async () =>
    (await chrome.tabs.query({})).filter((t): t is chrome.tabs.Tab & { id: number } => t.id !== undefined && isWebPage(t.url));
  const broadcast = async (message: object, pageUrl?: string) => {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
    const revoked = (message as { type?: string }).type === "permissions.revoked";
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs
      .filter((t) => t.id !== undefined && (revoked || isWebPage(t.url)) && (!pageUrl || pageKey(t.url!) === pageUrl))
      .map((t) => chrome.tabs.sendMessage(t.id!, message)));
  };
  const performRegistration = async () => {
    const granted = await chrome.permissions.contains({ origins: ORIGINS });
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_ID] });
    if (!granted) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_ID] });
      return false;
    }
    if (!existing.length) {
      try {
        await chrome.scripting.registerContentScripts([{
          id: CONTENT_ID, matches: ORIGINS, js: ["content-scripts/content.js"],
          runAt: "document_idle", allFrames: false, persistAcrossSessions: true,
        }]);
      } catch (error) {
        // While Chrome restores the persisted registration after a browser start
        // or extension reload, the ID is taken but not yet reported, and it
        // cannot be updated. It is this same definition, so it is already done.
        if (!String(error).includes("Duplicate script ID")) throw error;
      }
    }
    // Inject into already-open pages too; the content controller guards against duplicates.
    const tabs = await webTabs();
    await Promise.allSettled(tabs.map((t) => chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content-scripts/content.js"] })));
    await Promise.allSettled(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: "permissions.restored" })));
    return true;
  };
  // onAdded and the onboarding response can arrive together. Serialize registration
  // to prevent duplicate content-script IDs and replay later revocation changes.
  let registrationTask: Promise<boolean> = Promise.resolve(false);
  const register = (generation?: string) => {
    registrationTask = registrationTask.catch(() => false).then(async () => {
      // An older successful pass must not hide a newly rejected registration.
      await chrome.storage.session.remove(RUNTIME_REGISTRATION_KEY);
      const granted = await performRegistration();
      const currentGeneration = generation ?? (await runtimeHealth).generation;
      await chrome.storage.session.set({ [RUNTIME_REGISTRATION_KEY]: currentGeneration });
      return granted;
    });
    return registrationTask;
  };
  const runtimeHealth = initializeRuntime(register);
  observeBackgroundTask(runtimeHealth, "runtime initialization");
  chrome.runtime.onInstalled.addListener(() => {
    observeBackgroundTask(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }), "side panel configuration");
  });
  chrome.permissions.onAdded.addListener(() => { observeBackgroundTask(register(), "content registration"); });
  chrome.permissions.onRemoved.addListener(() => {
    pageStates.clear();
    observeBackgroundTask(register(), "content registration");
    observeBackgroundTask(broadcast({ type: "permissions.revoked" }), "permission notification");
  });
  chrome.tabs.onRemoved.addListener((id) => { pageStates.delete(id); });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) {
      pageStates.delete(tabId);
      void chrome.tabs.sendMessage(tabId, { type: "page.action.execute", action: "refresh" }).catch(() => undefined);
    }
  });

  installBackgroundRpc({ runtimeHealth, register, broadcast, pageStates, resolveContentPage, handlePdfRequest });
});
