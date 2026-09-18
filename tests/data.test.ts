import 'fake-indexeddb/auto';
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
    expect(await handleDataRequest({ type: 'settings.get' }, { trusted: true })).toEqual({ ok: true, data: localSettings });
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
});
