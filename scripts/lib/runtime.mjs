import { lstat, readdir, readFile, mkdir, cp, rm, writeFile, mkdtemp, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { validateRuntimeIntegrity } from './integrity.mjs';
export { createRuntimeIntegrity, validateRuntimeIntegrity } from './integrity.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const roots = new Set(['manifest.json', 'background.js', 'engine.js', 'library.html', 'pdf.html', 'sidepanel.html', 'build-info.json', 'runtime-integrity.json']);
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

// Historical archives predate PDF/engine entries and are not rollback candidates.
function validateArchive(files, identity) {
  const manifest = JSON.parse(files['manifest.json']?.toString() || '{}');
  if (manifest.name !== identity.name || manifest.key !== identity.key || manifest.manifest_version !== 3)
    throw Error('Archive extension identity mismatch; registration refused');
  if (typeof manifest.version !== 'string' || !manifest.version) throw Error('Invalid archive manifest version');
  if (Object.hasOwn(files, 'runtime-integrity.json')) {
    let seal;
    try { seal = JSON.parse(files['runtime-integrity.json'].toString()); }
    catch { throw Error('Invalid archival integrity manifest JSON'); }
    if (seal?.schemaVersion !== 1 || !seal.files || typeof seal.files !== 'object' || Array.isArray(seal.files))
      throw Error('Invalid archival integrity manifest schema');
    const payload = Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'runtime-integrity.json'));
    assert.deepEqual(seal.files, fileHashes(payload), 'Archival integrity mismatch');
  }
  return manifest;
}

async function rejectSymlink(location) {
  try {
    if ((await lstat(location)).isSymbolicLink()) throw Error(`Refusing symbolic link: ${location}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function installationPaths(repo) {
  repo = path.resolve(repo);
  const state = path.join(repo, '.local-install');
  for (const location of [repo, path.join(repo, '.output'), path.join(repo, '.build-output'), state,
    path.join(state, 'backups'), path.join(state, 'receipt.json'), path.join(state, 'pending.json')]) await rejectSymlink(location);
  return { repo, source: path.join(repo, '.build-output/chrome-mv3'),
    target: path.join(repo, '.output/chrome-mv3'), state, receiptPath: path.join(state, 'receipt.json') };
}

async function readReceipt(receiptPath) {
  try { return JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function receiptFor(target, identity, files, backup = null) {
  const manifest = validateIdentity(files, identity);
  const build = files['build-info.json'] ? JSON.parse(files['build-info.json'].toString()) : null;
  const extensionId = createHash('sha256').update(Buffer.from(identity.key, 'base64')).digest('hex')
    .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  return { schemaVersion: 1, target, extensionId, version: manifest.version, build, files: fileHashes(files), backup };
}

async function saveReceipt(receiptPath, receipt) {
  const temporaryDirectory = await mkdtemp(path.join(path.dirname(receiptPath), '.receipt-'));
  const temporary = path.join(temporaryDirectory, 'data.json');
  try {
    await writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, receiptPath);
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}

function checkReceipt(receipt, target, files) {
  if (receipt.target !== target) throw Error('Installation receipt target mismatch');
  assert.deepEqual(fileHashes(files), receipt.files, 'Installed files changed outside the updater');
}

async function restoreFiles(target, previous, currentNames) {
  for (const rel of currentNames) if (!(rel in previous)) await rm(path.join(target, rel), { force: true });
  for (const [rel, bytes] of Object.entries(previous)) {
    await mkdir(path.dirname(path.join(target, rel)), { recursive: true });
    await writeFile(path.join(target, rel), bytes);
  }
  assert.deepEqual(fileHashes(await runtimeFiles(target)), fileHashes(previous), 'Rollback failed; retain backup and stop');
}

/** A durable backup reference lets the next invocation recover an interrupted file copy. */
async function recoverPending({ target, state, receiptPath }, identity) {
  const journalPath = path.join(state, 'pending.json');
  const pending = await readReceipt(journalPath);
  if (!pending) return;
  if (pending.schemaVersion !== 1 || pending.target !== target || typeof pending.backup !== 'string' ||
    path.dirname(pending.backup) !== path.join(state, 'backups') || !/^build-[\w-]+$/.test(path.basename(pending.backup)))
    throw Error('Invalid update recovery journal; installation refused');
  await rejectSymlink(pending.backup);
  const previous = await runtimeFiles(path.join(pending.backup, 'chrome-mv3'));
  validateIdentity(previous, identity);
  validateRuntimeIntegrity(previous, { requireIntegrity: false });
  checkReceipt(pending.before, target, previous);
  if (pending.after?.target !== target || !pending.after.files || typeof pending.after.files !== 'object')
    throw Error('Invalid update recovery journal');
  for (const [name, hash] of Object.entries(pending.after.files)) {
    const parts = name.split('/');
    if (!name || parts.some(part => !part || part === '.' || part === '..') ||
      !(parts.length === 1 ? roots.has(name) : folders.has(parts[0])) || !/^[a-f0-9]{64}$/.test(hash))
      throw Error('Invalid update recovery file');
  }
  const receipt = await readReceipt(receiptPath);
  const current = await runtimeFiles(target);
  // A committed receipt means synchronization completed; do not undo later external changes.
  if (receipt && isDeepStrictEqual(receipt.files, pending.after.files)) {
    checkReceipt(receipt, target, current);
  } else {
    assert.deepEqual(receipt, pending.before, 'Recovery receipt mismatch; retain backup and stop');
    for (const rel of Object.keys(current)) if (!(rel in pending.before.files) && !(rel in pending.after.files))
      throw Error(`Unknown recovery entry: ${rel}`);
    await restoreFiles(target, previous, Object.keys(current));
    await saveReceipt(receiptPath, pending.before);
  }
  await rm(journalPath);
}

/** Explicit enrollment verifies the existing runtime before creating protected state. */
export async function registerInstallation(repo, identity) {
  const paths = await installationPaths(repo);
  const { target, state, receiptPath, repo: root } = paths;
  await recoverPending(paths, identity);
  const files = await runtimeFiles(target);
  validateIdentity(files, identity);
  validateRuntimeIntegrity(files, { requireIntegrity: false });
  const existing = await readReceipt(receiptPath);
  if (existing) { checkReceipt(existing, target, files); return existing; }
  const oldReceiptPath = path.join(root, '.output/install-receipt.json');
  await rejectSymlink(oldReceiptPath);
  const oldReceipt = await readReceipt(oldReceiptPath);
  if (oldReceipt) assert.deepEqual(fileHashes(files), oldReceipt.files, 'Installed files changed outside the updater');
  await mkdir(state, { recursive: true });
  const oldBackups = path.join(root, '.output/install-backups');
  await rejectSymlink(oldBackups);
  let entries;
  try { entries = await readdir(oldBackups, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  const migrated = [];
  const archivalBackups = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw Error(`Refusing symbolic link: ${entry.name}`);
    const nested = /^build-[\w-]+$/.test(entry.name);
    const flat = /^Web-Ink-Chrome-0\.1\.[12]-\d{8}T\d{6}Z$/.test(entry.name) ||
      /^before-(?:ci-canonical|public-release)-\d{8}T\d{6}Z$/.test(entry.name) ||
      /^chrome-mv3-[a-f0-9]{7}-\d{8}-\d{6}$/.test(entry.name);
    if (!entry.isDirectory() || (!nested && !flat)) throw Error(`Unknown legacy backup: ${entry.name}`);
    const backupRoot = path.join(oldBackups, entry.name);
    if (nested) {
      const children = await readdir(backupRoot, { withFileTypes: true });
      if (children.length !== 1 || children[0].name !== 'Web-Ink-Chrome' || !children[0].isDirectory())
        throw Error(`Unknown legacy backup layout: ${entry.name}`);
    }
    const original = nested ? path.join(backupRoot, 'Web-Ink-Chrome') : backupRoot;
    const saved = await runtimeFiles(original);
    const manifest = validateArchive(saved, identity);
    const archiveHashes = fileHashes(saved);
    const destination = path.join(state, 'backups/legacy', entry.name, 'chrome-mv3');
    for (const location of [path.join(state, 'backups/legacy'), path.dirname(destination), destination]) await rejectSymlink(location);
    await mkdir(path.dirname(destination), { recursive: true });
    try { await cp(original, destination, { recursive: true, errorOnExist: true, force: false }); }
    catch (error) { if (error.code !== 'ERR_FS_CP_EEXIST') throw error; }
    assert.deepEqual(fileHashes(await runtimeFiles(destination)), archiveHashes, 'Legacy backup migration hash mismatch');
    migrated.push(destination);
    archivalBackups.push({ source: original, destination, version: manifest.version, files: archiveHashes });
  }
  const receipt = { ...receiptFor(target, identity, files), migratedBackups: migrated, archivalBackups };
  await saveReceipt(receiptPath, receipt);
  return receipt;
}

/** Only verified runtime files are overwritten; the Chrome-loaded directory itself stays in place. */
export async function installRuntime(repo, identity, { copyFile = cp } = {}) {
  const paths = await installationPaths(repo);
  const { source, target, state, receiptPath } = paths;
  await recoverPending(paths, identity);
  const receipt = await readReceipt(receiptPath);
  if (!receipt) throw Error('Installation is not registered. Run npm run register:local in the primary checkout first.');
  const incoming = await runtimeFiles(source);
  validateIdentity(incoming, identity);
  validateRuntimeIntegrity(incoming);
  // Intentionally refuse a missing install: first installation remains explicit.
  const previous = await runtimeFiles(target);
  validateIdentity(previous, identity);
  validateRuntimeIntegrity(previous, { requireIntegrity: false });
  checkReceipt(receipt, target, previous);
  const backupRoot = path.join(state, 'backups');
  await mkdir(backupRoot, { recursive: true });
  if ((await lstat(backupRoot)).isSymbolicLink()) throw Error('Refusing backup symlink');
  const backup = await mkdtemp(path.join(backupRoot, 'build-'));
  await cp(target, path.join(backup, 'chrome-mv3'), { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(fileHashes(await runtimeFiles(path.join(backup, 'chrome-mv3'))), fileHashes(previous));
  const nextReceipt = receiptFor(target, identity, incoming, backup);
  const journalPath = path.join(state, 'pending.json');
  await saveReceipt(journalPath, { schemaVersion: 1, target, backup, before: receipt, after: nextReceipt });
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
    await saveReceipt(receiptPath, nextReceipt);
    await rm(journalPath);
  } catch (error) {
    await restoreFiles(target, previous, written);
    await saveReceipt(receiptPath, receipt);
    await rm(journalPath);
    throw error;
  }
  return { source, target, backup, ...receiptFor(target, identity, incoming, backup), files: Object.keys(incoming).length };
}
