import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { PdfRect } from "../core/model";
import type { NativePdfAnnotation, NativePdfAnnotationReply } from "./types";

const noteSubtypes = new Set([
  "Text", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine",
  "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink",
  "Redact", "FileAttachment", "Popup",
]);

export function nativePdfAnnotationKey(hash: string, pageNumber: number, id: string): string {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(pageNumber) || pageNumber < 1 ||
    typeof id !== "string" || !id || id.length > 512) throw new Error("Invalid original PDF annotation identity.");
  return `${hash}:${pageNumber}:${id}`;
}

function string(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length <= limit ? value : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  const body = typeof value === "string" ? value : object(value)?.str;
  if (typeof body === "string" && body.length > 1_000_000)
    throw new Error("An original PDF note exceeds the supported text limit.");
  return string(body, 1_000_000);
}
function numbers(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return;
  const values = Array.from(value as ArrayLike<number>);
  return values.length === length && values.every(v => typeof v === "number" && Number.isFinite(v))
    ? values : undefined;
}

/** PDF defaults for omitted fields match PDF.js; invalid dates remain unknown. */
export function nativePdfDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return;
  const match = /^D:(\d{4})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2}))?)?)?)?)?(?:([Z+-])(?:(\d{2})'?(\d{2})'?)?)?$/.exec(value);
  if (!match) return;
  const year = Number(match[1]), month = Number(match[2] ?? 1), day = Number(match[3] ?? 1);
  const hour = Number(match[4] ?? 0), minute = Number(match[5] ?? 0), second = Number(match[6] ?? 0);
  const zoneHour = Number(match[8] ?? 0), zoneMinute = Number(match[9] ?? 0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 ||
    zoneHour > 23 || zoneMinute > 59 || (match[7] === "Z" && match[8]) ||
    ((match[7] === "+" || match[7] === "-") && !match[8])) return;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return;
  const offset = (zoneHour * 60 + zoneMinute) * 60_000;
  if (match[7] === "+") date.setTime(date.getTime() - offset);
  else if (match[7] === "-") date.setTime(date.getTime() + offset);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
  return date.toISOString();
}

/** Convert a source PDF rectangle to the same unrotated frame as saved marks. */
export function nativePdfRect(rect: unknown, pageBox: unknown): PdfRect | undefined {
  const r = numbers(rect, 4), box = numbers(pageBox, 4);
  if (!r || !box || box[2]! <= box[0]! || box[3]! <= box[1]!) return;
  const width = box[2]! - box[0]!, height = box[3]! - box[1]!;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x = clamp((Math.min(r[0]!, r[2]!) - box[0]!) / width);
  const y = clamp((Math.min(r[1]!, r[3]!) - box[1]!) / height);
  const right = clamp((Math.max(r[0]!, r[2]!) - box[0]!) / width);
  const top = clamp((Math.max(r[1]!, r[3]!) - box[1]!) / height);
  if (right - x < 0.00001 || top - y < 0.00001) return;
  return { x, y, width: right - x, height: top - y };
}

export function parseNativePdfAnnotations(annotations: unknown[], hash: string, pageNumber: number): NativePdfAnnotation[] {
  nativePdfAnnotationKey(hash, pageNumber, "validation");
  const rawById = new Map<string, Record<string, unknown>>();
  const records = new Map<string, NativePdfAnnotation>();
  for (const value of annotations) {
    const raw = object(value);
    const id = string(raw?.id, 512), subtype = string(raw?.subtype, 64);
    if (!raw || !id || !subtype || !noteSubtypes.has(subtype) || records.has(id)) continue;
    const record: NativePdfAnnotation = {
      key: nativePdfAnnotationKey(hash, pageNumber, id), documentHash: hash, pageNumber,
      id, subtype, contents: text(raw.contentsObj) || text(raw.contents) || text(raw.richText) || "",
    };
    const author = string(object(raw.titleObj)?.str ?? raw.title, 4096);
    const createdAt = nativePdfDate(raw.creationDate), updatedAt = nativePdfDate(raw.modificationDate);
    const rect = numbers(raw.rect, 4), color = numbers(raw.color, 3);
    if (author) record.author = author;
    if (createdAt) record.createdAt = createdAt;
    if (updatedAt) record.updatedAt = updatedAt;
    if (rect) record.rect = rect;
    if (color?.every(v => v >= 0 && v <= 255)) record.color = color;
    const inReplyTo = string(raw.inReplyTo, 512), replyType = string(raw.replyType, 64);
    if (inReplyTo) record.inReplyTo = inReplyTo;
    if (replyType) record.replyType = replyType;
    rawById.set(id, raw);
    records.set(id, record);
  }

  // PDF.js 6 exposes popupRef on the parent, rather than parentId on Popup.
  const popupParents = new Map<string, string>();
  for (const [id, raw] of rawById) {
    const popupRef = string(raw.popupRef, 512);
    if (popupRef && !popupParents.has(popupRef)) popupParents.set(popupRef, id);
  }
  for (const [id, popup] of records) {
    if (popup.subtype !== "Popup") continue;
    const parentId = string(rawById.get(id)?.parentId, 512) ?? popupParents.get(id);
    const parent = parentId ? records.get(parentId) : undefined;
    if (!parent || parent.subtype === "Popup") continue;
    if (!parent.contents) parent.contents = popup.contents;
    parent.author ??= popup.author;
    parent.createdAt ??= popup.createdAt;
    parent.updatedAt ??= popup.updatedAt;
    parent.color ??= popup.color;
    parent.rect ??= numbers(rawById.get(id)?.parentRect, 4);
    if (popup.contents && popup.contents !== parent.contents) {
      if ((parent.replies?.length ?? 0) >= 500)
        throw new Error("An original PDF annotation exceeds 500 replies.");
      (parent.replies ??= []).push({ id, subtype: "Popup", contents: popup.contents,
        author: popup.author, createdAt: popup.createdAt, updatedAt: popup.updatedAt });
    }
    records.delete(id);
  }

  // null marks a cycle and every path leading to it. Those records retain
  // their individual identities; ordinary ancestry shares its cached root.
  const roots = new Map<string, NativePdfAnnotation | null>();
  function resolveRoot(record: NativePdfAnnotation): NativePdfAnnotation {
    const cached = roots.get(record.id);
    if (cached !== undefined) return cached ?? record;
    const path: NativePdfAnnotation[] = [];
    const seen = new Set<string>();
    let parent = record;
    let resolved: NativePdfAnnotation | null;
    while (true) {
      const known = roots.get(parent.id);
      if (known !== undefined) { resolved = known; break; }
      if (seen.has(parent.id)) { resolved = null; break; }
      seen.add(parent.id);
      path.push(parent);
      const ancestor = parent.inReplyTo ? records.get(parent.inReplyTo) : undefined;
      if (!ancestor) { resolved = parent; break; }
      parent = ancestor;
    }
    for (const item of path) roots.set(item.id, resolved);
    return resolved ?? record;
  }
  const result: NativePdfAnnotation[] = [];
  for (const record of records.values()) {
    const parent = resolveRoot(record);
    if (parent === record) {
      if (result.length >= 50_000) throw new Error("Original PDF metadata exceeds 50,000 parent records.");
      result.push(record);
      continue;
    }
    if (record.replyType === "Group" && record.contents === parent.contents && record.author === parent.author) continue;
    if ((parent.replies?.length ?? 0) + 1 + (record.replies?.length ?? 0) > 500)
      throw new Error("An original PDF annotation exceeds 500 replies.");
    const reply: NativePdfAnnotationReply = {
      id: record.id, subtype: record.subtype, contents: record.contents, author: record.author,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      inReplyTo: record.inReplyTo, replyType: record.replyType,
    };
    (parent.replies ??= []).push(reply, ...(record.replies ?? []));
  }
  return result;
}

function abortError(): DOMException {
  return new DOMException("Original PDF note loading was cancelled.", "AbortError");
}
function abortable<T>(promise: Promise<T>, signals: AbortSignal[]): Promise<T> {
  if (signals.some(signal => signal.aborted)) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signals.forEach(signal => signal.removeEventListener("abort", cancel));
    const cancel = () => { cleanup(); reject(abortError()); };
    signals.forEach(signal => signal.addEventListener("abort", cancel, { once: true }));
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Owns metadata only; page canvases and the PDF.js document belong to the reader. */
export class NativePdfAnnotations {
  private readonly pending = new Map<number, Promise<NativePdfAnnotation[]>>();
  private readonly loaded = new Map<number, NativePdfAnnotation[]>();
  private readonly lifetime = new AbortController();
  private recordCount = 0;
  private metadataBytes = 2;
  constructor(private readonly document: PDFDocumentProxy, private readonly hash: string) {
    nativePdfAnnotationKey(hash, 1, "validation");
  }
  get records(): NativePdfAnnotation[] {
    return [...this.loaded].sort(([a], [b]) => a - b).flatMap(([, records]) => records);
  }
  async readPage(pageNumber: number): Promise<NativePdfAnnotation[]> {
    if (this.lifetime.signal.aborted) throw abortError();
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > this.document.numPages)
      throw new Error("Original PDF annotation page is outside this document.");
    const cached = this.pending.get(pageNumber);
    if (cached) return cached;
    const read = (async () => {
      const page = await this.document.getPage(pageNumber);
      if (this.lifetime.signal.aborted) throw abortError();
      const annotations = await page.getAnnotations({ intent: "display" });
      if (this.lifetime.signal.aborted) throw abortError();
      const records = parseNativePdfAnnotations(annotations, this.hash, pageNumber);
      const nextCount = this.recordCount + records.length;
      if (nextCount > 50_000) throw new Error("Original PDF metadata exceeds 50,000 parent records.");
      // Account for one flattened JSON array, including UTF-8 and commas
      // between nonempty pages. Reject this page before publishing any of it.
      const bytes = records.length
        ? new TextEncoder().encode(JSON.stringify(records)).byteLength - 2 + (this.recordCount ? 1 : 0) : 0;
      if (this.metadataBytes + bytes > 20 * 1024 * 1024)
        throw new Error("Original PDF metadata exceeds the 20 MiB session limit.");
      this.loaded.set(pageNumber, records);
      this.recordCount = nextCount;
      this.metadataBytes += bytes;
      return records;
    })();
    this.pending.set(pageNumber, read);
    try { return await read; }
    catch (error) { this.pending.delete(pageNumber); throw error; }
  }
  async loadAll(signal?: AbortSignal, onProgress?: (completed: number, total: number) => void): Promise<NativePdfAnnotation[]> {
    const signals = signal ? [this.lifetime.signal, signal] : [this.lifetime.signal];
    if (signals.some(value => value.aborted)) throw abortError();
    const missing = Array.from({ length: this.document.numPages }, (_, i) => i + 1)
      .filter(page => !this.loaded.has(page));
    onProgress?.(this.loaded.size, this.document.numPages);
    for (let start = 0; start < missing.length; start += 8) {
      if (signals.some(value => value.aborted)) throw abortError();
      await abortable(Promise.all(missing.slice(start, start + 8).map(page => this.readPage(page))), signals);
      if (signals.some(value => value.aborted)) throw abortError();
      onProgress?.(this.loaded.size, this.document.numPages);
      if (start + 8 < missing.length) await abortable(new Promise<void>(resolve => setTimeout(resolve, 0)), signals);
    }
    return this.records;
  }
  dispose(): void {
    this.lifetime.abort();
    this.pending.clear();
    this.loaded.clear();
    this.recordCount = 0;
    this.metadataBytes = 2;
  }
}
