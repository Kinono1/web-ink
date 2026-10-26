import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { request, releaseChromeListener } from "../../core/client";
import { DEFAULT_SETTINGS, type Settings } from "../../core/model";
import {
  readSelectionToolbarEnabled,
  SELECTION_TOOLBAR_KEY,
  writeSelectionToolbarEnabled,
} from "../../core/selection-toolbar";
import { applyPageTheme } from "../page-theme";
import { COPY } from "../management/copy";
import type { NoticeMessage } from "../management/types";

export function useManagementSettings(setError: (message: string) => void) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  const settingsQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsVersion = useRef(0);
  const pendingSettings = useRef(0);
  const [selectionToolbarEnabled, setSelectionToolbarEnabled] = useState(false);
  const [selectionToolbarSaving, setSelectionToolbarSaving] = useState(false);
  const selectionToolbarVersion = useRef(0);
  settingsRef.current = settings;
  const receiveSettings = useCallback((next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);
  useEffect(() => {
    let active = true;
    const initialVersion = selectionToolbarVersion.current;
    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (!active || areaName !== "local" || !Object.hasOwn(changes, SELECTION_TOOLBAR_KEY))
        return;
      selectionToolbarVersion.current++;
      const change = changes[SELECTION_TOOLBAR_KEY];
      setSelectionToolbarEnabled(change?.newValue === true);
    };
    try {
      chrome.storage.onChanged?.addListener(changed);
    } catch { /* A revoked context cannot subscribe. */ }
    void readSelectionToolbarEnabled().then((value) => {
      if (active && selectionToolbarVersion.current === initialVersion)
        setSelectionToolbarEnabled(value);
    });
    return () => {
      active = false;
      try {
        releaseChromeListener(() => chrome.storage.onChanged?.removeListener(changed));
      } catch { /* The context may be gone. */ }
    };
  }, []);
  useLayoutEffect(() => applyPageTheme(settings.theme), [settings.theme]);
  useEffect(() => {
    const listener = (message: NoticeMessage) => {
      if (message.type !== "settings.changed" || pendingSettings.current) return;
      void request<Settings>({ type: "settings.get" })
        .then((next) => {
          if (!pendingSettings.current) receiveSettings(next);
        })
        .catch(() => undefined);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      releaseChromeListener(() => chrome.runtime.onMessage.removeListener(listener));
    };
  }, [receiveSettings]);
  const saveSettings = (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    const version = ++settingsVersion.current;
    settingsRef.current = next;
    pendingSettings.current++;
    setSettings(next);
    settingsQueue.current = settingsQueue.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const saved = await request<Settings>({
            type: "settings.put",
            settings: next,
          });
          if (version === settingsVersion.current) {
            settingsRef.current = saved;
            setSettings(saved);
          }
        } catch (cause) {
          if (version === settingsVersion.current)
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          pendingSettings.current--;
        }
      });
  };
  const toggleSelectionToolbar = async () => {
    if (selectionToolbarSaving) return;
    const next = !selectionToolbarEnabled;
    const version = ++selectionToolbarVersion.current;
    setSelectionToolbarSaving(true);
    try {
      await writeSelectionToolbarEnabled(next);
      if (version === selectionToolbarVersion.current)
        setSelectionToolbarEnabled(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSelectionToolbarSaving(false);
    }
  };
  const setOriginPaused = (origin: string | undefined, paused: boolean) => {
    const origins = settingsRef.current.disabledOrigins;
    const disabledOrigins = paused
      ? (origin ? [...origins, origin] : origins)
      : origins.filter((item) => item !== origin);
    saveSettings({ disabledOrigins });
  };
  return {
    settings,
    language: settings.language,
    t: COPY[settings.language],
    receiveSettings,
    saveSettings,
    setOriginPaused,
    selectionToolbarEnabled,
    selectionToolbarSaving,
    toggleSelectionToolbar,
  };
}
