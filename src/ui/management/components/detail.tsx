import { useEffect, useState } from "react";
import { COLORS, type Annotation } from "../../../core/model";
import { textLinkUrl } from "../../../core/text-link";
import { isPdf, kindFamily, localDate, excerptText, sourceName, Icon } from "../helpers";
import type { Draft } from "../types";
import { StatusLabel, problemOf } from "./meta";
import type { DetailProps } from "./types";

/** The library's reading view: where the quote came from, the quote itself,
 * your note, then everything else you marked on the same page. */
export function AnnotationDetail({ back, siblings = [], onSelect, ...props }: DetailProps & {
  back?: () => void; siblings?: Annotation[]; onSelect?: (id: string) => void;
}) {
  const { record, state, language, t, editing, draft, conflict } = props;
  const family = kindFamily(record.kind);
  return (
    <article className="annotation-detail" style={{ "--record-color": record.color } as React.CSSProperties}>
      {back ? <button className="back-button quiet" onClick={back}>
        <Icon name="chevron" />{t.library}</button> : null}
      <header className="detail-heading">
        <p className="row-meta">
          <span>{family === "pdf" ? t.pdf : family === "text" ? t.text : t.image}</span>
          <span>{isPdf(record) ? t.pageNumber(record.target.pageNumber) : new URL(record.pageUrl).host}</span>
          <time dateTime={record.updatedAt}>{localDate(record.updatedAt, language)}</time>
          <StatusLabel problem={problemOf(state)} t={t} />
        </p>
        <h2>{sourceName(record)}</h2>
      </header>
      {state?.status === "unresolved" ? (
        <p className="hint" role="status">
          {t.restoreExplanation}{record.kind === "text" ? t.rebindTextHint : t.rebindImageHint}
        </p>
      ) : null}
      {editing && draft ? <Editor {...props} draft={draft} conflict={conflict} /> : <>
        <blockquote className="detail-excerpt">{excerptText(record)}</blockquote>
        {record.note ? <p className="note">{record.note}</p> : null}
        {record.tags.length ? (
          <div className="tags">{record.tags.map((item) => <span key={item}>#{item}</span>)}</div>
        ) : null}
        <DetailActions {...props} />
      </>}
      {siblings.length ? (
        <section className="same-page" aria-label={t.samePage}>
          <h3>{t.samePage}<span className="count">{siblings.length}</span></h3>
          {siblings.map((sibling) => (
            <button key={sibling.id} className="sibling" onClick={() => onSelect?.(sibling.id)}
              style={{ "--record-color": sibling.color } as React.CSSProperties}>
              <span className="row-quote">{excerptText(sibling)}</span>
              {sibling.note ? <span className="row-note">{sibling.note}</span> : null}
            </button>
          ))}
        </section>
      ) : null}
    </article>
  );
}
/** One action vocabulary for both surfaces: quiet icon buttons, delete last. */
export function DetailActions({ record, state, t, compact, onEdit, onDelete, onFocus, onRebind, onOpenPdf }: DetailProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const originalContentUrl =
    record.kind === "text" ? textLinkUrl(record.target, record.pageUrl) : undefined;
  useEffect(() => { setConfirmDelete(false); }, [record.id]);
  return (
    <div className="detail-actions">
      {isPdf(record) ? (
        <button className="quiet" onClick={onOpenPdf}><Icon name="pdf" />{t.openPdf}</button>
      ) : compact ? (
        <button className="quiet" onClick={onFocus} disabled={state?.status === "unresolved"}>
          <Icon name="focus" />{t.focus}</button>
      ) : (
        <a className="quiet" href={record.pageUrl} target="_blank" rel="noreferrer">
          <Icon name="focus" />{t.source}</a>
      )}
      {originalContentUrl ? (
        <a className="quiet" href={originalContentUrl} target="_blank" rel="noopener noreferrer">
          {t.openOriginalContent}</a>
      ) : null}
      {state?.status === "unresolved" && compact
        ? <button className="quiet" onClick={onRebind}>{t.rebind}</button> : null}
      <button className="quiet" onClick={onEdit}><Icon name="note" />{t.note}</button>
      {confirmDelete ? (
        <span className="confirm-delete">
          <button className="danger" onClick={() => void onDelete().then((ok) => { if (ok) setConfirmDelete(false); })}>
            {t.confirmDelete}</button>
          <button className="quiet" onClick={() => setConfirmDelete(false)}>{t.cancel}</button>
        </span>
      ) : (
        <button className="quiet delete" onClick={() => setConfirmDelete(true)}>
          <Icon name="trash" />{t.delete}</button>
      )}
    </div>
  );
}
export function Editor({ draft, t, conflict, onDraft, onSave, onLoadLatest, onCancel, tagSuggestions }: DetailProps & {
  draft: Draft;
}) {
  const partialTag = draft.tags.split(",").at(-1)?.trim().toLocaleLowerCase() ?? "";
  const suggestions = partialTag
    ? tagSuggestions.filter((tag) => tag.toLocaleLowerCase().startsWith(partialTag) &&
        tag.toLocaleLowerCase() !== partialTag)
    : [];
  const chooseTag = (tag: string) => {
    const parts = draft.tags.split(",");
    parts[parts.length - 1] = ` ${tag}`;
    onDraft({ tags: parts.join(",").replace(/^\s+/, "") });
  };
  return (
    <div className="editor">
      <label>{t.note}
        <textarea autoFocus value={draft.note} maxLength={10_000}
          onChange={(event) => onDraft({ note: event.target.value })} />
      </label>
      <label>{t.tags}
        <input value={draft.tags} onChange={(event) => onDraft({ tags: event.target.value })} />
        {suggestions.length ? (
          <span className="tag-suggestions" aria-label={t.tagSuggestions}>
            <span>{t.tagSuggestions}</span>
            {suggestions.map((tag) => (
              <button key={tag} className="quiet" type="button" onClick={() => chooseTag(tag)}>{tag}</button>
            ))}
          </span>
        ) : null}
      </label>
      <ColorPicker value={draft.color} onChange={(color) => onDraft({ color })} label={t.color} />
      {conflict ? (
        <p className="draft-conflict">{t.conflict}{" "}
          <button className="quiet" onClick={onLoadLatest}>{t.loadLatest}</button>
        </p>
      ) : null}
      <div className="detail-actions">
        <button className="primary" onClick={onSave}>{t.save}</button>
        <button className="quiet" onClick={onCancel}>{t.cancel}</button>
      </div>
    </div>
  );
}
export function ColorPicker({ value, onChange, label = "Custom color" }: {
  value: string; onChange: (color: string) => void; label?: string;
}) {
  return (
    <span className="colors">
      {COLORS.map((color) => (
        <button key={color} type="button" className={value === color ? "active" : ""}
          onClick={() => onChange(color)} style={{ backgroundColor: color }} aria-label={color} title={color} />
      ))}
      <label className="custom-color">
        <span>{label}</span>
        <input type="color" value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} />
      </label>
    </span>
  );
}
