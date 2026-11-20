import { useCallback, useMemo, useRef, useState } from "react";
import type { PDFDocumentLoadingTask } from "pdfjs-dist/types/src/display/api";
import { defaultAnnotationPresets } from "../../core/annotation-presets";
import { COLORS, DEFAULT_SETTINGS, type PdfHandoff, type Settings } from "../../core/model";
import { ieeePaperUrl } from "../../core/pdf-context";
import type { NativePdfAnnotation, OpenDocument, PdfAnnotation, SelectionPreview } from "../../core/pdf-types";
import type { PdfAnnotationFilter, PdfNoteDraft, PdfReaderRequest, PdfSidebarState } from "../../core/sidebar";
import type { NativePdfAnnotations } from "../native-annotations";
import { doiUrl } from "../paper-identity";
import { PageLayoutIndex, type PdfRotation } from "../reading-position";
import type { PdfSearchMatch } from "../search";
import type { connectPdfSidebar } from "../sidebar-connection";
import { dirtyDraft, safeSource, type LeaveAction, type PositionSession } from "./contracts";

/** Owns the one live PDF.js loading task and its source-read AbortController. */
export class PdfSession {
  #generation = 0;
  #abort?: AbortController;
  #task?: PDFDocumentLoadingTask;
  #disposing?: Promise<void>;
  get generation(): number {
    return this.#generation;
  }
  isCurrent(token: number): boolean {
    return token === this.#generation;
  }
  async begin(): Promise<{ token: number; signal: AbortSignal }> {
    const token = ++this.#generation;
    await this.disposeCurrent();
    if (!this.isCurrent(token))
      throw new DOMException("Superseded PDF session.", "AbortError");
    const abort = new AbortController();
    this.#abort = abort;
    return { token, signal: abort.signal };
  }
  setTask(token: number, task: PDFDocumentLoadingTask): void {
    if (!this.isCurrent(token)) {
      void task.destroy();
      return;
    }
    this.#task = task;
  }
  async dispose(): Promise<void> {
    ++this.#generation;
    await this.disposeCurrent();
  }
  async disposeCurrent(): Promise<void> {
    this.#abort?.abort();
    this.#abort = undefined;
    const task = this.#task;
    this.#task = undefined;
    if (!task) return this.#disposing;
    const run = task.destroy().catch(() => undefined);
    this.#disposing = run;
    await run;
    if (this.#disposing === run) this.#disposing = undefined;
  }
}

export const FALLBACK_SELECTION_STYLE: React.CSSProperties = {};

export function useDocumentSessionState() {
  const [initialParams] = useState(() => new URLSearchParams(location.search));
  const localFileEntry = initialParams.get("open") === "local";
  const handoffToken = initialParams.get("handoff");
  const autoOpenAttempted = useRef(false);
  const [source, setSource] = useState(initialParams.get("source") || "");
  const [opened, setOpened] = useState<OpenDocument>();
  const [paperDoi, setPaperDoi] = useState<string>();
  const [previousHash, setPreviousHash] = useState<string>();
  const [handoff, setHandoff] = useState<PdfHandoff | null>(null);
  const [handoffReady, setHandoffReady] = useState(!handoffToken);
  const [ieeeRecovery, setIeeeRecovery] = useState<"permission" | "retry" | "return">();
  const [busy, setBusy] = useState(false);
  const [documentSession, setDocumentSession] = useState(0);
  const session = useRef(new PdfSession());
  const documentSessionRef = useRef(0);
  return {
    initialParams, localFileEntry, handoffToken, autoOpenAttempted, source, setSource, opened,
    setOpened, paperDoi, setPaperDoi, previousHash, setPreviousHash, handoff, setHandoff,
    handoffReady, setHandoffReady, ieeeRecovery, setIeeeRecovery, busy, setBusy, documentSession,
    setDocumentSession, session, documentSessionRef,
  };
}

export function useViewportState() {
  const nativeFocus = useRef<{ session: number; pageNumber: number; top: number; intent: number } | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<PdfRotation>(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [searchMatch, setSearchMatch] = useState<PdfSearchMatch>();
  const pendingSearchPosition = useRef<{ pageNumber: number; intent: number } | undefined>(undefined);
  const [zoomText, setZoomText] = useState("100%");
  const [fitWidth, setFitWidth] = useState(false);
  const intrinsicDimensions = useRef(new Map<number, { width: number; height: number }>());
  const currentView = useRef({ zoom, rotation });
  const [selection, setSelection] = useState<SelectionPreview>();
  const selectionBar = useRef<HTMLDivElement>(null);
  const [selectionStyle, setSelectionStyle] = useState(FALLBACK_SELECTION_STYLE);
  const [positionError, setPositionError] = useState("");
  const [positionEpoch, setPositionEpoch] = useState(0);
  const positionSession = useRef<PositionSession | undefined>(undefined);
  const intentEpoch = useRef(0);
  const [pageWindow, setPageWindow] = useState({ start: 0, end: 3 });
  const container = useRef<HTMLDivElement>(null);
  const layoutIndex = useRef(new PageLayoutIndex());
  const measureFrame = useRef(0);
  const layoutGeneration = useRef(0);
  const pendingScrollAdjustment = useRef(0);
  const pendingMeasures = useRef(
      new Map<number, { width: number; height: number }>(),
    );
  const dimensions = useRef(new Map<number, { width: number; height: number }>());
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [measurementGeneration, setMeasurementGeneration] = useState(0);
  currentView.current = { zoom, rotation };
  return {
    nativeFocus, zoom, setZoom, rotation, setRotation, pageNumber, setPageNumber, searchMatch,
    setSearchMatch, pendingSearchPosition, zoomText, setZoomText, fitWidth, setFitWidth,
    intrinsicDimensions, currentView, selection, setSelection, selectionBar, selectionStyle,
    setSelectionStyle, positionError, setPositionError, positionEpoch, setPositionEpoch,
    positionSession, intentEpoch, pageWindow, setPageWindow, container, layoutIndex,
    measureFrame, layoutGeneration, pendingScrollAdjustment, pendingMeasures, dimensions,
    layoutEpoch, setLayoutEpoch, measurementGeneration, setMeasurementGeneration,
  };
}

export function useAnnotationsState() {
  const [records, setRecords] = useState<PdfAnnotation[]>([]);
  const recordsRef = useRef(records);
  const [picked, setPicked] = useState<PdfAnnotation>();
  const [undoRecord, setUndoRecord] = useState<PdfAnnotation>();
  const [unsaved, setUnsaved] = useState<PdfAnnotation>();
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notesLimit, setNotesLimit] = useState(50);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, PdfNoteDraft>>(
    {},
  );
  const draftsRef = useRef(noteDrafts);
  const unsavedRef = useRef(unsaved);
  const noteAfterSave = useRef(false);
  const annotationWrites = useRef(new Set<Promise<unknown>>());
  const [writeCount, setWriteCount] = useState(0);
  const [noteSaving, setNoteSaving] = useState<string>();
  const [noteConflicts, setNoteConflicts] = useState<Record<string, boolean>>({});
  const annotationChangeEpoch = useRef(0);
  recordsRef.current = records;
  draftsRef.current = noteDrafts;
  unsavedRef.current = unsaved;
  const savedIds = useMemo(() => new Set(records.map((record) => record.id)), [records]);
  const deletedDrafts = useMemo(() => Object.values(noteDrafts).filter(
    (draft) => dirtyDraft(draft) && !savedIds.has(draft.base.id),
  ), [noteDrafts, savedIds]);
  const sortedNotes = useMemo(
    () =>
      records
        .slice()
        .sort(
          (a, b) =>
            a.target.pageNumber - b.target.pageNumber ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        ),
    [records],
  );
  const recordsByPage = useMemo(() => {
    const pages = new Map<number, PdfAnnotation[]>();
    for (const record of records) {
      const page = pages.get(record.target.pageNumber);
      if (page) page.push(record);
      else pages.set(record.target.pageNumber, [record]);
    }
    return pages;
  }, [records]);
  return {
    savedIds, deletedDrafts, sortedNotes, recordsByPage,
    records, setRecords, recordsRef, picked, setPicked, undoRecord, setUndoRecord, unsaved,
    setUnsaved, saving, setSaving, removing, setRemoving, notesLimit, setNotesLimit, noteDrafts,
    setNoteDrafts, draftsRef, unsavedRef, noteAfterSave, annotationWrites, writeCount,
    setWriteCount, noteSaving, setNoteSaving, noteConflicts, setNoteConflicts,
    annotationChangeEpoch,
  };
}

export function useNativeAnnotationsState() {
  const originalNotes = useRef<NativePdfAnnotations | undefined>(undefined);
  const nativeScan = useRef<AbortController | undefined>(undefined);
  const [nativeRecords, setNativeRecords] = useState<NativePdfAnnotation[]>([]);
  const [nativeFilter, setNativeFilter] = useState<PdfAnnotationFilter>("web-ink");
  const [nativeLoading, setNativeLoading] = useState(false);
  const [nativeProgress, setNativeProgress] = useState<{ completed: number; total: number }>();
  const [nativeError, setNativeError] = useState("");
  const [nativeOffset, setNativeOffset] = useState(0);
  const nativeLimit = 50;
  const nativeHistory = useRef<number[]>([]);
  const nativeWindow = useMemo(() => {
    const records: NativePdfAnnotation[] = [];
    const encoder = new TextEncoder();
    let bytes = 2, end = nativeOffset, oversized = false;
    while (end < nativeRecords.length && records.length < nativeLimit) {
      const record = nativeRecords[end]!;
      const recordBytes = encoder.encode(JSON.stringify(record)).byteLength;
      const nextBytes = bytes + recordBytes + (records.length ? 1 : 0);
      if (nextBytes > 4 * 1024 * 1024) {
        if (!records.length) { end++; oversized = true; }
        break;
      }
      records.push(record);
      bytes = nextBytes;
      end++;
    }
    return { records, end, oversized };
  }, [nativeRecords, nativeOffset]);
  return {
    nativeWindow,
    originalNotes, nativeScan, nativeRecords, setNativeRecords, nativeFilter, setNativeFilter,
    nativeLoading, setNativeLoading, nativeProgress, setNativeProgress, nativeError,
    setNativeError, nativeOffset, setNativeOffset, nativeLimit, nativeHistory,
  };
}

export function useExportState() {
  const exportController = useRef<AbortController | undefined>(undefined);
  const [exportStage, setExportStage] = useState<"preparing" | "writing" | "verifying">();
  const downloadUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  return { exportController, exportStage, setExportStage, downloadUrls };
}

export function useReaderUIState() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [showMarks, setShowMarks] = useState(true);
  const [area, setArea] = useState(false);
  const [color, setColor] = useState<string>(COLORS[0]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusHint, setFocusHint] = useState(false);
  const focusScroll = useRef<number | undefined>(undefined);
  const focusAttempt = useRef(0);
  const [presets, setPresets] = useState(() => defaultAnnotationPresets(DEFAULT_SETTINGS.language));
  const [presetsOpen, setPresetsOpen] = useState(false);
  const presetReadGeneration = useRef(0);
  const presetDraft = useRef(false);
  const presetSaving = useRef(false);
  const moreMenu = useRef<HTMLDivElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const notesRail = useRef<HTMLElement>(null);
  const zh = settings.language === "zh-CN";
  const t = useCallback((cn: string, en: string) => (zh ? cn : en), [zh]);
  return {
    zh, t,
    settings, setSettings, settingsReady, setSettingsReady, showMarks, setShowMarks, area,
    setArea, color, setColor, notesOpen, setNotesOpen, moreOpen, setMoreOpen, sourceOpen,
    setSourceOpen, focusMode, setFocusMode, focusBusy, setFocusBusy, focusHint, setFocusHint,
    focusScroll, focusAttempt, presets, setPresets, presetsOpen, setPresetsOpen,
    presetReadGeneration, presetDraft, presetSaving, moreMenu, moreTrigger, notesRail,
  };
}

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

export function useLeaveGuardState() {
  const [pendingLeave, setPendingLeave] = useState<LeaveAction>();
  const [leaving, setLeaving] = useState(false);
  const [guardSaving, setGuardSaving] = useState(false);
  return { pendingLeave, setPendingLeave, leaving, setLeaving, guardSaving, setGuardSaving };
}

// Transient reader notices share the UI feedback state and timer.
export function useNotificationsState() {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return { error, setError, notice, setNotice, noticeTimer };
}

type DerivedInputs =
  Pick<DocumentSessionState, "busy" | "documentSession" | "handoff" | "opened" | "paperDoi"> &
  Pick<AnnotationState, "noteDrafts" | "records" | "removing" | "saving" | "unsaved" | "writeCount"> &
  Pick<NativeNotesState,
    "nativeWindow" | "nativeError" | "nativeFilter" | "nativeProgress" | "nativeRecords"
  > &
  Pick<ExportState, "exportStage"> &
  Pick<ReaderUIState, "t" | "focusBusy" | "notesOpen"> &
  Pick<SidebarState, "fallbackNotes" | "sidebarAttached" | "supportsSidebar"> &
  Pick<LeaveGuardState, "guardSaving" | "leaving">;

export function useReaderDerived(state: DerivedInputs) {
  const { nativeWindow, t, busy, documentSession, exportStage, fallbackNotes, focusBusy, guardSaving, handoff, leaving, nativeError,
    nativeFilter, nativeProgress, nativeRecords, noteDrafts, notesOpen, opened, paperDoi, records, removing, saving, sidebarAttached,
    supportsSidebar, unsaved, writeCount, } = state;
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

export type DocumentSessionState = ReturnType<typeof useDocumentSessionState>;
export type ViewportState = ReturnType<typeof useViewportState>;
export type AnnotationState = ReturnType<typeof useAnnotationsState>;
export type NativeNotesState = ReturnType<typeof useNativeAnnotationsState>;
export type ExportState = ReturnType<typeof useExportState>;
export type ReaderUIState = ReturnType<typeof useReaderUIState>;
export type SidebarState = ReturnType<typeof useSidebarSyncState>;
export type LeaveGuardState = ReturnType<typeof useLeaveGuardState>;
export type NotificationState = ReturnType<typeof useNotificationsState>;
export type ReaderDerivedState = ReturnType<typeof useReaderDerived>;

export type ReaderSnapshot =
    DocumentSessionState
  & ViewportState
  & AnnotationState
  & NativeNotesState
  & ExportState
  & ReaderUIState
  & SidebarState
  & LeaveGuardState
  & NotificationState
  & ReaderDerivedState;
