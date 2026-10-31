import { request } from "../core/client";
import type { AnnotationCursor, AnnotationPage, PdfTarget } from "../core/model";
import { ieeePaperUrl } from "../core/pdf-context";
import { ieeeSourceUrl } from "./ieee";

const MAX_INPUT_LENGTH = 4096;
const MAX_DOI_LENGTH = 200;
const MAX_DISPLAY_LENGTH = 500;
const MAX_PAGES_PER_SOURCE = 20;
const MAX_SOURCE_URL_LENGTH = 8192;
const IDENTITY_PREFIX = "ui.pdfPaperIdentity.";
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const DOI_PATTERN = /^10\.\d{4,9}\/[A-Z0-9._;()/:+-]+$/i;
const INVALID_TEXT_PATTERN =
  /[\p{Surrogate}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
type PdfMetadata = { get(name: string): unknown };
export type PdfMetadataInput = { info?: object; metadata?: PdfMetadata | null; };

export function pdfDoi(input: PdfMetadataInput): string | undefined {
  return parseDoi(readMetadata(input, "prism:doi")) ??
    parseDoi(readMetadata(input, "dc:identifier"));
}

export function pdfDisplayName(input: PdfMetadataInput, fallback: string): string {
  const metadataTitle = cleanText(readMetadata(input, "dc:title"));
  const infoTitle = cleanText(readInfoTitle(input));
  const title = metadataTitle || infoTitle;
  const doi = pdfDoi(input);
  if (title) {
    const suffix = doi ? ` — DOI: ${doi}` : "";
    return `${truncateUtf16(title, MAX_DISPLAY_LENGTH - suffix.length)}${suffix}`;
  }
  if (doi) return `DOI: ${doi}`;
  return truncateUtf16(cleanText(fallback) || "PDF", MAX_DISPLAY_LENGTH);
}
function readMetadata(input: PdfMetadataInput, name: string): unknown {
  try {
    return input?.metadata?.get(name);
  } catch {
    return undefined;
  }
}
function readInfoTitle(input: PdfMetadataInput): unknown {
  try {
    return (input?.info as { Title?: unknown } | undefined)?.Title;
  } catch {
    return undefined;
  }
}
function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_INPUT_LENGTH) return;
  if (INVALID_TEXT_PATTERN.test(value)) return;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

export function parseDoi(value: unknown): string | undefined {
  const text = cleanText(value);
  if (!text) return;
  if (/^doi:/i.test(text)) return normalizeDoi(text.slice(4).trim());
  if (/^https:/i.test(text)) return doiFromUrl(text);
  return normalizeDoi(text);
}
function doiFromUrl(value: string): string | undefined {
  const match = /^https:\/\/doi\.org\/([^?#]*)$/i.exec(value);
  if (!match) return;
  try {
    return normalizeDoi(decodeURIComponent(match[1]!));
  } catch {
    return;
  }
}
function normalizeDoi(value: string): string | undefined {
  if (value.length > MAX_DOI_LENGTH || !DOI_PATTERN.test(value)) return;
  return value;
}
function truncateUtf16(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = maxLength;
  const lastIncluded = value.charCodeAt(end - 1);
  if (lastIncluded >= 0xd800 && lastIncluded <= 0xdbff) end -= 1;
  return value.slice(0, end).trimEnd();
}
/** Detection only: source identity never authorizes applying another hash's marks. */
export async function findPreviousPdfVersion(
  documentHash: string,
  sources: string[],
  signal: AbortSignal) : Promise<{ hash?: string; incomplete: boolean }> {
  const observedSources = new Set(sources);
  let incomplete = false;
  for (const source of observedSources) {
    let cursor: AnnotationCursor | undefined;
    for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_SOURCE; pageNumber++) {
      if (signal.aborted) return { incomplete: true };
      const requestId = crypto.randomUUID();
      const cancel = () => {
        void request({ type: "annotations.query.cancel", requestId }).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      let page: AnnotationPage;
      try {
        page = await request<AnnotationPage>({
          type: "annotations.query",
          query: { text: source, limit: 50, requestId, ...(cursor ? { cursor } : {}) },
        });
      } catch {
        incomplete = true;
        break;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
      if (signal.aborted) return { incomplete: true };
      if (page.cancelled) {
        incomplete = true;
        break;
      }
      for (const record of page.items) {
        if ((record.kind === "pdf-text" || record.kind === "pdf-area") &&
          record.target.sourceUrl && observedSources.has(record.target.sourceUrl) &&
          record.target.documentHash !== documentHash) {
          return { hash: record.target.documentHash, incomplete: false };
        }
      }
      const next = page.nextCursor;
      if (!next) break;
      // The query service orders [updatedAt, id] descending. A stalled or
      // reversing cursor cannot establish that the remaining history was read.
      if (pageNumber + 1 === MAX_PAGES_PER_SOURCE || (cursor &&
        (next.updatedAt > cursor.updatedAt ||
          (next.updatedAt === cursor.updatedAt && next.id >= cursor.id)))) {
        incomplete = true;
        break;
      }
      cursor = next;
    }
  }
  return { incomplete };
}
export type PdfPaperIdentity = { doi: string; paperUrl?: string };

export function doiUrl(value: unknown): string | undefined {
  const doi = parseDoi(value);
  return doi ? `https://doi.org/${encodeURI(doi)}` : undefined;
}

export async function learnPdfPaperIdentity(
  documentHash: string,
  metadata: PdfMetadataInput,
  sourceUrl?: string) : Promise<PdfPaperIdentity | undefined> {
  const key = storageKey(documentHash);
  const doi = pdfDoi(metadata);
  if (!key || !doi) return undefined;
  const paperUrl = observedPaperUrl(sourceUrl);
  const identity = paperUrl ? { doi, paperUrl } : { doi };
  // Optional preferences must never delay the reader's first paint.
  void persistIdentity(key, identity);
  return identity;
}

export async function readPdfPaperIdentity(
  documentHash: string | undefined,
  sourceUrl?: string) : Promise<PdfPaperIdentity | undefined> {
  const key = storageKey(documentHash);
  try {
    if (key) {
      const values = await chrome.storage.local.get(key);
      const exact = isRecord(values) && Object.hasOwn(values, key)
        ? storedIdentity(values[key]) : undefined;
      if (exact) return exact;
    }
    const paperUrl = observedPaperUrl(sourceUrl);
    if (!paperUrl) return undefined;
    // This scan belongs to an explicit paper-recovery action, never startup.
    const values = await chrome.storage.local.get(null);
    if (!isRecord(values)) return undefined;
    let match: PdfPaperIdentity | undefined;
    for (const [candidateKey, value] of Object.entries(values)) {
      if (!candidateKey.startsWith(IDENTITY_PREFIX) ||
        !storageKey(candidateKey.slice(IDENTITY_PREFIX.length))) continue;
      const identity = storedIdentity(value);
      if (identity?.paperUrl !== paperUrl) continue;
      if (match && match.doi.toLowerCase() !== identity.doi.toLowerCase()) return undefined;
      match ??= identity;
    }
    return match;
  } catch {
    return undefined;
  }
}
function storageKey(documentHash: string | undefined): string | undefined {
  if (typeof documentHash !== "string" || !HASH_PATTERN.test(documentHash)) return undefined;
  return `${IDENTITY_PREFIX}${documentHash.toLowerCase()}`;
}
async function persistIdentity(key: string, identity: PdfPaperIdentity): Promise<void> {
  let snapshot = { ...identity };
  try {
    if (!snapshot.paperUrl) {
      const values = await chrome.storage.local.get(key);
      const previous = isRecord(values) && Object.hasOwn(values, key)
        ? storedIdentity(values[key]) : undefined;
      if (previous?.paperUrl && previous.doi.toLowerCase() === snapshot.doi.toLowerCase())
        snapshot = { ...snapshot, paperUrl: previous.paperUrl };
    }
    await chrome.storage.local.set({ [key]: snapshot });
  } catch {
    // Explicit PDF metadata remains usable even if preferences are unavailable.
  }
}
function observedPaperUrl(value: unknown, maxLength = MAX_SOURCE_URL_LENGTH): string | undefined {
  if (typeof value !== "string" || value.length > maxLength ||
    /[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  try {
    const source = ieeeSourceUrl(value);
    if (source.pathname.toLowerCase() === "/stamp/stamp.jsp" &&
      source.searchParams.getAll("arnumber").length !== 1) return undefined;
    return ieeePaperUrl(source.href);
  } catch {
    return undefined;
  }
}
function storedIdentity(value: unknown): PdfPaperIdentity | undefined {
  if (!isRecord(value)) return undefined;
  try {
    if (!Object.hasOwn(value, "doi")) return undefined;
    const doi = parseDoi(value.doi);
    if (!doi) return undefined;
    if (value.paperUrl === undefined) return { doi };
    const paperUrl = observedPaperUrl(value.paperUrl);
    return paperUrl ? { doi, paperUrl } : undefined;
  } catch {
    return undefined;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export type PdfPaperReopen = { documentHash: string; pageNumber: number };
type ReopenIntent = PdfPaperReopen & { paperUrl?: string; doi?: string; expiresAt: number };
function reopenStorageKey(tabId?: number): string | undefined {
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
  const key = reopenStorageKey(tabId);
  const paper = observedPaperUrl(target.sourceUrl, Infinity);
  const identifier = parseDoi(doi) || parseDoi(target.sourceUrl);
  if (!key || !validTarget(target) || (!paper && !identifier)) return;
  const entry: ReopenIntent = { documentHash: target.documentHash, pageNumber: target.pageNumber,
    ...(paper ? { paperUrl: paper } : {}), ...(identifier ? { doi: identifier } : {}),
    expiresAt: Date.now() + 30 * 60000 };
  try { await chrome.storage.session.set({ [key]: entry }); }
  catch { /* The paper can still open without a page hint. */ }
}

export async function readPdfPaperReopen(source?: string, doi?: string, tabId?: number): Promise<PdfPaperReopen | undefined> {
  const key = reopenStorageKey(tabId);
  if (!key) return;
  try {
    const values = await chrome.storage.session.get([key]);
    const entry = values[key] as Partial<ReopenIntent> | undefined;
    if (!validTarget(entry) || !Number.isFinite(entry.expiresAt) || entry.expiresAt! <= Date.now()) {
      await chrome.storage.session.remove(key);
      return;
    }
    const paper = observedPaperUrl(source, Infinity);
    const identifier = parseDoi(doi);
    if (!(paper && paper === entry.paperUrl) &&
      !(identifier && identifier.toLowerCase() === parseDoi(entry.doi)?.toLowerCase())) return;
    await chrome.storage.session.remove(key);
    return { documentHash: entry.documentHash, pageNumber: entry.pageNumber };
  } catch { /* Unavailable intent falls back to the normal reading position. */ }
}
