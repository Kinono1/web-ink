import { useMemo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { RequestError, request, releaseChromeListener } from "../../core/client";
import type { Annotation, Language, PdfOpenResult, PdfTabContext } from "../../core/model";
import {
  ieeeFailureMessage,
  readPdfPaperIdentity,
  rememberPdfPaperReopen,
  type IeeePdfDiagnostic,
} from "../../pdf/public";
import { COPY } from "../management/copy";
import { isPdf, pdfReaderUrl } from "../management/helpers";
import { openPdfTab } from "../management/openPdf";
import type { Mode, NoticeMessage, TabContext } from "../management/types";

export function usePdfActions({
  mode, tab, pdfContext, activeDocument, documentVersion, language, setError,
}: {
  mode: Mode;
  tab: TabContext;
  pdfContext?: PdfTabContext;
  activeDocument: RefObject<{ version: number }>;
  documentVersion: number;
  language: Language;
  setError: (message: string) => void;
}) {
  const [openingPdf, setOpeningPdf] = useState(false);
  const [preparationStage, setPreparationStage] = useState<string>();
  const [pdfActionError, setPdfActionError] = useState<string>();
  const [ieeeDiagnostic, setIeeeDiagnostic] = useState<IeeePdfDiagnostic>();
  const pdfOpenPending = useRef(false);
  const t = COPY[language];
  // The observer increments its ref synchronously; this clears displayed errors
  // before paint while pending action completions still check the same ref.
  useLayoutEffect(() => {
    setPdfActionError(undefined);
    setIeeeDiagnostic(undefined);
  }, [documentVersion]);
  useEffect(() => {
    const listener = (message: NoticeMessage) => {
      if (
        message.type === "pdf.preparation.changed" &&
        mode === "sidepanel" && message.tabId === tab.id && pdfOpenPending.current
      )
        setPreparationStage(message.stage ?? message.diagnostic?.phase);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      releaseChromeListener(() => chrome.runtime.onMessage.removeListener(listener));
    };
  }, [mode, tab.id]);
  return useMemo(() => {
    const showPdf = async (record?: Annotation) => {
      if (pdfOpenPending.current) return;
      pdfOpenPending.current = true;
      setOpeningPdf(true);
      try {
        const identity = record && isPdf(record)
          ? await readPdfPaperIdentity(record.target.documentHash, record.target.sourceUrl)
          : undefined;
        const url = pdfReaderUrl(chrome.runtime.getURL("/pdf.html"), record, identity);
        const tabId = await openPdfTab(url);
        if (record && isPdf(record) && new URL(url).protocol === "https:")
          await rememberPdfPaperReopen(record.target, identity?.doi, tabId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pdfOpenPending.current = false;
        setOpeningPdf(false);
      }
    };
    const openCurrentPdf = (candidateUrl?: string, accessMode?: "site-session") => {
      if (tab.id === undefined || pdfContext?.currentReader || pdfOpenPending.current)
        return;
      pdfOpenPending.current = true;
      setOpeningPdf(true);
      setPdfActionError(undefined);
      const expectedDocument = activeDocument.current.version;
      setPreparationStage("identify");
      setIeeeDiagnostic(undefined);
      void request<PdfOpenResult>({
        type: "pdf.openCurrent",
        tabId: tab.id,
        ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
        ...(tab.url ? { expectedUrl: tab.url } : {}),
        ...(candidateUrl ? { candidateUrl } : {}),
        ...(accessMode ? { accessMode } : {}),
      })
        .catch((cause) => {
          if (expectedDocument !== activeDocument.current.version) return;
          const message = cause instanceof Error ? cause.message : String(cause);
          setPdfActionError(
            cause instanceof RequestError && cause.code
              ? ieeeFailureMessage(cause.code, language) ?? message
              : `${message} ${t.refreshPdfHint}`,
          );
          if (cause instanceof RequestError) setIeeeDiagnostic(cause.diagnostic);
        })
        .finally(() => {
          pdfOpenPending.current = false;
          setOpeningPdf(false);
          setPreparationStage(undefined);
        });
    };
    const openIeeeSessionPdf = async (candidateUrl?: string) => {
      const origin = { origins: ["https://ieeexplore.ieee.org/*"] };
      try {
        const granted = await chrome.permissions.contains(origin);
        if (granted || await chrome.permissions.request(origin)) {
          openCurrentPdf(candidateUrl, "site-session");
          return;
        }
      } catch {
        // A revoked extension context is handled as a denied IEEE host grant.
      }
      setError(t.ieeePermissionDenied);
    };
    const openLocalPdf = () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL("pdf.html?open=local") }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    const openLibrary = () => {
      window.open(chrome.runtime.getURL("library.html"));
    };
    const openPdf = (record?: Annotation) => {
      void showPdf(record);
    };
    const showHeaderPdfAction =
      !pdfContext?.currentReader && (!pdfContext || pdfContext.candidates.length <= 1);
    const isIeeeSession = pdfContext?.publisher === "ieee";
    const isIeeeCandidate = (candidate: PdfTabContext["candidates"][number]) => {
      const url = new URL(candidate.url);
      return url.origin === "https://ieeexplore.ieee.org" && !url.username && !url.password;
    };
    const ieeeCandidates = isIeeeSession
      ? pdfContext?.candidates.filter(isIeeeCandidate) ?? []
      : [];
    const publicCandidates = isIeeeSession
      ? pdfContext?.candidates.filter(candidate => !isIeeeCandidate(candidate)) ?? []
      : [];
    const cancelCurrentPdf = () => {
      void request({
        type: "pdf.cancelCurrent", tabId: tab.id,
        ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
        ...(tab.url ? { expectedUrl: tab.url } : {}),
      }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    };
    return {
      openingPdf,
      preparationStage,
      pdfActionError,
      setPdfActionError,
      ieeeDiagnostic,
      openCurrentPdf,
      openIeeeSessionPdf,
      openLocalPdf,
      openLibrary,
      openPdf,
      showHeaderPdfAction,
      isIeeeSession,
      ieeeCandidates,
      publicCandidates,
      cancelCurrentPdf,
    };
  }, [openingPdf, preparationStage, pdfActionError, ieeeDiagnostic, mode, tab, pdfContext, activeDocument, language, setError]);
}
export type PdfActions = ReturnType<typeof usePdfActions>;
