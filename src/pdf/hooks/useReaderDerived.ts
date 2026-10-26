import { type PdfAnnotation, type NativePdfAnnotation } from "../types";
import { useMemo } from "react";
import { ieeePaperUrl } from "../context";
import { doiUrl } from "../paper-identity";
import { dirtyDraft, type LeaveAction, safeSource } from "./reader-utils";
import type { ReaderState } from "./contracts";

type Inputs = Pick<ReaderState,
  "nativeWindow" | "t" | "busy" | "documentSession" | "exportStage" | "fallbackNotes" |
  "focusBusy" | "guardSaving" | "handoff" | "leaving" | "nativeError" | "nativeFilter" |
  "nativeProgress" | "nativeRecords" | "noteDrafts" | "notesOpen" | "opened" | "paperDoi" |
  "records" | "removing" | "saving" | "sidebarAttached" | "supportsSidebar" | "unsaved" |
  "writeCount"
>;

export function useReaderDerived(state: Inputs) {
  const {
    nativeWindow, t, busy, documentSession, exportStage, fallbackNotes, focusBusy,
    guardSaving, handoff, leaving, nativeError, nativeFilter, nativeProgress, nativeRecords,
    noteDrafts, notesOpen, opened, paperDoi, records, removing, saving, sidebarAttached,
    supportsSidebar, unsaved, writeCount,
  } = state;
  const sidebarSession = useMemo(() => crypto.randomUUID(), [documentSession]);
  const key = opened ? `urn:web-ink:pdf:${opened.hash}` : undefined;
  const inlineNotes = notesOpen && (!supportsSidebar || fallbackNotes) && !sidebarAttached;
  const originalError = nativeWindow.oversized
    ? t("这条原文件笔记超过侧栏显示上限；完整内容仍保留在当前文档，可导出给 AI。", "This original note exceeds the sidebar display limit. Its full contents remain in this document and can be exported for AI.")
    : nativeError;
  const nativeComplete = nativeProgress?.completed === opened?.document.numPages;
  const noteCount = nativeFilter === "web-ink" ? records.length : nativeFilter === "original" ? nativeRecords.length : records.length + nativeRecords.length;
  const currentParams = new URLSearchParams(location.search);
  const publicUrl = opened ? safeSource(opened.sourceUrl) : safeSource(currentParams.get("source") || undefined);
  const paperUrl = doiUrl(paperDoi) || ieeePaperUrl(handoff?.returnUrl || publicUrl);
  const locked = busy || saving || removing || !!unsaved || leaving || guardSaving || writeCount > 0 || !!exportStage || focusBusy;
  const dirtyNotes = Object.values(noteDrafts).some(dirtyDraft);
  const backLabel = handoff ? t("返回原阅读器", "Return to original reader") : publicUrl
    ? t("打开 PDF 来源", "Open PDF source") : t("重新选择 PDF", "Choose PDF again");
  const backAction: LeaveAction = { kind: handoff ? "return" : publicUrl ? "source" : "choose" };
  return {
    sidebarSession, key, inlineNotes, originalError, nativeComplete,
    noteCount, currentParams, publicUrl,
    paperUrl, locked, dirtyNotes, backLabel, backAction,
  };
}
