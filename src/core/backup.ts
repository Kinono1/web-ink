import {
  SCHEMA_VERSION,
  type Annotation,
  type BackupEnvelope,
  type Settings,
} from "./model";
import { validateBackup } from "./validation";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Produce a portable, versioned JSON object. Callers decide how it is downloaded. */
export function serializeBackup(
  annotations: Annotation[],
  settings?: Settings,
): BackupEnvelope {
  const envelope: BackupEnvelope = {
    format: "web-ink",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    annotations: clone(annotations).sort((a, b) => a.id.localeCompare(b.id)),
    ...(settings === undefined ? {} : { settings: clone(settings) }),
  };
  return validateBackup(envelope);
}

/** Parse and fully validate before data code starts an import transaction. */
export function parseBackup(value: unknown): BackupEnvelope {
  return validateBackup(value);
}

/** Escape content rather than treating annotations as Markdown syntax. */
function markdownInline(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]<>#!()+\-=|~])/g, "\\$1");
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
