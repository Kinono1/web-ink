import { matchesAnnotation } from "../../core/annotation-query";
import type { Annotation, AnchorState, Language } from "../../core/model";
import type { FilterKind, AnnotationKind } from "./types";
import { ieeePaperUrl } from "../../core/pdf-context";
import { doiUrl, ieeeSourceUrl, type PdfPaperIdentity } from "../../pdf/public";
export function tagText(tags: string[]): string {
  return tags.join(", ");
}
export function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
export function statusClass(status: AnchorState["status"] | undefined): string {
  return `status ${status ?? "pending"}`;
}
export function matchesQuery(
  annotation: Annotation,
  query: {
    pageUrl?: string;
    kind: FilterKind;
    color: string;
    tag: string;
    text: string;
  },
): boolean {
  return matchesAnnotation(annotation, {
    ...query,
    kind: query.kind === "all" ? undefined : query.kind,
    text: query.text.toLocaleLowerCase(),
  });
}
export function isPdf(
  annotation: Annotation,
): annotation is Extract<Annotation, { kind: "pdf-text" | "pdf-area" }> {
  return annotation.kind === "pdf-text" || annotation.kind === "pdf-area";
}
export function pdfReaderUrl(readerBase: string, record?: Annotation, identity?: PdfPaperIdentity): string {
  let ieeeSource = false;
  if (record && isPdf(record)) {
    const storedDoiSource = doiUrl(record.target.sourceUrl);
    if (storedDoiSource) return storedDoiSource;
    const paper = ieeePaperUrl(identity?.paperUrl) || ieeePaperUrl(record.target.sourceUrl);
    if (record.target.sourceUrl) {
      try { ieeeSourceUrl(record.target.sourceUrl); ieeeSource = true; }
      catch { /* Ordinary PDFs retain their direct reader flow. */ }
    }
    const doi = doiUrl(identity?.doi);
    if (doi && (paper || ieeeSource)) return doi;
    if (paper) return paper;
  }
  const url = new URL(readerBase);
  if (record && isPdf(record)) {
    url.searchParams.set("document", record.target.documentHash);
    url.searchParams.set("page", String(record.target.pageNumber));
    if (record.target.sourceUrl && !ieeeSource)
      url.searchParams.set("source", record.target.sourceUrl);
  }
  return url.href;
}
export function kindFamily(kind: AnnotationKind): "text" | "image" | "pdf" {
  return kind === "text" ? "text" : kind === "image" ? "image" : "pdf";
}
/** The words a row shows for an annotation: the quote, image label, or PDF text. */
export function excerptText(record: Annotation): string {
  return record.kind === "text"
    ? record.target.exact
    : record.kind === "image"
      ? record.target.alt || record.target.context || record.target.src
      : record.target.exact || record.target.fileName;
}
/** Where an annotation came from: page title, PDF file name, or host. */
export function sourceName(record: Annotation): string {
  return (
    record.pageTitle ||
    (isPdf(record) ? record.target.fileName : new URL(record.pageUrl).host)
  );
}
/** Mail-style dates: time today, month and day this year, full date otherwise. */
export function shortDate(value: string, language: Language, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const options: Intl.DateTimeFormatOptions =
    date.toDateString() === now.toDateString()
      ? { timeStyle: "short" }
      : date.getFullYear() === now.getFullYear()
        ? { month: "short", day: "numeric" }
        : { dateStyle: "medium" };
  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en", options).format(date);
}
export function localDate(value: string, language: Language): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
export function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
