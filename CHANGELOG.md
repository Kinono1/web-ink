# Changelog

## Unreleased

- Page keys drop known tracking parameters (`utm_*`, `fbclid`, `gclid`, `msclkid` and similar), so the same article matches however it was reached and click IDs stay out of the library and backups. IndexedDB v4 re-keys existing annotations, deletion records and page rows; older backups are re-keyed on import.
- Deleting a page's last annotation removes its page row, or clears its title when the page keeps a local on/off choice.
- Added **Delete all data** in Settings & data. It removes annotations, page rows, deletion records and PDF reading state, and keeps settings.
- Moved the service-worker message routing into `src/background/router.ts` with a route table and dedicated tests.
- Added Biome linting (`npm run lint`), declared `vite` directly, pinned `@vitest/coverage-v8`, and moved `@types/node` to Node 24.
- Browser tests that need historical baselines skip locally when the baseline is missing; CI still requires them.
- Split CI into parallel jobs and moved dated validation records to `docs/archive/`.
- Since 0.3.17: smoother PDF scrolling, a refined reading workspace, better annotation recovery and page export.

## 0.3.1 – 0.3.17 — 2026-09-19 to 2026-10-31

These versions were released without individual changelog entries. Highlights, grouped from the commit history:

- **PDF reader:** same-tab PDF handoff from the floating pen and side panel; saved reading positions; zoom, text search and focus reading; preserving original PDF notes and exporting a separate annotated PDF; IEEE sign-in reading with a scoped, short-lived session; corrupt-PDF failure handling; consistent highlight colors and geometry.
- **Webpages:** automatic or manual selection tools, annotation presets, pencil size, a draggable floating menu, recovery of annotations on dynamic feeds, and Markdown export of a page's annotations. Image drawing is marked as coming soon.
- **Library and side panel:** redesigned library, side panel and in-page toolbars on shared design tokens; PDF annotations in the Chrome side panel.
- **Reliability:** generation-aware runtime replacement and retried registration across worker wakes and extension Reload; verified local updates with backup and rollback; CRX packaging.
- **Engineering:** content engine, PDF reader and management UI split into owned modules; coverage thresholds, paired performance benchmarks and minimum-Chrome regression jobs in CI; the optional read-only annotation skill.

## 0.3.0 — performance preview, 2026-09-19

- Shared the webpage text index between selection capture and restoration, flushing queued DOM mutations before save and releasing replaced roots. Successful saves apply record deltas instead of full-page refreshes.
- Added owner-scoped cancellable query tasks, a single bulk read for indexed pagination, and 25/128-row batches for complete residual substring filtering. The library cancels previous input immediately before its 180 ms debounce.
- Reduced known-length PDF input copies; isolated document sessions and cleanup; replaced repeated page-offset rebuilding with a Fenwick index and batched size updates.
- Kept only the PDF viewport and neighboring pages mounted. Grouped annotations by page, paginated notes, and retained editor drafts across list reordering.
- Split PDF rendering, session, layout, input, and notes; management presentation/query; query planning; webpage hit testing and image layers into focused modules.
- Fixed legacy Chrome image-mark click/removal by passing a native SVG point to geometry hit-test methods.
- Preserved extension identity, IndexedDB v3, backup schema v2, deletion revisions, and runtime dependencies.

## 0.2.1 — annotation removal fix, 2026-09-19

- Added direct removal on saved webpage text/image annotations and PDF highlights/areas, with session undo.
- Replaced browser-native delete confirmation with an inline confirmation in the library.
- Kept PDF text selection working through the annotation overlay.
- Added durable deletion revisions so restoration cannot let a stale window overwrite restored records. Internal database v3 preserves existing data; portable backup schema remains v2.


## 0.2.0 — preview, 2026-09-19

This preview adds PDF reading and a quieter webpage engine. Local validation and measurement boundaries are documented in docs/VALIDATION.md and docs/PERFORMANCE.md; publishing requires the dedicated CI checks to pass.

- Added a quiet-by-default per-page webpage engine: the resident bootstrap keeps the palette and mode state, while selection, mutation observation, text indexing, and drawing load only after enable.
- Added shared macOS-style system/light/dark presentation tokens and reduced-motion/reduced-transparency preferences.
- Added delta-oriented webpage restore updates, cached text readings with DOM invalidation, and reusable SVG image layers.
- Added baseline PDF text/area metadata support. PDF annotations identify a document by SHA-256 and do not store source bytes.
- Added local-file re-selection for same-hash PDF restoration and a restricted direct-HTTPS reader path without credentials or redirects.
- Backup schema v2 accepts schema v1 imports.

## 0.1.3 — initial public prerelease, 2026-09-18

- Added a fixed bottom-right palette button and per-page enable preference.
- Added local storage statistics, backup/import, text highlights, image drawings, and conflict-aware local records.
- PDF support was not part of 0.1.3.
