import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const outputDirectory = '.output';
const entries = await readdir(outputDirectory, { withFileTypes: true });
const archives = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

if (!archives.length) throw new Error('No .output/*.zip archive found. Run npm run zip first.');

for (const archive of archives) {
  const bytes = await readFile(join(outputDirectory, archive));
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(outputDirectory, `${archive}.sha256`), `${digest}  ${archive}\n`, 'utf8');
}
