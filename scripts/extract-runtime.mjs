import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { unpackFiles } from './lib/archive.mjs';
const [archive, destination] = process.argv.slice(2);
if (!archive || !destination) throw Error('Usage: extract-runtime.mjs archive.zip NEW_DIRECTORY');
try { await lstat(destination); throw Error('Destination must not already exist'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const entries = unpackFiles(await readFile(archive));
const wrapped = Object.hasOwn(entries, 'web-ink/manifest.json');
const validRoot = wrapped
  ? Object.keys(entries).every(name => name.startsWith('web-ink/') && !name.startsWith('web-ink/web-ink/'))
  : Object.hasOwn(entries, 'manifest.json') && !Object.keys(entries).some(name => name.startsWith('web-ink/'));
if (!validRoot) throw Error('Invalid runtime archive root: expected a flat runtime or a single web-ink/ folder');
// Tests and upgrade baselines need the runtime directly in NEW_DIRECTORY, including old flat ZIPs.
const files = wrapped
  ? Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name.slice('web-ink/'.length), bytes]))
  : entries;
await mkdir(destination, { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  const target = path.join(destination, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
}
console.log(`Verified and extracted ${Object.keys(files).length} files to ${destination}`);
