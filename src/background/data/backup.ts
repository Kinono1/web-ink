import type { Annotation, BackupEnvelope, ImportPreview } from "../../core/model";
import { MAX_REVISION, ValidationError } from "../../core/validation";
import { serializeBackup } from "../../core/backup";
import { getDatabase } from "../database";
import { applyIncrementalStats, type StatsChange } from "../storage-stats";
import { listAnnotations } from "./annotations";
import { readSettings } from "./settings";
import { committedVersion, pageRecord, sameAnnotation } from "./validation";

type ImportChange = { incoming: Annotation; local?: Annotation };

export async function exportBackup(): Promise<BackupEnvelope> {
  return serializeBackup(await listAnnotations(), await readSettings());
}

export async function previewBackup(annotations: Annotation[]): Promise<ImportPreview> {
  const existing = await getDatabase().annotations.bulkGet(annotations.map(annotation => annotation.id));
  return classifyImport(annotations, existing);
}

export async function importBackup(annotations: Annotation[], overwrite: boolean): Promise<ImportPreview> {
  const db = getDatabase();
  // The caller validates the envelope first. Reads, writes, and totals use one transaction.
  return db.transaction("rw", db.annotations, db.pages, db.stats, db.tombstones, async () => {
    const existing = await db.annotations.bulkGet(annotations.map(annotation => annotation.id));
    const changes: ImportChange[] = [];
    const preview = classifyImport(annotations, existing, (incoming, local) => {
      if (!local || overwrite) changes.push({ incoming, local });
    });
    if (changes.length === 0) return preview;

    const newIds = changes.filter(change => !change.local).map(change => change.incoming.id);
    const tombstones = new Map<string, number>();
    for (const tombstone of await db.tombstones.bulkGet(newIds))
      if (tombstone) tombstones.set(tombstone.id, tombstone.revision);
    const records = changes.map(change => importRecord(change, tombstones));

    // The last imported record for a page determines its title and timestamp.
    // Existing enablement and selection overrides are carried into that final row.
    const lastByPage = new Map<string, Annotation>();
    for (const record of records) lastByPage.set(record.pageUrl, record);
    const previousPages = await db.pages.bulkGet([...lastByPage.keys()]);
    const pages = Array.from(lastByPage.values(), (record, index) => pageRecord(record, previousPages[index]));

    await db.annotations.bulkPut(records);
    await db.pages.bulkPut(pages);
    const stats: StatsChange[] = records.map((afterAnnotation, index) => ({
      beforeAnnotation: changes[index]!.local, afterAnnotation,
    }));
    pages.forEach((afterPage, index) => stats.push({ beforePage: previousPages[index], afterPage }));
    await applyIncrementalStats(stats);
    return preview;
  });
}

function importRecord({ incoming, local }: ImportChange, tombstones: ReadonlyMap<string, number>): Annotation {
  // An overwrite advances the local clock. A deleted ID advances past both clocks.
  if (local) return advanceRevision(incoming, local.revision);
  const deletedRevision = tombstones.get(incoming.id);
  return deletedRevision === undefined
    ? incoming
    : advanceRevision(incoming, Math.max(incoming.revision, deletedRevision));
}

function advanceRevision(incoming: Annotation, previous: number): Annotation {
  if (previous >= MAX_REVISION) throw new ValidationError("Annotation revision limit reached.");
  return committedVersion(incoming, previous);
}

function classifyImport(
  incoming: Annotation[],
  existing: Array<Annotation | undefined>,
  changed?: (incoming: Annotation, local: Annotation | undefined) => void,
): ImportPreview {
  let added = 0, identical = 0, conflicts = 0;
  for (const [index, annotation] of incoming.entries()) {
    if (!annotation) continue;
    const local = existing[index];
    if (!local) added++;
    else if (sameAnnotation(local, annotation)) {
      identical++;
      continue;
    } else conflicts++;
    changed?.(annotation, local);
  }
  return { added, identical, conflicts, total: incoming.length };
}
