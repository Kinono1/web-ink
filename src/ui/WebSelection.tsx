import { useEffect, useRef, useState, type CSSProperties } from "react";
import { COLORS, type Language, type TextAnnotation } from "../core/model";
import {
  SELECTION_PORT_NAME,
  type WebSelectionReply,
  type WebSelectionState,
} from "../core/selection-toolbar";

type SelectionWithText = WebSelectionState & {
  token: string;
  text: string;
};
type ReadySelection = SelectionWithText & { status: "ready" };

export function WebSelection({
  tabId,
  pageUrl,
  language,
  defaultColor,
  connectionKey = 0,
  onSaved,
  onError,
}: {
  tabId?: number;
  pageUrl?: string;
  language: Language;
  defaultColor: string;
  connectionKey?: number;
  onSaved: (annotation: TextAnnotation, startEditing: boolean) => void;
  onError: (message: string) => void;
}) {
  const [selection, setSelection] = useState<WebSelectionState>();
  const [localPending, setLocalPending] = useState(0);
  const [error, setError] = useState<string>();
  const onSavedRef = useRef(onSaved);
  const onErrorRef = useRef(onError);
  const defaultColorRef = useRef(defaultColor);
  const languageRef = useRef(language);
  const portRef = useRef<chrome.runtime.Port | undefined>(undefined);
  const pendingRef = useRef(new Map<string, boolean>());
  onSavedRef.current = onSaved;
  onErrorRef.current = onError;
  defaultColorRef.current = defaultColor;
  languageRef.current = language;

  useEffect(() => {
    setSelection(pageUrl ? { type: "selection", pageUrl, status: "empty" } : undefined);
    setLocalPending(0);
    setError(undefined);
    if (tabId === undefined || !pageUrl || typeof chrome.tabs.connect !== "function") return;

    let active = true;
    const pending = new Map<string, boolean>();
    pendingRef.current = pending;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let port: chrome.runtime.Port | undefined;
    let detachPort: (() => void) | undefined;
    const connectionClosed = () => languageRef.current === "zh-CN"
      ? "选区连接已断开，请刷新网页后重试。"
      : "Selection connection closed. Refresh the page and try again.";
    const clearRetry = () => {
      if (retryTimer === undefined) return;
      clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const retry = () => {
      if (!active || retryTimer !== undefined || retryAttempt >= 3) return;
      const delay = [100, 300, 800][retryAttempt++];
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, delay);
    };
    const receive = (message: WebSelectionReply) => {
      if (!active) return;
      if (message.type === "selection") {
        if (message.pageUrl === pageUrl) {
          clearRetry();
          setError(undefined);
          setSelection(message);
        }
        return;
      }
      const startEditing = pending.get(message.requestId);
      if (startEditing === undefined) return;
      pending.delete(message.requestId);
      setLocalPending(pending.size);
      if (message.type === "saved") {
        setSelection({ type: "selection", pageUrl, status: "empty" });
        onSavedRef.current(message.annotation, startEditing);
        return;
      }
      setError(message.error);
      onErrorRef.current(message.error);
    };
    const connect = () => {
      if (!active) return;
      try {
        const nextPort = chrome.tabs.connect(tabId, { name: SELECTION_PORT_NAME, frameId: 0 });
        port = nextPort;
        portRef.current = nextPort;
        const disconnected = () => {
          if (!active || portRef.current !== nextPort) return;
          // Reading lastError consumes Chrome's expected no-receiver disconnect warning.
          void chrome.runtime.lastError;
          detachPort?.();
          detachPort = undefined;
          port = undefined;
          portRef.current = undefined;
          pending.clear();
          setLocalPending(0);
          setSelection({ type: "selection", pageUrl, status: "empty" });
          setError(connectionClosed());
          retry();
        };
        detachPort = () => {
          nextPort.onMessage.removeListener(receive);
          nextPort.onDisconnect.removeListener(disconnected);
        };
        nextPort.onMessage.addListener(receive);
        nextPort.onDisconnect.addListener(disconnected);
      } catch {
        setError(connectionClosed());
        retry();
      }
    };
    connect();
    return () => {
      active = false;
      clearRetry();
      detachPort?.();
      if (portRef.current === port) portRef.current = undefined;
      if (pendingRef.current === pending) pendingRef.current = new Map();
      try { port?.disconnect(); } catch { /* Chrome may have already closed the port. */ }
    };
  }, [connectionKey, pageUrl, tabId]);

  const selected = (selection?.status === "ready" || selection?.status === "saving") && selection.token && selection.text
    ? selection as SelectionWithText
    : undefined;
  const ready = selected?.status === "ready" ? selected as ReadySelection : undefined;
  const saving = localPending > 0 || selection?.status === "saving";
  const customColor = /^#[0-9a-f]{6}$/i.test(defaultColor) && !COLORS.includes(defaultColor.toLowerCase() as typeof COLORS[number])
    ? defaultColor
    : undefined;
  const colors = customColor ? [...COLORS, customColor] : COLORS;
  const send = (color: string, startEditing: boolean) => {
    if (!ready || saving || tabId === undefined || !pageUrl) return;
    const requestId = crypto.randomUUID();
    const port = portRef.current;
    if (!port) return;
    pendingRef.current.set(requestId, startEditing);
    setLocalPending(pendingRef.current.size);
    setError(undefined);
    try {
      port.postMessage({ type: "annotate", token: ready.token, color, requestId });
    } catch (cause) {
      pendingRef.current.delete(requestId);
      const message = cause instanceof Error ? cause.message : String(cause);
      setLocalPending(pendingRef.current.size);
      setError(message);
      onErrorRef.current(message);
    }
  };

  return (
    <section className="web-selection" role="region" aria-label={language === "zh-CN" ? "当前选区" : "Current selection"}>
      <div className="web-selection-copy">
        <strong>{language === "zh-CN" ? "当前选区" : "Current selection"}</strong>
        {selected ? <p className="web-selection-excerpt">{selected.text}</p> : <p>{selection?.status === "unsupported"
          ? (language === "zh-CN" ? "当前网页不支持选区保存。" : "This webpage does not support selection saving.")
          : selection?.status === "paused"
            ? (language === "zh-CN" ? "此网站已暂停。" : "This site is paused.")
            : (language === "zh-CN" ? "选中网页文字后，可在这里选择高亮颜色或添加笔记。" : "Select webpage text, then choose a highlight color or add a note here.")}</p>}
      </div>
      {selected ? <div className="web-selection-actions">
        <div className="web-selection-colors" aria-label={language === "zh-CN" ? "高亮颜色" : "Highlight colors"}>
          {colors.map((color) => {
            const label = color === customColor
              ? (language === "zh-CN" ? `自定义高亮 ${color}` : `Custom highlight ${color}`)
              : (language === "zh-CN" ? `高亮 ${color}` : `Highlight ${color}`);
            return <button
              key={color}
              type="button"
              className="web-selection-color"
              aria-label={label}
              title={label}
              style={{ "--selection-color": color } as CSSProperties}
              disabled={saving || !ready}
              onClick={() => send(color, false)}
            />;
          })}
        </div>
        <button type="button" className="quiet web-selection-note" disabled={saving || !ready} aria-label={language === "zh-CN" ? "添加笔记" : "Add note"} onClick={() => send(defaultColorRef.current, true)}>
          {saving ? (language === "zh-CN" ? "正在保存…" : "Saving…") : (language === "zh-CN" ? "添加笔记" : "Add note")}
        </button>
      </div> : null}
      {error ? <p className="web-selection-error" role="alert">{error}</p> : null}
    </section>
  );
}
