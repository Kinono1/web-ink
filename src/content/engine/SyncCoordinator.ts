import { request, RequestError } from "../../core/client";
import type { Annotation, PageMode, Settings } from "../../core/model";
import { pageKey } from "../../core/url";
import { readAnnotationPresets } from "../../core/annotation-presets";
import { readSelectionToolbarEnabled } from "../../core/selection-toolbar";
import type { AnnotationController } from "./AnnotationController";

type SyncCoordinatorContext = Pick<
  AnnotationController,
  | "currentUrl"
  | "disabled"
  | "disposed"
  | "enabled"
  | "events"
  | "interactions"
  | "label"
  | "mode"
  | "modeReady"
  | "notifications"
  | "pageEnabled"
  | "render"
  | "save"
  | "settings"
  | "stopped"
  | "store"
  | "view"
>;

/** Owns refresh generations, navigation races, and bounded passive retries. */
export class SyncCoordinator {
  generation: number = 0;
  presetReadGeneration: number = 0;
  selectionToolbarReadGeneration: number = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  refreshDepth: number = 0;
  private passiveRetryCount: number = 0;
  private passiveRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly yieldTimers = new Map<ReturnType<typeof setTimeout>, () => void>();

  constructor(private readonly engine: SyncCoordinatorContext) {}

  refresh = async () => {
    const {
      notifications,
      store,
      render,
      mode,
      events,
      save,
      interactions,
      view,
      enabled,
      label,
    } = this.engine;
    if (this.engine.disposed) return;
    const token = ++this.generation;
    const presetReadToken = ++this.presetReadGeneration;
    const toolbarReadToken = ++this.selectionToolbarReadGeneration;
    this.refreshDepth++;
    let requestedUrl = this.engine.currentUrl;
    try {
      const nextUrl = pageKey(location.href);
      if (nextUrl !== this.engine.currentUrl) {
        notifications.resetScope();
        this.passiveRetryCount = 0;
        clearTimeout(this.passiveRetryTimer);
        this.passiveRetryTimer = undefined;
        this.engine.currentUrl = nextUrl;
        store.reset(true);
        render.images.clear();
        render.clearText();
        render.textSession.invalidate();
        mode.exitDrawing();
        this.engine.pageEnabled = false;
        this.engine.modeReady = false;
        events.mutationObserver.disconnect();
        events.resizeObserver.disconnect();
        save.resetHistory();
        mode.rebinding = undefined;
        interactions.hideSelection();
      }
      requestedUrl = this.engine.currentUrl;
      const [newSettings, pageMode, autoToolbar] = await Promise.all([
        request<Settings>({ type: "settings.get" }),
        request<PageMode>({ type: "page.mode.get", pageUrl: requestedUrl }),
        readSelectionToolbarEnabled(),
      ]);
      const newPresets = await readAnnotationPresets(newSettings.language);
      if (token !== this.generation || this.engine.disposed) return;
      if (pageKey(location.href) !== requestedUrl) {
        this.queueRefresh();
        return;
      }
      this.passiveRetryCount = 0;
      clearTimeout(this.passiveRetryTimer);
      this.passiveRetryTimer = undefined;
      if (this.engine.settings.defaultColor !== newSettings.defaultColor || mode.mode === "idle")
        mode.currentColor = newSettings.defaultColor;
      this.engine.settings = newSettings;
      if (toolbarReadToken === this.selectionToolbarReadGeneration) {
        interactions.selectionToolbarEnabled = autoToolbar;
        if (!autoToolbar && interactions.selectionPaletteAutomatic) interactions.hideSelection();
      }
      if (presetReadToken === this.presetReadGeneration)
        interactions.annotationPresets = newPresets;
      view.applyPreferences(this.engine.settings);
      this.engine.disabled = this.engine.settings.disabledOrigins.includes(location.origin);
      this.engine.pageEnabled = pageMode.enabled;
      this.engine.modeReady = true;
      if (!enabled()) {
        events.mutationObserver.disconnect();
        events.resizeObserver.disconnect();
        store.reset();
        render.clearText();
        render.images.clear();
        render.imageLayers.clear();
        render.transientLayer.replaceChildren();
        mode.exitDrawing();
        interactions.hideSelection();
        notifications.hide();
        store.publishStates();
        return;
      }
      events.observeReadingPage();
      const records = await request<Annotation[]>({
        type: "annotations.list",
        pageUrl: requestedUrl,
      });
      if (token !== this.generation || this.engine.disposed) return;
      if (pageKey(location.href) !== requestedUrl) {
        this.queueRefresh();
        return;
      }
      store.prepareRestore(records);
      render.clearText();
      events.resizeObserver.disconnect();
      render.images.clear();
      render.imageLayers.clear();
      if (!enabled()) {
        mode.exitDrawing();
        store.publishStates();
        return;
      }
      const supportsHighlight =
        "highlights" in CSS && typeof Highlight !== "undefined";
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        // A response started before a delete is never allowed to restore the
        // deleted version into this engine's local state.
        if (!store.acceptsRestore(record)) continue;
        store.restoreAnchor(record, supportsHighlight);
        // Yield for large pages, while a newer refresh can cancel this work.
        if (i % 20 === 19) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              this.yieldTimers.delete(timer);
              resolve();
            }, 0);
            this.yieldTimers.set(timer, resolve);
          });
          if (token !== this.generation || this.engine.disposed) return;
          if (pageKey(location.href) !== requestedUrl) {
            this.queueRefresh();
            return;
          }
        }
      }
      if (token !== this.generation || this.engine.disposed) return;
      render.applyTextStyles();
      store.publishStates();
      render.schedulePaint();
    } catch (error) {
      if (this.engine.disposed || token !== this.generation) return;
      if (
        (error instanceof RequestError && error.code === "PAGE_CHANGED") ||
        pageKey(location.href) !== requestedUrl
      ) {
        // Navigation races are expected background work, not a failed user save.
        // Retry a bounded number of times; never flood the page with an internal error.
        if (this.passiveRetryCount < 2 && !this.passiveRetryTimer) {
          this.passiveRetryCount++;
          this.passiveRetryTimer = setTimeout(() => {
            this.passiveRetryTimer = undefined;
            if (!this.engine.disposed && !this.engine.stopped) void this.refresh();
          }, 300);
        }
        return;
      }
      if (!this.engine.pageEnabled) {
        this.engine.modeReady = true;
        return;
      }
      notifications.show(
        label(
          "暂时无法恢复此页标注，可刷新网页重试。",
          "Annotations could not be restored. Reload this page to retry.",
        ),
        {
          kind: "error",
          key: `restore:${error instanceof RequestError ? error.code : "unavailable"}`,
          passive: true,
          dismissLabel: label("关闭提示", "Dismiss"),
        },
      );
    } finally {
      this.refreshDepth--;
    }
  };

  queueRefresh = () => {
    if (this.engine.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (
        !this.engine.disposed &&
        (this.engine.enabled() || pageKey(location.href) !== this.engine.currentUrl)
      )
        void this.refresh();
    }, 250);
  };

  dispose = () => {
    this.generation++;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.passiveRetryTimer);
    for (const [timer, resolve] of this.yieldTimers) {
      clearTimeout(timer);
      resolve();
    }
    this.yieldTimers.clear();
  };
}
