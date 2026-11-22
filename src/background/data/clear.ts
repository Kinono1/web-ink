import { getDatabase } from "../database";

/** Per-document preferences that name a PDF the user opened. */
const DOCUMENT_PREFIXES = ["ui.pdfReadingPosition.", "ui.pdfPaperIdentity."];

export interface LibraryClearResult {
  annotations: number;
  pages: number;
}

/**
 * Delete every annotation, page record and deletion record, plus per-PDF reading
 * state. Settings and interface preferences stay, so the extension keeps working
 * the way the user configured it.
 */
export async function clearLibrary(): Promise<LibraryClearResult> {
  const db = getDatabase();
  const result = await db.transaction("rw", db.annotations, db.pages, db.stats, db.tombstones, async () => {
    const counts = { annotations: await db.annotations.count(), pages: await db.pages.count() };
    await Promise.all([db.annotations.clear(), db.pages.clear(), db.tombstones.clear()]);
    await db.stats.put({
      id: "library", annotationCount: 0, textCount: 0, imageCount: 0, pdfTextCount: 0,
      pdfAreaCount: 0, pageCount: 0, annotationBytes: 0, pageBytes: 0,
    });
    return counts;
  });
  const stored = await chrome.storage.local.get(null);
  const documentKeys = Object.keys(stored).filter((key) => DOCUMENT_PREFIXES.some((prefix) => key.startsWith(prefix)));
  if (documentKeys.length) await chrome.storage.local.remove(documentKeys);
  return result;
}
