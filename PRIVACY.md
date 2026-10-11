# Privacy

Web Ink is designed for local use.

## Data stored in the browser profile

- Web annotations: canonical URL, page title, selected text or image-identification metadata, drawing geometry, note, tags, color, timestamps, revision, and per-page enabled preference.
- PDF annotations: SHA-256 document hash, file name, optional source URL, page number, text anchor/context, and area geometry.
- Settings: language, theme, reduced-motion/reduced-transparency preferences, default color, and paused origins.

Annotations are stored in extension-owned IndexedDB. Settings are stored in `chrome.storage.local`.

PDF bytes are never stored in IndexedDB, `chrome.storage`, JSON backup, or Web Ink's own files. To restore annotations for a local PDF, the user selects the same-content file again and Web Ink compares its hash. A changed hash is treated as a different document.

Local and direct-reader PDF input is capped at 50 MiB to protect browser memory. This is an input limit, not a retention policy. Text indexes, DOM ranges, query cancellation state, PDF input buffers, page-height indexes, and editor drafts are session-only objects. They are not added to the database or portable backups. Closing a document or the extension page releases its owned PDF loading/rendering work.

For image annotations, Web Ink stores source-identification metadata and shape coordinates. It does not separately download ordinary page images or save screenshots. A permitted inline `data:image` URL may itself contain encoded image data; if present, it is metadata supplied by the page and remains subject to input validation limits.

## HTTPS PDF reader requests

For ordinary public HTTPS PDF sources, Web Ink requests the direct PDF using `credentials: 'omit'`, `cache: 'no-cache'`, and `redirect: 'error'`. It does not forward cookies, authorization headers, login state, or other credentials. Redirects are rejected in the MVP; use a final direct PDF URL or download and select the file locally.

Each open revalidates the response with the server. When HTTP validators confirm that a public PDF is unchanged, Chrome may reuse its HTTP cache instead of transferring the body again. This cache is managed by the browser and server cache policy, outside Web Ink's database and backups; clearing Web Ink annotations does not clear the browser HTTP cache. Local file input is not added to this cache. Web Ink does not use an offline fallback when revalidation fails.

IEEE is an explicit exception: choosing **Open using IEEE sign-in** on an observed HTTPS `ieeexplore.ieee.org` paper page creates a tab-bound, short-lived session grant. Only same-origin observed PDF sources or sources found in the bounded, inert wrapper HTML are fetched with `credentials: include`, `cache: no-store`, and `redirect: error`. Web Ink never reads Cookie values or passwords. Temporary download addresses stay in session storage, while annotations retain the paper page without ticket parameters. The grant expires after ten minutes or when changing files, leaving, refreshing the reader, or reloading the extension. Return to IEEE to start again. Other authenticated sites, cross-origin redirects, and password-encrypted PDFs remain outside this flow.

Web Ink does not provide OCR, general authenticated-page scraping, cloud retrieval, or PDF write-back/editing.

The optional annotation skill reads only the JSON export explicitly selected by the user. The script makes no network requests and never reads browser profiles or writes the file. Sending those excerpts to a model is controlled by the chosen model service and is not claimed to be entirely local.

## Data not sent by Web Ink

Web Ink has no account, server API, cloud synchronization, analytics, telemetry, advertising SDK, or code that uploads annotations. Website network activity and the browser's own behavior are outside Web Ink's local storage behavior.

## Retention and user controls

You can pause an origin, disable a page, and delete individual annotations. Export JSON before uninstalling, clearing browser or extension data, changing profiles, or replacing a profile. Uninstalling removes extension-local data; Web Ink cannot recover records that were not backed up.

Backup schema v2 accepts v1 imports. Imported settings do not replace local settings. Conflicting IDs retain local records unless overwrite is explicitly selected.

## Deletion metadata

Deleting an annotation removes its content from the annotation library. A small local deletion record (ID, source key and revision, without quotation/note/drawing data) remains to reject stale writes and support safe session undo. These internal deletion records are not included in exported backups.
