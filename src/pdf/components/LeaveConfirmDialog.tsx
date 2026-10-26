
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfUI } from "../contexts/PdfUIContext";

type Props = {
  state: Pick<ReaderSnapshot,
    "error" | "guardSaving" | "leaving" | "writeCount"
  >;
  actions: Pick<ReaderActions,
    "dialogKeys" | "discardAndContinue" | "keepEditing" | "saveAndContinue"
  >;
};

export function LeaveConfirmDialog({ state, actions }: Props) {
  const { error, guardSaving, leaving, writeCount } = state;
  const { dialogKeys, discardAndContinue, keepEditing, saveAndContinue } = actions;
  const { t } = usePdfUI();
  return (<div className="pdf-dialog-backdrop"><section className="pdf-dialog" role="dialog" aria-modal="true"
        aria-label={t("未保存的内容", "Unsaved changes")} onKeyDown={dialogKeys}>
        <h2>{t("未保存的内容", "Unsaved changes")}</h2><p>{t("保存或放弃当前草稿后继续，也可以留在这里编辑。", "Save or discard the current draft to continue, or keep editing here.")}</p>
        {error && <p role="alert">{error}</p>}
        <div className="pdf-dialog-actions">
          <button disabled={guardSaving || leaving} onClick={() => void saveAndContinue()}>{guardSaving ? t("正在保存…", "Saving…") : t("保存并继续", "Save and continue")}</button>
          <button disabled={guardSaving || leaving || writeCount > 0} onClick={discardAndContinue}>{t("放弃并继续", "Discard and continue")}</button>
          <button autoFocus disabled={guardSaving || leaving} onClick={keepEditing}>{t("继续编辑", "Keep editing")}</button>
        </div>
      </section></div>);
}
