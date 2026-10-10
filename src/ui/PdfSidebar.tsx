import { useEffect, useRef, useState } from "react";
import type { Language } from "../core/model";
import { PdfNote, type PdfNoteDraft } from "../pdf/PdfNote";
import { connectPdfSidebar } from "../pdf/sidebar-connection";
import type { PdfSidebarCommand, PdfSidebarState } from "../pdf/sidebar-types";

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
  return <section className="pdf-sidebar" aria-label={t("PDF 标注", "PDF annotations")}>
    <header className="pdf-sidebar-context">
      <strong title={view.fileName}>{view.fileName}</strong>
      <span>{t("本篇标注", "Annotations")} {view.totalCount}</span>
    </header>
    {view.error && <p className="alert error" role="alert">{view.error}</p>}
    {view.notice && <p className="pdf-sidebar-notice" role="status">{view.notice}</p>}
    {!records.length && !orphaned.length && <p className="pdf-sidebar-empty">{t("选中文字后选择颜色保存高亮，或用「区域标注」框选图表。", "Select text and choose a color to highlight it, or use Mark area for a figure.")}</p>}
    {[...orphaned.map((draft) => draft.base), ...records].map((record) => <PdfNote
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
    {records.length < view.totalCount && <button className="load-more" disabled={view.locked} onClick={() => send({ type: "more" })}>{t("加载更多", "Load more")}</button>}
    {view.undoRecord && <div className="pdf-sidebar-undo" role="status"><span>{t("标注已移除。", "Annotation removed.")}</span>
      <button disabled={view.locked || !!operation} onClick={() => send({ type: "undo" })}>{t("撤销移除", "Undo remove")}</button></div>}
  </section>;
}
