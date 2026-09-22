import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createRuntimeIntegrity,
  fileHashes,
  installRuntime,
  runtimeFiles,
  validateRuntimeIntegrity,
} from '../scripts/lib/runtime.mjs';
import { packFiles, verifyArchive, unpackFiles } from '../scripts/lib/archive.mjs';

const identity = { name: 'Web Ink', key: 'test-public-key' };
const sourceName = '.output/chrome-mv3';
const targetName = 'Web-Ink-Chrome';

function manifest(version) {
  return {
    ...identity,
    manifest_version: 3,
    version,
    background: { service_worker: 'background.js', type: 'module' },
    content_scripts: [{ matches: ['https://example.test/*'], js: ['content-scripts/content.js'] }],
    action: { default_icon: { 16: 'icon/icon-16.png' } },
    icons: { 16: 'icon/icon-16.png' },
    web_accessible_resources: [{
      resources: ['engine.js', 'chunks/app.js', 'pdfjs/pdf.worker.min.mjs'],
      matches: ['https://example.test/*'],
    }],
  };
}

async function writeRuntime(dir, version, { seal = true } = {}) {
  await mkdir(path.join(dir, 'chunks'), { recursive: true });
  await mkdir(path.join(dir, 'content-scripts'), { recursive: true });
  await mkdir(path.join(dir, 'icon'), { recursive: true });
  await mkdir(path.join(dir, 'pdfjs'), { recursive: true });
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest(version))),
    writeFile(path.join(dir, 'background.js'), "import './chunks/helper.js';\n"),
    writeFile(path.join(dir, 'engine.js'), 'export const engine = true;\n'),
    writeFile(path.join(dir, 'content-scripts/content.js'), "import '../chunks/helper.js';\n"),
    writeFile(path.join(dir, 'chunks/app.js'), "import './helper.js';\nexport const app = true;\n"),
    writeFile(path.join(dir, 'chunks/helper.js'), 'export const helper = true;\n'),
    writeFile(path.join(dir, 'assets/app.css'), 'body { color: #111; mask: url(%23mask); filter: url(#filter); }\n'),
    writeFile(path.join(dir, 'pdfjs/pdf.worker.min.mjs'), 'self.onmessage = () => {};\n'),
    writeFile(path.join(dir, 'icon/icon-16.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    writeFile(path.join(dir, 'library.html'), '<!doctype html><link rel="stylesheet" href="assets/app.css"><script type="module" src="chunks/app.js"></script>\n'),
    writeFile(path.join(dir, 'sidepanel.html'), '<!doctype html><script type="module" src="chunks/app.js"></script>\n'),
    writeFile(path.join(dir, 'pdf.html'), '<!doctype html><script type="module" src="chunks/app.js"></script>\n'),
    writeFile(path.join(dir, 'build-info.json'), JSON.stringify({ version })),
  ]);
  if (seal) await reseal(dir);
}

async function reseal(dir) {
  const files = await runtimeFiles(dir);
  await writeFile(path.join(dir, 'runtime-integrity.json'), createRuntimeIntegrity(files));
}

async function fixture(t) {
  const repo = await mkdtemp(path.join(tmpdir(), 'webink-release-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeRuntime(path.join(repo, sourceName), '0.3.1');
  // Existing local installs predate the seal. They remain structurally checked.
  await writeRuntime(path.join(repo, targetName), '0.3.0', { seal: false });
  return repo;
}

async function hashes(root) {
  return fileHashes(await runtimeFiles(root));
}

test('create and validate runtime integrity cover a real minimal resource graph', async t => {
  const repo = await fixture(t);
  const source = path.join(repo, sourceName);
  const files = await runtimeFiles(source);
  const parsed = JSON.parse(createRuntimeIntegrity(files).toString());
  assert.equal(validateRuntimeIntegrity(files).version, '0.3.1');
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.files, fileHashes(Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'runtime-integrity.json'))));

  await rm(path.join(source, 'engine.js'));
  const missingEngine = await runtimeFiles(source);
  assert.throws(() => createRuntimeIntegrity(missingEngine), /engine\.js/);
});

test('installer accepts a complete legacy target, seals it on upgrade, and accepts a second upgrade', async t => {
  const repo = await fixture(t);
  const source = path.join(repo, sourceName);
  const target = path.join(repo, targetName);
  await rm(path.join(target, 'build-info.json'));
  const legacy = await runtimeFiles(target);
  assert.equal(validateRuntimeIntegrity(legacy, { requireIntegrity: false }).version, '0.3.0');

  const result = await installRuntime(repo, identity);
  assert.deepEqual(await hashes(result.target), await hashes(source));
  assert.deepEqual(await hashes(path.join(result.backup, targetName)), fileHashes(legacy));
  assert.deepEqual(JSON.parse(await readFile(path.join(repo, '.output/install-receipt.json'), 'utf8')).files, await hashes(target));
  await installRuntime(repo, identity);
});

test('installer rejects malformed or incomplete incoming runtimes before mutating the target', async t => {
  const repo = await fixture(t);
  const source = path.join(repo, sourceName);
  const target = path.join(repo, targetName);
  const cases = [
    ['missing engine', async () => rm(path.join(source, 'engine.js')), /engine\.js/],
    ['missing direct HTML chunk', async () => rm(path.join(source, 'chunks/app.js')), /chunks\/app\.js/],
    ['missing transitive JavaScript chunk', async () => rm(path.join(source, 'chunks/helper.js')), /chunks\/helper\.js/],
    ['missing PDF worker', async () => rm(path.join(source, 'pdfjs/pdf.worker.min.mjs')), /pdf\.worker\.min\.mjs/],
    ['missing manifest icon', async () => rm(path.join(source, 'icon/icon-16.png')), /icon\/icon-16\.png/],
    ['removed integrity seal', async () => rm(path.join(source, 'runtime-integrity.json')), /runtime-integrity/],
    ['content hash mismatch', async () => writeFile(path.join(source, 'chunks/app.js'), 'export const modified = true;\n'), /integrity|hash/i],
    ['unlisted file', async () => writeFile(path.join(source, 'chunks/unlisted.js'), 'export {};\n'), /integrity|hash/i],
    ['invalid integrity seal', async () => writeFile(path.join(source, 'runtime-integrity.json'), '{"schemaVersion":2}'), /runtime-integrity|schema/i],
  ];

  for (const [label, mutate, expected] of cases) {
    await rm(source, { recursive: true, force: true });
    await writeRuntime(source, '0.3.1');
    const before = await hashes(target);
    await mutate();
    await assert.rejects(installRuntime(repo, identity), expected, label);
    assert.deepEqual(await hashes(target), before, `${label} must not mutate the installation target`);
  }
});

test('installer refuses wrong identity, unknown user files, and symlink destinations', async t => {
  const repo = await fixture(t);
  const target = path.join(repo, targetName);
  const before = await hashes(target);
  await assert.rejects(installRuntime(repo, { ...identity, key: 'other' }), /identity mismatch/);
  assert.deepEqual(await hashes(target), before);

  await writeFile(path.join(target, 'personal-notes.txt'), 'keep');
  await assert.rejects(installRuntime(repo, identity), /Unknown install entry/);
  assert.equal(await readFile(path.join(target, 'personal-notes.txt'), 'utf8'), 'keep');
  await rm(target, { recursive: true });
  await symlink(path.join(repo, sourceName), target, 'dir');
  await assert.rejects(installRuntime(repo, identity), /symbolic link/);
});

test('installer rolls back files and receipt after a copy failure', async t => {
  const repo = await fixture(t);
  const source = path.join(repo, sourceName);
  const target = path.join(repo, targetName);
  await installRuntime(repo, identity);
  const old = await hashes(target);
  const receiptPath = path.join(repo, '.output/install-receipt.json');
  const receipt = await readFile(receiptPath);
  await writeFile(path.join(source, 'chunks/app.js'), "import './helper.js';\nexport const app = 'next';\n");
  await reseal(source);

  let count = 0;
  await assert.rejects(installRuntime(repo, identity, {
    copyFile: async (from, to) => {
      await cp(from, to);
      if (++count === 2) throw Error('simulated disk error');
    },
  }), /simulated disk error/);
  assert.deepEqual(await hashes(target), old);
  assert.deepEqual(await readFile(receiptPath), receipt);
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


test('sealing refuses missing direct and transitive references instead of blessing incomplete output', async t => {
  const repo = await fixture(t);
  const files = await runtimeFiles(path.join(repo, sourceName));
  for (const name of ['chunks/app.js', 'chunks/helper.js', 'assets/app.css', 'pdfjs/pdf.worker.min.mjs', 'icon/icon-16.png']) {
    const incomplete = { ...files }; delete incomplete[name];
    assert.throws(() => createRuntimeIntegrity(incomplete), error => error.message.includes(name), name);
  }
});

test('packaging CLI refuses an incomplete build before overwriting an existing archive', async t => {
  const repo = await fixture(t);
  const archive = path.join(repo, '.output/web-ink-0.3.1-chrome.zip');
  await writeFile(archive, 'previous verified archive');
  const script = fileURLToPath(new URL('../scripts/package-release.mjs', import.meta.url));
  for (const name of ['engine.js', 'chunks/helper.js', 'pdfjs/pdf.worker.min.mjs']) {
    const source = path.join(repo, sourceName);
    await rm(source, { recursive: true, force: true });
    await writeRuntime(source, '0.3.1');
    await rm(path.join(source, name));
    const result = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(name), result.stderr);
    assert.equal(await readFile(archive, 'utf8'), 'previous verified archive');
  }
});
