import type { PdfNoteDraft } from "../../core/sidebar";
import { errorText, type PdfAnnotation, type SelectionTarget } from "../../core/pdf-types";
import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { request, RequestError, releaseChromeListener } from "../../core/client";
import { type Annotation, type PdfTarget } from "../../core/model";
import { isIeeeSessionPage } from "../../core/pdf-context";
import { doiUrl } from "../paper-identity";
import { isPdf, noteTags, dirtyDraft, type ReaderSnapshot, type ReaderActionsRef } from "./contracts";

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
  const deletedDrafts = useMemo(() => Object.values(noteDrafts).filter(
    (draft) => dirtyDraft(draft) && !savedIds.has(draft.base.id),
  ), [noteDrafts, savedIds]);
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
  "annotationChangeEpoch" | "annotationWrites" | "color" | "documentSession" | "documentSessionRef" | "draftsRef" | "fallbackNotes" | "key" | "locked" | "noteAfterSave" | "opened" | "paperDoi" | "records" | "recordsRef" | "removing" | "saving" |
  "setError" | "setNoteConflicts" | "setNoteDrafts" | "setNoteSaving" | "setNotesLimit" | "setNotesOpen" | "setPicked" | "setRecords" | "setRemoving" | "setSaving" | "setSelection" | "setUndoRecord" | "setUnsaved" | "setWriteCount" | "supportsSidebar" | "t" | "undoRecord" |
  "unsaved" | "unsavedRef"> & Partial<Pick<ReaderSnapshot, "previousHash">>;

export function useAnnotations(state: Inputs, actions: ReaderActionsRef<"tell">,) {
  const { annotationChangeEpoch, annotationWrites, color, documentSession, documentSessionRef, draftsRef, fallbackNotes, key, locked,
    noteAfterSave, opened, paperDoi, previousHash, recordsRef, removing, saving, setError, setNoteConflicts, setNoteDrafts, setNoteSaving, setNotesLimit,
    setNotesOpen, setPicked, setRecords, setRemoving, setSaving, setSelection, setUndoRecord, setUnsaved, setWriteCount, supportsSidebar, t, undoRecord, unsaved, unsavedRef, } = state;
  // Remote deletion must reach pending save callbacks before React renders.
  const updateRecords = useCallback((next: PdfAnnotation[] | ((current: PdfAnnotation[]) => PdfAnnotation[])) => {
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
  }, [recordsRef, draftsRef, setNotesOpen, setRecords]);
  const updateDraft = useCallback((id: string, draft?: PdfNoteDraft, resolveConflict = false) => {
    if (documentSession !== documentSessionRef.current) return;
    const next = { ...draftsRef.current };
    if (draft) next[id] = draft;
    else delete next[id];
    draftsRef.current = next;
    setNoteDrafts(next);
    if (!draft || resolveConflict) setNoteConflicts((current) => ({ ...current, [id]: false }));
  }, [documentSession, documentSessionRef, draftsRef, setNoteDrafts, setNoteConflicts]);
  const trackWrite = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const pending = operation();
    annotationWrites.current.add(pending);
    setWriteCount(annotationWrites.current.size);
    try {
      return await pending;
    } finally {
      annotationWrites.current.delete(pending);
      setWriteCount(annotationWrites.current.size);
    }
  }, [annotationWrites, setWriteCount]);
  const refresh = useCallback(async (): Promise<void> => {
    if (!key || documentSession !== documentSessionRef.current) return;
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
  }, [key, documentSession, documentSessionRef, annotationChangeEpoch, updateRecords, setError]);
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
  const save = useCallback(async (record: PdfAnnotation, editNote = false): Promise<PdfAnnotation> => {
    if (documentSession !== documentSessionRef.current) throw new DOMException("Document changed", "AbortError");
    setSaving(true);
    setUnsaved(record);
    unsavedRef.current = record;
    noteAfterSave.current = editNote;
    setError("");
    const active = documentSession;
    const notesCount = recordsRef.current.length;
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
        if (!supportsSidebar || fallbackNotes) setNotesLimit((limit) => Math.max(limit, notesCount + 1));
        updateDraft(stored.id, { note: stored.note, tags: stored.tags.join(", "), color: stored.color, base: stored, editing: true });
      }
      return stored;
    } catch (cause) {
      if (active === documentSessionRef.current) setError(errorText(cause));
      throw cause;
    } finally {
      if (active === documentSessionRef.current) setSaving(false);
    } });
  }, [documentSession, documentSessionRef, trackWrite, updateRecords, updateDraft, setSaving, setUnsaved, unsavedRef,
    noteAfterSave, setError, setSelection, actions, t, setNotesOpen, supportsSidebar, fallbackNotes, setNotesLimit, recordsRef,]);
  const saveNote = useCallback(async (id: string, draft: PdfNoteDraft): Promise<void> => {
    if (documentSession !== documentSessionRef.current) throw new DOMException("Document changed", "AbortError");
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
  }, [documentSession, documentSessionRef, recordsRef, t, setNotesOpen, setError, setNoteSaving, trackWrite, updateRecords, updateDraft, setNoteConflicts,]);
  const remove = useCallback(async (record: PdfAnnotation) => {
    if (documentSession !== documentSessionRef.current || removing || saving || unsaved || record.pageUrl !== key) return;
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
  }, [documentSession, documentSessionRef, removing, saving, unsaved, key, setRemoving, setError, trackWrite, updateRecords, setNoteDrafts, setPicked, setUndoRecord, actions, t,]);
  const restoreRemoved = useCallback(async () => {
    if (
      documentSession !== documentSessionRef.current ||
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
  }, [documentSession, documentSessionRef, undoRecord, removing, saving, unsaved, key, setRemoving, setError, trackWrite, updateRecords, setUndoRecord, actions, t,]);
  const mark = useCallback((
    target: SelectionTarget,
    kind: "pdf-text" | "pdf-area",
    chosen = color,
    editNote = false,
    tags: string[] = [],
  ) => {
    if (documentSession !== documentSessionRef.current || !opened || !key || locked || annotationWrites.current.size) return;
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
  }, [documentSession, documentSessionRef, opened, key, locked, annotationWrites, color, paperDoi, save]);
  const copyPrevious = useCallback(async (old: PdfAnnotation, target: SelectionTarget): Promise<void> => {
    const active = documentSession;
    if (!opened || !key || !previousHash || old.target.documentHash !== previousHash ||
      old.pageUrl !== `urn:web-ink:pdf:${previousHash}` || previousHash === opened.hash ||
      active !== documentSessionRef.current || locked || unsavedRef.current || annotationWrites.current.size)
      throw Error(t("当前文档或标注状态已改变，请重新选择。", "The document or annotation state changed. Select it again."));
    await trackWrite(async () => {
      const latest = await request<Annotation | null>({ type: "annotations.get", id: old.id });
      if (!latest || !isPdf(latest) || latest.kind !== old.kind || latest.revision !== old.revision ||
        latest.pageUrl !== old.pageUrl || active !== documentSessionRef.current ||
        unsavedRef.current || annotationWrites.current.size > 1)
        throw Error(t("旧标注或文档已改变，请重新打开旧标注。", "The previous annotation or document changed. Open it again."));
      const recordSource = opened.sourceUrl && isIeeeSessionPage(opened.sourceUrl)
        ? doiUrl(paperDoi) || opened.sourceUrl : opened.sourceUrl;
      const copiedAt = new Date().toISOString();
      await save({
        ...latest,
        id: crypto.randomUUID(),
        pageUrl: key,
        pageTitle: opened.fileName,
        createdAt: copiedAt,
        updatedAt: copiedAt,
        revision: 0,
        target: { ...target, documentHash: opened.hash, fileName: opened.fileName,
          ...(recordSource ? { sourceUrl: recordSource } : {}) },
      });
    });
  }, [documentSession, documentSessionRef, opened, key, previousHash, locked, unsavedRef,
    annotationWrites, paperDoi, trackWrite, save, t]);
  return {
    updateRecords, updateDraft, trackWrite, refresh, save, saveNote, remove, restoreRemoved,
    mark, copyPrevious,
  };
}
