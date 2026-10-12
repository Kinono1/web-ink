import { PdfResponseError, readResponseBytes, verifyPdf } from "./source";
import { isIeeeDocumentPath } from "./context";
import {
  createIeeePdfDiagnostic,
  createIeeePdfReadId,
  type IeeePdfDiagnostic,
  type IeeePdfPhase,
  type IeeePdfSourceKind,
} from "./ieee-diagnostics";

const IEEE_ORIGIN = "https://ieeexplore.ieee.org";
const MAX_WRAPPER_BYTES = 1024 * 1024;

export type IeeePdfReason =
  | "source-hidden"
  | "site-permission"
  | "login-required"
  | "access-restricted"
  | "redirect-blocked"
  | "not-pdf"
  | "network";

const failureMessages: Record<IeeePdfReason, string> = {
  "source-hidden": "尚未找到文件来源 / PDF source is not visible.",
  "site-permission": "需要允许访问 IEEE / Grant access to IEEE first.",
  "login-required": "登录状态不可用，请回原页面登录后重试 / Return to IEEE to sign in, then retry.",
  "access-restricted": "来源拒绝访问，请回原页面确认访问权限 / The source denied access; return to the original page to confirm access.",
  "redirect-blocked": "该来源需要跳转，请在原页面下载后选择文件 / Download from the original page, then choose the file.",
  "not-pdf": "返回内容不是 PDF / The response is not a PDF.",
  "network": "网络读取失败，可能是网络问题或网站跳转 / Network read failed; a network problem or a site redirect may be involved.",
};

export class IeeePdfError extends Error {
  readonly stage?: PdfResponseError["stage"];
  readonly diagnostic: IeeePdfDiagnostic;
  constructor(
    readonly reason: IeeePdfReason,
    responseError?: PdfResponseError,
    diagnostic = createIeeePdfDiagnostic({ id: createIeeePdfReadId(), phase: "identify", startedAt: 0, now: 0 }),
  ) {
    super(responseError?.message ?? failureMessages[reason]);
    this.name = "IeeePdfError";
    this.stage = responseError?.stage;
    this.diagnostic = diagnostic;
  }
}

export interface IeeePdfReadOptions {
  onProgress?: (diagnostic: IeeePdfDiagnostic) => void;
  onActivity?: (byteLength: number) => void;
  /** Only a verified top-level IEEE content script can rely on the backend's grant. */
  sourcePage?: boolean;
}

/** Only this issuer can participate in an IEEE session handoff. */
export function ieeeSourceUrl(raw: string, base?: string): URL {
  try {
    // URL drops empty userinfo; reject it before normalization as well.
    const value = raw.trim();
    const absolute = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
    const authority = value.match(/^(?:https:)?\/\/([^/?#]+)/i)?.[1];
    if ((absolute && !authority) || authority?.includes("@") || /[\u0000-\u001f\u007f\\]/.test(value)) throw Error();
    const url = new URL(raw, base);
    if (url.origin !== IEEE_ORIGIN || url.username || url.password) throw Error();
    url.hash = "";
    return url;
  } catch {
    throw new IeeePdfError("source-hidden");
  }
}

/** Read actual element attributes in inert template content; never run scripts. */
export function parseIeeePdfSource(html: string, pageUrl: string): string {
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
  options?: IeeePdfReadOptions,
): Promise<Uint8Array> {
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
  diagnostic: (details?: { status?: number; mime?: string }) => IeeePdfDiagnostic,
): Promise<Response> {
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
