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
  const portRef = useRef<chrome.runtime.Port | undefined>(undefined);
  const pendingRef = useRef(new Map<string, boolean>());
  onSavedRef.current = onSaved;
  onErrorRef.current = onError;
  defaultColorRef.current = defaultColor;

  useEffect(() => {
    setSelection(pageUrl ? { type: "selection", pageUrl, status: "empty" } : undefined);
    setLocalPending(0);
    setError(undefined);
    if (tabId === undefined || !pageUrl || typeof chrome.tabs.connect !== "function") return;

    let active = true;
    const pending = new Map<string, boolean>();
    pendingRef.current = pending;
    let port: chrome.runtime.Port;
    try {
      port = chrome.tabs.connect(tabId, { name: SELECTION_PORT_NAME, frameId: 0 });
      portRef.current = port;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      return;
    }
    const receive = (message: WebSelectionReply) => {
      if (!active) return;
      if (message.type === "selection") {
        if (message.pageUrl === pageUrl) {
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
    const disconnected = () => {
      if (!active) return;
      // Reading lastError consumes Chrome's expected no-receiver disconnect warning.
      void chrome.runtime.lastError;
      pending.clear();
      setLocalPending(0);
      const message = "Selection connection closed. Refresh the page and try again.";
      setError(message);
    };
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(disconnected);
    return () => {
      active = false;
      port.onMessage.removeListener(receive);
      port.onDisconnect.removeListener(disconnected);
      if (portRef.current === port) portRef.current = undefined;
      if (pendingRef.current === pending) pendingRef.current = new Map();
      try { port.disconnect(); } catch { /* Chrome may have already closed the port. */ }
    };
  }, [connectionKey, pageUrl, tabId]);

  const selected = (selection?.status === "ready" || selection?.status === "saving") && selection.token && selection.text
    ? selection as SelectionWithText
    : undefined;
  const ready = selected?.status === "ready" ? selected as ReadySelection : undefined;
  const saving = localPending > 0 || selection?.status === "saving";
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
          {COLORS.map((color) => <button
            key={color}
            type="button"
            className="web-selection-color"
            aria-label={language === "zh-CN" ? `高亮 ${color}` : `Highlight ${color}`}
            title={language === "zh-CN" ? `高亮 ${color}` : `Highlight ${color}`}
            style={{ "--selection-color": color } as CSSProperties}
            disabled={saving || !ready}
            onClick={() => send(color, false)}
          />)}
        </div>
        <button type="button" className="quiet web-selection-note" disabled={saving || !ready} aria-label={language === "zh-CN" ? "添加笔记" : "Add note"} onClick={() => send(defaultColorRef.current, true)}>
          {saving ? (language === "zh-CN" ? "正在保存…" : "Saving…") : (language === "zh-CN" ? "添加笔记" : "Add note")}
        </button>
      </div> : null}
      {error ? <p className="web-selection-error" role="alert">{error}</p> : null}
    </section>
  );
}
