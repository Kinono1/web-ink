import { MAX_PDF_BYTES, pdfHash, verifyPdf } from "../core/pdf-source";
import { PDF_CHUNK_BYTES, type PreparedInfo } from "../core/prepared-contract";

export const PREPARED_CHUNK_BYTES = PDF_CHUNK_BYTES;
export const PREPARED_TTL_MS = 120_000;
const UPLOAD_TTL_MS = 60_000;

export type Owner = { tabId: number; documentId: string; generation: string };
export interface PreparedPdfStore {
  begin(owner: Owner): string;
  touch(token: string, owner: Owner): void;
  append(token: string, owner: Owner, index: number, data: string): void;
  finish(token: string, owner: Owner, expectedByteLength: number): Promise<PreparedInfo>;
  claim(token: string, reader: Owner): PreparedInfo;
  chunk(token: string, reader: Owner, index: number): string;
  release(token: string, owner: Owner): void;
  releaseTab(tabId: number): void;
  dispose(): void;
  peekToken(tabId: number): string | undefined;
}

type Lifetime = { token: string; source: Owner; expiresAt: number; timer?: ReturnType<typeof setTimeout> };
type UploadRecord = Lifetime & {
  stage: "uploading" | "finishing"; pages: Uint8Array[]; byteLength: number; nextUploadIndex: number; bytes?: Uint8Array;
};
type ReadyRecord = Lifetime & { stage: "ready"; bytes: Uint8Array; hash: string; reader?: Owner; nextReadIndex: number };
type ActiveRecord = UploadRecord | ReadyRecord;

const sameOwner = (left: Owner, right: Owner): boolean =>
  left.tabId === right.tabId && left.documentId === right.documentId && left.generation === right.generation;

function decodeChunk(data: string): Uint8Array {
  if (typeof data !== "string" || !data.length) throw Error("Empty or invalid prepared PDF chunk.");
  if (data.length > 4 * Math.ceil(PREPARED_CHUNK_BYTES / 3)) throw Error("Prepared PDF chunk exceeds 256 KiB.");
  if (data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Error("Invalid prepared PDF chunk base64.");
  let binary: string;
  try { binary = atob(data); } catch { throw Error("Invalid prepared PDF chunk base64."); }
  if (btoa(binary) !== data) throw Error("Noncanonical prepared PDF chunk base64.");
  if (binary.length > PREPARED_CHUNK_BYTES) throw Error("Prepared PDF chunk exceeds 256 KiB.");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const infoFor = (record: ReadyRecord): PreparedInfo => ({
  token: record.token, byteLength: record.bytes.length, hash: record.hash,
  chunks: Math.ceil(record.bytes.length / PREPARED_CHUNK_BYTES),
});

/** One background-owned RAM slot; retained buffers are wiped on disposal. */
export function createPreparedPdfStore(generation: string): PreparedPdfStore {
  if (typeof generation !== "string" || !generation.trim()) throw Error("Invalid prepared PDF generation.");
  let active: ActiveRecord | undefined;
  let disposed = false;

  function ownerFor(owner: Owner): Owner {
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) throw Error("Invalid prepared PDF owner.");
    const { tabId, documentId, generation: ownerGeneration } = owner;
    if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof documentId !== "string" || !documentId.trim())
      throw Error("Invalid prepared PDF owner.");
    if (ownerGeneration !== generation) throw Error("Prepared PDF generation does not match.");
    return { tabId, documentId, generation: ownerGeneration };
  }

  function clear(): void {
    if (!active) return;
    clearTimeout(active.timer);
    if (active.stage === "ready") active.bytes.fill(0);
    else {
      for (const page of active.pages) page.fill(0);
      active.pages.length = 0;
      active.bytes?.fill(0);
      active.bytes = undefined;
    }
    active = undefined;
  }

  function current(): ActiveRecord | undefined {
    if (active && Date.now() >= active.expiresAt) clear();
    return active;
  }

  function expireAfter(record: ActiveRecord, milliseconds: number): void {
    clearTimeout(record.timer);
    record.expiresAt = Date.now() + milliseconds;
    record.timer = setTimeout(() => { if (active === record) clear(); }, milliseconds);
  }

  function recordFor(token: string): ActiveRecord {
    const record = current();
    if (!record || record.token !== token) throw Error("Prepared PDF is unavailable.");
    return record;
  }

  function sourceRecord(token: string, owner: Owner): ActiveRecord {
    const record = recordFor(token);
    if (!sameOwner(record.source, ownerFor(owner))) throw Error("Prepared PDF belongs to another document.");
    return record;
  }

  function readyRecord(token: string): ReadyRecord {
    const record = recordFor(token);
    if (record.stage !== "ready") throw Error("Prepared PDF is not ready.");
    return record;
  }

  return {
    begin(owner) {
      if (disposed) throw Error("Prepared PDF store is disposed.");
      const source = ownerFor(owner);
      if (current()) throw Error("Prepared PDF store is busy.");
      const record: UploadRecord = {
        token: crypto.randomUUID(), source, expiresAt: 0,
        stage: "uploading", pages: [], byteLength: 0, nextUploadIndex: 0,
      };
      active = record;
      expireAfter(record, UPLOAD_TTL_MS);
      return record.token;
    },
    touch(token, owner) {
      const record = sourceRecord(token, owner);
      if (record.stage !== "uploading") throw Error("Prepared PDF upload is closed.");
      expireAfter(record, UPLOAD_TTL_MS);
    },
    append(token, owner, index, data) {
      const record = sourceRecord(token, owner);
      if (record.stage !== "uploading") throw Error("Prepared PDF upload is closed.");
      if (!Number.isSafeInteger(index) || index !== record.nextUploadIndex) throw Error("Invalid prepared PDF upload index.");
      const bytes = decodeChunk(data);
      if (record.byteLength + bytes.length > MAX_PDF_BYTES) throw Error("Prepared PDF exceeds 50 MiB.");
      // Packing prevents one-byte uploads from retaining millions of array objects.
      let offset = 0;
      while (offset < bytes.length) {
        const pageIndex = Math.floor(record.byteLength / PREPARED_CHUNK_BYTES);
        let page = record.pages[pageIndex];
        if (!page) { page = new Uint8Array(PREPARED_CHUNK_BYTES); record.pages.push(page); }
        const pageOffset = record.byteLength % PREPARED_CHUNK_BYTES;
        const length = Math.min(bytes.length - offset, PREPARED_CHUNK_BYTES - pageOffset);
        page.set(bytes.subarray(offset, offset + length), pageOffset);
        offset += length;
        record.byteLength += length;
      }
      record.nextUploadIndex++;
      expireAfter(record, UPLOAD_TTL_MS);
    },
    async finish(token, owner, expectedByteLength) {
      const record = sourceRecord(token, owner);
      if (record.stage !== "uploading") throw Error("Prepared PDF upload is closed.");
      record.stage = "finishing";
      try {
        if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 1 || expectedByteLength > MAX_PDF_BYTES)
          throw Error("Invalid expected prepared PDF byte length.");
        if (record.byteLength !== expectedByteLength) throw Error("Prepared PDF byte length does not match expected length.");
        const bytes = new Uint8Array(record.byteLength);
        record.bytes = bytes;
        let offset = 0;
        for (const page of record.pages) {
          const length = Math.min(page.length, bytes.length - offset);
          bytes.set(page.subarray(0, length), offset);
          offset += length;
          page.fill(0);
        }
        record.pages.length = 0;
        verifyPdf(bytes);
        const hash = await pdfHash(bytes);
        // Hashing can complete after cancellation or replacement of the one slot.
        if (current() !== record) throw Error("Prepared PDF is no longer available.");
        const ready: ReadyRecord = {
          token: record.token, source: record.source, expiresAt: 0,
          stage: "ready", bytes, hash, nextReadIndex: 0,
        };
        clearTimeout(record.timer);
        record.bytes = undefined;
        active = ready;
        expireAfter(ready, PREPARED_TTL_MS);
        return infoFor(ready);
      } catch (error) {
        if (active === record) clear();
        throw error;
      }
    },
    claim(token, reader) {
      const record = readyRecord(token);
      const actor = ownerFor(reader);
      if (actor.tabId !== record.source.tabId) throw Error("Prepared PDF belongs to another tab.");
      if (actor.documentId === record.source.documentId) throw Error("Source document cannot claim prepared PDF.");
      if (record.reader && !sameOwner(record.reader, actor)) throw Error("Prepared PDF belongs to another reader document.");
      record.reader ??= actor;
      return infoFor(record);
    },
    chunk(token, reader, index) {
      const record = readyRecord(token);
      const actor = ownerFor(reader);
      if (!record.reader || !sameOwner(record.reader, actor)) throw Error("Prepared PDF reader is not bound to this document.");
      const chunks = Math.ceil(record.bytes.length / PREPARED_CHUNK_BYTES);
      if (!Number.isSafeInteger(index) || index < 0 || index >= chunks ||
        (index !== record.nextReadIndex && index !== record.nextReadIndex - 1))
        throw Error("Invalid prepared PDF reader chunk index.");
      const start = index * PREPARED_CHUNK_BYTES;
      const end = Math.min(start + PREPARED_CHUNK_BYTES, record.bytes.length);
      let binary = "";
      for (let offset = start; offset < end; offset += 8192)
        binary += String.fromCharCode(...record.bytes.subarray(offset, Math.min(offset + 8192, end)));
      const data = btoa(binary);
      if (index === record.nextReadIndex) record.nextReadIndex++;
      return data;
    },
    release(token, owner) {
      const record = current();
      if (!record || record.token !== token) return;
      const actor = ownerFor(owner);
      if (!sameOwner(record.source, actor) && !(record.stage === "ready" && record.reader && sameOwner(record.reader, actor)))
        throw Error("Prepared PDF belongs to another document.");
      clear();
    },
    releaseTab(tabId) { if (current()?.source.tabId === tabId) clear(); },
    dispose() { disposed = true; clear(); },
    peekToken(tabId) {
      const record = current();
      return record?.source.tabId === tabId ? record.token : undefined;
    },
  };
}
