import { request, RequestError } from "../../core/client";
import type {
  Annotation,
  AnchorState,
  ImageAnnotation,
  PageMode,
  Settings,
  TextAnnotation,
} from "../../core/model";
import { resolveImage } from "../../core/image-anchor";
import { pageKey } from "../../core/url";
import { TextAnchorSession } from "../../core/text-anchor";
import { readAnnotationPresets } from "../../core/annotation-presets";
import { readSelectionToolbarEnabled } from "../../core/selection-toolbar";
import { ImageLayerManager, renderShape } from "../image-layers";
import type { NotificationOptions, Notifications } from "../notifications";
import { svgElement, type ContentView } from "../view-lite";
import type { UIController } from "./UIController";

/** Host surface supplied by {@link AnnotationController}; the UI half is set after construction. */
export interface DataEngineHost {
  readonly view: ContentView;
  readonly notifications: Notifications;
  readonly ui: UIController;
  settings: Settings;
  currentUrl: string;
  disabled: boolean;
  pageEnabled: boolean;
  modeReady: boolean;
  stopped: boolean;
  disposed: boolean;
  enabled: () => boolean;
  label: (cn: string, en: string) => string;
  toast: (message: string, error?: boolean, retry?: () => void) => void;
  fail: (error: unknown) => void;
}

/**
 * Owns content data: annotation records and anchor states, DOM anchor caches and
 * coalesced painting, server reconciliation/refresh, and confirmed writes.
 */
export class DataEngine {
  private records: Annotation[] = [];
  private anchorStates: AnchorState[] = [];
  private appliedRevisions: Map<string, number> = new Map<string, number>();
  private deletedRevisions: Map<string, number> = new Map<string, number>();

  readonly highlightStyle: HTMLStyleElement = document.createElement("style");
  private renderFrame: number = 0;
  readonly textSession: TextAnchorSession = new TextAnchorSession(document);
  readonly images: Map<string, HTMLImageElement> = new Map<string, HTMLImageElement>();
  readonly textRanges: Map<string, Range> = new Map<string, Range>();
  private highlightNames: Set<string> = new Set<string>();
  readonly imageLayers: ImageLayerManager;
  readonly transientLayer: SVGGElement = svgElement("g", { "data-web-ink-transient": "true" });
  private focusId: string | undefined;

  generation: number = 0;
  navigationGeneration: number = 0;
  presetReadGeneration: number = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  refreshDepth: number = 0;
  restoreFailed: boolean = false;
  private interactiveUrl: string | undefined;
  private currentRefresh: Promise<void> | undefined;
  private readonly refreshWaiters = new Set<() => void>();
  private cancellationGeneration: number = 0;
  private passiveRetryCount: number = 0;
  private passiveRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly yieldTimers = new Map<ReturnType<typeof setTimeout>, () => void>();

  private draft: Annotation | undefined;
  private removedRecords: Array<TextAnnotation | ImageAnnotation> = [];
  private undo: ImageAnnotation[] = [];
  private redo: ImageAnnotation[] = [];
  private saving: boolean = false;
  readonly recentColors: string[] = [];

  constructor(private readonly engine: DataEngineHost) {
    this.imageLayers = new ImageLayerManager(this.engine.view.svg);
    this.highlightStyle.dataset.webInk = "true";
    document.documentElement.append(this.highlightStyle);
  }

  /** Every engine notification uses the same dismissal affordance; callers add the rest. */
  private notify = (message: string, options: NotificationOptions = {}) =>
    this.engine.notifications.show(message, { dismissLabel: this.engine.label("关闭提示", "Dismiss"), ...options });

  get annotations(): Annotation[] { return this.records; }

  get states(): AnchorState[] { return this.anchorStates; }

  reset = (clearRevisions = false) => {
    this.records = [];
    this.anchorStates = [];
    if (clearRevisions) {
      this.appliedRevisions.clear();
      this.deletedRevisions.clear();
    }
  };

  prepareRestore = (records: Annotation[]) => {
    this.records = records.filter(
      record => (this.deletedRevisions.get(record.id) ?? -1) < record.revision,
    );
    this.anchorStates = [];
    this.appliedRevisions.clear();
    for (const record of this.records)
      this.appliedRevisions.set(record.id, record.revision);
  };

  acceptsRestore = (record: Annotation) =>
    (this.deletedRevisions.get(record.id) ?? -1) < record.revision &&
    this.records.find(item => item.id === record.id)?.revision === record.revision;

  restoreAnchor = (record: Annotation, supportsHighlight: boolean) => {
    if (record.kind === "text") {
      if (!supportsHighlight)
        this.anchorStates.push({
          id: record.id,
          status: "unsupported",
          reason: "CSS Custom Highlight is unavailable",
        });
      else {
        const match = this.textSession.resolve(record.target);
        this.anchorStates.push({
          id: record.id,
          status: match.status,
          reason: match.reason,
        });
        if (match.range) { this.textRanges.set(record.id, match.range); }
      }
    } else if (record.kind === "image") {
      const match = resolveImage(record.target);
      this.anchorStates.push({
        id: record.id,
        status: match.status,
        reason: match.reason,
      });
      if (match.image) {
        this.images.set(record.id, match.image);
        this.engine.ui.resizeObserver.observe(match.image);
      }
    }
  };

  applyAnnotationDelta = (annotation?: Annotation, deletedId?: string, pageUrl?: string): boolean => {
    if (!this.engine.enabled() || (pageUrl && pageUrl !== this.engine.currentUrl)) return true;
    if (!annotation && !deletedId) return false;
    if (deletedId) {
      if (this.refreshDepth) {
        this.generation++;
        this.queueRefresh();
      }
      const deleted = this.records.find((record) => record.id === deletedId);
      const known = this.appliedRevisions.get(deletedId) ?? deleted?.revision;
      if (known !== undefined)
        this.deletedRevisions.set(
          deletedId,
          Math.max(this.deletedRevisions.get(deletedId) ?? -1, known),
        );
      this.records = this.records.filter((record) => record.id !== deletedId);
      this.textRanges.delete(deletedId);
      this.images.delete(deletedId);
      this.appliedRevisions.delete(deletedId);
      this.anchorStates = this.anchorStates.filter((state) => state.id !== deletedId);
      if (this.engine.ui.actionRecords.some((record) => record.id === deletedId))
        this.engine.ui.hideSelection();
      this.imageLayers.drop(deletedId);
      this.applyTextStyles();
      this.publishStates();
      this.schedulePaint();
      return true;
    }
    if (!annotation || (annotation.kind !== "text" && annotation.kind !== "image") || annotation.pageUrl !== this.engine.currentUrl) return true;
    const known = this.appliedRevisions.get(annotation.id);
    if (known !== undefined && known >= annotation.revision) return true;
    if ((this.deletedRevisions.get(annotation.id) ?? -1) >= annotation.revision) return true;
    const previous = this.records.find((record) => record.id === annotation.id);
    this.records = previous
      ? this.records.map((record) =>
          record.id === annotation!.id ? annotation! : record,
        )
      : [...this.records, annotation];
    this.appliedRevisions.set(annotation.id, annotation.revision);
    if ((this.deletedRevisions.get(annotation.id) ?? -1) < annotation.revision)
      this.deletedRevisions.delete(annotation.id);
    if (annotation.kind === "text") {
      const targetChanged =
        previous?.kind !== "text" ||
        JSON.stringify(previous.target) !== JSON.stringify(annotation.target);
      if (targetChanged) {
        const match = this.textSession.resolve(annotation.target);
        this.textRanges.delete(annotation.id);
        this.anchorStates = this.anchorStates.filter((state) => state.id !== annotation!.id);
        this.anchorStates.push({
          id: annotation.id,
          status: match.status,
          reason: match.reason,
        });
        if (match.range) this.textRanges.set(annotation.id, match.range);
      }
      this.applyTextStyles();
    } else {
      const match = resolveImage(annotation.target);
      this.images.delete(annotation.id);
      this.imageLayers.drop(annotation.id);
      this.anchorStates = this.anchorStates.filter((state) => state.id !== annotation!.id);
      this.anchorStates.push({
        id: annotation.id,
        status: match.status,
        reason: match.reason,
      });
      if (match.image) {
        this.images.set(annotation.id, match.image);
        this.engine.ui.resizeObserver.observe(match.image);
      }
    }
    this.publishStates();
    this.schedulePaint();
    return true;
  };

  publishStates = () => {
    void request({ type: "page.states", states: this.anchorStates, pageUrl: this.engine.currentUrl }).catch(
      () => undefined,
    );
  };

  clearText = () => {
    if (typeof CSS !== "undefined" && "highlights" in CSS)
      for (const name of this.highlightNames) CSS.highlights.delete(name);
    this.highlightNames.clear();
    this.textRanges.clear();
    this.highlightStyle.textContent = "";
  };

  applyTextStyles = () => {
    if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
    for (const name of this.highlightNames) CSS.highlights.delete(name);
    this.highlightNames.clear();
    const groups = new Map<string, Range[]>();
    for (const record of this.annotations)
      if (record.kind === "text") {
        const range = this.textRanges.get(record.id);
        if (!range) continue;
        const group = groups.get(record.color) ?? [];
        group.push(range);
        groups.set(record.color, group);
      }
    const rules: string[] = [];
    for (const [color, ranges] of groups) {
      const name = `web-ink-${color.slice(1)}`;
      CSS.highlights.set(name, new Highlight(...ranges));
      this.highlightNames.add(name);
      rules.push(
        `::highlight(${name}) { background-color: ${color}99; color: inherit; }`,
      );
    }
    this.highlightStyle.textContent = rules.join("\n");
  };

  paintImages = () => {
    this.renderFrame = 0;
    if (this.engine.disposed) return;
    if (!this.engine.enabled()) return;
    this.imageLayers.beginPaint();
    this.transientLayer.replaceChildren();
    const validLayers = new Set<string>();
    for (const record of this.annotations)
      if (record.kind === "image") {
        validLayers.add(record.id);
        const image = this.images.get(record.id);
        if (image?.isConnected) this.imageLayers.draw(record, image, this.focusId);
        else this.imageLayers.hide(record.id);
      }
    if (this.engine.ui.selectedImage?.isConnected) {
      const geometry = this.imageLayers.clippedGeometry(this.engine.ui.selectedImage);
      if (geometry)
        this.transientLayer.append(
          svgElement("rect", {
            ...geometry.clipRect,
            fill: "none",
            stroke: "#2563eb",
            "stroke-width": 1,
            "stroke-dasharray": "5 4",
          }),
        );
      if (this.engine.ui.previewShape && geometry)
        this.transientLayer.append(
          renderShape(this.engine.ui.previewShape, geometry, this.engine.ui.currentColor),
        );
    }
    if (this.unsaved?.kind === "image") {
      validLayers.add(`${this.unsaved.id}-unsaved`);
      const match = resolveImage(this.unsaved.target);
      if (match.image)
        this.imageLayers.draw(this.unsaved, match.image, this.focusId, "-unsaved");
    }
    this.imageLayers.reconcile(validLayers);
    this.engine.view.svg.append(this.transientLayer);
  };

  schedulePaint = () => {
    if (!this.renderFrame && !this.engine.disposed)
      this.renderFrame = requestAnimationFrame(this.paintImages);
  };

  focusRecord = (id?: string) => {
    const range = id ? this.textRanges.get(id) : undefined;
    const image = id ? this.images.get(id) : undefined;
    if (range) {
      const node =
        range.startContainer.nodeType === Node.ELEMENT_NODE ? (range.startContainer as Element) : range.startContainer.parentElement;
      node?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (image)
      image.scrollIntoView({ block: "center", behavior: "smooth" });
    else
      this.engine.toast(
        this.engine.label("找不到原位置，可在侧栏选择重新定位。", "Original location not found. Use Rebind in the sidebar."),
        true,
      );
    this.focusId = id;
    this.schedulePaint();
  };

  disposeRender = () => {
    this.textSession.dispose();
    cancelAnimationFrame(this.renderFrame);
    this.clearText();
    // The bootstrap keeps the host alive; every engine-owned visual must go away.
    this.engine.view.svg.replaceChildren();
    this.engine.view.svg.style.pointerEvents = "none";
    this.engine.view.svg.style.cursor = "";
    this.images.clear();
    this.imageLayers.clear();
    this.highlightStyle.remove();
  };

  refresh = (interactive = false): Promise<void> => {
    const pending = this.refreshOnce(interactive);
    this.currentRefresh = pending;
    this.wakeRefreshWaiters();
    if (!interactive) return pending;
    const cancellationGeneration = this.cancellationGeneration;
    return (async () => {
      let latest = pending;
      while (true) {
        let wake!: () => void;
        const changed = new Promise<false>(resolve => {
          wake = () => resolve(false);
          this.refreshWaiters.add(wake);
        });
        const completed = await Promise.race([latest.then(() => true), changed]);
        this.refreshWaiters.delete(wake);
        if (
          this.cancellationGeneration !== cancellationGeneration ||
          !this.currentRefresh || (completed && this.currentRefresh === latest)
        ) return;
        latest = this.currentRefresh;
      }
    })();
  };

  private refreshOnce = async (interactive: boolean) => {
    if (this.engine.disposed || this.engine.stopped) {
      this.interactiveUrl = undefined;
      return;
    }
    const token = ++this.generation;
    const presetReadToken = ++this.presetReadGeneration;
    this.refreshDepth++;
    let requestedUrl = this.engine.currentUrl;
    let confirmedDisabled = false;
    try {
      const nextUrl = pageKey(location.href);
      if (interactive) this.interactiveUrl = nextUrl;
      else if (this.interactiveUrl !== nextUrl) this.interactiveUrl = undefined;
      if (nextUrl !== this.engine.currentUrl) {
        this.navigationGeneration++;
        this.engine.notifications.resetScope();
        this.passiveRetryCount = 0;
        clearTimeout(this.passiveRetryTimer);
        this.passiveRetryTimer = undefined;
        this.engine.currentUrl = nextUrl;
        this.reset(true);
        this.images.clear();
        this.clearText();
        this.textSession.invalidate();
        this.engine.ui.exitDrawing();
        this.engine.pageEnabled = false;
        this.engine.modeReady = false;
        this.restoreFailed = false;
        this.engine.ui.mutationObserver.disconnect();
        this.engine.ui.resizeObserver.disconnect();
        this.resetHistory();
        this.engine.ui.rebinding = undefined;
        this.engine.ui.hideSelection();
      }
      requestedUrl = this.engine.currentUrl;
      const [newSettings, pageMode] = await Promise.all([
        request<Settings>({ type: "settings.get" }),
        request<PageMode>({ type: "page.mode.get", pageUrl: requestedUrl }).then(result => {
          if (token === this.generation && !this.engine.disposed && pageKey(location.href) === requestedUrl)
            confirmedDisabled = !result.enabled;
          return result;
        }),
      ]);
      // Older extension contexts only return enabled; keep their global preference until the replacement background provides page intent.
      const selectionTools = pageMode.selectionToolsEnabled ??
        (pageMode.enabled && await readSelectionToolbarEnabled());
      const newPresets = await readAnnotationPresets(newSettings.language);
      if (token !== this.generation || this.engine.disposed) return;
      if (pageKey(location.href) !== requestedUrl) {
        this.queueRefresh();
        return;
      }
      this.passiveRetryCount = 0;
      clearTimeout(this.passiveRetryTimer);
      this.passiveRetryTimer = undefined;
      if (this.engine.settings.defaultColor !== newSettings.defaultColor || this.engine.ui.mode === "idle")
        this.engine.ui.currentColor = newSettings.defaultColor;
      this.engine.settings = newSettings;
      if (presetReadToken === this.presetReadGeneration)
        this.engine.ui.annotationPresets = newPresets;
      this.engine.view.applyPreferences(this.engine.settings);
      this.engine.disabled = this.engine.settings.disabledOrigins.includes(location.origin);
      this.engine.pageEnabled = pageMode.enabled;
      this.engine.modeReady = true;
      this.engine.ui.selectionToolbarEnabled = this.engine.enabled() && selectionTools;
      if (!this.engine.enabled()) {
        this.engine.ui.mutationObserver.disconnect();
        this.engine.ui.resizeObserver.disconnect();
        this.reset();
        this.clearText();
        this.images.clear();
        this.imageLayers.clear();
        this.transientLayer.replaceChildren();
        this.engine.ui.exitDrawing();
        this.engine.ui.hideSelection();
        this.restoreFailed = false;
        this.interactiveUrl = undefined;
        this.engine.notifications.clear("restore");
        this.publishStates();
        return;
      }
      this.engine.ui.observeReadingPage();
      const records = await request<Annotation[]>({
        type: "annotations.list",
        pageUrl: requestedUrl,
      });
      if (token !== this.generation || this.engine.disposed) return;
      if (pageKey(location.href) !== requestedUrl) {
        this.queueRefresh();
        return;
      }
      this.prepareRestore(records);
      this.clearText();
      this.engine.ui.resizeObserver.disconnect();
      this.images.clear();
      this.imageLayers.clear();
      if (!this.engine.enabled()) {
        this.interactiveUrl = undefined;
        this.engine.ui.exitDrawing();
        this.publishStates();
        return;
      }
      const supportsHighlight =
        "highlights" in CSS && typeof Highlight !== "undefined";
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        // A response started before a delete is never allowed to restore the deleted version into this engine's local state.
        if (!this.acceptsRestore(record)) continue;
        this.restoreAnchor(record, supportsHighlight);
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
      this.applyTextStyles();
      this.publishStates();
      this.schedulePaint();
      this.restoreFailed = false;
      this.interactiveUrl = undefined;
      this.engine.notifications.clear("restore");
    } catch (error) {
      if (this.engine.disposed || token !== this.generation) return;
      if (this.engine.stopped) {
        this.interactiveUrl = undefined;
        return;
      }
      if ((error instanceof RequestError && error.code === "PAGE_CHANGED") || pageKey(location.href) !== requestedUrl) {
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
      if (confirmedDisabled) {
        this.interactiveUrl = undefined;
        return;
      }
      this.restoreFailed = true;
      const repeat = this.interactiveUrl === requestedUrl;
      this.interactiveUrl = undefined;
      this.notify(
        this.engine.label("暂时无法恢复此页标注，可刷新网页重试。", "Annotations could not be restored. Reload this page to retry."),
        {
          kind: "error",
          key: "restore",
          passive: true,
          repeat,
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
      if (!this.engine.disposed && (this.engine.enabled() || pageKey(location.href) !== this.engine.currentUrl))
        void this.refresh();
    }, 250);
  };

  cancelPendingRefresh = () => {
    this.generation++;
    this.cancellationGeneration++;
    this.interactiveUrl = undefined;
    this.currentRefresh = undefined;
    this.wakeRefreshWaiters();
  };

  private wakeRefreshWaiters = () => {
    for (const wake of this.refreshWaiters) wake();
    this.refreshWaiters.clear();
  };

  disposeSync = () => {
    this.cancelPendingRefresh();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.passiveRetryTimer);
    for (const [timer, resolve] of this.yieldTimers) {
      clearTimeout(timer);
      resolve();
    }
    this.yieldTimers.clear();
  };

  get unsaved(): Annotation | undefined { return this.draft; }

  get pendingSave(): boolean { return this.saving; }

  get canUndoRemoval(): boolean { return this.removedRecords.length > 0; }

  discardDraft = () => { this.draft = undefined; };

  resetHistory = () => {
    this.undo.length = 0;
    this.redo.length = 0;
    this.removedRecords.length = 0;
  };

  removeAnnotation = async (record: TextAnnotation | ImageAnnotation) => {
    if (!this.engine.enabled() || this.saving || this.draft) return;
    this.saving = true;
    try {
      await request({
        type: "annotations.delete",
        id: record.id,
        expectedRevision: record.revision,
      });
      if (this.engine.disposed || record.pageUrl !== pageKey(location.href)) return;
      this.applyAnnotationDelta(undefined, record.id, record.pageUrl);
      this.engine.ui.hideSelection();
      getSelection()?.removeAllRanges();
      this.removedRecords.push(record);
      if (this.removedRecords.length > 20) this.removedRecords.shift();
      this.notify(this.engine.label("已取消标注", "Annotation removed"), {
        kind: "success",
        sticky: true,
        actions: [
          {
            label: this.engine.label("撤销取消", "Undo removal"),
            run: () => {
              void this.undoRemoval(record);
            },
          },
        ],
      });
    } catch (error) {
      if (error instanceof RequestError && error.code === "CONFLICT") {
        this.engine.ui.hideSelection();
        void this.refresh();
      }
      this.notify(
        this.engine.label("取消失败：", "Could not remove: ") +
          (error instanceof Error ? error.message : String(error)),
        {
          kind: "error",
          sticky: true,
          actions:
            error instanceof RequestError && error.code === "CONFLICT"
              ? []
              : [
                  {
                    label: this.engine.label("重试取消", "Retry removal"),
                    run: () => {
                      void this.removeAnnotation(record);
                    },
                  },
                ],
        },
      );
    } finally {
      this.saving = false;
    }
  };

  undoRemoval = async (record = this.removedRecords.at(-1)) => {
    if (!record || this.saving || this.draft || !this.engine.enabled() || record.pageUrl !== pageKey(location.href)) return;
    this.saving = true;
    try {
      const restored = await request<Annotation>({
        type: "annotations.restore",
        annotation: { ...record, updatedAt: new Date().toISOString() },
      });
      if (this.engine.disposed || record.pageUrl !== pageKey(location.href)) return;
      this.applyAnnotationDelta(restored, undefined, record.pageUrl);
      const index = this.removedRecords.lastIndexOf(record);
      if (index >= 0) this.removedRecords.splice(index, 1);
      this.notify(this.engine.label("已恢复标注", "Annotation restored"), {
        kind: "success",
      });
    } catch (error) {
      this.notify(
        this.engine.label("无法恢复：", "Could not restore: ") +
          (error instanceof Error ? error.message : String(error)),
        {
          kind: "error",
          sticky: true,
          actions: [
            {
              label: this.engine.label("重试恢复", "Retry restore"),
              run: () => {
                void this.undoRemoval(record);
              },
            },
          ],
        },
      );
    } finally {
      this.saving = false;
    }
  };

  baseRecord = (color: string) => {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      pageUrl: pageKey(location.href),
      pageTitle: document.title,
      color,
      note: "",
      tags: [],
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
  };

  commit = async (record: Annotation, track = false) => {
    if (this.saving) return;
    this.saving = true;
    this.draft = record;
    this.engine.toast(this.engine.label("正在保存…", "Saving…"));
    try {
      const stored = await request<Annotation>({
        type: "annotations.put",
        annotation: record,
        expectedRevision: record.revision,
      });
      this.recentColors.splice(
        0,
        this.recentColors.length,
        stored.color,
        ...this.recentColors.filter((color) => color !== stored.color).slice(0, 2),
      );
      this.draft = undefined;
      if (track && stored.kind === "image" && stored.pageUrl === pageKey(location.href)) {
        this.undo.push(stored);
        this.redo.length = 0;
      }
      this.engine.ui.rebinding = undefined;
      this.notify(this.engine.label("已保存到本机", "Saved on this device"), {
        kind: "success",
      });
      if (!this.engine.disposed && stored.pageUrl === pageKey(location.href))
        this.applyAnnotationDelta(stored, undefined, stored.pageUrl);
    } catch (error) {
      const reason =
        error instanceof RequestError && error.code === "PAGE_CHANGED"
          ? this.engine.label(
              "网页已切换，请回到原页面重试。",
              "The page changed. Return to the original page to retry.",
            )
          : error instanceof Error ? error.message : String(error);
      this.engine.toast(
        `${this.engine.label("保存失败，记录尚未落盘：", "Not saved: ")}${reason}`,
        true,
        () => {
          void this.commit(record, track);
        },
      );
    } finally {
      this.saving = false;
      this.schedulePaint();
    }
  };

  saveSelection = async (color: string, tags: string[] = [], range = this.engine.ui.selectedRange) => {
    if (!range || !this.engine.enabled() || this.saving || this.draft) return;
    try {
      // Mouseup captured this once for the palette. Reuse only if the session
      // can prove that no queued DOM change or range-boundary drift occurred.
      const target = this.textSession.captureSelected(range);
      const record: TextAnnotation =
        this.engine.ui.rebinding?.kind === "text"
          ? { ...this.engine.ui.rebinding, target, updatedAt: new Date().toISOString() }
          : { ...this.baseRecord(color), kind: "text", tags, target };
      this.engine.ui.hideSelection();
      window.getSelection()?.removeAllRanges();
      await this.commit(record);
    } catch (error) {
      this.engine.fail(error);
    }
  };

  annotateSelection = async (range: Range, color: string, isCurrent: () => boolean): Promise<TextAnnotation> => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw Error("Choose a six-digit HEX annotation color.");
    if (!this.engine.modeReady) await this.refresh();
    if (!isCurrent() || this.engine.disposed || pageKey(location.href) !== this.engine.currentUrl)
      throw Error("The page or selection changed. Select the text again.");
    if (!this.engine.enabled()) throw Error("Webpage annotations are paused or unavailable.");
    if (this.saving || this.draft || this.engine.ui.rebinding || this.engine.ui.mode !== "idle")
      throw Error("Finish the current annotation before saving this selection."); const target = this.textSession.captureSelected(range);
    if (!isCurrent()) throw Error("The selection changed. Select the text again.");
    const record: TextAnnotation = { ...this.baseRecord(color), kind: "text", target };
    this.saving = true;
    try {
      // Sidebar callers need the durable result or the original storage error.
      // The palette's commit() keeps its existing local-draft retry behavior.
      const stored = await request<TextAnnotation>({
        type: "annotations.put",
        annotation: record,
        expectedRevision: 0,
      });
      if (this.engine.disposed || !isCurrent() || stored.pageUrl !== this.engine.currentUrl) throw Error(
          "The annotation was saved, but the page or selection changed. Check the library before retrying.",
        );
      this.applyAnnotationDelta(stored, undefined, stored.pageUrl);
      this.engine.ui.hideSelection();
      return stored;
    } finally {
      this.saving = false;
    }
  };

  undoDrawing = async () => {
    if (this.saving || this.draft) return;
    const old = this.undo.at(-1);
    if (!old) return;
    try {
      await request({
        type: "annotations.delete",
        id: old.id,
        expectedRevision: old.revision,
      });
      this.undo.pop();
      this.redo.push(old);
      await this.refresh();
    } catch (error) {
      this.engine.fail(error);
    }
  };

  redoDrawing = async () => {
    if (this.saving || this.draft) return;
    const old = this.redo.at(-1);
    if (!old) return;
    try {
      const record = { ...old, updatedAt: new Date().toISOString() };
      const saved = await request<ImageAnnotation>({
        type: "annotations.restore",
        annotation: record,
      });
      this.redo.pop();
      this.undo.push(saved);
      await this.refresh();
    } catch (error) {
      this.engine.fail(error);
    }
  };
}
