import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfDocument } from "../contexts/PdfDocumentContext";
import { usePdfUI } from "../contexts/PdfUIContext";

/** Reader status/error notices and the unsaved-changes dialog share one module. */
export function PdfReaderMessages({ state, actions, onReviewPrevious, onRetrySaved, recovering }: { state: ReaderSnapshot; actions: ReaderActions;
  onReviewPrevious: () => void; onRetrySaved: () => void; recovering: boolean }) {
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
          <button disabled={saving} onClick={() => void save(unsaved, noteAfterSave.current).then(onRetrySaved).catch(() => undefined)}>{t("重试保存", "Retry save")}</button>
          <button disabled={saving} onClick={() => { unsavedRef.current = undefined; setUnsaved(undefined); setSelection(undefined); getSelection()?.removeAllRanges(); setError(""); }}>
            {t("放弃本次修改", "Discard change")}</button>
        </> : <button onClick={() => setError("")}>{t("关闭", "Dismiss")}</button>}
      </div>}
  {positionError && <div className="pdf-message error" role="status"><span>{positionError}</span>
        <button onClick={() => void flushPosition()}>{t("重试保存阅读位置", "Retry reading position")}</button>
        <button onClick={() => setPositionError("")}>{t("关闭", "Dismiss")}</button></div>}
  {!recovering && (notice || previousHash) && <div className="pdf-message" role="status"><span>{notice || t("旧版本标注已保留。", "Previous annotations are preserved.")}</span>
        {previousHash && <><button disabled={locked} onClick={onReviewPrevious}>{t("找回旧标注", "Recover previous annotations")}</button>
          <button disabled={locked} onClick={() => requestLeave({ kind: "previous" })}>{t("查看之前的标注", "View previous annotations")}</button></>}
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

export function LeaveConfirmDialog({ state, actions }: { state: ReaderSnapshot; actions: ReaderActions }) {
  const { error, guardSaving, leaving, writeCount } = state;
  const { dialogKeys, discardAndContinue, keepEditing, saveAndContinue } = actions;
  const { t } = usePdfUI();
  return (
    <div className="pdf-dialog-backdrop">
      <section className="pdf-dialog" role="dialog" aria-modal="true"
        aria-label={t("未保存的内容", "Unsaved changes")} onKeyDown={dialogKeys}>
        <h2>{t("未保存的内容", "Unsaved changes")}</h2><p>{t("保存或放弃当前草稿后继续，也可以留在这里编辑。", "Save or discard the current draft to continue, or keep editing here.")}</p>
        {error && <p role="alert">{error}</p>}
        <div className="pdf-dialog-actions">
          <button disabled={guardSaving || leaving} onClick={() => void saveAndContinue()}>{guardSaving ? t("正在保存…", "Saving…") : t("保存并继续", "Save and continue")}</button>
          <button disabled={guardSaving || leaving || writeCount > 0} onClick={discardAndContinue}>{t("放弃并继续", "Discard and continue")}</button>
          <button autoFocus disabled={guardSaving || leaving} onClick={keepEditing}>{t("继续编辑", "Keep editing")}</button>
        </div>
      </section>
    </div>
  );
}
