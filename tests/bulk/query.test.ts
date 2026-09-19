import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebInkDatabase, setDatabaseForTesting } from '../../src/background/database';
import { handleDataRequest } from '../../src/background/data';
import type { Annotation } from '../../src/core/model';

const pageUrl = 'https://example.test/bulk-query';
let db: WebInkDatabase;

function row(id: string, second: number): Annotation {
  return {
    id,
    pageUrl,
    pageTitle: 'Bulk query',
    color: '#facc15',
    note: 'other annotation',
    tags: ['query'],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: `2026-09-19T00:00:${String(second % 60).padStart(2, '0')}.000Z`,
    revision: 1,
    kind: 'text',
    target: { exact: 'query evidence', prefix: '', suffix: '', start: 0, end: 14, rootSelector: 'main' },
  };
}

beforeEach(() => {
  db = new WebInkDatabase(`bulk-query-${crypto.randomUUID()}`);
  setDatabaseForTesting(db);
});

afterEach(async () => {
  setDatabaseForTesting(undefined);
  db.close();
  await db.delete();
});

describe('large mixed-metadata query correctness', () => {
  it.each([10_000, 50_000])(
    'matches the DESC reference across %i records',
    async (count) => {
      const records = Array.from({ length: count }, (_, index) => ({
        ...row(`mixed-${String(index).padStart(6, '0')}`, index),
        pageUrl: index % 3 === 0 ? 'https://example.test/other' : pageUrl,
        color: index % 2 === 0 ? '#4ade80' : '#facc15',
        tags: index % 17 === 0 ? ['needle', 'query'] : ['query'],
        note: index % 19 === 0 ? 'searchable annotation exact' : 'other annotation',
      }));
      await db.annotations.bulkPut(records);
      const expected = records
        .filter(
          (record) =>
            record.pageUrl === pageUrl &&
            record.kind === 'text' &&
            record.color === '#4ade80' &&
            record.tags.includes('needle') &&
            `${record.note} ${record.target.exact}`.toLocaleLowerCase().includes('searchable'),
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
        );
      const actual: Annotation[] = [];
      let cursor: { updatedAt: string; id: string } | undefined;
      do {
        const response = await handleDataRequest(
          {
            type: 'annotations.query',
            query: {
              pageUrl,
              kind: 'text',
              color: '#4ade80',
              tag: 'needle',
              text: 'searchable',
              limit: 50,
              ...(cursor ? { cursor } : {}),
            },
          },
          { trusted: true, callerKey: `bulk-reference-${count}` },
        );
        if (!response.ok) throw new Error(response.error);
        const page = response.data as {
          items: Annotation[];
          nextCursor?: { updatedAt: string; id: string };
        };
        actual.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(actual.map((record) => record.id)).toEqual(expected.map((record) => record.id));
    },
  );
});
