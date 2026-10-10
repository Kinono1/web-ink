import "./notes.css";
import type { Settings } from "../core/model";
import type { PdfAnnotation } from "./types";
export type PdfNoteDraft = {
  note: string;
  tags: string;
  color: string;
  base: PdfAnnotation;
  editing: boolean;
};
export function PdfNote({
  record,
  language,
  onJump,
  onSave,
  onRemove,
  removing,
  draft,
  onDraft,
  onClearDraft,
  saving,
  conflict,
  locked,
  deleted = false,
}: {
  record: PdfAnnotation;
  language: Settings["language"];
  onJump: () => void;
  onSave: (draft: PdfNoteDraft) => Promise<void>;
  onRemove: (record: PdfAnnotation) => void;
  removing: boolean;
  draft?: PdfNoteDraft;
  onDraft: (draft: PdfNoteDraft, resolveConflict?: boolean) => void;
  onClearDraft: () => void;
  saving: boolean;
  conflict: boolean;
  locked: boolean;
  deleted?: boolean;
}) {
  const editing = draft?.editing === true;
  const note = draft?.note ?? record.note;
  const tags = draft?.tags ?? record.tags.join(", ");
  const color = draft?.color ?? record.color;
  const base = draft?.base ?? record;
  const zh = language === "zh-CN";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const edit = () => {
    onDraft({
      note: record.note,
      tags: record.tags.join(", "),
      color: record.color,
      base: record,
      editing: true,
    }, true);
  };
  const updateDraft = (
    next: Partial<Pick<PdfNoteDraft, "note" | "tags" | "color">>,
  ) => onDraft({ note, tags, color, base, editing: true, ...next });
  const save = () => onSave({ note, tags, color, base, editing: true });
  return (
    <article
      className="pdf-note"
      data-pdf-note={record.id}
      style={{ "--record-color": record.color } as React.CSSProperties}
    >
      <button
        className="pdf-note-source"
        onClick={onJump}
        title={t("跳到这一页", "Go to this page")}
      >
        <span className="row-quote">
          {record.kind === "pdf-text"
            ? record.target.exact
            : t("区域标注", "Area annotation")}
        </span>
      </button>
      {record.note && <p>{record.note}</p>}
      <span className="row-meta">
        <span>
          {t(
            `第 ${record.target.pageNumber} 页`,
            `Page ${record.target.pageNumber}`,
          )}
        </span>
        {record.tags.length > 0 && (
          <span>{record.tags.map((tag) => `#${tag}`).join(" ")}</span>
        )}
      </span>
      {editing ? (
        <div className="pdf-note-editor">
          {deleted && <p role="alert">
            {t(
              "原标注已被删除。此草稿只保留在当前窗口，可继续编辑或复制内容后放弃草稿。",
              "The original annotation was deleted. This draft remains in this window; keep editing or copy its contents before discarding it.",
            )}
          </p>}
          <label>
            {t("笔记", "Note")}
            <textarea
              autoFocus
              maxLength={10000}
              disabled={saving || locked}
              value={note}
              onChange={(e) => updateDraft({ note: e.target.value.slice(0, 10000) })}
            />
            {note.length >= 10000 && <small role="status">{t("笔记最多 10,000 个字符。", "Notes are limited to 10,000 characters.")}</small>}
          </label>
          <label>
            {t("标签", "Tags")}
            <input
              maxLength={10000}
              disabled={saving || locked}
              value={tags}
              onChange={(e) => updateDraft({ tags: e.target.value.slice(0, 10000) })}
            />
          </label>
          <input
            disabled={saving || locked}
            type="color"
            aria-label={t("颜色", "Color")}
            value={color}
            onChange={(e) => updateDraft({ color: e.target.value })}
          />
          {conflict && !deleted && (
            <p role="alert">
              {t(
                "其他窗口已修改。草稿保留，请载入最新版本后再保存。",
                "Changed elsewhere. Your draft is preserved; load the latest revision before saving.",
              )}
              <button
                onClick={() => {
                  onDraft({ note, tags, color, base: record, editing: true }, true);
                }}
              >
                {t("载入最新版本", "Load latest")}
              </button>
            </p>
          )}
          {!deleted && <button disabled={saving || locked || conflict} onClick={() => void save().catch(() => undefined)}>
            {t("保存", "Save")}
          </button>}
          <button disabled={saving || locked} onClick={onClearDraft}>
            {deleted ? t("放弃草稿", "Discard draft") : t("取消", "Cancel")}
          </button>
        </div>
      ) : (
        <div className="pdf-note-actions">
          <button disabled={locked} onClick={edit}>{t("编辑", "Edit")}</button>
          <button disabled={removing} onClick={() => onRemove(record)}>
            {t("取消标注", "Remove annotation")}
          </button>
        </div>
      )}
    </article>
  );
}
