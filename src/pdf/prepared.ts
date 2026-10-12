import { MAX_PDF_BYTES, pdfHash, verifyPdf } from './source';
import type { PreparedInfo } from '../background/pdf-prepared';

export const IEEE_PREPARE_PORT = 'web-ink-ieee-prepare';
export const PDF_CHUNK_BYTES = 256 * 1024;
export function encodePdfChunk(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
export async function readPreparedPdf(
  token: string, request: <T>(message: object) => Promise<T>, signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  let claimed = false;
  try {
    const info = await request<PreparedInfo>({ type: 'pdf.prepared.claim', token });
    claimed = true;
    signal.throwIfAborted();
    if (info.token !== token || !Number.isInteger(info.byteLength) || info.byteLength <= 0 ||
      info.byteLength > MAX_PDF_BYTES || info.chunks !== Math.ceil(info.byteLength / PDF_CHUNK_BYTES) ||
      !/^[a-f0-9]{64}$/.test(info.hash)) throw Error('Prepared PDF integrity check failed.');
    const bytes = new Uint8Array(info.byteLength);
    for (let index = 0; index < info.chunks; index++) {
      signal.throwIfAborted();
      const data = await request<string>({ type: 'pdf.prepared.chunk', token, index });
      signal.throwIfAborted();
      const expected = Math.min(PDF_CHUNK_BYTES, bytes.length - index * PDF_CHUNK_BYTES);
      if (typeof data !== 'string' || data.length > Math.ceil(PDF_CHUNK_BYTES / 3) * 4)
        throw Error('Prepared PDF integrity check failed.');
      const binary = atob(data);
      if (binary.length !== expected || btoa(binary) !== data) throw Error('Prepared PDF integrity check failed.');
      for (let i = 0; i < binary.length; i++) bytes[index * PDF_CHUNK_BYTES + i] = binary.charCodeAt(i);
    }
    verifyPdf(bytes);
    if (await pdfHash(bytes) !== info.hash) throw Error('Prepared PDF integrity check failed.');
    signal.throwIfAborted();
    return bytes;
  } finally {
    if (claimed) await request({ type: 'pdf.prepared.release', token }).catch(() => undefined);
  }
}
