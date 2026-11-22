import {
  SCHEMA_VERSION, type Annotation, type BackupEnvelope, type Settings,
} from "./model";
import { isWebPage, pageKey } from "./url";
import { MAX_BACKUP_ANNOTATIONS, validateBackup } from "./validation";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Produce a portable, versioned JSON object. Callers decide how it is downloaded. */
export function serializeBackup(annotations: Annotation[], settings?: Settings): BackupEnvelope {
  const envelope: BackupEnvelope = {
    format: "web-ink", schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(),
    annotations: clone(annotations).sort((a, b) => a.id.localeCompare(b.id)),
    ...(settings === undefined ? {} : { settings: clone(settings) }),
  };
  return validateBackup(envelope);
}

/**
 * Backups written before a page-key rule changed (for example, before tracking
 * parameters were dropped) store the older key. Re-key web pages to the current
 * form so they import and match the page instead of failing validation.
 */
function currentPageKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const backup = value as { annotations?: unknown };
  if (!Array.isArray(backup.annotations) || backup.annotations.length > MAX_BACKUP_ANNOTATIONS) return value;
  let changed = false;
  const annotations = backup.annotations.map((annotation: unknown) => {
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) return annotation;
    const pageUrl = (annotation as { pageUrl?: unknown }).pageUrl;
    if (typeof pageUrl !== "string" || !isWebPage(pageUrl)) return annotation;
    let current: string;
    try { current = pageKey(pageUrl); } catch { return annotation; }
    if (current === pageUrl) return annotation;
    changed = true;
    return { ...annotation, pageUrl: current };
  });
  return changed ? { ...backup, annotations } : value;
}

/** Parse and fully validate before data code starts an import transaction. */
export function parseBackup(value: unknown): BackupEnvelope {
  return validateBackup(currentPageKeys(value));
}

/** Escape content rather than treating annotations as Markdown syntax. */
function markdownInline(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}[\]<>#!()+\-=|~])/g, "\\$1");
}

/** Keep each source line inside a quote; no source line can start a Markdown block. */
function markdownQuote(value: string): string {
  return value
    .split(/\r\n?|\n/)
    .map((line) => `> ${markdownInline(line)}`)
    .join("\n");
}

/** Inline fields use a visible literal newline instead of changing document structure. */
function markdownField(value: string): string {
  return value
    .split(/\r\n?|\n/)
    .map(markdownInline)
    .join("\\n");
}

/** A readable index only: it deliberately references source images instead of exporting drawings. */
export function toMarkdown(annotations: Annotation[]): string {
  const lines = [
    "# Web Ink annotations",
    "",
    `Exported: ${new Date().toISOString()}`,
    "",
 ];
  for (const annotation of [...annotations].sort(
    (a, b) => a.pageUrl.localeCompare(b.pageUrl) || a.id.localeCompare(b.id),
  )) {
    const label =
      annotation.kind === "text"
        ? "Text"
        : annotation.kind === "image"
          ? "Image"
          : annotation.kind === "pdf-text"
            ? "PDF text"
            : "PDF area";
    lines.push(`## ${label} annotation`);
    lines.push(`- Page title: ${markdownField(annotation.pageTitle)}`);
    lines.push(`- URL: ${markdownField(annotation.pageUrl)}`);
    lines.push(`- Created: ${markdownField(annotation.createdAt)}`);
    lines.push(`- Updated: ${markdownField(annotation.updatedAt)}`);
    lines.push(`- Color: ${markdownField(annotation.color)}`);
    if (annotation.tags.length)
      lines.push(`- Tags: ${annotation.tags.map(markdownField).join(", ")}`);
    if (annotation.kind === "text") {
      lines.push("- Text quotation:");
      lines.push(markdownQuote(annotation.target.exact));
    } else if (annotation.kind === "image")
      lines.push(
        `- Image source reference: ${markdownField(annotation.target.src)}`,
      );
    else {
      lines.push(`- PDF file: ${markdownField(annotation.target.fileName)}`);
      lines.push(`- PDF page: ${annotation.target.pageNumber}`);
      if (annotation.target.sourceUrl)
        lines.push(`- Source URL: ${markdownField(annotation.target.sourceUrl)}`);
      if (annotation.kind === "pdf-text") {
        lines.push("- Text quotation:");
        lines.push(markdownQuote(annotation.target.exact));
      }
    }
    if (annotation.note)
      lines.push(`- Note: ${markdownField(annotation.note)}`);
    lines.push("");
  }
  return lines.join("\n");
}
