import type { Annotation, AnchorState, Language } from "../../core/model";
import type { FilterKind, AnnotationKind } from "./types";
import { ICON_PATHS, type IconName } from "../icons";
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
export function annotationText(annotation: Annotation): string {
  const target =
    annotation.kind === "text"
      ? annotation.target.exact
      : annotation.kind === "image"
        ? `${annotation.target.alt} ${annotation.target.context} ${annotation.target.src}`
        : `${annotation.target.fileName} ${annotation.target.sourceUrl ?? ""} ${annotation.target.exact}`;
  return `${annotation.pageTitle} ${annotation.pageUrl} ${annotation.note} ${annotation.tags.join(" ")} ${target}`.toLocaleLowerCase();
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
  return (
    (!query.pageUrl || annotation.pageUrl === query.pageUrl) &&
    (query.kind === "all" || annotation.kind === query.kind) &&
    (!query.color || annotation.color === query.color) &&
    (!query.tag || annotation.tags.includes(query.tag)) &&
    (!query.text ||
      annotationText(annotation).includes(query.text.toLocaleLowerCase()))
  );
}
export function isPdf(
  annotation: Annotation,
): annotation is Extract<Annotation, { kind: "pdf-text" | "pdf-area" }> {
  return annotation.kind === "pdf-text" || annotation.kind === "pdf-area";
}
export function pdfReaderUrl(readerBase: string, record?: Annotation): string {
  const url = new URL(readerBase);
  if (record && isPdf(record)) {
    url.searchParams.set("document", record.target.documentHash);
    if (record.target.sourceUrl)
      url.searchParams.set("source", record.target.sourceUrl);
  }
  return url.href;
}
export function kindFamily(kind: AnnotationKind): "text" | "image" | "pdf" {
  return kind === "text" ? "text" : kind === "image" ? "image" : "pdf";
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
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

