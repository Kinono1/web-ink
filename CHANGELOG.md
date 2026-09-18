# Changelog

## 0.1.3 — initial public prerelease, 2026-09-18

- Added a fixed bottom-right palette button: gray/off, colored/on, with keyboard support and translated status labels.
- Pages start quiet. The switch is remembered independently for each canonical page; switching off hides tools/highlights without deleting annotation records.
- Disabled pages do not scan changing page text or show selection palettes. Existing site-pause rules still take precedence.
- Page preferences remain local UI settings and survive annotation writes/imports; backup format and database schema version are unchanged.
- PDF viewer support remains a separate, unimplemented feature.

## 0.1.2 — local candidate, 2026-09-18

- Fixed SPA navigation falsely reporting that content scripts were reading another page. Page scope is resolved from the browser-identified sending document's current URL, with document and origin validation retained.
- Ignore stale restoration results and retry navigation races silently, with a bounded retry count.
- Successful save notices disappear after 2.5 seconds. Background errors display once per page scope, including after dismissal or auto-hide; failed saves retain retry/discard controls.
- Added browser regressions for pushState, replaceState, back navigation, streaming updates, forged page reads, and repeated passive errors.

## 0.1.1 — local candidate, 2026-09-18

- Added a local-storage panel with annotation/page counts, UTF-8 record size, browser-reported estimates and backup-size information.
- Added advisory capacity notices; no automatic deletion or retention limit.
- Compact JSON backup output now matches the byte-size validation used for import, avoiding pretty-print inflation.
- Storage statistics are available only to trusted extension pages and do not expose library-wide counts to content scripts.

## 0.1.0 — local candidate, 2026-09-18

- Initial local-first Web Ink extension: text anchors, image drawing annotations, local library, backup/import, and conflict-aware storage.
- Added backup input validation, revision-safe overwrite import, and literal-safe Markdown index export.
- Added local release preparation: documentation, checksums, and CI artifacts. No public publishing is performed by CI.
