# Web Ink

**Highlight webpages and PDFs, add notes, and draw on images in Chrome. No account. Annotations stay on your device.**

[Download preview](https://github.com/Kinono1/web-ink/releases) · [中文](README.md) · [Usage and limitations](docs/USAGE.en.md) · [Privacy](PRIVACY.md)

![Web Ink PDF entry](docs/images/v031-pdf-entry.png)

## Install

1. Download `web-ink-<version>-chrome.zip` from Releases and extract it into a permanent folder.
2. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`.
3. Open a webpage, click Web Ink in Chrome's toolbar, grant page access when prompted, and enable the bottom-right page switch before highlighting text.

Webpages require Chrome 120+, and the PDF reader requires Chrome 125+. This is a preview. Check **Library → Settings & data** for the installed version and build identity; source, development builds, and public archives may differ. Consult the release notes for verified coverage.

## Update without losing notes

1. Export a JSON backup from **Library → Settings & data**.
2. Replace the runtime files in the same install folder with the new archive's files.
3. Click **Reload** on Web Ink's extension card, refresh open webpages, and reopen the side panel.

**Do not uninstall: uninstalling removes extension-local data.** Keep the same browser profile and install folder. Developers can use `npm run update:local` to back up, verify identity, synchronize, and hash-check the existing `Web-Ink-Chrome` directory, with rollback on copy failure. Initial installation remains explicit.

## Read, annotate, return

- Select webpage text and choose a color. Click a saved mark to add a note or remove it; removal can be undone.
- Use the side panel's image tools for rectangles, ellipses, arrows, and freehand drawing.
- Choose **PDF** in the side panel, or **Open current PDF in Web Ink** when its source is recognized. Download authenticated files and choose them locally. Your default PDF viewer is unchanged.
- Search the library and export JSON or Markdown. If a webpage changes, unresolved notes are retained and can be rebound.

Data belongs to the current browser profile; there is no cross-device sync. Choose the same local PDF again to restore its notes. Original PDF bytes are not saved in the library. Back up before clearing browser data or changing devices.

## Limits and development

Webpage annotations do not cover iframes, page-owned Shadow DOM, canvas, or browser-internal pages. PDFs are limited to 50 MiB; no OCR, credential forwarding, or PDF write-back is provided. Online PDFs require an authorized direct public HTTPS URL. See [detailed usage](docs/USAGE.en.md).

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

Use Node 24.15+ within the package engine range and the committed lockfile. `zip` verifies and packages the existing tested build without rebuilding. Clean builds use the commit timestamp as their reproducible build epoch.

[Validation](docs/VALIDATION.md) · [Performance evidence](docs/PERFORMANCE.md) · [Release process](docs/RELEASING.md) · [Third-party licenses](THIRD_PARTY_NOTICES.md) · [MIT license](LICENSE)
