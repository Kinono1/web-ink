import { type PdfNoteDraft } from "../PdfNote";
import { errorText, type PdfAnnotation, type SelectionTarget } from "../types";
import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { request, RequestError, releaseChromeListener } from "../../core/client";
import { type Annotation, type PdfTarget } from "../../core/model";
import { isIeeeSessionPage } from "../context";
import { doiUrl } from "../paper-identity";
import { isPdf, noteTags, dirtyDraft } from "./reader-utils";
import type { ReaderSnapshot, ReaderActionsRef } from "./contracts";

export function useAnnotationsState() {
  const [records, setRecords] = useState<PdfAnnotation[]>([]);
  const recordsRef = useRef(records);
  const [picked, setPicked] = useState<PdfAnnotation>();
  const [undoRecord, setUndoRecord] = useState<PdfAnnotation>();
  const [unsaved, setUnsaved] = useState<PdfAnnotation>();
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notesLimit, setNotesLimit] = useState(50);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, PdfNoteDraft>>(
    {},
  );
  const draftsRef = useRef(noteDrafts);
  const unsavedRef = useRef(unsaved);
  const noteAfterSave = useRef(false);
  const annotationWrites = useRef(new Set<Promise<unknown>>());
  const [writeCount, setWriteCount] = useState(0);
  const [noteSaving, setNoteSaving] = useState<string>();
  const [noteConflicts, setNoteConflicts] = useState<Record<string, boolean>>({});
  const annotationChangeEpoch = useRef(0);
  recordsRef.current = records;
  draftsRef.current = noteDrafts;
  unsavedRef.current = unsaved;
  const savedIds = useMemo(() => new Set(records.map((record) => record.id)), [records]);
  const deletedDrafts = Object.values(noteDrafts).filter(
    (draft) => dirtyDraft(draft) && !savedIds.has(draft.base.id),
  );
  const sortedNotes = useMemo(
    () =>
      records
        .slice()
        .sort(
          (a, b) =>
            a.target.pageNumber - b.target.pageNumber ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        ),
    [records],
  );
  const recordsByPage = useMemo(() => {
    const pages = new Map<number, PdfAnnotation[]>();
    for (const record of records) {
      const page = pages.get(record.target.pageNumber);
      if (page) page.push(record);
      else pages.set(record.target.pageNumber, [record]);
    }
    return pages;
  }, [records]);

  return {
    savedIds, deletedDrafts, sortedNotes, recordsByPage,
    records, setRecords, recordsRef, picked, setPicked, undoRecord, setUndoRecord, unsaved,
    setUnsaved, saving, setSaving, removing, setRemoving, notesLimit, setNotesLimit, noteDrafts,
    setNoteDrafts, draftsRef, unsavedRef, noteAfterSave, annotationWrites, writeCount,
    setWriteCount, noteSaving, setNoteSaving, noteConflicts, setNoteConflicts,
    annotationChangeEpoch,
  };
}

type Inputs = Pick<ReaderSnapshot,
  "annotationChangeEpoch" | "annotationWrites" | "color" | "documentSession" |
  "documentSessionRef" | "draftsRef" | "fallbackNotes" | "key" | "locked" | "noteAfterSave" |
  "opened" | "paperDoi" | "records" | "recordsRef" | "removing" | "saving" | "setError" |
  "setNoteConflicts" | "setNoteDrafts" | "setNoteSaving" | "setNotesLimit" | "setNotesOpen" |
  "setPicked" | "setRecords" | "setRemoving" | "setSaving" | "setSelection" |
  "setUndoRecord" | "setUnsaved" | "setWriteCount" | "supportsSidebar" | "t" | "undoRecord" |
  "unsaved" | "unsavedRef"
>;

export function useAnnotations(
  state: Inputs,
  actions: ReaderActionsRef<"tell">,
) {
  const {
    annotationChangeEpoch, annotationWrites, color, documentSession, documentSessionRef,
    draftsRef, fallbackNotes, key, locked, noteAfterSave, opened, paperDoi, records,
    recordsRef, removing, saving, setError, setNoteConflicts, setNoteDrafts, setNoteSaving,
    setNotesLimit, setNotesOpen, setPicked, setRecords, setRemoving, setSaving, setSelection,
    setUndoRecord, setUnsaved, setWriteCount, supportsSidebar, t, undoRecord, unsaved,
    unsavedRef,
  } = state;

  // Remote deletion must reach pending save callbacks before React renders.
  function updateRecords(next: PdfAnnotation[] | ((current: PdfAnnotation[]) => PdfAnnotation[])) {
    const values = typeof next === "function" ? next(recordsRef.current) : next;
    const ids = new Set(values.map((record) => record.id));
    for (const record of recordsRef.current) {
      const draft = draftsRef.current[record.id];
      if (draft && dirtyDraft(draft) && !ids.has(record.id)) {
        setNotesOpen(true);
        break;
      }
    }
    recordsRef.current = values;
    setRecords(values);
  }

  function updateDraft(id: string, draft?: PdfNoteDraft, resolveConflict = false) {
    const next = { ...draftsRef.current };
    if (draft) next[id] = draft;
    else delete next[id];
    draftsRef.current = next;
    setNoteDrafts(next);
    if (!draft || resolveConflict) setNoteConflicts((current) => ({ ...current, [id]: false }));
  }

  async function trackWrite<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    annotationWrites.current.add(pending);
    setWriteCount(annotationWrites.current.size);
    try {
      return await pending;
    } finally {
      annotationWrites.current.delete(pending);
      setWriteCount(annotationWrites.current.size);
    }
  }

  const refresh = useCallback(async (): Promise<void> => {
    if (!key) return;
    const active = documentSession;
    const epoch = annotationChangeEpoch.current;
    try {
      const all = await request<Annotation[]>({
        type: "annotations.list",
        pageUrl: key,
      });
      if (active !== documentSessionRef.current) return;
      if (epoch !== annotationChangeEpoch.current) return refresh();
      updateRecords(all.filter(isPdf));
    } catch (cause) {
      if (active !== documentSessionRef.current) return;
      if (epoch !== annotationChangeEpoch.current) return refresh();
      setError(errorText(cause));
    }
  }, [key, documentSession]);

  useEffect(() => {
    if (!key) return;
    const active = documentSession;
    const listener = (m: {
      type?: string;
      pageUrl?: string;
      annotation?: Annotation;
      deletedId?: string;
    }) => {
      if (active !== documentSessionRef.current) return;
      if (
        m.type === "annotations.changed" &&
        (!m.pageUrl || m.pageUrl === key)
      ) {
        annotationChangeEpoch.current++;
        if (m.annotation && isPdf(m.annotation)) {
          const changed = m.annotation;
          updateRecords((old) =>
            [...old.filter((r) => r.id !== changed.id), changed].sort(
              (a, b) => a.target.pageNumber - b.target.pageNumber,
            ),
          );
        } else if (m.deletedId)
          updateRecords((old) => old.filter((r) => r.id !== m.deletedId));
        else void refresh();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    // Parsing can outlive the initial snapshot. Subscribe before refreshing,
    // and reject snapshots overtaken by a notification while they were read.
    void refresh();
    return () => releaseChromeListener(() => chrome.runtime.onMessage.removeListener(listener));
  }, [key, documentSession, refresh]);

  useEffect(() => {
    setNotesLimit(50);
  }, [documentSession]);

  async function save(record: PdfAnnotation, editNote = false): Promise<PdfAnnotation> {
    setSaving(true);
    setUnsaved(record);
    unsavedRef.current = record;
    noteAfterSave.current = editNote;
    setError("");
    const active = documentSession;
    return trackWrite(async () => { try {
      const stored = await request<PdfAnnotation>({
        type: "annotations.put",
        annotation: record,
        expectedRevision: record.revision,
      });
      if (active !== documentSessionRef.current) throw new DOMException("Document changed", "AbortError");
      updateRecords((old) => [...old.filter((r) => r.id !== stored.id), stored]);
      setUnsaved(undefined);
      unsavedRef.current = undefined;
      setSelection(undefined);
      getSelection()?.removeAllRanges();
      actions.current.tell(t("已保存到本机", "Saved on this device"));
      if (editNote) {
        setNotesOpen(true);
        if (!supportsSidebar || fallbackNotes) setNotesLimit((limit) => Math.max(limit, records.length + 1));
        updateDraft(stored.id, { note: stored.note, tags: stored.tags.join(", "), color: stored.color, base: stored, editing: true });
      }
      return stored;
    } catch (cause) {
      if (active === documentSessionRef.current) setError(errorText(cause));
      throw cause;
    } finally {
      if (active === documentSessionRef.current) setSaving(false);
    } });
  }

  async function saveNote(id: string, draft: PdfNoteDraft): Promise<void> {
    const deletedMessage = t(
      "原标注已被删除。草稿仅保留在此窗口，请复制内容或放弃草稿后再继续。",
      "The original annotation was deleted. This draft remains in this window; copy its contents or discard it before leaving.",
    );
    if (!recordsRef.current.some((record) => record.id === id)) {
      setNotesOpen(true);
      setError(deletedMessage);
      throw Error(deletedMessage);
    }
    const active = documentSession;
    setNoteSaving(id);
    setError("");
    return trackWrite(async () => { try {
      const stored = await request<PdfAnnotation>({ type: "annotations.put", annotation: {
        ...draft.base, note: draft.note, tags: noteTags(draft.tags), color: draft.color, updatedAt: new Date().toISOString(),
      }, expectedRevision: draft.base.revision });
      if (active !== documentSessionRef.current) return;
      if (!recordsRef.current.some((record) => record.id === id)) throw Error(deletedMessage);
      updateRecords((old) => [...old.filter((record) => record.id !== id), stored]);
      updateDraft(id);
    } catch (cause) {
      if (active === documentSessionRef.current) {
        if (cause instanceof RequestError && cause.code === "CONFLICT") setNoteConflicts((current) => ({ ...current, [id]: true }));
        setError(errorText(cause));
      }
      throw cause;
    } finally {
      if (active === documentSessionRef.current) setNoteSaving(undefined);
    } });
  }

  async function remove(record: PdfAnnotation) {
    if (removing || saving || unsaved || record.pageUrl !== key) return;
    setRemoving(true);
    setError("");
    const active = documentSession;
    try {
      await trackWrite(() => request({
        type: "annotations.delete",
        id: record.id,
        expectedRevision: record.revision,
      }));
      if (active !== documentSessionRef.current) return;
      updateRecords((old) => old.filter((item) => item.id !== record.id));
      setNoteDrafts((current) => {
        const { [record.id]: _removed, ...rest } = current;
        return rest;
      });
      setPicked((current) => (current?.id === record.id ? undefined : current));
      setUndoRecord(record);
      actions.current.tell(t("已移除标注，可撤销。", "Annotation removed. Undo is available."));
    } catch (cause) {
      if (active === documentSessionRef.current) setError(errorText(cause));
    } finally {
      if (active === documentSessionRef.current) setRemoving(false);
    }
  }

  async function restoreRemoved() {
    if (
      !undoRecord ||
      removing ||
      saving ||
      unsaved ||
      undoRecord.pageUrl !== key
    )
      return;
    setRemoving(true);
    setError("");
    const active = documentSession;
    try {
      const restored = await trackWrite(() => request<PdfAnnotation>({
        type: "annotations.restore",
        annotation: { ...undoRecord, updatedAt: new Date().toISOString() },
      }));
      if (active !== documentSessionRef.current) return;
      updateRecords((old) => [
        ...old.filter((item) => item.id !== restored.id),
        restored,
      ]);
      setUndoRecord(undefined);
      actions.current.tell(t("标注已恢复。", "Annotation restored."));
    } catch (cause) {
      if (active === documentSessionRef.current) setError(errorText(cause));
    } finally {
      if (active === documentSessionRef.current) setRemoving(false);
    }
  }

  function mark(
    target: SelectionTarget,
    kind: "pdf-text" | "pdf-area",
    chosen = color,
    editNote = false,
    tags: string[] = [],
  ) {
    if (!opened || !key || locked || annotationWrites.current.size) return;
    const now = new Date().toISOString();
    const recordSource = opened.sourceUrl && isIeeeSessionPage(opened.sourceUrl)
      ? doiUrl(paperDoi) || opened.sourceUrl : opened.sourceUrl;
    const pdfTarget: PdfTarget = {
      ...target,
      documentHash: opened.hash,
      fileName: opened.fileName,
      ...(recordSource ? { sourceUrl: recordSource } : {}),
    };
    void save({
      id: crypto.randomUUID(),
      pageUrl: key,
      pageTitle: opened.fileName,
      color: chosen,
      note: "",
      tags,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      kind,
      target: pdfTarget,
    }, editNote).catch(() => undefined);
  }
  return {
    updateRecords, updateDraft, trackWrite, refresh, save, saveNote, remove, restoreRemoved,
    mark,
  };
}
