#!/usr/bin/env node
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const releasesDirectory = '.build-output/releases';
const releaseArtifactPattern = /^web-ink-\d+\.\d+\.\d+-chrome\.zip(?:\.sha256)?$/;
const maxAgeDays = 7;
const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
const dryRun = process.argv.includes('--dry-run');

let entries;
try {
  const buildOutput = await lstat('.build-output');
  if (!buildOutput.isDirectory()) {
    throw new Error('Refusing non-directory build output path');
  }
  const releases = await lstat(releasesDirectory);
  if (!releases.isDirectory()) throw new Error('Refusing non-directory release path');
  entries = await readdir(releasesDirectory, { withFileTypes: true });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('No staged release artifacts found');
    process.exit(0);
  }
  throw error;
}

const artifacts = [];
for (const entry of entries) {
  if (!entry.isFile() || !releaseArtifactPattern.test(entry.name)) continue;
  const filePath = join(releasesDirectory, entry.name);
  const info = await lstat(filePath);
  if (info.isFile() && info.mtimeMs < cutoffTime) {
    artifacts.push({ path: filePath, size: info.size });
  }
}

if (artifacts.length === 0) {
  console.log('No stale staged release artifacts found');
  process.exit(0);
}

const totalSize = artifacts.reduce((total, artifact) => total + artifact.size, 0);
console.log(dryRun ? 'Dry run — would remove:' : 'Removing:');
for (const artifact of artifacts) {
  console.log(`  ${artifact.path} (${(artifact.size / 1024 / 1024).toFixed(2)} MB)`);
}
console.log(`Total space to free: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

if (dryRun) {
  console.log('Run without --dry-run to remove these files');
} else {
  for (const artifact of artifacts) await unlink(artifact.path);
  console.log('Cleanup complete');
}
