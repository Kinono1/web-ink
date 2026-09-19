import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { unpackFiles } from './lib/archive.mjs';
const [archive, destination] = process.argv.slice(2);
if (!archive || !destination) throw Error('Usage: extract-runtime.mjs archive.zip NEW_DIRECTORY');
try { await lstat(destination); throw Error('Destination must not already exist'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const files = unpackFiles(await readFile(archive));
await mkdir(destination, { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  const target = path.join(destination, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
}
console.log(`Verified and extracted ${Object.keys(files).length} files to ${destination}`);
