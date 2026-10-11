const MAX_INPUT_LENGTH = 4096;
const MAX_DOI_LENGTH = 200;
const MAX_DISPLAY_LENGTH = 500;
const DOI_PATTERN = /^10\.\d{4,9}\/[A-Z0-9._;()/:+-]+$/i;
const INVALID_TEXT_PATTERN =
  /[\p{Surrogate}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

type PdfMetadata = { get(name: string): unknown };
export type PdfMetadataInput = {
  info?: object;
  metadata?: PdfMetadata | null;
};

export function pdfDoi(input: PdfMetadataInput): string | undefined {
  return (
    parseDoi(readMetadata(input, "prism:doi")) ??
    parseDoi(readMetadata(input, "dc:identifier"))
  );
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
