import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebInkDatabase, setDatabaseForTesting } from '../src/background/database';
import { handleDataRequest } from '../src/background/data';
import type { Annotation, Settings } from '../src/core/model';

const pageUrl = 'https://example.test/article?topic=ink';
const otherPageUrl = 'https://other.test/page';
let db: WebInkDatabase;
let local: Record<string, unknown> = {};

function textAnnotation(id = 'annotation-1', revision = 0): Annotation {
  return {
    id,
    pageUrl,
    pageTitle: 'Article',
    color: '#facc15',
    note: 'A note',
    tags: ['research'],
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    revision,
    kind: 'text',
    target: { exact: 'hello', prefix: '', suffix: '', start: 0, end: 5, rootSelector: 'article' },
  };
}

function pdfAnnotation(id = 'pdf-annotation-1', revision = 0): Annotation {
  const documentHash = 'a'.repeat(64);
  return {
    id, pageUrl: `urn:web-ink:pdf:${documentHash}`, pageTitle: 'Paper', color: '#38bdf8', note: 'PDF note', tags: ['paper'],
    createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', revision, kind: 'pdf-text',
    target: { documentHash, fileName: 'paper.pdf', sourceUrl: 'https://papers.example/paper.pdf', pageNumber: 1, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }], exact: 'PDF evidence', prefix: '', suffix: '' },
  };
}

beforeEach(() => {
  db = new WebInkDatabase(`web-ink-test-${crypto.randomUUID()}`);
  setDatabaseForTesting(db);
  local = {};
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: local[key] }),
          set: async (value: Record<string, unknown>) => { Object.assign(local, value); },
        },
      },
    },
  });
});

afterEach(async () => {
  setDatabaseForTesting(undefined);
  db.close();
  await db.delete();
});

describe('handleDataRequest annotation boundary', () => {
  it('commits a create once and returns the same record for an identical retry', async () => {
    const request = { type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 };
    const first = await handleDataRequest(request, { trusted: false, pageUrl });
    expect(first).toEqual({ ok: true, data: { ...textAnnotation(), revision: 1 } });

    const retry = await handleDataRequest(request, { trusted: false, pageUrl });
    expect(retry).toEqual(first);
    expect(await db.annotations.count()).toBe(1);
  });

  it('does not overwrite a multi-tab stale edit', async () => {
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: true });
    const current = await db.annotations.get('annotation-1');
    if (!current) throw new Error('missing fixture');
    const updated = { ...current, note: 'newer edit', updatedAt: '2026-09-18T00:01:00.000Z' };
    expect(await handleDataRequest({ type: 'annotations.put', annotation: updated, expectedRevision: 1 }, { trusted: true }))
      .toEqual({ ok: true, data: { ...updated, revision: 2 } });

    const stale = { ...current, note: 'stale edit', updatedAt: '2026-09-18T00:02:00.000Z' };
    const response = await handleDataRequest({ type: 'annotations.put', annotation: stale, expectedRevision: 1 }, { trusted: true });
    expect(response).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect((await db.annotations.get('annotation-1'))?.note).toBe('newer edit');
  });

  it('limits an untrusted sender to its own canonical page', async () => {
    const response = await handleDataRequest(
      { type: 'annotations.put', annotation: { ...textAnnotation(), pageUrl: otherPageUrl }, expectedRevision: 0 },
      { trusted: false, pageUrl },
    );
    expect(response).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await db.annotations.count()).toBe(0);
    expect(await handleDataRequest({ type: 'backup.export' }, { trusted: false, pageUrl })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await handleDataRequest({ type: 'settings.put', settings: { language: 'en', defaultColor: '#ffffff', disabledOrigins: [] } }, { trusted: false, pageUrl }))
      .toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('does not allow a content script to claim another page record by ID', async () => {
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: true });
    const attackerRecord = { ...textAnnotation('annotation-1', 1), pageUrl: otherPageUrl, note: 'claimed by another page' };
    const response = await handleDataRequest(
      { type: 'annotations.put', annotation: attackerRecord, expectedRevision: 1 },
      { trusted: false, pageUrl: otherPageUrl },
    );
    expect(response).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await db.annotations.get('annotation-1')).toMatchObject({ pageUrl, note: 'A note', revision: 1 });
  });

  it('rejects hostile target input before it reaches IndexedDB', async () => {
    const image = {
      ...textAnnotation('image-1'),
      kind: 'image',
      target: {
        src: 'javascript:alert(1)', sourceCandidates: [], alt: '', naturalWidth: 100, naturalHeight: 100,
        selector: 'img', occurrence: 0, context: '',
      },
      shape: { kind: 'rectangle', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], width: 0.01 },
    };
    const response = await handleDataRequest({ type: 'annotations.put', annotation: image, expectedRevision: 0 }, { trusted: true });
    expect(response).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await db.annotations.count()).toBe(0);
  });
});

describe('settings and backup import boundary', () => {
  it('keeps local settings while importing annotations and reports conflicts', async () => {
    const localSettings: Settings = { language: 'en', defaultColor: '#ffffff', disabledOrigins: ['https://blocked.test'] };
    await handleDataRequest({ type: 'settings.put', settings: localSettings }, { trusted: true });
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: true });
    const conflicting = { ...textAnnotation(), note: 'from backup', revision: 7 };
    const added = textAnnotation('annotation-2');
    const backup = {
      format: 'web-ink', schemaVersion: 1, exportedAt: '2026-09-18T03:00:00.000Z',
      annotations: [conflicting, added],
      settings: { language: 'zh-CN', defaultColor: '#000000', disabledOrigins: [] },
    };
    expect(await handleDataRequest({ type: 'backup.preview', backup }, { trusted: true }))
      .toEqual({ ok: true, data: { added: 1, identical: 0, conflicts: 1, total: 2 } });
    expect(await handleDataRequest({ type: 'backup.import', backup, overwrite: false }, { trusted: true }))
      .toEqual({ ok: true, data: { added: 1, identical: 0, conflicts: 1, total: 2 } });
    expect((await db.annotations.get('annotation-1'))?.note).toBe('A note');
    expect((await db.annotations.get('annotation-2'))?.revision).toBe(0);
    expect(await handleDataRequest({ type: 'settings.get' }, { trusted: true })).toEqual({ ok: true, data: { ...localSettings, theme: 'system', reduceMotion: false, reduceTransparency: false } });
  });

  it('validates the whole backup before starting its import transaction', async () => {
    const valid = textAnnotation('annotation-good');
    const invalid = { ...textAnnotation('annotation-bad'), note: 'bad\u0000note' };
    const backup = {
      format: 'web-ink', schemaVersion: 1, exportedAt: '2026-09-18T03:00:00.000Z', annotations: [valid, invalid],
    };
    const response = await handleDataRequest({ type: 'backup.import', backup, overwrite: false }, { trusted: true });
    expect(response).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await db.annotations.count()).toBe(0);
  });

  it('makes an overwrite import advance the local revision and invalidate stale tabs', async () => {
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: true });
    const imported = { ...textAnnotation('annotation-1', 0), note: 'backup replacement', updatedAt: '2026-09-18T00:02:00.000Z' };
    const backup = { format: 'web-ink', schemaVersion: 1, exportedAt: '2026-09-18T03:00:00.000Z', annotations: [imported] };
    expect(await handleDataRequest({ type: 'backup.import', backup, overwrite: true }, { trusted: true }))
      .toEqual({ ok: true, data: { added: 0, identical: 0, conflicts: 1, total: 1 } });
    expect(await db.annotations.get('annotation-1')).toMatchObject({ note: 'backup replacement', revision: 2 });

    const staleTabEdit = { ...textAnnotation('annotation-1', 1), note: 'stale tab edit', updatedAt: '2026-09-18T00:03:00.000Z' };
    expect(await handleDataRequest({ type: 'annotations.put', annotation: staleTabEdit, expectedRevision: 1 }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'CONFLICT' });
    expect((await db.annotations.get('annotation-1'))?.note).toBe('backup replacement');
  });

  it('keeps records through a simulated service-worker restart', async () => {
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: true });
    db.close();
    const restartedWorker = new WebInkDatabase(db.name);
    setDatabaseForTesting(restartedWorker);
    const response = await handleDataRequest({ type: 'annotations.list', pageUrl }, { trusted: false, pageUrl });
    expect(response).toEqual({ ok: true, data: [{ ...textAnnotation(), revision: 1 }] });
    restartedWorker.close();
    setDatabaseForTesting(db);
  });

  it('imports and lists 10,000 validated records', async () => {
    const annotations = Array.from({ length: 10_000 }, (_, index) => textAnnotation(`bulk-${index}`));
    const backup = { format: 'web-ink', schemaVersion: 1, exportedAt: '2026-09-18T03:00:00.000Z', annotations };
    const imported = await handleDataRequest({ type: 'backup.import', backup, overwrite: false }, { trusted: true });
    expect(imported).toEqual({ ok: true, data: { added: 10_000, identical: 0, conflicts: 0, total: 10_000 } });
    const listed = await handleDataRequest({ type: 'annotations.list', pageUrl }, { trusted: false, pageUrl });
    expect(listed.ok && Array.isArray(listed.data) ? listed.data.length : -1).toBe(10_000);
  }, 10_000);
});

describe('PDF and cursor query boundary', () => {
  it('allows only trusted UI to write and query a validated PDF annotation', async () => {
    const pdf = pdfAnnotation();
    expect(await handleDataRequest({ type: 'annotations.put', annotation: pdf, expectedRevision: 0 }, { trusted: false, pageUrl }))
      .toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await handleDataRequest({ type: 'annotations.put', annotation: pdf, expectedRevision: 0 }, { trusted: true }))
      .toMatchObject({ ok: true, data: expect.objectContaining({ kind: 'pdf-text', revision: 1 }) });
    expect(await handleDataRequest({ type: 'annotations.list', pageUrl: pdf.pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: [{ ...pdf, revision: 1 }] });
    expect(await handleDataRequest({ type: 'annotations.query', query: { pageUrl: pdf.pageUrl, kind: 'pdf-text', limit: 50, requestId: 'pdf-search' } }, { trusted: true }))
      .toMatchObject({ ok: true, data: { items: [expect.objectContaining({ id: pdf.id })] } });
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl: pdf.pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false } });
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl: pdf.pageUrl, enabled: true }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: true } });
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl: pdf.pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: true } });
    expect(await handleDataRequest({ type: 'annotations.delete', id: pdf.id, expectedRevision: 1 }, { trusted: true }))
      .toEqual({ ok: true, data: { id: pdf.id, deleted: true } });
    expect(await handleDataRequest({ type: 'annotations.list', pageUrl: pdf.pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: [] });
  });

  it('paginates in updatedAt/id order, applies filters, clamps limit, and accepts cancellation', async () => {
    const records = Array.from({ length: 55 }, (_, index) => ({ ...textAnnotation(`query-${String(index).padStart(2, '0')}`), updatedAt: `2026-09-18T00:00:${String(index % 60).padStart(2, '0')}.000Z`, tags: [index % 2 ? 'odd' : 'even'], color: index % 2 ? '#4ade80' : '#facc15', note: `needle ${index}` }));
    for (const record of records) await handleDataRequest({ type: 'annotations.put', annotation: record, expectedRevision: 0 }, { trusted: true });
    await handleDataRequest({ type: 'annotations.put', annotation: { ...textAnnotation('query-other'), pageUrl: otherPageUrl, updatedAt: '2026-09-18T23:59:59.000Z' }, expectedRevision: 0 }, { trusted: true });
    const filtered = await handleDataRequest({ type: 'annotations.query', query: { pageUrl, tag: 'odd', color: '#4ade80', text: 'needle', limit: 500, requestId: 'query-filtered' } }, { trusted: true });
    if (!filtered.ok) throw new Error(filtered.error);
    const filteredPage = filtered.data as { items: Annotation[] };
    expect(filteredPage.items).toHaveLength(27);
    expect(filteredPage.items.every(item => item.tags.includes('odd') && item.color === '#4ade80')).toBe(true);
    const first = await handleDataRequest({ type: 'annotations.query', query: { pageUrl, limit: 500, requestId: 'query-first' } }, { trusted: true });
    if (!first.ok) throw new Error(first.error);
    const firstPage = first.data as { items: Annotation[]; nextCursor?: { updatedAt: string; id: string } };
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).toBeDefined();
    const second = await handleDataRequest({ type: 'annotations.query', query: { pageUrl, cursor: firstPage.nextCursor, limit: 50 } }, { trusted: true });
    if (!second.ok) throw new Error(second.error);
    const secondPage = second.data as { items: Annotation[] };
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.items.every(item => item.pageUrl === pageUrl)).toBe(true);
    expect(await handleDataRequest({ type: 'annotations.query.cancel', requestId: 'obsolete-query' }, { trusted: true })).toEqual({ ok: true, data: true });
    expect(await handleDataRequest({ type: 'annotations.query', query: { pageUrl, requestId: 'obsolete-query' } }, { trusted: true }))
      .toEqual({ ok: true, data: { items: [], cancelled: true } });
  }, 10_000);

  it('returns newest updates first with an inverse cursor and no cross-page duplicates', async () => {
    const ordered = [
      { ...textAnnotation('order-a'), updatedAt: '2026-09-18T00:01:00.000Z' },
      { ...textAnnotation('order-b'), updatedAt: '2026-09-18T00:02:00.000Z' },
      { ...textAnnotation('order-c'), updatedAt: '2026-09-18T00:02:00.000Z' },
    ];
    for (const record of ordered) await handleDataRequest({ type: 'annotations.put', annotation: record, expectedRevision: 0 }, { trusted: true });
    await handleDataRequest({ type: 'annotations.put', annotation: { ...textAnnotation('order-other'), pageUrl: otherPageUrl, updatedAt: '2026-09-18T23:59:59.000Z' }, expectedRevision: 0 }, { trusted: true });
    const first = await handleDataRequest({ type: 'annotations.query', query: { pageUrl, text: 'A note', limit: 2 } }, { trusted: true });
    if (!first.ok) throw new Error(first.error);
    const pageOne = first.data as { items: Annotation[]; nextCursor?: { updatedAt: string; id: string } };
    expect(pageOne.items.map(item => item.id)).toEqual(['order-c', 'order-b']);
    expect(pageOne.nextCursor).toEqual({ updatedAt: '2026-09-18T00:02:00.000Z', id: 'order-b' });
    const second = await handleDataRequest({ type: 'annotations.query', query: { pageUrl, text: 'A note', cursor: pageOne.nextCursor, limit: 2 } }, { trusted: true });
    if (!second.ok) throw new Error(second.error);
    const pageTwo = second.data as { items: Annotation[] };
    expect(pageTwo.items.map(item => item.id)).toEqual(['order-a']);
    expect([...pageOne.items, ...pageTwo.items].every(item => item.pageUrl === pageUrl)).toBe(true);
    expect(new Set([...pageOne.items, ...pageTwo.items].map(item => item.id)).size).toBe(3);
  });

  it('stops a broad cancelled query after its current small IndexedDB batch', async () => {
    await db.annotations.bulkPut(Array.from({ length: 500 }, (_, index) => ({ ...textAnnotation(`cancel-${index}`), updatedAt: `2026-09-18T01:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z` })));
    let reads = 0;
    const reading = () => { reads += 1; };
    db.annotations.hook('reading', reading);
    const pending = handleDataRequest({ type: 'annotations.query', query: { text: 'not-present', requestId: 'interrupt-me', limit: 50 } }, { trusted: true });
    await handleDataRequest({ type: 'annotations.query.cancel', requestId: 'interrupt-me' }, { trusted: true });
    expect(await pending).toEqual({ ok: true, data: { items: [], cancelled: true } });
    expect(reads).toBeLessThanOrEqual(25);
    db.annotations.hook('reading').unsubscribe(reading);
  });
});

describe('page mode boundary', () => {
  it('defaults a missing page to disabled without creating a page record', async () => {
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false } });
    expect(await db.pages.count()).toBe(0);
  });

  it('persists enabled state, allows closing it, and retains existing annotations', async () => {
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: true } });
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: false, pageUrl });
    expect((await db.pages.get(pageUrl))?.enabled).toBe(true);

    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: false }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false } });
    expect(await db.annotations.count()).toBe(1);
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false } });
  });

  it('keeps page mode while annotation writes and overwrite imports update page metadata', async () => {
    await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true }, { trusted: true });
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: true });
    expect((await db.pages.get(pageUrl))?.enabled).toBe(true);

    const imported = { ...textAnnotation('annotation-1'), note: 'from backup', updatedAt: '2026-09-18T00:02:00.000Z' };
    const backup = { format: 'web-ink', schemaVersion: 1, exportedAt: '2026-09-18T03:00:00.000Z', annotations: [imported] };
    await handleDataRequest({ type: 'backup.import', backup, overwrite: true }, { trusted: true });
    expect((await db.pages.get(pageUrl))?.enabled).toBe(true);
  });

  it('rejects cross-page, malformed, oversized, and paused-site enable requests', async () => {
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl: otherPageUrl }, { trusted: false, pageUrl }))
      .toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl: otherPageUrl, enabled: true }, { trusted: false, pageUrl }))
      .toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: 'true' }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl: `https://example.test/${'x'.repeat(8_193)}`, enabled: true }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' });

    const paused: Settings = { language: 'zh-CN', defaultColor: '#facc15', disabledOrigins: ['https://example.test'] };
    await handleDataRequest({ type: 'settings.put', settings: paused }, { trusted: true });
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false } });
  });
});

describe('Dexie lifecycle under fake IndexedDB', () => {
  it('can close and delete an independent extension database', async () => {
    const name = `web-ink-lifecycle-${crypto.randomUUID()}`;
    const disposable = new WebInkDatabase(name);
    await disposable.annotations.put(textAnnotation('lifecycle-record'));
    disposable.close();
    await disposable.delete();
    const reopened = new WebInkDatabase(name);
    expect(await reopened.annotations.count()).toBe(0);
    reopened.close();
    await reopened.delete();
  });

  it('upgrades a real v1 database without losing IDs, revisions, or page mode', async () => {
    const name = `web-ink-v1-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({ annotations: 'id, pageUrl, updatedAt', pages: 'url, updatedAt' });
    await legacy.open();
    const record = { ...textAnnotation('v1-record', 7), updatedAt: '2026-09-18T00:07:00.000Z' };
    await legacy.table('annotations').put(record);
    await legacy.table('pages').put({ url: pageUrl, title: 'Legacy page', updatedAt: record.updatedAt, enabled: true });
    legacy.close();

    const upgraded = new WebInkDatabase(name);
    await upgraded.open();
    expect(await upgraded.annotations.get(record.id)).toMatchObject({ id: 'v1-record', revision: 7, pageUrl });
    expect(await upgraded.pages.get(pageUrl)).toMatchObject({ enabled: true, title: 'Legacy page' });
    expect(await upgraded.stats.get('library')).toMatchObject({ annotationCount: 1, textCount: 1, pageCount: 1 });
    upgraded.close();
    await upgraded.delete();
  });
});
