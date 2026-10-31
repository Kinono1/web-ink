export const IEEE_PREPARE_PORT = "web-ink-ieee-prepare";
export const PDF_CHUNK_BYTES = 256 * 1024;
export type PreparedInfo = { token: string; byteLength: number; hash: string; chunks: number };
export function encodePdfChunk(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
