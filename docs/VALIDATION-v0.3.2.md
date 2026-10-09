# Web Ink v0.3.2 — candidate validation checkpoint

This is a local candidate record, not a release or proof that the user's Chrome is running v0.3.2. Native Chrome acceptance is pending because the Mac was locked during computer-use checks. The installed main checkout remains v0.3.1 at `d37555855f4d3f8cec0bbd27d28de8afa12f49fc`.

## Automated checkpoint — 2026-10-10, Asia/Shanghai

Clean source/build: `6df483c80c995dc8ceab5fa1029c103928c509e3`, version `0.3.2`, `dirty:false`. Node 26.5.0; Playwright 1.63.0; isolated Chrome for Testing 153.0.8010.12.

| Check | Actual result |
| --- | --- |
| Type check | Passed |
| Ordinary unit suite | 285 passed / 27 files |
| Serial large-data suite | 3 passed / 2 files |
| Release/installation tools | 17 passed; no skipped tests |
| Production build | Passed; 226 sealed entries plus integrity manifest |
| Full browser suite | 57 passed / 5 files; 69.854 seconds |
| Release-mode local ZIP | Passed; 227 runtime files matched after extraction |

The full browser run includes text/image creation and recovery, deletion/undo and conflicts, PDF selection/save/failed retry, same-tab handoff and token/return behavior, hash-bound bookmarks, bounded 500/1000-page rendering, browser restart, three in-place extension Reload transitions, and the old-version upgrade. Functional host tests use synthetic responses and disposable pre-granted manifests. They do not establish native permission approval, actual IEEE access or Scholar coexistence.

The first full 8af checkpoint had three failures caused by old theme/initial-detail assumptions; these were corrected without dropping data/undo assertions. Rebuilding also exposed an exact PDF CTA selector mismatch, fixed in `6df483c`. No browser test was skipped.

## Independent checks and evidence boundaries

The v0.3.0 upgrade baseline is the public ZIP with SHA-256 `d8298aca8ff085ad282595cef898d96bfaef7657e2ec8f4e28110aeb72dfe9a2`; the separate Reload baseline is clean v0.3.1 commit `d37555855f4d3f8cec0bbd27d28de8afa12f49fc`. Upgrade assertions retain all four annotation types, ID/body/note/color/tags/revision/target, settings and local preferences, and JSON export/import.

The 6df local ZIP SHA-256 is `0617b8bc488801af293701336c18ca5607c58ce2574e271e16ab4bea9b467008`. An independent extraction audit found zero missing, extra or changed files; the manifest derives the existing extension ID `cmllmmnfiefikhcbelokclankodgcdog`. PDF.js resource notices and the full pinned implementation-reference notices are present. The file/content checks found no test profiles, backup files, artificial PDFs, source maps or common credential patterns. This is a bounded package audit, not a general legal or security determination.

Pinned source snippets, adapted input/output contracts, retained Web Ink logic and license boundaries are documented in [OPEN_SOURCE_REFERENCES.md](OPEN_SOURCE_REFERENCES.md). No runtime dependency, annotation database/backup schema or extension identity change was introduced.

Actual local synthetic-PDF and Management captures verify the 52px reader bar, 320px notes rail/overlay, light/dark surfaces, real 200% tab zoom, 320px side panel, saved Chinese highlight/note and bounded 3–4 canvases. Three Management captures were invalid evidence (wrong theme filename, unsettled filtered list, clipped full-page zoom capture); they were preserved and replaced with explicitly asserted theme/row/viewport captures. These were harness errors, not proof of production defects.

Fresh visual review identified three concrete CSS issues: light placeholders and selected-label contrast, and a 24px native tag field. `cfdc565d02c6c1d38c027f46d84f892b077e8527` uses existing text roles and the existing 36px/8px field style. Shared theme values and annotation colors stay intact. The affected suite passed 49 tests. Actual Management post-fix measurements show tag fields at 36px / 8px / 14px in both themes, placeholders at 6.77:1 light and 5.61:1 dark, and selected labels at 14.52:1 light and 10.46:1 dark. The actual PDF active More label and public-source placeholder pass at the same respective ratios in both themes; the input was not submitted. Final independent visual scoring remains a separate receipt.

## Gates still pending

- Regular Chrome's native allow/deny prompts; actual built-in viewer and Scholar coexistence; public HTTPS/IEEE accessible and inaccessible paths; local Chinese/image-only/changed-content files.
- Three actual Chrome Reload-button rounds using one loaded directory and ID, without uninstalling, changing directories, host refresh or browser restart; final user-profile activation. Automated Reload evidence does not replace this gate.
- Exact PR-head CI including Chrome 120 webpage and Chrome 125 PDF checks; merge commit to main; final main CI/build/ZIP; primary-checkout installation sync and actual runtime health.

No push, PR, merge to main, public Release or tag has been performed at this checkpoint. Ordered native acceptance remains before PR integration. Saved test evidence and temporary profiles are excluded from Git; personal PDFs, notes and browser profiles were not used.
