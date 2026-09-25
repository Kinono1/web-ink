import { useState, useEffect } from "react";
import { COLORS, type Annotation, type AnchorState, type Language, type Settings, type ImportPreview } from "../../core/model";
import type { FilterKind, Draft } from "./types";
import { COPY } from "./copy";
import { statusClass, isPdf, kindFamily, localDate, shortDate, excerptText, sourceName, Icon } from "./helpers";
import { StoragePanel } from "../StoragePanel";
import { BuildInfo } from "../BuildInfo";
import type { IconName } from "../icons";
export function Alert({
  kind,
  text,
  close,
  closeLabel,
}: {
  kind: "error" | "notice";
  text: string;
  close: () => void;
  closeLabel: string;
}) {
  return (
    <p className={`alert ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {text}
      <button onClick={close} aria-label={closeLabel}>
        <Icon name="close" />
      </button>
    </p>
  );
}
export function Empty({
  title,
  text,
  action,
  icon,
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
  icon?: IconName;
}) {
  return (
    <section className="empty">
      {icon ? <span className="empty-icon" aria-hidden="true"><Icon name={icon} /></span> : null}
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
      {action ? <div>{action}</div> : null}
    </section>
  );
}
export function PageHeader({
  title,
  host,
  enabled,
  onToggle,
  toggleLabel,
  disabled = false,
}: {
  title: string;
  host?: string;
  enabled: boolean;
  onToggle: () => void;
  toggleLabel: string;
  disabled?: boolean;
}) {
  return (
    <section className="page-header">
      <strong title={title}>{title}</strong>
      <div className="page-context">
        {host ? <span>{host}</span> : null}
      <button
        className={enabled ? "page-switch on" : "page-switch"}
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={onToggle}
      >
        <span aria-hidden="true" />
        {toggleLabel}
      </button>
      </div>
    </section>
  );
}
export function FilterPopover({
  language,
  t,
  kind,
  color,
  tag,
  records,
  setKind,
  setColor,
  setTag,
  clear,
}: {
  language: Language;
  t: (typeof COPY)[Language];
  kind: FilterKind;
  color: string;
  tag: string;
  records: Annotation[];
  setKind: (value: FilterKind) => void;
  setColor: (value: string) => void;
  setTag: (value: string) => void;
  clear: () => void;
}) {
  const colors = [...new Set(records.map((record) => record.color))].sort();
  const tags = [...new Set(records.flatMap((record) => record.tags))].sort();
  return (
    <section className="filter-popover" aria-label={t.filter}>
      <div className="filter-kinds" role="group" aria-label={t.filter}>
        {(["all", "text", "image", "pdf-text", "pdf-area"] as const).map(
          (value) => (
            <button
              key={value}
              className={kind === value ? "selected" : ""}
              onClick={() => setKind(value)}
            >
              {value === "all"
                ? t.all
                : value === "pdf-text"
                  ? t.pdfText
                  : value === "pdf-area"
                    ? t.pdfArea
                    : value === "text"
                      ? t.text
                      : t.image}
            </button>
          ),
        )}
      </div>
      <label>
        {t.color}
        <select
          value={color}
          onChange={(event) => setColor(event.target.value)}
        >
          <option value="">{t.all}</option>
          {colors.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.tag}
        <select value={tag} onChange={(event) => setTag(event.target.value)}>
          <option value="">{t.all}</option>
          {tags.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <button className="quiet" onClick={clear}>
        {t.clearFilters}
      </button>
    </section>
  );
}
type BrowserProps = {
  compact?: boolean;
  detailOpen?: boolean;
  onBack?: () => void;
  records: Annotation[];
  selectedId?: string;
  setSelectedId: (id: string) => void;
  states: Record<string, AnchorState>;
  language: Language;
  t: (typeof COPY)[Language];
  editing?: string;
  drafts: Record<string, Draft>;
  conflicts: Record<string, true>;
  onEdit: (record: Annotation) => void;
  onDraft: (
    id: string,
    patch: Pick<Partial<Draft>, "note" | "tags" | "color">,
  ) => void;
  onSave: (id: string) => void;
  onLoadLatest: (id: string) => void;
  onCancel: () => void;
  onDelete: (record: Annotation) => Promise<boolean>;
  onFocus: (record: Annotation) => void;
  onRebind: (record: Annotation) => void;
  onDraw: (record: Annotation) => void;
  onOpenPdf: (record?: Annotation) => void;
};
export function AnnotationBrowser({
  compact = false,
  detailOpen = false,
  onBack,
  records,
  selectedId,
  setSelectedId,
  states,
  language,
  t,
  editing,
  drafts,
  conflicts,
  onEdit,
  onDraft,
  onSave,
  onLoadLatest,
  onCancel,
  onDelete,
  onFocus,
  onRebind,
  onDraw,
  onOpenPdf,
}: BrowserProps) {
  const selected =
    records.find((record) => record.id === selectedId) ?? records[0];
  const detailProps = (record: Annotation): DetailProps => ({
    record,
    state: states[record.id],
    language,
    t,
    compact,
    draft: drafts[record.id],
    editing: editing === record.id,
    conflict: Boolean(conflicts[record.id]),
    onEdit: () => onEdit(record),
    onDraft: (patch) => onDraft(record.id, patch),
    onSave: () => onSave(record.id),
    onLoadLatest: () => onLoadLatest(record.id),
    onCancel,
    onDelete: () => onDelete(record),
    onFocus: () => onFocus(record),
    onRebind: () => onRebind(record),
    onDraw: () => onDraw(record),
    onOpenPdf: () => onOpenPdf(record),
  });
  // The side panel opens the selected annotation in place; the library keeps
  // a list beside a detail pane.
  if (compact)
    return (
      <section className="annotation-browser compact">
        <div className="annotation-list" aria-label={t.pageAnnotations}>
          {records.map((record) => (
            <AnnotationItem
              key={record.id}
              {...detailProps(record)}
              open={record.id === selected?.id}
              onSelect={() => setSelectedId(record.id)}
            />
          ))}
        </div>
      </section>
    );
  return (
    <section
      className={
        detailOpen ? "annotation-browser detail-open" : "annotation-browser"
      }
    >
      <div className="annotation-list" aria-label={t.library}>
        {records.map((record) => (
          <AnnotationRow
            key={record.id}
            record={record}
            selected={selected?.id === record.id}
            state={states[record.id]}
            language={language}
            t={t}
            onSelect={() => setSelectedId(record.id)}
          />
        ))}
      </div>
      {selected ? (
        <AnnotationDetail
          {...detailProps(selected)}
          back={onBack}
          siblings={records.filter(
            (record) =>
              record.pageUrl === selected.pageUrl && record.id !== selected.id,
          )}
          onSelect={setSelectedId}
        />
      ) : null}
    </section>
  );
}
type DetailProps = {
  record: Annotation;
  state?: AnchorState;
  language: Language;
  t: (typeof COPY)[Language];
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
  onDraw: () => void;
  onOpenPdf: () => void;
};
const statusKey = (status: AnchorState["status"]) =>
  status === "located"
    ? "located"
    : status === "pending"
      ? "pending"
      : status === "unresolved"
        ? "unresolved"
        : "unsupportedStatus";
/** A library row: the quote first, then the note and one quiet line of facts. */
export function AnnotationRow({
  record,
  selected,
  state,
  language,
  t,
  onSelect,
}: {
  record: Annotation;
  selected: boolean;
  state?: AnchorState;
  language: Language;
  t: (typeof COPY)[Language];
  onSelect: () => void;
}) {
  const family = kindFamily(record.kind);
  const problem =
    state?.status === "unresolved" || state?.status === "unsupported"
      ? state
      : undefined;
  return (
    <button
      className={selected ? "annotation-row selected" : "annotation-row"}
      aria-current={selected || undefined}
      onClick={onSelect}
      style={{ "--record-color": record.color } as React.CSSProperties}
    >
      <span className="row-quote">{excerptText(record)}</span>
      {record.note ? <span className="row-note">{record.note}</span> : null}
      <span className="row-meta">
        <span className="row-source">{sourceName(record)}</span>
        {family !== "text" ? (
          <span>{family === "image" ? t.image : t.pdf}</span>
        ) : null}
        <time
          dateTime={record.updatedAt}
          title={localDate(record.updatedAt, language)}
        >
          {shortDate(record.updatedAt, language)}
        </time>
        {record.tags.length ? (
          <span className="row-tags">
            {record.tags.map((tag) => `#${tag}`).join(" ")}
          </span>
        ) : null}
        {problem ? (
          <span className={statusClass(problem.status)} title={problem.reason}>
            {t[statusKey(problem.status)]}
          </span>
        ) : null}
      </span>
    </button>
  );
}
/**
 * One side-panel annotation. Closed it is a single row; open, the same row
 * grows into the detail card so focus and reading position stay put.
 */
function AnnotationItem({
  open,
  onSelect,
  ...props
}: DetailProps & { open: boolean; onSelect: () => void }) {
  const { record, state, language, t, editing, draft, conflict } = props;
  const family = kindFamily(record.kind);
  const problem =
    state?.status === "unresolved" || state?.status === "unsupported"
      ? state
      : undefined;
  const editDraft = open && editing ? draft : undefined;
  return (
    <div
      className={open ? "annotation-item open annotation-detail" : "annotation-item"}
      style={{ "--record-color": record.color } as React.CSSProperties}
    >
      <button
        className={open ? "annotation-row selected" : "annotation-row"}
        aria-expanded={open}
        onClick={onSelect}
      >
        <span className="row-quote">{excerptText(record)}</span>
        {record.note && !editDraft ? (
          <span className="note">{record.note}</span>
        ) : null}
        <span className="row-meta">
          {family !== "text" ? (
            <span>{family === "image" ? t.image : t.pdf}</span>
          ) : null}
          <time
            dateTime={record.updatedAt}
            title={localDate(record.updatedAt, language)}
          >
            {shortDate(record.updatedAt, language)}
          </time>
          {record.tags.length ? (
            <span className="row-tags">
              {record.tags.map((tag) => `#${tag}`).join(" ")}
            </span>
          ) : null}
          {problem ? (
            <span className={statusClass(problem.status)} title={problem.reason}>
              {t[statusKey(problem.status)]}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="item-body">
          {state?.status === "unresolved" ? (
            <p className="hint" role="status">
              {t.restoreExplanation}
              {record.kind === "text" ? t.rebindTextHint : t.rebindImageHint}
            </p>
          ) : null}
          {editDraft ? (
            <Editor
              draft={editDraft}
              t={t}
              conflict={conflict}
              onDraft={props.onDraft}
              onSave={props.onSave}
              onLoadLatest={props.onLoadLatest}
              onCancel={props.onCancel}
            />
          ) : (
            <DetailActions {...props} />
          )}
        </div>
      ) : null}
    </div>
  );
}
/**
 * The library's reading view: where the quote came from, the quote itself,
 * your note, then everything else you marked on the same page.
 */
export function AnnotationDetail({
  back,
  siblings = [],
  onSelect,
  ...props
}: DetailProps & {
  back?: () => void;
  siblings?: Annotation[];
  onSelect?: (id: string) => void;
}) {
  const { record, state, language, t, editing, draft, conflict } = props;
  const family = kindFamily(record.kind);
  const problem =
    state?.status === "unresolved" || state?.status === "unsupported"
      ? state
      : undefined;
  return (
    <article
      className="annotation-detail"
      style={{ "--record-color": record.color } as React.CSSProperties}
    >
      {back ? (
        <button className="back-button quiet" onClick={back}>
          <Icon name="chevron" />
          {t.library}
        </button>
      ) : null}
      <header className="detail-heading">
        <p className="row-meta">
          <span>
            {family === "pdf" ? t.pdf : family === "text" ? t.text : t.image}
          </span>
          <span>
            {isPdf(record)
              ? t.pageNumber(record.target.pageNumber)
              : new URL(record.pageUrl).host}
          </span>
          <time dateTime={record.updatedAt}>
            {localDate(record.updatedAt, language)}
          </time>
          {problem ? (
            <span className={statusClass(problem.status)} title={problem.reason}>
              {t[statusKey(problem.status)]}
            </span>
          ) : null}
        </p>
        <h2>{sourceName(record)}</h2>
      </header>
      {state?.status === "unresolved" ? (
        <p className="hint" role="status">
          {t.restoreExplanation}
          {record.kind === "text" ? t.rebindTextHint : t.rebindImageHint}
        </p>
      ) : null}
      {editing && draft ? (
        <Editor
          draft={draft}
          t={t}
          conflict={conflict}
          onDraft={props.onDraft}
          onSave={props.onSave}
          onLoadLatest={props.onLoadLatest}
          onCancel={props.onCancel}
        />
      ) : (
        <>
          <blockquote className="detail-excerpt">{excerptText(record)}</blockquote>
          {record.note ? <p className="note">{record.note}</p> : null}
          {record.tags.length ? (
            <div className="tags">
              {record.tags.map((item) => (
                <span key={item}>#{item}</span>
              ))}
            </div>
          ) : null}
          <DetailActions {...props} />
        </>
      )}
      {siblings.length ? (
        <section className="same-page" aria-label={t.samePage}>
          <h3>
            {t.samePage}
            <span className="count">{siblings.length}</span>
          </h3>
          {siblings.map((sibling) => (
            <button
              key={sibling.id}
              className="sibling"
              onClick={() => onSelect?.(sibling.id)}
              style={{ "--record-color": sibling.color } as React.CSSProperties}
            >
              <span className="row-quote">{excerptText(sibling)}</span>
              {sibling.note ? (
                <span className="row-note">{sibling.note}</span>
              ) : null}
            </button>
          ))}
        </section>
      ) : null}
    </article>
  );
}
/** One action vocabulary for both surfaces: quiet icon buttons, delete last. */
function DetailActions({
  record,
  state,
  t,
  compact,
  onEdit,
  onDelete,
  onFocus,
  onRebind,
  onDraw,
  onOpenPdf,
}: DetailProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setConfirmDelete(false);
  }, [record.id]);
  return (
    <div className="detail-actions">
      {isPdf(record) ? (
        <button className="quiet" onClick={onOpenPdf}>
          <Icon name="pdf" />
          {t.openPdf}
        </button>
      ) : compact ? (
        <button className="quiet" onClick={onFocus}>
          <Icon name="focus" />
          {t.focus}
        </button>
      ) : (
        <a className="quiet" href={record.pageUrl} target="_blank" rel="noreferrer">
          <Icon name="focus" />
          {t.source}
        </a>
      )}
      {state?.status === "unresolved" && compact ? (
        <button className="quiet" onClick={onRebind}>
          {t.rebind}
        </button>
      ) : null}
      {record.kind === "image" && compact ? (
        <button className="quiet" onClick={onDraw}>
          <Icon name="draw" />
          {t.draw}
        </button>
      ) : null}
      <button className="quiet" onClick={onEdit}>
        <Icon name="note" />
        {t.note}
      </button>
      {confirmDelete ? (
        <span className="confirm-delete">
          <button
            className="danger"
            onClick={() =>
              void onDelete().then((ok) => {
                if (ok) setConfirmDelete(false);
              })
            }
          >
            {t.confirmDelete}
          </button>
          <button className="quiet" onClick={() => setConfirmDelete(false)}>
            {t.cancel}
          </button>
        </span>
      ) : (
        <button className="quiet delete" onClick={() => setConfirmDelete(true)}>
          <Icon name="trash" />
          {t.delete}
        </button>
      )}
    </div>
  );
}
export function Editor({
  draft,
  t,
  conflict,
  onDraft,
  onSave,
  onLoadLatest,
  onCancel,
}: {
  draft: Draft;
  t: (typeof COPY)[Language];
  conflict: boolean;
  onDraft: (patch: Pick<Partial<Draft>, "note" | "tags" | "color">) => void;
  onSave: () => void;
  onLoadLatest: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="editor">
      <label>
        {t.note}
        <textarea
          value={draft.note}
          onChange={(event) => onDraft({ note: event.target.value })}
          maxLength={10_000}
        />
      </label>
      <label>
        {t.tags}
        <input
          value={draft.tags}
          onChange={(event) => onDraft({ tags: event.target.value })}
        />
      </label>
      <ColorPicker
        value={draft.color}
        onChange={(color) => onDraft({ color })}
        label={t.color}
      />
      {conflict ? (
        <p className="draft-conflict">
          {t.conflict}{" "}
          <button className="quiet" onClick={onLoadLatest}>
            {t.loadLatest}
          </button>
        </p>
      ) : null}
      <div className="detail-actions">
        <button className="primary" onClick={onSave}>
          {t.save}
        </button>
        <button className="quiet" onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </div>
  );
}
export function ColorPicker({
  value,
  onChange,
  label = "Custom color",
}: {
  value: string;
  onChange: (color: string) => void;
  label?: string;
}) {
  return (
    <span className="colors">
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={value === color ? "active" : ""}
          onClick={() => onChange(color)}
          style={{ backgroundColor: color }}
          aria-label={color}
          title={color}
        />
      ))}
      <label className="custom-color">
        <span>{label}</span>
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
        />
      </label>
    </span>
  );
}
export function SettingsView({
  settings,
  t,
  language,
  saveSettings,
  exportJson,
  exportMarkdown,
  readImport,
  preview,
  overwrite,
  setOverwrite,
  busyImport,
  importBackup,
}: {
  settings: Settings;
  t: (typeof COPY)[Language];
  language: Language;
  saveSettings: (patch: Partial<Settings>) => void;
  exportJson: () => void;
  exportMarkdown: () => void;
  readImport: (file: File | undefined) => void;
  preview?: ImportPreview;
  overwrite: boolean;
  setOverwrite: (value: boolean) => void;
  busyImport: boolean;
  importBackup: () => void;
}) {
  return (
    <section className="settings-view">
      <section className="settings-group">
        <h2>{t.preferences}</h2>
        <label>
          {t.theme}
          <select
            aria-label={t.theme}
            value={settings.theme ?? "system"}
            onChange={(event) =>
              saveSettings({ theme: event.target.value as Settings["theme"] })
            }
          >
            <option value="system">{t.system}</option>
            <option value="light">{t.light}</option>
            <option value="dark">{t.dark}</option>
          </select>
        </label>
        <label>
          {t.language}
          <select
            aria-label={t.language}
            value={settings.language}
            onChange={(event) =>
              saveSettings({ language: event.target.value as Language })
            }
          >
            <option value="zh-CN">{t.chinese}</option>
            <option value="en">{t.english}</option>
          </select>
        </label>
        <label className="switch-row">
          <input
            aria-label={t.reduceMotion}
            type="checkbox"
            checked={settings.reduceMotion === true}
            onChange={(event) =>
              saveSettings({ reduceMotion: event.target.checked })
            }
          />
          {t.reduceMotion}
        </label>
        <label className="switch-row">
          <input
            aria-label={t.reduceTransparency}
            type="checkbox"
            checked={settings.reduceTransparency === true}
            onChange={(event) =>
              saveSettings({ reduceTransparency: event.target.checked })
            }
          />
          {t.reduceTransparency}
        </label>
        <label>
          {t.defaultColor}
          <ColorPicker
            value={settings.defaultColor}
            onChange={(color) => saveSettings({ defaultColor: color })}
            label={t.customColor}
          />
        </label>
      </section>
      <StoragePanel language={language} />
      <section className="settings-group">
        <h2>{t.backup}</h2>
        <p className="hint">{t.localDataNotice}</p>
        <div className="detail-actions">
          <button className="quiet" onClick={exportJson}>
            {t.downloadJson}
          </button>
          <button className="quiet" onClick={exportMarkdown}>
            {t.downloadMarkdown}
          </button>
        </div>
        <label className="file-input">
          {t.chooseFile}
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => void readImport(event.target.files?.[0])}
          />
        </label>
        {preview ? (
          <div className="import-preview">
            <p>{t.importSummary(preview)}</p>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
              />{" "}
              {t.overwrite}
            </label>
            <button
              className="primary"
              disabled={busyImport}
              onClick={importBackup}
            >
              {busyImport ? t.importing : t.import}
            </button>
          </div>
        ) : null}
        <p className="hint">{t.importSettings}</p>
      </section>
      <BuildInfo language={language} />
    </section>
  );
}
