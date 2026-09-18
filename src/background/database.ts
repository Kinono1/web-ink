import Dexie, { type Table } from 'dexie';
import type { Annotation, PageRecord } from '../core/model';

/** Extension-owned IndexedDB. Content scripts access it only through the service worker. */
export class WebInkDatabase extends Dexie {
  annotations!: Table<Annotation, string>;
  pages!: Table<PageRecord, string>;

  constructor(name = 'web-ink') {
    super(name);
    this.version(1).stores({
      annotations: 'id, pageUrl, updatedAt',
      pages: 'url, updatedAt',
    });
  }
}

let activeDatabase: WebInkDatabase | undefined;

export function getDatabase(): WebInkDatabase {
  activeDatabase ??= new WebInkDatabase();
  return activeDatabase;
}

/** Test-only seam; production code should use the stable extension database. */
export function setDatabaseForTesting(database: WebInkDatabase | undefined): void {
  activeDatabase = database;
}
