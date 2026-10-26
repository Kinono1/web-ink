import { connectPdfSidebar } from "../sidebar-connection";
import type { PdfReaderRequest, PdfSidebarState } from "../sidebar-types";
import { errorText } from "../types";
import { useEffect, useRef, useState } from "react";
import type { ReaderSnapshot, ReaderActionsRef } from "./contracts";

export function useSidebarSyncState() {
  const readerTab = useRef<number | undefined>(undefined);
  const readerWindow = useRef<number | undefined>(undefined);
  const supportsSidebar = typeof chrome.sidePanel?.open === "function";
  const [fallbackNotes, setFallbackNotes] = useState(false);
  const [sidebarAttached, setSidebarAttached] = useState(false);
  const sidebarAttachedRef = useRef(false);
  const sidebarClient = useRef<ReturnType<typeof connectPdfSidebar> | undefined>(undefined);
  const sidebarHandler = useRef<(message: PdfReaderRequest) => void>(() => {});
  const sidebarView = useRef<PdfSidebarState | null>(null);
  const [sidebarAck, setSidebarAck] = useState<string>();
  return {
    readerTab, readerWindow, supportsSidebar, fallbackNotes, setFallbackNotes, sidebarAttached,
    setSidebarAttached, sidebarAttachedRef, sidebarClient, sidebarHandler, sidebarView,
    sidebarAck, setSidebarAck,
  };
}

type Inputs = Pick<ReaderSnapshot,
  "annotationWrites" | "busy" | "draftsRef" | "error" | "key" | "locked" | "nativeFilter" |
  "nativeLimit" | "nativeLoading" | "nativeOffset" | "nativeProgress" | "nativeRecords" |
  "nativeWindow" | "noteConflicts" | "noteDrafts" | "noteSaving" | "notesLimit" | "notice" |
  "opened" | "originalError" | "pendingLeave" | "readerTab" | "readerWindow" | "records" |
  "recordsRef" | "removing" | "setError" | "setFallbackNotes" | "setNoteConflicts" |
  "setNotesLimit" | "setPicked" | "setSidebarAck" | "setSidebarAttached" | "sidebarAck" |
  "sidebarAttachedRef" | "sidebarClient" | "sidebarHandler" | "sidebarSession" |
  "sidebarView" | "sortedNotes" | "sourceOpen" | "undoRecord" | "unsavedRef"
>;

export function useSidebarSync(
  state: Inputs,
  actions: ReaderActionsRef<
    "cancelNativeScan" | "filterAnnotations" | "focusOriginalNote" | "jump" |
    "nextOriginalPage" | "previousOriginalPage" | "remove" | "restoreRemoved" | "saveNote" |
    "updateDraft"
  >,
) {
  const {
    annotationWrites, busy, draftsRef, error, key, locked, nativeFilter, nativeLimit,
    nativeLoading, nativeOffset, nativeProgress, nativeRecords, nativeWindow, noteConflicts,
    noteDrafts, noteSaving, notesLimit, notice, opened, originalError, pendingLeave,
    readerTab, readerWindow, records, recordsRef, removing, setError, setFallbackNotes,
    setNoteConflicts, setNotesLimit, setPicked, setSidebarAck, setSidebarAttached, sidebarAck,
    sidebarAttachedRef, sidebarClient, sidebarHandler, sidebarSession, sidebarView,
    sortedNotes, sourceOpen, undoRecord, unsavedRef,
  } = state;

  useEffect(() => {
    void chrome.tabs?.getCurrent?.()
      .then((tab) => { readerTab.current = tab?.id; readerWindow.current = tab?.windowId; })
      .catch((cause) => setError(errorText(cause)));
    if (!chrome.runtime.connect) return;
    const client = connectPdfSidebar("web-ink-pdf-reader", (message) => {
      if (message.type === "attached") {
        sidebarAttachedRef.current = message.attached;
        setSidebarAttached(message.attached);
        if (message.attached) setFallbackNotes(false);
      } else if (message.type === "command") sidebarHandler.current(message);
      else if (message.type === "unavailable") {
        sidebarAttachedRef.current = false;
        setSidebarAttached(false);
      }
    }, () => client.send({ type: "state", state: sidebarView.current }));
    sidebarClient.current = client;
    return () => { sidebarClient.current = undefined; client.dispose(); };
  }, []);
  const sidebarState: PdfSidebarState | null = opened && key && !busy ? {
    sessionId: sidebarSession, pageUrl: key, fileName: opened.fileName,
    totalCount: records.length,
    records: sortedNotes.filter((record, index) => index < notesLimit || noteDrafts[record.id]),
    drafts: noteDrafts, conflicts: noteConflicts,
    locked: locked || !!pendingLeave || sourceOpen,
    noteSaving, removing, undoRecord, error, notice,
    nativeFilter, nativeRecords: nativeWindow.records, nativeLoading, nativeProgress, nativeError: originalError,
    nativeTotalCount: nativeRecords.length, nativeOffset, nativeLimit, nativePageEnd: nativeWindow.end,
  } : null;
  sidebarView.current = sidebarState;

  useEffect(() => {
    sidebarClient.current?.send({ type: "state", state: sidebarState, ack: sidebarAck });
  }, [opened, key, busy, records, notesLimit, noteDrafts, noteConflicts, locked, pendingLeave, sourceOpen, noteSaving, removing, undoRecord, error, notice, sidebarAck, sidebarSession,
    nativeFilter, nativeRecords, nativeLoading, nativeProgress, originalError, nativeOffset, nativeWindow]);
  sidebarHandler.current = (message) => {
    if (message.type !== "command" || message.pageUrl !== key || message.sessionId !== sidebarSession) return;
    const { command, commandId } = message;
    const handle = async () => {
      if (command.type === "cancel-native") { actions.current.cancelNativeScan(); return; }
      if (command.type === "filter") { actions.current.filterAnnotations(command.filter); return; }
      if (command.type === "more-native") { actions.current.nextOriginalPage(); return; }
      if (command.type === "previous-native") { actions.current.previousOriginalPage(); return; }
      if (locked || pendingLeave || sourceOpen || annotationWrites.current.size || unsavedRef.current) return;
      const record = "id" in command ? recordsRef.current.find((record) => record.id === command.id) : undefined;
      switch (command.type) {
        case "focus-native": {
          const original = nativeWindow.records.find((record) => record.key === command.key);
          if (original) await actions.current.focusOriginalNote(original);
          break;
        }
        case "focus": if (record) { actions.current.jump(record.target.pageNumber); setPicked(record); } break;
        case "draft":
          if (record || draftsRef.current[command.id]) {
            actions.current.updateDraft(command.id, command.draft, command.resolveConflict);
            if (record && command.draft && command.draft.base.revision !== record.revision)
              setNoteConflicts((old) => ({ ...old, [command.id]: true }));
          }
          break;
        case "save": {
          const draft = draftsRef.current[command.id];
          if (draft && !noteConflicts[command.id]) await actions.current.saveNote(command.id, draft);
          break;
        }
        case "remove": if (record) await actions.current.remove(record); break;
        case "undo": await actions.current.restoreRemoved(); break;
        case "more": setNotesLimit((limit) => limit + 50); break;
      }
    };
    void handle().catch(() => undefined).finally(() => setSidebarAck(commandId));
  };
}
