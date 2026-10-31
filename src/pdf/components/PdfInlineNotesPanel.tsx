import { useCallback, type ComponentProps } from "react";
import { PdfNote } from "../PdfNote";
import type { PdfNoteDraft } from "../../core/sidebar";
import { NativePdfNote, PdfAnnotationFilters } from "../../ui/PdfSidebar";
import { errorText } from "../../core/pdf-types";
import { Icon } from "../../ui/management/helpers";
import type { ReaderSnapshot, ReaderActions } from "../hooks/contracts";
import { usePdfUI } from "../contexts/PdfUIContext";

type Props = { state: ReaderSnapshot; actions: ReaderActions };

// Bind row-specific arguments where React can preserve their identity. PdfNote
// uses normal memo comparison, so a changed callback still reaches its editor.
type InlineNoteProps = Omit<ComponentProps<typeof PdfNote>, "onJump" | "onSave" | "onDraft" | "onClearDraft"> &
  Pick<Props["actions"], "jump" | "saveNote" | "updateDraft">;

function InlinePdfNote({ record, jump, saveNote, updateDraft, ...props }: InlineNoteProps) {
  const onJump = useCallback(() => jump(record.target.pageNumber), [jump, record.target.pageNumber]);
  const onSave = useCallback((draft: PdfNoteDraft) => saveNote(record.id, draft), [saveNote, record.id]);
  const onDraft = useCallback(
    (draft: PdfNoteDraft, resolveConflict?: boolean) => updateDraft(record.id, draft, resolveConflict),
    [updateDraft, record.id],
  );
  const onClearDraft = useCallback(() => updateDraft(record.id), [updateDraft, record.id]);
  return <PdfNote {...props} record={record} onJump={onJump} onSave={onSave} onDraft={onDraft} onClearDraft={onClearDraft} />;
}

export function PdfInlineNotesPanel({ state, actions }: Props) {
  const {
    deletedDrafts, guardSaving, inlineNotes, leaving, nativeComplete, nativeFilter,
    nativeLoading, nativeOffset, nativeProgress, nativeRecords, nativeWindow, noteConflicts,
    noteCount, noteDrafts, noteSaving, notesLimit, notesRail, originalError, records, removing,
    savedIds, setNativeError, setNotesLimit, setNotesOpen, sortedNotes, unsaved, writeCount,
  } = state;
  const {
    cancelNativeScan, filterAnnotations, focusOriginalNote, jump, nextOriginalPage,
    previousOriginalPage, remove, saveNote, scanOriginalNotes, updateDraft,
  } = actions;
  const { language, t } = usePdfUI();
  return (<aside className="pdf-notes" id="pdf-notes" ref={notesRail} aria-label={t("本篇笔记", "Document notes")} hidden={!inlineNotes}>
    <div className="pdf-notes-header"><h2>{nativeFilter === "original" ? t("原文件标注", "Original annotations") : t("本篇标注", "Annotations")} <span>{noteCount}</span>
      {nativeFilter !== "web-ink" && !nativeComplete && <small>{t("（已读取）", "(read so far)")}</small>}</h2>
      <button className="quiet icon-button" aria-label={t("关闭笔记", "Close notes")} onClick={() => setNotesOpen(false)}><Icon name="close" /></button></div>
    {nativeFilter !== "original" && !records.length && <p className="pdf-muted">{t("选中文字后选择颜色保存高亮，或用「区域标注」框选图表。", "Select text and choose a color to save it, or use Mark area for a figure.")}</p>}
    <PdfAnnotationFilters filter={nativeFilter} language={language} onFilter={filterAnnotations} />
    {nativeFilter !== "web-ink" && <>
      {originalError && <p role="alert">{originalError}</p>}
      {nativeProgress && <p role="status">{t("原文件已读取", "Original pages read")} {nativeProgress.completed} / {nativeProgress.total}</p>}
      {nativeLoading && <button onClick={cancelNativeScan}>{t("取消读取", "Cancel reading")}</button>}
      {!nativeLoading && nativeProgress && nativeProgress.completed < nativeProgress.total &&
        <button onClick={() => void scanOriginalNotes()}>{t("继续读取原文件标注", "Continue reading original annotations")}</button>}
    </>}
    {nativeFilter !== "original" && [...deletedDrafts.map((draft) => draft.base), ...sortedNotes.slice(0, notesLimit)].map((record) => <InlinePdfNote key={record.id} record={record} language={language}
      jump={jump} saveNote={saveNote} updateDraft={updateDraft} onRemove={remove}
      removing={removing} saving={noteSaving === record.id} conflict={noteConflicts[record.id] === true}
      locked={leaving || guardSaving || writeCount > 0 || !!unsaved} draft={noteDrafts[record.id]}
      deleted={!savedIds.has(record.id)}
      />)}
    {nativeFilter !== "web-ink" && nativeWindow.records.map((record) => <NativePdfNote key={record.key} record={record} language={language}
      onJump={() => void focusOriginalNote(record).catch((cause) => setNativeError(errorText(cause)))} />)}
    {nativeFilter !== "web-ink" && <div className="pdf-annotation-filters">
      {nativeOffset > 0 && <button onClick={previousOriginalPage}>{t("上一页原文件标注", "Previous original annotations")}</button>}
      {nativeWindow.end < nativeRecords.length && <button onClick={nextOriginalPage}>{t("下一页原文件标注", "Next original annotations")}</button>}
    </div>}
    {nativeFilter !== "original" && notesLimit < sortedNotes.length && <button onClick={() => setNotesLimit((limit) => limit + 50)}>{t("加载更多", "Load more")}</button>}
  </aside>);
}
