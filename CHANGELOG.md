# Changelog

## 0.3.0 — performance preview, 2026-09-19

- Shared the webpage text index between selection capture and restoration, flushing queued DOM mutations before save and releasing replaced roots. Successful saves apply record deltas instead of full-page refreshes.
- Added owner-scoped cancellable query tasks, a single bulk read for indexed pagination, and 25/128-row batches for complete residual substring filtering. The library cancels previous input immediately before its 180 ms debounce.
- Reduced known-length PDF input copies; isolated document sessions and cleanup; replaced repeated page-offset rebuilding with a Fenwick index and batched size updates.
- Kept only the PDF viewport and neighboring pages mounted. Grouped annotations by page, paginated notes, and retained editor drafts across list reordering.
- Split PDF rendering, session, layout, input, and notes; management presentation/query; query planning; webpage hit testing and image layers into focused modules.
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
