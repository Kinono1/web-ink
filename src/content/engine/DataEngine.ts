import { request, RequestError } from "../../core/client";
import type {
  Annotation,
  AnchorState,
  ImageAnnotation,
  TextAnnotation,
} from "../../core/model";
import { resolveImage } from "../../core/image-anchor";
import { pageKey } from "../../core/url";
import { TextAnchorSession } from "../../core/text-anchor";
import { ImageLayerManager } from "../image-layers";
import type { NotificationOptions } from "../notifications";
import type { ContentView } from "../view-lite";
import { PageRefresh, type PageRefreshHost } from "./PageRefresh";

/** Host surface supplied by {@link AnnotationController}; the UI half is set after construction. */
export interface DataEngineHost extends PageRefreshHost {
  readonly view: ContentView;
  readonly ui: PageRefreshHost["ui"] & {
    selectedRange: Range | undefined;
    actionRecords: ReadonlyArray<TextAnnotation | ImageAnnotation>;
  };
  toast: (message: string, error?: boolean, retry?: () => void) => void;
  fail: (error: unknown) => void;
}

/**
 * Owns content data: annotation records and anchor states, DOM anchor caches and
 * coalesced painting, and confirmed writes.
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
  private focusId: string | undefined;

  private draft: Annotation | undefined;
  private removedRecords: Array<TextAnnotation | ImageAnnotation> = [];
  private saving: boolean = false;
  readonly recentColors: string[] = [];
  readonly sync: PageRefresh;

  constructor(private readonly engine: DataEngineHost) {
    this.imageLayers = new ImageLayerManager(this.engine.view.svg);
    this.sync = new PageRefresh(engine, this);
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
    this.appliedRevisions.get(record.id) === record.revision;

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
      this.removeDelta(deletedId);
    } else if (annotation) {
      if ((annotation.kind !== "text" && annotation.kind !== "image") ||
        annotation.pageUrl !== this.engine.currentUrl) return true;
      const { id, revision } = annotation;
      if ((this.appliedRevisions.get(id) ?? -1) >= revision ||
        (this.deletedRevisions.get(id) ?? -1) >= revision) return true;
      const index = this.records.findIndex(record => record.id === id);
      const previous = this.records[index];
      this.records = previous
        ? this.records.map(record => record.id === id ? annotation : record)
        : [...this.records, annotation];
      this.appliedRevisions.set(id, revision);
      this.deletedRevisions.delete(id);
      if (annotation.kind === "image" || previous?.kind !== "text" ||
        JSON.stringify(previous.target) !== JSON.stringify(annotation.target)) {
        this.dropAnchor(id);
        const supportsHighlight = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
        this.restoreAnchor(annotation, supportsHighlight);
      }
    }
    if (deletedId || annotation?.kind === "text") this.applyTextStyles();
    this.publishStates();
    this.schedulePaint();
    return true;
  };

  private removeDelta(id: string) {
    this.sync.restartAfterDelete();
    const revision = this.appliedRevisions.get(id);
    if (revision !== undefined)
      this.deletedRevisions.set(id, Math.max(this.deletedRevisions.get(id) ?? -1, revision));
    this.records = this.records.filter(record => record.id !== id);
    this.appliedRevisions.delete(id);
    this.dropAnchor(id);
    if (this.engine.ui.actionRecords.some(record => record.id === id)) this.engine.ui.hideSelection();
  }

  private dropAnchor(id: string) {
    this.textRanges.delete(id);
    this.images.delete(id);
    this.imageLayers.drop(id);
    this.anchorStates = this.anchorStates.filter(state => state.id !== id);
  }

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
    const validLayers = new Set<string>();
    for (const record of this.annotations)
      if (record.kind === "image") {
        validLayers.add(record.id);
        const image = this.images.get(record.id);
        if (image?.isConnected) this.imageLayers.draw(record, image, this.focusId);
        else this.imageLayers.hide(record.id);
      }
    if (this.unsaved?.kind === "image") {
      validLayers.add(`${this.unsaved.id}-unsaved`);
      const match = resolveImage(this.unsaved.target);
      if (match.image)
        this.imageLayers.draw(this.unsaved, match.image, this.focusId, "-unsaved");
    }
    this.imageLayers.reconcile(validLayers);
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

  clearAnchors = () => {
    this.clearText();
    this.images.clear();
    this.imageLayers.clear();
  };

  invalidateTextIndex = () => this.textSession.invalidate();

  get unsaved(): Annotation | undefined { return this.draft; }

  get pendingSave(): boolean { return this.saving; }

  get canUndoRemoval(): boolean { return this.removedRecords.length > 0; }

  discardDraft = () => { this.draft = undefined; };

  clearRemovalHistory = () => { this.removedRecords.length = 0; };

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
        void this.sync.refresh();
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

  commit = async (record: Annotation) => {
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
          void this.commit(record);
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
    if (!this.engine.modeReady) await this.sync.refresh();
    if (!isCurrent() || this.engine.disposed || pageKey(location.href) !== this.engine.currentUrl)
      throw Error("The page or selection changed. Select the text again.");
    if (!this.engine.enabled()) throw Error("Webpage annotations are paused or unavailable.");
    if (this.saving || this.draft || this.engine.ui.rebinding || this.engine.ui.mode !== "idle")
      throw Error("Finish the current annotation before saving this selection.");
    const target = this.textSession.captureSelected(range);
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
}
