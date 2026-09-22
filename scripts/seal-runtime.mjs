import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeFiles, digest } from './lib/runtime.mjs';
import { createRuntimeIntegrity, validateRuntimeIntegrity, INTEGRITY_FILE } from './lib/integrity.mjs';
const directory = '.output/chrome-mv3';
const files = await runtimeFiles(directory);
// Every prepared public asset must survive the WXT copy. This includes dynamic
// PDF worker/font/CMap/decoder resources that cannot be inferred from imports.
async function checkPublicAssets(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error(`Refusing linked public asset: ${name}`);
    if (entry.isDirectory()) await checkPublicAssets(path.join(dir, entry.name), name + '/');
    else if (entry.isFile()) {
      const source = await readFile(path.join(dir, entry.name));
      if (!files[name] || digest(source) !== digest(files[name])) throw Error(`Incomplete runtime: public asset missing or modified: ${name}`);
    }
  }
}
await checkPublicAssets('public');
const seal = createRuntimeIntegrity(files);
validateRuntimeIntegrity({ ...files, [INTEGRITY_FILE]: seal });
await writeFile(path.join(directory, INTEGRITY_FILE), seal);
console.log(`Runtime integrity sealed: ${Object.keys(JSON.parse(seal).files).length} files`);
