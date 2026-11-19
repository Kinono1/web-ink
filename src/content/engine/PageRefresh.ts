import { readAnnotationPresets, type AnnotationPreset } from "../../core/annotation-presets";
import { request, RequestError } from "../../core/client";
import type { Annotation, PageMode, Settings } from "../../core/model";
import { readSelectionToolbarEnabled } from "../../core/selection-toolbar";
import { pageKey } from "../../core/url";
import type { Notifications } from "../notifications";
import type { ContentView } from "../view-lite";

export interface PageRefreshHost {
  readonly view: Pick<ContentView, "applyPreferences">;
  readonly notifications: Notifications;
  readonly ui: {
    mode: "idle" | "choose-image";
    currentColor: string;
    annotationPresets: AnnotationPreset[];
    selectionToolbarEnabled: boolean;
    rebinding: Annotation | undefined;
    resizeObserver: ResizeObserver;
    mutationObserver: MutationObserver;
    exitImageRebind(): void;
    hideSelection(): void;
    observeReadingPage(): void;
  };
  currentUrl: string;
  settings: Settings;
  disabled: boolean;
  pageEnabled: boolean;
  modeReady: boolean;
  stopped: boolean;
  disposed: boolean;
  enabled(): boolean;
  label(cn: string, en: string): string;
}

interface PageRefreshData {
  reset(clearRevisions?: boolean): void;
  clearAnchors(): void;
  invalidateTextIndex(): void;
  clearRemovalHistory(): void;
  prepareRestore(records: Annotation[]): void;
  acceptsRestore(record: Annotation): boolean;
  restoreAnchor(record: Annotation, supportsHighlight: boolean): void;
  applyTextStyles(): void;
  publishStates(): void;
  schedulePaint(): void;
}

/** Coordinates one document's mode reads and anchor restoration across route changes and Reload. */
export class PageRefresh {
  generation = 0;
  navigationGeneration = 0;
  presetReadGeneration = 0;
  refreshDepth = 0;
  restoreFailed = false;

  private interactiveUrl: string | undefined;
  private currentRefresh: Promise<void> | undefined;
  private readonly refreshWaiters = new Set<() => void>();
  private cancellationGeneration = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly yieldTimers = new Map<ReturnType<typeof setTimeout>, () => void>();

  constructor(private readonly engine: PageRefreshHost, private readonly data: PageRefreshData) {}

  refresh = (interactive = false): Promise<void> => {
    const pending = this.refreshOnce(interactive);
    this.currentRefresh = pending;
    this.wakeRefreshWaiters();
    return interactive ? this.awaitLatest(pending) : pending;
  };

  private async awaitLatest(latest: Promise<void>) {
    const cancellation = this.cancellationGeneration;
    while (true) {
      let wake!: () => void;
      const changed = new Promise<false>(resolve => {
        wake = () => resolve(false);
        this.refreshWaiters.add(wake);
      });
      try {
        const completed = await Promise.race([latest.then(() => true), changed]);
        if (this.cancellationGeneration !== cancellation ||
          !this.currentRefresh || (completed && this.currentRefresh === latest)) return;
        latest = this.currentRefresh;
      } finally {
        this.refreshWaiters.delete(wake);
      }
    }
  }

  private async refreshOnce(interactive: boolean) {
    if (this.engine.disposed || this.engine.stopped) {
      this.interactiveUrl = undefined;
      return;
    }
    const generation = ++this.generation;
    const presetReadGeneration = ++this.presetReadGeneration;
    this.refreshDepth++;
    let requestedUrl = this.engine.currentUrl;
    let confirmedDisabled = false;
    try {
      const nextUrl = pageKey(location.href);
      if (interactive) this.interactiveUrl = nextUrl;
      else if (this.interactiveUrl !== nextUrl) this.interactiveUrl = undefined;
      if (nextUrl !== this.engine.currentUrl) this.changeRoute(nextUrl);
      requestedUrl = this.engine.currentUrl;
      const [settings, mode] = await Promise.all([
        request<Settings>({ type: "settings.get" }),
        request<PageMode>({ type: "page.mode.get", pageUrl: requestedUrl }).then(result => {
          if (generation === this.generation && !this.engine.disposed && pageKey(location.href) === requestedUrl)
            confirmedDisabled = !result.enabled;
          return result;
        }),
      ]);
      // Older extension contexts provide only the enabled flag.
      const selectionToolsEnabled = mode.selectionToolsEnabled ??
        (mode.enabled && await readSelectionToolbarEnabled());
      const presets = await readAnnotationPresets(settings.language);
      if (!this.isCurrent(generation, requestedUrl)) return;
      this.clearRetry();
      this.applyMode(settings, mode.enabled, selectionToolsEnabled, presetReadGeneration, presets);
      if (!this.engine.enabled()) {
        this.clearDisabledPage();
        return;
      }
      this.engine.ui.observeReadingPage();
      await this.restorePage(generation, requestedUrl);
    } catch (error) {
      this.handleRefreshFailure(error, generation, requestedUrl, confirmedDisabled);
    } finally {
      this.refreshDepth--;
    }
  }

  private changeRoute(url: string) {
    this.navigationGeneration++;
    this.engine.notifications.resetScope();
    this.clearRetry();
    this.engine.currentUrl = url;
    this.data.reset(true);
    this.data.clearAnchors();
    this.data.invalidateTextIndex();
    this.engine.ui.exitImageRebind();
    this.engine.pageEnabled = false;
    this.engine.modeReady = false;
    this.restoreFailed = false;
    this.engine.ui.mutationObserver.disconnect();
    this.engine.ui.resizeObserver.disconnect();
    this.data.clearRemovalHistory();
    this.engine.ui.rebinding = undefined;
    this.engine.ui.hideSelection();
  }

  private applyMode(
    settings: Settings, enabled: boolean, selectionToolsEnabled: boolean,
    presetGeneration: number, presets: AnnotationPreset[],
  ) {
    const { ui, view } = this.engine;
    if (this.engine.settings.defaultColor !== settings.defaultColor || ui.mode === "idle")
      ui.currentColor = settings.defaultColor;
    this.engine.settings = settings;
    if (presetGeneration === this.presetReadGeneration) ui.annotationPresets = presets;
    view.applyPreferences(settings);
    this.engine.disabled = settings.disabledOrigins.includes(location.origin);
    this.engine.pageEnabled = enabled;
    this.engine.modeReady = true;
    ui.selectionToolbarEnabled = this.engine.enabled() && selectionToolsEnabled;
  }

  private clearDisabledPage() {
    this.engine.ui.mutationObserver.disconnect();
    this.engine.ui.resizeObserver.disconnect();
    this.data.reset();
    this.data.clearAnchors();
    this.engine.ui.exitImageRebind();
    this.engine.ui.hideSelection();
    this.restoreFailed = false;
    this.interactiveUrl = undefined;
    this.engine.notifications.clear("restore");
    this.data.publishStates();
  }

  private isCurrent(generation: number, url: string): boolean {
    if (generation !== this.generation || this.engine.disposed) return false;
    if (pageKey(location.href) === url) return true;
    this.queueRefresh();
    return false;
  }

  private async restorePage(generation: number, url: string) {
    const records = await request<Annotation[]>({ type: "annotations.list", pageUrl: url });
    if (!this.isCurrent(generation, url)) return;
    this.data.prepareRestore(records);
    this.engine.ui.resizeObserver.disconnect();
    this.data.clearAnchors();
    if (!this.engine.enabled()) {
      this.interactiveUrl = undefined;
      this.engine.ui.exitImageRebind();
      this.data.publishStates();
      return;
    }
    const supportsHighlight = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
    for (const [index, record] of records.entries()) {
      if (!this.data.acceptsRestore(record)) continue;
      this.data.restoreAnchor(record, supportsHighlight);
      // Yield for large pages so a newer refresh can cancel before painting.
      if (index % 20 === 19) {
        await this.yieldToPage();
        if (!this.isCurrent(generation, url)) return;
      }
    }
    if (generation !== this.generation || this.engine.disposed) return;
    this.data.applyTextStyles();
    this.data.publishStates();
    this.data.schedulePaint();
    this.restoreFailed = false;
    this.interactiveUrl = undefined;
    this.engine.notifications.clear("restore");
  }

  private yieldToPage(): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.yieldTimers.delete(timer);
        resolve();
      }, 0);
      this.yieldTimers.set(timer, resolve);
    });
  }

  private handleRefreshFailure(error: unknown, generation: number, url: string, confirmedDisabled: boolean) {
    if (this.engine.disposed || generation !== this.generation) return;
    if (this.engine.stopped) {
      this.interactiveUrl = undefined;
      return;
    }
    if ((error instanceof RequestError && error.code === "PAGE_CHANGED") || pageKey(location.href) !== url) {
      if (this.retryCount >= 2 || this.retryTimer) return;
      this.retryCount++;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        if (!this.engine.disposed && !this.engine.stopped) void this.refresh();
      }, 300);
      return;
    }
    if (confirmedDisabled) {
      this.interactiveUrl = undefined;
      return;
    }
    this.restoreFailed = true;
    const repeat = this.interactiveUrl === url;
    this.interactiveUrl = undefined;
    const { label, notifications } = this.engine;
    notifications.show(label("暂时无法恢复此页标注，可刷新网页重试。", "Annotations could not be restored. Reload this page to retry."), {
      dismissLabel: label("关闭提示", "Dismiss"),
      kind: "error",
      key: "restore",
      passive: true,
      repeat,
    });
  }

  queueRefresh = () => {
    if (this.engine.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.engine.disposed && (this.engine.enabled() || pageKey(location.href) !== this.engine.currentUrl))
        void this.refresh();
    }, 250);
  };

  restartAfterDelete() {
    if (this.refreshDepth === 0) return;
    this.generation++;
    this.queueRefresh();
  }

  cancelPendingRefresh() {
    this.generation++;
    this.cancellationGeneration++;
    this.interactiveUrl = undefined;
    this.currentRefresh = undefined;
    this.wakeRefreshWaiters();
  }

  private wakeRefreshWaiters() {
    for (const wake of this.refreshWaiters) wake();
    this.refreshWaiters.clear();
  }

  private clearRetry() {
    this.retryCount = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  dispose() {
    this.cancelPendingRefresh();
    clearTimeout(this.refreshTimer);
    this.clearRetry();
    for (const [timer, resolve] of this.yieldTimers) {
      clearTimeout(timer);
      resolve();
    }
    this.yieldTimers.clear();
  }
}
