import type { Annotation, BackupEnvelope, ImportPreview } from "../../core/model";
import { MAX_REVISION, ValidationError } from "../../core/validation";
import { serializeBackup } from "../../core/backup";
import { getDatabase } from "../database";
import { applyIncrementalStats } from "../storage-stats";
import { listAnnotations } from "./annotations";
import { readSettings } from "./settings";
import { classifyImport, pageRecord, sameAnnotation } from "./validation";

export async function exportBackup(): Promise<BackupEnvelope> {
  return serializeBackup(await listAnnotations(), await readSettings());
}

export async function previewBackup(annotations: Annotation[]): Promise<ImportPreview> {
  const db = getDatabase();
  return classifyImport(annotations, await db.annotations.bulkGet(annotations.map((a) => a.id)));
}

export async function importBackup(annotations: Annotation[], overwrite: boolean): Promise<ImportPreview> {
  const db = getDatabase();
  // `parseBackup` ran before this call. All mutations below are one Dexie transaction.
  return db.transaction("rw", db.annotations, db.pages, db.stats, db.tombstones, async () => {
    const existing = await db.annotations.bulkGet(annotations.map((a) => a.id));
    const preview = classifyImport(annotations, existing);
    for (let index = 0; index < annotations.length; index += 1) {
      const incoming = annotations[index];
      if (!incoming) continue;
      const local = existing[index];
      if (!local || (overwrite && !sameAnnotation(local, incoming))) {
        // Imported revisions are foreign clocks. A local overwrite is a new local
        // mutation, so it must advance the local clock and invalidate stale tabs.
        if (local && local.revision >= MAX_REVISION)
          throw new ValidationError("Annotation revision limit reached.");
        const tombstone = !local ? await db.tombstones.get(incoming.id) : undefined;
        if (tombstone && Math.max(incoming.revision, tombstone.revision) >= MAX_REVISION)
          throw new ValidationError("Annotation revision limit reached.");
        const stored = local
          ? ({ ...incoming, revision: local.revision + 1 } as Annotation)
          : tombstone
            ? ({ ...incoming, revision: Math.max(incoming.revision, tombstone.revision) + 1 } as Annotation)
            : incoming;
        const existingPage = await db.pages.get(stored.pageUrl);
        const storedPage = pageRecord(stored, existingPage);
        await db.annotations.put(stored);
        await db.pages.put(storedPage);
        await applyIncrementalStats({
          ...(local ? { beforeAnnotation: local } : {}),
          afterAnnotation: stored,
          ...(existingPage ? { beforePage: existingPage } : {}),
          afterPage: storedPage,
        });
      }
    }
    return preview;
  });
}
