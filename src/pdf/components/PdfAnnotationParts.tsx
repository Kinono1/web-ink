import type { Language } from "../../core/model";
import type { NativePdfAnnotation } from "../../core/pdf-types";
import type { PdfAnnotationFilter } from "../../core/sidebar";

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
