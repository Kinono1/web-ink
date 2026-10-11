import { ieeePaperUrl } from "./context";
import { ieeeSourceUrl } from "./ieee";
import { parseDoi, pdfDoi, type PdfMetadataInput } from "./metadata";

const IDENTITY_PREFIX = "ui.pdfPaperIdentity.";
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_SOURCE_URL_LENGTH = 8192;

export type PdfPaperIdentity = { doi: string; paperUrl?: string };

export function doiUrl(value: unknown): string | undefined {
  const doi = parseDoi(value);
  return doi ? `https://doi.org/${encodeURI(doi)}` : undefined;
}

export async function learnPdfPaperIdentity(
  documentHash: string,
  metadata: PdfMetadataInput,
  sourceUrl?: string,
): Promise<PdfPaperIdentity | undefined> {
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
  sourceUrl?: string,
): Promise<PdfPaperIdentity | undefined> {
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

function observedPaperUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_SOURCE_URL_LENGTH ||
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
