# v0.3.5 — native PDF notes and annotated PDF export

Baseline: main `13f75beda34b3d69b0a6972991ee829d846b79fb`, v0.3.4. Validation date: 2026-10-12, Asia/Shanghai. Commit-specific CI and installation receipts are recorded separately; this document does not claim a public release.

## Behavior and compatibility

Original PDF annotations remain in the PDF and are read-only in Web Ink. The existing sidebar offers All, Web Ink and Original filters; Original notes are not imported into IndexedDB or the JSON backup. Popup/replies are grouped with their parent. Rendering uses PDF.js's original appearance streams and official annotation layer, without drawing a second original highlight.

Export starts from the unchanged source bytes and a saved, exact-content-hash snapshot. New highlights and rectangles use standard annotations with appearance streams and Unicode Contents. An independent PDF.js readback verifies original annotation semantics, new geometry/text/count, page boxes/rotation and a distinct output hash before download. Repeated export does not append to an earlier output. Reopening the output treats its embedded notes as original notes and does not apply the input's local overlay.

Encrypted, signed, annotation-restricted, XFA, damaged and over-50-MiB inputs are refused for export. This is not a guarantee of lossless rewriting of every complex PDF. No flattening, source overwrite, database migration, permission expansion or automatic model upload is introduced.

## Evidence

- Final integration typecheck passed. Unit suite: 969 passed, two opt-in cases skipped by default. Those two cases (writer performance and real Preview-authored input) were separately executed and passed.
- Large-data correctness: three passed. Installation/release tooling: 31 passed. Read-only annotation skill: 26 passed. Original PDF dates are preserved independently even when a modification date precedes creation; durable Web Ink records retain their chronology invariant.
- Full browser suite: 85 passed, including checksum-verified v0.3.0 upgrade and pinned v0.3.1 Reload baselines. Browser integration uses real PDF.js canvas pixels and metadata: original custom appearance before/after export, new note export, repeated export, H1 reopen, no original-note database import, complete AI snapshot, and bounded virtual canvases. Exact candidate commit and later native-window results are recorded in the local acceptance receipt.
- An existing IEEE failure-loop case exposed an intermittent stale sidebar context (84 passed / one failed on the first full run). Tab event subscriptions now remain stable across context renders. The new lifecycle regression and unchanged IEEE end-to-end assertion passed; the complete 85-case rerun passed. The original failing trace is retained locally.
- A synthetic two-page PDF was annotated and saved in the actual macOS Preview application. Independent source readback found five annotations: two yellow highlights, one underline, one rectangle and one Chinese multiline sticky note. Source SHA-256: `4bc07d82f5dbfc3ff0217fdc7e06f3067d609ddfde18c85bbff5615d036d2201` (29,456 bytes).
- The writer probe retained those five and appended two Web Ink annotations containing Chinese, emoji and newlines. The source hash remained identical. Actual Preview opened the output and exposed all seven annotations and their note bodies. Probe output SHA-256: `1a65e19effbe2e1d392bab242170a87867db34e9e4929231f6f86dac15d1ffe9` (26,323 bytes). This probe supplements, rather than replaces, the reader UI acceptance.
- Preview's green-highlight authoring was not confirmed: its color menu did not accept the automated choice. Acrobat Reader is not installed and was not tested or installed. Tested-reader results must not be reported as universal compatibility.

Synthetic PDFs, Chrome profiles, raw acceptance captures and exported notes remain outside Git. No personal PDF or note is included in the repository.

## Export performance scope

Node 26.5.0 / macOS, pdf-lib 1.17.1 and PDF.js 6.3.289. Five adapter runs each; hash/load/append/save only, excluding worker startup and independent verification.

| Input | New annotations | Input/output bytes | Five durations in ms |
| --- | --- | --- | --- |
| 10 pages | 20 | 5,449 / 13,576 | 9.42, 7.45, 4.24, 4.29, 4.14 |
| 100 pages | 200 | 42,315 / 121,530 | 37.25, 33.41, 35.56, 32.76, 31.43 |

These small synthetic samples do not measure peak browser memory, 50-MiB throughput or arbitrary research-paper latency. The writer is dynamically loaded in an owned worker only after an export action; it adds no writer request or parsing work to the PDF opening path.
