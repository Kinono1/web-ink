import { request } from "../../core/client";
import type { Annotation, AnchorState } from "../../core/model";
import { resolveImage } from "../../core/image-anchor";
import type { AnnotationController } from "./AnnotationController";

type AnnotationStoreContext = Pick<
  AnnotationController,
  | "currentUrl"
  | "enabled"
  | "events"
  | "interactions"
  | "render"
  | "sync"
>;

/** Owns records, anchor states, and revision/tombstone reconciliation. */
export class AnnotationStore {
  private records: Annotation[] = [];
  private anchorStates: AnchorState[] = [];
  private appliedRevisions: Map<string, number> = new Map<string, number>();
  private deletedRevisions: Map<string, number> = new Map<string, number>();

  constructor(private readonly engine: AnnotationStoreContext) {}

  get annotations(): Annotation[] {
    return this.records;
  }

  get states(): AnchorState[] {
    return this.anchorStates;
  }

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
    const { render, events } = this.engine;
    if (record.kind === "text") {
      if (!supportsHighlight)
        this.anchorStates.push({
          id: record.id,
          status: "unsupported",
          reason: "CSS Custom Highlight is unavailable",
        });
      else {
        const match = render.textSession.resolve(record.target);
        this.anchorStates.push({
          id: record.id,
          status: match.status,
          reason: match.reason,
        });
        if (match.range) {
          render.textRanges.set(record.id, match.range);
        }
      }
    } else if (record.kind === "image") {
      const match = resolveImage(record.target);
      this.anchorStates.push({
        id: record.id,
        status: match.status,
        reason: match.reason,
      });
      if (match.image) {
        render.images.set(record.id, match.image);
        events.resizeObserver.observe(match.image);
      }
    }
  };

  applyAnnotationDelta = (annotation?: Annotation, deletedId?: string, pageUrl?: string): boolean => {
    const { enabled, sync, render, interactions, events } = this.engine;
    if (!enabled() || (pageUrl && pageUrl !== this.engine.currentUrl)) return true;
    if (!annotation && !deletedId) return false;
    if (deletedId) {
      if (sync.refreshDepth) {
        sync.generation++;
        sync.queueRefresh();
      }
      const deleted = this.records.find((record) => record.id === deletedId);
      const known = this.appliedRevisions.get(deletedId) ?? deleted?.revision;
      if (known !== undefined)
        this.deletedRevisions.set(
          deletedId,
          Math.max(this.deletedRevisions.get(deletedId) ?? -1, known),
        );
      this.records = this.records.filter((record) => record.id !== deletedId);
      render.textRanges.delete(deletedId);
      render.images.delete(deletedId);
      this.appliedRevisions.delete(deletedId);
      this.anchorStates = this.anchorStates.filter((state) => state.id !== deletedId);
      if (interactions.actionRecords.some((record) => record.id === deletedId))
        interactions.hideSelection();
      render.imageLayers.drop(deletedId);
      render.applyTextStyles();
      this.publishStates();
      render.schedulePaint();
      return true;
    }
    if (
      !annotation ||
      (annotation.kind !== "text" && annotation.kind !== "image") ||
      annotation.pageUrl !== this.engine.currentUrl
    )
      return true;
    const known = this.appliedRevisions.get(annotation.id);
    if (known !== undefined && known >= annotation.revision) return true;
    if ((this.deletedRevisions.get(annotation.id) ?? -1) >= annotation.revision)
      return true;
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
        const match = render.textSession.resolve(annotation.target);
        render.textRanges.delete(annotation.id);
        this.anchorStates = this.anchorStates.filter((state) => state.id !== annotation!.id);
        this.anchorStates.push({
          id: annotation.id,
          status: match.status,
          reason: match.reason,
        });
        if (match.range) render.textRanges.set(annotation.id, match.range);
      }
      render.applyTextStyles();
    } else {
      const match = resolveImage(annotation.target);
      render.images.delete(annotation.id);
      render.imageLayers.drop(annotation.id);
      this.anchorStates = this.anchorStates.filter((state) => state.id !== annotation!.id);
      this.anchorStates.push({
        id: annotation.id,
        status: match.status,
        reason: match.reason,
      });
      if (match.image) {
        render.images.set(annotation.id, match.image);
        events.resizeObserver.observe(match.image);
      }
    }
    this.publishStates();
    render.schedulePaint();
    return true;
  };

  publishStates = () => {
    void request({ type: "page.states", states: this.anchorStates, pageUrl: this.engine.currentUrl }).catch(
      () => undefined,
    );
  };
}
