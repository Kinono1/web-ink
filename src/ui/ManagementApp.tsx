import { useAnnotationQuery } from "./management/useAnnotationQuery";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { toMarkdown } from "../core/backup";
import { RequestError, request, releaseChromeListener } from "../core/client";
import {
  COLORS,
  DEFAULT_SETTINGS,
  type AnchorState,
  type Annotation,
  type AnnotationPage,
  type AnnotationQuery,
  type BackupEnvelope,
  type ImportPreview,
  type Language,
  type PageMode,
  type PdfOpenResult,
  type PdfTabContext,
  type Settings,
} from "../core/model";
import { isWebPage, pageKey } from "../core/url";
import { ICON_PATHS, type IconName } from "./icons";
import { PdfSidebar } from "./PdfSidebar";
import { AnnotationPresetEditor } from "./AnnotationPresets";
import { readAnnotationPresets, saveAnnotationPresets, type AnnotationPreset } from "../core/annotation-presets";
import { StoragePanel } from "./StoragePanel";
import { pdfPreparationLabel, ieeeFailureMessage, formatIeeeDiagnostic } from '../pdf/ieee-status';
import type { IeeePdfDiagnostic } from '../pdf/ieee-diagnostics';
import { applyPageTheme, installPageTheme } from "./page-theme";
import { readSelectionToolbarEnabled, SELECTION_TOOLBAR_KEY, writeSelectionToolbarEnabled } from "../core/selection-toolbar";
import { WebSelection } from "./WebSelection";
import "./management.css";
import "./sidepanel.css";

import type {
  Mode,
  Screen,
  TabContext,
  Draft,
  AnnotationKind,
  FilterKind,
  NoticeMessage,
} from "./management/types";
import { COPY } from "./management/copy";
import { openPdfTab } from "./management/openPdf";
import { readPdfPaperIdentity } from "../pdf/paper-identity";
import { rememberPdfPaperReopen } from "../pdf/paper-reopen";
import {
  tagText,
  parseTags,
  statusClass,
  annotationText,
  matchesQuery,
  isPdf,
  pdfReaderUrl,
  kindFamily,
  localDate,
  download,
  Icon,
} from "./management/helpers";
import {
  Alert,
  Empty,
  PageHeader,
  FilterPopover,
  AnnotationBrowser,
  AnnotationRow,
  AnnotationDetail,
  Editor,
  ColorPicker,
  SettingsView,
  SelectionToolbarSwitch,
} from "./management/components";
export { pdfReaderUrl } from "./management/helpers";
export function mountManagementApp(root: HTMLElement, mode: Mode): void {
  installPageTheme();
  createRoot(root).render(<ManagementApp mode={mode} />);
}

const isPdfSurface = (context: PdfTabContext | undefined) =>
  Boolean(context && (context.currentReader || context.kind !== "unavailable"));

export function ManagementApp({ mode }: { mode: Mode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [presetEditor, setPresetEditor] = useState<AnnotationPreset[]>();
  const [presetsLoading, setPresetsLoading] = useState(false);
  const presetDraft = useRef(false), presetSaving = useRef(false);
  const presetTrigger = useRef<HTMLElement | null>(null);
  const [tab, setTab] = useState<TabContext>({});
  const [pdfContext, setPdfContext] = useState<PdfTabContext>();
  const [hasPermission, setHasPermission] = useState(true);
  const [states, setStates] = useState<Record<string, AnchorState>>({});
  const [pageEnabled, setPageEnabled] = useState(false);
  const pageStateVersion = useRef(0);
  const [selectionToolbarEnabled, setSelectionToolbarEnabled] = useState(false);
  const [selectionToolbarSaving, setSelectionToolbarSaving] = useState(false);
  const [selectionConnectionVersion, setSelectionConnectionVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [libraryDocument, setLibraryDocument] = useState(() => {
    const hash = new URLSearchParams(location.search).get("document");
    return mode === "library" && hash && /^[a-f0-9]{64}$/.test(hash) ? `urn:web-ink:pdf:${hash}` : undefined;
  });
  const [kind, setKind] = useState<FilterKind>("all");
  const [color, setColor] = useState("");
  const [tag, setTag] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>("library");
  const [selectedId, setSelectedId] = useState<string>();
  const [libraryDetail, setLibraryDetail] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState<string>();
  const [conflicts, setConflicts] = useState<Record<string, true>>({});
  const [error, setError] = useState<string>();
  const [contextError, setContextError] = useState<string>();
  const [pdfActionError, setPdfActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [backup, setBackup] = useState<unknown>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [overwrite, setOverwrite] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [openingPdf, setOpeningPdf] = useState(false);
  const [preparationStage, setPreparationStage] = useState<string>();
  const [ieeeDiagnostic, setIeeeDiagnostic] = useState<IeeePdfDiagnostic>();
  const [moreOpen, setMoreOpen] = useState(false);
  const pdfOpenPending = useRef(false);
  const moreMenu = useRef<HTMLDetailsElement>(null);
  const moreTrigger = useRef<HTMLElement>(null);
  const libraryScrollY = useRef<number | undefined>(undefined);
  const contextRequest = useRef(0);
  const activeTabId = useRef<number | undefined>(undefined);
  const activeDocument = useRef<{ id?: number; url?: string; version: number }>({ version: 0 });
  const selectionToolbarVersion = useRef(0);
  const settingsRef = useRef<Settings>(settings);
  const settingsQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsVersion = useRef(0);
  const pendingSettings = useRef(0);
  settingsRef.current = settings;
  const language = settings.language;
  const t = COPY[language];
  const displayError = error ?? pdfActionError ?? contextError;
  useEffect(() => {
    let active = true;
    const initialVersion = selectionToolbarVersion.current;
    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (!active || areaName !== "local" || !Object.hasOwn(changes, SELECTION_TOOLBAR_KEY)) return;
      selectionToolbarVersion.current++;
      const change = changes[SELECTION_TOOLBAR_KEY];
      setSelectionToolbarEnabled(change?.newValue === true);
    };
    try { chrome.storage.onChanged?.addListener(changed); } catch { /* A revoked context cannot subscribe. */ }
    void readSelectionToolbarEnabled().then((value) => {
      if (active && selectionToolbarVersion.current === initialVersion) setSelectionToolbarEnabled(value);
    });
    return () => {
      active = false;
      try { releaseChromeListener(() => chrome.storage.onChanged?.removeListener(changed)); } catch { /* The context may be gone. */ }
    };
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!presetDraft.current && !presetSaving.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  useLayoutEffect(() => applyPageTheme(settings.theme), [settings.theme]);
  const observedUrl = pdfContext?.url ?? tab.url;
  const pageUrl =
    !isPdfSurface(pdfContext) && observedUrl && isWebPage(observedUrl)
      ? pageKey(observedUrl)
      : undefined;
  const origin = pageUrl ? new URL(pageUrl).origin : undefined;
  const paused = Boolean(origin && settings.disabledOrigins.includes(origin));
  const { records, setRecords, nextCursor, loading, loadRecords } =
    useAnnotationQuery(
      { mode, pageUrl: mode === "library" ? libraryDocument : pageUrl, kind, color, tag, query },
      setError,
      (items) =>
        setSelectedId((current) =>
          current && items.some((item) => item.id === current)
            ? current
            : undefined,
        ),
    );

  const observeDocument = useCallback((context: TabContext) => {
    const previous = activeDocument.current;
    const url = context.url ?? (previous.id === context.id ? previous.url : undefined);
    if (previous.id !== context.id || previous.url !== url) {
      activeDocument.current = { id: context.id, url, version: previous.version + 1 };
      setPdfActionError(undefined);
      setIeeeDiagnostic(undefined);
    }
  }, []);

  const pageState = useCallback(
    async (tabId?: number, url?: string, expectedContext?: number) => {
      const version = ++pageStateVersion.current;
      if (mode !== "sidepanel" || tabId === undefined || !url) {
        setStates({});
        setPageEnabled(false);
        return;
      }
      try {
        const [result, pageMode] = await Promise.all([
          request<{
            pageUrl?: string;
            states: AnchorState[];
            enabled?: boolean;
          }>({ type: "page.state.get", tabId }),
          request<PageMode>({ type: "page.mode.get", pageUrl: url }),
        ]);
        if (
          version !== pageStateVersion.current ||
          (expectedContext !== undefined &&
            expectedContext !== contextRequest.current) ||
          (result.pageUrl && result.pageUrl !== url)
        )
          return;
        const next: Record<string, AnchorState> = {};
        for (const state of result.states) next[state.id] = state;
        setStates(next);
        // Content snapshots may precede the asynchronous mode broadcast.
        // Read effective mode so automatic reminders and site pauses agree with the page.
        setPageEnabled(pageMode.enabled === true);
      } catch (cause) {
        if (
          version === pageStateVersion.current &&
          (expectedContext === undefined || expectedContext === contextRequest.current)
        )
          setContextError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [mode],
  );
  useEffect(() => {
    if (mode === "sidepanel" && pageUrl)
      void pageState(tab.id, pageUrl, contextRequest.current);
  }, [mode, pageUrl, tab.id, selectionToolbarEnabled, pageState]);
  const refreshContext = useCallback(async () => {
    const requestId = ++contextRequest.current;
    setContextError(undefined);
    setSelectionConnectionVersion((current) => current + 1);
    try {
      const nextTab =
        mode === "sidepanel"
          ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
          : undefined;
      const context: TabContext = nextTab
        ? { id: nextTab.id, windowId: nextTab.windowId, url: nextTab.url, title: nextTab.title }
        : {};
      if (requestId !== contextRequest.current) return;
      activeTabId.current = context.id;
      observeDocument(context);
      const nextPdfContext =
        mode === "sidepanel" && context.id !== undefined
          ? await request<PdfTabContext>({
              type: "pdf.context.get",
              tabId: context.id,
              ...(context.windowId !== undefined ? { windowId: context.windowId } : {}),
              ...(context.url ? { expectedUrl: context.url } : {}),
            })
          : undefined;
      const permission = await chrome.permissions.contains({
        origins: ["http://*/*", "https://*/*"],
      });
      const nextSettings = await request<Settings>({ type: "settings.get" });
      if (requestId !== contextRequest.current) return;
      const observedContext = {
        ...context,
        ...(nextPdfContext?.url ? { url: nextPdfContext.url } : {}),
      };
      observeDocument(observedContext);
      setTab(observedContext);
      setPdfContext(nextPdfContext);
      setHasPermission(permission);
      settingsRef.current = nextSettings;
      setSettings(nextSettings);
      const nextUrl =
        !isPdfSurface(nextPdfContext) &&
        observedContext.url &&
        isWebPage(observedContext.url)
          ? pageKey(observedContext.url)
          : undefined;
      await pageState(observedContext.id, nextUrl, requestId);
    } catch (cause) {
      if (requestId === contextRequest.current && !(cause instanceof RequestError && cause.code === "PAGE_CHANGED"))
        setContextError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [mode, observeDocument, pageState]);
  useEffect(() => {
    void refreshContext();
  }, [refreshContext]);
  const closeMore = useCallback(() => {
    setMoreOpen(false);
    moreTrigger.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !moreOpen) return;
      event.preventDefault();
      closeMore();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (moreOpen && !moreMenu.current?.contains(event.target as Node))
        setMoreOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closeMore, moreOpen]);
  useEffect(() => {
    const activated = (activeInfo: { tabId: number }) => {
      if (mode === "sidepanel") {
        observeDocument({ id: activeInfo.tabId });
        activeTabId.current = activeInfo.tabId;
        void refreshContext();
      }
    };
    const updated = (tabId: number, change: { url?: string; status?: string }) => {
      if (mode !== "sidepanel" || tabId !== activeTabId.current) return;
      if (change.url) observeDocument({ id: tabId, url: change.url });
      if (change.status === "loading") {
        activeDocument.current.version++;
        setPdfActionError(undefined);
        setIeeeDiagnostic(undefined);
      }
      if (change.url || change.status === "complete") void refreshContext();
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    return () => {
      releaseChromeListener(() => chrome.tabs.onActivated.removeListener(activated));
      releaseChromeListener(() => chrome.tabs.onUpdated.removeListener(updated));
    };
  }, [mode, observeDocument, refreshContext]);
  useEffect(() => {
    const listener = (message: NoticeMessage) => {
      if (message.type === 'pdf.preparation.changed' && mode === 'sidepanel' && message.tabId === tab.id && pdfOpenPending.current) {
        setPreparationStage(message.stage ?? message.diagnostic?.phase);
        return;
      }
      if (message.type === "pdf.reader.changed" && mode === "sidepanel") {
        void refreshContext();
        return;
      }
      if (
        message.type === "page.state.changed" &&
        mode === "sidepanel" &&
        message.tabId === tab.id
      ) {
        void pageState(tab.id, pageUrl, contextRequest.current);
        return;
      }
      if (
        message.type === "page.mode.changed" &&
        mode === "sidepanel" &&
        message.pageUrl === pageUrl
      ) {
        void pageState(tab.id, pageUrl, contextRequest.current);
        return;
      }
      if (message.type === "settings.changed") {
        if (pendingSettings.current) return;
        void request<Settings>({ type: "settings.get" })
          .then((next) => {
            if (!pendingSettings.current) {
              settingsRef.current = next;
              setSettings(next);
            }
          })
          .catch(() => undefined);
        return;
      }
      if (message.type !== "annotations.changed") return;
      if (message.deletedId) {
        setRecords((current) =>
          current.filter((record) => record.id !== message.deletedId),
        );
        return;
      }
      if (message.annotation) {
        const active = {
          pageUrl: mode === "sidepanel" ? pageUrl : undefined,
          kind,
          color,
          tag,
          text: query,
        };
        if (!matchesQuery(message.annotation, active)) {
          setRecords((current) =>
            current.filter((record) => record.id !== message.annotation!.id),
          );
          return;
        }
        void loadRecords();
        return;
      }
      void loadRecords();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      releaseChromeListener(() => chrome.runtime.onMessage.removeListener(listener));
    };
  }, [
    color,
    kind,
    loadRecords,
    mode,
    pageState,
    pageUrl,
    query,
    refreshContext,
    tab.id,
    tag,
  ]);

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
      if (version === selectionToolbarVersion.current) setSelectionToolbarEnabled(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSelectionToolbarSaving(false);
    }
  };
  const enablePermissions = async () => {
    try {
      const granted = await chrome.permissions.request({
        origins: ["http://*/*", "https://*/*"],
      });
      if (!granted)
        throw new Error(
          language === "zh-CN"
            ? "未授予网页访问权限。"
            : "Page access was not granted.",
        );
      await request<boolean>({ type: "permissions.enable" });
      await refreshContext();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const pageAction = async (
    action: "focus" | "rebind" | "draw",
    id?: string,
  ) => {
    if (tab.id === undefined) {
      setError(t.actionUnavailable);
      return;
    }
    try {
      await request<boolean>({
        type: "page.action",
        tabId: tab.id,
        action,
        ...(id ? { id } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const toggleCurrentPage = async () => {
    if (!pageUrl) return;
    try {
      await request({ type: "page.mode.put", pageUrl, enabled: !pageEnabled });
      await pageState(tab.id, pageUrl, contextRequest.current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const startEdit = (record: Annotation) => {
    setEditing(record.id);
    setDrafts((current) => ({
      ...current,
      [record.id]: current[record.id] ?? {
        note: record.note,
        tags: tagText(record.tags),
        color: record.color,
        base: record,
      },
    }));
  };
  const updateDraft = (
    id: string,
    patch: Pick<Partial<Draft>, "note" | "tags" | "color">,
  ) =>
    setDrafts((current) =>
      current[id]
        ? { ...current, [id]: { ...current[id], ...patch } }
        : current,
    );
  const saveRecord = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    try {
      const candidate: Annotation = {
        ...draft.base,
        note: draft.note,
        tags: parseTags(draft.tags),
        color: draft.color,
        updatedAt: new Date().toISOString(),
      };
      const saved = await request<Annotation>({
        type: "annotations.put",
        annotation: candidate,
        expectedRevision: draft.base.revision,
      });
      setRecords((current) =>
        current.map((item) => (item.id === saved.id ? saved : item)),
      );
      setDrafts((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
      setConflicts((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
      setEditing(undefined);
      setNotice(t.updated);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/changed in another tab|CONFLICT/i.test(message)) {
        setConflicts((current) => ({ ...current, [id]: true }));
        setError(t.conflict);
        void loadRecords();
      } else setError(message);
    }
  };
  const loadLatest = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    try {
      const latest = await request<AnnotationPage>({
        type: "annotations.query",
        query: {
          ...(mode === "sidepanel" && pageUrl ? { pageUrl } : {}),
          text: "",
          limit: 50,
          requestId: crypto.randomUUID(),
        },
      });
      const record = latest.items.find((item) => item.id === id);
      if (!record)
        throw new Error(
          language === "zh-CN"
            ? "标注已被删除。"
            : "The annotation was deleted.",
        );
      setRecords((current) =>
        current.map((item) => (item.id === id ? record : item)),
      );
      setDrafts((current) =>
        current[id]
          ? { ...current, [id]: { ...current[id], base: record } }
          : current,
      );
      setConflicts((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const removeRecord = async (record: Annotation): Promise<boolean> => {
    try {
      await request<{ id: string; deleted: true }>({
        type: "annotations.delete",
        id: record.id,
        expectedRevision: record.revision,
      });
      setRecords((current) => current.filter((item) => item.id !== record.id));
      if (selectedId === record.id) setSelectedId(undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  const exportJson = async () => {
    try {
      const value = await request<BackupEnvelope>({ type: "backup.export" });
      download(
        "web-ink-backup.json",
        JSON.stringify(value),
        "application/json",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const exportMarkdown = async () => {
    try {
      const value = await request<BackupEnvelope>({ type: "backup.export" });
      download(
        "web-ink-annotations.md",
        toMarkdown(value.annotations),
        "text/markdown;charset=utf-8",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const readImport = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setError("Import file exceeds 20 MiB.");
      return;
    }
    try {
      const value: unknown = JSON.parse(await file.text());
      const nextPreview = await request<ImportPreview>({
        type: "backup.preview",
        backup: value,
      });
      setBackup(value);
      setPreview(nextPreview);
      setError(undefined);
    } catch (cause) {
      setBackup(undefined);
      setPreview(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const importBackup = async () => {
    if (!backup) return;
    setBusyImport(true);
    try {
      await request<ImportPreview>({
        type: "backup.import",
        backup,
        overwrite,
      });
      setNotice(t.importDone);
      setBackup(undefined);
      setPreview(undefined);
      await loadRecords();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyImport(false);
    }
  };
  const showPdf = async (record?: Annotation) => {
    if (pdfOpenPending.current) return;
    pdfOpenPending.current = true;
    setOpeningPdf(true);
    try {
      const identity = record && isPdf(record)
        ? await readPdfPaperIdentity(record.target.documentHash, record.target.sourceUrl) : undefined;
      const url = pdfReaderUrl(chrome.runtime.getURL("/pdf.html"), record, identity);
      const tabId = await openPdfTab(url);
      if (record && isPdf(record) && new URL(url).protocol === "https:")
        await rememberPdfPaperReopen(record.target, identity?.doi, tabId);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pdfOpenPending.current = false; setOpeningPdf(false); }
  };
  const openCurrentPdf = (candidateUrl?: string, accessMode?: "site-session") => {
    if (tab.id === undefined || pdfContext?.currentReader || pdfOpenPending.current)
      return;
    pdfOpenPending.current = true;
    setOpeningPdf(true);
    setPdfActionError(undefined);
    const expectedDocument = activeDocument.current.version;
    setPreparationStage('identify'); setIeeeDiagnostic(undefined);
    void request<PdfOpenResult>({
      type: "pdf.openCurrent",
      tabId: tab.id,
      ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
      ...(tab.url ? { expectedUrl: tab.url } : {}),
      ...(candidateUrl ? { candidateUrl } : {}),
      ...(accessMode ? { accessMode } : {}),
    })
      .catch((cause) => {
        if (expectedDocument !== activeDocument.current.version) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setPdfActionError(
          cause instanceof RequestError && cause.code
            ? ieeeFailureMessage(cause.code, language) ?? message
            : `${message} ${t.refreshPdfHint}`,
        );
        if (cause instanceof RequestError) setIeeeDiagnostic(cause.diagnostic);
      })
      .finally(() => {
        pdfOpenPending.current = false;
        setOpeningPdf(false);
        setPreparationStage(undefined);
      });
  };
  const openIeeeSessionPdf = async (candidateUrl?: string) => {
    const origin = { origins: ["https://ieeexplore.ieee.org/*"] };
    try {
      const granted = await chrome.permissions.contains(origin);
      if (granted || await chrome.permissions.request(origin)) {
        openCurrentPdf(candidateUrl, "site-session");
        return;
      }
    } catch {
      // A revoked extension context is handled as a denied IEEE host grant.
    }
    setError(t.ieeePermissionDenied);
  };
  const openLocalPdf = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("pdf.html?open=local") }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const openLibrary = () => {
    window.open(chrome.runtime.getURL("library.html"));
  };
  const openPdf = (record?: Annotation) => {
    void showPdf(record);
  };
  const filterCount =
    Number(kind !== "all") + Number(Boolean(color)) + Number(Boolean(tag));
  const showHeaderPdfAction =
    !pdfContext?.currentReader && (!pdfContext || pdfContext.candidates.length <= 1);
  const isIeeeSession = pdfContext?.publisher === "ieee";
  const isIeeeCandidate = (candidate: PdfTabContext["candidates"][number]) => {
    const url = new URL(candidate.url);
    return url.origin === "https://ieeexplore.ieee.org" && !url.username && !url.password;
  };
  const ieeeCandidates = isIeeeSession
    ? pdfContext?.candidates.filter(isIeeeCandidate) ?? []
    : [];
  const publicCandidates = isIeeeSession
    ? pdfContext?.candidates.filter(candidate => !isIeeeCandidate(candidate)) ?? []
    : [];
  const openLibraryDetail = (id: string) => {
    if (window.innerWidth <= 699) libraryScrollY.current = window.scrollY;
    setSelectedId(id);
    setLibraryDetail(true);
  };
  const closeLibraryDetail = () => {
    setLibraryDetail(false);
  };
  useLayoutEffect(() => {
    const top = libraryScrollY.current;
    if (mode !== "library" || libraryDetail || top === undefined) return;
    libraryScrollY.current = undefined;
    window.scrollTo({ top, behavior: "auto" });
  }, [libraryDetail, mode]);
  return (
    <main
      className={mode === "sidepanel" ? "ink-app sidepanel" : "ink-app"}
      data-theme={settings.theme ?? "system"}
      data-reduce-motion={settings.reduceMotion === true}
      data-reduce-transparency={settings.reduceTransparency === true}
    >
      <header className="topbar">
        <div className="app-title">
          <h1>
            {mode === "sidepanel"
              ? t.pageAnnotations
              : screen === "settings"
                ? t.settings
                : t.library}
          </h1>
          {(mode === "sidepanel" ? pageUrl && !paused : screen === "library") &&
          records.length ? (
            <span className="count">
              {records.length}
              {nextCursor ? "+" : ""}
            </span>
          ) : null}
        </div>
        <div className="header-actions">
          {mode === "sidepanel" ? (
            <>
            {showHeaderPdfAction ? (
              <button className="quiet icon-button" disabled={openingPdf}
                onClick={() => {
                  if (isIeeeSession) void openIeeeSessionPdf(ieeeCandidates[0]?.url);
                  else openCurrentPdf(pdfContext?.candidates[0]?.url);
                }}
                title={isIeeeSession ? t.openIeeeSessionPdf : t.openPdf}
                aria-label={isIeeeSession ? t.openIeeeSessionPdf : t.openPdf}>
                <Icon name="pdf" />
              </button>
            ) : null}
            <button
              className="quiet icon-button"
              aria-label={t.openLibrary}
              title={t.openLibrary}
              onClick={openLibrary}
            >
              <Icon name="library" />
            </button>
            </>
          ) : (
            <div className="segmented-control" role="group">
              <button
                className={
                  screen === "library" ? "segmented selected" : "segmented"
                }
                aria-pressed={screen === "library"}
                onClick={() => setScreen("library")}
              >
                {t.library}
              </button>
              <button
                className={
                  screen === "settings" ? "segmented selected" : "segmented"
                }
                aria-pressed={screen === "settings"}
                onClick={() => setScreen("settings")}
              >
                {t.settings}
              </button>
            </div>
          )}
          {mode === "library" && screen === "library" ? (
            <button
              className="quiet icon-button"
              onClick={() => openPdf()}
              aria-label={t.openPdf}
              title={t.openPdf}
            >
              <Icon name="pdf" />
            </button>
          ) : null}
          <button
            className="quiet icon-button"
            onClick={() => {
              void refreshContext();
              void loadRecords();
            }}
            aria-label={t.refresh}
            title={t.refresh}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
      {mode === "library" && screen === "library" && libraryDocument && <div className="alert notice" role="status">
        <span>{language === "zh-CN" ? "之前版本的标注" : "Annotations from the previous version"}</span>
        <button className="quiet" onClick={() => {
          setLibraryDocument(undefined);
          const url = new URL(location.href);
          url.searchParams.delete("document");
          history.replaceState(null, "", url.href);
        }}>{language === "zh-CN" ? "查看全部" : "View all"}</button>
      </div>}
      {displayError ? (
        <Alert
          kind="error"
          text={displayError}
          close={() => error ? setError(undefined) : pdfActionError ? setPdfActionError(undefined) : setContextError(undefined)}
          closeLabel={t.close}
        />
      ) : null}
      {pdfActionError && ieeeDiagnostic && <details className="ieee-diagnostic">
        <summary>{language === 'zh-CN' ? '诊断详情' : 'Diagnostic details'}</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>
          {formatIeeeDiagnostic(ieeeDiagnostic, chrome.runtime.getManifest().version)}</pre>
        <button className="quiet" onClick={() => {
          void navigator.clipboard.writeText(formatIeeeDiagnostic(ieeeDiagnostic, chrome.runtime.getManifest().version))
            .then(() => setNotice(language === 'zh-CN' ? '诊断摘要已复制' : 'Diagnostic summary copied'))
            .catch(() => setNotice(language === 'zh-CN' ? '请手动选择上面的摘要复制' : 'Select the summary above to copy it'));
        }}>{language === 'zh-CN' ? '复制诊断摘要' : 'Copy diagnostic summary'}</button>
      </details>}
      {notice ? (
        <Alert
          kind="notice"
          text={notice}
          close={() => setNotice(undefined)}
          closeLabel={t.close}
        />
      ) : null}
      {!hasPermission && !(mode === "sidepanel" && isPdfSurface(pdfContext)) ? (
        <Empty
          title={t.permission}
          text={t.permissionText}
          action={
            <button
              className="primary"
              onClick={() => void enablePermissions()}
            >
              {t.permission}
            </button>
          }
        />
      ) : null}
      {mode === "sidepanel" && (hasPermission || isPdfSurface(pdfContext)) ? (
        <>
          {pageUrl ? <PageHeader
            title={pageUrl ? tab.title || new URL(pageUrl).host : t.unknownPage}
            host={pageUrl ? new URL(pageUrl).host : undefined}
            enabled={pageEnabled}
            onToggle={selectionToolbarEnabled && !paused ? undefined : toggleCurrentPage}
            toggleLabel={t.showAnnotations}
            disabled={!pageUrl || paused}
          /> : null}
          <div className="sidepanel-content">
          {pageUrl && !paused ? <SelectionToolbarSwitch
            enabled={selectionToolbarEnabled}
            saving={selectionToolbarSaving}
            onToggle={() => void toggleSelectionToolbar()}
            t={t}
          /> : null}
          {pageUrl && !paused ? <WebSelection
            tabId={tab.id}
            pageUrl={pageUrl}
            language={language}
            defaultColor={settings.defaultColor}
            connectionKey={selectionConnectionVersion}
            onError={setError}
            onSaved={(annotation, startEditing) => {
              setRecords((current) => current.some((record) => record.id === annotation.id)
                ? current.map((record) => record.id === annotation.id ? annotation : record)
                : [annotation, ...current]);
              setSelectedId(annotation.id);
              if (startEditing) startEdit(annotation);
              void loadRecords();
            }}
          /> : null}
          {pdfContext?.currentReader ? <PdfSidebar tabId={tab.id} language={language} /> : !pageUrl && isPdfSurface(pdfContext) ? (
            <section className="pdf-handoff">
              <span className="pdf-handoff-icon" aria-hidden="true"><Icon name="pdf" /></span>
              <h2>{pdfContext?.currentReader ? t.pdfReading : pdfContext ? t.currentPdfTitle : t.pdfWelcomeTitle}</h2>
              <p>{pdfContext?.currentReader ? t.pdfReadingText : isPdfSurface(pdfContext) ? t.currentPdfText : t.pdfFallbackText}</p>
              {tab.title ? <span className="pdf-document-name" title={tab.title}>{tab.title}</span> : null}
              {pdfContext?.currentReader ? (
                <span className="pdf-reader-status" role="status">{t.pdfReading}</span>
              ) : isIeeeSession ? (
                <>
                  {ieeeCandidates.length > 1 ? (
                    <div className="pdf-source-choices" aria-label={t.choosePdfSource}>
                      {ieeeCandidates.map((candidate) => (
                        <button
                          className="quiet pdf-source-choice"
                          disabled={openingPdf}
                          key={candidate.url}
                          onClick={() => void openIeeeSessionPdf(candidate.url)}
                        >
                          {`${t.openIeeeSessionPdf}: ${candidate.url}`}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button className="primary pdf-open-current" disabled={openingPdf}
                      onClick={() => void openIeeeSessionPdf(ieeeCandidates[0]?.url)}>
                      <Icon name="pdf" />{openingPdf ? pdfPreparationLabel(preparationStage, language) : t.openIeeeSessionPdf}
                    </button>
                  )}
                  {publicCandidates.map((candidate) => (
                    <button
                      className="quiet pdf-source-choice"
                      disabled={openingPdf}
                      key={candidate.url}
                      onClick={() => openCurrentPdf(candidate.url)}
                    >
                      {candidate.url}
                    </button>
                  ))}
                </>
              ) : pdfContext && pdfContext.candidates.length > 1 ? (
                <div className="pdf-source-choices" aria-label={t.choosePdfSource}>
                  {pdfContext.candidates.map((candidate) => (
                    <button
                      className="quiet pdf-source-choice"
                      disabled={openingPdf}
                      key={candidate.url}
                      onClick={() => {
                        if (isIeeeSession) void openIeeeSessionPdf(candidate.url);
                        else openCurrentPdf(candidate.url);
                      }}
                    >
                      {isIeeeSession ? `${t.openIeeeSessionPdf}: ${candidate.url}` : candidate.url}
                    </button>
                  ))}
                </div>
              ) : (
                <button className="primary pdf-open-current" disabled={openingPdf}
                  onClick={() => {
                    if (isIeeeSession) void openIeeeSessionPdf(ieeeCandidates[0]?.url);
                    else openCurrentPdf(pdfContext?.candidates[0]?.url);
                  }}>
                  <Icon name="pdf" />{openingPdf ? isIeeeSession ? pdfPreparationLabel(preparationStage, language) : t.openingPdf : isIeeeSession ? t.openIeeeSessionPdf : t.openCurrentPdf}
                </button>
              )}
              {openingPdf && isIeeeSession && <button className="quiet" onClick={() => {
                void request({ type: 'pdf.cancelCurrent', tabId: tab.id, ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}), ...(tab.url ? { expectedUrl: tab.url } : {}) })
                  .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
              }}>{language === 'zh-CN' ? '取消读取' : 'Cancel reading'}</button>}
              {!pdfContext?.currentReader && pdfContext?.candidates.length !== undefined && pdfContext.candidates.length <= 1 ? (
                <button className="quiet pdf-local-link" onClick={openLocalPdf}>{t.chooseLocalPdf}</button>
              ) : null}
              <small>{t.pdfLocalNote}</small>
            </section>
          ) : !pageUrl ? (
            <Empty
              title={t.unknownPage}
              text={t.pageUnavailableText}
              action={<div className="unavailable-actions">
                <button className="quiet" onClick={() => void refreshContext()}>{t.refresh}</button>
                <button className="quiet" onClick={openLibrary}>{t.openLibrary}</button>
                <button className="quiet" onClick={openLocalPdf}>{t.chooseLocalPdf}</button>
              </div>}
            />
          ) : paused ? (
            <section className="notice-card warning">
              <strong>{t.paused}</strong>
              <button
                className="quiet"
                onClick={() =>
                  saveSettings({
                    disabledOrigins: settingsRef.current.disabledOrigins.filter(
                      (item) => item !== origin,
                    ),
                  })
                }
              >
                {t.resume}
              </button>
            </section>
          ) : null}
          {pageUrl && !paused && records.length > 0 ? (
            <AnnotationBrowser
              compact
              records={records}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              states={states}
              language={language}
              t={t}
              editing={editing}
              drafts={drafts}
              conflicts={conflicts}
              onEdit={startEdit}
              onDraft={updateDraft}
              onSave={saveRecord}
              onLoadLatest={loadLatest}
              onCancel={() => setEditing(undefined)}
              onDelete={removeRecord}
              onFocus={(record) => void pageAction("focus", record.id)}
              onRebind={(record) => void pageAction("rebind", record.id)}
              onDraw={(record) => void pageAction("draw", record.id)}
              onOpenPdf={openPdf}
            />
          ) : null}
          {nextCursor && !loading && pageUrl && !paused ? (
            <button
              className="load-more"
              onClick={() => void loadRecords(true, nextCursor)}
            >
              {t.loadMore}
            </button>
          ) : null}
          {pageUrl && !records.length && !loading && !paused ? (
            <Empty title={t.pageEmptyTitle} text={t.pageEmptyText} icon="draw" />
          ) : null}
          {loading && pageUrl && !paused ? (
            <p className="loading" role="status">{t.loading}</p>
          ) : null}
          </div>
          {pageUrl && !paused ? (
            <footer className="sidepanel-dock" aria-label={t.pageAnnotations}>
              <button
                className="quiet dock-draw"
                disabled
              >
                <Icon name="draw" />
                {t.drawImage} · {t.comingSoon}
              </button>
              <details
                ref={moreMenu}
                className="menu"
                open={moreOpen}
                onToggle={(event) => setMoreOpen(event.currentTarget.open)}
              >
                <summary ref={moreTrigger} aria-label={t.moreActions} title={t.moreActions}>
                  <Icon name="more" />
                </summary>
                <div className="sidepanel-more-actions">
                  <button className="quiet" onClick={openLibrary}>{t.openLibrary}</button>
                  <button className="quiet" onClick={openLocalPdf}>{t.chooseLocalPdf}</button>
                  <button
                    className="danger"
                    onClick={() =>
                      saveSettings({
                        disabledOrigins: origin
                          ? [...settingsRef.current.disabledOrigins, origin]
                          : settingsRef.current.disabledOrigins,
                      })
                    }
                  >
                    {t.pause}
                  </button>
                </div>
              </details>
            </footer>
          ) : null}
        </>
      ) : null}
      {hasPermission && mode === "library" && screen === "library" ? (
        <section className="library-shell">
          <div className="library-tools">
            <label className="search">
              <Icon name="search" />
              <input
                aria-label={t.search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t.search}
              />
            </label>
            <button
              className={filterOpen ? "quiet selected" : "quiet"}
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((value) => !value)}
            >
              <Icon name="filter" />
              {t.filter}
              {filterCount ? (
                <span className="filter-count">{filterCount}</span>
              ) : null}
            </button>
            {filterOpen ? (
              <FilterPopover
                language={language}
                t={t}
                kind={kind}
                color={color}
                tag={tag}
                records={records}
                setKind={setKind}
                setColor={setColor}
                setTag={setTag}
                clear={() => {
                  setKind("all");
                  setColor("");
                  setTag("");
                }}
              />
            ) : null}
          </div>
          {records.length ? <AnnotationBrowser
            detailOpen={libraryDetail}
            onBack={closeLibraryDetail}
            records={records}
            selectedId={selectedId}
            setSelectedId={openLibraryDetail}
            states={states}
            language={language}
            t={t}
            editing={editing}
            drafts={drafts}
            conflicts={conflicts}
            onEdit={startEdit}
            onDraft={updateDraft}
            onSave={saveRecord}
            onLoadLatest={loadLatest}
            onCancel={() => setEditing(undefined)}
            onDelete={removeRecord}
            onFocus={() => undefined}
            onRebind={() => undefined}
            onDraw={() => undefined}
            onOpenPdf={openPdf}
          /> : null}
          {!records.length && !loading ? (
            <Empty
              title={query || filterCount ? t.noResults : t.libraryEmptyTitle}
              text={query || filterCount ? "" : t.libraryEmptyText}
            />
          ) : null}
          {loading ? (
            <p className="loading" role="status">
              {t.loading}
            </p>
          ) : null}
          {nextCursor && !loading ? (
            <button
              className="load-more"
              onClick={() => void loadRecords(true, nextCursor)}
            >
              {t.loadMore}
            </button>
          ) : null}
        </section>
      ) : null}
      {hasPermission && mode === "library" && screen === "settings" ? (
        <SettingsView
          settings={settings}
          t={t}
          language={language}
          saveSettings={saveSettings}
          exportJson={exportJson}
          exportMarkdown={exportMarkdown}
          readImport={readImport}
          preview={preview}
          overwrite={overwrite}
          setOverwrite={setOverwrite}
          busyImport={busyImport}
          importBackup={importBackup}
          presetsLoading={presetsLoading}
          selectionToolbarEnabled={selectionToolbarEnabled}
          selectionToolbarSaving={selectionToolbarSaving}
          toggleSelectionToolbar={() => void toggleSelectionToolbar()}
          onPresets={() => {
            if (presetsLoading) return;
            presetTrigger.current = document.activeElement as HTMLElement;
            setPresetsLoading(true);
            void readAnnotationPresets(language).then(setPresetEditor).finally(() => setPresetsLoading(false));
          }}
        />
      ) : null}
      {presetEditor && <div className="dialog-backdrop"><AnnotationPresetEditor presets={presetEditor} language={language}
        onSave={saveAnnotationPresets} onDirtyChange={(dirty) => { presetDraft.current = dirty; }}
        onSavingChange={(writing) => { presetSaving.current = writing; }}
        onClose={() => { setPresetEditor(undefined); presetTrigger.current?.focus(); }} /></div>}
    </main>
  );
}
