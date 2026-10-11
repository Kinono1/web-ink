import { PdfResponseError, readResponseBytes, verifyPdf } from "./source";
import { isIeeeDocumentPath } from "./context";

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
  constructor(readonly reason: IeeePdfReason, responseError?: PdfResponseError) {
    super(responseError?.message ?? failureMessages[reason]);
    this.name = "IeeePdfError";
    this.stage = responseError?.stage;
  }
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
): Promise<Uint8Array> {
  try {
    signal.throwIfAborted();
    const page = ieeeSourceUrl(input.pageUrl);
    let source = input.sourceUrl === undefined ? undefined : ieeeSourceUrl(input.sourceUrl);
    const wrapper = page.pathname.toLowerCase() === "/stamp/stamp.jsp";
    const documentEmbed = isIeeeDocumentPath(page.pathname) && source !== undefined;
    if (!wrapper && !documentEmbed && source?.href !== page.href) throw new IeeePdfError("source-hidden");
    if (!source) {
      const response = await fetchIeee(page, signal);
      const bytes = await readResponseBytes(response, MAX_WRAPPER_BYTES);
      signal.throwIfAborted();
      source = ieeeSourceUrl(parseIeeePdfSource(new TextDecoder().decode(bytes), page.href));
    }
    const response = await fetchIeee(source, signal);
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mime === "text/html" || mime === "application/xhtml+xml") {
      await response.body?.cancel().catch(() => undefined);
      throw new IeeePdfError("not-pdf");
    }
    const bytes = await readResponseBytes(response);
    signal.throwIfAborted();
    try { return verifyPdf(bytes); } catch { throw new IeeePdfError("not-pdf"); }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof IeeePdfError || (error instanceof Error && error.name === "AbortError")) throw error;
    if (error instanceof PdfResponseError) throw new IeeePdfError("network", error);
    // redirect:error and a network failure both reject opaquely; do not guess.
    throw new IeeePdfError("network");
  }
}

async function fetchIeee(url: URL, signal: AbortSignal): Promise<Response> {
  if (!(await chrome.permissions.contains({ origins: [`${IEEE_ORIGIN}/*`] })))
    throw new IeeePdfError("site-permission");
  signal.throwIfAborted();
  const response = await fetch(url, {
    signal, credentials: "include", cache: "no-store", redirect: "error",
  });
  let reason: IeeePdfReason | undefined;
  if (response.redirected || response.type === "opaqueredirect" || [300, 301, 302, 303, 307, 308].includes(response.status))
    reason = "redirect-blocked";
  if (response.url) {
    try {
      if (ieeeSourceUrl(response.url).href !== url.href) reason = "redirect-blocked";
    } catch { reason = "redirect-blocked"; }
  }
  if (!reason && response.status === 401) reason = "login-required";
  if (!reason && response.status === 403) reason = "access-restricted";
  if (!reason && !response.ok) reason = "network";
  if (reason) {
    await response.body?.cancel().catch(() => undefined);
    throw new IeeePdfError(reason);
  }
  return response;
}
