import type { ComponentProps } from "react";
import { COLORS } from "../../core/model";
import { Icon } from "../../ui/management/helpers";
import { type PdfRotation } from "../reading-position";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfDocument } from "../contexts/PdfDocumentContext";
import { usePdfUI } from "../contexts/PdfUIContext";
import { PdfZoomControls } from "./PdfZoomControls";
type Props = {
  state: Pick<ReaderSnapshot,
    "area" | "color" | "dirtyNotes" | "exportStage" | "fitWidth" | "guardSaving" |
    "inlineNotes" | "leaving" | "locked" | "moreMenu" | "moreOpen" | "moreTrigger" |
    "pageNumber" | "rotation" | "setArea" | "setColor" | "setFitWidth" | "setMoreOpen" |
    "setPicked" | "setPresetsOpen" | "setSelection" | "setShowMarks" | "showMarks" |
    "sidebarAttached" | "zoom"
  > & ComponentProps<typeof PdfZoomControls>["state"];
  actions: Pick<ReaderActions,
    "applyView" | "enterFocus" | "jump" | "openNotes" | "requestLeave" | "userIntent"
  > & ComponentProps<typeof PdfZoomControls>["actions"];
};

export function PdfMoreMenu({ state, actions }: Props) {
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
  return (<div className="pdf-more" ref={moreMenu}>
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
  </div>);
}
