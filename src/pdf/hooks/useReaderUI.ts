import {
  defaultAnnotationPresets, readAnnotationPresets, validateAnnotationPresets,
  type AnnotationPreset,
} from "../../core/annotation-presets";
import { errorText } from "../types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { request, releaseChromeListener } from "../../core/client";
import { COLORS, DEFAULT_SETTINGS, type Settings } from "../../core/model";
import { THEME_TOKENS } from "../../ui/theme";
import { dirtyDraft } from "./reader-utils";
import type { ReaderSnapshot, ReaderActionsRef } from "./contracts";

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
  const t = (cn: string, en: string) => (zh ? cn : en);

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
  "container" | "deletedDrafts" | "dirtyNotes" | "draftsRef" | "focusAttempt" | "focusMode" |
  "focusScroll" | "inlineNotes" | "locked" | "moreMenu" | "moreOpen" | "notesRail" |
  "pendingLeave" | "presetReadGeneration" | "presetsOpen" | "readerTab" | "readerWindow" |
  "selection" | "setColor" | "setError" | "setFallbackNotes" | "setFocusBusy" |
  "setFocusHint" | "setFocusMode" | "setMoreOpen" | "setNotesOpen" | "setPresets" |
  "setSettings" | "setSettingsReady" | "settings" | "settingsReady" | "sidebarAttachedRef" |
  "sourceOpen" | "supportsSidebar" | "t"
>;

export function useReaderUI(
  state: Inputs,
  actions: ReaderActionsRef<"mark">,
) {
  const {
    container, deletedDrafts, dirtyNotes, draftsRef, focusAttempt, focusMode, focusScroll,
    inlineNotes, locked, moreMenu, moreOpen, notesRail, pendingLeave, presetReadGeneration,
    presetsOpen, readerTab, readerWindow, selection, setColor, setError, setFallbackNotes,
    setFocusBusy, setFocusHint, setFocusMode, setMoreOpen, setNotesOpen, setPresets,
    setSettings, setSettingsReady, settings, settingsReady, sidebarAttachedRef, sourceOpen,
    supportsSidebar, t,
  } = state;

  useEffect(() => () => {
    focusAttempt.current++;
  }, []);

  function cancelFocusAttempt() {
    focusAttempt.current++;
    setFocusBusy(false);
    setFocusMode(false);
  }

  function openNotes() {
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
  }

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

  async function enterFocus() {
    if (locked || dirtyNotes || presetsOpen) return;
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
    if (attempt !== focusAttempt.current) return;
    setFocusBusy(false);
    if (Object.values(draftsRef.current).some(dirtyDraft)) return;
    focusScroll.current = container.current?.scrollTop;
    setNotesOpen(false);
    setMoreOpen(false);
    setFocusHint(hint);
    setFocusMode(true);
  }

  function exitFocus() {
    cancelFocusAttempt();
    focusScroll.current = container.current?.scrollTop;
    container.current?.focus({ preventScroll: true });
  }

  function choosePreset(preset: AnnotationPreset) {
    const current = getSelection();
    if (!selection || locked || presetsOpen || !current?.rangeCount || current.isCollapsed) return false;
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
  }

  function dialogKeys(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return { cancelFocusAttempt, openNotes, enterFocus, exitFocus, choosePreset, dialogKeys };
}
