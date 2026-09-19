import { lstat, readdir, readFile, mkdir, cp, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const roots = new Set(['manifest.json', 'background.js', 'engine.js', 'library.html', 'pdf.html', 'sidepanel.html', 'build-info.json']);
const folders = new Set(['assets', 'chunks', 'content-scripts', 'icon', 'licenses', 'pdfjs']);

export async function runtimeFiles(root) {
  const found = {};
  async function visit(dir, prefix = '') {
    if ((await lstat(dir)).isSymbolicLink()) throw Error(`Refusing symbolic link: ${dir}`);
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) throw Error(`Refusing symbolic link: ${rel}`);
      if (!prefix && !roots.has(rel) && !folders.has(rel)) throw Error(`Unknown install entry: ${rel}`);
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), rel + '/');
      else if (entry.isFile()) {
        if (/\.(?:pdf|sqlite|db|map|zip|crx)$/i.test(rel)) throw Error(`Non-runtime file: ${rel}`);
        found[rel] = await readFile(path.join(root, rel));
      } else throw Error(`Unsupported install entry: ${rel}`);
    }
  }
  await visit(root);
  return found;
}
export const fileHashes = files => Object.fromEntries(Object.keys(files).sort().map(name => [name, digest(files[name])]));
export function validateIdentity(files, identity) {
  const manifest = JSON.parse(files['manifest.json']?.toString() || '{}');
  if (manifest.name !== identity.name || manifest.key !== identity.key || manifest.manifest_version !== 3)
    throw Error('Extension identity mismatch; installation refused');
  for (const name of ['background.js', 'library.html', 'sidepanel.html', 'pdf.html'])
    if (!files[name]) throw Error(`Incomplete runtime: ${name}`);
  return manifest;
}

/** All destinations are derived from the repository root, never an arbitrary CLI path. */
export async function installRuntime(repo, identity, { copyFile = cp } = {}) {
  repo = path.resolve(repo);
  const source = path.join(repo, '.output/chrome-mv3');
  const target = path.join(repo, 'Web-Ink-Chrome');
  // Inspect each ancestor too: an output symlink must not redirect a backup/write.
  for (const dir of [repo, path.join(repo, '.output')])
    if ((await lstat(dir)).isSymbolicLink()) throw Error(`Refusing symbolic link: ${dir}`);
  const incoming = await runtimeFiles(source);
  validateIdentity(incoming, identity);
  // Intentionally refuse a missing install: first installation remains explicit.
  const previous = await runtimeFiles(target);
  validateIdentity(previous, identity);
  const receiptPath = path.join(repo, '.output/install-receipt.json');
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.deepEqual(fileHashes(previous), receipt.files, 'Installed files changed outside the updater');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const backupRoot = path.join(repo, '.output/install-backups');
  await mkdir(backupRoot, { recursive: true });
  if ((await lstat(backupRoot)).isSymbolicLink()) throw Error('Refusing backup symlink');
  const backup = await mkdtemp(path.join(backupRoot, 'build-'));
  await cp(target, path.join(backup, 'Web-Ink-Chrome'), { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(fileHashes(await runtimeFiles(path.join(backup, 'Web-Ink-Chrome'))), fileHashes(previous));
  const written = [];
  try {
    for (const rel of Object.keys(incoming)) {
      await mkdir(path.dirname(path.join(target, rel)), { recursive: true });
      // Track before the write, including a partial write that subsequently fails.
      written.push(rel);
      await copyFile(path.join(source, rel), path.join(target, rel));
    }
    for (const rel of Object.keys(previous))
      if (!(rel in incoming)) await rm(path.join(target, rel));
    assert.deepEqual(fileHashes(await runtimeFiles(target)), fileHashes(incoming), 'Installed hash mismatch');
    await writeFile(receiptPath, JSON.stringify({ files: fileHashes(incoming), backup }, null, 2) + '\n');
  } catch (error) {
    for (const rel of written) if (!(rel in previous)) await rm(path.join(target, rel), { force: true });
    for (const [rel, bytes] of Object.entries(previous)) {
      await mkdir(path.dirname(path.join(target, rel)), { recursive: true });
      await writeFile(path.join(target, rel), bytes);
    }
    assert.deepEqual(fileHashes(await runtimeFiles(target)), fileHashes(previous), 'Rollback failed; retain backup and stop');
    throw error;
  }
  return { target, backup, files: Object.keys(incoming).length };
}
