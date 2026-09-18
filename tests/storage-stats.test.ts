import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { WebInkDatabase, setDatabaseForTesting } from '../src/background/database';
import { handleDataRequest } from '../src/background/data';
import { DEFAULT_SETTINGS, type Annotation, type BackupEnvelope, type StorageStats } from '../src/core/model';

let db: WebInkDatabase;
const pageUrl = 'https://example.test/reading';
const row = (id: string): Annotation => ({
  id, pageUrl, pageTitle: '中文阅读', kind: 'text', color: '#facc15', note: '保留我的笔记', tags: ['研究'],
  createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', revision: 0,
  target: { exact: '中文', prefix: '', suffix: '', start: 0, end: 2, rootSelector: 'body' },
});
const storageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
beforeEach(() => {
  db = new WebInkDatabase(`stats-${crypto.randomUUID()}`); setDatabaseForTesting(db);
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: { get: async () => ({ settings: DEFAULT_SETTINGS }) } } } });
  Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
});
afterEach(async () => {
  setDatabaseForTesting(undefined); db.close(); await db.delete();
  if (storageDescriptor) Object.defineProperty(navigator, 'storage', storageDescriptor);
  else Reflect.deleteProperty(navigator, 'storage');
});
async function stats(): Promise<StorageStats> {
  const result = await handleDataRequest({ type: 'storage.stats' }, { trusted: true });
  if (!result.ok) throw new Error(result.error); return result.data as StorageStats;
}

describe('local storage usage reporting', () => {
  it('distinguishes an empty library from an unavailable browser disk estimate', async () => {
    const value = await stats();
    expect(value).toMatchObject({ annotationCount: 0, pageCount: 0, textCount: 0, imageCount: 0, browserUsageBytes: null, browserQuotaBytes: null });
    expect(value.logicalBytes).toBeGreaterThan(0); // Settings are still present.
    expect(await db.annotations.count()).toBe(0);
  });
  it('counts pages and UTF-8 data consistently with the actual compact backup', async () => {
    for (const id of ['one', 'two']) await handleDataRequest({ type: 'annotations.put', annotation: row(id), expectedRevision: 0 }, { trusted: true });
    const value = await stats();
    const exported = await handleDataRequest({ type: 'backup.export' }, { trusted: true });
    if (!exported.ok) throw new Error(exported.error);
    const json = JSON.stringify(exported.data as BackupEnvelope);
    expect(value).toMatchObject({ annotationCount: 2, pageCount: 1, textCount: 2, imageCount: 0 });
    expect(value.backupBytes).toBe(new TextEncoder().encode(json).byteLength);
    expect(value.backupBytes).toBeGreaterThan(json.length); // Chinese is not one byte per character.
    const existing = await db.annotations.get('one');
    await handleDataRequest({ type: 'annotations.delete', id: 'one', expectedRevision: existing!.revision }, { trusted: true });
    const after = await stats();
    expect(after.annotationCount).toBe(1); expect(after.logicalBytes).toBeLessThan(value.logicalBytes);
  });
  it('never exposes whole-library counts or usage to a page script', async () => {
    expect(await handleDataRequest({ type: 'storage.stats' }, { trusted: false, pageUrl })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await handleDataRequest({ type: 'storage.stats', extra: true }, { trusted: true })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
  it('reports valid browser estimates and survives missing or invalid estimates', async () => {
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 8192, quota: 100000 }) } });
    expect(await stats()).toMatchObject({ browserUsageBytes: 8192, browserQuotaBytes: 100000 });
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: Number.NaN, quota: -1 }) } });
    expect(await stats()).toMatchObject({ browserUsageBytes: null, browserQuotaBytes: null });
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => { throw new Error('Not available'); } } });
    expect(await stats()).toMatchObject({ browserUsageBytes: null, browserQuotaBytes: null });
  });
  it('measures over-limit libraries without deleting or blocking records', async () => {
    const record = row('large'); record.note = '大'.repeat(7 * 1024 * 1024);
    // Simulate an existing oversized library without making the statistics endpoint a write path.
    await db.annotations.put(record);
    const value = await stats();
    expect(value.backupBytes).toBeGreaterThan(value.backupLimitBytes);
    expect(value.annotationCount).toBe(1);
    expect((await db.annotations.get('large'))!.note).toHaveLength(7 * 1024 * 1024);
  });
  it('reads the incremental snapshot normally and scans only on explicit recalculation', async () => {
    await handleDataRequest({ type: 'annotations.put', annotation: row('incremental'), expectedRevision: 0 }, { trusted: true });
    const each = vi.spyOn(db.annotations, 'each');
    expect((await stats()).annotationCount).toBe(1);
    expect(each).not.toHaveBeenCalled();
    expect(await handleDataRequest({ type: 'storage.stats', recalculate: true }, { trusted: true })).toMatchObject({ ok: true, data: { annotationCount: 1 } });
    expect(each).toHaveBeenCalled();
  });
  it('keeps incremental metadata and annotation totals equal to a requested full recalculation', async () => {
    await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true }, { trusted: true });
    await handleDataRequest({ type: 'annotations.put', annotation: row('compare-one'), expectedRevision: 0 }, { trusted: true });
    const existing = await db.annotations.get('compare-one');
    if (!existing) throw new Error('missing fixture');
    await handleDataRequest({ type: 'annotations.put', annotation: { ...existing, note: 'updated note', updatedAt: '2026-09-18T00:01:00.000Z' }, expectedRevision: existing.revision }, { trusted: true });
    const incremental = await stats();
    const recalculated = await handleDataRequest({ type: 'storage.stats', recalculate: true }, { trusted: true });
    if (!recalculated.ok) throw new Error(recalculated.error);
    expect(recalculated.data).toMatchObject({
      annotationCount: incremental.annotationCount, textCount: incremental.textCount, imageCount: incremental.imageCount,
      pdfTextCount: incremental.pdfTextCount, pdfAreaCount: incremental.pdfAreaCount, pageCount: incremental.pageCount,
      logicalBytes: incremental.logicalBytes, backupBytes: incremental.backupBytes,
    });
  });
});
