import { useLayoutEffect, useRef, useState } from "react";
import { useLibraryContext } from "../contexts/ManagementContext";
import { AnnotationBrowser, Empty, FilterPopover } from "../management/components";
import { Icon } from "../management/helpers";
import type { PdfActions } from "../hooks/usePdfActions";

export function LibraryScreen({ visible, openPdf }: {
  visible: boolean;
  openPdf: PdfActions["openPdf"];
}) {
  const { language, t, annotations } = useLibraryContext();
  const { records, nextCursor, loading, loadRecords, query, setQuery, kind, setKind,
    color, setColor, tag, setTag, filterOpen, setFilterOpen, filterCount,
    selectedId, setSelectedId, editing, setEditing, drafts, conflicts,
    startEdit, updateDraft, saveRecord, loadLatest, removeRecord } = annotations;
  const [libraryDetail, setLibraryDetail] = useState(false);
  const libraryScrollY = useRef<number | undefined>(undefined);
  const openLibraryDetail = (id: string) => {
    if (window.innerWidth <= 699) libraryScrollY.current = window.scrollY;
    setSelectedId(id);
    setLibraryDetail(true);
  };
  const closeLibraryDetail = () => {
    setLibraryDetail(false);
  };
  useLayoutEffect(() => {
    const top = libraryScrollY.current;
    if (libraryDetail || top === undefined) return;
    libraryScrollY.current = undefined;
    window.scrollTo({ top, behavior: "auto" });
  }, [libraryDetail]);
  if (!visible) return null;
  return (
    <section className="library-shell">
      <div className="library-tools">
        <label className="search">
          <Icon name="search" />
          <input
            aria-label={t.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.search}
          />
        </label>
        <button
          className={filterOpen ? "quiet selected" : "quiet"}
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((value) => !value)}
        >
          <Icon name="filter" />
          {t.filter}
          {filterCount ? (
            <span className="filter-count">{filterCount}</span>
          ) : null}
        </button>
        {filterOpen ? (
          <FilterPopover
            language={language}
            t={t}
            kind={kind}
            color={color}
            tag={tag}
            records={records}
            setKind={setKind}
            setColor={setColor}
            setTag={setTag}
            clear={() => {
              setKind("all");
              setColor("");
              setTag("");
            }}
          />
        ) : null}
      </div>
      {records.length ? <AnnotationBrowser
        detailOpen={libraryDetail}
        onBack={closeLibraryDetail}
        records={records}
        selectedId={selectedId}
        setSelectedId={openLibraryDetail}
        states={{}}
        language={language}
        t={t}
        editing={editing}
        drafts={drafts}
        conflicts={conflicts}
        onEdit={startEdit}
        onDraft={updateDraft}
        onSave={saveRecord}
        onLoadLatest={loadLatest}
        onCancel={() => setEditing(undefined)}
        onDelete={removeRecord}
        onFocus={() => undefined}
        onRebind={() => undefined}
        onOpenPdf={openPdf}
      /> : null}
      {!records.length && !loading ? (
        <Empty
          title={query || filterCount ? t.noResults : t.libraryEmptyTitle}
          text={query || filterCount ? "" : t.libraryEmptyText}
        />
      ) : null}
      {loading ? (
        <p className="loading" role="status">
          {t.loading}
        </p>
      ) : null}
      {nextCursor && !loading ? (
        <button
          className="load-more"
          onClick={() => void loadRecords(true, nextCursor)}
        >
          {t.loadMore}
        </button>
      ) : null}
    </section>
  );
}
