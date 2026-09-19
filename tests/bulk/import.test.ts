import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebInkDatabase, setDatabaseForTesting } from '../../src/background/database';
import { handleDataRequest } from '../../src/background/data';
import { parseBackup } from '../../src/core/backup';
import type { Annotation } from '../../src/core/model';

const pageUrl = 'https://example.test/bulk-import';
let db: WebInkDatabase;

function textAnnotation(id: string): Annotation {
  return {
    id,
    pageUrl,
    pageTitle: 'Bulk import',
    color: '#facc15',
    note: 'A manually authored bulk-test annotation',
    tags: ['bulk'],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    revision: 0,
    kind: 'text',
    target: { exact: 'bulk evidence', prefix: '', suffix: '', start: 0, end: 13, rootSelector: 'article' },
  };
}

async function measure<T>(phase: string, operation: () => T | Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await operation();
  console.info(`[bulk timing] ${phase}=${(performance.now() - startedAt).toFixed(1)}ms`);
  return result;
}

beforeEach(() => {
  db = new WebInkDatabase(`bulk-import-${crypto.randomUUID()}`);
  setDatabaseForTesting(db);
});

afterEach(async () => {
  setDatabaseForTesting(undefined);
  db.close();
  await db.delete();
});

describe('10,000-record backup import', () => {
  it('keeps import/list correctness and emits phase timing evidence', async () => {
    const backup = await measure('prepare', () => ({
      format: 'web-ink',
      schemaVersion: 1,
      exportedAt: '2026-09-19T03:00:00.000Z',
      annotations: Array.from({ length: 10_000 }, (_, index) => textAnnotation(`bulk-${index}`)),
    }));

    // This measures the validation layer on its own. The request below validates
    // again by design before its transaction; do not treat either duration as a
    // production latency budget or a performance-regression threshold.
    const validated = await measure('validate', () => parseBackup(backup));
    expect(validated.annotations).toHaveLength(10_000);

    const imported = await measure('import', () =>
      handleDataRequest({ type: 'backup.import', backup, overwrite: false }, { trusted: true }),
    );
    expect(imported).toEqual({ ok: true, data: { added: 10_000, identical: 0, conflicts: 0, total: 10_000 } });

    const listed = await measure('query', () =>
      handleDataRequest({ type: 'annotations.list', pageUrl }, { trusted: false, pageUrl }),
    );
    expect(listed.ok && Array.isArray(listed.data) ? listed.data.length : -1).toBe(10_000);
  });
});
