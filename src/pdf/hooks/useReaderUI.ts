import { defaultAnnotationPresets, readAnnotationPresets, validateAnnotationPresets, type AnnotationPreset, } from "../../core/annotation-presets";
import { errorText } from "../../core/pdf-types";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { request, releaseChromeListener } from "../../core/client";
import { COLORS, DEFAULT_SETTINGS, type Settings } from "../../core/model";
import { THEME_TOKENS } from "../../core/theme";
import type { PdfAnnotation, NativePdfAnnotation } from "../../core/pdf-types";
import { ieeePaperUrl } from "../../core/pdf-context";
import { doiUrl } from "../paper-identity";
import { dirtyDraft, type LeaveAction, safeSource, type ReaderState, type ReaderSnapshot, type ReaderActionsRef } from "./contracts";

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
type Inputs = Pick<ReaderSnapshot,
  "container" | "documentSession" | "documentSessionRef" | "deletedDrafts" | "dirtyNotes" | "draftsRef" | "focusAttempt" | "focusMode" | "focusScroll" | "inlineNotes" | "locked" | "moreMenu" | "moreOpen" | "notesRail" | "pendingLeave" |
  "presetReadGeneration" | "presetsOpen" | "readerTab" | "readerWindow" | "selection" | "setColor" | "setError" | "setFallbackNotes" | "setFocusBusy" | "setFocusHint" | "setFocusMode" | "setMoreOpen" | "setNotesOpen" | "setPresets" | "setSettings" | "setSettingsReady" |
  "settings" | "settingsReady" | "sidebarAttachedRef" | "sourceOpen" | "supportsSidebar" | "t">;

export function useReaderUI(state: Inputs, actions: ReaderActionsRef<"mark">,) {
  const { container, documentSession, documentSessionRef, deletedDrafts, dirtyNotes, draftsRef, focusAttempt, focusMode, focusScroll,
    inlineNotes, locked, moreMenu, moreOpen, notesRail, pendingLeave, presetReadGeneration, presetsOpen, readerTab, readerWindow,
    selection, setColor, setError, setFallbackNotes, setFocusBusy, setFocusHint, setFocusMode, setMoreOpen, setNotesOpen,
      setPresets, setSettings, setSettingsReady, settings, settingsReady, sidebarAttachedRef, sourceOpen, supportsSidebar, t, } = state;
  useEffect(() => () => {
    focusAttempt.current++;
  }, []);
  const cancelFocusAttempt = useCallback(() => {
    focusAttempt.current++;
    setFocusBusy(false);
    setFocusMode(false);
  }, [focusAttempt, setFocusBusy, setFocusMode]);
  const openNotes = useCallback(() => {
    cancelFocusAttempt();
    if (!supportsSidebar) { setNotesOpen((open) => !open); return; }
    setNotesOpen(true);
    if (readerTab.current === undefined) {
      setError(t("请点击浏览器工具栏 Web Ink 打开标注侧栏。", "Click Web Ink in the browser toolbar to open annotations."));
      return;
    }
    // Must run on the click, before saving yields the user gesture.
    void chrome.sidePanel.open({ tabId: readerTab.current }).then(() => setFallbackNotes(false)).catch(() => {
      if (!sidebarAttachedRef.current) setFallbackNotes(true);
      setError(t("侧栏暂时无法打开，请重试或点击工具栏 Web Ink。", "The sidebar could not open. Retry or click Web Ink in the toolbar."));
    });
  }, [cancelFocusAttempt, supportsSidebar, setNotesOpen, readerTab, setError, t, setFallbackNotes, sidebarAttachedRef]);
  useLayoutEffect(() => {
    if (inlineNotes && deletedDrafts.length && !pendingLeave && !sourceOpen)
      notesRail.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [inlineNotes, deletedDrafts.length, pendingLeave, sourceOpen]);
  useEffect(() => {
    if (!moreOpen) return;
    const outside = (event: PointerEvent) => {
      if (!moreMenu.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [moreOpen]);
  useEffect(() => {
    void request<Settings>({ type: "settings.get" }).then((next) => {
      setSettings(next);
      setSettingsReady(true);
    }).catch((cause) => setError(errorText(cause)));
    const listener = (m: { type?: string }) => {
      if (m.type === "settings.changed")
        void request<Settings>({ type: "settings.get" }).then(setSettings).catch((cause) => setError(errorText(cause)));
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => releaseChromeListener(() => chrome.runtime.onMessage.removeListener(listener));
  }, []);
  useEffect(() => {
    setColor(settings.defaultColor);
  }, [settings.defaultColor]);
  useEffect(() => {
    if (!settingsReady) return;
    let active = true;
    const generation = ++presetReadGeneration.current;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local" || !changes["ui.annotationPresets"]) return;
      presetReadGeneration.current++;
      try { setPresets(validateAnnotationPresets(changes["ui.annotationPresets"].newValue)); }
      catch { setPresets(defaultAnnotationPresets(settings.language)); }
    };
    chrome.storage.onChanged?.addListener(changed);
    void readAnnotationPresets(settings.language).then((next) => {
      if (active && generation === presetReadGeneration.current) setPresets(next);
    });
    return () => { active = false; releaseChromeListener(() => chrome.storage.onChanged?.removeListener(changed)); };
  }, [settingsReady, settings.language]);
  useLayoutEffect(() => {
    if (focusScroll.current !== undefined && container.current) {
      container.current.scrollTop = focusScroll.current;
      focusScroll.current = undefined;
    }
    if (focusMode) container.current?.focus({ preventScroll: true });
  }, [focusMode]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme =
        settings.theme === "dark" ||
        (settings.theme !== "light" && media.matches)
          ? "dark"
          : "light";
      for (const [k, v] of Object.entries(THEME_TOKENS[theme]))
        document.documentElement.style.setProperty(k, v);
      document.documentElement.style.colorScheme = theme;
      document.documentElement.dataset.reduceMotion = String(
        settings.reduceMotion === true,
      );
      document.documentElement.dataset.reduceTransparency = String(
        settings.reduceTransparency === true,
      );
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings]);
  const enterFocus = useCallback(async () => {
    if (documentSession !== documentSessionRef.current || locked || dirtyNotes || presetsOpen) return;
    const attempt = ++focusAttempt.current;
    setFocusBusy(true);
    let hint = supportsSidebar;
    try {
      if (typeof chrome.sidePanel?.close === "function" && readerWindow.current !== undefined) {
        // The reader uses the global panel; tabId-only close rejects on Chrome 145+.
        await chrome.sidePanel.close({ windowId: readerWindow.current });
        hint = false;
      }
    } catch { /* The visible manual-close hint is the older-browser/failure fallback. */ }
    if (documentSession !== documentSessionRef.current || attempt !== focusAttempt.current) return;
    setFocusBusy(false);
    if (Object.values(draftsRef.current).some(dirtyDraft)) return;
    focusScroll.current = container.current?.scrollTop;
    setNotesOpen(false);
    setMoreOpen(false);
    setFocusHint(hint);
    setFocusMode(true);
  }, [documentSession, documentSessionRef, locked, dirtyNotes, presetsOpen, focusAttempt, setFocusBusy, supportsSidebar,
    readerWindow, draftsRef, focusScroll, container, setNotesOpen, setMoreOpen, setFocusHint, setFocusMode,]);
  const exitFocus = useCallback(() => {
    cancelFocusAttempt();
    focusScroll.current = container.current?.scrollTop;
    container.current?.focus({ preventScroll: true });
  }, [cancelFocusAttempt, focusScroll, container]);
  const choosePreset = useCallback((preset: AnnotationPreset) => {
    const current = getSelection();
    if (documentSession !== documentSessionRef.current || !selection || locked || presetsOpen || !current?.rangeCount || current.isCollapsed) return false;
    const range = current.getRangeAt(0);
    const layer = container.current?.querySelector(`[data-page="${selection.target.pageNumber}"] .textLayer`);
    if (!layer || !layer.contains(range.startContainer) || !layer.contains(range.endContainer) || current.toString().trim() !== selection.target.exact) return false;
    const before = range.cloneRange(), after = range.cloneRange();
    before.selectNodeContents(layer); before.setEnd(range.startContainer, range.startOffset);
    after.selectNodeContents(layer); after.setStart(range.endContainer, range.endOffset);
    if (before.toString().slice(-64) !== selection.target.prefix || after.toString().slice(0, 64) !== selection.target.suffix) return false;
    setColor(preset.color);
    actions.current.mark(selection.target, "pdf-text", preset.color, false, [preset.label]);
    return true;
  }, [documentSession, documentSessionRef, selection, locked, presetsOpen, container, setColor, actions]);
  const dialogKeys = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }, []);
  return { cancelFocusAttempt, openNotes, enterFocus, exitFocus, choosePreset, dialogKeys };
}
// Transient reader notices share the UI feedback state and timer.
export function useNotificationsState() {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return { error, setError, notice, setNotice, noticeTimer };
}
type NotificationInputs = Pick<ReaderSnapshot, "noticeTimer" | "setNotice">;

export function useNotifications(state: NotificationInputs) {
  const { noticeTimer, setNotice, } = state;
  useEffect(() => () => {
    clearTimeout(noticeTimer.current);
  }, []);
  const tell = useCallback((message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 1800);
  }, []);
  return { tell };
}
type DerivedInputs = Pick<ReaderState,
  "nativeWindow" | "t" | "busy" | "documentSession" | "exportStage" | "fallbackNotes" | "focusBusy" | "guardSaving" | "handoff" | "leaving" | "nativeError" | "nativeFilter" | "nativeProgress" | "nativeRecords" | "noteDrafts" | "notesOpen" |
  "opened" | "paperDoi" | "records" | "removing" | "saving" | "sidebarAttached" | "supportsSidebar" | "unsaved" | "writeCount">;

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