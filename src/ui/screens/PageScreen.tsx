import { useCallback, useEffect, useRef, useState } from "react";
import { PdfSidebar } from "../PdfSidebar";
import { WebSelection } from "../WebSelection";
import { pdfPreparationLabel } from "../../pdf/public";
import { toMarkdown } from "../../core/backup";
import { request } from "../../core/client";
import type { Annotation } from "../../core/model";
import { useManagementContext } from "../contexts/ManagementContext";
import { useTabContext } from "../contexts/TabContext";
import { isPdfSurface } from "../hooks/useTabObserver";
import type { PdfActions } from "../hooks/usePdfActions";
import { AnnotationBrowser, Empty, PageHeader, SelectionToolbarSwitch } from "../management/components";
import { download, Icon } from "../management/helpers";

export function PageScreen({ visible, pdf }: { visible: boolean; pdf: PdfActions }) {
  const { preferences, annotations, setError, setNotice } = useManagementContext();
  const { settings, language, t, setOriginPaused, selectionToolbarEnabled,
    selectionToolbarSaving, toggleSelectionToolbar } = preferences;
  const { records, nextCursor, loading, loadRecords, selectionSaved } = annotations;
  const { tab, pdfContext, pageUrl, pageEnabled, states, selectionConnectionVersion,
    pageToggling, toggleCurrentPage, pageAction, refreshContext, activeDocument } = useTabContext();
  const { openingPdf, preparationStage, isIeeeSession, ieeeCandidates, publicCandidates,
    openCurrentPdf, openIeeeSessionPdf, openLocalPdf, openLibrary, openPdf, cancelCurrentPdf } = pdf;
  const origin = pageUrl ? new URL(pageUrl).origin : undefined;
  const paused = Boolean(origin && settings.disabledOrigins.includes(origin));
  const [moreOpen, setMoreOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
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
      if (moreOpen && !moreMenu.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closeMore, moreOpen]);
  const exportPage = async () => {
    if (!pageUrl || exporting) return;
    const current = activeDocument.current;
    if (tab.id === undefined || !tab.url || current.id !== tab.id || current.url !== tab.url) {
      setError(t.exportPageChanged);
      return;
    }
    const version = current.version;
    setExporting(true);
    setNotice(undefined);
    try {
      const saved = await request<Annotation[]>({ type: "annotations.list", pageUrl });
      if (activeDocument.current.version !== version) {
        setError(t.exportPageChanged);
      } else if (!saved.length) {
        setNotice(t.exportPageEmpty);
      } else {
        download("web-ink-page-annotations.md", toMarkdown(saved), "text/markdown;charset=utf-8");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  };
  if (!visible) return null;
  const host = pageUrl ? new URL(pageUrl).host : undefined;
  const candidates = pdfContext?.candidates ?? [];
  const primaryLabel = openingPdf
    ? isIeeeSession ? pdfPreparationLabel(preparationStage, language) : t.openingPdf
    : isIeeeSession ? t.openIeeeSessionPdf : t.openCurrentPdf;
  const openCandidate = (url?: string) =>
    isIeeeSession ? void openIeeeSessionPdf(url) : openCurrentPdf(url);
  const primaryButton = (
    <button className="primary pdf-open-current" disabled={openingPdf}
      onClick={() => openCandidate(isIeeeSession ? ieeeCandidates[0]?.url : candidates[0]?.url)}>
      <Icon name="pdf" />{primaryLabel}
    </button>
  );
  const sourceChoices = (choices: { url: string; label: string; open: () => void }[]) => (
    <div className="pdf-source-choices" aria-label={t.choosePdfSource}>
      {choices.map((choice) => (
        <button className="quiet pdf-source-choice" disabled={openingPdf} key={choice.url} onClick={choice.open}>
          {choice.label}
        </button>
      ))}
    </div>
  );
  return (
    <>
      {pageUrl ? <PageHeader title={tab.title || host!} host={host} enabled={pageEnabled}
        onToggle={toggleCurrentPage} toggleLabel={t.showAnnotations} scopeLabel={t.pageScope}
        disabled={paused || pageToggling} pending={pageToggling} /> : null}
      <div className="sidepanel-content">
        {pageUrl && !paused ? <SelectionToolbarSwitch enabled={selectionToolbarEnabled}
          saving={selectionToolbarSaving} onToggle={() => void toggleSelectionToolbar()} t={t} /> : null}
        {pageUrl && !paused ? <WebSelection tabId={tab.id} pageUrl={pageUrl} language={language}
          defaultColor={settings.defaultColor} connectionKey={selectionConnectionVersion}
          onError={setError} onSaved={selectionSaved} /> : null}
        {pdfContext?.currentReader ? <PdfSidebar tabId={tab.id} language={language} /> : !pageUrl && isPdfSurface(pdfContext) ? (
          <section className="pdf-handoff">
            <span className="pdf-handoff-icon" aria-hidden="true"><Icon name="pdf" /></span>
            <h2>{pdfContext ? t.currentPdfTitle : t.pdfWelcomeTitle}</h2>
            <p>{isPdfSurface(pdfContext) ? t.currentPdfText : t.pdfFallbackText}</p>
            {tab.title ? <span className="pdf-document-name" title={tab.title}>{tab.title}</span> : null}
            {isIeeeSession ? <>
              {ieeeCandidates.length > 1
                ? sourceChoices(ieeeCandidates.map((candidate) => ({ url: candidate.url,
                    label: `${t.openIeeeSessionPdf}: ${candidate.url}`,
                    open: () => void openIeeeSessionPdf(candidate.url) })))
                : primaryButton}
              {sourceChoices(publicCandidates.map((candidate) => ({ url: candidate.url,
                label: candidate.url, open: () => openCurrentPdf(candidate.url) })))}
            </> : candidates.length > 1
              ? sourceChoices(candidates.map((candidate) => ({ url: candidate.url,
                  label: candidate.url, open: () => openCandidate(candidate.url) })))
              : primaryButton}
            {openingPdf && isIeeeSession && (
              <button className="quiet" onClick={cancelCurrentPdf}>
                {language === "zh-CN" ? "取消读取" : "Cancel reading"}
              </button>
            )}
            {pdfContext?.candidates.length !== undefined && pdfContext.candidates.length <= 1 ? (
              <button className="quiet pdf-local-link" onClick={openLocalPdf}>{t.chooseLocalPdf}</button>
            ) : null}
            <small>{t.pdfLocalNote}</small>
          </section>
        ) : !pageUrl ? (
          <Empty title={t.unknownPage} text={t.pageUnavailableText}
            action={<div className="unavailable-actions">
              <button className="quiet" onClick={() => void refreshContext()}>{t.refresh}</button>
              <button className="quiet" onClick={openLibrary}>{t.openLibrary}</button>
              <button className="quiet" onClick={openLocalPdf}>{t.chooseLocalPdf}</button>
            </div>} />
        ) : paused ? (
          <section className="notice-card warning">
            <strong>{t.paused}</strong>
            <button className="quiet" onClick={() => setOriginPaused(origin, false)}>{t.resume}</button>
            <button className="quiet" disabled={exporting} onClick={() => void exportPage()}>{t.exportPage}</button>
          </section>
        ) : null}
        {pageUrl && !paused && records.length > 0 ? (
          <AnnotationBrowser compact annotations={annotations} states={states} language={language} t={t}
            onFocus={(record) => void pageAction("focus", record.id)}
            onRebind={(record) => void pageAction("rebind", record.id)}
            onOpenPdf={openPdf} />
        ) : null}
        {nextCursor && !loading && pageUrl && !paused ? (
          <button className="load-more" onClick={() => void loadRecords(true, nextCursor)}>{t.loadMore}</button>
        ) : null}
        {pageUrl && !records.length && !loading && !paused
          ? <Empty title={t.pageEmptyTitle} text={t.pageEmptyText} icon="draw" /> : null}
        {loading && pageUrl && !paused ? <p className="loading" role="status">{t.loading}</p> : null}
      </div>
      {pageUrl && !paused ? (
        <footer className="sidepanel-dock" aria-label={t.pageAnnotations}>
          <button className="quiet dock-draw" disabled><Icon name="draw" />{t.drawImage} · {t.comingSoon}</button>
          <details ref={moreMenu} className="menu" open={moreOpen}
            onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
            <summary ref={moreTrigger} aria-label={t.moreActions} title={t.moreActions}><Icon name="more" /></summary>
            <div className="sidepanel-more-actions">
              <button className="quiet" disabled={exporting} onClick={() => { closeMore(); void exportPage(); }}>
                {t.exportPage}
              </button>
              <button className="quiet" onClick={openLibrary}>{t.openLibrary}</button>
              <button className="quiet" onClick={openLocalPdf}>{t.chooseLocalPdf}</button>
              <button className="danger" onClick={() => setOriginPaused(origin, true)}>{t.pause}</button>
            </div>
          </details>
        </footer>
      ) : null}
    </>
  );
}
