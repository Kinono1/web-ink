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
