import { useState } from "react";
import { request, RequestError } from "../core/client";
import type { Settings } from "../core/model";
import { errorText, type PdfAnnotation } from "./types";
export function PdfNote({
  record,
  language,
  onJump,
  onError,
  onRemove,
  removing,
}: {
  record: PdfAnnotation;
  language: Settings["language"];
  onJump: () => void;
  onError: (e: string) => void;
  onRemove: (record: PdfAnnotation) => void;
  removing: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [note, setNote] = useState(record.note),
    [tags, setTags] = useState(record.tags.join(", ")),
    [color, setColor] = useState(record.color),
    [base, setBase] = useState(record),
    [conflict, setConflict] = useState(false),
    [saving, setSaving] = useState(false);
  const zh = language === "zh-CN";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const edit = () => {
    setBase(record);
    setNote(record.note);
    setTags(record.tags.join(", "));
    setColor(record.color);
    setConflict(false);
    setEditing(true);
  };
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
      setEditing(false);
      setConflict(false);
    } catch (cause) {
      if (cause instanceof RequestError && cause.code === "CONFLICT")
        setConflict(true);
      onError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <article className="pdf-note" style={{ borderLeftColor: record.color }}>
      <button className="pdf-note-source" onClick={onJump}>
        {t("第", "Page ")}
        {record.target.pageNumber}
        {zh ? "页" : ""} ·{" "}
        {record.kind === "pdf-text"
          ? record.target.exact
          : t("区域标注", "Area annotation")}
      </button>
      {record.note && <p>{record.note}</p>}
      {record.tags.length > 0 && <small>{record.tags.join(" · ")}</small>}
      {editing ? (
        <div className="pdf-note-editor">
          <label>
            {t("笔记", "Note")}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label>
            {t("标签", "Tags")}
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <input
            type="color"
            aria-label={t("颜色", "Color")}
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
          {conflict && (
            <p role="alert">
              {t(
                "其他窗口已修改。草稿保留，请载入最新版本后再保存。",
                "Changed elsewhere. Your draft is preserved; load the latest revision before saving.",
              )}
              <button
                onClick={() => {
                  setBase(record);
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
          <button disabled={saving} onClick={() => setEditing(false)}>
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
