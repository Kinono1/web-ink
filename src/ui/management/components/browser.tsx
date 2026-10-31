import { useEffect } from "react";
import type { Annotation, AnchorState, Language } from "../../../core/model";
import { excerptText, sourceName } from "../helpers";
import { AnnotationDetail, DetailActions, Editor } from "./detail";
import { RecordFacts, problemOf } from "./meta";
import type { AnnotationBrowserState, Copy, DetailProps } from "./types";

type BrowserProps = {
  compact?: boolean; detailOpen?: boolean; onBack?: () => void;
  annotations: AnnotationBrowserState;
  /** The library opens a detail pane; the side panel keeps the list in place. */
  setSelectedId?: (id: string) => void;
  states: Record<string, AnchorState>; language: Language; t: Copy;
  onFocus?: (record: Annotation) => void; onRebind?: (record: Annotation) => void;
  onOpenPdf: (record?: Annotation) => void;
};

export function AnnotationBrowser({ compact = false, detailOpen = false, onBack, annotations,
  setSelectedId: selectId, states, language, t, onFocus, onRebind, onOpenPdf }: BrowserProps) {
  const { records, selectedId, setSelectedId, editing, drafts, conflicts, setEditing,
    startEdit, updateDraft, saveRecord, loadLatest, removeRecord } = annotations;
  const select = selectId ?? setSelectedId;
  const selected = records.find((record) => record.id === selectedId);
  useEffect(() => {
    if (!compact && detailOpen && !selected) onBack?.();
  }, [compact, detailOpen, onBack, selected]);
  const tagSuggestions = [...new Set(records.flatMap((item) => item.tags))].sort();
  const detailProps = (record: Annotation): DetailProps => ({
    record, state: states[record.id], language, t, compact,
    draft: drafts[record.id], editing: editing === record.id, conflict: Boolean(conflicts[record.id]),
    onEdit: () => startEdit(record), onDraft: (patch) => updateDraft(record.id, patch),
    onSave: () => saveRecord(record.id), onLoadLatest: () => loadLatest(record.id),
    onCancel: () => setEditing(undefined), onDelete: () => removeRecord(record),
    onFocus: () => onFocus?.(record), onRebind: () => onRebind?.(record),
    onOpenPdf: () => onOpenPdf(record), tagSuggestions,
  });
  // The side panel opens the selected annotation in place; the library keeps
  // a list beside a detail pane.
  if (compact)
    return (
      <section className="annotation-browser compact">
        <div className="annotation-list" aria-label={t.pageAnnotations}>
          {records.map((record) => (
            <AnnotationItem key={record.id} {...detailProps(record)}
              open={record.id === selected?.id} onSelect={() => select(record.id)} />
          ))}
        </div>
      </section>
    );
  return (
    <section className={detailOpen ? "annotation-browser detail-open" : "annotation-browser"}>
      <div className="annotation-list" aria-label={t.library}>
        {records.map((record) => (
          <AnnotationRow key={record.id} record={record} selected={selected?.id === record.id}
            state={states[record.id]} language={language} t={t} onSelect={() => select(record.id)} />
        ))}
      </div>
      {selected ? (
        <AnnotationDetail {...detailProps(selected)} back={onBack} onSelect={select}
          siblings={records.filter((record) => record.pageUrl === selected.pageUrl && record.id !== selected.id)} />
      ) : null}
    </section>
  );
}
/** A library row: the quote first, then the note and one quiet line of facts. */
export function AnnotationRow({ record, selected, state, language, t, onSelect }: {
  record: Annotation; selected: boolean; state?: AnchorState;
  language: Language; t: Copy; onSelect: () => void;
}) {
  return (
    <button className={selected ? "annotation-row selected" : "annotation-row"}
      aria-current={selected || undefined} onClick={onSelect}
      style={{ "--record-color": record.color } as React.CSSProperties}>
      <span className="annotation-row-content">
        <span className="row-quote">{excerptText(record)}</span>
        {record.note ? <span className="row-note">{record.note}</span> : null}
        <span className="row-meta">
          <span className="row-source">{sourceName(record)}</span>
          <RecordFacts record={record} state={state} language={language} t={t} />
        </span>
      </span>
    </button>
  );
}
/**
 * One side-panel annotation. Closed it is a single row; open, the same row
 * grows into the detail card so focus and reading position stay put.
 */
function AnnotationItem({ open, onSelect, ...props }: DetailProps & { open: boolean; onSelect: () => void }) {
  const { record, state, language, t, editing, draft, conflict } = props;
  const editDraft = open && editing ? draft : undefined;
  return (
    <div className={open ? "annotation-item open annotation-detail" : "annotation-item"}
      style={{ "--record-color": record.color } as React.CSSProperties}>
      <button className={open ? "annotation-row selected" : "annotation-row"}
        aria-expanded={open} onClick={onSelect}>
        <span className="row-quote">{excerptText(record)}</span>
        {record.note && !editDraft ? <span className="note">{record.note}</span> : null}
        <span className="row-meta">
          <RecordFacts record={record} state={state} language={language} t={t} />
        </span>
      </button>
      {open ? (
        <div className="item-body">
          {problemOf(state) && state?.status === "unresolved" ? (
            <p className="hint" role="status">
              {t.restoreExplanation}{record.kind === "text" ? t.rebindTextHint : t.rebindImageHint}
            </p>
          ) : null}
          {editDraft
            ? <Editor {...props} draft={editDraft} conflict={conflict} />
            : <DetailActions {...props} />}
        </div>
      ) : null}
    </div>
  );
}
