import type { PdfTarget } from "../core/model";
import { ieeePaperUrl } from "./context";
import { ieeeSourceUrl } from "./ieee";
import { parseDoi } from "./metadata";

export type PdfPaperReopen = { documentHash: string; pageNumber: number };
type ReopenIntent = PdfPaperReopen & { paperUrl?: string; doi?: string; expiresAt: number };

function paperUrl(source?: string): string | undefined {
  if (!source || /[\u0000-\u001f\u007f\\]/.test(source)) return;
  try {
    const url = ieeeSourceUrl(source);
    if (url.pathname.toLowerCase() === "/stamp/stamp.jsp" && url.searchParams.getAll("arnumber").length !== 1) return;
    return ieeePaperUrl(url.href);
  } catch { return; }
}

function storageKey(tabId?: number): string | undefined {
  return Number.isSafeInteger(tabId) && tabId! >= 0 ? `pdf.paperReopen.${tabId}` : undefined;
}

function validTarget(value: unknown): value is PdfPaperReopen & Partial<ReopenIntent> {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PdfPaperReopen>;
  return typeof entry.documentHash === "string" && /^[a-f0-9]{64}$/.test(entry.documentHash) &&
    Number.isSafeInteger(entry.pageNumber) && entry.pageNumber! > 0;
}

// One intent per destination tab carries a library choice through sign-in.
// It never treats a DOI as proof of identical bytes or moves saved coordinates.
export async function rememberPdfPaperReopen(target: PdfTarget, doi?: string, tabId?: number): Promise<void> {
  const key = storageKey(tabId);
  const paper = paperUrl(target.sourceUrl);
  const identifier = parseDoi(doi) || parseDoi(target.sourceUrl);
  if (!key || !validTarget(target) || (!paper && !identifier)) return;
  const entry: ReopenIntent = { documentHash: target.documentHash, pageNumber: target.pageNumber,
    ...(paper ? { paperUrl: paper } : {}), ...(identifier ? { doi: identifier } : {}),
    expiresAt: Date.now() + 30 * 60000 };
  try { await chrome.storage.session.set({ [key]: entry }); }
  catch { /* The paper can still open without a page hint. */ }
}

export async function readPdfPaperReopen(source?: string, doi?: string, tabId?: number): Promise<PdfPaperReopen | undefined> {
  const key = storageKey(tabId);
  if (!key) return;
  try {
    const values = await chrome.storage.session.get([key]);
    const entry = values[key] as Partial<ReopenIntent> | undefined;
    if (!validTarget(entry) || !Number.isFinite(entry.expiresAt) || entry.expiresAt! <= Date.now()) {
      await chrome.storage.session.remove(key);
      return;
    }
    const paper = paperUrl(source);
    const identifier = parseDoi(doi);
    if (!(paper && paper === entry.paperUrl) &&
      !(identifier && identifier.toLowerCase() === parseDoi(entry.doi)?.toLowerCase())) return;
    await chrome.storage.session.remove(key);
    return { documentHash: entry.documentHash, pageNumber: entry.pageNumber };
  } catch { /* Unavailable intent falls back to the normal reading position. */ }
}
