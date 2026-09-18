import type {
  Annotation,
  ImportPreview,
  PageMode,
  PageRecord,
  Result,
  Settings,
} from "../core/model";
import { DEFAULT_SETTINGS } from "../core/model";
import { pageKey } from "../core/url";
import { parseBackup, serializeBackup } from "../core/backup";
import {
  MAX_REVISION,
  ValidationError,
  validateAnnotation,
  validateSettings,
} from "../core/validation";
import { getDatabase } from "./database";
import {
  executeAnnotationQuery,
  QueryTaskRegistry,
  validateAnnotationQuery,
  validQueryId,
} from "./query";
import { applyIncrementalStats, getStorageStats } from "./storage-stats";

const SETTINGS_KEY = "settings";
export { SETTINGS_KEY };
/** Backups may carry settings for portability, but imports always retain local policy. */
export const IMPORT_SETTINGS_POLICY = "keep-local" as const;

export interface DataRequestContext {
  trusted: boolean;
  pageUrl?: string;
  /** Stable background-derived browser document identity for query cancellation. */
  callerKey?: string;
}

type KnownMessage =
  | { type: "annotations.list"; pageUrl?: string }
  | { type: "annotations.put"; annotation: unknown; expectedRevision: unknown }
  | { type: "annotations.restore"; annotation: unknown }
  | { type: "annotations.delete"; id: unknown; expectedRevision: unknown }
  | { type: "annotations.query"; query: unknown }
  | { type: "annotations.query.cancel"; requestId: unknown }
  | { type: "settings.get" }
  | { type: "settings.put"; settings: unknown }
  | { type: "page.mode.get"; pageUrl: unknown }
  | { type: "page.mode.put"; pageUrl: unknown; enabled: unknown }
  | { type: "storage.stats"; recalculate?: unknown }
  | { type: "backup.export" }
  | { type: "backup.preview"; backup: unknown }
  | { type: "backup.import"; backup: unknown; overwrite: unknown };

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}
function fail(error: string, code?: string): Result<never> {
  return { ok: false, error, ...(code === undefined ? {} : { code }) };
}
function invalid(error: string): Result<never> {
  return fail(error, "INVALID_INPUT");
}
const queryTasks = new QueryTaskRegistry();

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

function parseMessage(value: unknown): KnownMessage | undefined {
  const message = record(value);
  if (!message || typeof message.type !== "string") return undefined;
  switch (message.type) {
    case "annotations.list":
      return hasOnly(message, ["type"], ["pageUrl"])
        ? (message as KnownMessage)
        : undefined;
    case "annotations.put":
      return hasOnly(message, ["type", "annotation", "expectedRevision"])
        ? (message as KnownMessage)
        : undefined;
    case "annotations.restore":
      return hasOnly(message, ["type", "annotation"])
        ? (message as KnownMessage)
        : undefined;
    case "annotations.delete":
      return hasOnly(message, ["type", "id", "expectedRevision"])
        ? (message as KnownMessage)
        : undefined;
    case "annotations.query":
      return hasOnly(message, ["type", "query"])
        ? (message as KnownMessage)
        : undefined;
    case "annotations.query.cancel":
      return hasOnly(message, ["type", "requestId"])
        ? (message as KnownMessage)
        : undefined;
    case "settings.get":
    case "backup.export":
      return hasOnly(message, ["type"]) ? (message as KnownMessage) : undefined;
    case "storage.stats":
      return hasOnly(message, ["type"], ["recalculate"])
        ? (message as KnownMessage)
        : undefined;
    case "settings.put":
      return hasOnly(message, ["type", "settings"])
        ? (message as KnownMessage)
        : undefined;
    case "page.mode.get":
      return hasOnly(message, ["type", "pageUrl"])
        ? (message as KnownMessage)
        : undefined;
    case "page.mode.put":
      return hasOnly(message, ["type", "pageUrl", "enabled"])
        ? (message as KnownMessage)
        : undefined;
    case "backup.preview":
      return hasOnly(message, ["type", "backup"])
        ? (message as KnownMessage)
        : undefined;
    case "backup.import":
      return hasOnly(message, ["type", "backup", "overwrite"])
        ? (message as KnownMessage)
        : undefined;
    default:
      return undefined;
  }
}

function canonicalContextPage(context: DataRequestContext): string | undefined {
  if (context.trusted) return undefined;
  if (!context.pageUrl)
    throw new ValidationError("Content requests require a sender page URL");
  return canonicalPage(context.pageUrl, "sender page URL");
}

function canonicalPage(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192)
    throw new ValidationError(`${name} must be an HTTP(S) URL`);
  try {
    return pageKey(value);
  } catch {
    throw new ValidationError(`${name} must be an HTTP(S) URL`);
  }
}

/** Page-mode writes use the same durable canonical form as annotation records. */
function canonicalPageUrl(value: unknown, name: string): string {
  const canonical = canonicalPage(value, name);
  if (canonical !== value)
    throw new ValidationError(`${name} must be a canonical HTTP(S) URL`);
  return canonical;
}

function pageKeyForMode(
  value: unknown,
  name: string,
  trusted: boolean,
): string {
  if (
    trusted &&
    typeof value === "string" &&
    /^urn:web-ink:pdf:[0-9a-f]{64}$/.test(value)
  )
    return value;
  return canonicalPageUrl(value, name);
}

function validExpectedRevision(value: unknown): number {
  // A put always advances revision by one, so accepting MAX_REVISION would create
  // a record that the persistent schema itself rejects.
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= MAX_REVISION
  ) {
    throw new ValidationError(
      "expectedRevision must be a non-negative integer",
    );
  }
  return value as number;
}

function validId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    throw new ValidationError("id has an invalid format");
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(source[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameAnnotation(left: Annotation, right: Annotation): boolean {
  return stableJson(left) === stableJson(right);
}

function committedVersion(
  annotation: Annotation,
  expectedRevision: number,
): Annotation {
  return { ...annotation, revision: expectedRevision + 1 } as Annotation;
}

function pageRecord(annotation: Annotation, existing?: PageRecord): PageRecord {
  return {
    url: annotation.pageUrl,
    title: annotation.pageTitle,
    updatedAt: annotation.updatedAt,
    ...(existing?.enabled === undefined ? {} : { enabled: existing.enabled }),
  };
}

function isPdfAnnotation(
  annotation: Annotation,
): annotation is Extract<Annotation, { kind: "pdf-text" | "pdf-area" }> {
  return annotation.kind === "pdf-text" || annotation.kind === "pdf-area";
}

async function readSettings(): Promise<Settings> {
  const result = (await chrome.storage.local.get(SETTINGS_KEY)) as Record<
    string,
    unknown
  >;
  if (result[SETTINGS_KEY] === undefined)
    return structuredClone(DEFAULT_SETTINGS);
  try {
    return validateSettings(result[SETTINGS_KEY]);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function listAnnotations(pageUrl?: string): Promise<Annotation[]> {
  const db = getDatabase();
  const rows =
    pageUrl === undefined
      ? await db.annotations.toArray()
      : await db.annotations.where("pageUrl").equals(pageUrl).toArray();
  return rows.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

async function getPageMode(pageUrl: string): Promise<PageMode> {
  const page = await getDatabase().pages.get(pageUrl);
  // Reads are deliberately side-effect free: an unopened page stays absent from pages.
  return { enabled: page?.enabled === true };
}

async function putPageMode(
  pageUrl: string,
  enabled: boolean,
): Promise<Result<PageMode>> {
  if (enabled) {
    const settings = await readSettings();
    if (settings.disabledOrigins.includes(new URL(pageUrl).origin)) {
      return fail("This site is paused and cannot be enabled.", "FORBIDDEN");
    }
  }
  const db = getDatabase();
  return db.transaction("rw", db.pages, db.stats, async () => {
    const existing = await db.pages.get(pageUrl);
    const stored: PageRecord = {
      url: pageUrl,
      title: existing?.title ?? "",
      updatedAt: new Date().toISOString(),
      enabled,
    };
    await db.pages.put(stored);
    await applyIncrementalStats({
      ...(existing ? { beforePage: existing } : {}),
      afterPage: stored,
    });
    return ok({ enabled });
  });
}

async function putAnnotation(
  annotation: Annotation,
  expectedRevision: number,
  ownPage?: string,
): Promise<Result<Annotation>> {
  if (annotation.revision !== expectedRevision)
    return fail(
      "annotation.revision must equal expectedRevision",
      "INVALID_INPUT",
    );
  const db = getDatabase();
  return db.transaction(
    "rw",
    db.annotations,
    db.pages,
    db.stats,
    db.tombstones,
    async () => {
      const existing = await db.annotations.get(annotation.id);
      const candidate = committedVersion(annotation, expectedRevision);
      // Check the owner from the transactional read, rather than trusting an ID and
      // page URL supplied by an untrusted content script.
      if (existing && ownPage !== undefined && existing.pageUrl !== ownPage) {
        return fail(
          "Content scripts may only write annotations from their own page.",
          "FORBIDDEN",
        );
      }
      // A service-worker retry may carry the pre-commit revision. Do not turn it into another edit.
      if (existing && sameAnnotation(existing, candidate)) return ok(existing);
      if (existing && existing.revision !== expectedRevision)
        return fail("Annotation changed in another tab.", "CONFLICT");
      if (!existing && (await db.tombstones.get(annotation.id)))
        return fail(
          "Annotation was deleted; restore it through its tombstone.",
          "CONFLICT",
        );
      if (!existing && expectedRevision !== 0)
        return fail("Annotation no longer exists.", "CONFLICT");
      const existingPage = await db.pages.get(candidate.pageUrl);
      const storedPage = pageRecord(candidate, existingPage);
      await db.annotations.put(candidate);
      await db.pages.put(storedPage);
      await applyIncrementalStats({
        ...(existing ? { beforeAnnotation: existing } : {}),
        afterAnnotation: candidate,
        ...(existingPage ? { beforePage: existingPage } : {}),
        afterPage: storedPage,
      });
      return ok(candidate);
    },
  );
}

async function restoreAnnotation(
  annotation: Annotation,
  ownPage?: string,
): Promise<Result<Annotation>> {
  const db = getDatabase();
  return db.transaction(
    "rw",
    db.annotations,
    db.pages,
    db.stats,
    db.tombstones,
    async () => {
      const tombstone = await db.tombstones.get(annotation.id);
      const existing = await db.annotations.get(annotation.id);
      if (!tombstone)
        return fail(
          "Annotation cannot be restored because its deletion generation is unavailable.",
          "CONFLICT",
        );
      if (ownPage !== undefined && tombstone.pageUrl !== ownPage)
        return fail(
          "Content scripts may only restore annotations from their own page.",
          "FORBIDDEN",
        );
      if (
        annotation.pageUrl !== tombstone.pageUrl ||
        annotation.revision !== tombstone.revision
      )
        return fail("Annotation deletion generation has changed.", "CONFLICT");
      if (tombstone.revision >= MAX_REVISION)
        throw new ValidationError("Annotation revision limit reached.");
      const restored = {
        ...annotation,
        revision: tombstone.revision + 1,
      } as Annotation;
      if (existing) {
        if (sameAnnotation(existing, restored)) return ok(existing);
        return fail(
          "Annotation ID has been reused by a newer record.",
          "CONFLICT",
        );
      }
      const existingPage = await db.pages.get(restored.pageUrl);
      const storedPage = pageRecord(restored, existingPage);
      await db.annotations.put(restored);
      await db.pages.put(storedPage);
      await applyIncrementalStats({
        afterAnnotation: restored,
        ...(existingPage ? { beforePage: existingPage } : {}),
        afterPage: storedPage,
      });
      return ok(restored);
    },
  );
}

async function deleteAnnotation(
  id: string,
  expectedRevision: number,
  ownPage?: string,
): Promise<Result<{ id: string; deleted: true }>> {
  const db = getDatabase();
  return db.transaction(
    "rw",
    db.annotations,
    db.stats,
    db.tombstones,
    async () => {
      const existing = await db.annotations.get(id);
      if (!existing) return fail("Annotation no longer exists.", "CONFLICT");
      if (ownPage !== undefined && existing.pageUrl !== ownPage)
        return fail(
          "Content scripts may only delete annotations from their own page.",
          "FORBIDDEN",
        );
      if (existing.revision !== expectedRevision)
        return fail("Annotation changed in another tab.", "CONFLICT");
      await db.annotations.delete(id);
      await db.tombstones.put({
        id: existing.id,
        pageUrl: existing.pageUrl,
        revision: existing.revision,
      });
      await applyIncrementalStats({ beforeAnnotation: existing });
      return ok({ id, deleted: true });
    },
  );
}

function classifyImport(
  incoming: Annotation[],
  existing: Array<Annotation | undefined>,
): ImportPreview {
  let added = 0;
  let identical = 0;
  let conflicts = 0;
  for (let index = 0; index < incoming.length; index += 1) {
    const candidate = incoming[index];
    if (!candidate) continue;
    const local = existing[index];
    if (!local) added += 1;
    else if (sameAnnotation(local, candidate)) identical += 1;
    else conflicts += 1;
  }
  return { added, identical, conflicts, total: incoming.length };
}

async function previewBackup(
  annotations: Annotation[],
): Promise<ImportPreview> {
  const db = getDatabase();
  return classifyImport(
    annotations,
    await db.annotations.bulkGet(
      annotations.map((annotation) => annotation.id),
    ),
  );
}

async function importBackup(
  annotations: Annotation[],
  overwrite: boolean,
): Promise<ImportPreview> {
  const db = getDatabase();
  // `parseBackup` ran before this call. All mutations below are one Dexie transaction.
  return db.transaction(
    "rw",
    db.annotations,
    db.pages,
    db.stats,
    db.tombstones,
    async () => {
      const existing = await db.annotations.bulkGet(
        annotations.map((annotation) => annotation.id),
      );
      const preview = classifyImport(annotations, existing);
      for (let index = 0; index < annotations.length; index += 1) {
        const incoming = annotations[index];
        if (!incoming) continue;
        const local = existing[index];
        if (!local || (overwrite && !sameAnnotation(local, incoming))) {
          // Imported revisions are foreign clocks. A local overwrite is a new local
          // mutation, so it must advance the local clock and invalidate stale tabs.
          if (local && local.revision >= MAX_REVISION)
            throw new ValidationError("Annotation revision limit reached.");
          const tombstone = !local
            ? await db.tombstones.get(incoming.id)
            : undefined;
          if (
            tombstone &&
            Math.max(incoming.revision, tombstone.revision) >= MAX_REVISION
          )
            throw new ValidationError("Annotation revision limit reached.");
          const stored = local
            ? ({ ...incoming, revision: local.revision + 1 } as Annotation)
            : tombstone
              ? ({
                  ...incoming,
                  revision: Math.max(incoming.revision, tombstone.revision) + 1,
                } as Annotation)
              : incoming;
          const existingPage = await db.pages.get(stored.pageUrl);
          const storedPage = pageRecord(stored, existingPage);
          await db.annotations.put(stored);
          await db.pages.put(storedPage);
          await applyIncrementalStats({
            ...(local ? { beforeAnnotation: local } : {}),
            afterAnnotation: stored,
            ...(existingPage ? { beforePage: existingPage } : {}),
            afterPage: storedPage,
          });
        }
      }
      return preview;
    },
  );
}

function queryOwner(context: DataRequestContext): string {
  return (
    context.callerKey ??
    `${context.trusted ? "trusted" : "content"}:${context.pageUrl ?? ""}`
  );
}

function requireTrusted(
  context: DataRequestContext,
  action: string,
): Result<never> | undefined {
  return context.trusted
    ? undefined
    : fail(`Content scripts cannot ${action}.`, "FORBIDDEN");
}

/**
 * Single storage authority for the extension service worker. `trusted` identifies the
 * extension UI; sender URLs are canonicalized before content-script data access.
 */
export async function handleDataRequest(
  message: unknown,
  context: DataRequestContext,
): Promise<Result<unknown>> {
  try {
    const request = parseMessage(message);
    if (!request) return invalid("Unsupported or malformed data request.");
    const ownPage = canonicalContextPage(context);
    switch (request.type) {
      case "annotations.list": {
        const requested =
          request.pageUrl === undefined
            ? ownPage
            : pageKeyForMode(request.pageUrl, "pageUrl", context.trusted);
        if (!context.trusted && requested !== ownPage)
          return fail(
            "Content scripts may only list their own page.",
            "FORBIDDEN",
          );
        return ok(await listAnnotations(requested));
      }
      case "annotations.put": {
        const annotation = validateAnnotation(request.annotation);
        if (isPdfAnnotation(annotation) && !context.trusted)
          return fail(
            "Content scripts cannot write PDF annotations.",
            "FORBIDDEN",
          );
        if (!context.trusted && annotation.pageUrl !== ownPage)
          return fail(
            "Content scripts may only write their own page.",
            "FORBIDDEN",
          );
        return putAnnotation(
          annotation,
          validExpectedRevision(request.expectedRevision),
          ownPage,
        );
      }
      case "annotations.restore": {
        const annotation = validateAnnotation(request.annotation);
        if (isPdfAnnotation(annotation) && !context.trusted)
          return fail(
            "Content scripts cannot restore PDF annotations.",
            "FORBIDDEN",
          );
        if (!context.trusted && annotation.pageUrl !== ownPage)
          return fail(
            "Content scripts may only restore their own page.",
            "FORBIDDEN",
          );
        return restoreAnnotation(annotation, ownPage);
      }
      case "annotations.delete":
        return deleteAnnotation(
          validId(request.id),
          validExpectedRevision(request.expectedRevision),
          ownPage,
        );
      case "annotations.query": {
        const query = validateAnnotationQuery(
          request.query,
          context.trusted,
          pageKeyForMode,
        );
        if (
          !context.trusted &&
          (!query.pageUrl ||
            query.pageUrl !== ownPage ||
            query.kind === "pdf-text" ||
            query.kind === "pdf-area")
        )
          return fail(
            "Content scripts may only query their own web page.",
            "FORBIDDEN",
          );
        return ok(
          await executeAnnotationQuery(query, queryOwner(context), queryTasks),
        );
      }
      case "annotations.query.cancel": {
        const requestId = validQueryId(request.requestId, "requestId");
        queryTasks.cancel(queryOwner(context), requestId);
        return ok(true);
      }
      case "page.mode.get": {
        const requested = pageKeyForMode(
          request.pageUrl,
          "pageUrl",
          context.trusted,
        );
        if (!context.trusted && requested !== ownPage)
          return fail(
            "Content scripts may only read their own page mode.",
            "FORBIDDEN",
          );
        return ok(await getPageMode(requested));
      }
      case "page.mode.put": {
        const requested = pageKeyForMode(
          request.pageUrl,
          "pageUrl",
          context.trusted,
        );
        if (typeof request.enabled !== "boolean")
          return invalid("enabled must be a boolean");
        if (!context.trusted && requested !== ownPage)
          return fail(
            "Content scripts may only change their own page mode.",
            "FORBIDDEN",
          );
        return putPageMode(requested, request.enabled);
      }
      case "settings.get":
        return ok(await readSettings());
      case "storage.stats": {
        const forbidden = requireTrusted(
          context,
          "read whole-library storage usage",
        );
        if (forbidden) return forbidden;
        if (
          request.recalculate !== undefined &&
          typeof request.recalculate !== "boolean"
        )
          return invalid("recalculate must be a boolean");
        return ok(
          await getStorageStats(
            await readSettings(),
            request.recalculate === true,
          ),
        );
      }
      case "settings.put": {
        const forbidden = requireTrusted(context, "change settings");
        if (forbidden) return forbidden;
        const settings = validateSettings(request.settings);
        await writeSettings(settings);
        return ok(settings);
      }
      case "backup.export": {
        const forbidden = requireTrusted(context, "export backups");
        if (forbidden) return forbidden;
        return ok(
          serializeBackup(await listAnnotations(), await readSettings()),
        );
      }
      case "backup.preview": {
        const forbidden = requireTrusted(context, "preview backups");
        if (forbidden) return forbidden;
        return ok(await previewBackup(parseBackup(request.backup).annotations));
      }
      case "backup.import": {
        const forbidden = requireTrusted(context, "import backups");
        if (forbidden) return forbidden;
        if (typeof request.overwrite !== "boolean")
          return invalid("overwrite must be a boolean");
        const backup = parseBackup(request.backup); // validates the entire input before any write
        // Imported settings are intentionally ignored: local disabled-origin policy stays local.
        return ok(await importBackup(backup.annotations, request.overwrite));
      }
    }
  } catch (error) {
    if (error instanceof ValidationError) return invalid(error.message);
    return fail(
      error instanceof Error ? error.message : "Storage request failed.",
      "INTERNAL",
    );
  }
}
