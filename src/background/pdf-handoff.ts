import type { PdfHandoff, PdfOpenResult, PdfTabContext, Result } from "../core/model";
import {
  buildPdfOpenUrl, classifyPdfTab, getPdfContext, isKnownPdfViewer, isIeeePdfWrapper,
  isIeeeSessionPage, probePdfDocument, publicPdfSource,
} from "../core/pdf-context";
import { IeeePdfError } from "../core/ieee-contract";
import { createIeeePreparation } from "./ieee-preparation";
import { ok } from "./request-result";
import { navigationChanged, ownPage, pageUrl, parseInput, PdfNavigationError, returnUrl, UUID, type Input } from "./pdf-handoff/contract";
import { handoffKey, readHandoff, removeTabHandoffs } from "./pdf-handoff/session-store";
import { createPdfTabContext, type Actor, type Snapshot } from "./pdf-handoff/tab-context";

/** Background-owned source observation and session navigation. */
export function createPdfHandoffHandler(getGeneration: () => Promise<string>) {
  const preparation = createIeeePreparation(getGeneration);
  const preparedReaders = new Map<number, string>();
  const flights = new Map<number, { key: string; task: Promise<unknown> }>();
  const cancellations = new Map<number, number>();
  const grantUpdates = new Map<number, Promise<PdfHandoff | null>>();
  const cancellationEpoch = (tabId: number) => cancellations.get(tabId) ?? 0;
  const tabs = createPdfTabContext(cancellationEpoch);
  const { actorFor, capture, guard } = tabs;

  // Native PDF viewers cannot be probed. Loading events also catch same-URL refreshes.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url || change.status === "loading") {
      tabs.tabChanged(tabId);
      preparation.cancelTab(tabId);
      if (change.url && preparedReaders.has(tabId) &&
        (!ownPage(change.url, 'pdf.html') || new URL(change.url).searchParams.get('handoff') !== preparedReaders.get(tabId))) {
        preparation.releaseTab(tabId);
        preparedReaders.delete(tabId);
      }
    }
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    tabs.tabChanged(tabId);
    preparation.releaseTab(tabId);
    preparedReaders.delete(tabId);
    void removeTabHandoffs(tabId).catch(() => undefined);
  });
  chrome.tabs.onActivated.addListener(({ windowId }) => { tabs.tabActivated(windowId); });
  async function inspect(actor: Actor, input: Input) {
    const snapshot = await capture(actor);
    if (input.expectedUrl !== undefined && input.expectedUrl !== snapshot.url) throw navigationChanged();
    let context = classifyPdfTab(actor.tabId, snapshot.url);
    if (ownPage(snapshot.url, "pdf.html")) {
      context = await currentReaderContext(actor.tabId, snapshot.url!);
    } else if (snapshot.url && !getPdfContext(snapshot.url) && !isKnownPdfViewer(snapshot.url)) {
      context = await inspectSourceDocument(actor, snapshot, context);
    }
    await guard(actor, snapshot);
    return { context, snapshot };
  }

  /** One flight per tab; identical concurrent requests join it, different ones are rejected. */
  const singleFlight = (actor: Actor, input: Input, run: () => Promise<unknown>) => {
    const key = JSON.stringify([input.type, actor.kind, actor.windowId, actor.contextDocumentId ?? actor.sender.documentId, input.expectedUrl, input.candidateUrl, input.token, input.accessMode]);
    const existing = flights.get(actor.tabId);
    if (existing) {
      if (existing.key !== key) throw navigationChanged();
      return existing.task;
    }
    const task = Promise.resolve().then(run);
    flights.set(actor.tabId, { key, task });
    void task.finally(() => { if (flights.get(actor.tabId)?.task === task) flights.delete(actor.tabId); }).catch(() => undefined);
    return task;
  };
  async function open(actor: Actor, input: Input): Promise<PdfOpenResult> {
    const cancelEpoch = cancellationEpoch(actor.tabId);
    const { context, snapshot } = await inspect(actor, input);
    snapshot.cancelEpoch = cancelEpoch;
    await guard(actor, snapshot);
    if (context.currentReader) return {
      tabId: actor.tabId, readerUrl: context.url!, navigation: "current-reader",
      ...(context.handoffToken ? { token: context.handoffToken } : {}),
      ...(context.candidates[0] ? { sourceUrl: context.candidates[0].url } : {}),
    };

    const siteSession = input.accessMode === "site-session";
    const source = selectSource(context, input.candidateUrl, siteSession);
    const original = returnUrl(snapshot.url);
    if (siteSession) await authorizeIeeeSource(original, source);

    const base = chrome.runtime.getURL("pdf.html");
    if (!original || context.kind === "unavailable") {
      await guard(actor, snapshot);
      return openManualReader(base);
    }

    const token = crypto.randomUUID();
    const preparedToken = siteSession ? await prepareSource(actor, snapshot, context, original, source) : undefined;
    const handoff: PdfHandoff = {
      token, tabId: actor.tabId, returnUrl: original,
      ...(source ? { sourceUrl: source } : {}),
      ...(siteSession ? { accessMode: "site-session", allowedOrigin: IEEE_ORIGIN, expiresAt: Date.now() + 600_000, preparedToken } : {}),
    };
    // Credential-bound sources stay in session storage.
    const reader = new URL(buildPdfOpenUrl(base, !siteSession && source ? { kind: "remote", sourceUrl: source } : undefined));
    reader.searchParams.set("handoff", token);
    await navigateToReader(actor, snapshot, handoff, reader.href);
    return { tabId: actor.tabId, readerUrl: reader.href, navigation: "same-tab", token, ...(source ? { sourceUrl: source } : {}) };
  }

  async function prepareSource(actor: Actor, snapshot: Snapshot, context: PdfTabContext, original: string, source?: string) {
    // Browser-owned direct PDFs rely on the URL and tab-loading epoch guard.
    const protectedDirect = actor.kind === "sidebar" && context.kind === "direct" && source === publicPdfSource(original);
    if (!protectedDirect && !snapshot.documentId) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: actor.tabId },
        func: () => ({ href: location.href, top: window === window.top }),
      });
      const top = results.find(item => item.frameId === 0);
      if (!top?.documentId || !top.result?.top || pageUrl(top.result.href) !== snapshot.url) throw navigationChanged();
      snapshot.documentId = top.documentId;
    }
    const verify = () => guard(actor, snapshot);
    const prepared = protectedDirect
      ? await preparation.prepareDirect(actor.tabId, source!, verify)
      : await preparation.prepare(actor.tabId, snapshot.documentId!, original, source, verify);
    try { await verify(); }
    catch (error) { preparation.releaseTab(actor.tabId); throw error; }
    return prepared.token;
  }

  async function navigateToReader(actor: Actor, snapshot: Snapshot, handoff: PdfHandoff, url: string) {
    const { tabId, token, preparedToken } = handoff;
    const releasePrepared = () => { if (preparedToken) preparation.releaseTab(tabId); };
    try { await guard(actor, snapshot); }
    catch (error) { releasePrepared(); throw error; }
    try {
      // Retain a single recovery token for the live tab.
      await removeTabHandoffs(tabId);
      await chrome.storage.session.set({ [handoffKey(token)]: handoff });
    } catch {
      releasePrepared();
      throw new PdfNavigationError("STORAGE_UNAVAILABLE", "Return context could not be saved. Reader navigation was not started.");
    }
    try { await guard(actor, snapshot); }
    catch (error) {
      await chrome.storage.session.remove(handoffKey(token)).catch(() => undefined);
      releasePrepared();
      throw error;
    }
    if (preparedToken) preparedReaders.set(tabId, token);
    try { await chrome.tabs.update(tabId, { url }); }
    catch {
      releasePrepared();
      throw new PdfNavigationError("NAVIGATION_FAILED", "Reader navigation could not be confirmed. Saved return context is retained for recovery.");
    }
  }

  const readerHandoff = async (actor: Actor, token: string) => {
    if (actor.kind !== "reader") throw new PdfNavigationError("FORBIDDEN", "Return to the original page from its PDF reader.");
    const snapshot = await capture(actor);
    if (!ownPage(snapshot.url, "pdf.html") || new URL(snapshot.url!).searchParams.get("handoff") !== token)
      throw new PdfNavigationError("FORBIDDEN", "This return session does not belong to this reader.");
    const handoff = await readHandoff(token, actor.tabId);
    await guard(actor, snapshot);
    return { handoff, snapshot };
  };
  const updateGrant = (actor: Actor, token: string, revoke: boolean) => {
    // Serialize storage read/write, including calls from a replacement document.
    const previous = grantUpdates.get(actor.tabId) ?? Promise.resolve(null);
    const task = previous.catch(() => null).then(async () => {
      const { handoff, snapshot } = await readerHandoff(actor, token);
      if (handoff?.accessMode !== "site-session") return handoff;
      const expired = revoke || handoff.expiresAt! <= Date.now() ||
        (handoff.readerDocumentId !== undefined && handoff.readerDocumentId !== actor.documentId);
      if (!expired && handoff.readerDocumentId) return handoff;
      if (expired && handoff.expiresAt === 0 && !handoff.sourceUrl) return handoff;
      const updated = { ...handoff };
      if (expired) { updated.expiresAt = 0; delete updated.sourceUrl; preparation.releaseTab(actor.tabId); }
      else updated.readerDocumentId = actor.documentId!;
      try { await chrome.storage.session.set({ [handoffKey(token)]: updated }); }
      catch { throw new PdfNavigationError("STORAGE_UNAVAILABLE", "Session access could not be saved. Return to IEEE and open again."); }
      await guard(actor, snapshot);
      return updated;
    });
    grantUpdates.set(actor.tabId, task);
    void task.finally(() => { if (grantUpdates.get(actor.tabId) === task) grantUpdates.delete(actor.tabId); }).catch(() => undefined);
    return task;
  };
  async function preparedRequest(actor: Actor, input: Input): Promise<Result<unknown>> {
    const { handoff, snapshot } = await readerHandoff(actor, input.token!);
    if (!handoff?.preparedToken || handoff.expiresAt! <= Date.now())
      throw new PdfNavigationError("PDF_SOURCE_UNAVAILABLE", "Prepared PDF session expired. Return to IEEE and open again.");
    if (!handoff.readerDocumentId || handoff.readerDocumentId !== actor.documentId)
      throw new PdfNavigationError("FORBIDDEN", "Prepared PDF belongs to another reader document.");
    const data = await preparation.getStore();
    const owner = { tabId: actor.tabId, documentId: actor.documentId!, generation: await getGeneration() };
    await guard(actor, snapshot);
    switch (input.type) {
      case "pdf.prepared.claim":
        return ok({ ...data.claim(handoff.preparedToken, owner), token: input.token });
      case "pdf.prepared.chunk":
        return ok(data.chunk(handoff.preparedToken, owner, input.index!));
      case "pdf.prepared.release":
        data.release(handoff.preparedToken, owner);
        return ok(undefined);
      default:
        throw new PdfNavigationError("INVALID_INPUT", "Unsupported PDF request.");
    }
  }

  async function returnToSource(actor: Actor, token: string) {
    const { handoff, snapshot } = await readerHandoff(actor, token);
    if (!handoff)
      throw new PdfNavigationError("PDF_SOURCE_UNAVAILABLE", "Return context expired. Open the source or choose a local PDF.");
    await guard(actor, snapshot);
    preparation.releaseTab(actor.tabId);
    try { await chrome.tabs.update(actor.tabId, { url: handoff.returnUrl }); }
    catch { throw new PdfNavigationError("NAVIGATION_FAILED", "Return navigation could not be confirmed. Saved return context is retained for recovery."); }
    await chrome.storage.session.remove(handoffKey(handoff.token)).catch(() => undefined);
    return { tabId: actor.tabId, url: handoff.returnUrl };
  }

  return async (raw: unknown, sender: chrome.runtime.MessageSender): Promise<Result<unknown>> => {
    try {
      const input = parseInput(raw);
      const actor = await actorFor(input, sender);
      switch (input.type) {
        case "pdf.context.get":
          return ok((await inspect(actor, input)).context);
        case "pdf.openCurrent":
          return ok(await singleFlight(actor, input, () => open(actor, input)));
        case "pdf.cancelCurrent":
          await inspect(actor, input);
          if (flights.has(actor.tabId)) cancellations.set(actor.tabId, cancellationEpoch(actor.tabId) + 1);
          preparation.cancelTab(actor.tabId);
          return ok(undefined);
        case "pdf.handoff.get":
        case "pdf.handoff.revoke":
          return ok(await updateGrant(actor, input.token!, input.type === "pdf.handoff.revoke"));
        case "pdf.returnOriginal":
          return ok(await singleFlight(actor, input, () => returnToSource(actor, input.token!)));
        default:
          if (input.type.startsWith("pdf.prepared.")) return await preparedRequest(actor, input);
          throw new PdfNavigationError("INVALID_INPUT", "Unsupported PDF request.");
      }
    } catch (error) {
      return pdfFailure(error);
    }
  };
}

const IEEE_ORIGIN = "https://ieeexplore.ieee.org";

function selectSource(context: PdfTabContext, selected: string | undefined, siteSession: boolean): string | undefined {
  const candidates = siteSession ? context.candidates.filter(item => new URL(item.url).origin === IEEE_ORIGIN) : context.candidates;
  if (selected) {
    const source = context.candidates.find(item => item.url === selected)?.url;
    if (!source) throw new PdfNavigationError("PDF_SOURCE_UNAVAILABLE", "This PDF source is no longer available. Choose a source again.");
    return source;
  }
  if (candidates.length > 1) throw new PdfNavigationError("PDF_CHOICE_REQUIRED", "Choose which PDF to open.");
  return candidates[0]?.url;
}

async function authorizeIeeeSource(original: string | undefined, source: string | undefined) {
  if (!original || !isIeeeSessionPage(original) || (source && new URL(source).origin !== IEEE_ORIGIN))
    throw new PdfNavigationError("FORBIDDEN", "IEEE login reading is available only from the current IEEE PDF page.");
  if (!source && !isIeeePdfWrapper(original))
    throw new PdfNavigationError("FORBIDDEN", "Open the PDF on IEEE first; this page has no observed same-origin PDF source.");
  if (!(await chrome.permissions.contains({ origins: [IEEE_ORIGIN + "/*"] }).catch(() => false)))
    throw new PdfNavigationError("FORBIDDEN", "Allow access to IEEE before opening with its sign-in session.");
}

async function openManualReader(url: string): Promise<PdfOpenResult> {
  try {
    const tab = await chrome.tabs.create({ url });
    if (tab.id === undefined) throw Error("Missing reader tab");
    return { tabId: tab.id, readerUrl: url, navigation: "new-tab" };
  } catch { throw new PdfNavigationError("NAVIGATION_FAILED", "The manual PDF reader could not be opened."); }
}

async function currentReaderContext(tabId: number, url: string): Promise<PdfTabContext> {
  const params = new URL(url).searchParams;
  const token = params.get("handoff") ?? undefined;
  const source = publicPdfSource(params.get("source") ?? "");
  const context: PdfTabContext = {
    tabId, url, kind: "wrapper", currentReader: true,
    candidates: source ? [{ url: source, via: "viewer" }] : [],
    ...(token && UUID.test(token) ? { handoffToken: token } : {}),
  };
  if (context.handoffToken) {
    try { if (!(await readHandoff(context.handoffToken, tabId))) context.reason = "session-unavailable"; }
    catch (error) {
      if (error instanceof PdfNavigationError && error.code === "FORBIDDEN") throw error;
      context.reason = "session-unavailable";
    }
  }
  return context;
}

async function inspectSourceDocument(actor: Actor, snapshot: Snapshot, fallback: PdfTabContext): Promise<PdfTabContext> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: actor.tabId, ...(actor.documentId ? { documentIds: [actor.documentId] } : {}) },
      func: probePdfDocument,
    });
    const result = results.find(item => item.frameId === 0 && (!actor.documentId || item.documentId === actor.documentId));
    if (!result?.documentId || !result.result?.top || pageUrl(result.result.href) !== snapshot.url) throw navigationChanged();
    snapshot.documentId = result.documentId;
    const candidates = Array.isArray(result.result.candidates) ? result.result.candidates : [];
    return classifyPdfTab(actor.tabId, snapshot.url, candidates);
  } catch (error) {
    if (actor.kind === "content" || error instanceof PdfNavigationError) throw navigationChanged();
    return { ...fallback, reason: "permission-denied" };
  }
}

function pdfFailure(error: unknown): Result<never> {
  const hasMessage = error instanceof Error || error instanceof DOMException;
  const message = hasMessage ? error.message : "PDF context is unavailable.";
  if (error instanceof PdfNavigationError) return { ok: false, code: error.code, error: message };
  if (error instanceof IeeePdfError)
    return { ok: false, code: `IEEE_${error.reason}`, error: message, diagnostic: error.diagnostic };
  const code = hasMessage && error.name === "AbortError" ? "CANCELLED" : "CONTEXT_UNAVAILABLE";
  return { ok: false, code, error: message };
}
