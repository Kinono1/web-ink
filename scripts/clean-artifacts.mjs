#!/usr/bin/env node
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const outputDir = '.output';
const maxAgeDays = 7; // Keep artifacts newer than this
const installBackupMaxDays = 14;
const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
const backupCutoffTime = Date.now() - installBackupMaxDays * 24 * 60 * 60 * 1000;

let totalSize = 0;
const toRemove = [];

async function getDirectorySize(path) {
  let size = 0;
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) {
        size += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        const stats = await stat(fullPath);
        size += stats.size;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return size;
}

async function shouldRemove(path, pattern, maxAge = cutoffTime) {
  try {
    const stats = await stat(path);
    return stats.mtime.getTime() < maxAge;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

try {
  const entries = await readdir(outputDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(outputDir, entry.name);
    let shouldDelete = false;
    let reason = '';

    if (entry.isDirectory()) {
      // Remove old test snapshots
      if (entry.name.startsWith('acceptance-') || entry.name.startsWith('baseline-')) {
        if (await shouldRemove(fullPath, entry.name)) {
          shouldDelete = true;
          reason = 'old test snapshot';
        }
      }
      // Remove native profile data
      else if (entry.name.startsWith('native-profile-')) {
        shouldDelete = true;
        reason = 'native profile data';
      }
      // Remove old install backups
      else if (entry.name === 'install-backups') {
        if (await shouldRemove(fullPath, entry.name, backupCutoffTime)) {
          shouldDelete = true;
          reason = 'old install backups';
        }
      }
    } else if (entry.isFile()) {
      // Remove historical release ZIPs (keep current version 0.3.1)
      if (entry.name.match(/^web-ink-0\.[0-2]\.\d+-chrome\.zip(\.sha256)?$/)) {
        shouldDelete = true;
        reason = 'historical release artifact';
      }
      // Remove old v0.3.0 artifacts
      else if (entry.name.match(/^web-ink-0\.3\.0-chrome\.zip(\.sha256)?$/)) {
        shouldDelete = true;
        reason = 'superseded release';
      }
    }

    if (shouldDelete) {
      const size = entry.isDirectory() ? await getDirectorySize(fullPath) : (await stat(fullPath)).size;
      totalSize += size;
      toRemove.push({ path: fullPath, size, reason });
    }
  }

  if (toRemove.length === 0) {
    console.log('✓ No artifacts to clean');
    process.exit(0);
  }

  console.log(dryRun ? 'Dry run — would remove:\n' : 'Removing:\n');

  for (const { path, size, reason } of toRemove) {
    const sizeStr = (size / 1024 / 1024).toFixed(2);
    console.log(`  ${path.replace(outputDir + '/', '')} (${sizeStr} MB) — ${reason}`);
  }

  console.log(`\nTotal space to free: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

  if (!dryRun) {
    for (const { path } of toRemove) {
      await rm(path, { recursive: true, force: true });
    }
    console.log('\n✓ Cleanup complete');
  } else {
    console.log('\nRun without --dry-run to remove these files');
  }
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('✓ No .output directory found');
  } else {
    console.error('Error during cleanup:', error.message);
    process.exit(1);
  }
}
