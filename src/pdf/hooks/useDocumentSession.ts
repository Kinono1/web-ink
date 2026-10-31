import { NativePdfAnnotations } from "../native-annotations";
import { errorText, type OpenDocument } from "../../core/pdf-types";
import { useEffect, useRef, useState } from "react";
import { request } from "../../core/client";
import { type Annotation, type PdfHandoff } from "../../core/model";
import { pdfHash, pdfSourceUrl, readLocalPdf, readRemotePdf } from "../../core/pdf-source";
import { ieeeSourceUrl, IeeePdfError } from "../ieee";
import { readPreparedPdf } from "../prepared";
import { isIeeeSessionPage, isIeeePdfWrapper } from "../../core/pdf-context";
import { doiUrl, findPreviousPdfVersion, learnPdfPaperIdentity, pdfDisplayName, pdfDoi, readPdfPaperReopen, type PdfMetadataInput, } from "../paper-identity";
import { readPdfReadingPosition, createPdfReadingPositionWriter, type PdfReadingPosition, } from "../reading-position";
import { isPdf, type PositionSession, safeSource, ieeeRecordSource, type ReaderSnapshot, type ReaderActionsRef, } from "./contracts";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
type PdfApiModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type SourceBytes = { api: PdfApiModule; bytes: Uint8Array; hash: string;
  positionRead: Promise<PdfReadingPosition | undefined> };
type OpenedDocument = SourceBytes & { doc: PDFDocumentProxy; all: Annotation[]; metadata: PdfMetadataInput };
type PreparedSource = { remote?: string; ieeeGrant?: PdfHandoff };
/** Owns the one live PDF.js loading task and its source-read AbortController. */
export class PdfSession {
  #generation = 0;
  #abort?: AbortController;
  #task?: PDFDocumentLoadingTask;
  #disposing?: Promise<void>;
  get generation(): number {
    return this.#generation;
  }
  isCurrent(token: number): boolean {
    return token === this.#generation;
  }
  async begin(): Promise<{ token: number; signal: AbortSignal }> {
    const token = ++this.#generation;
    await this.disposeCurrent();
    if (!this.isCurrent(token))
      throw new DOMException("Superseded PDF session.", "AbortError");
    const abort = new AbortController();
    this.#abort = abort;
    return { token, signal: abort.signal };
  }
  setTask(token: number, task: PDFDocumentLoadingTask): void {
    if (!this.isCurrent(token)) {
      void task.destroy();
      return;
    }
    this.#task = task;
  }
  async dispose(): Promise<void> {
    ++this.#generation;
    await this.disposeCurrent();
  }
  async disposeCurrent(): Promise<void> {
    this.#abort?.abort();
    this.#abort = undefined;
    const task = this.#task;
    this.#task = undefined;
    if (!task) return this.#disposing;
    const run = task.destroy().catch(() => undefined);
    this.#disposing = run;
    await run;
    if (this.#disposing === run) this.#disposing = undefined;
  }
}

export function useDocumentSessionState() {
  const [initialParams] = useState(() => new URLSearchParams(location.search));
  const localFileEntry = initialParams.get("open") === "local";
  const handoffToken = initialParams.get("handoff");
  const autoOpenAttempted = useRef(false);
  const [source, setSource] = useState(initialParams.get("source") || "");
  const [opened, setOpened] = useState<OpenDocument>();
  const [paperDoi, setPaperDoi] = useState<string>();
  const [previousHash, setPreviousHash] = useState<string>();
  const [handoff, setHandoff] = useState<PdfHandoff | null>(null);
  const [handoffReady, setHandoffReady] = useState(!handoffToken);
  const [ieeeRecovery, setIeeeRecovery] = useState<"permission" | "retry" | "return">();
  const [busy, setBusy] = useState(false);
  const [documentSession, setDocumentSession] = useState(0);
  const session = useRef(new PdfSession());
  const documentSessionRef = useRef(0);
  return {
    initialParams, localFileEntry, handoffToken, autoOpenAttempted, source, setSource, opened,
    setOpened, paperDoi, setPaperDoi, previousHash, setPreviousHash, handoff, setHandoff,
    handoffReady, setHandoffReady, ieeeRecovery, setIeeeRecovery, busy, setBusy, documentSession,
    setDocumentSession, session, documentSessionRef,
  };
}
type Inputs = Pick<ReaderSnapshot,
  "autoOpenAttempted" | "dimensions" | "documentSessionRef" | "draftsRef" | "exportController" | "focusAttempt" | "handoff" | "handoffReady" | "handoffToken" | "initialParams" | "intentEpoch" | "intrinsicDimensions" | "nativeFocus" |
  "nativeHistory" | "nativeScan" | "originalNotes" | "pendingSearchPosition" | "positionSession" | "recordsRef" | "session" | "setArea" | "setBusy" | "setDocumentSession" | "setError" | "setExportStage" | "setFitWidth" | "setFocusBusy" | "setFocusHint" | "setFocusMode" | "setHandoff" |
  "setHandoffReady" | "setIeeeRecovery" | "setNativeError" | "setNativeFilter" | "setNativeLoading" | "setNativeOffset" | "setNativeProgress" | "setNativeRecords" | "setNoteConflicts" | "setNoteDrafts" | "setNotesOpen" | "setNotice" | "setOpened" | "setPageNumber" |
  "setPageWindow" | "setPaperDoi" | "setPicked" | "setPositionEpoch" | "setPositionError" | "setPreviousHash" | "setRotation" | "setSearchMatch" | "setSelection" | "setShowMarks" | "setSource" | "setSourceOpen" | "setUndoRecord" | "setZoom" | "settingsReady" | "source" | "t">;

export function useDocumentSession(state: Inputs, actions: ReaderActionsRef<"updateRecords">,) {
  const { autoOpenAttempted, dimensions, documentSessionRef, draftsRef, exportController, focusAttempt, handoff, handoffReady, handoffToken,
    initialParams, intentEpoch, intrinsicDimensions, nativeFocus, nativeHistory, nativeScan, originalNotes, pendingSearchPosition,
    positionSession, recordsRef, session, setArea, setBusy, setDocumentSession, setError, setExportStage, setFitWidth, setFocusBusy, setFocusHint,
      setFocusMode, setHandoff, setHandoffReady, setIeeeRecovery, setNativeError, setNativeFilter, setNativeLoading, setNativeOffset,
    setNativeProgress, setNativeRecords, setNoteConflicts, setNoteDrafts, setNotesOpen, setNotice, setOpened, setPageNumber,
      setPageWindow, setPaperDoi, setPicked, setPositionEpoch, setPositionError, setPreviousHash, setRotation, setSearchMatch, setSelection,
    setShowMarks, setSource, setSourceOpen, setUndoRecord, setZoom, settingsReady, source, t, } = state;
  useEffect(() => () => {
    documentSessionRef.current++;
    void session.current.dispose();
  }, []);
  useEffect(() => {
    if (!handoffToken) return;
    let dead = false;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(handoffToken)) {
      setHandoffReady(true);
      return;
    }
    void request<PdfHandoff | null>({ type: "pdf.handoff.get", token: handoffToken })
      .then((value) => { if (!dead) setHandoff(value?.token === handoffToken ? value : null); })
      .catch(() => { if (!dead) setHandoff(null); })
      .finally(() => { if (!dead) setHandoffReady(true); });
    return () => { dead = true; };
  }, [handoffToken]);
  useEffect(() => {
    if (!settingsReady || !handoffReady || autoOpenAttempted.current) return;
    autoOpenAttempted.current = true;
    const initialSource = initialParams.get("source");
    const sessionSource = handoff?.accessMode === "site-session" &&
      ((!initialParams.get("document") && !initialSource) || initialSource === ieeeRecordSource(handoff.returnUrl));
    if (sessionSource && handoff) {
      void loadPdf(undefined, true, handoff.returnUrl, true);
    } else if (handoffToken && !handoff && initialSource && isIeeeSessionPage(initialSource)) {
      setIeeeRecovery("return");
      setError(t("登录读取授权已过期，请返回 IEEE 后重新打开。", "Sign-in access expired. Return to IEEE and open again."));
    } else if (initialSource && safeSource(initialSource) && isIeeePdfWrapper(initialSource)) {
      setIeeeRecovery("return");
      setError(t("请返回 IEEE 原页面，选择「使用 IEEE 登录状态打开」。", "Return to the IEEE paper page and choose Open using IEEE sign-in."));
    } else if (safeSource(initialParams.get("source") || undefined)) {
      // A side-panel click starts this handoff. Never request site access from
      // an effect: if needed, the reader's Open URL button supplies the gesture.
      void loadPdf(undefined, true);
    }
  }, [settingsReady, handoffReady]);
  async function claimIeeeGrant(): Promise<PdfHandoff> {
    const grant = handoffToken ? await request<PdfHandoff | null>({ type: "pdf.handoff.get", token: handoffToken }) : null;
    if (!grant || grant.token !== handoffToken || grant.accessMode !== "site-session" ||
      grant.allowedOrigin !== "https://ieeexplore.ieee.org" || !Number.isFinite(grant.expiresAt) || grant.expiresAt! <= Date.now()) {
      setIeeeRecovery("return");
      throw Error(t("登录读取授权已过期，请返回 IEEE 后重新打开。", "Sign-in access expired. Return to IEEE and open again."));
    }
    ieeeSourceUrl(grant.returnUrl);
    if (grant.sourceUrl) ieeeSourceUrl(grant.sourceUrl);
    return grant;
  }
  function resetDocumentState() {
    setError("");
    setNotice("");
    setPreviousHash(undefined);
    setPaperDoi(undefined);
    setIeeeRecovery(undefined);
    setBusy(true);
    documentSessionRef.current++;
    exportController.current?.abort();
    exportController.current = undefined;
    setExportStage(undefined);
    nativeScan.current?.abort();
    nativeScan.current = undefined;
    originalNotes.current?.dispose();
    originalNotes.current = undefined;
    nativeFocus.current = undefined;
    setNativeRecords([]);
    setNativeFilter("web-ink");
    setNativeLoading(false);
    setNativeProgress(undefined);
    setNativeError("");
    setNativeOffset(0);
    nativeHistory.current = [];
    positionSession.current?.writer.dispose();
    positionSession.current = undefined;
    setOpened(undefined);
    setSearchMatch(undefined);
    pendingSearchPosition.current = undefined;
    setSelection(undefined);
    setPicked(undefined);
    setUndoRecord(undefined);
    actions.current.updateRecords([]);
    setNoteDrafts({});
    draftsRef.current = {};
    setNoteConflicts({});
    setShowMarks(true);
    setNotesOpen(false);
    focusAttempt.current++;
    setFocusMode(false);
    setFocusBusy(false);
    setFocusHint(false);
    setSourceOpen(false);
    setPositionError("");
    setFitWidth(false);
    intrinsicDimensions.current.clear();
    setZoom(1);
    setRotation(0);
    setPageNumber(1);
    dimensions.current.clear();
    setPageWindow({ start: 0, end: 3 });
  }
  async function prepareSource(
    file: File | undefined, automatic: boolean, chosenSource: string, siteSession: boolean, token: number) : Promise<PreparedSource | undefined> {
    if (!siteSession && handoff?.accessMode === "site-session" && handoffToken) {
      await request({ type: "pdf.handoff.revoke", token: handoffToken });
      if (!session.current.isCurrent(token)) return;
      setHandoff({ ...handoff, expiresAt: 0, sourceUrl: undefined });
    }
    let remote: string | undefined;
    let ieeeGrant: PdfHandoff | null = null;
    if (!file && siteSession) {
      ieeeGrant = await claimIeeeGrant();
      if (!session.current.isCurrent(token)) return;
      // Download tickets stay in session storage. Records keep only the
      // observed paper page, with its article identifier when available.
      remote = ieeeRecordSource(ieeeGrant.returnUrl);
    }
    if (!file) {
      const url = pdfSourceUrl(remote ?? chosenSource.trim());
      remote = url.href;
      const origins = [`${url.origin}/*`];
      if (!(await chrome.permissions.contains({ origins }))) {
        if (automatic) {
          if (siteSession) setIeeeRecovery("permission");
          setNotice(siteSession
            ? t("需要允许访问 IEEE。点击「允许访问 IEEE 并重试」继续。", "Grant IEEE access with Allow IEEE and retry.")
            : t("链接已带入。点击「打开网址」授权并读取，或选择本地 PDF。", "Link ready. Click Open URL to grant access, or choose a local PDF."));
          return;
        }
        if (!(await chrome.permissions.request({ origins }))) {
          if (siteSession) setIeeeRecovery("permission");
          throw Error(t("未授予网站访问权限。", "Site permission was not granted."));
        }
      }
    }
    if (ieeeGrant) {
      // A permission dialog can remain open beyond the ten-minute grant.
      ieeeGrant = await claimIeeeGrant();
      if (!session.current.isCurrent(token)) return;
    }
    return { ...(remote ? { remote } : {}), ...(ieeeGrant ? { ieeeGrant } : {}) };
  }
  async function readSourceBytes(
    prepared: PreparedSource, file: File | undefined, signal: AbortSignal, token: number) : Promise<SourceBytes | undefined> {
    const [bytes, api] = await Promise.all([
      file ? readLocalPdf(file) : prepared.ieeeGrant
        ? readPreparedPdf(handoffToken!, message => request(message as import('../../core/model').Request), signal)
        : readRemotePdf(prepared.remote!, signal),
      import("pdfjs-dist/legacy/build/pdf.mjs"),
    ]);
    if (!session.current.isCurrent(token)) return;
    const hash = await pdfHash(bytes);
    if (!session.current.isCurrent(token)) return;
    return { api, bytes, hash, positionRead: readPdfReadingPosition(hash) };
  }
  async function openDocument(
    sourceBytes: SourceBytes, token: number) : Promise<OpenedDocument | undefined> {
    const { api, bytes, hash } = sourceBytes;
    api.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
      "/pdfjs/pdf.worker.min.mjs",
    );
    const task = api.getDocument({
      data: bytes,
      cMapUrl: chrome.runtime.getURL("/pdfjs/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL("/pdfjs/standard_fonts/"),
      wasmUrl: chrome.runtime.getURL("/pdfjs/wasm/"),
      iccUrl: chrome.runtime.getURL("/pdfjs/iccs/"),
      enableXfa: false,
      // Font fallbacks are recoverable; page failures still reject and show an alert.
      verbosity: api.VerbosityLevel.ERRORS,
      stopAtErrors: true,
      maxImageSize: 16777216,
      canvasMaxAreaInBytes: 67108864,
    });
    session.current.setTask(token, task);
    task.onPassword = () => {
      if (!session.current.isCurrent(token)) return;
      setError(
        t(
          "加密 PDF 暂不支持，请先解锁文件。",
          "Encrypted PDFs are not supported; unlock the file first.",
        ),
      );
      void session.current.disposeCurrent();
    };
    const pageUrl = `urn:web-ink:pdf:${hash}`;
    // Read existing records during parsing, but publish only when both are
    // ready: a faster first paint must not allow editing an incomplete list.
    const [doc, all] = await Promise.all([
      task.promise,
      request<Annotation[]>({ type: "annotations.list", pageUrl }),
    ]);
    if (!session.current.isCurrent(token)) return;
    const metadata = await doc.getMetadata().catch(() => ({}));
    if (!session.current.isCurrent(token)) return;
    return { ...sourceBytes, doc, all, metadata };
  }
  async function publishDocument(
    openedDocument: OpenedDocument, prepared: PreparedSource, file: File | undefined,
    token: number, signal: AbortSignal, openingParams: URLSearchParams, openingIntent: number,
    previousMarkedHash?: string) : Promise<void> {
    const { api, doc, all, hash, metadata, positionRead } = openedDocument;
    const remote = prepared.remote;
    const sourcePage = remote ? new URL(remote) : undefined;
    const ieeeName = prepared.ieeeGrant && sourcePage?.pathname.toLowerCase() === "/stamp/stamp.jsp"
      ? `IEEE-${sourcePage.searchParams.get("arnumber") || "paper"}.pdf` : undefined;
    const fallbackName = file?.name || ieeeName || decodeURIComponent(sourcePage?.pathname.split("/").pop() || "Document.pdf");
    const fileName = pdfDisplayName(metadata, fallbackName);
    const doi = pdfDoi(metadata);
    const tabId = await chrome.tabs.getCurrent().then(tab => tab?.id).catch(() => undefined);
    const reopen = await readPdfPaperReopen(remote, doi, tabId);
    if (!session.current.isCurrent(token)) return;
    setPaperDoi(doi);
    void learnPdfPaperIdentity(hash, metadata, remote);
    // Keep the reader URL aligned with the successfully loaded document so
    // a later library/source handoff cannot reuse a tab showing another PDF.
    const readerLocation = new URL(location.href);
    readerLocation.searchParams.set("document", hash);
    readerLocation.searchParams.delete("open");
    readerLocation.searchParams.delete("page");
    if (remote) readerLocation.searchParams.set("source", remote);
    else readerLocation.searchParams.delete("source");
    history.replaceState(null, "", readerLocation.href);
    setSource(remote ?? "");
    const nativeAnnotations = new NativePdfAnnotations(doc, hash);
    originalNotes.current = nativeAnnotations;
    setOpened({
      document: doc,
      api,
      hash,
      fileName,
      nativeAnnotations,
      ...(remote ? { sourceUrl: remote } : {}),
    });
    documentSessionRef.current++;
    setDocumentSession(documentSessionRef.current);
    actions.current.updateRecords(all.filter(isPdf));
    setArea(false);
    const expected = openingParams.get("document") || reopen?.documentHash;
    const requestedPage = openingParams.get("page") || (reopen ? String(reopen.pageNumber) : null);
    const explicitPage = requestedPage && /^[1-9]\d*$/.test(requestedPage) && (!expected || expected === hash) && Number(requestedPage) <= doc.numPages
      ? Number(requestedPage) : undefined;
    const position: PositionSession = {
      session: documentSessionRef.current, hash,
      writer: createPdfReadingPositionWriter(hash), readReady: false, intent: openingIntent,
    };
    positionSession.current = position;
    void positionRead.then((stored) => {
      if (!session.current.isCurrent(token) || positionSession.current !== position) return;
      position.readReady = true;
      if (openingIntent === intentEpoch.current) {
        const valid = stored && stored.pageNumber <= doc.numPages ? stored : undefined;
        const target = explicitPage ? { version: 1 as const, pageNumber: explicitPage, pageOffsetRatio: 0,
          zoom: valid?.zoom ?? 1, rotation: valid?.rotation ?? 0 } : valid;
        if (target) {
          position.pending = target;
          setZoom(target.zoom);
          setRotation(target.rotation);
          setPageNumber(target.pageNumber);
          setPageWindow({ start: Math.max(0, target.pageNumber - 2), end: Math.min(doc.numPages, target.pageNumber + 2) });
        }
      }
      setPositionEpoch((epoch) => epoch + 1);
    });
    let changed = !!expected && expected !== hash;
    let earlierHash: string | undefined;
    let versionCheckIncomplete = false;
    if (remote && !changed) {
      const citation = doiUrl(doi);
      const previous = await findPreviousPdfVersion(
        hash, citation ? [citation, remote] : [remote], signal,
      );
      earlierHash = previous.hash;
      changed = !!earlierHash;
      versionCheckIncomplete = previous.incomplete;
    }
    if (!session.current.isCurrent(token)) return;
    if (changed) {
      const oldHash = earlierHash || expected;
      if (oldHash && /^[a-f0-9]{64}$/.test(oldHash)) setPreviousHash(oldHash);
      setNotice(
        t(
          "文档版本已变化：旧标注已保留，没有套用到这份文件。",
          "Document changed: previous annotations are preserved and were not applied to this file.",
        ),
      );
    } else if (versionCheckIncomplete) {
      setNotice((notice) => notice || t(
        "旧版本检查未完成，请到资料库查看之前的标注。旧标注仍按文档隔离保存。",
        "The previous-version check is incomplete. Check the library for earlier annotations; they remain isolated by document.",
      ));
    } else if (previousMarkedHash && previousMarkedHash !== hash) {
      setPreviousHash(previousMarkedHash);
      setNotice(t(
        "已打开另一份 PDF，之前文件的标注仍保存在资料库。",
        "Another PDF is open. Annotations from the previous file remain in your library.",
      ));
    }
  }
  async function loadPdf(file?: File, automatic = false, chosenSource = source, siteSession = false) {
    const openingParams = new URLSearchParams(location.search);
    const previousHash = positionSession.current?.hash;
    const previousMarkedHash = previousHash && recordsRef.current.some(
      record => record.target.documentHash === previousHash,
    ) ? previousHash : undefined;
    // A reader URL names the open document; choosing another file is not a
    // request to apply that document's page or assume the files are related.
    if (previousHash) {
      openingParams.delete("document");
      openingParams.delete("page");
    }
    const openingIntent = intentEpoch.current;
    const chromeVersion = Number(
      navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] || 0,
    );
    if (chromeVersion && chromeVersion < 125) {
      setError(
        t(
          "PDF 阅读需要 Chrome 125 或更高版本。",
          "PDF reading requires Chrome 125 or later.",
        ),
      );
      return;
    }
    let token = 0,
      signal: AbortSignal | undefined;
    resetDocumentState();
    try {
      const active = await session.current.begin();
      token = active.token;
      signal = active.signal;
      const prepared = await prepareSource(file, automatic, chosenSource, siteSession, token);
      if (!prepared) return;
      const sourceBytes = await readSourceBytes(prepared, file, active.signal, token);
      if (!sourceBytes) return;
      const openedDocument = await openDocument(sourceBytes, token);
      if (!openedDocument) return;
      await publishDocument(
        openedDocument, prepared, file, token, active.signal, openingParams, openingIntent, previousMarkedHash,
      );
    } catch (cause) {
      if (token && session.current.isCurrent(token) && !signal?.aborted) {
        if (siteSession) {
          let recovery: "permission" | "retry" | "return" = "return";
          if (cause instanceof IeeePdfError && cause.reason === "site-permission") recovery = "permission";
          setIeeeRecovery(recovery);
        }
        setError(errorText(cause));
        await session.current.disposeCurrent();
      }
    } finally {
      if (token && session.current.isCurrent(token)) setBusy(false);
    }
  }
  return { claimIeeeGrant, loadPdf };
}
