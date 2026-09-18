# Changelog

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
