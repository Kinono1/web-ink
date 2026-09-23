import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const packages = ['react', 'react-dom', 'scheduler', 'dexie', 'perfect-freehand', 'pdfjs-dist', 'wxt'];
const sections = [];
for (const name of packages) {
  const folder = path.join('node_modules', name);
  const pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
  let license;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT']) {
    try { license = await readFile(path.join(folder, file), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // The WXT monorepo npm tarballs omit their root license. This verbatim copy is
  // from https://github.com/wxt-dev/wxt/blob/main/LICENSE (checked 2026-09-18).
  if (!license && (name === 'wxt' || name.startsWith('@wxt-dev/'))) license = await readFile('scripts/vendor-licenses/WXT-MIT.txt', 'utf8');
  if (!license) throw new Error(`License text missing for ${name}`);
  sections.push(`${name} ${pkg.version}\n${'='.repeat(64)}\n${license.trim()}\n`);
  try { sections.push(await readFile(path.join(folder, 'NOTICE'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir('public/licenses', { recursive: true });
await writeFile('public/licenses/THIRD_PARTY_LICENSES.txt', sections.join('\n'));
await writeFile('public/licenses/WEB_INK_LICENSE.txt', await readFile('LICENSE', 'utf8'));
