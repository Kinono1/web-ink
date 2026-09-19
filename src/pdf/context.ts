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
