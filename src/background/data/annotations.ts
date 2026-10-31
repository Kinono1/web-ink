import type { Annotation, Result } from "../../core/model";
import { MAX_REVISION, ValidationError } from "../../core/validation";
import { getDatabase } from "../database";
import { applyIncrementalStats } from "../storage-stats";
import { committedVersion, fail, ok, pageRecord, sameAnnotation } from "./validation";

export async function listAnnotations(pageUrl?: string): Promise<Annotation[]> {
  const db = getDatabase();
  const rows = pageUrl === undefined
    ? await db.annotations.toArray()
    : await db.annotations.where("pageUrl").equals(pageUrl).toArray();
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function getAnnotation(id: string): Promise<Annotation | null> {
  return (await getDatabase().annotations.get(id)) ?? null;
}

export async function putAnnotation(
  annotation: Annotation,
  expectedRevision: number,
  ownPage?: string,
): Promise<Result<Annotation>> {
  if (annotation.revision !== expectedRevision)
    return fail("annotation.revision must equal expectedRevision", "INVALID_INPUT");
  const db = getDatabase();
  return db.transaction("rw", db.annotations, db.pages, db.stats, db.tombstones, async () => {
    const existing = await db.annotations.get(annotation.id);
    const candidate = committedVersion(annotation, expectedRevision);
    // Check the owner from the transactional read, rather than trusting an ID and
    // page URL supplied by an untrusted content script.
    if (existing && ownPage !== undefined && existing.pageUrl !== ownPage)
      return fail("Content scripts may only write annotations from their own page.", "FORBIDDEN");
    // A service-worker retry may carry the pre-commit revision. Do not turn it into another edit.
    if (existing && sameAnnotation(existing, candidate)) return ok(existing);
    if (existing && existing.revision !== expectedRevision)
      return fail("Annotation changed in another tab.", "CONFLICT");
    if (!existing && (await db.tombstones.get(annotation.id)))
      return fail("Annotation was deleted; restore it through its tombstone.", "CONFLICT");
    if (!existing && expectedRevision !== 0) return fail("Annotation no longer exists.", "CONFLICT");
    const existingPage = await db.pages.get(candidate.pageUrl);
    const storedPage = pageRecord(candidate, existingPage);
    await db.annotations.put(candidate);
    await db.pages.put(storedPage);
    await applyIncrementalStats({
      ...(existing ? { beforeAnnotation: existing } : {}),
      afterAnnotation: candidate,
      ...(existingPage ? { beforePage: existingPage } : {}),
      afterPage: storedPage,
    });
    return ok(candidate);
  });
}

export async function restoreAnnotation(annotation: Annotation, ownPage?: string): Promise<Result<Annotation>> {
  const db = getDatabase();
  return db.transaction("rw", db.annotations, db.pages, db.stats, db.tombstones, async () => {
    const tombstone = await db.tombstones.get(annotation.id);
    const existing = await db.annotations.get(annotation.id);
    if (!tombstone)
      return fail("Annotation cannot be restored because its deletion generation is unavailable.", "CONFLICT");
    if (ownPage !== undefined && tombstone.pageUrl !== ownPage)
      return fail("Content scripts may only restore annotations from their own page.", "FORBIDDEN");
    if (annotation.pageUrl !== tombstone.pageUrl || annotation.revision !== tombstone.revision)
      return fail("Annotation deletion generation has changed.", "CONFLICT");
    if (tombstone.revision >= MAX_REVISION) throw new ValidationError("Annotation revision limit reached.");
    const restored = { ...annotation, revision: tombstone.revision + 1 } as Annotation;
    if (existing) {
      if (sameAnnotation(existing, restored)) return ok(existing);
      return fail("Annotation ID has been reused by a newer record.", "CONFLICT");
    }
    const existingPage = await db.pages.get(restored.pageUrl);
    const storedPage = pageRecord(restored, existingPage);
    await db.annotations.put(restored);
    await db.pages.put(storedPage);
    await applyIncrementalStats({
      afterAnnotation: restored,
      ...(existingPage ? { beforePage: existingPage } : {}),
      afterPage: storedPage,
    });
    return ok(restored);
  });
}

export async function deleteAnnotation(
  id: string,
  expectedRevision: number,
  ownPage?: string,
): Promise<Result<{ id: string; deleted: true }>> {
  const db = getDatabase();
  return db.transaction("rw", db.annotations, db.stats, db.tombstones, async () => {
    const existing = await db.annotations.get(id);
    if (!existing) return fail("Annotation no longer exists.", "CONFLICT");
    if (ownPage !== undefined && existing.pageUrl !== ownPage)
      return fail("Content scripts may only delete annotations from their own page.", "FORBIDDEN");
    if (existing.revision !== expectedRevision) return fail("Annotation changed in another tab.", "CONFLICT");
    await db.annotations.delete(id);
    await db.tombstones.put({ id: existing.id, pageUrl: existing.pageUrl, revision: existing.revision });
    await applyIncrementalStats({ beforeAnnotation: existing });
    return ok({ id, deleted: true });
  });
}
