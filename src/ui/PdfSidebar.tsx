import { useEffect, useRef, useState } from "react";
import type { Language } from "../core/model";
import { PdfNote, type PdfNoteDraft } from "../pdf/PdfNote";
import { connectPdfSidebar } from "../pdf/sidebar-connection";
import type { PdfAnnotationFilter, PdfSidebarCommand, PdfSidebarState } from "../pdf/sidebar-types";
import type { NativePdfAnnotation } from "../pdf/types";

const nativeLabels = new Map<string, [string, string]>([
  ["Highlight", ["高亮", "Highlight"]],
  ["Underline", ["下划线", "Underline"]],
  ["StrikeOut", ["删除线", "Strikethrough"]],
  ["Square", ["矩形", "Rectangle"]],
  ["Text", ["便签", "Sticky note"]],
  ["Ink", ["手写标注", "Handwriting"]],
  ["Popup", ["弹出笔记", "Popup note"]],
]);

export function PdfAnnotationFilters({ filter, language, onFilter }: {
  filter: PdfAnnotationFilter; language: Language; onFilter: (filter: PdfAnnotationFilter) => void;
}) {
  const zh = language === "zh-CN";
  const choices: Array<{ filter: PdfAnnotationFilter; label: string }> = [
    { filter: "all", label: zh ? "全部" : "All" },
    { filter: "web-ink", label: "Web Ink" },
    { filter: "original", label: zh ? "原文件" : "Original" },
  ];
  return <div className="pdf-annotation-filters" role="group" aria-label={zh ? "标注来源" : "Annotation source"}>
    {choices.map((choice) => <button key={choice.filter} aria-pressed={filter === choice.filter}
      onClick={() => onFilter(choice.filter)}>{choice.label}</button>)}
  </div>;
}

export function NativePdfNote({ record, language, onJump }: { record: NativePdfAnnotation; language: Language; onJump: () => void }) {
  const zh = language === "zh-CN";
  const labels = nativeLabels.get(record.subtype);
  const date = record.updatedAt || record.createdAt;
  return <article className="pdf-note pdf-native-note" data-native-annotation={record.key}
    style={{ "--record-color": record.color ? `rgb(${record.color.join(", ")})` : "var(--ink-tertiary)" } as React.CSSProperties}>
    <header><button className="quiet" onClick={onJump}>{zh ? `第 ${record.pageNumber} 页` : `Page ${record.pageNumber}`}</button>
      <span className="pdf-native-label">{zh ? "原文件·只读" : "Original file·read-only"}</span></header>
    <strong>{zh ? "原文件笔记" : "Original file note"} · {labels?.[zh ? 0 : 1] ?? record.subtype}</strong>
    {!labels && <p className="pdf-muted">{zh ? "不支持完整交互" : "Full interaction is not supported"}</p>}
    <p className="pdf-native-contents">{record.contents || (zh ? "无文字笔记" : "No text note")}</p>
    {record.replies?.map((reply) => <blockquote key={reply.id} className="pdf-native-contents">{reply.author && <strong>{reply.author}: </strong>}{reply.contents}</blockquote>)}
    <footer><span>{record.author}</span><span>{date ? <time dateTime={date}>{new Date(date).toLocaleDateString(zh ? "zh-CN" : "en")}</time> : zh ? "日期未知" : "Date unknown"}</span></footer>
  </article>;
}

/** The reader owns drafts and writes; this is its view inside Chrome's one sidebar. */
export function PdfSidebar({ tabId, language }: { tabId?: number; language: Language }) {
  const [view, setView] = useState<PdfSidebarState | null>(null);
  const [pending, setPending] = useState<Record<string, { commandId: string; draft?: PdfNoteDraft; resolveConflict?: boolean }>>({});
  const pendingRef = useRef(pending);
  const replayDrafts = useRef(false);
  const [operation, setOperation] = useState<string>();
  const connection = useRef<ReturnType<typeof connectPdfSidebar> | undefined>(undefined);
  const scope = useRef<string | undefined>(undefined);
  const zh = language === "zh-CN";
  const t = (cn: string, en: string) => zh ? cn : en;
  useEffect(() => {
    setView(null);
    setPending({});
    pendingRef.current = {};
    scope.current = undefined;
    setOperation(undefined);
    const client = connectPdfSidebar("web-ink-pdf-sidebar", (message) => {
      if (message.type === "unavailable") {
        // Only drafts may be replayed; repeating save/delete could write twice.
        replayDrafts.current = true;
        setView(null);
        setOperation(undefined);
      } else if (message.type === "state" && message.state === null) {
        setView(null);
        setPending({});
        pendingRef.current = {};
        scope.current = undefined;
        setOperation(undefined);
      } else if (message.type === "state" && message.state) {
        if (scope.current !== message.state.sessionId) {
          scope.current = message.state.sessionId;
          setPending({});
          pendingRef.current = {};
          setOperation(undefined);
        }
        setView(message.state);
        const next = Object.fromEntries(Object.entries(pendingRef.current).filter(([, value]) => value.commandId !== message.ack));
        pendingRef.current = next;
        setPending(next);
        setOperation((old) => old === message.ack ? undefined : old);
        if (replayDrafts.current) {
          replayDrafts.current = false;
          for (const [id, value] of Object.entries(next)) client.send({
            type: "command", commandId: value.commandId, pageUrl: message.state.pageUrl, sessionId: message.state.sessionId,
            command: { type: "draft", id, draft: value.draft,
              resolveConflict: value.resolveConflict && value.draft?.base.revision === message.state.records.find((record) => record.id === id)?.revision },
          });
        }
      }
    }, () => client.send({ type: "watch", tabId }));
    connection.current = client;
    return () => { connection.current = undefined; client.dispose(); };
  }, [tabId]);
  const send = (command: PdfSidebarCommand) => {
    if (!view) return;
    const commandId = crypto.randomUUID();
    if (["save", "remove", "undo"].includes(command.type)) setOperation(commandId);
    if (command.type === "draft") {
      const next = { ...pendingRef.current, [command.id]: { commandId, draft: command.draft, resolveConflict: command.resolveConflict } };
      pendingRef.current = next;
      setPending(next);
    }
    connection.current?.send({ type: "command", commandId, pageUrl: view.pageUrl, sessionId: view.sessionId, command });
  };
  if (!view) return <p className="loading" role="status">{t("正在连接 PDF…", "Connecting to PDF…")}</p>;
  const ids = new Set(view.records.map((record) => record.id));
  const drafts = { ...view.drafts };
  for (const [id, value] of Object.entries(pending)) {
    if (value.draft) drafts[id] = value.draft;
    else delete drafts[id];
  }
  const orphaned = Object.values(drafts).filter((draft) => !ids.has(draft.base.id));
  const records = view.records.slice().sort((a, b) => a.target.pageNumber - b.target.pageNumber || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const filter = view.nativeFilter ?? "web-ink";
  const originals = view.nativeRecords ?? [];
  const originalCount = view.nativeTotalCount ?? originals.length;
  const count = filter === "web-ink" ? view.totalCount : filter === "original" ? originalCount : view.totalCount + originalCount;
  const originalComplete = !!view.nativeProgress && view.nativeProgress.completed === view.nativeProgress.total;
  return <section className="pdf-sidebar" aria-label={t("PDF 标注", "PDF annotations")}>
    <header className="pdf-sidebar-context">
      <strong title={view.fileName}>{view.fileName}</strong>
      <span>{filter === "original" ? t("原文件标注", "Original annotations") : t("本篇标注", "Annotations")} {count}
        {filter !== "web-ink" && !originalComplete && t("（已读取）", " (read so far)")}</span>
    </header>
    <PdfAnnotationFilters language={language} filter={filter} onFilter={(filter) => send({ type: "filter", filter })} />
    {view.error && <p className="alert error" role="alert">{view.error}</p>}
    {view.notice && <p className="pdf-sidebar-notice" role="status">{view.notice}</p>}
    {filter !== "web-ink" && <>
      {view.nativeError && <p className="alert error" role="alert">{view.nativeError}</p>}
      {view.nativeProgress && <p className="pdf-sidebar-notice" role="status">{t("原文件已读取", "Original pages read")} {view.nativeProgress.completed} / {view.nativeProgress.total}</p>}
      {view.nativeLoading && <button onClick={() => send({ type: "cancel-native" })}>{t("取消读取", "Cancel reading")}</button>}
      {!view.nativeLoading && view.nativeProgress && view.nativeProgress.completed < view.nativeProgress.total &&
        <button onClick={() => send({ type: "filter", filter })}>{t("继续读取原文件标注", "Continue reading original annotations")}</button>}
    </>}
    {filter !== "original" && !records.length && !orphaned.length && <p className="pdf-sidebar-empty">{t("选中文字后选择颜色保存高亮，或用「区域标注」框选图表。", "Select text and choose a color to highlight it, or use Mark area for a figure.")}</p>}
    {filter !== "original" && [...orphaned.map((draft) => draft.base), ...records].map((record) => <PdfNote
      key={record.id} record={record} language={language}
      onJump={() => send({ type: "focus", id: record.id })}
      draft={drafts[record.id]} deleted={!ids.has(record.id)}
      removing={view.removing || !!operation} saving={view.noteSaving === record.id} locked={view.locked || !!operation}
      conflict={view.conflicts[record.id] === true}
      onDraft={(draft, resolveConflict) => send({ type: "draft", id: record.id, draft, resolveConflict })}
      onClearDraft={() => send({ type: "draft", id: record.id })}
      onSave={async () => send({ type: "save", id: record.id })}
      onRemove={() => send({ type: "remove", id: record.id })}
    />)}
    {filter !== "web-ink" && originals.map((record) => <NativePdfNote key={record.key} record={record} language={language} onJump={() => send({ type: "focus-native", key: record.key })} />)}
    {filter !== "web-ink" && <div className="pdf-annotation-filters">
      {(view.nativeOffset ?? 0) > 0 && <button onClick={() => send({ type: "previous-native" })}>{t("上一页原文件标注", "Previous original annotations")}</button>}
      {(view.nativePageEnd ?? originals.length) < originalCount && <button onClick={() => send({ type: "more-native" })}>{t("下一页原文件标注", "Next original annotations")}</button>}
    </div>}
    {filter === "original" && !originalCount && !view.nativeLoading && <p className="pdf-sidebar-empty">{t("已读取的页面中没有原文件标注。", "No original annotations in the pages read.")}</p>}
    {filter !== "original" && records.length < view.totalCount && <button className="load-more" disabled={view.locked} onClick={() => send({ type: "more" })}>{t("加载更多", "Load more")}</button>}
    {view.undoRecord && <div className="pdf-sidebar-undo" role="status"><span>{t("标注已移除。", "Annotation removed.")}</span>
      <button disabled={view.locked || !!operation} onClick={() => send({ type: "undo" })}>{t("撤销移除", "Undo remove")}</button></div>}
  </section>;
}
