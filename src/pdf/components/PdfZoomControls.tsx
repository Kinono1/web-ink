import { Icon } from "../../ui/management/helpers";
import { PDF_MIN_ZOOM, PDF_MAX_ZOOM } from "../reading-position";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfUI } from "../contexts/PdfUIContext";

type Props = {
  state: Pick<ReaderSnapshot,
    "locked" | "setFitWidth" | "setZoomText" | "zoom" | "zoomText"
  >;
  actions: Pick<ReaderActions,
    "changeZoom" | "commitZoom" | "userIntent"
  >;
};

export function PdfZoomControls({ state, actions }: Props) {
  const { locked, setFitWidth, setZoomText, zoom, zoomText } = state;
  const { changeZoom, commitZoom, userIntent } = actions;
  const { t } = usePdfUI();
  return (<>
    <button className="quiet icon-button" aria-label={t("缩小", "Zoom out")} title={t("缩小", "Zoom out")}
      disabled={locked || zoom <= PDF_MIN_ZOOM} onClick={() => changeZoom(-0.25)}><Icon name="minus" /></button>
    <input className="pdf-zoom" aria-label={t("缩放比例", "Zoom percentage")} inputMode="decimal" value={zoomText} disabled={locked}
      onChange={(event) => { setFitWidth(false); userIntent(); setZoomText(event.target.value); }}
      onBlur={(event) => commitZoom(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); commitZoom(event.currentTarget.value); }
        if (event.key === "Escape") { event.stopPropagation(); setZoomText(`${Math.round(zoom * 100)}%`); }
      }} />
    <button className="quiet icon-button" aria-label={t("放大", "Zoom in")} title={t("放大", "Zoom in")}
      disabled={locked || zoom >= PDF_MAX_ZOOM} onClick={() => changeZoom(0.25)}><Icon name="plus" /></button>
  </>);
}
