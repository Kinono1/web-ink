import { request } from "../core/client";
import { DEFAULT_SETTINGS, type PageMode, type Settings } from "../core/model";
import { pageKey } from "../core/url";
import { createPaletteToggle } from "./palette-toggle";
import { createView } from "./view-lite";

export interface EngineBridge {
  start: () => void;
  stop: () => void;
  dispatch: (
    action: "focus" | "rebind" | "draw" | "refresh",
    id?: string,
  ) => void;
  snapshot: () => { pageUrl: string; states: unknown[]; enabled: boolean };
  canStop: () => boolean;
}
export interface ContentBootstrap {
  view: ReturnType<typeof createView>;
  isEnabled: () => boolean;
  dispose: () => void;
}

declare global {
  interface Window {
    __webInkBootstrap?: ContentBootstrap;
    __webInkEngine?: EngineBridge;
  }
}

type RawResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Persistent, low-cost content script. It owns only the palette and mode routing. */
export function startBootstrap(): () => void {
  if (window.top !== window) return () => undefined;
  if (window.__webInkBootstrap) return () => undefined;
  const view = createView();
  let disposed = false;
  let enabled = false;
  let blocked = false;
  let busy = true;
  let language: Settings["language"] = DEFAULT_SETTINGS.language;
  let currentUrl = pageKey(location.href);
  const updateToggle = () =>
    toggle.update({ enabled, blocked, busy, language });
  const raw = async <T>(message: object): Promise<T> => {
    const response = (await chrome.runtime.sendMessage(message)) as
      | RawResult<T>
      | undefined;
    if (!response) throw new Error("Extension unavailable.");
    if (!response.ok) throw new Error(response.error);
    return response.data;
  };
  const stopEngine = (force = false): boolean => {
    const bridge = window.__webInkEngine;
    if (!bridge || force || bridge.canStop()) {
      bridge?.stop();
      return true;
    }
    return false;
  };
  const ensureEngine = async (): Promise<boolean> => {
    if (disposed || !enabled || blocked) return false;
    let bridge = window.__webInkEngine;
    bridge?.start();
    if (bridge) return true;
    await raw<boolean>({ type: "engine.ensure", pageUrl: currentUrl });
    // executeScript completes before the background response; retain this guard for
    // an extension reload or a document navigation in the intervening microtask.
    if (disposed || pageKey(location.href) !== currentUrl) return false;
    bridge = window.__webInkEngine;
    bridge?.start();
    return Boolean(bridge);
  };
  const refreshMode = async () => {
    const url = pageKey(location.href);
    currentUrl = url;
    busy = true;
    updateToggle();
    try {
      const [settings, mode] = await Promise.all([
        request<Settings>({ type: "settings.get" }),
        request<PageMode>({ type: "page.mode.get", pageUrl: url }),
      ]);
      if (disposed || pageKey(location.href) !== url) return;
      language = settings.language;
      view.applyPreferences(settings);
      blocked = settings.disabledOrigins.includes(location.origin);
      enabled = mode.enabled;
      if (enabled && !blocked) await ensureEngine();
      else stopEngine();
    } catch {
      // The palette remains visible and disabled until a later permission/mode event.
      enabled = false;
      stopEngine();
    } finally {
      if (!disposed && pageKey(location.href) === url) {
        busy = false;
        updateToggle();
      }
    }
  };
  const setEnabled = async (next: boolean): Promise<boolean> => {
    if (
      disposed ||
      busy ||
      blocked ||
      (!next && window.__webInkEngine && !window.__webInkEngine.canStop())
    )
      return false;
    busy = true;
    updateToggle();
    const url = pageKey(location.href);
    try {
      const mode = await request<PageMode>({
        type: "page.mode.put",
        pageUrl: url,
        enabled: next,
      });
      if (disposed || pageKey(location.href) !== url) return false;
      enabled = mode.enabled;
      currentUrl = url;
      if (enabled) return ensureEngine();
      stopEngine();
      return true;
    } catch {
      return false;
    } finally {
      if (!disposed) {
        busy = false;
        updateToggle();
      }
    }
  };
  const dispatch = async (
    action: "focus" | "rebind" | "draw" | "refresh",
    id?: string,
  ) => {
    if (pageKey(location.href) !== currentUrl) {
      stopEngine();
      await refreshMode();
    }
    // Direct user operations may deliberately turn the page on. Rebind only acts
    // on an already-restored record and therefore does not silently enable a page.
    if ((action === "focus" || action === "draw") && !enabled && !blocked)
      await setEnabled(true);
    if (!enabled || blocked || !(await ensureEngine())) return;
    window.__webInkEngine?.dispatch(action, id);
  };
  const toggle = createPaletteToggle(view.root, () => {
    void setEnabled(!enabled);
  });
  const onMessage = (
    message: { type?: string; pageUrl?: string; action?: string; id?: string },
    _sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => {
    if (message.type === "permissions.revoked") {
      blocked = true;
      enabled = false;
      stopEngine(true);
      updateToggle();
      return false;
    }
    if (
      message.type === "permissions.restored" ||
      message.type === "settings.changed" ||
      (message.type === "page.mode.changed" &&
        (!message.pageUrl || message.pageUrl === pageKey(location.href)))
    ) {
      void refreshMode();
      return false;
    }
    if (
      message.type === "page.action.execute" &&
      (message.action === "focus" ||
        message.action === "rebind" ||
        message.action === "draw" ||
        message.action === "refresh")
    ) {
      void dispatch(message.action, message.id)
        .then(() => respond(true))
        .catch(() => respond(false));
      return true;
    }
    if (message.type === "page.snapshot") {
      const snapshot = window.__webInkEngine?.snapshot();
      if (snapshot) respond(snapshot);
      else respond({ pageUrl: currentUrl, states: [], enabled });
      return false;
    }
    return false;
  };
  const route = () => {
    if (pageKey(location.href) !== currentUrl) void refreshMode();
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", route);
  const bootstrap: ContentBootstrap = {
    view,
    isEnabled: () => enabled && !blocked,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener("popstate", route);
      window.removeEventListener("hashchange", route);
      stopEngine();
      toggle.dispose();
      view.host.remove();
      delete window.__webInkBootstrap;
    },
  };
  window.__webInkBootstrap = bootstrap;
  updateToggle();
  void refreshMode();
  return bootstrap.dispose;
}
