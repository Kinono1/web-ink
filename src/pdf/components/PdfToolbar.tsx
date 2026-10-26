import type { ComponentProps } from "react";
import { PdfFind } from "../PdfFind";
import { Icon } from "../../ui/management/helpers";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfDocument } from "../contexts/PdfDocumentContext";
import { usePdfUI } from "../contexts/PdfUIContext";
import { PdfZoomControls } from "./PdfZoomControls";
import { PdfMoreMenu } from "./PdfMoreMenu";
type Props = {
  state: Pick<ReaderSnapshot,
    "backAction" | "backLabel" | "exportStage" | "fitWidth" | "focusMode" | "guardSaving" |
    "handoffReady" | "intentEpoch" | "leaving" | "locked" | "pageNumber" | "pendingLeave" |
    "pendingSearchPosition" | "presetsOpen" | "setFitWidth" | "setSearchMatch" |
    "sourceOpen" | "zoom"
  > & ComponentProps<typeof PdfZoomControls>["state"] & ComponentProps<typeof PdfMoreMenu>["state"];
  actions: Pick<ReaderActions,
    "jump" | "requestLeave" | "userIntent"
  > & ComponentProps<typeof PdfZoomControls>["actions"] & ComponentProps<typeof PdfMoreMenu>["actions"];
};

export function PdfToolbar({ state, actions }: Props) {
  const {
    backAction, backLabel, exportStage, fitWidth, focusMode, guardSaving, handoffReady,
    intentEpoch, leaving, locked, pageNumber, pendingLeave, pendingSearchPosition, presetsOpen,
    setFitWidth, setSearchMatch, sourceOpen,
  } = state;
  const { jump, requestLeave, userIntent } = actions;
  const opened = usePdfDocument();
  const { language, t } = usePdfUI();
  if (!opened) return null;
  return (<nav className="pdf-toolbar" hidden={focusMode} aria-label={t("PDF 工具栏", "PDF toolbar")}>
    <button className="quiet icon-button pdf-back" aria-label={backLabel} title={backLabel}
      disabled={leaving || !handoffReady} onClick={() => requestLeave(backAction)}><Icon name="chevron" /></button>
    <span className="pdf-name" title={opened.fileName}>{opened.fileName}</span>
    <button className="quiet icon-button pdf-previous pdf-page-action" aria-label={t("上一页", "Previous page")} title={t("上一页", "Previous page")}
      disabled={locked || pageNumber <= 1} onClick={() => jump(pageNumber - 1)}><Icon name="chevron" /></button>
    <label className="pdf-page-field"><input aria-label={t("页码", "Page number")} type="number" min="1"
      max={opened.document.numPages} value={pageNumber} disabled={locked}
      onChange={(event) => { const number = event.target.valueAsNumber; if (Number.isInteger(number)) jump(number); }} />
      <span>/ {opened.document.numPages}</span></label>
    <button className="quiet icon-button pdf-page-action" aria-label={t("下一页", "Next page")} title={t("下一页", "Next page")}
      disabled={locked || pageNumber >= opened.document.numPages} onClick={() => jump(pageNumber + 1)}><Icon name="chevron" /></button>
    <div className="pdf-zoom-controls"><PdfZoomControls state={state} actions={actions} /></div>
    <button className="quiet icon-button pdf-view-action" aria-label={t("适合宽度", "Fit to width")} title={t("适合宽度", "Fit to width")} aria-pressed={fitWidth}
      disabled={locked} onClick={() => { userIntent(); setFitWidth(true); }}><Icon name="fitWidth" /></button>
    <PdfFind opened={opened} language={language} blocked={focusMode || presetsOpen || leaving || guardSaving || !!pendingLeave || sourceOpen || !!exportStage}
      onMatch={(match) => { pendingSearchPosition.current = undefined; setSearchMatch(match); }}
      onNavigate={(page) => { jump(page); pendingSearchPosition.current = { pageNumber: page, intent: intentEpoch.current }; }} />
    <PdfMoreMenu state={state} actions={actions} />
  </nav>);
}
