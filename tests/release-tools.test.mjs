import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp, stat, realpath, utimes } from 'node:fs/promises';
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
import * as runtime from '../scripts/lib/runtime.mjs';
import { packFiles, verifyArchive, unpackFiles } from '../scripts/lib/archive.mjs';

const identity = { name: 'Web Ink', key: 'test-public-key' };
const sourceName = '.build-output/chrome-mv3';
const targetName = '.output/chrome-mv3';
const receiptName = '.local-install/receipt.json';

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

async function fixture(t, { registered = true } = {}) {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'webink-release-test-')));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeRuntime(path.join(repo, sourceName), '0.3.1');
  // Existing local installs predate the seal. They remain structurally checked.
  await writeRuntime(path.join(repo, targetName), '0.3.0', { seal: false });
  if (registered) await runtime.registerInstallation(repo, identity);
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
  const repo = await fixture(t, { registered: false });
  const source = path.join(repo, sourceName);
  const target = path.join(repo, targetName);
  await rm(path.join(target, 'build-info.json'));
  const legacy = await runtimeFiles(target);
  assert.equal(validateRuntimeIntegrity(legacy, { requireIntegrity: false }).version, '0.3.0');
  await runtime.registerInstallation(repo, identity);

  const result = await installRuntime(repo, identity);
  assert.deepEqual(await hashes(result.target), await hashes(source));
  assert.deepEqual(await hashes(path.join(result.backup, 'chrome-mv3')), fileHashes(legacy));
  assert.deepEqual(JSON.parse(await readFile(path.join(repo, receiptName), 'utf8')).files, await hashes(target));
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
  const receiptPath = path.join(repo, receiptName);
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
  const archive = path.join(repo, '.build-output/releases/web-ink-0.3.1-chrome.zip');
  await mkdir(path.dirname(archive), { recursive: true });
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

test('unregistered installation is refused rather than silently skipping old-file verification', async t => {
  const repo = await fixture(t, { registered: false });
  const target = path.join(repo, targetName);
  const before = await hashes(target);
  await assert.rejects(installRuntime(repo, identity), /not registered/i);
  assert.deepEqual(await hashes(target), before);
});

test('staging cleanup preserves loaded directory root, receipt and verified rollback source', async t => {
  const repo = await fixture(t);
  const target = path.join(repo, targetName);
  const originalRoot = (await stat(target)).ino;
  const old = await hashes(target);
  const installed = await installRuntime(repo, identity);
  await rm(path.join(repo, '.build-output'), { recursive: true });
  assert.equal((await stat(target)).ino, originalRoot);
  assert.deepEqual(await hashes(path.join(installed.backup, 'chrome-mv3')), old);
  const receipt = JSON.parse(await readFile(path.join(repo, receiptName), 'utf8'));
  assert.equal(receipt.target, target);
  assert.deepEqual(receipt.files, await hashes(target));
  await writeRuntime(path.join(repo, sourceName), '0.3.2');
  await installRuntime(repo, identity);
  assert.equal((await stat(target)).ino, originalRoot);
});

test('registration validates old receipt and copies legacy backups without touching the loaded runtime', async t => {
  const repo = await fixture(t, { registered: false });
  const target = path.join(repo, targetName);
  const old = await hashes(target);
  const legacyBackup = path.join(repo, '.output/install-backups/build-old');
  await mkdir(legacyBackup, { recursive: true });
  await cp(target, path.join(legacyBackup, 'Web-Ink-Chrome'), { recursive: true });
  await writeFile(path.join(repo, '.output/install-receipt.json'), JSON.stringify({ files: old, backup: legacyBackup }));
  await runtime.registerInstallation(repo, identity);
  await rm(path.join(repo, '.output/install-backups'), { recursive: true });
  assert.deepEqual(await hashes(target), old);
  assert.deepEqual(await hashes(path.join(repo, '.local-install/backups/legacy/build-old/chrome-mv3')), old);
  await writeFile(path.join(target, 'engine.js'), 'external modification');
  await assert.rejects(installRuntime(repo, identity), /changed outside/i);
  await assert.rejects(runtime.registerInstallation(repo, identity), /changed outside/i);
});

async function cliFixture(t) {
  const repo = await fixture(t);
  await cp(fileURLToPath(new URL('../scripts', import.meta.url)), path.join(repo, 'scripts'), { recursive: true });
  await writeFile(path.join(repo, 'wxt.config.ts'), `export default { manifest: { key: '${identity.key}' } };\n`);
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ version: '0.3.1' }));
  await writeFile(path.join(repo, '.gitignore'), '.build-output/\n.output/\n.local-install/\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  await writeFile(path.join(repo, sourceName, 'build-info.json'), JSON.stringify({ version: '0.3.1', commit: head, dirty: false }));
  await reseal(path.join(repo, sourceName));
  return repo;
}

test('update CLI rejects linked worktrees before building or changing either installation', async t => {
  const repo = await cliFixture(t);
  const linked = path.join(repo, 'linked');
  const before = await hashes(path.join(repo, targetName));
  const result = spawnSync('git', ['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(process.execPath, [path.join(linked, 'scripts/update-local.mjs')], { cwd: linked, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /primary checkout/i);
  assert.ok(run.stderr.includes(repo), run.stderr);
  assert.deepEqual(await hashes(path.join(repo, targetName)), before);
  await assert.rejects(stat(path.join(linked, '.output')), { code: 'ENOENT' });
});

test('skip-build accepts only a clean matching candidate and leaves the installation unchanged on rejection', async t => {
  const repo = await cliFixture(t);
  const script = path.join(repo, 'scripts/update-local.mjs');
  const target = path.join(repo, targetName);
  const before = await hashes(target);
  const infoPath = path.join(repo, sourceName, 'build-info.json');
  const info = JSON.parse(await readFile(infoPath, 'utf8'));
  for (const invalid of [{ ...info, commit: 'old' }, { ...info, version: '0.3.0' }, { ...info, dirty: true }]) {
    await writeRuntime(path.join(repo, sourceName), invalid.version);
    await writeFile(infoPath, JSON.stringify(invalid));
    await reseal(path.join(repo, sourceName));
    const result = spawnSync(process.execPath, [script, '--skip-build'], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /candidate|stale|clean/i);
    assert.deepEqual(await hashes(target), before);
  }
  await writeRuntime(path.join(repo, sourceName), info.version);
  await writeFile(infoPath, JSON.stringify(info));
  await reseal(path.join(repo, sourceName));
  const result = spawnSync(process.execPath, [script, '--skip-build'], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(target), result.stdout);
  assert.deepEqual(await hashes(target), await hashes(path.join(repo, sourceName)));
});

test('artifact cleanup deletes only stale staged archives and preserves installs, backups and profiles', async t => {
  const repo = await fixture(t);
  const preserved = ['.output/install-backups/keep', '.local-install/backups/keep', '.build-output/releases/notes.txt',
    '.build-output/native-profile-old/keep', '.build-output/releases/web-ink-0.3.2-chrome.zip'];
  const stale = ['.build-output/releases/web-ink-0.3.0-chrome.zip', '.build-output/releases/web-ink-0.3.0-chrome.zip.sha256'];
  for (const name of [...preserved, ...stale]) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), 'keep or intentionally expired');
  }
  const oldTime = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
  for (const name of stale) await utimes(path.join(repo, name), oldTime, oldTime);
  const target = path.join(repo, targetName);
  const before = await hashes(target);
  const script = fileURLToPath(new URL('../scripts/clean-artifacts.mjs', import.meta.url));
  for (const args of [['--dry-run'], []]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const name of preserved) assert.equal(await readFile(path.join(repo, name), 'utf8'), 'keep or intentionally expired');
    assert.deepEqual(await hashes(target), before);
    await stat(path.join(repo, receiptName));
    if (args.length) for (const name of stale) await stat(path.join(repo, name));
    else for (const name of stale) await assert.rejects(stat(path.join(repo, name)), { code: 'ENOENT' });
  }
});

test('interrupted update restores its verified backup before the next attempt', async t => {
  const repo = await fixture(t);
  await writeFile(path.join(repo, sourceName, 'background.js'), "import './chunks/helper.js';\nexport const candidate = true;\n");
  await reseal(path.join(repo, sourceName));
  const target = path.join(repo, targetName);
  const before = await hashes(target);
  const library = new URL('../scripts/lib/runtime.mjs', import.meta.url).href;
  const script = `import { installRuntime } from ${JSON.stringify(library)};
    import { cp } from 'node:fs/promises';
    let copies = 0;
    await installRuntime(${JSON.stringify(repo)}, ${JSON.stringify(identity)}, { copyFile: async (from, to) => {
      await cp(from, to); if (++copies === 2) process.exit(71);
    } });`;
  const stopped = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(stopped.status, 71, stopped.stderr);
  assert.notDeepEqual(await hashes(target), before);
  const result = await installRuntime(repo, identity);
  assert.deepEqual(await hashes(path.join(result.backup, 'chrome-mv3')), before);
  assert.deepEqual(await hashes(target), await hashes(path.join(repo, sourceName)));
});

test('an unrelated stale receipt temporary file cannot prevent the next update or be deleted', async t => {
  const repo = await fixture(t);
  const stale = path.join(repo, '.local-install/receipt.json.tmp');
  await writeFile(stale, 'preserve for investigation');
  await installRuntime(repo, identity);
  assert.equal(await readFile(stale, 'utf8'), 'preserve for investigation');
});

test('invalid recovery journal is refused without modifying the installation', async t => {
  const repo = await fixture(t);
  const target = path.join(repo, targetName);
  const before = await hashes(target);
  const receipt = JSON.parse(await readFile(path.join(repo, receiptName), 'utf8'));
  const backup = path.join(repo, '.local-install/backups/build-recovery');
  await cp(target, path.join(backup, 'chrome-mv3'), { recursive: true });
  const pending = { schemaVersion: 1, target, backup, before: receipt, after: receipt };
  for (const invalid of [
    { ...pending, backup: path.join(repo, 'outside') },
    { ...pending, before: { ...receipt, files: {} } },
    { ...pending, after: { ...receipt, files: { '../outside': 'a'.repeat(64) } } },
  ]) {
    await writeFile(path.join(repo, '.local-install/pending.json'), JSON.stringify(invalid));
    await assert.rejects(installRuntime(repo, identity), /journal|changed outside|recovery/i);
    assert.deepEqual(await hashes(target), before);
  }
});
