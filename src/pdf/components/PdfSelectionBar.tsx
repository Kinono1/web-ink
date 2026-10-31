import { AnnotationPresetActions } from "../../ui/AnnotationPresets";
import { COLORS } from "../../core/model";
import { Icon } from "../../ui/management/helpers";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfUI } from "../contexts/PdfUIContext";

type Props = { state: ReaderSnapshot; actions: ReaderActions };

export function PdfSelectionBar({ state, actions, recovering, recoveryBusy, onRecover }: Props & {
  recovering?: boolean; recoveryBusy?: boolean; onRecover?: () => void;
}) {
  const {
    color, locked, presets, saving, selection, selectionBar, selectionStyle, setSelection,
  } = state;
  const { choosePreset, mark, openNotes } = actions;
  const { language, t } = usePdfUI();
  if (!selection) return null;
  return (<div className="pdf-selection" ref={selectionBar} style={selectionStyle} role="toolbar" aria-label={t("选中文字高亮", "Highlight selected text")}>
    {recovering ? <>
      <button disabled={locked || recoveryBusy} onPointerDown={(event) => event.preventDefault()} onClick={onRecover}>
        {t("复制旧标注到此处", "Copy previous annotation here")}
      </button>
      <button disabled={recoveryBusy} onClick={() => { setSelection(undefined); getSelection()?.removeAllRanges(); }}>{t("取消选区", "Clear selection")}</button>
    </> : <>
    <AnnotationPresetActions language={language} presets={presets} disabled={locked} onChoose={choosePreset} />
    {COLORS.map((chosen) => <button className="pdf-swatch" key={chosen} aria-label={`${t("高亮", "Highlight")} ${chosen}`}
      title={`${t("高亮", "Highlight")} ${chosen}`} style={{ background: chosen }} disabled={locked}
      onPointerDown={(event) => event.preventDefault()} onClick={() => mark(selection.target, "pdf-text", chosen)} />)}
    <button disabled={locked} onPointerDown={(event) => event.preventDefault()}
      onClick={() => { openNotes(); mark(selection.target, "pdf-text", color, true); }}><Icon name="note" />{t("添加笔记", "Add note")}</button>
    <button disabled={saving} onClick={() => { setSelection(undefined); getSelection()?.removeAllRanges(); }}>{t("取消", "Cancel")}</button>
    </>}
  </div>);
}
