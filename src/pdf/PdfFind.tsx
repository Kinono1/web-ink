import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/management/helpers";
import { PdfTextSearchIndex, type PdfSearchMatch, type PdfSearchProgress, type PdfSearchResult } from "./search";
import type { Language } from "../core/model";
import type { OpenDocument } from "./types";

export function PdfFind({ opened, language, blocked, onMatch, onNavigate }: {
  opened: OpenDocument;
  language: Language;
  blocked: boolean;
  onMatch: (match: PdfSearchMatch | undefined) => void;
  onNavigate: (pageNumber: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<PdfSearchResult>();
  const [progress, setProgress] = useState<PdfSearchProgress>();
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onMatch, onNavigate, blocked });
  callbacks.current = { onMatch, onNavigate, blocked };
  const index = useMemo(() => new PdfTextSearchIndex(opened.document), [opened]);
  const zh = language === "zh-CN";
  const t = (cn: string, en: string) => zh ? cn : en;
  useEffect(() => () => index.dispose(), [index]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (blocked || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
        input.current?.focus();
        input.current?.select();
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("keydown", shortcut, true);
    return () => document.removeEventListener("keydown", shortcut, true);
  }, [open, blocked]);
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    setProgress(undefined);
    setSelected(0);
    setError(false);
    callbacks.current.onMatch(undefined);
    const active = open && !blocked && !!query.trim();
    setSearching(active);
    if (!active) return () => controller.abort();
    const timer = setTimeout(() => {
      void index.search(query, { signal: controller.signal, onProgress: setProgress }).then((found) => {
        if (controller.signal.aborted || callbacks.current.blocked) return;
        setResult(found);
        setSearching(false);
        const first = found.matches[0];
        callbacks.current.onMatch(first);
        if (first) callbacks.current.onNavigate(first.pageNumber);
      }).catch(() => {
        if (!controller.signal.aborted) { setSearching(false); setError(true); }
      });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [index, open, query, blocked]);
  function move(delta: number) {
    const matches = result?.matches;
    if (blocked || !matches?.length || searching) return;
    const next = (selected + delta + matches.length) % matches.length;
    setSelected(next);
    callbacks.current.onMatch(matches[next]);
    callbacks.current.onNavigate(matches[next]!.pageNumber);
  }
  return <div className="pdf-find-tool">
    <button className="quiet icon-button" ref={trigger} aria-label={t("搜索 PDF", "Search PDF")} title={t("搜索 PDF（⌘/Ctrl+F）", "Search PDF (⌘/Ctrl+F)")}
      aria-expanded={open} disabled={blocked} onClick={() => setOpen((value) => !value)}><Icon name="search" /></button>
    {open && <section className="pdf-find" role="search" aria-label={t("PDF 文内搜索", "Find in PDF")}>
      <input ref={input} autoFocus aria-label={t("搜索 PDF 文字", "Search PDF text")} value={query} maxLength={200}
        placeholder={t("搜索这份 PDF", "Search this PDF")} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
      <div className="pdf-find-actions">
        <span className="pdf-find-count" role="status">{searching ? t(`正在搜索 ${progress?.scannedPages ?? 0}/${opened.document.numPages} 页…`, `Searching ${progress?.scannedPages ?? 0}/${opened.document.numPages} pages…`)
          : result ? `${result.matches.length ? selected + 1 : 0} / ${result.limited ? "10,000+" : result.total}` : t("输入关键词", "Enter a search term")}</span>
        <button className="quiet icon-button pdf-previous" aria-label={t("上一处", "Previous match")} disabled={blocked || searching || !result?.matches.length} onClick={() => move(-1)}><Icon name="chevron" /></button>
        <button className="quiet icon-button" aria-label={t("下一处", "Next match")} disabled={blocked || searching || !result?.matches.length} onClick={() => move(1)}><Icon name="chevron" /></button>
        <button className="quiet icon-button" aria-label={t("关闭搜索", "Close search")} onClick={() => { setOpen(false); trigger.current?.focus(); }}><Icon name="close" /></button>
      </div>
      {result?.failedPages ? <p role="status">{t(`${result.failedPages} 页无法提取文字，搜索结果可能不完整。`, `Text could not be read on ${result.failedPages} pages. Results may be incomplete.`)}</p>
        : result && !result.textPages && <p role="status">{t("这份 PDF 没有可搜索文字，仍可使用区域标注。", "This PDF has no searchable text. Area annotations are available.")}</p>}
      {result?.limited && <p>{t("可浏览前 10,000 处结果，请输入更具体的关键词。", "The first 10,000 matches are available. Refine the search for fewer results.")}</p>}
      {error && <p role="alert">{t("搜索暂时失败，请修改关键词后重试。", "Search failed. Change the query to try again.")}</p>}
    </section>}
  </div>;
}
