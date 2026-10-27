import { request, RequestError } from "../../core/client";
import type { Annotation, ImageAnnotation, TextAnnotation } from "../../core/model";
import { pageKey } from "../../core/url";
import type { AnnotationController } from "./AnnotationController";

type SaveCoordinatorContext = Pick<
  AnnotationController,
  | "currentUrl"
  | "disposed"
  | "enabled"
  | "fail"
  | "interactions"
  | "label"
  | "mode"
  | "modeReady"
  | "notifications"
  | "render"
  | "store"
  | "sync"
  | "toast"
>;

/** Owns explicit confirmed writes, failed drafts, and removal/drawing history. */
export class SaveCoordinator {
  private draft: Annotation | undefined;
  private removedRecords: Array<TextAnnotation | ImageAnnotation> = [];
  private undo: ImageAnnotation[] = [];
  private redo: ImageAnnotation[] = [];
  private saving: boolean = false;
  readonly recentColors: string[] = [];

  constructor(private readonly engine: SaveCoordinatorContext) {}

  get unsaved(): Annotation | undefined {
    return this.draft;
  }

  get pendingSave(): boolean {
    return this.saving;
  }

  get canUndoRemoval(): boolean {
    return this.removedRecords.length > 0;
  }

  discardDraft = () => {
    this.draft = undefined;
  };

  resetHistory = () => {
    this.undo.length = 0;
    this.redo.length = 0;
    this.removedRecords.length = 0;
  };

  removeAnnotation = async (record: TextAnnotation | ImageAnnotation) => {
    const { enabled, store, interactions, notifications, label, sync } = this.engine;
    if (!enabled() || this.saving || this.draft) return;
    this.saving = true;
    try {
      await request({
        type: "annotations.delete",
        id: record.id,
        expectedRevision: record.revision,
      });
      if (this.engine.disposed || record.pageUrl !== pageKey(location.href)) return;
      store.applyAnnotationDelta(undefined, record.id, record.pageUrl);
      interactions.hideSelection();
      getSelection()?.removeAllRanges();
      this.removedRecords.push(record);
      if (this.removedRecords.length > 20) this.removedRecords.shift();
      notifications.show(label("已取消标注", "Annotation removed"), {
        kind: "success",
        sticky: true,
        dismissLabel: label("关闭提示", "Dismiss"),
        actions: [
          {
            label: label("撤销取消", "Undo removal"),
            run: () => {
              void this.undoRemoval(record);
            },
          },
        ],
      });
    } catch (error) {
      if (error instanceof RequestError && error.code === "CONFLICT") {
        interactions.hideSelection();
        void sync.refresh();
      }
      notifications.show(
        label("取消失败：", "Could not remove: ") +
          (error instanceof Error ? error.message : String(error)),
        {
          kind: "error",
          sticky: true,
          dismissLabel: label("关闭提示", "Dismiss"),
          actions:
            error instanceof RequestError && error.code === "CONFLICT"
              ? []
              : [
                  {
                    label: label("重试取消", "Retry removal"),
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
    const { enabled, store, notifications, label } = this.engine;
    if (
      !record ||
      this.saving ||
      this.draft ||
      !enabled() ||
      record.pageUrl !== pageKey(location.href)
    )
      return;
    this.saving = true;
    try {
      const restored = await request<Annotation>({
        type: "annotations.restore",
        annotation: { ...record, updatedAt: new Date().toISOString() },
      });
      if (this.engine.disposed || record.pageUrl !== pageKey(location.href)) return;
      store.applyAnnotationDelta(restored, undefined, record.pageUrl);
      const index = this.removedRecords.lastIndexOf(record);
      if (index >= 0) this.removedRecords.splice(index, 1);
      notifications.show(label("已恢复标注", "Annotation restored"), {
        kind: "success",
        dismissLabel: label("关闭提示", "Dismiss"),
      });
    } catch (error) {
      notifications.show(
        label("无法恢复：", "Could not restore: ") +
          (error instanceof Error ? error.message : String(error)),
        {
          kind: "error",
          sticky: true,
          dismissLabel: label("关闭提示", "Dismiss"),
          actions: [
            {
              label: label("重试恢复", "Retry restore"),
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
    const { toast, label, mode, notifications, store, render } = this.engine;
    if (this.saving) return;
    this.saving = true;
    this.draft = record;
    toast(label("正在保存…", "Saving…"));
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
      if (
        track &&
        stored.kind === "image" &&
        stored.pageUrl === pageKey(location.href)
      ) {
        this.undo.push(stored);
        this.redo.length = 0;
      }
      mode.rebinding = undefined;
      notifications.show(label("已保存到本机", "Saved on this device"), {
        kind: "success",
        dismissLabel: label("关闭提示", "Dismiss"),
      });
      if (!this.engine.disposed && stored.pageUrl === pageKey(location.href))
        store.applyAnnotationDelta(stored, undefined, stored.pageUrl);
    } catch (error) {
      const reason =
        error instanceof RequestError && error.code === "PAGE_CHANGED"
          ? label(
              "网页已切换，请回到原页面重试。",
              "The page changed. Return to the original page to retry.",
            )
          : error instanceof Error
            ? error.message
            : String(error);
      toast(
        `${label("保存失败，记录尚未落盘：", "Not saved: ")}${reason}`,
        true,
        () => {
          void this.commit(record, track);
        },
      );
    } finally {
      this.saving = false;
      render.schedulePaint();
    }
  };

  saveSelection = async (
    color: string,
    tags: string[] = [],
    range = this.engine.interactions.selectedRange,
  ) => {
    const { enabled, render, mode, interactions, fail } = this.engine;
    if (!range || !enabled() || this.saving || this.draft) return;
    try {
      // Mouseup captured this once for the palette. Reuse only if the session
      // can prove that no queued DOM change or range-boundary drift occurred.
      const target = render.textSession.captureSelected(range);
      const record: TextAnnotation =
        mode.rebinding?.kind === "text"
          ? { ...mode.rebinding, target, updatedAt: new Date().toISOString() }
          : { ...this.baseRecord(color), kind: "text", tags, target };
      interactions.hideSelection();
      window.getSelection()?.removeAllRanges();
      await this.commit(record);
    } catch (error) {
      fail(error);
    }
  };

  annotateSelection = async (
    range: Range,
    color: string,
    isCurrent: () => boolean,
  ): Promise<TextAnnotation> => {
    const { sync, enabled, mode, render, store, interactions } = this.engine;
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw Error("Choose a six-digit HEX annotation color.");
    if (!this.engine.modeReady) await sync.refresh();
    if (!isCurrent() || this.engine.disposed || pageKey(location.href) !== this.engine.currentUrl)
      throw Error("The page or selection changed. Select the text again.");
    if (!enabled()) throw Error("Webpage annotations are paused or unavailable.");
    if (this.saving || this.draft || mode.rebinding || mode.mode !== "idle")
      throw Error("Finish the current annotation before saving this selection.");
    const target = render.textSession.captureSelected(range);
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
      if (this.engine.disposed || !isCurrent() || stored.pageUrl !== this.engine.currentUrl)
        throw Error(
          "The annotation was saved, but the page or selection changed. Check the library before retrying.",
        );
      store.applyAnnotationDelta(stored, undefined, stored.pageUrl);
      interactions.hideSelection();
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
      await this.engine.sync.refresh();
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
      await this.engine.sync.refresh();
    } catch (error) {
      this.engine.fail(error);
    }
  };
}
