# Release process and file boundary

This document is a release checklist. It does not assert that any unreleased feature has passed validation.

## Source, release assets, and local-only data

| Destination | Contents |
| --- | --- |
| Git source tree | Source, entrypoints, reviewed docs, artificial fixtures, tests, lockfile, scripts, public icons, generated license manifests, and resource license files required by the package |
| GitHub Release assets | `web-ink-<version>-chrome.zip` and matching `.zip.sha256` |
| Local only | `node_modules/`, `.wxt/`, `.output/`, unpacked install folders, browser profiles, test traces/reports, exported annotations, IndexedDB databases, environment files, PDF files, and private keys |

The manifest `key` is a public extension-identity key used for stable unpacked updates. It is intentionally tracked and is not a signing private key.

## Pre-release checks

1. Review staged paths and documentation claims. Never add browser profiles, real PDFs, personal annotations, exports, credentials, or private keys.
2. Run the repository's documented Node/npm commands. Node and npm workflow remain unchanged; install from the committed `package-lock.json`.
3. Run build, unit, browser, and packaging checks required by the target release. Record only results actually observed for that exact commit.
4. Inspect ZIP entries. Runtime code, HTML/CSS, icons, PDF.js assets, matching worker, CMaps/fonts/WASM, and their required licenses may be present. Exclude source maps unless intentionally released, user data, credentials, profiles, and original PDFs.
5. Verify PDF.js packaging uses version `6.3.289` legacy build with a matching worker. Check that every bundled PDF resource has the relevant upstream license/notice retained; do not summarize all fonts/CMaps/WASM as Apache-2.0.
6. Check the public extension ID remains stable. Upgrade by replacing files in the same unpacked directory and using **Reload**; do not uninstall as an upgrade test because uninstall deletes extension-local storage.

## PDF acceptance boundary

Before declaring PDF support accepted, test at least local-file open, same-hash re-selection restore, changed-hash non-migration, text and area annotation, direct HTTPS PDF authorization, redirect refusal, and no-cookie/no-credential behavior. Chrome 125 is the current intended minimum for the PDF page but remains subject to final browser validation. Webpage behavior continues to use the Chrome 120 boundary.

## Publish

Tag the exact verified commit, create the release/prerelease deliberately, upload ZIP and checksum assets, and verify the release URL, tag target, prerelease flag, and digests. CI may build artifacts but does not replace release acceptance or publish authorization.

## v0.3.1 candidate workflow

1. Run `npm run check`, `npm test`, `npm run test:bulk`, and `npm run test:release`. Large-data correctness has a separate single-worker 60-second ceiling; its timings are evidence, not a claim of improved performance.
2. Commit the candidate source before the release build. Run `npm run build`; require `build-info.json.dirty` to be false and its commit to equal HEAD. The clean build epoch defaults to the commit timestamp for reproducibility.
3. Run all browser tests and both minimum-browser CI gates. The same candidate commit must pass two complete CI attempts.
4. Run `npm run zip`. It packages the existing runtime, decompresses and compares every filename/content hash, and emits its SHA-256 file; it never triggers another build.
5. Extract that ZIP into a new acceptance directory with `node scripts/extract-runtime.mjs ZIP NEW_DIRECTORY`. Run tests against it with `WEB_INK_BUILD=NEW_DIRECTORY`. For the upgrade test, set `WEB_INK_OLD_BUILD` to a checksum-verified extracted v0.3.0 archive. The upgrade profile is artificial and disposable.
6. Verify ordinary-Chrome native permissions/side panel, public webpage/PDF recovery, reader coexistence, and the agreed competitor tasks separately. Pre-granted test profiles cannot close native acceptance. Save acceptance and comparison receipts with exact build identities; if any required gate is blocked, retain a candidate instead of publishing.
7. Install the exact accepted runtime with `node scripts/update-local.mjs --skip-build` only when `.output/chrome-mv3` matches the accepted ZIP. This fixed-directory updater records hashes in `.output/install-receipt.json`, keeps backups in `.output/install-backups`, and refuses unknown or changed installs. Do not remove its safety receipt to bypass a mismatch; investigate first.
8. After all gates pass, publish `v0.3.1` as a prerelease from that exact commit, attach ZIP, checksum and acceptance receipts, then download and verify the public asset. Do not overwrite the v0.3.0 archive.


## Runtime integrity before packaging or local installation

`npm run build` runs a post-build check: required entry points, manifest/HTML references, literal generated module imports/preload references, and every prepared public asset must exist. It then creates `runtime-integrity.json` with SHA-256 hashes of all runtime files except itself. PDF workers, CMaps, fonts, decoders and licenses are included in that inventory, even when their names are computed at runtime.

Both packaging and local installation require this inventory and compare the exact filename set and contents before writing. Missing `engine.js`, direct or transitive chunks, a PDF worker, a manifest icon, a missing inventory, modified bytes or unlisted files fail closed. Re-running the sealing step cannot bless missing static references or missing prepared public assets. Build using `npm run build`; running `wxt build` alone does not produce a sealed candidate.

For an existing install created before this change, an absent inventory is accepted only on the destination side after structural and identity checks. If an inventory exists there, it is always validated. Incoming builds never use this legacy allowance. The inventory is an accidental-corruption/completeness check, not a publisher signature or proof that browser acceptance has run. Required release tests and manual acceptance remain separate gates.
