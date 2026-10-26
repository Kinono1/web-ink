import { useEffect, useState } from "react";
import { request, releaseChromeListener } from "../../core/client";
import type { Annotation, AnnotationPage, Language } from "../../core/model";
import { COPY } from "../management/copy";
import { tagText, parseTags, matchesQuery } from "../management/helpers";
import type { Draft, FilterKind, Mode, NoticeMessage } from "../management/types";
import { useAnnotationQuery } from "../management/useAnnotationQuery";

export function useAnnotationSync({ mode, pageUrl, language, setError, setNotice }: {
  mode: Mode;
  pageUrl?: string;
  language: Language;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}) {
  const t = COPY[language];
  const [query, setQuery] = useState("");
  const [libraryDocument, setLibraryDocument] = useState(() => {
    const hash = new URLSearchParams(location.search).get("document");
    return mode === "library" && hash && /^[a-f0-9]{64}$/.test(hash) ? `urn:web-ink:pdf:${hash}` : undefined;
  });
  const [kind, setKind] = useState<FilterKind>("all");
  const [color, setColor] = useState("");
  const [tag, setTag] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState<string>();
  const [conflicts, setConflicts] = useState<Record<string, true>>({});
  const { records, setRecords, nextCursor, loading, loadRecords } =
    useAnnotationQuery(
      { mode, pageUrl: mode === "library" ? libraryDocument : pageUrl, kind, color, tag, query },
      setError,
      (items) =>
        setSelectedId((current) =>
          current && items.some((item) => item.id === current)
            ? current
            : undefined,
        ),
    );

  useEffect(() => {
    const listener = (message: NoticeMessage) => {
      if (message.type !== "annotations.changed") return;
      if (message.deletedId) {
        setRecords((current) =>
          current.filter((record) => record.id !== message.deletedId),
        );
        return;
      }
      if (message.annotation) {
        const active = {
          pageUrl: mode === "sidepanel" ? pageUrl : undefined,
          kind,
          color,
          tag,
          text: query,
        };
        if (!matchesQuery(message.annotation, active)) {
          setRecords((current) =>
            current.filter((record) => record.id !== message.annotation!.id),
          );
          return;
        }
        void loadRecords();
        return;
      }
      void loadRecords();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      releaseChromeListener(() => chrome.runtime.onMessage.removeListener(listener));
    };
  }, [color, kind, loadRecords, mode, pageUrl, query, tag]);
  const startEdit = (record: Annotation) => {
    setEditing(record.id);
    setDrafts((current) => ({
      ...current,
      [record.id]: current[record.id] ?? {
        note: record.note,
        tags: tagText(record.tags),
        color: record.color,
        base: record,
      },
    }));
  };
  const updateDraft = (
    id: string,
    patch: Pick<Partial<Draft>, "note" | "tags" | "color">,
  ) =>
    setDrafts((current) =>
      current[id]
        ? { ...current, [id]: { ...current[id], ...patch } }
        : current,
    );
  const saveRecord = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    try {
      const candidate: Annotation = {
        ...draft.base,
        note: draft.note,
        tags: parseTags(draft.tags),
        color: draft.color,
        updatedAt: new Date().toISOString(),
      };
      const saved = await request<Annotation>({
        type: "annotations.put",
        annotation: candidate,
        expectedRevision: draft.base.revision,
      });
      setRecords((current) =>
        current.map((item) => (item.id === saved.id ? saved : item)),
      );
      setDrafts((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
      setConflicts((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
      setEditing(undefined);
      setNotice(t.updated);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/changed in another tab|CONFLICT/i.test(message)) {
        setConflicts((current) => ({ ...current, [id]: true }));
        setError(t.conflict);
        void loadRecords();
      } else setError(message);
    }
  };
  const loadLatest = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    try {
      const latest = await request<AnnotationPage>({
        type: "annotations.query",
        query: {
          ...(mode === "sidepanel" && pageUrl ? { pageUrl } : {}),
          text: "",
          limit: 50,
          requestId: crypto.randomUUID(),
        },
      });
      const record = latest.items.find((item) => item.id === id);
      if (!record)
        throw new Error(
          language === "zh-CN"
            ? "标注已被删除。"
            : "The annotation was deleted.",
        );
      setRecords((current) =>
        current.map((item) => (item.id === id ? record : item)),
      );
      setDrafts((current) =>
        current[id]
          ? { ...current, [id]: { ...current[id], base: record } }
          : current,
      );
      setConflicts((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const removeRecord = async (record: Annotation): Promise<boolean> => {
    try {
      await request<{ id: string; deleted: true }>({
        type: "annotations.delete",
        id: record.id,
        expectedRevision: record.revision,
      });
      setRecords((current) => current.filter((item) => item.id !== record.id));
      if (selectedId === record.id) setSelectedId(undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  const selectionSaved = (annotation: Annotation, startEditing: boolean) => {
    setRecords((current) => current.some((record) => record.id === annotation.id)
      ? current.map((record) => record.id === annotation.id ? annotation : record)
      : [annotation, ...current]);
    setSelectedId(annotation.id);
    if (startEditing) startEdit(annotation);
    void loadRecords();
  };
  const filterCount = Number(kind !== "all") + Number(Boolean(color)) + Number(Boolean(tag));
  const showAllDocuments = () => {
    setLibraryDocument(undefined);
    const url = new URL(location.href);
    url.searchParams.delete("document");
    history.replaceState(null, "", url.href);
  };
  return {
    records, nextCursor, loading, loadRecords,
    query, setQuery, kind, setKind, color, setColor, tag, setTag,
    filterOpen, setFilterOpen, filterCount, libraryDocument, showAllDocuments,
    selectedId, setSelectedId, editing, setEditing, drafts, conflicts,
    startEdit, updateDraft, saveRecord, loadLatest, removeRecord, selectionSaved,
  };
}
