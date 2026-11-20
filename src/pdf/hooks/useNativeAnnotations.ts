import type { PdfAnnotationFilter } from "../../core/sidebar";
import { nativePdfRect } from "../native-annotations";
import { fromPdfRect } from "../geometry";
import { errorText, type NativePdfAnnotation } from "../../core/pdf-types";
import { useCallback, useEffect } from "react";
import type { ReaderActionsRef } from "./contracts";
import type {
  DocumentSessionState,
  ViewportState,
  AnnotationState,
  NativeNotesState,
  ExportState,
} from "./reader-state";

type Inputs =
  Pick<DocumentSessionState, "documentSession" | "documentSessionRef" | "opened"> &
  Pick<ViewportState, "intentEpoch" | "nativeFocus" | "rotation" | "setPositionEpoch" | "zoom"> &
  Pick<AnnotationState, "setPicked"> &
  Pick<NativeNotesState,
    "nativeHistory" | "nativeOffset" | "nativeRecords" | "nativeScan" | "nativeWindow"
    | "originalNotes" | "setNativeError" | "setNativeFilter" | "setNativeLoading" | "setNativeOffset"
    | "setNativeProgress" | "setNativeRecords"
  > &
  Pick<ExportState, "exportController">;

export function useNativeAnnotations(state: Inputs, actions: ReaderActionsRef<"jump">,) {
  const { documentSession, documentSessionRef, exportController, intentEpoch, nativeFocus, nativeHistory, nativeOffset, nativeRecords,
    nativeScan, nativeWindow, opened, originalNotes, rotation, setNativeError, setNativeFilter, setNativeLoading, setNativeOffset,
    setNativeProgress, setNativeRecords, setPicked, setPositionEpoch, zoom, } = state;
  useEffect(() => () => {
    nativeScan.current?.abort();
    originalNotes.current?.dispose();
  }, []);
  const receiveOriginalNotes = useCallback((next: NativePdfAnnotation[]) => {
    if (documentSession !== documentSessionRef.current) return;
    const hash = originalNotes.current?.records[0]?.documentHash ?? opened?.hash;
    if (next.some((record) => record.documentHash !== hash)) return;
    setNativeRecords(originalNotes.current?.records.slice() ?? next);
  }, [documentSession, opened?.hash]);
  function cancelNativeScan() {
    nativeScan.current?.abort();
    nativeScan.current = undefined;
    setNativeLoading(false);
  }
  async function scanOriginalNotes() {
    const collector = originalNotes.current;
    if (!collector || nativeScan.current) return;
    const active = documentSessionRef.current;
    const controller = new AbortController();
    nativeScan.current = controller;
    setNativeLoading(true);
    setNativeError("");
    try {
      const all = await collector.loadAll(controller.signal, (completed, total) => {
        if (active !== documentSessionRef.current || controller.signal.aborted) return;
        setNativeProgress({ completed, total });
        setNativeRecords(collector.records);
      });
      if (active === documentSessionRef.current && !controller.signal.aborted) setNativeRecords(all);
    } catch (cause) {
      if (active === documentSessionRef.current && !controller.signal.aborted) setNativeError(errorText(cause));
    } finally {
      if (nativeScan.current === controller) { nativeScan.current = undefined; setNativeLoading(false); }
    }
  }
  function filterAnnotations(filter: PdfAnnotationFilter) {
    if (exportController.current) return;
    setNativeFilter(filter);
    if (filter === "web-ink") cancelNativeScan();
    else void scanOriginalNotes();
  }
  function nextOriginalPage() {
    if (nativeWindow.end >= nativeRecords.length) return;
    nativeHistory.current.push(nativeOffset);
    setNativeOffset(nativeWindow.end);
  }
  function previousOriginalPage() {
    setNativeOffset(nativeHistory.current.pop() ?? 0);
  }
  async function focusOriginalNote(record: NativePdfAnnotation) {
    if (!opened || record.documentHash !== opened.hash) return;
    const active = documentSessionRef.current;
    actions.current.jump(record.pageNumber);
    const intent = intentEpoch.current;
    setPicked(undefined);
    if (!record.rect) return;
    const page = await opened.document.getPage(record.pageNumber);
    if (active !== documentSessionRef.current || intent !== intentEpoch.current) return;
    const rect = nativePdfRect(record.rect, page.view);
    if (!rect) return;
    const viewport = page.getViewport({ scale: zoom, rotation: (page.rotate + rotation) % 360 });
    const position = fromPdfRect(rect, viewport, page.view);
    nativeFocus.current = { session: active, pageNumber: record.pageNumber, top: position.y, intent };
    setPositionEpoch((epoch) => epoch + 1);
  }
  return {
    receiveOriginalNotes, cancelNativeScan, scanOriginalNotes, filterAnnotations,
    nextOriginalPage, previousOriginalPage, focusOriginalNote,
  };
}
