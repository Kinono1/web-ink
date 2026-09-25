import { useState } from "react";
import { request, RequestError } from "../core/client";
import type { Settings } from "../core/model";
import { errorText, type PdfAnnotation } from "./types";
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
  onError,
  onRemove,
  removing,
  draft,
  onDraft,
  onClearDraft,
}: {
  record: PdfAnnotation;
  language: Settings["language"];
  onJump: () => void;
  onError: (e: string) => void;
  onRemove: (record: PdfAnnotation) => void;
  removing: boolean;
  draft?: PdfNoteDraft;
  onDraft: (draft: PdfNoteDraft) => void;
  onClearDraft: () => void;
}) {
  const [conflict, setConflict] = useState(false),
    [saving, setSaving] = useState(false);
  const editing = draft?.editing === true;
  const note = draft?.note ?? record.note;
  const tags = draft?.tags ?? record.tags.join(", ");
  const color = draft?.color ?? record.color;
  const base = draft?.base ?? record;
  const zh = language === "zh-CN";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const edit = () => {
    setConflict(false);
    onDraft({
      note: record.note,
      tags: record.tags.join(", "),
      color: record.color,
      base: record,
      editing: true,
    });
  };
  const updateDraft = (
    next: Partial<Pick<PdfNoteDraft, "note" | "tags" | "color">>,
  ) => onDraft({ note, tags, color, base, editing: true, ...next });
  const save = async () => {
    setSaving(true);
    try {
      await request({
        type: "annotations.put",
        annotation: {
          ...base,
          note,
          tags: [
            ...new Set(
              tags
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ],
          color,
          updatedAt: new Date().toISOString(),
        },
        expectedRevision: base.revision,
      });
      setConflict(false);
      onClearDraft();
    } catch (cause) {
      if (cause instanceof RequestError && cause.code === "CONFLICT")
        setConflict(true);
      onError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };
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
          <label>
            {t("笔记", "Note")}
            <textarea
              value={note}
              onChange={(e) => updateDraft({ note: e.target.value })}
            />
          </label>
          <label>
            {t("标签", "Tags")}
            <input
              value={tags}
              onChange={(e) => updateDraft({ tags: e.target.value })}
            />
          </label>
          <input
            type="color"
            aria-label={t("颜色", "Color")}
            value={color}
            onChange={(e) => updateDraft({ color: e.target.value })}
          />
          {conflict && (
            <p role="alert">
              {t(
                "其他窗口已修改。草稿保留，请载入最新版本后再保存。",
                "Changed elsewhere. Your draft is preserved; load the latest revision before saving.",
              )}
              <button
                onClick={() => {
                  onDraft({ note, tags, color, base: record, editing: true });
                  setConflict(false);
                }}
              >
                {t("载入最新版本", "Load latest")}
              </button>
            </p>
          )}
          <button disabled={saving || conflict} onClick={() => void save()}>
            {t("保存", "Save")}
          </button>
          <button disabled={saving} onClick={onClearDraft}>
            {t("取消", "Cancel")}
          </button>
        </div>
      ) : (
        <div className="pdf-note-actions">
          <button onClick={edit}>{t("编辑", "Edit")}</button>
          <button disabled={removing} onClick={() => onRemove(record)}>
            {t("取消标注", "Remove annotation")}
          </button>
        </div>
      )}
    </article>
  );
}
