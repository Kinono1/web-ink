import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--untracked-files=normal').length > 0;
// Clean builds use the commit timestamp, a reproducible build epoch rather than
// pretending two builds of the same source were produced at the same wall time.
const builtAt = process.env.WEB_INK_BUILD_TIME || (dirty ? new Date().toISOString() : git('show', '-s', '--format=%cI', 'HEAD'));
if (!Number.isFinite(Date.parse(builtAt))) throw Error('Invalid build timestamp');
await writeFile('public/build-info.json', JSON.stringify({ version, commit, builtAt, dirty }, null, 2) + '\n');
console.log(`Build ${version} ${commit.slice(0, 7)}${dirty ? ' (working tree)' : ''}`);
