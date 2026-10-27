import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebInkDatabase, setDatabaseForTesting } from '../src/background/database';
import { handleDataRequest } from '../src/background/data';
import type { Annotation, Settings } from '../src/core/model';
import { SELECTION_TOOLBAR_KEY } from '../src/core/selection-toolbar';

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
  it('reads a current annotation by ID only for trusted extension UI and returns null for a missing ID', async () => {
    await db.annotations.put(textAnnotation('target', 7));
    expect(await handleDataRequest({ type: 'annotations.get', id: 'target' }, { trusted: true }))
      .toEqual({ ok: true, data: textAnnotation('target', 7) });
    expect(await handleDataRequest({ type: 'annotations.get', id: 'missing' }, { trusted: true }))
      .toEqual({ ok: true, data: null });
    for (const senderPage of [pageUrl, otherPageUrl]) {
      expect(await handleDataRequest({ type: 'annotations.get', id: 'target' }, { trusted: false, pageUrl: senderPage }))
        .toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
  });

  it.each([
    { type: 'annotations.get' },
    { type: 'annotations.get', id: '' },
    { type: 'annotations.get', id: '../target' },
    { type: 'annotations.get', id: 7 },
    { type: 'annotations.get', id: 'a'.repeat(129) },
    { type: 'annotations.get', id: 'target', pageUrl },
  ])('rejects malformed direct annotation reads: %j', async (request) => {
    expect(await handleDataRequest(request, { trusted: true }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

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

});

describe('tombstone restore generations', () => {
  it('prevents ABA after delete/restore and makes the same restore idempotent', async () => {
    const original = textAnnotation('aba-record');
    await handleDataRequest({ type: 'annotations.put', annotation: original, expectedRevision: 0 }, { trusted: true });
    const deleted = { ...original, revision: 1 };
    expect(await handleDataRequest({ type: 'annotations.delete', id: deleted.id, expectedRevision: 1 }, { trusted: true }))
      .toEqual({ ok: true, data: { id: deleted.id, deleted: true } });
    expect(await handleDataRequest({ type: 'annotations.put', annotation: original, expectedRevision: 0 }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'CONFLICT' });
    const restored = await handleDataRequest({ type: 'annotations.restore', annotation: deleted }, { trusted: true });
    expect(restored).toEqual({ ok: true, data: { ...deleted, revision: 2 } });
    expect(await handleDataRequest({ type: 'annotations.restore', annotation: deleted }, { trusted: true }))
      .toEqual(restored);
    const stale = { ...deleted, note: 'old window edit', updatedAt: '2026-09-18T00:01:00.000Z' };
    expect(await handleDataRequest({ type: 'annotations.put', annotation: stale, expectedRevision: 1 }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'CONFLICT' });
    expect((await db.annotations.get(deleted.id))?.revision).toBe(2);
  });

  it('requires the latest deletion generation and never overwrites an explicit imported recovery', async () => {
    const original = textAnnotation('generation-record');
    await handleDataRequest({ type: 'annotations.put', annotation: original, expectedRevision: 0 }, { trusted: true });
    const revisionOne = { ...original, revision: 1 };
    await handleDataRequest({ type: 'annotations.delete', id: original.id, expectedRevision: 1 }, { trusted: true });
    const imported = { ...revisionOne, note: 'explicit imported recovery' };
    const backup = { format: 'web-ink', schemaVersion: 2, exportedAt: '2026-09-18T03:00:00.000Z', annotations: [imported] };
    await handleDataRequest({ type: 'backup.import', backup, overwrite: false }, { trusted: true });
    expect(await db.annotations.get(original.id)).toMatchObject({ note: 'explicit imported recovery', revision: 2 });
    expect(await handleDataRequest({ type: 'annotations.restore', annotation: revisionOne }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'CONFLICT' });
    expect((await db.annotations.get(original.id))?.note).toBe('explicit imported recovery');

    const current = await db.annotations.get(original.id);
    if (!current) throw new Error('missing imported record');
    await handleDataRequest({ type: 'annotations.delete', id: current.id, expectedRevision: current.revision }, { trusted: true });
    expect(await handleDataRequest({ type: 'annotations.restore', annotation: revisionOne }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(await handleDataRequest({ type: 'annotations.restore', annotation: current }, { trusted: true }))
      .toEqual({ ok: true, data: { ...current, revision: 3 } });
  });
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
  it('inherits enabled reminders for a new webpage without creating a page or stats record', async () => {
    local[SELECTION_TOOLBAR_KEY] = true;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
    expect(await db.pages.count()).toBe(0);
    expect(await db.stats.count()).toBe(0);
    expect(local).toEqual({ [SELECTION_TOOLBAR_KEY]: true });
  });

  it('lets annotation-only page records inherit reminders without updating their metadata', async () => {
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: true });
    const before = await db.pages.get(pageUrl);
    const stats = await db.stats.toArray();
    expect(before).not.toHaveProperty('enabled');
    local[SELECTION_TOOLBAR_KEY] = true;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
    local[SELECTION_TOOLBAR_KEY] = false;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await db.pages.get(pageUrl)).toEqual(before);
    expect(await db.stats.toArray()).toEqual(stats);
    expect(await db.annotations.get('annotation-1')).toMatchObject({ note: 'A note', revision: 1 });
  });

  it('keeps historical disabled pages without an override on the automatic fallback', async () => {
    await db.pages.put({ url: pageUrl, title: 'Legacy page', updatedAt: '2026-09-18T00:00:00.000Z', enabled: false });
    const disabled = await db.pages.get(pageUrl);
    local[SELECTION_TOOLBAR_KEY] = true;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
    expect(await db.pages.get(pageUrl)).toEqual(disabled);
    local[SELECTION_TOOLBAR_KEY] = false;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await db.pages.get(pageUrl)).toEqual(disabled);
  });

  it.each([false, true])('persists an explicit page choice when automatic reminders start at %s', async (automatic) => {
    local[SELECTION_TOOLBAR_KEY] = automatic;
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: false }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await db.pages.get(pageUrl)).toMatchObject({ enabled: false, modeOverride: true });
    db.close();
    await db.open();
    for (const nextAutomatic of [true, false, true]) {
      local[SELECTION_TOOLBAR_KEY] = nextAutomatic;
      expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
        .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
      expect(await handleDataRequest({ type: 'page.mode.get', pageUrl: otherPageUrl }, { trusted: true }))
        .toEqual({ ok: true, data: { enabled: nextAutomatic, selectionToolsEnabled: nextAutomatic } });
    }
    expect(await db.pages.get(otherPageUrl)).toBeUndefined();
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
    local[SELECTION_TOOLBAR_KEY] = false;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
    expect(await db.pages.get(pageUrl)).toMatchObject({ enabled: true, modeOverride: true });
  });

  it.each([false, true])('lets a paused origin override inherited and explicit enabled modes with manual tools %s', async (selectionTools) => {
    await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true, selectionTools }, { trusted: true });
    const saved = await db.pages.get(pageUrl);
    local[SELECTION_TOOLBAR_KEY] = true;
    local.settings = { language: 'en', defaultColor: '#facc15', disabledOrigins: ['https://example.test'] };
    const fresh = 'https://example.test/new-page';
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl: fresh }, { trusted: false, pageUrl: fresh }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await db.pages.get(pageUrl)).toEqual(saved);
    expect(await db.pages.get(fresh)).toBeUndefined();
    local.settings = { language: 'en', defaultColor: '#facc15', disabledOrigins: [] };
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
  });

  it('keeps reminder fallback off after a preference read error without saving a fallback', async () => {
    const get = chrome.storage.local.get;
    Object.defineProperty(chrome.storage.local, 'get', {
      configurable: true,
      value: async (key: string) => {
        if (key === SELECTION_TOOLBAR_KEY) throw Error('Storage unavailable');
        return get(key);
      },
    });
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await db.pages.count()).toBe(0);
    expect(await db.stats.count()).toBe(0);
    expect(local).toEqual({});
  });

  it.each([undefined, false, true])('keeps webpage tool intent out of PDF mode and storage: %s', async (selectionTools) => {
    local[SELECTION_TOOLBAR_KEY] = true;
    const pdfUrl = `urn:web-ink:pdf:${'a'.repeat(64)}`;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl: pdfUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false } });
    expect(await db.pages.count()).toBe(0);
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl: pdfUrl, enabled: true, ...(selectionTools === undefined ? {} : { selectionTools }) }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: true } });
    expect(await db.pages.get(pdfUrl)).not.toHaveProperty('modeOverride');
    expect(await db.pages.get(pdfUrl)).not.toHaveProperty('manualSelectionTools');
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl: pdfUrl, enabled: false, ...(selectionTools === undefined ? {} : { selectionTools }) }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false } });
    expect(await db.pages.get(pdfUrl)).not.toHaveProperty('modeOverride');
    expect(await db.pages.get(pdfUrl)).not.toHaveProperty('manualSelectionTools');
  });

  it.each([
    { automatic: false, selectionTools: undefined, expected: true },
    { automatic: false, selectionTools: true, expected: true },
    { automatic: false, selectionTools: false, expected: false },
    { automatic: true, selectionTools: undefined, expected: true },
    { automatic: true, selectionTools: true, expected: true },
    { automatic: true, selectionTools: false, expected: true },
  ])('separates explicit selection tools from temporary page enablement: %j', async ({ automatic, selectionTools, expected }) => {
    local[SELECTION_TOOLBAR_KEY] = automatic;
    const intent = selectionTools === undefined ? {} : { selectionTools };
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true, ...intent }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: expected } });
    expect(await db.pages.get(pageUrl)).toMatchObject({ enabled: true, modeOverride: true, manualSelectionTools: selectionTools ?? true });
    db.close();
    await db.open();
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: expected } });
    local[SELECTION_TOOLBAR_KEY] = false;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: selectionTools !== false } });
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: false, ...intent }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    local[SELECTION_TOOLBAR_KEY] = true;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
  });

  it.each([true, undefined])('preserves explicit tools committed before a delayed implicit enable: %s', async (manualSelectionTools) => {
    local[SELECTION_TOOLBAR_KEY] = false;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });

    let release = () => {};
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let notifyStarted = () => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const get = chrome.storage.local.get;
    let blockOnce = true;
    Object.defineProperty(chrome.storage.local, 'get', {
      configurable: true,
      value: async (key: string) => {
        if (key === 'settings' && blockOnce) {
          blockOnce = false;
          notifyStarted();
          await paused;
        }
        return get(key);
      },
    });
    const implicit = handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true, selectionTools: false }, { trusted: true });
    await started;
    try {
      expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true, selectionTools: true }, { trusted: true }))
        .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
      if (manualSelectionTools === undefined) {
        // The older explicit switch stored no tool-intent field.
        await db.pages.update(pageUrl, { manualSelectionTools: undefined });
        expect(await db.pages.get(pageUrl)).not.toHaveProperty('manualSelectionTools');
      }
    } finally {
      release();
    }
    expect(await implicit)
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
    expect(await db.pages.get(pageUrl)).toMatchObject({ enabled: true, modeOverride: true, manualSelectionTools: true });

    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: false, selectionTools: false }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true, selectionTools: false }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: false } });
  });

  it.each([
    { enabled: true, modeOverride: true as const, expectedEnabled: true, expectedTools: true },
    { enabled: false, modeOverride: true as const, expectedEnabled: false, expectedTools: false },
    { enabled: true, expectedEnabled: true, expectedTools: false },
    { enabled: true, manualSelectionTools: true, expectedEnabled: true, expectedTools: false },
    { enabled: false, expectedEnabled: false, expectedTools: false },
  ])('preserves legacy page intent without rewriting records: %j', async ({ expectedEnabled, expectedTools, ...legacy }) => {
    const stored = { url: pageUrl, title: 'Legacy page', updatedAt: '2026-09-18T00:00:00.000Z', ...legacy };
    await db.pages.put(stored);
    local[SELECTION_TOOLBAR_KEY] = false;
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: expectedEnabled, selectionToolsEnabled: expectedTools } });
    expect(await db.pages.get(pageUrl)).toEqual(stored);
  });

  it.each([null, 0, 1, 'true', [], {}])('rejects non-boolean selection tool intent without mutation: %j', async (selectionTools) => {
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true, selectionTools }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await db.pages.count()).toBe(0);
    expect(await db.stats.count()).toBe(0);
  });

  it('defaults a missing page to disabled without creating a page record', async () => {
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await db.pages.count()).toBe(0);
  });

  it('persists enabled state, allows closing it, and retains existing annotations', async () => {
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: false, pageUrl });
    expect((await db.pages.get(pageUrl))?.enabled).toBe(true);

    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: false }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await db.annotations.count()).toBe(1);
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: false, pageUrl }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
  });

  it.each([
    { enabled: false, selectionTools: false },
    { enabled: false, selectionTools: true },
    { enabled: true, selectionTools: false },
    { enabled: true, selectionTools: true },
  ])('keeps explicit mode and tool intent through annotation writes, restores and imports: %j', async ({ enabled, selectionTools }) => {
    local[SELECTION_TOOLBAR_KEY] = true;
    await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled, selectionTools }, { trusted: true });
    await handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: true });
    const checkPage = async (title: string) => {
      const page = await db.pages.get(pageUrl);
      expect(page).toMatchObject({ enabled, modeOverride: true, manualSelectionTools: selectionTools, title });
      expect(await db.stats.get('library')).toMatchObject({
        pageCount: 1, pageBytes: new TextEncoder().encode(JSON.stringify(page)).byteLength,
      });
      expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
        .toEqual({ ok: true, data: { enabled, selectionToolsEnabled: enabled } });
    };
    await checkPage('Article');
    const saved = textAnnotation('annotation-1', 1);
    expect(await handleDataRequest({ type: 'annotations.delete', id: saved.id, expectedRevision: 1 }, { trusted: true }))
      .toMatchObject({ ok: true });
    expect(await handleDataRequest({ type: 'annotations.restore', annotation: { ...saved, pageTitle: 'Restored article' } }, { trusted: true }))
      .toMatchObject({ ok: true });
    await checkPage('Restored article');

    const imported = { ...textAnnotation('annotation-1'), pageTitle: 'Imported article', note: 'from backup', updatedAt: '2026-09-18T00:02:00.000Z' };
    const backup = { format: 'web-ink', schemaVersion: 1, exportedAt: '2026-09-18T03:00:00.000Z', annotations: [imported] };
    expect(await handleDataRequest({ type: 'backup.import', backup, overwrite: true }, { trusted: true }))
      .toMatchObject({ ok: true });
    await checkPage('Imported article');
    const added = { ...textAnnotation('annotation-2'), pageTitle: 'Added article' };
    expect(await handleDataRequest({ type: 'backup.import', backup: { ...backup, annotations: [added] }, overwrite: false }, { trusted: true }))
      .toMatchObject({ ok: true });
    await checkPage('Added article');
    expect((await db.annotations.toArray()).every((annotation) => !('modeOverride' in annotation))).toBe(true);
    const exported = await handleDataRequest({ type: 'backup.export' }, { trusted: true });
    expect(exported).toMatchObject({ ok: true });
    expect(JSON.stringify(exported)).not.toContain('modeOverride');
    expect(JSON.stringify(exported)).not.toContain('manualSelectionTools');
  });

  it('preserves a page-specific close through site pause and resume without affecting another page', async () => {
    local[SELECTION_TOOLBAR_KEY] = true;
    await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: false }, { trusted: true });
    const closed = await db.pages.get(pageUrl);
    local.settings = { language: 'en', defaultColor: '#facc15', disabledOrigins: ['https://example.test'] };
    expect(await handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true }, { trusted: true }))
      .toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await db.pages.get(pageUrl)).toEqual(closed);
    const sameOrigin = 'https://example.test/another-page';
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl: sameOrigin }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    local.settings = { language: 'en', defaultColor: '#facc15', disabledOrigins: [] };
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl: sameOrigin }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: true, selectionToolsEnabled: true } });
    expect(await db.pages.get(pageUrl)).toEqual(closed);
  });

  it('keeps the explicit flag atomic with mode writes and concurrent annotation metadata updates', async () => {
    local[SELECTION_TOOLBAR_KEY] = true;
    const results = await Promise.all([
      handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: true }, { trusted: true }),
      handleDataRequest({ type: 'annotations.put', annotation: textAnnotation(), expectedRevision: 0 }, { trusted: true }),
      handleDataRequest({ type: 'page.mode.put', pageUrl, enabled: false, selectionTools: false }, { trusted: true }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const page = await db.pages.get(pageUrl);
    expect(page).toMatchObject({ title: 'Article', enabled: false, modeOverride: true, manualSelectionTools: false });
    expect(await db.stats.get('library')).toMatchObject({
      pageCount: 1, annotationCount: 1,
      pageBytes: new TextEncoder().encode(JSON.stringify(page)).byteLength,
    });
    expect(await handleDataRequest({ type: 'page.mode.get', pageUrl }, { trusted: true }))
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
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
      .toEqual({ ok: true, data: { enabled: false, selectionToolsEnabled: false } });
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

  it('upgrades a real v2 database while preserving existing annotation records', async () => {
    const name = `web-ink-v2-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(2).stores({
      annotations: 'id, pageUrl, updatedAt, [updatedAt+id], [pageUrl+updatedAt+id], [kind+updatedAt+id], [color+updatedAt+id], *tags',
      pages: 'url, updatedAt', stats: 'id',
    });
    await legacy.open();
    const record = { ...textAnnotation('v2-record', 4), updatedAt: '2026-09-18T00:04:00.000Z' };
    await legacy.table('annotations').put(record);
    await legacy.table('pages').put({ url: pageUrl, title: 'V2 page', updatedAt: record.updatedAt, enabled: true });
    legacy.close();
    const upgraded = new WebInkDatabase(name);
    await upgraded.open();
    expect(await upgraded.annotations.get(record.id)).toMatchObject({ id: record.id, revision: 4, note: 'A note' });
    expect(await upgraded.pages.get(pageUrl)).toMatchObject({ enabled: true, title: 'V2 page' });
    expect(await upgraded.tombstones.count()).toBe(0);
    upgraded.close();
    await upgraded.delete();
  });
});
