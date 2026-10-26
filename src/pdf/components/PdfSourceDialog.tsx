import type { ComponentProps } from "react";

import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfUI } from "../contexts/PdfUIContext";
import { PdfSourceControls } from "./PdfSourceControls";
type Props = { state: Pick<ReaderSnapshot, "setSourceOpen"> & ComponentProps<typeof PdfSourceControls>["state"]; actions: Pick<ReaderActions, "dialogKeys"> & ComponentProps<typeof PdfSourceControls>["actions"] };

export function PdfSourceDialog({ state, actions }: Props) {
  const { setSourceOpen } = state;
  const { dialogKeys } = actions;
  const { t } = usePdfUI();
  return (<div className="pdf-dialog-backdrop"><section className="pdf-dialog" role="dialog" aria-modal="true"
        aria-label={t("打开其他 PDF", "Open another PDF")} onKeyDown={dialogKeys}>
        <h2>{t("打开其他 PDF", "Open another PDF")}</h2><p>{t("标注保留在本机；原文件不会存入资料库。", "Annotations stay on this device; PDF files are not stored in your library.")}</p>
        <PdfSourceControls state={state} actions={actions} /><button autoFocus onClick={() => setSourceOpen(false)}>{t("继续阅读", "Keep reading")}</button>
      </section></div>);
}
