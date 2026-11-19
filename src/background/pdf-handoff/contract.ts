import { isKnownPdfViewer, publicPdfSource } from "../../core/pdf-context";
import type { PdfNavigationErrorCode } from "../../core/model";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class PdfNavigationError extends Error {
  constructor(readonly code: PdfNavigationErrorCode, message: string) { super(message); }
}
export type Input = {
  type: string; tabId?: number; windowId?: number; expectedUrl?: string; candidateUrl?: string;
  token?: string; accessMode?: "public" | "site-session"; index?: number;
};
export function pageUrl(raw: string): string {
  try { return new URL(raw).href; } catch { throw new PdfNavigationError("INVALID_INPUT", "Invalid page URL."); }
}
export function ownPage(raw: string | undefined, name: string): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw), own = new URL(chrome.runtime.getURL(name));
    return url.protocol === own.protocol && url.host === own.host && url.pathname === own.pathname;
  } catch { return false; }
}
export function returnUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return undefined;
    if (["http:", "https:", "file:"].includes(url.protocol) || isKnownPdfViewer(raw)) return url.href;
    return undefined;
  } catch { return undefined; }
}
export function parseInput(raw: unknown): Input {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PdfNavigationError("INVALID_INPUT", "Invalid PDF request.");
  const input = { ...raw } as Input;
  const reader = isReaderRequest(input.type);
  const fields = reader ? ["type", "token"] : ["type", "tabId", "windowId", "expectedUrl"];
  if (input.type === 'pdf.prepared.chunk') fields.push('index');
  if (input.type === "pdf.openCurrent") fields.push("candidateUrl", "accessMode");
  if (Object.keys(raw).some(key => !fields.includes(key))) throw new PdfNavigationError("INVALID_INPUT", "Invalid PDF request fields.");
  if (input.type === 'pdf.prepared.chunk' && (!Number.isInteger(input.index) || input.index! < 0))
    throw new PdfNavigationError('INVALID_INPUT', 'Invalid PDF chunk index.');
  if (input.accessMode !== undefined && input.accessMode !== "public" && input.accessMode !== "site-session")
    throw new PdfNavigationError("INVALID_INPUT", "Invalid PDF access mode.");
  if (reader) {
    if (typeof input.token !== "string" || !UUID.test(input.token)) throw new PdfNavigationError("INVALID_INPUT", "Invalid return session.");
    return input;
  }
  if (input.tabId !== undefined && (!Number.isInteger(input.tabId) || input.tabId < 0)) throw new PdfNavigationError("INVALID_INPUT", "Invalid tab.");
  if (input.windowId !== undefined && (!Number.isInteger(input.windowId) || input.windowId < 0)) throw new PdfNavigationError("INVALID_INPUT", "Invalid window.");
  if (input.expectedUrl !== undefined) {
    if (typeof input.expectedUrl !== "string" || input.expectedUrl.length > 8192) throw new PdfNavigationError("INVALID_INPUT", "Invalid page URL.");
    input.expectedUrl = pageUrl(input.expectedUrl);
  }
  if (input.candidateUrl !== undefined) {
    if (typeof input.candidateUrl !== "string" || input.candidateUrl.length > 8192 || !publicPdfSource(input.candidateUrl))
      throw new PdfNavigationError("INVALID_INPUT", "Choose a public HTTPS PDF source.");
    input.candidateUrl = publicPdfSource(input.candidateUrl);
  }
  return input;
}

export function isReaderRequest(type: string): boolean {
  return type === "pdf.handoff.get" || type === "pdf.handoff.revoke" ||
    type === "pdf.returnOriginal" || type.startsWith("pdf.prepared.");
}

export function navigationChanged(): PdfNavigationError {
  return new PdfNavigationError("PAGE_CHANGED", "The tab or document changed. Try again on the current page.");
}
