# Privacy

Web Ink is designed for local use.

## Data stored in the browser profile

- Web annotations: canonical URL, page title, selected text or image-identification metadata, drawing geometry, note, tags, color, timestamps, revision, and per-page enabled preference.
- PDF annotations: SHA-256 document hash, file name, optional source URL, page number, text anchor/context, and area geometry.
- Settings: language, theme, reduced-motion/reduced-transparency preferences, default color, and paused origins.

Annotations are stored in extension-owned IndexedDB. Settings are stored in `chrome.storage.local`.

PDF bytes are never stored in IndexedDB, `chrome.storage`, JSON backup, or Web Ink's own files. To restore annotations for a local PDF, the user selects the same-content file again and Web Ink compares its hash. A changed hash is treated as a different document.

Local and direct-reader PDF input is capped at 50 MiB to protect browser memory. This is an input limit, not a retention policy.

For image annotations, Web Ink stores source-identification metadata and shape coordinates. It does not separately download ordinary page images or save screenshots. A permitted inline `data:image` URL may itself contain encoded image data; if present, it is metadata supplied by the page and remains subject to input validation limits.

## HTTPS PDF reader requests

When an explicitly authorized HTTPS PDF reader is opened, Web Ink requests the direct PDF using `credentials: 'omit'`, `cache: 'no-store'`, and `redirect: 'error'`. It does not forward cookies, authorization headers, login state, or other credentials. Redirects are rejected in the MVP; use a final direct PDF URL or download and select the file locally.

Web Ink does not provide OCR, authenticated-page scraping, cloud retrieval, or PDF write-back/editing.

## Data not sent by Web Ink

Web Ink has no account, server API, cloud synchronization, analytics, telemetry, advertising SDK, or code that uploads annotations. Website network activity and the browser's own behavior are outside Web Ink's local storage behavior.

## Retention and user controls

You can pause an origin, disable a page, and delete individual annotations. Export JSON before uninstalling, clearing browser or extension data, changing profiles, or replacing a profile. Uninstalling removes extension-local data; Web Ink cannot recover records that were not backed up.

Backup schema v2 accepts v1 imports. Imported settings do not replace local settings. Conflicting IDs retain local records unless overwrite is explicitly selected.

## Deletion metadata

Deleting an annotation removes its content from the annotation library. A small local deletion record (ID, source key and revision, without quotation/note/drawing data) remains to reject stale writes and support safe session undo. These internal deletion records are not included in exported backups.
