#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BUILD_DIR = resolve('.build-output/chrome-mv3');
const KEY_PATH = resolve('.build-output/web-ink.pem');
const OUTPUT_DIR = resolve('releases');

// Validate that the build exists
if (!existsSync(BUILD_DIR)) {
  throw new Error(`Build directory not found: ${BUILD_DIR}\nRun 'npm run build' first.`);
}

// Validate that Chrome is available
if (!existsSync(CHROME_PATH)) {
  throw new Error(`Chrome not found at: ${CHROME_PATH}\nUpdate CHROME_PATH in this script.`);
}

// Read package.json for version
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const version = pkg.version;

console.log(`Packaging Web Ink ${version} as CRX...`);

// Prepare output directory
await mkdir(OUTPUT_DIR, { recursive: true });

const CRX_PATH = resolve(OUTPUT_DIR, `web-ink-${version}-chrome.crx`);

try {
  // Pack extension with Chrome
  const args = ['--pack-extension=' + BUILD_DIR];

  // Use existing key if available, otherwise Chrome will generate one
  if (existsSync(KEY_PATH)) {
    args.push('--pack-extension-key=' + KEY_PATH);
    console.log('Using existing private key from .build-output/web-ink.pem');
  } else {
    console.log('No private key found. Chrome will generate a new one.');
    console.log('IMPORTANT: Save the generated .pem file — you need it for future updates.');
  }

  execFileSync(CHROME_PATH, args, { stdio: 'inherit' });

  // Chrome outputs the CRX next to the source directory
  const defaultCrxPath = BUILD_DIR + '.crx';
  const defaultPemPath = BUILD_DIR + '.pem';

  // Move CRX to releases directory
  if (existsSync(defaultCrxPath)) {
    const crxBytes = await readFile(defaultCrxPath);
    await writeFile(CRX_PATH, crxBytes);

    // Clean up the default location
    await import('node:fs/promises').then(fs => fs.unlink(defaultCrxPath));

    console.log(`\n✓ CRX created: ${CRX_PATH}`);
    console.log(`  Size: ${(crxBytes.length / 1024).toFixed(1)} KB`);
  }

  // Move PEM to .build-output if it was generated
  if (existsSync(defaultPemPath) && !existsSync(KEY_PATH)) {
    const pemBytes = await readFile(defaultPemPath);
    await writeFile(KEY_PATH, pemBytes);

    await import('node:fs/promises').then(fs => fs.unlink(defaultPemPath));

    console.log(`\n⚠️  Private key saved: ${KEY_PATH}`);
    console.log('   Keep this file safe and DO NOT commit it to git.');
    console.log('   You need this key to maintain the same extension ID for updates.');
  }

  console.log(`\n✓ Done. Distribute ${CRX_PATH} to your users.`);
  console.log('\nUsers can install by dragging the .crx file to chrome://extensions');

} catch (err) {
  console.error('Failed to pack extension:', err.message);
  process.exit(1);
}
