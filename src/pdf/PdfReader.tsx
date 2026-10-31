import { useRef } from "react";
import { FocusControls } from "./FocusControls";
import { AnnotationPresetEditor } from "../ui/AnnotationPresets";
import { saveAnnotationPresets, presetIndexFromKey } from "../core/annotation-presets";

import type { ReaderActions } from "./hooks/contracts";
import { PdfToolbar } from "./components/PdfChrome";
import { PdfWelcomeHeader, PdfWelcomeScreen, PdfSourceDialog } from "./components/PdfWelcome";
import { PdfReaderMessages, LeaveConfirmDialog } from "./components/PdfOverlays";
import { PdfSelectionBar } from "./components/PdfSelectionBar";
import { PdfVersionRecovery } from "./components/PdfVersionRecovery";
import { PdfInlineNotesPanel } from "./components/PdfInlineNotesPanel";
import { PdfCanvas } from "./components/PdfCanvas";
import { PdfDocumentContext } from "./contexts/PdfDocumentContext";
import { PdfUIProvider } from "./contexts/PdfUIContext";
import { useDocumentSession, useDocumentSessionState } from "./hooks/useDocumentSession";
import { useViewport, useViewportState } from "./hooks/useViewport";
import { useAnnotations, useAnnotationsState } from "./hooks/useAnnotations";
import { useNativeAnnotations, useNativeAnnotationsState } from "./hooks/useNativeAnnotations";
import { useExport, useExportState } from "./hooks/useExport";
import { useNotifications, useNotificationsState, useReaderDerived, useReaderUI, useReaderUIState } from "./hooks/useReaderUI";
import { useSidebarSync, useSidebarSyncState } from "./hooks/useSidebarSync";
import { useLeaveGuard, useLeaveGuardState } from "./hooks/useLeaveGuard";
import { useVersionRecovery } from "./hooks/useVersionRecovery";
import "pdfjs-dist/web/pdf_viewer.css";
import "../ui/management.css";
import "./pdf.css";

export function PdfReader() {
  // Allocate domain state before connecting transactions that reset several
  // domains together. Effects and commands remain with their owning hook.
  const document = useDocumentSessionState();
  const viewport = useViewportState();
  const annotations = useAnnotationsState();
  const native = useNativeAnnotationsState();
  const exports = useExportState();
  const ui = useReaderUIState();
  const sidebar = useSidebarSyncState();
  const leave = useLeaveGuardState();
  const notifications = useNotificationsState();
  const state = {
    ...document,
    ...viewport,
    ...annotations,
    ...native,
    ...exports,
    ...ui,
    ...sidebar,
    ...leave,
    ...notifications,
  };
  const snapshot = { ...state, ...useReaderDerived(state) };

  // Bind commands after every domain renders. Async work still captures its
  // own session/intent; the ref only resolves commands across domain cycles.
  const actions = useRef<ReaderActions>(undefined!);
  const recovery = useVersionRecovery(snapshot, actions);
  const documentActions = useDocumentSession(snapshot, actions);
  const viewportActions = useViewport(snapshot, actions);
  const annotationActions = useAnnotations(snapshot, actions);
  const nativeActions = useNativeAnnotations(snapshot, actions);
  const exportActions = useExport(snapshot, actions);
  const uiActions = useReaderUI(snapshot, actions);
  useSidebarSync(snapshot, actions);
  const leaveActions = useLeaveGuard(snapshot, actions);
  const notificationActions = useNotifications(snapshot);
  actions.current = {
    ...documentActions,
    ...viewportActions,
    ...annotationActions,
    ...nativeActions,
    ...exportActions,
    ...uiActions,
    ...leaveActions,
    ...notificationActions,
  };
  const {
    focusBusy, focusHint, focusMode, guardSaving, inlineNotes, leaving, locked,
    moreOpen, moreTrigger, opened, pageNumber, pendingLeave, picked, presetDraft,
    presetReadGeneration, presetSaving, presets, presetsOpen, removing, selection,
    setArea, setMoreOpen, setPicked, setPresets, setPresetsOpen, setSelection,
    setSourceOpen, setUndoRecord, settings, showMarks, sourceOpen, t, undoRecord,
  } = snapshot;
  const {
    choosePreset, exitFocus, jump, keepEditing, openNotes, remove, restoreRemoved,
  } = actions.current;

  function readerKeys(event: React.KeyboardEvent<HTMLElement>) {
    const editable = event.target instanceof Element && event.target.closest(
      "input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='dialog'], .pdf-native-layer",
    );
    const presetIndex = presetIndexFromKey(event.nativeEvent);
    if (!event.defaultPrevented && !editable && !pendingLeave && !sourceOpen &&
      !presetsOpen && presetIndex !== undefined) {
      const preset = presets[presetIndex];
      if (preset && choosePreset(preset)) event.preventDefault();
      return;
    }
    if (event.key !== "Escape" || guardSaving || leaving || presetsOpen) return;
    if (recovery.open) recovery.close();
    else if (recovery.active && !recovery.busy) recovery.cancel();
    else if (pendingLeave) keepEditing();
    else if (sourceOpen) setSourceOpen(false);
    else if (focusBusy) {
      event.preventDefault();
      exitFocus();
      setMoreOpen(false);
    } else if (focusMode && !(event.target instanceof Element && event.target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], .pdf-native-layer",
    ))) {
      event.preventDefault();
      exitFocus();
    } else {
      if (moreOpen) moreTrigger.current?.focus();
      setMoreOpen(false);
      setSelection(undefined);
      setPicked(undefined);
      setArea(false);
    }
  }

  return (
    <PdfDocumentContext.Provider value={opened}>
      <PdfUIProvider language={settings.language}>
        <main className="pdf-app" data-focus={focusMode} onKeyDown={readerKeys}>
          {opened
            ? <PdfToolbar state={snapshot} actions={actions.current} requestedSearch={recovery.requestedSearch} recoveryOpen={recovery.open} />
            : <PdfWelcomeHeader state={snapshot} actions={actions.current} />}
          <PdfReaderMessages state={snapshot} actions={actions.current} onReviewPrevious={recovery.review}
            onRetrySaved={() => { if (recovery.active) recovery.cancel(); }} recovering={!!recovery.active} />
          {recovery.active && <div className="pdf-message" role="status">
            <span>{recovery.active.kind === "pdf-text"
              ? t("核对搜索结果，选择新文件中的文字后确认。", "Check the search results, select text in this file, then confirm.")
              : recovery.area ? t("核对框选区域后确认。", "Check the selected area, then confirm.")
                : t("请在新文件中框选对应区域。", "Select the matching area in this file.")}</span>
            {recovery.active.kind === "pdf-area" && recovery.area && <button disabled={locked || recovery.busy}
              onClick={() => { if (recovery.area) void recovery.restore(recovery.area); }}>{t("复制旧标注到此处", "Copy previous annotation here")}</button>}
            <button disabled={recovery.busy} onClick={recovery.review}>{t("选择其他标注", "Choose another annotation")}</button>
            <button disabled={recovery.busy} onClick={recovery.cancel}>{t("取消", "Cancel")}</button>
          </div>}
          {opened ? <>
            {focusMode && <FocusControls
              language={settings.language}
              pageNumber={pageNumber}
              totalPages={opened.document.numPages}
              blocked={locked}
              onJump={jump}
              onExit={exitFocus}
              onNotes={openNotes}
              sidebarHint={focusHint}
            />}
            {selection && <PdfSelectionBar state={snapshot} actions={actions.current}
              recovering={recovery.active?.kind === "pdf-text"} recoveryBusy={recovery.busy} onRecover={() => void recovery.restore(selection.target)} />}
            {picked && showMarks && <div className="pdf-mark-menu" role="status">
              <span>{picked.kind === "pdf-text"
                ? t("文字标注", "Text annotation")
                : t("区域标注", "Area annotation")}</span>
              <button disabled={locked} onClick={() => void remove(picked)}>
                {t("取消标注", "Remove annotation")}
              </button>
              <button onClick={() => setPicked(undefined)}>{t("关闭", "Close")}</button>
            </div>}
            {undoRecord && <div className="pdf-undo" role="status">
              <span>{t("标注已移除。", "Annotation removed.")}</span>
              <button disabled={locked} onClick={() => void restoreRemoved()}>
                {t("撤销移除", "Undo remove")}
              </button>
              <button disabled={removing} onClick={() => setUndoRecord(undefined)}>
                {t("关闭", "Close")}
              </button>
            </div>}
            <div className={`pdf-workspace${inlineNotes ? " notes-open" : ""}`}>
              <PdfCanvas state={snapshot} actions={actions.current}
                recoveryArea={recovery.active?.kind === "pdf-area" && recovery.area
                  ? { target: recovery.area, color: recovery.active.color } : undefined}
                onRecoveryArea={recovery.active?.kind === "pdf-area" ? recovery.selectArea : undefined} />
              <PdfInlineNotesPanel state={snapshot} actions={actions.current} />
            </div>
          </> : <PdfWelcomeScreen state={snapshot} actions={actions.current} />}
          {presetsOpen && <div className="pdf-dialog-backdrop">
            <AnnotationPresetEditor
              presets={presets}
              language={settings.language}
              onDirtyChange={(dirty) => { presetDraft.current = dirty; }}
              onSavingChange={(writing) => { presetSaving.current = writing; }}
              onSave={async (next) => {
                await saveAnnotationPresets(next);
                presetReadGeneration.current++;
                setPresets(next);
              }}
              onClose={() => {
                setPresetsOpen(false);
                moreTrigger.current?.focus();
              }}
            />
          </div>}
          {sourceOpen && <PdfSourceDialog state={snapshot} actions={actions.current} />}
          {recovery.open && snapshot.previousHash && <PdfVersionRecovery key={`${document.documentSession}:${snapshot.previousHash}`}
            hash={snapshot.previousHash} locked={locked || recovery.busy} onChoose={recovery.choose} onClose={recovery.close}
            dialogKeys={actions.current.dialogKeys} />}
          {pendingLeave && <LeaveConfirmDialog state={snapshot} actions={actions.current} />}
        </main>
      </PdfUIProvider>
    </PdfDocumentContext.Provider>
  );
}
