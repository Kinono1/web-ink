import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installRuntime, runtimeFiles, fileHashes } from '../scripts/lib/runtime.mjs';
import { packFiles, verifyArchive, unpackFiles } from '../scripts/lib/archive.mjs';
const identity = { name: 'Web Ink', key: 'test-public-key' };
async function fixture(t) {
  const repo = await mkdtemp(path.join(tmpdir(), 'webink-release-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  for (const [folder, version] of [['.output/chrome-mv3', '0.3.1'], ['Web-Ink-Chrome', '0.3.0']]) {
    const dir = path.join(repo, folder); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ ...identity, manifest_version: 3, version }));
    for (const name of ['background.js', 'library.html', 'sidepanel.html', 'pdf.html']) await writeFile(path.join(dir, name), version);
  }
  return repo;
}
test('installer preserves identity, backs up previous bytes, and matches every runtime file', async t => {
  const repo = await fixture(t);
  const old = fileHashes(await runtimeFiles(path.join(repo, 'Web-Ink-Chrome')));
  const result = await installRuntime(repo, identity);
  assert.deepEqual(fileHashes(await runtimeFiles(result.target)), fileHashes(await runtimeFiles(path.join(repo, '.output/chrome-mv3'))));
  assert.deepEqual(fileHashes(await runtimeFiles(path.join(result.backup, 'Web-Ink-Chrome'))), old);
  await installRuntime(repo, identity);
});
test('installer refuses a wrong extension identity without changing its files', async t => {
  const repo = await fixture(t), target = path.join(repo, 'Web-Ink-Chrome');
  const before = fileHashes(await runtimeFiles(target));
  await assert.rejects(installRuntime(repo, { ...identity, key: 'other' }), /identity mismatch/);
  assert.deepEqual(fileHashes(await runtimeFiles(target)), before);
});
test('installer refuses unknown user files and symlink destinations', async t => {
  const repo = await fixture(t), target = path.join(repo, 'Web-Ink-Chrome');
  await writeFile(path.join(target, 'personal-notes.txt'), 'keep');
  await assert.rejects(installRuntime(repo, identity), /Unknown install entry/);
  assert.equal(await readFile(path.join(target, 'personal-notes.txt'), 'utf8'), 'keep');
  await rm(target, { recursive: true });
  await symlink(path.join(repo, '.output/chrome-mv3'), target, 'dir');
  await assert.rejects(installRuntime(repo, identity), /symbolic link/);
});
test('installer rolls back partial writes after a copy failure', async t => {
  const repo = await fixture(t), target = path.join(repo, 'Web-Ink-Chrome');
  const old = fileHashes(await runtimeFiles(target));
  let count = 0;
  await assert.rejects(installRuntime(repo, identity, { copyFile: async (from, to) => {
    await cp(from, to); if (++count === 2) throw Error('simulated disk error');
  } }), /simulated disk error/);
  assert.deepEqual(fileHashes(await runtimeFiles(target)), old);
});
test('ZIP verifier checks complete filenames, contents, and corrupted payloads', async () => {
  const files = { 'manifest.json': Buffer.from('{"version":"0.3.1"}'), 'chunks/a.js': Buffer.from('synthetic runtime') };
  const zip = await packFiles(files);
  verifyArchive(zip, files);
  assert.deepEqual(fileHashes(unpackFiles(zip)), fileHashes(files));
  assert.throws(() => verifyArchive(zip, { ...files, 'unexpected.js': Buffer.from('x') }));
  const damaged = Buffer.from(zip); damaged[40] ^= 255;
  assert.throws(() => verifyArchive(damaged, files));
});
