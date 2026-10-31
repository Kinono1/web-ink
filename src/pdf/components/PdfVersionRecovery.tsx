import { useState } from "react";
import type { PdfAnnotation } from "../../core/pdf-types";
import { useAnnotationQuery } from "../../ui/management/useAnnotationQuery";
import { isPdf, type ReaderActions } from "../hooks/contracts";
import { usePdfUI } from "../contexts/PdfUIContext";

export function PdfVersionRecovery({ hash, locked, onChoose, onClose, dialogKeys }: {
  hash: string;
  locked: boolean;
  onChoose: (record: PdfAnnotation) => void;
  onClose: () => void;
  dialogKeys: ReaderActions["dialogKeys"];
}) {
  const { t } = usePdfUI();
  const [error, setError] = useState("");
  const { records, nextCursor, loading, loadRecords } = useAnnotationQuery({
    mode: "library", pageUrl: `urn:web-ink:pdf:${hash}`, kind: "all", color: "", tag: "", query: "",
  }, setError, () => {});
  const pdfRecords = records.filter(isPdf);
  return <div className="pdf-dialog-backdrop">
    <section className="pdf-dialog" role="dialog" aria-modal="true"
      aria-label={t("找回旧标注", "Recover previous annotations")}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        else dialogKeys(event);
      }}>
      <h2>{t("找回旧标注", "Recover previous annotations")}</h2>
      <p>{t("两份文件可能不同，请先核对内容和位置。复制会保留旧记录。", "The files may differ. Check the text and location first; copying keeps the previous record.")}</p>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">{t("正在读取…", "Loading…")}</p>}
      {!loading && !pdfRecords.length && !error && <p>{t("旧版本没有可找回的标注。", "No previous annotations are available.")}</p>}
      {!!pdfRecords.length && <div className="pdf-recovery-list">{pdfRecords.map((record) => <article key={record.id}>
        <strong>{record.kind === "pdf-text" ? record.target.exact.slice(0, 300) : t("区域标注", "Area annotation")}</strong>
        {record.note && <p>{record.note.slice(0, 300)}</p>}
        <small>{t(`原第 ${record.target.pageNumber} 页`, `Previously on page ${record.target.pageNumber}`)}</small>
        <button disabled={locked} onClick={() => onChoose(record)}>{record.kind === "pdf-text"
          ? t("查找并选择", "Find and select") : t("选择新区域", "Select new area")}</button>
      </article>)}</div>}
      {nextCursor && <button disabled={loading} onClick={() => void loadRecords(true, nextCursor)}>{t("加载更多", "Load more")}</button>}
      <button autoFocus onClick={onClose}>{t("关闭", "Close")}</button>
    </section>
  </div>;
}
