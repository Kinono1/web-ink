import { COLORS } from "../../core/model";
import { Icon } from "../../ui/management/helpers";
import { type PdfRotation, PDF_MIN_ZOOM, PDF_MAX_ZOOM } from "../reading-position";
import { PdfFind } from "../PdfFind";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfDocument } from "../contexts/PdfDocumentContext";
import { usePdfUI } from "../contexts/PdfUIContext";

function PdfZoomControls({ state, actions }: { state: ReaderSnapshot; actions: ReaderActions }) {
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

function PdfMoreMenu({ state, actions }: { state: ReaderSnapshot; actions: ReaderActions }) {
  const {
    area, color, dirtyNotes, exportStage, fitWidth, guardSaving, inlineNotes, leaving, locked,
    moreMenu, moreOpen, moreTrigger, pageNumber, rotation, setArea, setColor, setFitWidth,
    setMoreOpen, setPicked, setPresetsOpen, setSelection, setShowMarks, showMarks,
    sidebarAttached, zoom,
  } = state;
  const { applyView, enterFocus, jump, openNotes, requestLeave, userIntent } = actions;
  const opened = usePdfDocument();
  const { t } = usePdfUI();
  if (!opened) return null;
  return (
    <div className="pdf-more" ref={moreMenu}>
      <button className="quiet icon-button" ref={moreTrigger} aria-label={t("更多", "More")} title={t("更多", "More")}
        aria-expanded={moreOpen} aria-controls="pdf-more-menu" disabled={leaving || guardSaving}
        onClick={() => setMoreOpen((open) => !open)}><Icon name="more" /></button>
      {moreOpen && <div className="pdf-more-menu" id="pdf-more-menu" aria-label={t("更多阅读器操作", "More reader actions")}>
        <div className="pdf-more-group" role="group" aria-label={t("阅读", "Reading")}>
          <button disabled={locked || dirtyNotes} onClick={() => void enterFocus()} title={dirtyNotes ? t("先保存或放弃正在编辑的笔记", "Save or discard the note draft first") : undefined}>
            <Icon name="focus" />{t("专注阅读", "Focus reading")}</button>
          <div className="pdf-more-zoom"><PdfZoomControls state={state} actions={actions} /></div>
          <button className="pdf-more-page" disabled={locked || pageNumber <= 1} onClick={() => { jump(pageNumber - 1); setMoreOpen(false); }}>
            <Icon name="chevron" />{t("上一页", "Previous page")}</button>
          <button className="pdf-more-page" disabled={locked || pageNumber >= opened.document.numPages} onClick={() => { jump(pageNumber + 1); setMoreOpen(false); }}>
            <Icon name="chevron" />{t("下一页", "Next page")}</button>
          <button className="pdf-more-view" disabled={locked} aria-pressed={fitWidth} onClick={() => { userIntent(); setFitWidth(true); setMoreOpen(false); }}>
            <Icon name="fitWidth" />{t("适合宽度", "Fit to width")}</button>
          <button aria-label={t("旋转页面", "Rotate page")} title={t("旋转页面", "Rotate page")} disabled={locked} onClick={() => { applyView(zoom, ((rotation + 90) % 360) as PdfRotation); setMoreOpen(false); }}>
            <Icon name="rotate" />{t("旋转页面", "Rotate page")}</button>
        </div>
        <div className="pdf-more-group" role="group" aria-label={t("标注", "Annotations")}>
          {!sidebarAttached && !inlineNotes && <button onClick={() => { openNotes(); setMoreOpen(false); }}>
            <Icon name="note" />{t("查看标注", "View annotations")}</button>}
          <button aria-pressed={area} disabled={locked} onClick={() => { userIntent(); setArea((value) => !value); setSelection(undefined); setMoreOpen(false); }}>
            <Icon name="highlight" />{area ? t("文字选择", "Select text") : t("区域标注", "Mark area")}</button>
          {area && <div className="pdf-area-color" role="group" aria-label={t("标注颜色", "Annotation color")}>
            {COLORS.map((chosen) => <button className="pdf-swatch" key={chosen} aria-label={`${t("标注颜色", "Annotation color")} ${chosen}`}
              title={`${t("标注颜色", "Annotation color")} ${chosen}`} style={{ background: chosen }} aria-pressed={color === chosen}
              disabled={locked} onClick={() => setColor(chosen)} />)}
          </div>}
          <button aria-pressed={showMarks} onClick={() => { setShowMarks((value) => !value); setPicked(undefined); setMoreOpen(false); }}>
            {showMarks ? t("隐藏标注", "Hide annotations") : t("显示标注", "Show annotations")}</button>
          <button disabled={locked} onClick={() => { setPresetsOpen(true); setMoreOpen(false); }}>
            <Icon name="highlight" />{t("标注预设…", "Annotation presets…")}</button>
        </div>
        <div className="pdf-more-group" role="group" aria-label={t("文件", "Files")}>
          <button disabled={!!exportStage} onClick={() => requestLeave({ kind: "export" })}>{t("导出带标注的 PDF…", "Export annotated PDF…")}</button>
          <button disabled={!!exportStage} onClick={() => requestLeave({ kind: "ai" })}>{t("导出给 AI", "Export notes for AI")}</button>
          <button onClick={() => requestLeave({ kind: "choose" })}><Icon name="pdf" />{t("打开其他文件", "Open another file")}</button>
          <button onClick={() => requestLeave({ kind: "library" })}><Icon name="library" />{t("资料库", "Library")}</button>
        </div>
      </div>}
    </div>
  );
}

export function PdfToolbar({ state, actions }: { state: ReaderSnapshot; actions: ReaderActions }) {
  const {
    backAction, backLabel, exportStage, fitWidth, focusMode, guardSaving, handoffReady,
    intentEpoch, leaving, locked, pageNumber, pendingLeave, pendingSearchPosition, presetsOpen,
    setFitWidth, setSearchMatch, sourceOpen,
  } = state;
  const { jump, requestLeave, userIntent } = actions;
  const opened = usePdfDocument();
  const { language, t } = usePdfUI();
  if (!opened) return null;
  return (
    <nav className="pdf-toolbar" hidden={focusMode} aria-label={t("PDF 工具栏", "PDF toolbar")}>
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
    </nav>
  );
}
