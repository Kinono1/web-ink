import { useState, useEffect } from "react";
import { COLORS, type Annotation, type AnchorState, type Language, type Settings, type ImportPreview } from "../../core/model";
import type { FilterKind, Draft } from "./types";
import { COPY } from "./copy";
import { tagText, parseTags, statusClass, annotationText, matchesQuery, isPdf, pdfReaderUrl, kindFamily, localDate, download, Icon } from "./helpers";
import { StoragePanel } from "../StoragePanel";
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
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="empty">
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
}: {
  title: string;
  host?: string;
  enabled: boolean;
  onToggle: () => void;
  toggleLabel: string;
}) {
  return (
    <section className="page-header">
      <div>
        <p className="eyebrow">CURRENT PAGE</p>
        <strong title={title}>{title}</strong>
        {host ? <span>{host}</span> : null}
      </div>
      <button
        className={enabled ? "page-switch on" : "page-switch"}
        aria-pressed={enabled}
        onClick={onToggle}
      >
        <span aria-hidden="true" />
        {toggleLabel}
      </button>
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
  return (
    <section
      className={`${compact ? "annotation-browser compact" : "annotation-browser"}${detailOpen ? " detail-open" : ""}`}
    >
      <div className="annotation-list" aria-label={t.library}>
        {records.map((record) => (
          <AnnotationRow
            key={record.id}
            record={record}
            selected={selected?.id === record.id}
            state={states[record.id]}
            language={language}
            onSelect={() => setSelectedId(record.id)}
          />
        ))}
      </div>
      {selected ? (
        <AnnotationDetail
          record={selected}
          state={states[selected.id]}
          language={language}
          t={t}
          compact={compact}
          back={onBack}
          draft={drafts[selected.id]}
          editing={editing === selected.id}
          conflict={Boolean(conflicts[selected.id])}
          onEdit={() => onEdit(selected)}
          onDraft={(patch) => onDraft(selected.id, patch)}
          onSave={() => onSave(selected.id)}
          onLoadLatest={() => onLoadLatest(selected.id)}
          onCancel={onCancel}
          onDelete={() => onDelete(selected)}
          onFocus={() => onFocus(selected)}
          onRebind={() => onRebind(selected)}
          onDraw={() => onDraw(selected)}
          onOpenPdf={() => onOpenPdf(selected)}
        />
      ) : null}
    </section>
  );
}
export function AnnotationRow({
  record,
  selected,
  state,
  language,
  onSelect,
}: {
  record: Annotation;
  selected: boolean;
  state?: AnchorState;
  language: Language;
  onSelect: () => void;
}) {
  const description =
    record.kind === "text"
      ? record.target.exact
      : record.kind === "image"
        ? record.target.alt || record.target.context || record.target.src
        : record.target.exact || record.target.fileName;
  const icon =
    kindFamily(record.kind) === "text"
      ? "text"
      : kindFamily(record.kind) === "image"
        ? "image"
        : "pdf";
  return (
    <button
      className={selected ? "annotation-row selected" : "annotation-row"}
      onClick={onSelect}
      style={{ "--record-color": record.color } as React.CSSProperties}
    >
      <span className="type">
        <Icon name={icon} />
      </span>
      <span className="row-copy">
        <strong>{description}</strong>
        <small>
          {record.pageTitle ||
            (isPdf(record)
              ? record.target.fileName
              : new URL(record.pageUrl).host)}{" "}
          · {localDate(record.updatedAt, language)}
        </small>
      </span>
      {state ? (
        <span className={statusClass(state.status)} title={state.reason}>
          {state.status}
        </span>
      ) : (
        <Icon name="chevron" />
      )}
    </button>
  );
}
export function AnnotationDetail({
  record,
  state,
  language,
  t,
  compact,
  back,
  draft,
  editing,
  conflict,
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
}: {
  record: Annotation;
  state?: AnchorState;
  language: Language;
  t: (typeof COPY)[Language];
  compact: boolean;
  back?: () => void;
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
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setConfirmDelete(false);
  }, [record.id]);
  const label = state
    ? t[
        state.status === "located"
          ? "located"
          : state.status === "pending"
            ? "pending"
            : state.status === "unresolved"
              ? "unresolved"
              : "unsupportedStatus"
      ]
    : undefined;
  return (
    <article
      className={compact ? "annotation-detail compact" : "annotation-detail"}
    >
      {back ? (
        <button className="back-button quiet" onClick={back}>
          <Icon name="chevron" />
          {t.library}
        </button>
      ) : null}
      <div className="detail-heading">
        <span className="color-dot" style={{ backgroundColor: record.color }} />
        <div>
          <p className="eyebrow">
            {kindFamily(record.kind) === "pdf"
              ? t.pdf
              : kindFamily(record.kind) === "text"
                ? t.text
                : t.image}
          </p>
          <h2>
            {record.pageTitle ||
              (isPdf(record)
                ? record.target.fileName
                : new URL(record.pageUrl).host)}
          </h2>
        </div>
        {label ? (
          <span className={statusClass(state?.status)} title={state?.reason}>
            {label}
          </span>
        ) : null}
      </div>
      {editing && draft ? (
        <Editor
          draft={draft}
          t={t}
          conflict={conflict}
          onDraft={onDraft}
          onSave={onSave}
          onLoadLatest={onLoadLatest}
          onCancel={onCancel}
        />
      ) : (
        <>
          <p className="detail-excerpt">
            {record.kind === "text"
              ? record.target.exact
              : record.kind === "image"
                ? record.target.alt ||
                  record.target.context ||
                  record.target.src
                : record.target.exact || record.target.fileName}
          </p>
          {record.note ? <p className="note">{record.note}</p> : null}
          {record.tags.length ? (
            <div className="tags">
              {record.tags.map((item) => (
                <span key={item}>#{item}</span>
              ))}
            </div>
          ) : null}
          <div className="detail-actions">
            {isPdf(record) ? (
              <button onClick={onOpenPdf}>
                <Icon name="pdf" />
                {t.openPdf}
              </button>
            ) : compact ? (
              <button onClick={onFocus}>
                <Icon name="focus" />
                {t.focus}
              </button>
            ) : (
              <a href={record.pageUrl} target="_blank" rel="noreferrer">
                <Icon name="focus" />
                {t.source}
              </a>
            )}
            {state?.status === "unresolved" && compact ? (
              <button onClick={onRebind}>{t.rebind}</button>
            ) : null}
            {record.kind === "image" && compact ? (
              <button onClick={onDraw}>
                <Icon name="draw" />
                {t.draw}
              </button>
            ) : null}
            <button onClick={onEdit}>{t.note}</button>
            {confirmDelete ? (
              <>
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
                <button
                  className="quiet"
                  onClick={() => setConfirmDelete(false)}
                >
                  {t.cancel}
                </button>
              </>
            ) : (
              <button className="danger" onClick={() => setConfirmDelete(true)}>
                {t.delete}
              </button>
            )}
          </div>
        </>
      )}
    </article>
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
        label={t.defaultColor}
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
        <h2>{t.settings}</h2>
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
            label={t.defaultColor}
          />
        </label>
      </section>
      <StoragePanel language={language} />
      <section className="settings-group">
        <h2>{t.backup}</h2>
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
    </section>
  );
}
