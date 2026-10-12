import { RequestError, request } from "../core/client";
import { pdfPreparationLabel, ieeeFailureMessage, formatIeeeDiagnostic } from '../pdf/ieee-status';
import type { IeeePdfDiagnostic } from '../pdf/ieee-diagnostics';
import {
  DEFAULT_SETTINGS,
  type PageMode,
  type RuntimeHealth,
  type Settings,
  type PdfTabContext,
} from "../core/model";
import { pageKey } from "../core/url";
import { createPaletteToggle } from "./palette-toggle";
import { createPaletteMenu, type PaletteAction, type PaletteMenuItem } from "./palette-menu";
import { getPdfContext } from "../pdf/context";
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
  const updateToggle = () => {
    toggle.update({ enabled, blocked, busy, language });
    menu.update({ language, items: menuItems() });
  };
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
      // Keep page annotation off until a later permission/mode refresh.
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
    () => menu.toggle(),
    position => { menu.close(); positionWriter.save(position); },
  );
  let menuEpoch = 0;
  let menuContext: PdfTabContext | undefined;
  let opening = false;
  let preparationPhase: string | undefined;
  let preparationError = '';
  let preparationDiagnostic: string | undefined;
  const menuItems = (): PaletteMenuItem[] => {
    const zh = language === "zh-CN";
    const items: PaletteMenuItem[] = [];
    const labeledCandidates = (candidates: PdfTabContext["candidates"]) => {
      const named = candidates.map(candidate => {
        const url = new URL(candidate.url);
        return { candidate, filename: url.pathname.split("/").pop() || url.hostname };
      });
      const nameCounts = new Map<string, number>();
      for (const { filename } of named) nameCounts.set(filename, (nameCounts.get(filename) || 0) + 1);
      return named.map(({ candidate, filename }) => ({
        candidate,
        sourceLabel: nameCounts.get(filename)! > 1 ? `${filename} · ${candidate.url}` : filename,
      }));
    };
    const isIeeeCandidate = (candidate: PdfTabContext["candidates"][number]) => {
      const url = new URL(candidate.url);
      return url.origin === "https://ieeexplore.ieee.org" && !url.username && !url.password;
    };
    if (menuContext?.publisher === "ieee") {
      const label = zh ? "用 Web Ink 标注当前 PDF" : "Annotate current PDF in Web Ink";
      const ieeeCandidates = menuContext.candidates.filter(isIeeeCandidate);
      const publicCandidates = menuContext.candidates.filter(candidate => !isIeeeCandidate(candidate));
      if (!ieeeCandidates.length) {
        items.push({
          action: "open-ieee",
          icon: "pdf",
          primary: true,
          label,
        });
      } else {
        for (const { candidate, sourceLabel } of labeledCandidates(ieeeCandidates)) {
          items.push({
            action: "open-ieee",
            icon: "pdf",
            primary: true,
            label: ieeeCandidates.length === 1 ? label : `${label}: ${sourceLabel}`,
            candidateUrl: candidate.url,
          });
        }
      }
      for (const { candidate, sourceLabel } of labeledCandidates(publicCandidates)) {
        items.push({
          action: "open-pdf",
          icon: "pdf",
          primary: true,
          label: `${zh ? "打开" : "Open"} ${sourceLabel}`,
          candidateUrl: candidate.url,
        });
      }
    } else if (menuContext?.candidates.length) {
      for (const { candidate, sourceLabel } of labeledCandidates(menuContext.candidates)) {
        items.push({ action: "open-pdf", icon: "pdf", primary: true,
          label: menuContext.candidates.length === 1
            ? zh ? "用 Web Ink 标注当前 PDF" : "Annotate current PDF in Web Ink"
            : `${zh ? "打开" : "Open"} ${sourceLabel}`,
          candidateUrl: candidate.url });
      }
    } else if (menuContext?.reason === "not-pdf" && !getPdfContext(location.href)) {
      items.push({ action: "toggle", icon: "highlight", primary: true, disabled: blocked,
        label: zh ? enabled ? "关闭本页标注" : "开启本页标注"
          : enabled ? "Disable annotations on this page" : "Enable annotations on this page" });
    }
    items.push(
      { action: "sidebar", icon: "note", label: zh ? "查看本篇标注" : "Page annotations" },
      { action: "library", icon: "library", label: zh ? "资料库" : "Library" },
      { action: "local-pdf", icon: "pdf", label: zh ? "选择电脑上的 PDF…" : "Choose a local PDF…" },
    );
    if (opening && menuContext?.publisher === 'ieee') {
      if (items[0]) items[0].label = pdfPreparationLabel(preparationPhase, language);
      items.push({ action: 'cancel', icon: 'close', label: zh ? '取消读取' : 'Cancel reading' });
    }
    return items;
  };
  const loadMenu = async () => {
    if (opening) { menu.update({ pending: true, items: menuItems(), status: pdfPreparationLabel(preparationPhase, language) }); return; }
    const epoch = ++menuEpoch;
    const url = location.href;
    menuContext = undefined;
    menu.update({ items: menuItems(), loading: true, pending: opening, error: preparationError, diagnostic: preparationDiagnostic });
    try {
      const context = await request<PdfTabContext>({ type: "pdf.context.get", expectedUrl: url });
      if (disposed || epoch !== menuEpoch || location.href !== url || !menu.isOpen()) return;
      menuContext = context;
      const recovery = context.reason && context.reason !== "not-pdf" && !context.candidates.length;
      menu.update({ items: menuItems(), loading: false, error: preparationError || (recovery
        ? language === "zh-CN" ? "无法取得 PDF 来源，请打开已下载的本地文件。" : "PDF source unavailable. Open the downloaded file instead."
        : ""), diagnostic: preparationDiagnostic });
    } catch (cause) {
      if (disposed || epoch !== menuEpoch || location.href !== url || !menu.isOpen()) return;
      menu.update({ loading: false, error: cause instanceof Error ? cause.message : String(cause), items: [
        { action: "retry", icon: "refresh", label: language === "zh-CN" ? "重试识别" : "Retry detection" }, ...menuItems(),
      ] });
    }
  };
  const runMenuAction = async (action: PaletteAction, candidateUrl?: string) => {
    if (action === 'cancel') { await request({ type: 'pdf.cancelCurrent', expectedUrl: location.href }).catch(() => undefined); return; }
    if (disposed || opening) return;
    if (action === "retry") { void loadMenu(); return; }
    const url = location.href;
    const epoch = ++menuEpoch;
    if (menuContext?.url && pageKey(menuContext.url) !== pageKey(url)) {
      void loadMenu(); return;
    }
    opening = true;
    preparationPhase = 'identify'; preparationError = ''; preparationDiagnostic = undefined;
    // Ignore an outstanding context result so it cannot erase this action's error.
    menu.update({ pending: true, loading: false, error: "", diagnostic: undefined, items: menuItems(), status: pdfPreparationLabel(preparationPhase, language) });
    try {
      if (action === "open-pdf" || action === "open-ieee") {
        if (window.__webInkEngine && !window.__webInkEngine.canStop(health.generation))
          throw Error(language === "zh-CN" ? "请先保存正在编辑的内容。" : "Save your current edits first.");
        await request({
          type: "pdf.openCurrent",
          expectedUrl: url,
          ...(candidateUrl ? { candidateUrl } : {}),
          ...(action === "open-ieee" ? { accessMode: "site-session" as const } : {}),
        });
      } else if (action === "toggle") {
        if (!await setEnabled(!enabled)) throw Error(language === "zh-CN" ? "未能切换标注，请重试。" : "Could not change annotations. Try again.");
      } else {
        // Send in the click's message turn so Chrome retains sidePanel.open activation.
        await request({ type: "ui.open", target: action });
      }
      if (!disposed && epoch === menuEpoch && location.href === url) menu.close();
    } catch (cause) {
      if (!disposed && location.href === url) {
        preparationError = cause instanceof RequestError ? ieeeFailureMessage(cause.code, language) ?? cause.message : cause instanceof Error ? cause.message : String(cause);
        preparationDiagnostic = cause instanceof RequestError && cause.diagnostic ? formatIeeeDiagnostic(cause.diagnostic, health.version) : undefined;
        menu.update({ error: preparationError, diagnostic: preparationDiagnostic });
      }
    } finally {
      opening = false;
      if (!disposed) menu.update({ pending: false, status: undefined, items: menuItems() });
    }
  };
  const menu = createPaletteMenu(view.root, toggle.button, open => {
    if (open) void loadMenu(); else menuEpoch++;
  }, (action, candidate) => { void runMenuAction(action, candidate); });
  // Read once per content-script lifetime. Other open pages keep their position;
  // settings/theme changes and SPA routes must not restore this preference again.
  void Promise.resolve().then(() => chrome.storage.local.get(PALETTE_POSITION_KEY))
    .then(saved => {
      if (!disposed) toggle.setPosition(readPalettePosition(saved[PALETTE_POSITION_KEY]));
    })
    .catch(() => undefined);
  const onMessage = (
    message: { type?: string; pageUrl?: string; action?: string; id?: string; diagnostic?: IeeePdfDiagnostic; stage?: string },
    _sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => {
    if (disposed) return false;
    if (message.type === 'pdf.preparation.changed' && _sender.id === chrome.runtime.id && opening) {
      preparationPhase = message.stage ?? message.diagnostic?.phase;
      menu.update({ pending: true, status: pdfPreparationLabel(preparationPhase, language), items: menuItems() });
      return false;
    }
    if (message.type === "permissions.revoked") {
      menu.close();
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
    if (pageKey(location.href) !== currentUrl) { menu.close(); void refreshMode(); }
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
      menu.dispose();
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
