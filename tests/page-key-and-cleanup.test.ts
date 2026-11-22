import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebInkDatabase, setDatabaseForTesting } from '../src/background/database';
import { handleDataRequest } from '../src/background/data';
import { parseBackup } from '../src/core/backup';
import type { Annotation } from '../src/core/model';
import { pageKey } from '../src/core/url';

const article = 'https://example.test/article?topic=ink';
const trusted = { trusted: true } as const;
let db: WebInkDatabase;
let local: Record<string, unknown>;

function text(id: string, pageUrl = article, revision = 0): Annotation {
  return {
    id, pageUrl, pageTitle: 'Article', color: '#facc15', note: '', tags: [],
    createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', revision, kind: 'text',
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
          get: async (key: string | null) => (key === null ? { ...local } : { [key]: local[key] }),
          set: async (value: Record<string, unknown>) => { Object.assign(local, value); },
          remove: async (keys: string[]) => { for (const key of keys) delete local[key]; },
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

describe('pageKey', () => {
  it('drops tracking parameters and keeps content parameters byte for byte', () => {
    expect(pageKey('https://example.test/a?utm_source=x&id=7&fbclid=abc')).toBe('https://example.test/a?id=7');
    expect(pageKey('https://example.test/a?UTM_Medium=x&gclid=1')).toBe('https://example.test/a');
    expect(pageKey('https://example.test/a?q=a%20b+c&utm_campaign=z')).toBe('https://example.test/a?q=a%20b+c');
    expect(pageKey('https://example.test/a?q=a%20b+c')).toBe('https://example.test/a?q=a%20b+c');
    expect(pageKey('https://example.test/a?utm_source=x#/route')).toBe('https://example.test/a#/route');
    expect(pageKey('https://example.test/a?utm_source=x#heading')).toBe('https://example.test/a');
  });

  it('is stable when applied twice', () => {
    const once = pageKey('https://example.test/a?b=1&utm_term=t&&c=2');
    expect(pageKey(once)).toBe(once);
  });
});

describe('backup import with older page keys', () => {
  it('re-keys web annotations saved with tracking parameters', () => {
    const backup = {
      format: 'web-ink', schemaVersion: 2, exportedAt: '2026-09-18T00:00:00.000Z',
      annotations: [text('legacy', 'https://example.test/article?topic=ink&utm_source=feed')],
    };
    expect(parseBackup(backup).annotations[0]?.pageUrl).toBe(article);
  });
});

describe('database v4 migration', () => {
  it('moves annotations, deletion records and page rows to the current key', async () => {
    const name = `web-ink-legacy-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(3).stores({
      annotations: 'id, pageUrl, updatedAt, [updatedAt+id], [pageUrl+updatedAt+id], [kind+updatedAt+id], [color+updatedAt+id], *tags',
      pages: 'url, updatedAt', stats: 'id', tombstones: 'id, pageUrl, revision',
    });
    const tracked = `${article}&utm_source=feed`;
    await legacy.table('annotations').bulkPut([text('a', tracked, 1), text('b', article, 1)]);
    await legacy.table('pages').bulkPut([
      { url: tracked, title: 'Tracked', updatedAt: '2026-09-19T00:00:00.000Z', enabled: true, modeOverride: true },
      { url: article, title: 'Plain', updatedAt: '2026-09-18T00:00:00.000Z' },
    ]);
    await legacy.table('tombstones').put({ id: 'gone', pageUrl: tracked, revision: 2 });
    legacy.close();

    const upgraded = new WebInkDatabase(name);
    try {
      expect((await upgraded.annotations.toArray()).map((a) => a.pageUrl)).toEqual([article, article]);
      expect((await upgraded.tombstones.get('gone'))?.pageUrl).toBe(article);
      const pages = await upgraded.pages.toArray();
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({ url: article, title: 'Tracked', enabled: true, modeOverride: true });
      expect(await upgraded.stats.get('library')).toMatchObject({ annotationCount: 2, pageCount: 1 });
    } finally {
      upgraded.close();
      await upgraded.delete();
    }
  });
});

describe('page cleanup and delete all', () => {
  it('removes the page row once its last annotation is deleted', async () => {
    await handleDataRequest({ type: 'annotations.put', annotation: text('one'), expectedRevision: 0 }, trusted);
    await handleDataRequest({ type: 'annotations.put', annotation: text('two'), expectedRevision: 0 }, trusted);
    await handleDataRequest({ type: 'annotations.delete', id: 'one', expectedRevision: 1 }, trusted);
    expect(await db.pages.get(article)).toBeDefined();
    await handleDataRequest({ type: 'annotations.delete', id: 'two', expectedRevision: 1 }, trusted);
    expect(await db.pages.get(article)).toBeUndefined();
    expect(await db.stats.get('library')).toMatchObject({ annotationCount: 0, pageCount: 0, pageBytes: 0 });
  });

  it('keeps a page on/off choice but forgets the title', async () => {
    await handleDataRequest({ type: 'page.mode.put', pageUrl: article, enabled: true }, trusted);
    await handleDataRequest({ type: 'annotations.put', annotation: text('one'), expectedRevision: 0 }, trusted);
    await handleDataRequest({ type: 'annotations.delete', id: 'one', expectedRevision: 1 }, trusted);
    expect(await db.pages.get(article)).toMatchObject({ title: '', enabled: true, modeOverride: true });
  });

  it('restores the page title when a deletion is undone', async () => {
    await handleDataRequest({ type: 'annotations.put', annotation: text('one'), expectedRevision: 0 }, trusted);
    await handleDataRequest({ type: 'annotations.delete', id: 'one', expectedRevision: 1 }, trusted);
    const restored = await handleDataRequest({ type: 'annotations.restore', annotation: text('one', article, 1) }, trusted);
    expect(restored.ok).toBe(true);
    expect(await db.pages.get(article)).toMatchObject({ title: 'Article' });
  });

  it('deletes all library data and PDF reading state for trusted UI only', async () => {
    await handleDataRequest({ type: 'annotations.put', annotation: text('one'), expectedRevision: 0 }, trusted);
    await handleDataRequest({ type: 'annotations.delete', id: 'one', expectedRevision: 1 }, trusted);
    await handleDataRequest({ type: 'annotations.put', annotation: text('two'), expectedRevision: 0 }, trusted);
    local = { settings: { kept: true }, 'ui.pdfReadingPosition.abc': 1, 'ui.pdfPaperIdentity.abc': 2 };

    const denied = await handleDataRequest({ type: 'library.clear' }, { trusted: false, pageUrl: article });
    expect(denied).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await db.annotations.count()).toBe(1);

    const cleared = await handleDataRequest({ type: 'library.clear' }, trusted);
    expect(cleared).toEqual({ ok: true, data: { annotations: 1, pages: 1 } });
    expect(await db.annotations.count()).toBe(0);
    expect(await db.pages.count()).toBe(0);
    expect(await db.tombstones.count()).toBe(0);
    expect(await db.stats.get('library')).toMatchObject({ annotationCount: 0, pageCount: 0 });
    expect(local).toEqual({ settings: { kept: true } });
  });
});
