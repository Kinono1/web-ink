import type { Annotation, AnchorState, Language } from "../../../core/model";
import type { useAnnotationSync } from "../../hooks/useAnnotationSync";
import type { COPY } from "../copy";
import type { Draft } from "../types";

export type Copy = (typeof COPY)[Language];

export type DetailProps = {
  record: Annotation;
  state?: AnchorState;
  language: Language;
  t: Copy;
  compact: boolean;
  draft?: Draft;
  editing: boolean;
  conflict: boolean;
  onEdit: () => void;
  onDraft: (patch: Pick<Partial<Draft>, "note" | "tags" | "color">) => void;
  onSave: () => void;
  onLoadLatest: () => void;
  onCancel: () => void;
  onDelete: () => Promise<boolean>;
  onFocus: () => void;
  onRebind: () => void;
  onOpenPdf: () => void;
  tagSuggestions: string[];
};

/** The record state a browser renders and edits; screens only pass it through. */
export type AnnotationBrowserState = ReturnType<typeof useAnnotationSync>;
