import Dexie, { type Table } from 'dexie';
import type { Annotation, PageRecord } from '../core/model';

export interface LibraryStatsRecord {
  id: 'library';
  annotationCount: number;
  textCount: number;
  imageCount: number;
  pdfTextCount: number;
  pdfAreaCount: number;
  pageCount: number;
  annotationBytes: number;
  pageBytes: number;
}

/** Durable deletion generation used to prevent an ID/revision ABA resurrection. */
export interface TombstoneRecord {
  id: string;
  pageUrl: string;
  /** Revision of the record that was deleted. A restoration must advance it. */
  revision: number;
}

/** Extension-owned IndexedDB. Content scripts access it only through the service worker. */
export class WebInkDatabase extends Dexie {
  annotations!: Table<Annotation, string>;
  pages!: Table<PageRecord, string>;
  stats!: Table<LibraryStatsRecord, 'library'>;
  tombstones!: Table<TombstoneRecord, string>;

  constructor(name = 'web-ink') {
    super(name);
    this.version(1).stores({
      annotations: 'id, pageUrl, updatedAt',
      pages: 'url, updatedAt',
    });
    this.version(2).stores({
      annotations: 'id, pageUrl, updatedAt, [updatedAt+id], [pageUrl+updatedAt+id], [kind+updatedAt+id], [color+updatedAt+id], *tags',
      pages: 'url, updatedAt',
      stats: 'id',
    }).upgrade(async transaction => {
      let annotationCount = 0, textCount = 0, imageCount = 0, pdfTextCount = 0, pdfAreaCount = 0, annotationBytes = 0, pageCount = 0, pageBytes = 0;
      const annotations = transaction.table('annotations') as Table<Annotation, string>;
      const pages = transaction.table('pages') as Table<PageRecord, string>;
      await annotations.each(annotation => {
        annotationCount += 1;
        annotationBytes += new TextEncoder().encode(JSON.stringify(annotation)).byteLength;
        if (annotation.kind === 'text') textCount += 1;
        else if (annotation.kind === 'image') imageCount += 1;
        else if (annotation.kind === 'pdf-text') pdfTextCount += 1;
        else pdfAreaCount += 1;
      });
      await pages.each(page => { pageCount += 1; pageBytes += new TextEncoder().encode(JSON.stringify(page)).byteLength; });
      await transaction.table('stats').put({ id: 'library', annotationCount, textCount, imageCount, pdfTextCount, pdfAreaCount, pageCount, annotationBytes, pageBytes });
    });
    this.version(3).stores({
      annotations: 'id, pageUrl, updatedAt, [updatedAt+id], [pageUrl+updatedAt+id], [kind+updatedAt+id], [color+updatedAt+id], *tags',
      pages: 'url, updatedAt',
      stats: 'id',
      tombstones: 'id, pageUrl, revision',
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
