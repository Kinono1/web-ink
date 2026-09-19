import { createZip } from '@aklinker1/zero-zip';
import { inflateRawSync, crc32 } from 'node:zlib';
import assert from 'node:assert/strict';
import { fileHashes } from './runtime.mjs';

export async function packFiles(files) {
  const archive = createZip({ level: 9 });
  for (const name of Object.keys(files).sort()) archive.addFile(name, files[name]);
  return archive.toBuffer();
}
/** Bounded verifier for our own non-ZIP64 runtime archives, not a general unzipper. */
export function unpackFiles(bytes) {
  if (bytes.length > 64 * 1024 * 1024) throw Error('Archive too large');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 65557) throw Error('Invalid ZIP footer');
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw Error('Multi-disk ZIP unsupported');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16), total = 0;
  if (count === 65535 || cursor + size !== end) throw Error('Invalid or ZIP64 directory');
  const files = {};
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw Error('Invalid ZIP directory');
    const method = bytes.readUInt16LE(cursor + 10), checksum = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || Object.hasOwn(files, name)) throw Error('Unsafe ZIP path');
    if ((bytes.readUInt16LE(cursor + 8) & 1) || (bytes.readUInt32LE(cursor + 38) >>> 16 & 0xf000) === 0xa000) throw Error('Encrypted or linked ZIP entry');
    total += expanded;
    if (total > 64 * 1024 * 1024) throw Error('Expanded archive too large');
    const local = bytes.readUInt32LE(cursor + 42);
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw Error('Invalid local ZIP entry');
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    if (bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) throw Error('ZIP filename mismatch');
    const start = local + 30 + localNameLength + localExtraLength;
    if (start + compressed > bytes.length) throw Error('Truncated ZIP entry');
    const packed = bytes.subarray(start, start + compressed);
    const content = method === 0 ? Buffer.from(packed) : method === 8 ? inflateRawSync(packed, { maxOutputLength: 64 * 1024 * 1024 }) : undefined;
    if (!content || content.length !== expanded || crc32(content) !== checksum) throw Error('ZIP content check failed');
    files[name] = content;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) throw Error('ZIP directory length mismatch');
  return files;
}
export function verifyArchive(bytes, files) {
  assert.deepEqual(fileHashes(unpackFiles(bytes)), fileHashes(files), 'Packaged files differ from the tested build');
}
