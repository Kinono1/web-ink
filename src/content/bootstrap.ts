import { request } from "../core/client";
import {
  DEFAULT_SETTINGS,
  type PageMode,
  type RuntimeHealth,
  type Settings,
} from "../core/model";
import { pageKey } from "../core/url";
import { createPaletteToggle } from "./palette-toggle";
import { readPalettePosition } from "./palette-position";
import { createPalettePositionWriter, PALETTE_POSITION_KEY } from "./palette-position-storage";
import { createView } from "./view-lite";

export interface EngineBridge {
  generation: string;
  start: (generation?: string) => void;
  stop: (generation?: string) => void;
  dispatch: (
    action: "focus" | "rebind" | "draw" | "refresh",
    id?: string,
    generation?: string,
  ) => void;
  snapshot: () => { pageUrl: string; states: unknown[]; enabled: boolean };
  canStop: (generation?: string) => boolean;
}
export interface ContentBootstrap {
  health: RuntimeHealth;
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

/** Stop legacy closures before creating a new view; never reuse their bridges. */
export function disposeContentRuntime(): void {
  const bootstrap = window.__webInkBootstrap;
  const bridge = window.__webInkEngine;
  const hosts = document.querySelectorAll('web-ink-ui[data-web-ink-ui="true"]');
  const styles = document.querySelectorAll('style[data-web-ink="true"]');
  try {
    bridge?.stop(bridge.generation);
  } catch {
    // Legacy stop() may throw after aborting its DOM observers and listeners.
  }
  try {
    bootstrap?.dispose();
  } catch {
    // Legacy dispose() may mark itself disposed before its Chrome API throws.
  } finally {
    bootstrap?.view.host.remove();
    hosts.forEach((host) => host.remove());
    styles.forEach((style) => style.remove());
    if (typeof CSS !== "undefined" && "highlights" in CSS)
      for (const name of CSS.highlights.keys())
        if (name.startsWith("web-ink-")) CSS.highlights.delete(name);
    if (window.__webInkBootstrap === bootstrap) delete window.__webInkBootstrap;
    if (window.__webInkEngine === bridge) delete window.__webInkEngine;
  }
}

/** Persistent, low-cost content script. It owns only the palette and mode routing. */
export function startBootstrap(health: RuntimeHealth): () => void {
  if (window.top !== window) return () => undefined;
  const previous = window.__webInkBootstrap;
  if (
    previous?.health?.generation === health.generation &&
    previous.view.host.isConnected
  )
    return () => undefined;
  disposeContentRuntime();
  const view = createView();
  view.host.dataset.webInkGeneration = health.generation;
  let disposed = false;
  let enabled = false;
  let blocked = false;
  let permissionEpoch = 0;
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
    if (!bridge || bridge.generation !== health.generation) return true;
    if (force || bridge.canStop(health.generation)) {
      try {
        bridge.stop(health.generation);
      } finally {
        if (force && window.__webInkEngine === bridge) delete window.__webInkEngine;
      }
      return true;
    }
    return false;
  };
  const ensureEngine = async (): Promise<boolean> => {
    if (disposed || !enabled || blocked) return false;
    let bridge = window.__webInkEngine;
    if (bridge?.generation !== health.generation) bridge = undefined;
    bridge?.start(health.generation);
    if (bridge) return true;
    await raw<boolean>({ type: "engine.ensure", pageUrl: currentUrl });
    // executeScript completes before the background response; retain this guard for
    // an extension reload or a document navigation in the intervening microtask.
    if (
      disposed ||
      !enabled ||
      blocked ||
      pageKey(location.href) !== currentUrl
    )
      return false;
    bridge = window.__webInkEngine;
    if (bridge?.generation !== health.generation) return false;
    bridge?.start(health.generation);
    return Boolean(bridge);
  };
  const refreshMode = async (showBusy = true) => {
    if (disposed) return;
    const url = pageKey(location.href);
    const epoch = permissionEpoch;
    currentUrl = url;
    if (showBusy) {
      busy = true;
      updateToggle();
    }
    try {
      const [settings, mode] = await Promise.all([
        request<Settings>({ type: "settings.get" }),
        request<PageMode>({ type: "page.mode.get", pageUrl: url }),
      ]);
      if (disposed || epoch !== permissionEpoch || pageKey(location.href) !== url) return;
      language = settings.language;
      view.applyPreferences(settings);
      blocked = settings.disabledOrigins.includes(location.origin);
      enabled = mode.enabled;
      if (enabled && !blocked) await ensureEngine();
      else stopEngine();
    } catch (error) {
      if (disposed || epoch !== permissionEpoch || pageKey(location.href) !== url) return;
      if (/Extension context invalidated|Extension unavailable/i.test(String(error))) {
        bootstrap.dispose();
        return;
      }
      // The palette remains visible and disabled until a later permission/mode event.
      enabled = false;
      stopEngine();
    } finally {
      if (!disposed && epoch === permissionEpoch && pageKey(location.href) === url) {
        if (showBusy) busy = false;
        updateToggle();
      }
    }
  };
  const setEnabled = async (next: boolean): Promise<boolean> => {
    if (
      disposed ||
      busy ||
      blocked ||
      (!next && window.__webInkEngine && !window.__webInkEngine.canStop(health.generation))
    )
      return false;
    busy = true;
    updateToggle();
    const url = pageKey(location.href);
    const epoch = permissionEpoch;
    try {
      const mode = await request<PageMode>({
        type: "page.mode.put",
        pageUrl: url,
        enabled: next,
      });
      if (disposed || epoch !== permissionEpoch || pageKey(location.href) !== url) return false;
      enabled = mode.enabled;
      currentUrl = url;
      if (enabled) return ensureEngine();
      stopEngine();
      return true;
    } catch {
      return false;
    } finally {
      if (!disposed && epoch === permissionEpoch) {
        busy = false;
        updateToggle();
      }
    }
  };
  const dispatch = async (
    action: "focus" | "rebind" | "draw" | "refresh",
    id?: string,
  ) => {
    if (disposed) return;
    if (pageKey(location.href) !== currentUrl) {
      stopEngine();
      await refreshMode();
    }
    // Direct user operations may deliberately turn the page on. Rebind only acts
    // on an already-restored record and therefore does not silently enable a page.
    if ((action === "focus" || action === "draw") && !enabled && !blocked)
      await setEnabled(true);
    if (!enabled || blocked || !(await ensureEngine())) return;
    window.__webInkEngine?.dispatch(action, id, health.generation);
  };
  const positionWriter = createPalettePositionWriter(
    position => chrome.storage.local.set({ [PALETTE_POSITION_KEY]: position }),
  );
  const toggle = createPaletteToggle(
    view.root,
    () => { void setEnabled(!enabled); },
    positionWriter.save,
  );
  // Read once per content-script lifetime. Other open pages keep their position;
  // settings/theme changes and SPA routes must not restore this preference again.
  void Promise.resolve().then(() => chrome.storage.local.get(PALETTE_POSITION_KEY))
    .then(saved => {
      if (!disposed) toggle.setPosition(readPalettePosition(saved[PALETTE_POSITION_KEY]));
    })
    .catch(() => undefined);
  const onMessage = (
    message: { type?: string; pageUrl?: string; action?: string; id?: string },
    _sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => {
    if (disposed) return false;
    if (message.type === "permissions.revoked") {
      permissionEpoch++;
      blocked = true;
      enabled = false;
      busy = false;
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
      if (message.type === "permissions.restored") permissionEpoch++;
      // Appearance updates must not briefly disable and cancel an active drag.
      // Pausing an origin still cancels once its actual blocked state is read.
      void refreshMode(message.type !== "settings.changed");
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
    if (disposed) return;
    if (pageKey(location.href) !== currentUrl) void refreshMode();
  };
  const bootstrap: ContentBootstrap = {
    health,
    view,
    isEnabled: () => !disposed && enabled && !blocked,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        // Reload invalidates this API before the DOM resources are released.
      }
      window.removeEventListener("popstate", route);
      window.removeEventListener("hashchange", route);
      try {
        stopEngine(true);
      } catch {
        // A legacy bridge must not interrupt the palette's cleanup.
      }
      positionWriter.dispose();
      toggle.dispose();
      view.host.remove();
      if (window.__webInkBootstrap === bootstrap) delete window.__webInkBootstrap;
    },
  };
  window.__webInkBootstrap = bootstrap;
  try {
    chrome.runtime.onMessage.addListener(onMessage);
  } catch {
    bootstrap.dispose();
    return () => undefined;
  }
  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", route);
  updateToggle();
  void refreshMode();
  return bootstrap.dispose;
}
