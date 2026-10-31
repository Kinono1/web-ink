import { errorText } from "../../core/pdf-types";
import { useEffect, useState } from "react";
import { request, RequestError } from "../../core/client";
import { type PdfReturnResult } from "../../core/model";
import { ieeePaperUrl } from "../../core/pdf-context";
import { doiUrl, readPdfPaperIdentity } from "../paper-identity";
import { dirtyDraft, type LeaveAction, type ReaderSnapshot, type ReaderActionsRef } from "./contracts";

export function useLeaveGuardState() {
  const [pendingLeave, setPendingLeave] = useState<LeaveAction>();
  const [leaving, setLeaving] = useState(false);
  const [guardSaving, setGuardSaving] = useState(false);
  return { pendingLeave, setPendingLeave, leaving, setLeaving, guardSaving, setGuardSaving };
}
type Inputs = Pick<ReaderSnapshot,
  "annotationWrites" | "autoOpenAttempted" | "currentParams" | "draftsRef" | "exportController" | "focusBusy" | "focusMode" | "guardSaving" | "handoff" | "handoffToken" | "intentEpoch" | "leaving" | "nativeScan" | "noteAfterSave" | "paperDoi" |
  "paperUrl" | "pendingLeave" | "positionSession" | "presetDraft" | "presetSaving" | "previousHash" | "publicUrl" | "setError" | "setGuardSaving" | "setHandoff" | "setLeaving" | "setMoreOpen" | "setNativeFilter" | "setNoteConflicts" | "setNoteDrafts" | "setNotesOpen" |
  "setPendingLeave" | "setSelection" | "setSourceOpen" | "setUnsaved" | "sidebarAttachedRef" | "supportsSidebar" | "t" | "unsavedRef">;

export function useLeaveGuard(state: Inputs, actions:
  ReaderActionsRef< "cancelExport" | "cancelFocusAttempt" | "cancelNativeScan" | "exportAnnotations" | "flushPosition" | "loadPdf" | "openNotes" | "save" | "saveNote" >,) {
  const { annotationWrites, autoOpenAttempted, currentParams, draftsRef, exportController, focusBusy, focusMode, guardSaving, handoff,
    handoffToken, intentEpoch, leaving, nativeScan, noteAfterSave, paperDoi, paperUrl, pendingLeave, positionSession, presetDraft,
    presetSaving, previousHash, publicUrl, setError, setGuardSaving, setHandoff, setLeaving, setMoreOpen, setNativeFilter, setNoteConflicts,
      setNoteDrafts, setNotesOpen, setPendingLeave, setSelection, setSourceOpen, setUnsaved, sidebarAttachedRef, supportsSidebar, t,
    unsavedRef, } = state;
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!unsavedRef.current && !annotationWrites.current.size && !Object.values(draftsRef.current).some(dirtyDraft) && !presetDraft.current && !presetSaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const hide = () => {
      exportController.current?.abort();
      nativeScan.current?.abort();
      void positionSession.current?.writer.flush().catch(() => undefined);
      // Page teardown may prevent this best-effort message; a replacement
      // reader is independently denied by the background's document binding.
      if (handoffToken) void request({ type: "pdf.handoff.revoke", token: handoffToken }).catch(() => undefined);
    };
    window.addEventListener("beforeunload", guard);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("beforeunload", guard);
      window.removeEventListener("pagehide", hide);
    };
  }, []);
  async function executeLeave(action: LeaveAction) {
    if (leaving) return;
    if (action.kind === "ai" || action.kind === "export") {
      setPendingLeave(undefined);
      void actions.current.exportAnnotations(action.kind);
      return;
    }
    if (exportController.current) actions.current.cancelExport();
    setLeaving(true);
    try {
      await actions.current.flushPosition();
      actions.current.cancelNativeScan();
      if (handoff?.accessMode === "site-session" && (action.kind === "library" || action.kind === "previous" || action.kind === "source" || action.kind === "paper"))
        await request({ type: "pdf.handoff.revoke", token: handoff.token });
      switch (action.kind) {
        case "return":
          if (!handoff) throw Error(t("原阅读器会话已失效，请打开 PDF 来源或重新选择本地文件。", "Original-reader session expired. Open the public source or choose the local file again."));
          await request<PdfReturnResult>({ type: "pdf.returnOriginal", token: handoff.token });
          break;
        case "source":
          if (publicUrl) location.assign(doiUrl(paperDoi) || ieeePaperUrl(publicUrl) || publicUrl);
          else setSourceOpen(true);
          break;
        case "paper":
          const identity = await readPdfPaperIdentity(currentParams.get("document") || undefined, handoff?.returnUrl || publicUrl);
          const destination = doiUrl(paperDoi || identity?.doi) || paperUrl;
          if (destination) location.assign(destination);
          else setSourceOpen(true);
          break;
        case "library": location.assign(chrome.runtime.getURL("/library.html")); break;
        case "previous":
          if (previousHash) location.assign(chrome.runtime.getURL(`/library.html?document=${previousHash}`));
          break;
        case "choose": setSourceOpen(true); break;
        case "open": await actions.current.loadPdf(action.file, false, action.source); break;
      }
      setPendingLeave(undefined);
    } catch (cause) {
      if (action.kind === "return" && cause instanceof RequestError &&
        (cause.code === "PDF_SOURCE_UNAVAILABLE" || cause.code === "FORBIDDEN")) setHandoff(null);
      setError(errorText(cause));
    } finally { setLeaving(false); }
  }
  function requestLeave(action: LeaveAction) {
    if ((action.kind === "export" || action.kind === "ai") && exportController.current) return;
    if (focusBusy || focusMode) actions.current.cancelFocusAttempt();
    if (action.kind === "open") {
      autoOpenAttempted.current = true;
      // Cancel old initialization without queuing another old-document write.
      intentEpoch.current++;
      if (positionSession.current) positionSession.current.pending = undefined;
    }
    setMoreOpen(false);
    if (unsavedRef.current || annotationWrites.current.size || Object.values(draftsRef.current).some(dirtyDraft)) {
      setPendingLeave(action);
      return;
    }
    void executeLeave(action);
  }
  async function saveAndContinue() {
    if (!pendingLeave || guardSaving) return;
    setGuardSaving(true);
    try {
      await Promise.all([...annotationWrites.current]);
      if (unsavedRef.current) await actions.current.save(unsavedRef.current, noteAfterSave.current);
      for (const [id, draft] of Object.entries(draftsRef.current)) {
        if (dirtyDraft(draft)) await actions.current.saveNote(id, draft);
      }
      await executeLeave(pendingLeave);
    } catch (cause) { setError(errorText(cause)); }
    finally { setGuardSaving(false); }
  }
  function discardAndContinue() {
    if (!pendingLeave || annotationWrites.current.size || guardSaving) return;
    unsavedRef.current = undefined;
    setUnsaved(undefined);
    draftsRef.current = {};
    setNoteDrafts({});
    setNoteConflicts({});
    setSelection(undefined);
    getSelection()?.removeAllRanges();
    setError("");
    void executeLeave(pendingLeave);
  }
  function keepEditing() {
    setPendingLeave(undefined);
    if (Object.values(draftsRef.current).some(dirtyDraft)) {
      setNativeFilter("web-ink");
      actions.current.cancelNativeScan();
      setNotesOpen(true);
      if (supportsSidebar && !sidebarAttachedRef.current) actions.current.openNotes();
    }
  }
  return { executeLeave, requestLeave, saveAndContinue, discardAndContinue, keepEditing };
}