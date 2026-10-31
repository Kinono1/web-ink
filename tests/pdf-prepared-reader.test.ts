import { describe, it, expect, vi } from 'vitest';
import { readPreparedPdf } from '../src/pdf/prepared';
import { encodePdfChunk } from '../src/core/prepared-contract';

describe('prepared PDF reader', () => {
  const bytes = new TextEncoder().encode('%PDF-1.7\nsource bytes already downloaded\n');
  it('reads acknowledged prepared chunks and releases without downloading again', async () => {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const messages: object[] = [];
    const request = async <T>(message: object): Promise<T> => {
      messages.push(message);
      const type = (message as { type: string }).type;
      if (type.endsWith('claim')) return { token: 'token', byteLength: bytes.length, chunks: 1, hash } as T;
      if (type.endsWith('chunk')) return encodePdfChunk(bytes) as T;
      return undefined as T;
    };
    vi.stubGlobal('fetch', () => { throw Error('Unexpected second download'); });
    expect(Array.from(await readPreparedPdf('token', request, new AbortController().signal))).toEqual(Array.from(bytes));
    expect(messages).toEqual([
      { type: 'pdf.prepared.claim', token: 'token' },
      { type: 'pdf.prepared.chunk', token: 'token', index: 0 },
      { type: 'pdf.prepared.release', token: 'token' },
    ]);
    vi.unstubAllGlobals();
  });
  it('rejects a changed chunk and releases the temporary file', async () => {
    let released = false;
    const request = async <T>(message: object): Promise<T> => {
      const type = (message as { type: string }).type;
      if (type.endsWith('claim')) return { token: 'token', byteLength: bytes.length, chunks: 1, hash: 'a'.repeat(64) } as T;
      if (type.endsWith('chunk')) return encodePdfChunk(bytes) as T;
      released = true;
      return undefined as T;
    };
    await expect(readPreparedPdf('token', request, new AbortController().signal)).rejects.toThrow(/integrity/i);
    expect(released).toBe(true);
  });
  it('releases bytes when the reader cancels after claim', async () => {
    const controller = new AbortController();
    const messages: string[] = [];
    const request = async <T>(message: object): Promise<T> => {
      const type = (message as { type: string }).type;
      messages.push(type);
      if (type.endsWith('claim')) { controller.abort(); return { token: 'token', byteLength: 1, chunks: 1, hash: 'a'.repeat(64) } as T; }
      return undefined as T;
    };
    await expect(readPreparedPdf('token', request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(messages).toEqual(['pdf.prepared.claim', 'pdf.prepared.release']);
  });
});
