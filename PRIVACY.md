# Privacy

Web Ink is designed for local use.

## Data it stores

- Annotation records: canonical page URL, page title, selected text or image-identification metadata, drawing geometry, note, tags, color, timestamps, and revision.
- Extension settings: language, default color, paused website origins and per-page enabled/disabled preferences.
- These records are stored in the browser profile: annotations in extension-owned IndexedDB and settings in `chrome.storage.local`.

For image annotations, Web Ink stores a source reference and shape coordinates. It does not separately download ordinary network images or save webpage screenshots/PDF files. A permitted inline data:image URL may itself contain a small encoded image payload; that URL is stored as metadata and is subject to the input length limit.

## Data it does not send

The extension has no account, server API, cloud synchronization, analytics, telemetry, advertising SDK, or code that uploads annotation data. The optional HTTP(S) permission is used to run the content script on pages that the user enables. Normal network activity of the websites themselves is outside Web Ink's storage behavior.

## Your controls and retention

You can pause an origin from the extension UI and delete individual annotations. Export a JSON backup before uninstalling, changing browser profiles, clearing browser/extension data, or replacing a browser profile. Uninstalling the extension removes its local storage; Web Ink cannot recover records that were not backed up.

JSON import is validated before writes, is limited to 20 MiB and 50,000 annotations, and does not import settings over local settings. Conflicting IDs keep the local record unless the user explicitly selects overwrite.
