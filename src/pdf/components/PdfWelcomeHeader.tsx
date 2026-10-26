import { Icon } from "../../ui/management/helpers";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfUI } from "../contexts/PdfUIContext";

type Props = {
  state: Pick<ReaderSnapshot,
    "backAction" | "backLabel" | "handoffReady" | "handoffToken" | "leaving"
  >;
  actions: Pick<ReaderActions,
    "requestLeave"
  >;
};

export function PdfWelcomeHeader({ state, actions }: Props) {
  const { backAction, backLabel, handoffReady, handoffToken, leaving } = state;
  const { requestLeave } = actions;
  const { t } = usePdfUI();
  return (<header className="pdf-header">
    <div className="pdf-brand"><Icon name="pdf" /><strong>Web Ink <span>PDF</span></strong></div>
    {handoffToken && <button className="quiet" disabled={!handoffReady || leaving} onClick={() => requestLeave(backAction)}>{backLabel}</button>}
    <button className="quiet icon-button" aria-label={t("资料库", "Library")} title={t("资料库", "Library")}
      onClick={() => requestLeave({ kind: "library" })}><Icon name="library" /></button>
  </header>);
}
