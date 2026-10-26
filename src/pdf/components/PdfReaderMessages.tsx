
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfDocument } from "../contexts/PdfDocumentContext";
import { usePdfUI } from "../contexts/PdfUIContext";

type Props = {
  state: Pick<ReaderSnapshot,
    "backAction" | "backLabel" | "busy" | "error" | "exportStage" | "handoff" |
    "handoffReady" | "handoffToken" | "ieeeRecovery" | "leaving" | "locked" | "noteAfterSave" |
    "notice" | "paperUrl" | "positionError" | "previousHash" | "saving" | "setError" |
    "setPositionError" | "setSelection" | "setUnsaved" | "unsaved" | "unsavedRef"
  >;
  actions: Pick<ReaderActions,
    "cancelExport" | "flushPosition" | "loadPdf" | "requestLeave" | "save"
  >;
};

export function PdfReaderMessages({ state, actions }: Props) {
  const {
    backAction, backLabel, busy, error, exportStage, handoff, handoffReady, handoffToken,
    ieeeRecovery, leaving, locked, noteAfterSave, notice, paperUrl, positionError, previousHash,
    saving, setError, setPositionError, setSelection, setUnsaved, unsaved, unsavedRef,
  } = state;
  const { cancelExport, flushPosition, loadPdf, requestLeave, save } = actions;
  const opened = usePdfDocument();
  const { t } = usePdfUI();
  return (<>
  {exportStage && <div className="pdf-message" role="status" aria-busy="true">
        <span>{exportStage === "preparing" ? t("正在准备导出…", "Preparing export…") : exportStage === "writing" ? t("正在写入标注…", "Writing annotations…") : t("正在校验导出的 PDF…", "Verifying exported PDF…")}</span>
        <button onClick={cancelExport}>{t("取消导出", "Cancel export")}</button>
      </div>}
  {error && <div className="pdf-message error" role="alert">
        <span>{error}</span>
        {!opened && <p>{t("无法直接读取？下载 PDF 后，点击「选择本地 PDF」继续。", "Can't open the link? Download the PDF, then choose the local file.")}</p>}
        {unsaved ? <>
          <button disabled={saving} onClick={() => void save(unsaved, noteAfterSave.current).catch(() => undefined)}>{t("重试保存", "Retry save")}</button>
          <button disabled={saving} onClick={() => { unsavedRef.current = undefined; setUnsaved(undefined); setSelection(undefined); getSelection()?.removeAllRanges(); setError(""); }}>
            {t("放弃本次修改", "Discard change")}</button>
        </> : <button onClick={() => setError("")}>{t("关闭", "Dismiss")}</button>}
      </div>}
  {positionError && <div className="pdf-message error" role="status"><span>{positionError}</span>
        <button onClick={() => void flushPosition()}>{t("重试保存阅读位置", "Retry reading position")}</button>
        <button onClick={() => setPositionError("")}>{t("关闭", "Dismiss")}</button></div>}
  {notice && <div className="pdf-message" role="status"><span>{notice}</span>
        {previousHash && <button disabled={locked} onClick={() => requestLeave({ kind: "previous" })}>{t("查看之前的标注", "View previous annotations")}</button>}
      </div>}
  {!opened && ieeeRecovery && (error || notice) && <div className="pdf-message">
        {ieeeRecovery === "return" ? <button disabled={busy || leaving} onClick={() => requestLeave(paperUrl ? { kind: "paper" } : backAction)}>{t("返回 IEEE", "Return to IEEE")}</button>
          : handoff && <button disabled={busy || leaving} onClick={() => void loadPdf(undefined, false, handoff.returnUrl, true)}>
            {ieeeRecovery === "permission" ? t("允许访问 IEEE 并重试", "Allow IEEE and retry") : t("重试读取", "Retry reading")}</button>}
      </div>}
  {!notice && handoffToken && handoffReady && !handoff && <div className="pdf-message" role="status">
        <span>{t("暂时无法返回原阅读器。", "The original reader is unavailable.")}</span>
        <button onClick={() => requestLeave(backAction)}>{backLabel}</button>
      </div>}
  </>);
}
