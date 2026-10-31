import { PdfResponseError, readResponseBytes, verifyPdf } from "./pdf-source";
import { isIeeeDocumentPath } from "./pdf-context";
import {
  createIeeePdfDiagnostic,
  createIeeePdfReadId,
  type IeeePdfDiagnostic,
  type IeeePdfPhase,
  type IeeePdfSourceKind,
} from "./ieee-contract";
const IEEE_ORIGIN = "https://ieeexplore.ieee.org";
const MAX_WRAPPER_BYTES = 1024 * 1024;

interface IeeePdfReadOptions {
  onProgress?: (diagnostic: IeeePdfDiagnostic) => void;
  onActivity?: (byteLength: number) => void;
  /** Only a verified top-level IEEE content script can rely on the backend's grant. */
  sourcePage?: boolean;
}

import { IeeePdfError, ieeeSourceUrl, type IeeePdfReason } from "./ieee-contract";
/** Read actual element attributes in inert template content; never run scripts. */
function parseIeeePdfSource(html: string, pageUrl: string): string {
  const page = ieeeSourceUrl(pageUrl);
  const template = document.createElement("template");
  template.innerHTML = html;
  const candidates = new Set<string>();
  for (const element of template.content.querySelectorAll("iframe,embed,object")) {
    const raw = element.getAttribute(element.localName === "object" ? "data" : "src");
    if (!raw?.trim()) continue;
    try {
      // An HTML base element cannot replace the observed wrapper's origin.
      const source = ieeeSourceUrl(raw, page.href);
      if (source.href !== page.href) candidates.add(source.href);
    } catch {
      // Unsafe or cross-origin elements are never fetched with site credentials.
    }
  }
  if (candidates.size !== 1) throw new IeeePdfError("source-hidden");
  return [...candidates][0]!;
}

/** Caller must already have validated the tab and user-authorized handoff. */
export async function readIeeePdf(
  input: { pageUrl: string; sourceUrl?: string },
  signal: AbortSignal,
  options?: IeeePdfReadOptions) : Promise<Uint8Array> {
  const id = createIeeePdfReadId();
  const startedAt = Date.now();
  let phase: IeeePdfPhase = "identify";
  let sourceKind: IeeePdfSourceKind = "unknown";
  const diagnostic = (details: { status?: number; mime?: string } = {}) => createIeeePdfDiagnostic({
    id,
    phase,
    startedAt,
    sourceKind,
    ...details,
  });
  const fail = (reason: IeeePdfReason, responseError?: PdfResponseError, details?: { status?: number; mime?: string }) =>
    new IeeePdfError(reason, responseError, diagnostic(details));
  const progress = (nextPhase: IeeePdfPhase, nextSourceKind: IeeePdfSourceKind) => {
    phase = nextPhase;
    sourceKind = nextSourceKind;
    options?.onProgress?.(diagnostic());
  };
  try {
    progress("identify", "unknown");
    signal.throwIfAborted();
    let page: URL;
    let source: URL | undefined;
    try {
      page = ieeeSourceUrl(input.pageUrl);
      source = input.sourceUrl === undefined ? undefined : ieeeSourceUrl(input.sourceUrl);
    } catch {
      throw fail("source-hidden");
    }
    if (options?.sourcePage && !isExactIeeeSourcePage(page)) throw fail("source-hidden");
    const wrapper = page.pathname.toLowerCase() === "/stamp/stamp.jsp";
    const documentEmbed = isIeeeDocumentPath(page.pathname) && source !== undefined;
    if (!wrapper && !documentEmbed && source?.href !== page.href) throw fail("source-hidden");
    if (!source) {
      progress("wrapper", "wrapper");
      const response = await fetchIeee(page, signal, options?.sourcePage === true, diagnostic);
      const bytes = await readResponseBytes(response, MAX_WRAPPER_BYTES, options?.onActivity);
      signal.throwIfAborted();
      try {
        const wrapperUrl = response.url ? ieeeSourceUrl(response.url) : page;
        source = ieeeSourceUrl(parseIeeePdfSource(new TextDecoder().decode(bytes), wrapperUrl.href));
      } catch {
        throw fail("source-hidden");
      }
    }
    progress("file", "file");
    const response = await fetchIeee(source, signal, options?.sourcePage === true, diagnostic);
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mime === "text/html" || mime === "application/xhtml+xml") {
      await response.body?.cancel().catch(() => undefined);
      throw fail("not-pdf", undefined, { status: response.status, mime });
    }
    const bytes = await readResponseBytes(response, undefined, options?.onActivity);
    signal.throwIfAborted();
    progress("validate", "file");
    try { return verifyPdf(bytes); } catch { throw fail("not-pdf", undefined, { status: response.status, mime }); }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof IeeePdfError || (error instanceof Error && error.name === "AbortError")) throw error;
    if (error instanceof PdfResponseError) throw fail("network", error);
    // redirect:error and a network failure both reject opaquely; do not guess.
    throw fail("network");
  }
}
function isExactIeeeSourcePage(page: URL): boolean {
  try {
    return window === window.top && window.location.origin === IEEE_ORIGIN &&
      ieeeSourceUrl(window.location.href).href === page.href;
  } catch {
    return false;
  }
}
async function fetchIeee(
  url: URL,
  signal: AbortSignal,
  sourcePage: boolean,
  diagnostic: (details?: { status?: number; mime?: string }) => IeeePdfDiagnostic) : Promise<Response> {
  if (!sourcePage && !(await chrome.permissions.contains({ origins: [`${IEEE_ORIGIN}/*`] })))
    throw new IeeePdfError("site-permission", undefined, diagnostic());
  signal.throwIfAborted();
  const response = await fetch(url, {
    signal,
    credentials: "include",
    cache: "no-store",
    // Same-origin makes the browser reject a cross-origin redirect before its
    // next request; the final-URL check below is only a second boundary.
    ...(sourcePage ? { mode: "same-origin" as const, redirect: "follow" as const } : { redirect: "error" as const }),
  });
  let reason: IeeePdfReason | undefined;
  if (response.type === "opaqueredirect" || [300, 301, 302, 303, 307, 308].includes(response.status))
    reason = "redirect-blocked";
  if (!sourcePage && response.redirected) reason = "redirect-blocked";
  if (response.url) {
    try {
      const finalUrl = ieeeSourceUrl(response.url);
      if (!sourcePage && finalUrl.href !== url.href) reason = "redirect-blocked";
    } catch { reason = "redirect-blocked"; }
  } else if (sourcePage && response.redirected) {
    reason = "redirect-blocked";
  }
  if (!reason && response.status === 401) reason = "login-required";
  if (!reason && response.status === 403) reason = "access-restricted";
  if (!reason && !response.ok) reason = "network";
  if (reason) {
    await response.body?.cancel().catch(() => undefined);
    throw new IeeePdfError(reason, undefined, diagnostic({
      status: response.status,
      mime: response.headers.get("content-type") ?? undefined,
    }));
  }
  return response;
}