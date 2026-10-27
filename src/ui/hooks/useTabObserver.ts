import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { RequestError, request, releaseChromeListener } from "../../core/client";
import type { AnchorState, Language, PageMode, PdfTabContext, Settings } from "../../core/model";
import { isWebPage, pageKey } from "../../core/url";
import { COPY } from "../management/copy";
import type { Mode, NoticeMessage, TabContext } from "../management/types";

export const isPdfSurface = (context: PdfTabContext | undefined) =>
  Boolean(context && (context.currentReader || context.kind !== "unavailable"));

export function useTabObserver({
  mode, selectionToolbarEnabled, receiveSettings, language, setError,
}: {
  mode: Mode;
  selectionToolbarEnabled: boolean;
  receiveSettings: (settings: Settings) => void;
  language: Language;
  setError: (message: string) => void;
}) {
  const [tab, setTab] = useState<TabContext>({});
  const [pdfContext, setPdfContext] = useState<PdfTabContext>();
  const [hasPermission, setHasPermission] = useState(true);
  const [contextError, setContextError] = useState<string>();
  const [states, setStates] = useState<Record<string, AnchorState>>({});
  const [pageEnabled, setPageEnabled] = useState(false);
  const [selectionConnectionVersion, setSelectionConnectionVersion] = useState(0);
  const [documentVersion, setDocumentVersion] = useState(0);
  const pageStateVersion = useRef(0);
  const pageToggleVersion = useRef<number | undefined>(undefined);
  const contextRequest = useRef(0);
  const activeTabId = useRef<number | undefined>(undefined);
  const activeDocument = useRef<{ id?: number; url?: string; version: number }>({ version: 0 });
  const t = COPY[language];
  const observedUrl = pdfContext?.url ?? tab.url;
  const pageUrl =
    !isPdfSurface(pdfContext) && observedUrl && isWebPage(observedUrl)
      ? pageKey(observedUrl)
      : undefined;
  const observeDocument = useCallback((context: TabContext) => {
    const previous = activeDocument.current;
    const url = context.url ?? (previous.id === context.id ? previous.url : undefined);
    if (previous.id !== context.id || previous.url !== url) {
      activeDocument.current = { id: context.id, url, version: previous.version + 1 };
      setDocumentVersion(activeDocument.current.version);
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
      receiveSettings(nextSettings);
      const nextUrl =
        !isPdfSurface(nextPdfContext) &&
        observedContext.url &&
        isWebPage(observedContext.url)
          ? pageKey(observedContext.url)
          : undefined;
      await pageState(observedContext.id, nextUrl, requestId);
    } catch (cause) {
      if (
        requestId === contextRequest.current &&
        !(cause instanceof RequestError && cause.code === "PAGE_CHANGED")
      )
        setContextError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [mode, observeDocument, pageState, receiveSettings]);
  useEffect(() => {
    void refreshContext();
  }, [refreshContext]);
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
        setDocumentVersion(activeDocument.current.version);
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
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      releaseChromeListener(() => chrome.runtime.onMessage.removeListener(listener));
    };
  }, [mode, pageState, pageUrl, refreshContext, tab.id]);
  return useMemo(() => {
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
      action: "focus" | "rebind",
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
      const document = activeDocument.current;
      if (!pageUrl || tab.id === undefined || !tab.url ||
          document.id !== tab.id || document.url !== tab.url ||
          pageToggleVersion.current === document.version) return;
      const version = document.version;
      const isCurrent = () => activeDocument.current.version === version;
      pageToggleVersion.current = version;
      try {
        const response: unknown = await chrome.tabs.sendMessage(tab.id, {
          type: "page.mode.set", expectedUrl: tab.url, enabled: !pageEnabled,
        }, { frameId: 0 });
        if (!isCurrent()) return;
        if (!response || typeof response !== "object" ||
            !("ok" in response) || response.ok !== true ||
            !("data" in response) || response.data !== true) {
          const message = response && typeof response === "object" &&
            "error" in response && typeof response.error === "string"
            ? response.error
            : language === "zh-CN" ? "未能切换标注，请刷新网页后重试。" : "Could not change annotations. Reload the page and try again.";
          throw Error(message);
        }
        await pageState(tab.id, pageUrl, contextRequest.current);
      } catch (cause) {
        if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (pageToggleVersion.current === version) pageToggleVersion.current = undefined;
      }
    };
    return {
      tab,
      pdfContext,
      hasPermission,
      contextError,
      setContextError,
      states,
      pageEnabled,
      pageUrl,
      selectionConnectionVersion,
      activeDocument,
      documentVersion,
      refreshContext,
      enablePermissions,
      pageAction,
      toggleCurrentPage,
    };
  }, [tab, pdfContext, hasPermission, contextError, states, pageEnabled, pageUrl, selectionConnectionVersion, documentVersion, refreshContext, pageState, mode, language, setError]);
}
