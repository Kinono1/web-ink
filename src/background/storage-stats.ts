import type { Annotation, PageRecord, Settings, StorageStats } from '../core/model';
import { SCHEMA_VERSION } from '../core/model';
import { MAX_BACKUP_ANNOTATIONS, MAX_BACKUP_BYTES } from '../core/validation';
import { getDatabase, type LibraryStatsRecord } from './database';

/** Advisory threshold only. Nothing is deleted or blocked when it is exceeded. */
export const STORAGE_WARNING_BYTES = 50 * 1024 * 1024;
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const validEstimate = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const emptyStats = (): LibraryStatsRecord => ({ id: 'library', annotationCount: 0, textCount: 0, imageCount: 0, pdfTextCount: 0, pdfAreaCount: 0, pageCount: 0, annotationBytes: 0, pageBytes: 0 });

function applyAnnotation(target: LibraryStatsRecord, annotation: Annotation, direction: 1 | -1): void {
  target.annotationCount += direction;
  target.annotationBytes += direction * bytes(annotation);
  if (annotation.kind === 'text') target.textCount += direction;
  else if (annotation.kind === 'image') target.imageCount += direction;
  else if (annotation.kind === 'pdf-text') target.pdfTextCount += direction;
  else target.pdfAreaCount += direction;
}

function applyPage(target: LibraryStatsRecord, page: PageRecord, direction: 1 | -1): void {
  target.pageCount += direction;
  target.pageBytes += direction * bytes(page);
}

/** Called inside the caller's Dexie transaction; it never walks the annotation table. */
export async function applyIncrementalStats(change: {
  beforeAnnotation?: Annotation;
  afterAnnotation?: Annotation;
  beforePage?: PageRecord;
  afterPage?: PageRecord;
}): Promise<void> {
  const db = getDatabase();
  const stats = structuredClone(await db.stats.get('library') ?? emptyStats());
  if (change.beforeAnnotation) applyAnnotation(stats, change.beforeAnnotation, -1);
  if (change.afterAnnotation) applyAnnotation(stats, change.afterAnnotation, 1);
  if (change.beforePage) applyPage(stats, change.beforePage, -1);
  if (change.afterPage) applyPage(stats, change.afterPage, 1);
  await db.stats.put(stats);
}

/** Explicit repair path only. Normal storage.stats reads the incremental record. */
export async function recalculateStorageStats(): Promise<LibraryStatsRecord> {
  const db = getDatabase();
  return db.transaction('rw', db.annotations, db.pages, db.stats, async () => {
    const stats = emptyStats();
    await db.annotations.each(annotation => applyAnnotation(stats, annotation, 1));
    await db.pages.each(page => applyPage(stats, page, 1));
    await db.stats.put(stats);
    return stats;
  });
}

export async function getStorageStats(settings: Settings, recalculate = false): Promise<StorageStats> {
  const db = getDatabase();
  const snapshot = recalculate ? await recalculateStorageStats() : await db.stats.get('library') ?? await recalculateStorageStats();
  let browserUsageBytes: number | null = null, browserQuotaBytes: number | null = null;
  try {
    const estimate = await globalThis.navigator?.storage?.estimate();
    browserUsageBytes = validEstimate(estimate?.usage);
    browserQuotaBytes = validEstimate(estimate?.quota);
  } catch { /* Some profiles do not expose origin estimates; unknown must not be shown as zero. */ }
  const emptyBackupBytes = bytes({ format: 'web-ink', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), annotations: [], settings });
  return {
    annotationCount: snapshot.annotationCount, textCount: snapshot.textCount,
    imageCount: snapshot.imageCount, pdfTextCount: snapshot.pdfTextCount, pdfAreaCount: snapshot.pdfAreaCount, pageCount: snapshot.pageCount,
    logicalBytes: snapshot.annotationBytes + snapshot.pageBytes + bytes(settings),
    // Empty [] is already included; add records and separating commas. Sorting changes no byte count.
    backupBytes: emptyBackupBytes + snapshot.annotationBytes + Math.max(0, snapshot.annotationCount - 1),
    browserUsageBytes, browserQuotaBytes, backupLimitBytes: MAX_BACKUP_BYTES,
    backupRecordLimit: MAX_BACKUP_ANNOTATIONS, storageWarningBytes: STORAGE_WARNING_BYTES,
  };
}
