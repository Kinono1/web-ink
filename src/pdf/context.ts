import type { PdfContextReason, PdfSourceCandidate, PdfTabContext } from "../core/model";

/** A PDF source classification that never performs I/O. */
export type PdfContext =
  | { kind: "remote"; sourceUrl: string }
  | { kind: "local" }
  | { kind: "viewer"; sourceUrl?: string };

const SCHOLAR_READER_ID = "dahenjhkoodjbpjheillcadbppiidmhp";
const CHROME_PDF_VIEWER_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

/**
 * Identifies a direct PDF URL or one of the known Chrome PDF reader wrappers.
 *
 * `remote` is deliberately limited to credential-free HTTPS. HTTP and file
 * documents are still recognized as `local`, which tells callers to use a
 * user-mediated open flow instead of fetching them automatically.
 */
export function getPdfContext(raw?: string): PdfContext | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const wrapped = wrappedPdfContext(url);
  return wrapped ?? directPdfContext(url);
}

/** Builds a reader link without ever forwarding a local or viewer URL. */
export function buildPdfOpenUrl(readerBase: string, context?: PdfContext): string {
  const reader = new URL(readerBase);
  if (context?.kind !== "remote") return reader.href;

  const source = safeHttpsUrl(context.sourceUrl);
  if (!source) return reader.href;

  reader.searchParams.set("source", source.href);
  reader.searchParams.set("open", "1");
  return reader.href;
}

function directPdfContextFromRaw(raw: string): PdfContext | undefined {
  try {
    return directPdfContext(new URL(raw));
  } catch {
    return undefined;
  }
}

function directPdfContext(url: URL): PdfContext | undefined {
  if (!isPdfPath(url) && !isArxivPdfPath(url)) return undefined;

  if (url.protocol === "https:" && !url.username && !url.password)
    return { kind: "remote", sourceUrl: url.href };
  // HTTP is recognized for context detection but is never eligible for the
  // automatic remote-reader flow.
  if (url.protocol === "http:" && !url.username && !url.password)
    return { kind: "local" };
  if (url.protocol === "file:") return { kind: "local" };
  return undefined;
}

function wrappedPdfContext(url: URL): PdfContext | undefined {
  if (url.protocol !== "chrome-extension:") return undefined;

  const viewer = viewerSourceParameter(url);
  if (!viewer) return undefined;
  if (!viewer.source) return { kind: "viewer" };

  const httpsSource = safeHttpsUrl(viewer.source);
  if (httpsSource) return { kind: "remote", sourceUrl: httpsSource.href };

  // Known readers can wrap download endpoints without a .pdf suffix. Their
  // HTTP and file inputs still fall back to user-mediated selection.
  const source = directPdfContextFromRaw(viewer.source);
  return source ? { kind: "viewer" } : undefined;
}

function safeHttpsUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function viewerSourceParameter(url: URL): { source?: string } | undefined {
  const extension = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const recognized =
    (extension === SCHOLAR_READER_ID && path === "/reader.html") ||
    (extension === CHROME_PDF_VIEWER_ID && path === "/index.html");
  if (!recognized) return undefined;

  // Read URL-like parameters only after the extension host and viewer page
  // are known, so arbitrary pages cannot smuggle a nested source through.
  return {
    source: url.searchParams.get("url") || url.searchParams.get("file") || undefined,
  };
}

function isPdfPath(url: URL): boolean {
  return /\.pdf$/i.test(url.pathname);
}

function isArxivPdfPath(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.hostname.toLowerCase() !== "arxiv.org") return false;
  // Current IDs have one segment; legacy arXiv IDs such as hep-th/9901001
  // have two. A bare /pdf/ endpoint is not a document.
  return /^\/pdf\/[^/]+(?:\/[^/]+)?$/i.test(url.pathname);
}

export interface ObservedPdfCandidate {
  url: string;
  via: "iframe" | "embed" | "object";
  mimeType: string;
}
export interface PdfDocumentSnapshot {
  href: string;
  top: boolean;
  candidates: ObservedPdfCandidate[];
}

/** Chrome serializes this function. It must depend only on the observed DOM. */
export function probePdfDocument(): PdfDocumentSnapshot {
  const candidates: ObservedPdfCandidate[] = [];
  for (const element of document.querySelectorAll("iframe,embed,object")) {
    const rectangle = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      element.closest("[hidden]") ||
      style.display === "none" || style.visibility === "hidden" ||
      rectangle.width <= 0 || rectangle.height <= 0 ||
      rectangle.bottom <= 0 || rectangle.right <= 0 ||
      rectangle.top >= innerHeight || rectangle.left >= innerWidth
    )
      continue;
    const via = element.localName as "iframe" | "embed" | "object";
    const attribute = element.getAttribute(via === "object" ? "data" : "src");
    if (!attribute || attribute.length > 8192) continue;
    let url: string;
    try { url = new URL(attribute, document.baseURI).href; } catch { continue; }
    if (url.length > 8192) continue;
    candidates.push({ url, via, mimeType: (element.getAttribute("type") ?? "").slice(0, 200) });
    if (candidates.length === 100) break;
  }
  return { href: location.href, top: window === window.top, candidates };
}

export function isKnownPdfViewer(raw: string): boolean {
  try { return Boolean(viewerSourceParameter(new URL(raw))); } catch { return false; }
}
export function isIeeePdfWrapper(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username && !url.password && url.hostname === "ieeexplore.ieee.org" &&
      url.pathname.toLowerCase() === "/stamp/stamp.jsp";
  } catch { return false; }
}
export function publicPdfSource(raw: string): string | undefined {
  return safeHttpsUrl(raw)?.href;
}

/** URL/MIME hints are candidates, never proof that bytes are a PDF. */
export function classifyPdfTab(tabId: number, raw?: string, observed: ObservedPdfCandidate[] = []): PdfTabContext {
  const base: PdfTabContext = { tabId, ...(raw ? { url: raw } : {}), kind: "unavailable", candidates: [], currentReader: false };
  if (!raw) return { ...base, reason: "context-unavailable" };
  let page: URL;
  try { page = new URL(raw); } catch { return { ...base, reason: "context-unavailable" }; }
  const direct = getPdfContext(raw);
  const wrapper = isKnownPdfViewer(raw) || isIeeePdfWrapper(raw);
  if (direct?.kind === "remote") return {
    ...base, kind: wrapper ? "wrapper" : "direct",
    candidates: [{ url: direct.sourceUrl, via: wrapper ? "viewer" : "url" }],
  };
  if (direct?.kind === "local") return { ...base, kind: "local", reason: "local-source" };
  if (isKnownPdfViewer(raw)) {
    const source = viewerSourceParameter(page)?.source;
    let reason: PdfContextReason = source ? "unsafe-source" : "protected-viewer";
    if (source) {
      try {
        const url = new URL(source);
        if (["http:", "file:"].includes(url.protocol) && !url.username && !url.password) reason = "local-source";
      } catch { /* A malformed nested source remains an unsafe manual fallback. */ }
    }
    return { ...base, kind: "wrapper", reason };
  }
  const candidates = new Map<string, PdfSourceCandidate>();
  let local = false;
  let unsafe = false;
  let embedded = false;
  for (const item of observed) {
    if (!item || typeof item.url !== "string" || !["iframe", "embed", "object"].includes(item.via)) continue;
    const mime = typeof item.mimeType === "string" ? item.mimeType.split(";")[0]!.trim().toLowerCase() : "";
    if (mime && mime !== "application/pdf") continue;
    let url: URL;
    try { url = new URL(item.url, raw); } catch { continue; }
    const known = getPdfContext(url.href);
    if (!known && !isPdfPath(url) && !isArxivPdfPath(url) && mime !== "application/pdf" && !wrapper) continue;
    embedded = true;
    const source = known?.kind === "remote" ? known.sourceUrl : publicPdfSource(url.href);
    if (source) {
      if (!candidates.has(source)) candidates.set(source, { url: source, via: item.via });
    } else if ((url.protocol === "http:" || url.protocol === "file:") && !url.username && !url.password) local = true;
    else unsafe = true;
  }
  if (candidates.size) return { ...base, kind: wrapper ? "wrapper" : "embedded", candidates: [...candidates.values()] };
  let reason: PdfContextReason = wrapper ? "source-unknown" : "not-pdf";
  if (local) reason = "local-source";
  if (unsafe || (isPdfPath(page) && !direct)) reason = "unsafe-source";
  let kind: PdfTabContext["kind"] = "unavailable";
  if (wrapper) kind = "wrapper";
  else if (local) kind = "local";
  else if (embedded) kind = "embedded";
  return { ...base, kind, reason };
}
