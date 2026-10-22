# Web Ink

**Highlight webpages and PDFs and add notes in Chrome. No account. Annotations stay on your device.**

[Download preview](https://github.com/Kinono1/web-ink/releases) · [中文](README.md) · [Usage and limitations](docs/USAGE.en.md) · [Privacy](PRIVACY.md)

![Web Ink PDF selection tools](docs/images/v032-pdf-selection.png)

## Install

1. Download `web-ink-<version>-chrome.zip` from Releases. Extract the `web-ink` folder and keep it in a permanent location. Only the ZIP filename includes the version.
2. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select the `web-ink` folder containing `manifest.json`.
3. Open a webpage, click Web Ink in Chrome's toolbar, and grant page access when prompted. Select text and choose a color or add a note in the side panel. Enable automatic reminders in Settings to show selection tools on current and new webpages.

Webpages require Chrome 120+, and the PDF reader requires Chrome 125+. This is a preview. Check **Library → Settings & data** for the installed version and build identity; source, development builds, and public archives may differ. Consult the release notes for verified coverage.

## Update without losing notes

1. Export a JSON backup from **Library → Settings & data**.
2. Copy the **contents** of the extracted `web-ink` folder into the original install folder, replacing matching files and merging subfolders. Do not nest another `web-ink` folder inside it. If the old install folder has a version in its name, keep that original name and path.
3. Click **Reload** on Web Ink's extension card and reopen the side panel. If the browser refuses reinjection into a page, follow the prompt to refresh that page and retry.

**Do not uninstall: uninstalling removes extension-local data.** Keep the same browser profile and install folder. Developer updates run only in the primary checkout. Chrome's loaded target stays `.output/chrome-mv3`; builds go to `.build-output/chrome-mv3`, and receipts and recovery backups live in `.local-install/`. Explicitly enroll a confirmed legacy installation once with `npm run register:local`, then use `npm run update:local`. The updater accepts a clean commit's matching sealed build, backs up and overwrites runtime files individually, hash-checks the result, and rolls back on failure. Linked worktrees are rejected before building or writing. Initial installation remains explicit.

## Read, annotate, return

- Select webpage text and choose a color. Click a saved mark to add a note or remove it; removal can be undone.
- Adjust **Pencil size** (40–64px) and **Default highlight color** in **Settings & data**. The Apple five-color palette remains available; a custom color outside that palette adds a separate sidebar swatch without changing saved annotations.
- **Show annotation tools automatically** defaults to off. Enable it in the side panel or **Settings & data** to select text directly on current and new authorized webpages. Paused sites remain off. While automatic reminders are on, saved page-off choices do not block annotation. Turning reminders off restores manual page choices; the pen and side panel still work, and saved records remain available.
- Use editable color/tag presets for selected text. PDF **More → Focus reading** hides the reader bar while keeping pages, annotations and exit available.
- **Image drawing (coming soon):** The side-panel entry remains visible but is disabled. Existing image annotations and notes are preserved.
- For a PDF in the current tab, click the floating pen and choose **Open current PDF**. If the pen is unavailable, open Web Ink from Chrome's toolbar and choose **Start annotating in this tab** in the existing side panel. With the IEEE PDF already open, choose **Open using IEEE sign-in** from the floating-pen menu or side panel; grant Chrome's IEEE site access if requested. On a page containing only paper information or a download link, first open the PDF on IEEE. The Web Ink reader opens in the same tab and keeps **Return to original reader**. Saved PDF marks and notes appear in the existing Web Ink side panel; the reader has no separate Notes button. If a source cannot be read, download it and choose the file locally.
- Read original PDF notes in the sidebar and export a separate annotated PDF from **More**. The source is not overwritten. A current-file JSON notes snapshot is also available for the read-only skill.
- Search the library and export JSON or Markdown. If a webpage changes, unresolved notes are retained and can be rebound.

Data belongs to the current browser profile; there is no cross-device sync. Choose the same local PDF again to restore its notes and reading position. Original PDF bytes are not saved in the library. Reading and floating-button positions are local preferences outside annotation backups. Return sessions may expire after browser restart or extension Reload; the reader then offers the PDF source or file selection. Back up before clearing browser data or changing devices.

## Search exported annotations

The repository includes the source for an optional read-only annotation skill. Web Ink does not install it into your Codex skills root, and it does not provide a live MCP connection. The skill reads only the JSON export you select; it does not read browser profiles, access the network, or write to the export. It can search saved excerpts and notes, not the complete paper or webpage. See [usage and limitations](docs/USAGE.en.md) for the commands and scope.

## Limits and development

Webpage annotations do not cover iframes, page-owned Shadow DOM, canvas, or browser-internal pages. PDFs are limited to 50 MiB; there is no OCR or PDF write-back. Ordinary online PDFs require an authorized direct public HTTPS URL. IEEE has a separate, explicit same-origin sign-in flow; other authenticated sites, cross-origin redirects, and password-encrypted PDFs are unsupported. See [detailed usage](docs/USAGE.en.md).

```sh
npm ci
npm run check
npm test
npm run test:bulk
npm run test:release
npm run build
npm run test:e2e
npm run zip
```

The full browser suite requires two verified baselines: `WEB_INK_OLD_BUILD` is the extracted v0.3.0 release archive, and `WEB_INK_RELOAD_OLD_BUILD` is the v0.3.1 build at commit `d37555855f4d3f8cec0bbd27d28de8afa12f49fc`. CI prepares both. See [release process](docs/RELEASING.md) for local setup; missing baselines fail instead of skipping upgrade acceptance.

Use Node 24.15+ within the package engine range and the committed lockfile. `build` checks entry points, static resource references and prepared PDF assets, then writes `runtime-integrity.json`. Installation and packaging reject missing, modified or unlisted runtime files. Complete legacy installs can still be upgraded. `zip` verifies and packages the existing build without rebuilding. Clean builds use the commit timestamp as their reproducible build epoch.

[Validation](docs/VALIDATION.md) · [Performance evidence](docs/PERFORMANCE.md) · [Release process](docs/RELEASING.md) · [Third-party licenses](THIRD_PARTY_NOTICES.md) · [MIT license](LICENSE)
