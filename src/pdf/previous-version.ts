import { request } from "../core/client";
import type { AnnotationCursor, AnnotationPage } from "../core/model";

const MAX_PAGES_PER_SOURCE = 20;

/** Detection only: source identity never authorizes applying another hash's marks. */
export async function findPreviousPdfVersion(
  documentHash: string,
  sources: string[],
  signal: AbortSignal,
): Promise<{ hash?: string; incomplete: boolean }> {
  const observedSources = new Set(sources);
  let incomplete = false;
  for (const source of observedSources) {
    let cursor: AnnotationCursor | undefined;
    for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_SOURCE; pageNumber++) {
      if (signal.aborted) return { incomplete: true };
      const requestId = crypto.randomUUID();
      const cancel = () => {
        void request({ type: "annotations.query.cancel", requestId }).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      let page: AnnotationPage;
      try {
        page = await request<AnnotationPage>({
          type: "annotations.query",
          query: { text: source, limit: 50, requestId, ...(cursor ? { cursor } : {}) },
        });
      } catch {
        incomplete = true;
        break;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
      if (signal.aborted) return { incomplete: true };
      if (page.cancelled) {
        incomplete = true;
        break;
      }
      for (const record of page.items) {
        if ((record.kind === "pdf-text" || record.kind === "pdf-area") &&
          record.target.sourceUrl && observedSources.has(record.target.sourceUrl) &&
          record.target.documentHash !== documentHash) {
          return { hash: record.target.documentHash, incomplete: false };
        }
      }
      const next = page.nextCursor;
      if (!next) break;
      // The query service orders [updatedAt, id] descending. A stalled or
      // reversing cursor cannot establish that the remaining history was read.
      if (pageNumber + 1 === MAX_PAGES_PER_SOURCE || (cursor &&
        (next.updatedAt > cursor.updatedAt ||
          (next.updatedAt === cursor.updatedAt && next.id >= cursor.id)))) {
        incomplete = true;
        break;
      }
      cursor = next;
    }
  }
  return { incomplete };
}
