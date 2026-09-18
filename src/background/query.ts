import type {
  Annotation,
  AnnotationCursor,
  AnnotationPage,
  AnnotationQuery,
} from "../core/model";
import { ValidationError } from "../core/validation";
import { getDatabase } from "./database";

const FIRST_BATCH_SIZE = 25;
const RESIDUAL_BATCH_SIZE = 128;
const PRE_CANCEL_TTL_MS = 5_000;
const MAX_PRE_CANCELS = 1_024;

type QueryTask = { cancelled: boolean };

/** Request IDs are only meaningful within a browser-document owner namespace. */
export class QueryTaskRegistry {
  private readonly active = new Map<string, QueryTask>();
  private readonly preCancelled = new Map<string, number>();

  start(owner: string, requestId: string): QueryTask {
    this.prune();
    const key = this.key(owner, requestId);
    this.active.get(key) && (this.active.get(key)!.cancelled = true);
    const task = { cancelled: this.preCancelled.delete(key) };
    this.active.set(key, task);
    return task;
  }

  cancel(owner: string, requestId: string): void {
    this.prune();
    const key = this.key(owner, requestId);
    const task = this.active.get(key);
    if (task) task.cancelled = true;
    else {
      this.preCancelled.set(key, Date.now() + PRE_CANCEL_TTL_MS);
      while (this.preCancelled.size > MAX_PRE_CANCELS)
        this.preCancelled.delete(
          this.preCancelled.keys().next().value as string,
        );
    }
  }

  complete(owner: string, requestId: string, task: QueryTask): void {
    const key = this.key(owner, requestId);
    if (this.active.get(key) === task) this.active.delete(key);
  }

  private key(owner: string, requestId: string): string {
    return `${owner}\u0000${requestId}`;
  }
  private prune(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.preCancelled)
      if (expiresAt <= now) this.preCancelled.delete(key);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnly(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    throw new ValidationError("id has an invalid format");
  return value;
}

export function validQueryId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    throw new ValidationError(`${name} is invalid`);
  return value;
}

function validCursor(value: unknown): AnnotationCursor {
  const cursor = record(value);
  if (!cursor || !hasOnly(cursor, ["updatedAt", "id"]))
    throw new ValidationError("query.cursor is invalid");
  const updatedAt = cursor.updatedAt;
  if (
    typeof updatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(updatedAt) ||
    Number.isNaN(Date.parse(updatedAt))
  )
    throw new ValidationError("query.cursor.updatedAt is invalid");
  return { updatedAt, id: validId(cursor.id) };
}

export function validateAnnotationQuery(
  value: unknown,
  trusted: boolean,
  pageKeyForMode: (value: unknown, name: string, trusted: boolean) => string,
): AnnotationQuery {
  const query = record(value);
  if (
    !query ||
    !hasOnly(
      query,
      [],
      [
        "pageUrl",
        "kind",
        "color",
        "tag",
        "text",
        "cursor",
        "limit",
        "requestId",
      ],
    )
  )
    throw new ValidationError("query is malformed");
  const pageUrl =
    query.pageUrl === undefined
      ? undefined
      : pageKeyForMode(query.pageUrl, "query.pageUrl", trusted);
  const kind = query.kind;
  if (
    kind !== undefined &&
    kind !== "text" &&
    kind !== "image" &&
    kind !== "pdf-text" &&
    kind !== "pdf-area"
  )
    throw new ValidationError("query.kind is unsupported");
  const color =
    query.color === undefined ? undefined : String(query.color).toLowerCase();
  if (color !== undefined && !/^#[0-9a-f]{6}$/.test(color))
    throw new ValidationError("query.color is invalid");
  const tag = query.tag === undefined ? undefined : query.tag;
  if (
    tag !== undefined &&
    (typeof tag !== "string" ||
      tag.length < 1 ||
      tag.length > 64 ||
      /[\u0000-\u001F\u007F]/.test(tag))
  )
    throw new ValidationError("query.tag is invalid");
  const text = query.text === undefined ? undefined : query.text;
  if (
    text !== undefined &&
    (typeof text !== "string" ||
      text.length > 500 ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text))
  )
    throw new ValidationError("query.text is invalid");
  const limit = query.limit === undefined ? 25 : query.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1)
    throw new ValidationError("query.limit is invalid");
  return {
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(kind === undefined ? {} : { kind }),
    ...(color === undefined ? {} : { color }),
    ...(tag === undefined ? {} : { tag }),
    ...(text === undefined ? {} : { text: text.toLocaleLowerCase() }),
    ...(query.cursor === undefined
      ? {}
      : { cursor: validCursor(query.cursor) }),
    limit: Math.min(limit as number, 50),
    ...(query.requestId === undefined
      ? {}
      : { requestId: validQueryId(query.requestId, "query.requestId") }),
  };
}

function annotationMatches(
  annotation: Annotation,
  query: AnnotationQuery,
): boolean {
  if (query.kind && annotation.kind !== query.kind) return false;
  if (query.color && annotation.color !== query.color) return false;
  if (query.tag && !annotation.tags.includes(query.tag)) return false;
  if (!query.text) return true;
  const target =
    annotation.kind === "text"
      ? annotation.target.exact
      : annotation.kind === "image"
        ? `${annotation.target.alt} ${annotation.target.context} ${annotation.target.src}`
        : `${annotation.target.fileName} ${annotation.target.sourceUrl ?? ""} ${annotation.target.exact}`;
  return `${annotation.pageTitle} ${annotation.pageUrl} ${annotation.note} ${annotation.tags.join(" ")} ${target}`
    .toLocaleLowerCase()
    .includes(query.text);
}

function querySource(query: AnnotationQuery, cursor?: AnnotationCursor) {
  const db = getDatabase();
  if (query.pageUrl)
    return cursor
      ? db.annotations
          .where("[pageUrl+updatedAt+id]")
          .between(
            [query.pageUrl, "", ""],
            [query.pageUrl, cursor.updatedAt, cursor.id],
            true,
            false,
          )
          .reverse()
      : db.annotations
          .where("[pageUrl+updatedAt+id]")
          .between(
            [query.pageUrl, "", ""],
            [query.pageUrl, "\uffff", "\uffff"],
            true,
            true,
          )
          .reverse();
  if (query.kind)
    return cursor
      ? db.annotations
          .where("[kind+updatedAt+id]")
          .between(
            [query.kind, "", ""],
            [query.kind, cursor.updatedAt, cursor.id],
            true,
            false,
          )
          .reverse()
      : db.annotations
          .where("[kind+updatedAt+id]")
          .between(
            [query.kind, "", ""],
            [query.kind, "\uffff", "\uffff"],
            true,
            true,
          )
          .reverse();
  if (query.color)
    return cursor
      ? db.annotations
          .where("[color+updatedAt+id]")
          .between(
            [query.color, "", ""],
            [query.color, cursor.updatedAt, cursor.id],
            true,
            false,
          )
          .reverse()
      : db.annotations
          .where("[color+updatedAt+id]")
          .between(
            [query.color, "", ""],
            [query.color, "\uffff", "\uffff"],
            true,
            true,
          )
          .reverse();
  return cursor
    ? db.annotations
        .where("[updatedAt+id]")
        .below([cursor.updatedAt, cursor.id])
        .reverse()
    : db.annotations.orderBy("[updatedAt+id]").reverse();
}

function needsResidualFiltering(query: AnnotationQuery): boolean {
  return Boolean(
    query.text ||
    query.tag ||
    (query.pageUrl && (query.kind || query.color)) ||
    (query.kind && query.color),
  );
}

/**
 * Retains the native getAll/toArray fast path. The initial residual batch stays
 * at 25 so an immediately cancelled request cannot read more than that batch.
 */
export async function executeAnnotationQuery(
  query: AnnotationQuery,
  owner: string,
  registry: QueryTaskRegistry,
): Promise<AnnotationPage> {
  const requestId = query.requestId;
  const task = requestId ? registry.start(owner, requestId) : undefined;
  try {
    if (task?.cancelled) return { items: [], cancelled: true };
    const limit = query.limit ?? 25;
    if (!needsResidualFiltering(query)) {
      const rows = await querySource(query, query.cursor)
        .limit(limit + 1)
        .toArray();
      if (task?.cancelled) return { items: [], cancelled: true };
      const hasNext = rows.length > limit;
      const items = hasNext ? rows.slice(0, limit) : rows;
      const last = items.at(-1);
      return {
        items,
        ...(hasNext && last
          ? { nextCursor: { updatedAt: last.updatedAt, id: last.id } }
          : {}),
      };
    }
    const items: Annotation[] = [];
    let cursor = query.cursor;
    let batchSize = FIRST_BATCH_SIZE;
    let hasNext = false;
    while (items.length <= limit) {
      if (task?.cancelled) return { items: [], cancelled: true };
      const rows = await querySource(query, cursor).limit(batchSize).toArray();
      if (task?.cancelled) return { items: [], cancelled: true };
      if (!rows.length) break;
      for (const annotation of rows) {
        cursor = { updatedAt: annotation.updatedAt, id: annotation.id };
        if (annotationMatches(annotation, query)) items.push(annotation);
        if (items.length > limit) {
          hasNext = true;
          break;
        }
      }
      if (hasNext || rows.length < batchSize) break;
      batchSize = RESIDUAL_BATCH_SIZE;
    }
    const visibleItems = hasNext ? items.slice(0, limit) : items;
    const last = visibleItems.at(-1);
    return {
      items: visibleItems,
      ...(hasNext && last
        ? { nextCursor: { updatedAt: last.updatedAt, id: last.id } }
        : {}),
    };
  } finally {
    if (requestId && task) registry.complete(owner, requestId, task);
  }
}
