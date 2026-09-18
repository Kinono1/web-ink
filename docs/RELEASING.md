# Release process and file boundary

The initial public release is **v0.1.3**, marked as a GitHub prerelease. PDF support and universal site compatibility are not claimed.

## What belongs where

| Destination | Contents |
| --- | --- |
| Git source tree | `src/`, `entrypoints/`, artificial `tests/`, build/check scripts, `package.json`, `package-lock.json`, TypeScript/WXT/Playwright/Vitest config, CI, public icons/license notices, README/privacy/license/changelog, reviewed `docs/` |
| GitHub Release assets | `web-ink-<version>-chrome.zip` and its `.zip.sha256` |
| Local only | `node_modules/`, `.wxt/`, `.output/`, `Web-Ink-Chrome/`, test reports/traces, browser profiles, exported annotations, databases, environment files and private keys |

The manifest `key` is a **public** extension identity key. It keeps the unpacked extension ID stable and is intentionally tracked. No private signing key is included.

`.gitignore` is a guard for untracked files, not a substitute for reviewing the staged list. Personal data is never suitable for source control merely because its filename is not ignored.

## Build and publish

1. Check the package version, README, changelog and known limitations. Inspect `git status` for unrelated or personal files.
2. Run `npm ci`, `npm run check`, `npm test`, `npm run build`, `npx playwright install chromium`, and `npm run test:e2e`.
3. Run `npm run zip` and `node scripts/checksum.mjs`. In `.output`, run `shasum -a 256 -c web-ink-<version>-chrome.zip.sha256` (Linux: `sha256sum`).
4. Inspect ZIP entries: only the runtime manifest, HTML/JS/CSS, icons and license notices belong inside. Exclude source maps, credentials, user data and browser profiles.
5. Review the explicit staged source paths and the commit identity. Commit and push source, then confirm GitHub Actions passed for that commit.
6. Tag that exact commit as `v<version>`. Create a GitHub prerelease with the ZIP and checksum assets and installation/upgrade instructions.
7. Verify the release URL, prerelease flag, tag target and asset digests. Do not overwrite an existing public release silently; use a new version for changed artifacts.

CI uses read-only repository permissions and uploads build artifacts. It does not publish a release automatically. GitHub's automatic Source code archives contain the source tree; users should install the named extension ZIP asset.

## Manual acceptance boundary

Automated functional tests pre-grant host permissions in a disposable test manifest. Native Chrome permission approval, its native side-panel entry and user-specific upgrade behavior still deserve a manual check. A GitHub prerelease makes the candidate available for testing; it does not turn these checks into completed results.
