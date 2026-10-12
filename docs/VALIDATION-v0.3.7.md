# v0.3.7 — prepare authenticated IEEE PDFs before navigation

Baseline: main `d7f9bb1a0de5d803b5a1744044e648beb26deac6`, v0.3.6. Date: 2026-10-12, Asia/Shanghai. Runtime implementation candidate: `0e25fad3524fba45b94860594a13dac56d62e5a7`. Exact PR/main CI, final package, installation and activation results belong to the local delivery receipt; this record does not imply a public release.

## Behavior and boundaries

- The actual IEEE source page reads its observed same-origin PDF using the current session. Browser-enforced same-origin redirects are allowed; cross-origin redirects are blocked before the next request. Ordinary public PDF retrieval retains its existing credential-free, redirect-rejecting policy.
- The original page remains until PDF size, bytes and hash pass validation and the source tab/document/generation are rechecked. Cancellation or a late result cannot navigate a changed page.
- One global preparation holds bytes only in RAM. A ready file expires after two minutes; acknowledged 256 KiB chunks reach only the matching reader document. Completion, cancellation, expiry, tab closure and Reload release the data. The reader does not download it again.
- Shared phases, confirmed failure reasons, explicit cancellation and optional sanitized diagnostics appear in the pen menu, side panel and reader. Closing the menu leaves the task running. Unknown fetch failures remain unknown.
- The pen menu prioritizes current PDF, current annotations, Library and local file selection. The reader retains frequent navigation/zoom/search controls; More groups reading, annotation and file actions. Area colors appear only in area mode.
- No runtime dependency, permission, database migration, backup format, extension ID or installation path changed.

## Automated evidence

- Typecheck passed; 1,167 unit cases passed, two existing opt-in cases skipped. Read-only skill: 26; bulk correctness: three; release/install tools: 32.
- All 94 browser cases passed against the exact clean candidate build, including ten IEEE cases, checksum-verified old-record upgrade and three in-place Reload rounds. CI separately runs the complete suite and Chrome 120 webpage / Chrome 125 PDF compatibility gates.
- Focused tests cover failure-before-navigation, one download, cancellation, repeated requests, changed source, wrong reader/token, chunk order, expiry, ephemeral loss, 401/403/HTML/unknown errors and same-file versus changed-version isolation.
- Independent review fixed late cancellation, replacement-reader ownership, immediate local-port abort and setup-error sanitization. A disposable negative control changed source-page fetch mode to `cors`; the cross-origin regression failed at the intended assertion (one forbidden target request instead of zero). Original source and build hashes remained unchanged. The fixture denies external networking rather than contacting IEEE.

## Native Chrome and interoperability

- Used the user's existing Chrome window and original unpacked directory. Reload alone activated v0.3.7 / `0e25fad`; no uninstall, new installation directory or browser restart.
- Three real signed-in IEEE automatic opens succeeded from the pen menu without pasted URLs or downloaded-file selection. Actual area/text annotations and notes were saved and read back. Returning used the observed original reader address.
- The three returned files had different content hashes. The changed-version warning appeared, previous records remained readable through Library, and old coordinates were not applied to a changed copy. **Native same-hash IEEE coordinate restoration was not observed**; automated same-file restoration is separate evidence. A changing download timestamp was visible, but the complete cause of byte differences was not established.
- An exported 16-page PDF was independently inspected: standard `/Highlight`, appearance stream, 72 QuadPoints values and intact note text. Preview's Highlights and Notes displayed the added mark and note. A Poppler first-page render was checked for clipping and overlapping-color artifacts. This is one external-reader sample, not universal interoperability certification.
- Earlier real requests returned HTTP 202 with empty HTML and were correctly rejected while the original page stayed visible. A visible cached PDF did not establish that a fresh request was authorized. Fresh official full-text entry preceded successful reads; no credential or anti-bot bypass was attempted.

Licensed files, user annotations, temporary URLs, cookies, native profiles and screenshots remain outside Git. Final main activation must be read back after the final main build is installed.
