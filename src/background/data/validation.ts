import type { Annotation, PageRecord, Result } from "../../core/model";
import { MAX_REVISION, ValidationError } from "../../core/validation";
import { pageKey } from "../../core/url";
import { fail } from "../request-result";

export interface DataRequestContext {
  trusted: boolean;
  pageUrl?: string;
  /** Stable background-derived browser document identity for query cancellation. */
  callerKey?: string;
  /** Publish the page determined by the committed deletion. */
  annotationDeleted?: (pageUrl: string, id: string) => Promise<void>;
}

/** Closed set of data messages; shapes are validated by `parseMessage`. */
export type KnownMessage =
  | { type: "annotations.list"; pageUrl?: string }
  | { type: "annotations.get"; id: unknown }
  | { type: "annotations.put"; annotation: unknown; expectedRevision: unknown }
  | { type: "annotations.restore"; annotation: unknown }
  | { type: "annotations.delete"; id: unknown; expectedRevision: unknown }
  | { type: "annotations.query"; query: unknown }
  | { type: "annotations.query.cancel"; requestId: unknown }
  | { type: "settings.get" }
  | { type: "settings.put"; settings: unknown }
  | { type: "page.mode.get"; pageUrl: unknown }
  | { type: "page.mode.put"; pageUrl: unknown; enabled: unknown; selectionTools?: unknown }
  | { type: "storage.stats"; recalculate?: unknown }
  | { type: "backup.export" }
  | { type: "backup.preview"; backup: unknown }
  | { type: "backup.import"; backup: unknown; overwrite: unknown };

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype ? (value as Record<string, unknown>) : undefined;
}

export function hasOnly(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

/** Required/optional keys per protocol type; a table keeps the union and parser in sync. */
const MESSAGE_SHAPES: Record<string, { required: string[]; optional?: string[] }> = {
  "annotations.list": { required: ["type"], optional: ["pageUrl"] },
  "annotations.get": { required: ["type", "id"] },
  "annotations.put": { required: ["type", "annotation", "expectedRevision"] },
  "annotations.restore": { required: ["type", "annotation"] },
  "annotations.delete": { required: ["type", "id", "expectedRevision"] },
  "annotations.query": { required: ["type", "query"] },
  "annotations.query.cancel": { required: ["type", "requestId"] },
  "settings.get": { required: ["type"] },
  "settings.put": { required: ["type", "settings"] },
  "page.mode.get": { required: ["type", "pageUrl"] },
  "page.mode.put": { required: ["type", "pageUrl", "enabled"], optional: ["selectionTools"] },
  "storage.stats": { required: ["type"], optional: ["recalculate"] },
  "backup.export": { required: ["type"] },
  "backup.preview": { required: ["type", "backup"] },
  "backup.import": { required: ["type", "backup", "overwrite"] },
};

export function parseMessage(value: unknown): KnownMessage | undefined {
  const message = record(value);
  if (!message || typeof message.type !== "string" || !Object.hasOwn(MESSAGE_SHAPES, message.type))
    return undefined;
  const shape = MESSAGE_SHAPES[message.type];
  return shape && hasOnly(message, shape.required, shape.optional) ? (message as KnownMessage) : undefined;
}

export function canonicalContextPage(context: DataRequestContext): string | undefined {
  if (context.trusted) return undefined;
  if (!context.pageUrl) throw new ValidationError("Content requests require a sender page URL");
  return canonicalPage(context.pageUrl, "sender page URL");
}

export function canonicalPage(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192)
    throw new ValidationError(`${name} must be an HTTP(S) URL`);
  try { return pageKey(value); } catch { throw new ValidationError(`${name} must be an HTTP(S) URL`); }
}

/** Page-mode writes use the same durable canonical form as annotation records. */
export function canonicalPageUrl(value: unknown, name: string): string {
  const canonical = canonicalPage(value, name);
  if (canonical !== value) throw new ValidationError(`${name} must be a canonical HTTP(S) URL`);
  return canonical;
}

export function pageKeyForMode(value: unknown, name: string, trusted: boolean): string {
  if (trusted && typeof value === "string" && /^urn:web-ink:pdf:[0-9a-f]{64}$/.test(value)) return value;
  return canonicalPageUrl(value, name);
}

export function validExpectedRevision(value: unknown, maximum = MAX_REVISION - 1): number {
  // A put always advances revision by one, so accepting MAX_REVISION would create
  // a record that the persistent schema itself rejects.
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw new ValidationError("expectedRevision must be a non-negative integer");
  return value as number;
}

export function validId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new ValidationError("id has an invalid format");
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${stableJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sameAnnotation(left: Annotation, right: Annotation): boolean {
  return stableJson(left) === stableJson(right);
}

export function committedVersion(annotation: Annotation, expectedRevision: number): Annotation {
  return { ...annotation, revision: expectedRevision + 1 } as Annotation;
}

export function pageRecord(annotation: Annotation, existing?: PageRecord): PageRecord {
  return {
    url: annotation.pageUrl,
    title: annotation.pageTitle,
    updatedAt: annotation.updatedAt,
    ...(existing?.enabled === undefined ? {} : { enabled: existing.enabled }),
    ...(existing?.modeOverride ? { modeOverride: true } : {}),
    ...(!isPdfAnnotation(annotation) && existing?.manualSelectionTools !== undefined
      ? { manualSelectionTools: existing.manualSelectionTools } : {}),
  };
}

export function isPdfAnnotation(
  annotation: Annotation,
): annotation is Extract<Annotation, { kind: "pdf-text" | "pdf-area" }> {
  return annotation.kind === "pdf-text" || annotation.kind === "pdf-area";
}

export function queryOwner(context: DataRequestContext): string {
  return context.callerKey ?? `${context.trusted ? "trusted" : "content"}:${context.pageUrl ?? ""}`;
}

export function requireTrusted(context: DataRequestContext, action: string): Result<never> | undefined {
  return context.trusted ? undefined : fail(`Content scripts cannot ${action}.`, "FORBIDDEN");
}
