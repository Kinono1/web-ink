import type { Settings, StorageStats } from '../core/model';
import { SCHEMA_VERSION } from '../core/model';
import { MAX_BACKUP_ANNOTATIONS, MAX_BACKUP_BYTES } from '../core/validation';
import { getDatabase } from './database';

/** Advisory threshold only. Nothing is deleted or blocked when it is exceeded. */
export const STORAGE_WARNING_BYTES = 50 * 1024 * 1024;
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const validEstimate = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export async function getStorageStats(settings: Settings): Promise<StorageStats> {
  const db = getDatabase();
  const snapshot = await db.transaction('r', db.annotations, db.pages, async () => {
    const pages = new Set<string>();
    let annotationCount = 0, textCount = 0, imageCount = 0, annotationBytes = 0, metadataBytes = 0;
    // Stream one record at a time instead of retaining another copy of the full library.
    await db.annotations.each(annotation => {
      annotationCount++; annotationBytes += bytes(annotation); pages.add(annotation.pageUrl);
      if (annotation.kind === 'text') textCount++; else imageCount++;
    });
    await db.pages.each(page => { metadataBytes += bytes(page); });
    return { annotationCount, textCount, imageCount, pageCount: pages.size, annotationBytes, metadataBytes };
  });
  let browserUsageBytes: number | null = null, browserQuotaBytes: number | null = null;
  try {
    const estimate = await globalThis.navigator?.storage?.estimate();
    browserUsageBytes = validEstimate(estimate?.usage);
    browserQuotaBytes = validEstimate(estimate?.quota);
  } catch { /* Some profiles do not expose origin estimates; unknown must not be shown as zero. */ }
  const emptyBackupBytes = bytes({ format: 'web-ink', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), annotations: [], settings });
  return {
    annotationCount: snapshot.annotationCount, textCount: snapshot.textCount,
    imageCount: snapshot.imageCount, pageCount: snapshot.pageCount,
    logicalBytes: snapshot.annotationBytes + snapshot.metadataBytes + bytes(settings),
    // Empty [] is already included; add records and separating commas. Sorting changes no byte count.
    backupBytes: emptyBackupBytes + snapshot.annotationBytes + Math.max(0, snapshot.annotationCount - 1),
    browserUsageBytes, browserQuotaBytes, backupLimitBytes: MAX_BACKUP_BYTES,
    backupRecordLimit: MAX_BACKUP_ANNOTATIONS, storageWarningBytes: STORAGE_WARNING_BYTES,
  };
}
