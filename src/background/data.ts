import type { Annotation, ImportPreview, PageMode, PageRecord, Result, Settings } from '../core/model';
import { DEFAULT_SETTINGS } from '../core/model';
import { pageKey } from '../core/url';
import { parseBackup, serializeBackup } from '../core/backup';
import { MAX_REVISION, ValidationError, validateAnnotation, validateSettings } from '../core/validation';
import { getDatabase } from './database';
import { getStorageStats } from './storage-stats';

const SETTINGS_KEY = 'settings';
export { SETTINGS_KEY };
/** Backups may carry settings for portability, but imports always retain local policy. */
export const IMPORT_SETTINGS_POLICY = 'keep-local' as const;

export interface DataRequestContext { trusted: boolean; pageUrl?: string }

type KnownMessage =
  | { type: 'annotations.list'; pageUrl?: string }
  | { type: 'annotations.put'; annotation: unknown; expectedRevision: unknown }
  | { type: 'annotations.delete'; id: unknown; expectedRevision: unknown }
  | { type: 'settings.get' }
  | { type: 'settings.put'; settings: unknown }
  | { type: 'page.mode.get'; pageUrl: unknown }
  | { type: 'page.mode.put'; pageUrl: unknown; enabled: unknown }
  | { type: 'storage.stats' }
  | { type: 'backup.export' }
  | { type: 'backup.preview'; backup: unknown }
  | { type: 'backup.import'; backup: unknown; overwrite: unknown };

function ok<T>(data: T): Result<T> { return { ok: true, data }; }
function fail(error: string, code?: string): Result<never> { return { ok: false, error, ...(code === undefined ? {} : { code }) }; }
function invalid(error: string): Result<never> { return fail(error, 'INVALID_INPUT'); }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnly(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key));
}

function parseMessage(value: unknown): KnownMessage | undefined {
  const message = record(value);
  if (!message || typeof message.type !== 'string') return undefined;
  switch (message.type) {
    case 'annotations.list': return hasOnly(message, ['type'], ['pageUrl']) ? message as KnownMessage : undefined;
    case 'annotations.put': return hasOnly(message, ['type', 'annotation', 'expectedRevision']) ? message as KnownMessage : undefined;
    case 'annotations.delete': return hasOnly(message, ['type', 'id', 'expectedRevision']) ? message as KnownMessage : undefined;
    case 'settings.get':
    case 'storage.stats':
    case 'backup.export': return hasOnly(message, ['type']) ? message as KnownMessage : undefined;
    case 'settings.put': return hasOnly(message, ['type', 'settings']) ? message as KnownMessage : undefined;
    case 'page.mode.get': return hasOnly(message, ['type', 'pageUrl']) ? message as KnownMessage : undefined;
    case 'page.mode.put': return hasOnly(message, ['type', 'pageUrl', 'enabled']) ? message as KnownMessage : undefined;
    case 'backup.preview': return hasOnly(message, ['type', 'backup']) ? message as KnownMessage : undefined;
    case 'backup.import': return hasOnly(message, ['type', 'backup', 'overwrite']) ? message as KnownMessage : undefined;
    default: return undefined;
  }
}

function canonicalContextPage(context: DataRequestContext): string | undefined {
  if (context.trusted) return undefined;
  if (!context.pageUrl) throw new ValidationError('Content requests require a sender page URL');
  return canonicalPage(context.pageUrl, 'sender page URL');
}

function canonicalPage(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) throw new ValidationError(`${name} must be an HTTP(S) URL`);
  try { return pageKey(value); }
  catch { throw new ValidationError(`${name} must be an HTTP(S) URL`); }
}

/** Page-mode writes use the same durable canonical form as annotation records. */
function canonicalPageUrl(value: unknown, name: string): string {
  const canonical = canonicalPage(value, name);
  if (canonical !== value) throw new ValidationError(`${name} must be a canonical HTTP(S) URL`);
  return canonical;
}

function validExpectedRevision(value: unknown): number {
  // A put always advances revision by one, so accepting MAX_REVISION would create
  // a record that the persistent schema itself rejects.
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= MAX_REVISION) {
    throw new ValidationError('expectedRevision must be a non-negative integer');
  }
  return value as number;
}

function validId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ValidationError('id has an invalid format');
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${stableJson(source[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameAnnotation(left: Annotation, right: Annotation): boolean { return stableJson(left) === stableJson(right); }

function committedVersion(annotation: Annotation, expectedRevision: number): Annotation {
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

async function readSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY) as Record<string, unknown>;
  if (result[SETTINGS_KEY] === undefined) return structuredClone(DEFAULT_SETTINGS);
  try { return validateSettings(result[SETTINGS_KEY]); }
  catch { return structuredClone(DEFAULT_SETTINGS); }
}

async function writeSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function listAnnotations(pageUrl?: string): Promise<Annotation[]> {
  const db = getDatabase();
  const rows = pageUrl === undefined ? await db.annotations.toArray() : await db.annotations.where('pageUrl').equals(pageUrl).toArray();
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

async function getPageMode(pageUrl: string): Promise<PageMode> {
  const page = await getDatabase().pages.get(pageUrl);
  // Reads are deliberately side-effect free: an unopened page stays absent from pages.
  return { enabled: page?.enabled === true };
}

async function putPageMode(pageUrl: string, enabled: boolean): Promise<Result<PageMode>> {
  if (enabled) {
    const settings = await readSettings();
    if (settings.disabledOrigins.includes(new URL(pageUrl).origin)) {
      return fail('This site is paused and cannot be enabled.', 'FORBIDDEN');
    }
  }
  const db = getDatabase();
  return db.transaction('rw', db.pages, async () => {
    const existing = await db.pages.get(pageUrl);
    await db.pages.put({
      url: pageUrl,
      title: existing?.title ?? '',
      updatedAt: new Date().toISOString(),
      enabled,
    });
    return ok({ enabled });
  });
}

async function putAnnotation(annotation: Annotation, expectedRevision: number, ownPage?: string): Promise<Result<Annotation>> {
  if (annotation.revision !== expectedRevision) return fail('annotation.revision must equal expectedRevision', 'INVALID_INPUT');
  const db = getDatabase();
  return db.transaction('rw', db.annotations, db.pages, async () => {
    const existing = await db.annotations.get(annotation.id);
    const candidate = committedVersion(annotation, expectedRevision);
    // Check the owner from the transactional read, rather than trusting an ID and
    // page URL supplied by an untrusted content script.
    if (existing && ownPage !== undefined && existing.pageUrl !== ownPage) {
      return fail('Content scripts may only write annotations from their own page.', 'FORBIDDEN');
    }
    // A service-worker retry may carry the pre-commit revision. Do not turn it into another edit.
    if (existing && sameAnnotation(existing, candidate)) return ok(existing);
    if (existing && existing.revision !== expectedRevision) return fail('Annotation changed in another tab.', 'CONFLICT');
    if (!existing && expectedRevision !== 0) return fail('Annotation no longer exists.', 'CONFLICT');
    await db.annotations.put(candidate);
    await db.pages.put(pageRecord(candidate, await db.pages.get(candidate.pageUrl)));
    return ok(candidate);
  });
}

async function deleteAnnotation(id: string, expectedRevision: number, ownPage?: string): Promise<Result<{ id: string; deleted: true }>> {
  const db = getDatabase();
  return db.transaction('rw', db.annotations, async () => {
    const existing = await db.annotations.get(id);
    if (!existing) return fail('Annotation no longer exists.', 'CONFLICT');
    if (ownPage !== undefined && existing.pageUrl !== ownPage) return fail('Content scripts may only delete annotations from their own page.', 'FORBIDDEN');
    if (existing.revision !== expectedRevision) return fail('Annotation changed in another tab.', 'CONFLICT');
    await db.annotations.delete(id);
    return ok({ id, deleted: true });
  });
}

function classifyImport(incoming: Annotation[], existing: Array<Annotation | undefined>): ImportPreview {
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

async function previewBackup(annotations: Annotation[]): Promise<ImportPreview> {
  const db = getDatabase();
  return classifyImport(annotations, await db.annotations.bulkGet(annotations.map(annotation => annotation.id)));
}

async function importBackup(annotations: Annotation[], overwrite: boolean): Promise<ImportPreview> {
  const db = getDatabase();
  // `parseBackup` ran before this call. All mutations below are one Dexie transaction.
  return db.transaction('rw', db.annotations, db.pages, async () => {
    const existing = await db.annotations.bulkGet(annotations.map(annotation => annotation.id));
    const preview = classifyImport(annotations, existing);
    for (let index = 0; index < annotations.length; index += 1) {
      const incoming = annotations[index];
      if (!incoming) continue;
      const local = existing[index];
      if (!local || (overwrite && !sameAnnotation(local, incoming))) {
        // Imported revisions are foreign clocks. A local overwrite is a new local
        // mutation, so it must advance the local clock and invalidate stale tabs.
        if (local && local.revision >= MAX_REVISION) throw new ValidationError('Annotation revision limit reached.');
        const stored = local ? { ...incoming, revision: local.revision + 1 } as Annotation : incoming;
        await db.annotations.put(stored);
        await db.pages.put(pageRecord(stored, await db.pages.get(stored.pageUrl)));
      }
    }
    return preview;
  });
}

function requireTrusted(context: DataRequestContext, action: string): Result<never> | undefined {
  return context.trusted ? undefined : fail(`Content scripts cannot ${action}.`, 'FORBIDDEN');
}

/**
 * Single storage authority for the extension service worker. `trusted` identifies the
 * extension UI; sender URLs are canonicalized before content-script data access.
 */
export async function handleDataRequest(message: unknown, context: DataRequestContext): Promise<Result<unknown>> {
  try {
    const request = parseMessage(message);
    if (!request) return invalid('Unsupported or malformed data request.');
    const ownPage = canonicalContextPage(context);
    switch (request.type) {
      case 'annotations.list': {
        const requested = request.pageUrl === undefined ? ownPage : canonicalPage(request.pageUrl, 'pageUrl');
        if (!context.trusted && requested !== ownPage) return fail('Content scripts may only list their own page.', 'FORBIDDEN');
        return ok(await listAnnotations(requested));
      }
      case 'annotations.put': {
        const annotation = validateAnnotation(request.annotation);
        if (!context.trusted && annotation.pageUrl !== ownPage) return fail('Content scripts may only write their own page.', 'FORBIDDEN');
        return putAnnotation(annotation, validExpectedRevision(request.expectedRevision), ownPage);
      }
      case 'annotations.delete': return deleteAnnotation(validId(request.id), validExpectedRevision(request.expectedRevision), ownPage);
      case 'page.mode.get': {
        const requested = canonicalPageUrl(request.pageUrl, 'pageUrl');
        if (!context.trusted && requested !== ownPage) return fail('Content scripts may only read their own page mode.', 'FORBIDDEN');
        return ok(await getPageMode(requested));
      }
      case 'page.mode.put': {
        const requested = canonicalPageUrl(request.pageUrl, 'pageUrl');
        if (typeof request.enabled !== 'boolean') return invalid('enabled must be a boolean');
        if (!context.trusted && requested !== ownPage) return fail('Content scripts may only change their own page mode.', 'FORBIDDEN');
        return putPageMode(requested, request.enabled);
      }
      case 'settings.get': return ok(await readSettings());
      case 'storage.stats': {
        const forbidden = requireTrusted(context, 'read whole-library storage usage');
        if (forbidden) return forbidden;
        return ok(await getStorageStats(await readSettings()));
      }
      case 'settings.put': {
        const forbidden = requireTrusted(context, 'change settings');
        if (forbidden) return forbidden;
        const settings = validateSettings(request.settings);
        await writeSettings(settings);
        return ok(settings);
      }
      case 'backup.export': {
        const forbidden = requireTrusted(context, 'export backups');
        if (forbidden) return forbidden;
        return ok(serializeBackup(await listAnnotations(), await readSettings()));
      }
      case 'backup.preview': {
        const forbidden = requireTrusted(context, 'preview backups');
        if (forbidden) return forbidden;
        return ok(await previewBackup(parseBackup(request.backup).annotations));
      }
      case 'backup.import': {
        const forbidden = requireTrusted(context, 'import backups');
        if (forbidden) return forbidden;
        if (typeof request.overwrite !== 'boolean') return invalid('overwrite must be a boolean');
        const backup = parseBackup(request.backup); // validates the entire input before any write
        // Imported settings are intentionally ignored: local disabled-origin policy stays local.
        return ok(await importBackup(backup.annotations, request.overwrite));
      }
    }
  } catch (error) {
    if (error instanceof ValidationError) return invalid(error.message);
    return fail(error instanceof Error ? error.message : 'Storage request failed.', 'INTERNAL');
  }
}
