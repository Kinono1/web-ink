import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { installRuntime, registerInstallation, runtimeFiles, validateRuntimeIntegrity } from './lib/runtime.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => !['--skip-build', '--register'].includes(arg)) || args.length > 1)
  throw Error('Use --skip-build or --register; the install directory is fixed');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const [gitDir, commonDir] = git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir').split('\n');
if (gitDir !== commonDir) {
  const primary = path.dirname(commonDir);
  throw Error(`Updates require the primary checkout. Run: cd '${primary.replaceAll("'", "'\\''")}' && npm run update:local`);
}
const config = await readFile(path.join(repo, 'wxt.config.ts'), 'utf8');
const key = config.match(/key:\s*'([^']+)'/)?.[1];
if (!key) throw Error('Missing stable extension key');
if (args.includes('--register')) {
  console.log(JSON.stringify(await registerInstallation(repo, { name: 'Web Ink', key }), null, 2));
  console.log('Existing loaded directory registered. No extension files changed.');
  process.exit(0);
}
if (!args.includes('--skip-build')) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' });
const files = await runtimeFiles(path.join(repo, '.build-output/chrome-mv3'));
const manifest = validateRuntimeIntegrity(files);
const info = JSON.parse(files['build-info.json'].toString());
const pkg = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
if (info.commit !== git('rev-parse', 'HEAD') || info.version !== pkg.version || manifest.version !== pkg.version)
  throw Error('Stale candidate: build version and commit must match the primary checkout');
if (info.dirty || git('status', '--porcelain', '--untracked-files=normal'))
  throw Error('Local installation requires a clean candidate commit; commit and verify before updating');
console.log(JSON.stringify(await installRuntime(repo, { name: 'Web Ink', key }), null, 2));
console.log('Files synchronized. Click Web Ink Reload in chrome://extensions to activate; browser activation still needs verification. Do not uninstall.');
