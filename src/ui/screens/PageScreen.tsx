import { useCallback, useEffect, useRef, useState } from "react";
import { PdfSidebar } from "../PdfSidebar";
import { WebSelection } from "../WebSelection";
import { pdfPreparationLabel } from "../../pdf/ieee-status";
import { useManagementContext } from "../contexts/ManagementContext";
import { useTabContext } from "../contexts/TabContext";
import { isPdfSurface } from "../hooks/useTabObserver";
import type { PdfActions } from "../hooks/usePdfActions";
import { AnnotationBrowser, Empty, PageHeader, SelectionToolbarSwitch } from "../management/components";
import { Icon } from "../management/helpers";

export function PageScreen({ visible, pdf }: { visible: boolean; pdf: PdfActions }) {
  const { preferences, annotations, setError } = useManagementContext();
  const { settings, language, t, setOriginPaused, selectionToolbarEnabled,
    selectionToolbarSaving, toggleSelectionToolbar } = preferences;
  const { records, nextCursor, loading, loadRecords, selectedId, setSelectedId,
    editing, setEditing, drafts, conflicts, startEdit, updateDraft, saveRecord,
    loadLatest, removeRecord, selectionSaved } = annotations;
  const { tab, pdfContext, pageUrl, pageEnabled, states, selectionConnectionVersion,
    toggleCurrentPage, pageAction, refreshContext } = useTabContext();
  const { openingPdf, preparationStage, isIeeeSession, ieeeCandidates, publicCandidates,
    openCurrentPdf, openIeeeSessionPdf, openLocalPdf, openLibrary, openPdf, cancelCurrentPdf } = pdf;
  const origin = pageUrl ? new URL(pageUrl).origin : undefined;
  const paused = Boolean(origin && settings.disabledOrigins.includes(origin));
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenu = useRef<HTMLDetailsElement>(null);
  const moreTrigger = useRef<HTMLElement>(null);
  const closeMore = useCallback(() => {
    setMoreOpen(false);
    moreTrigger.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !moreOpen) return;
      event.preventDefault();
      closeMore();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (moreOpen && !moreMenu.current?.contains(event.target as Node))
        setMoreOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closeMore, moreOpen]);
  if (!visible) return null;
  return (
    <>
      {pageUrl ? <PageHeader
        title={pageUrl ? tab.title || new URL(pageUrl).host : t.unknownPage}
        host={pageUrl ? new URL(pageUrl).host : undefined}
        enabled={pageEnabled}
        onToggle={selectionToolbarEnabled && !paused ? undefined : toggleCurrentPage}
        toggleLabel={t.showAnnotations}
        disabled={!pageUrl || paused}
      /> : null}
      <div className="sidepanel-content">
        {pageUrl && !paused ? <SelectionToolbarSwitch
          enabled={selectionToolbarEnabled}
          saving={selectionToolbarSaving}
          onToggle={() => void toggleSelectionToolbar()}
          t={t}
        /> : null}
        {pageUrl && !paused ? <WebSelection
          tabId={tab.id}
          pageUrl={pageUrl}
          language={language}
          defaultColor={settings.defaultColor}
          connectionKey={selectionConnectionVersion}
          onError={setError}
          onSaved={selectionSaved}
        /> : null}
        {pdfContext?.currentReader ? <PdfSidebar tabId={tab.id} language={language} /> : !pageUrl && isPdfSurface(pdfContext) ? (
          <section className="pdf-handoff">
            <span className="pdf-handoff-icon" aria-hidden="true"><Icon name="pdf" /></span>
            <h2>
              {pdfContext?.currentReader ? t.pdfReading : pdfContext ? t.currentPdfTitle : t.pdfWelcomeTitle}
            </h2>
            <p>
              {pdfContext?.currentReader ? t.pdfReadingText : isPdfSurface(pdfContext) ? t.currentPdfText : t.pdfFallbackText}
            </p>
            {tab.title ? <span className="pdf-document-name" title={tab.title}>{tab.title}</span> : null}
            {pdfContext?.currentReader ? (
              <span className="pdf-reader-status" role="status">{t.pdfReading}</span>
            ) : isIeeeSession ? (
              <>
                {ieeeCandidates.length > 1 ? (
                  <div className="pdf-source-choices" aria-label={t.choosePdfSource}>
                    {ieeeCandidates.map((candidate) => (
                      <button
                        className="quiet pdf-source-choice"
                        disabled={openingPdf}
                        key={candidate.url}
                        onClick={() => void openIeeeSessionPdf(candidate.url)}
                      >
                        {`${t.openIeeeSessionPdf}: ${candidate.url}`}
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    className="primary pdf-open-current"
                    disabled={openingPdf}
                    onClick={() => void openIeeeSessionPdf(ieeeCandidates[0]?.url)}
                  >
                    <Icon name="pdf" />
                    {openingPdf ? pdfPreparationLabel(preparationStage, language) : t.openIeeeSessionPdf}
                  </button>
                )}
                {publicCandidates.map((candidate) => (
                  <button
                    className="quiet pdf-source-choice"
                    disabled={openingPdf}
                    key={candidate.url}
                    onClick={() => openCurrentPdf(candidate.url)}
                  >
                    {candidate.url}
                  </button>
                ))}
              </>
            ) : pdfContext && pdfContext.candidates.length > 1 ? (
              <div className="pdf-source-choices" aria-label={t.choosePdfSource}>
                {pdfContext.candidates.map((candidate) => (
                  <button
                    className="quiet pdf-source-choice"
                    disabled={openingPdf}
                    key={candidate.url}
                    onClick={() => {
                      if (isIeeeSession) void openIeeeSessionPdf(candidate.url);
                      else openCurrentPdf(candidate.url);
                    }}
                  >
                    {isIeeeSession ? `${t.openIeeeSessionPdf}: ${candidate.url}` : candidate.url}
                  </button>
                ))}
              </div>
            ) : (
              <button
                className="primary pdf-open-current"
                disabled={openingPdf}
                onClick={() => {
                  if (isIeeeSession) void openIeeeSessionPdf(ieeeCandidates[0]?.url);
                  else openCurrentPdf(pdfContext?.candidates[0]?.url);
                }}
              >
                <Icon name="pdf" />
                {openingPdf
                  ? isIeeeSession ? pdfPreparationLabel(preparationStage, language) : t.openingPdf
                  : isIeeeSession ? t.openIeeeSessionPdf : t.openCurrentPdf}
              </button>
            )}
            {openingPdf && isIeeeSession && (
              <button className="quiet" onClick={cancelCurrentPdf}>
                {language === "zh-CN" ? "取消读取" : "Cancel reading"}
              </button>
            )}
            {!pdfContext?.currentReader && pdfContext?.candidates.length !== undefined && pdfContext.candidates.length <= 1 ? (
              <button className="quiet pdf-local-link" onClick={openLocalPdf}>{t.chooseLocalPdf}</button>
            ) : null}
            <small>{t.pdfLocalNote}</small>
          </section>
        ) : !pageUrl ? (
          <Empty
            title={t.unknownPage}
            text={t.pageUnavailableText}
            action={<div className="unavailable-actions">
              <button className="quiet" onClick={() => void refreshContext()}>{t.refresh}</button>
              <button className="quiet" onClick={openLibrary}>{t.openLibrary}</button>
              <button className="quiet" onClick={openLocalPdf}>{t.chooseLocalPdf}</button>
            </div>}
          />
        ) : paused ? (
          <section className="notice-card warning">
            <strong>{t.paused}</strong>
            <button
              className="quiet"
              onClick={() => setOriginPaused(origin, false)}
            >
              {t.resume}
            </button>
          </section>
        ) : null}
        {pageUrl && !paused && records.length > 0 ? (
          <AnnotationBrowser
            compact
            records={records}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            states={states}
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
            onFocus={(record) => void pageAction("focus", record.id)}
            onRebind={(record) => void pageAction("rebind", record.id)}
            onOpenPdf={openPdf}
          />
        ) : null}
        {nextCursor && !loading && pageUrl && !paused ? (
          <button
            className="load-more"
            onClick={() => void loadRecords(true, nextCursor)}
          >
            {t.loadMore}
          </button>
        ) : null}
        {pageUrl && !records.length && !loading && !paused ? (
          <Empty title={t.pageEmptyTitle} text={t.pageEmptyText} icon="draw" />
        ) : null}
        {loading && pageUrl && !paused ? (
          <p className="loading" role="status">{t.loading}</p>
        ) : null}
      </div>
      {pageUrl && !paused ? (
        <footer className="sidepanel-dock" aria-label={t.pageAnnotations}>
          <button
            className="quiet dock-draw"
            disabled
          >
            <Icon name="draw" />
            {t.drawImage} · {t.comingSoon}
          </button>
          <details
            ref={moreMenu}
            className="menu"
            open={moreOpen}
            onToggle={(event) => setMoreOpen(event.currentTarget.open)}
          >
            <summary ref={moreTrigger} aria-label={t.moreActions} title={t.moreActions}>
              <Icon name="more" />
            </summary>
            <div className="sidepanel-more-actions">
              <button className="quiet" onClick={openLibrary}>{t.openLibrary}</button>
              <button className="quiet" onClick={openLocalPdf}>{t.chooseLocalPdf}</button>
              <button
                className="danger"
                onClick={() => setOriginPaused(origin, true)}
              >
                {t.pause}
              </button>
            </div>
          </details>
        </footer>
      ) : null}
    </>
  );
}
