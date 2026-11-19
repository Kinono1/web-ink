import type { PdfHandoff } from "../../core/model";
import { isIeeeSessionPage, publicPdfSource } from "../../core/pdf-context";
import { PdfNavigationError, returnUrl, UUID } from "./contract";

const prefix = "pdf.handoff.";
export const handoffKey = (token: string) => prefix + token;

export async function removeTabHandoffs(tabId: number): Promise<void> {
  const entries = await chrome.storage.session.get(null);
  const keys = Object.keys(entries).filter(key => {
    const value = entries[key];
    return key.startsWith(prefix) && value !== null && typeof value === "object" &&
      "tabId" in value && value.tabId === tabId;
  });
  if (keys.length) await chrome.storage.session.remove(keys);
}

export async function readHandoff(token: string, tabId: number): Promise<PdfHandoff | null> {
  let stored: unknown;
  try { stored = (await chrome.storage.session.get(handoffKey(token)))[handoffKey(token)]; }
  catch { throw new PdfNavigationError("STORAGE_UNAVAILABLE", "Return context is unavailable. Open the source or choose a local PDF."); }
  if (!stored) return null;
  const handoff = stored as PdfHandoff;
  if (handoff.token !== token || handoff.tabId !== tabId) throw new PdfNavigationError("FORBIDDEN", "This return session belongs to another tab.");
  const original = returnUrl(handoff.returnUrl);
  if (!original || (handoff.sourceUrl !== undefined && !publicPdfSource(handoff.sourceUrl))) return null;
  const siteSession = handoff.accessMode === "site-session";
  if (siteSession && (!isIeeeSessionPage(original) || handoff.allowedOrigin !== "https://ieeexplore.ieee.org" ||
    !Number.isFinite(handoff.expiresAt) || (handoff.readerDocumentId !== undefined && typeof handoff.readerDocumentId !== "string") ||
    (handoff.sourceUrl && new URL(handoff.sourceUrl).origin !== handoff.allowedOrigin))) return null;
  return { token, tabId, returnUrl: original, ...(handoff.sourceUrl ? { sourceUrl: handoff.sourceUrl } : {}),
    ...(siteSession ? { accessMode: "site-session", allowedOrigin: handoff.allowedOrigin, expiresAt: handoff.expiresAt,
      ...(typeof handoff.preparedToken === 'string' && UUID.test(handoff.preparedToken) ? { preparedToken: handoff.preparedToken } : {}),
      ...(handoff.readerDocumentId ? { readerDocumentId: handoff.readerDocumentId } : {}) } : {}) };
}
