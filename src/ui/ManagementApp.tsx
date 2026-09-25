import { useAnnotationQuery } from "./management/useAnnotationQuery";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { toMarkdown } from "../core/backup";
import { request } from "../core/client";
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
  type Settings,
} from "../core/model";
import { isWebPage, pageKey } from "../core/url";
import { getPdfContext, buildPdfOpenUrl } from "../pdf/context";
import { ICON_PATHS, type IconName } from "./icons";
import { StoragePanel } from "./StoragePanel";
import { applyPageTheme, installPageTheme } from "./page-theme";
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
} from "./management/components";
export { pdfReaderUrl } from "./management/helpers";
export function mountManagementApp(root: HTMLElement, mode: Mode): void {
  installPageTheme();
  createRoot(root).render(<ManagementApp mode={mode} />);
}

export function ManagementApp({ mode }: { mode: Mode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<TabContext>({});
  const [hasPermission, setHasPermission] = useState(true);
  const [states, setStates] = useState<Record<string, AnchorState>>({});
  const [pageEnabled, setPageEnabled] = useState(false);
  const [query, setQuery] = useState("");
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
  const [notice, setNotice] = useState<string>();
  const [backup, setBackup] = useState<unknown>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [overwrite, setOverwrite] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [openingPdf, setOpeningPdf] = useState(false);
  const pdfOpenPending = useRef(false);
  const contextRequest = useRef(0);
  const settingsRef = useRef<Settings>(settings);
  const settingsQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsVersion = useRef(0);
  const pendingSettings = useRef(0);
  settingsRef.current = settings;
  const language = settings.language;
  const t = COPY[language];
  useLayoutEffect(() => applyPageTheme(settings.theme), [settings.theme]);
  const pdfContext = getPdfContext(tab.url);
  const pageUrl = !pdfContext && tab.url && isWebPage(tab.url) ? pageKey(tab.url) : undefined;
  const origin = pageUrl ? new URL(pageUrl).origin : undefined;
  const paused = Boolean(origin && settings.disabledOrigins.includes(origin));
  const { records, setRecords, nextCursor, loading, loadRecords } =
    useAnnotationQuery(
      { mode, pageUrl, kind, color, tag, query },
      setError,
      (items) =>
        setSelectedId((current) =>
          items.some((item) => item.id === current) ? current : items[0]?.id,
        ),
    );

  const pageState = useCallback(
    async (tabId?: number, url?: string, expectedContext?: number) => {
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
          (expectedContext !== undefined &&
            expectedContext !== contextRequest.current) ||
          (result.pageUrl && result.pageUrl !== url)
        )
          return;
        const next: Record<string, AnchorState> = {};
        for (const state of result.states) next[state.id] = state;
        setStates(next);
        // Content snapshots may precede the asynchronous mode broadcast.
        // Read the persisted preference so the switch does not revert visually.
        setPageEnabled(pageMode.enabled === true);
      } catch (cause) {
        if (
          expectedContext === undefined ||
          expectedContext === contextRequest.current
        )
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [mode],
  );
  const refreshContext = useCallback(async () => {
    const requestId = ++contextRequest.current;
    try {
      const nextTab =
        mode === "sidepanel"
          ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
          : undefined;
      const context: TabContext = nextTab
        ? { id: nextTab.id, url: nextTab.url, title: nextTab.title }
        : {};
      const permission = await chrome.permissions.contains({
        origins: ["http://*/*", "https://*/*"],
      });
      const nextSettings = await request<Settings>({ type: "settings.get" });
      if (requestId !== contextRequest.current) return;
      setTab(context);
      setHasPermission(permission);
      settingsRef.current = nextSettings;
      setSettings(nextSettings);
      const nextUrl =
        !getPdfContext(context.url) && context.url && isWebPage(context.url)
          ? pageKey(context.url)
          : undefined;
      await pageState(context.id, nextUrl, requestId);
    } catch (cause) {
      if (requestId === contextRequest.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [mode, pageState]);
  useEffect(() => {
    void refreshContext();
  }, [refreshContext]);
  useEffect(() => {
    const listener = (message: NoticeMessage) => {
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
    const activated = () => {
      if (mode === "sidepanel") void refreshContext();
    };
    const updated = (_id: number, change: { url?: string }) => {
      if (mode === "sidepanel" && change.url) void refreshContext();
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
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
  const showPdf = async (url: string) => {
    if (pdfOpenPending.current) return;
    pdfOpenPending.current = true;
    setOpeningPdf(true);
    try { await openPdfTab(url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pdfOpenPending.current = false; setOpeningPdf(false); }
  };
  const openCurrentPdf = () => {
    void showPdf(buildPdfOpenUrl(chrome.runtime.getURL("/pdf.html"), pdfContext));
  };
  const openPdf = (record?: Annotation) => {
    void showPdf(pdfReaderUrl(chrome.runtime.getURL("/pdf.html"), record));
  };
  const filterCount =
    Number(kind !== "all") + Number(Boolean(color)) + Number(Boolean(tag));
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
            <button className="quiet icon-button" disabled={openingPdf} onClick={openCurrentPdf}
              title={t.openPdf} aria-label={t.openPdf}>
              <Icon name="pdf" />
            </button>
            <button
              className="quiet icon-button"
              aria-label={t.openLibrary}
              title={t.openLibrary}
              onClick={() => window.open(chrome.runtime.getURL("library.html"))}
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
      {error ? (
        <Alert
          kind="error"
          text={error}
          close={() => setError(undefined)}
          closeLabel={t.close}
        />
      ) : null}
      {notice ? (
        <Alert
          kind="notice"
          text={notice}
          close={() => setNotice(undefined)}
          closeLabel={t.close}
        />
      ) : null}
      {!hasPermission && !(mode === "sidepanel" && (!pageUrl || pdfContext)) ? (
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
      {mode === "sidepanel" && (hasPermission || !pageUrl) ? (
        <>
          {pageUrl ? <PageHeader
            title={pageUrl ? tab.title || new URL(pageUrl).host : t.unknownPage}
            host={pageUrl ? new URL(pageUrl).host : undefined}
            enabled={pageEnabled}
            onToggle={toggleCurrentPage}
            toggleLabel={t.showAnnotations}
            disabled={!pageUrl || paused}
          /> : null}
          <div className="sidepanel-content">
          {!pageUrl ? (
            <section className="pdf-handoff">
              <span className="pdf-handoff-icon" aria-hidden="true"><Icon name="pdf" /></span>
              <h2>{pdfContext ? t.currentPdfTitle : t.pdfWelcomeTitle}</h2>
              <p>{pdfContext?.kind === "remote" ? t.currentPdfText : t.pdfFallbackText}</p>
              {pdfContext && tab.title ? <span className="pdf-document-name" title={tab.title}>{tab.title}</span> : null}
              <button className="primary pdf-open-current" disabled={openingPdf} onClick={openCurrentPdf}>
                <Icon name="pdf" />{openingPdf ? t.openingPdf : pdfContext?.kind === "remote" ? t.openCurrentPdf : t.openPdf}
              </button>
              {pdfContext?.kind === "remote" ? <button className="quiet pdf-local-link" onClick={() => openPdf()}>{t.chooseLocalPdf}</button> : null}
              <small>{t.pdfLocalNote}</small>
            </section>
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
                onClick={() => void pageAction("draw")}
              >
                <Icon name="draw" />
                {t.drawImage}
              </button>
              <details className="menu">
                <summary aria-label={t.moreActions} title={t.moreActions}>
                  <Icon name="more" />
                </summary>
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
          <AnnotationBrowser
            detailOpen={libraryDetail}
            onBack={() => setLibraryDetail(false)}
            records={records}
            selectedId={selectedId}
            setSelectedId={(id) => {
              setSelectedId(id);
              setLibraryDetail(true);
            }}
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
          />
          {!records.length && !loading ? (
            <Empty
              title={query || filterCount ? t.noResults : t.empty}
              text=""
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
        />
      ) : null}
    </main>
  );
}
