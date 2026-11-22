import Dexie, { type Table, type Transaction } from "dexie";
import type { Annotation, PageRecord } from "../core/model";
import { isWebPage, pageKey } from "../core/url";

export interface LibraryStatsRecord {
  id: "library"; annotationCount: number; textCount: number; imageCount: number;
  pdfTextCount: number; pdfAreaCount: number; pageCount: number; annotationBytes: number; pageBytes: number;
}

/** Durable deletion generation used to prevent an ID/revision ABA resurrection. */
export interface TombstoneRecord {
  id: string;
  pageUrl: string;
  /** Revision of the record that was deleted. A restoration must advance it. */
  revision: number;
}

const ANNOTATION_STORES =
  "id, pageUrl, updatedAt, [updatedAt+id], [pageUrl+updatedAt+id], [kind+updatedAt+id], [color+updatedAt+id], *tags";

const TOMBSTONE_STORES = "id, pageUrl, revision";

/** Count the library inside an upgrade transaction (the stats table may not exist yet). */
async function countLibrary(transaction: Transaction): Promise<LibraryStatsRecord> {
  let annotationCount = 0, textCount = 0, imageCount = 0, pdfTextCount = 0, pdfAreaCount = 0, annotationBytes = 0;
  let pageCount = 0, pageBytes = 0;
  const annotations = transaction.table("annotations") as Table<Annotation, string>;
  const pages = transaction.table("pages") as Table<PageRecord, string>;
  const encoder = new TextEncoder();
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  await annotations.each((annotation) => {
    annotationCount += 1;
    annotationBytes += bytes(annotation);
    if (annotation.kind === "text") textCount += 1;
    else if (annotation.kind === "image") imageCount += 1;
    else if (annotation.kind === "pdf-text") pdfTextCount += 1;
    else pdfAreaCount += 1;
  });
  await pages.each((page) => { pageCount += 1; pageBytes += bytes(page); });
  return { id: "library", annotationCount, textCount, imageCount, pdfTextCount, pdfAreaCount, pageCount, annotationBytes, pageBytes };
}

function currentKey(url: string): string {
  if (!isWebPage(url)) return url;
  try { return pageKey(url); } catch { return url; }
}

/** A local on/off choice outranks a page row that only carries a title. */
function mergePages(left: PageRecord, right: PageRecord): PageRecord {
  const [newer, older] = left.updatedAt >= right.updatedAt ? [left, right] : [right, left];
  const choice = newer.modeOverride ? newer : older.modeOverride ? older : newer;
  return { ...choice, url: newer.url, title: newer.title || older.title, updatedAt: newer.updatedAt };
}

/** Move annotations, deletion records and page rows to the current page key. */
async function rekeyPages(transaction: Transaction): Promise<void> {
  const annotations = transaction.table("annotations") as Table<Annotation, string>;
  const tombstones = transaction.table("tombstones") as Table<TombstoneRecord, string>;
  const pages = transaction.table("pages") as Table<PageRecord, string>;
  await annotations.toCollection().modify((annotation) => { annotation.pageUrl = currentKey(annotation.pageUrl); });
  await tombstones.toCollection().modify((tombstone) => { tombstone.pageUrl = currentKey(tombstone.pageUrl); });
  const moved = (await pages.toArray()).filter((page) => currentKey(page.url) !== page.url);
  if (!moved.length) return;
  await pages.bulkDelete(moved.map((page) => page.url));
  const merged = new Map<string, PageRecord>();
  for (const page of moved) {
    const url = currentKey(page.url);
    const candidate = { ...page, url };
    const existing = merged.get(url) ?? (await pages.get(url));
    merged.set(url, existing ? mergePages(existing, candidate) : candidate);
  }
  await pages.bulkPut([...merged.values()]);
}

/** Extension-owned IndexedDB. Content scripts access it only through the service worker. */
export class WebInkDatabase extends Dexie {
  annotations!: Table<Annotation, string>;
  pages!: Table<PageRecord, string>;
  stats!: Table<LibraryStatsRecord, "library">;
  tombstones!: Table<TombstoneRecord, string>;

  constructor(name = "web-ink") {
    super(name);
    this.version(1).stores({ annotations: "id, pageUrl, updatedAt", pages: "url, updatedAt" });
    this.version(2)
      .stores({ annotations: ANNOTATION_STORES, pages: "url, updatedAt", stats: "id" })
      .upgrade(async (transaction) => {
        await transaction.table("stats").put(await countLibrary(transaction));
      });
    this.version(3).stores({ annotations: ANNOTATION_STORES, pages: "url, updatedAt", stats: "id", tombstones: TOMBSTONE_STORES });
    // v4 re-keys web pages after tracking parameters left the page key.
    this.version(4)
      .stores({ annotations: ANNOTATION_STORES, pages: "url, updatedAt", stats: "id", tombstones: TOMBSTONE_STORES })
      .upgrade(async (transaction) => {
        await rekeyPages(transaction);
        await transaction.table("stats").put(await countLibrary(transaction));
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
