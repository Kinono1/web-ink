# Validation — Web Ink

## 0.3.0 performance preview — 2026-09-19

Local TypeScript/build, **124 unit tests across 16 files and all 27 Chromium browser tests passed**. The final webpage runtime/benchmark source is `69bdd60`; the unchanged PDF source was measured at `0326026`. The matching release commit must also pass the dedicated Chrome 125 PDF/query and Chrome 120 webpage CI gates before publication. The release notes link that exact run.

Chrome 120 CI exposed a saved-image click failure in the previous DOMPoint-based SVG hit test. The compatibility fix uses `createSVGPoint()` from the owning SVG, retaining exact fill/stroke hit testing. The minimum-browser regression also checks the SVG group's actual display state when CSS transforms temporarily hide marks. [MDN compatibility source](https://github.com/mdn/browser-compat-data/blob/main/api/SVGGeometryElement.json).

New coverage includes native SVG-point arguments; shared-index build counts; pending text/child-node mutations, replaced roots and contenteditable changes; scoped query cancellation, errors retaining prior UI records, full 1k/10k/50k reference-result comparisons and compound pagination; known/unknown/compressed PDF input, 20/50 MiB limits, mismatched lengths, interruption/reselection; 500/1000-page mixed-size jumps and zoom/rotation; rapid A/B/C sessions; 50-row PDF notes and draft retention through reordering; frame-local shared-image geometry reads. Existing deletion, undo, stale writes, browser restart, v1/v2 database upgrades, v1 backups, per-page toggles, SPA ownership and 320px/dark UI cases remain green.

The database, message model and backup files differ from v0.2.1 only by deterministic formatting; their persisted structures are unchanged. IndexedDB remains v3, backup schema remains v2, and the manifest public identity key is unchanged. The install ZIP was checked against the built files and contains 224 runtime/resource/license files, without PDFs, source maps, profiles, backups or secrets.

[Performance results](PERFORMANCE.md) include 30-sample baseline/candidate runs and raw data. All stated webpage timing gates passed. PDF results explicitly separate allocation ownership and bounded canvas counts from unavailable whole-browser peak memory; the large-file opening test does not show a startup speedup. Synthetic PDF/library screenshots were inspected. Native Chrome permission approval and personal-profile acceptance remain the manual boundary described below.

## 0.2.1 removal fix — 2026-09-19

Local TypeScript/build, **90 unit tests and 23 browser tests passed**. New scenarios exercise direct removal of saved webpage text/images, selecting existing text, individual overlapping-mark removal, delete failures preserving data, native-dialog-free library deletion, PDF removal after reselecting the same file, and revision-safe undo preserving notes/tags/color/identity. Existing PDF text selection continues through the non-interactive overlay.

Internal IndexedDB v3 adds deletion revisions; v1/v2 upgrades preserve records and page preferences. Portable backup schema remains v2. The dedicated Chrome 125 PDF CI suite now contains six tests and remains a release gate.


## 0.2.0 candidate — 2026-09-19

Local TypeScript/build and **86 unit tests across 11 files** passed. Browser regression development covers optional hosts, actual webpage selection/drawing/rebinding, SPA isolation, failed-save recovery, CAS drafts, backup import/export, per-page mode persistence, native Range/SVG reuse, PDF local/HTTPS input, unchanged-file restoration, changed-file isolation, Chinese/multicolumn text, zoom/rotation and bounded page rendering. The local Chromium suite passed all 17 browser tests, including the 320px dark UI. The final CI result is linked from the release.

Performance results and their limits are in [PERFORMANCE.md](PERFORMANCE.md). PDF files are not persisted. Browser tests use isolated profiles and reviewed artificial fixtures; functional hosts are pre-granted in a disposable manifest. Native permission-dialog acceptance and personal user acceptance remain separate manual checks.

The minimum PDF target is Chrome 125; the dedicated CI step runs the PDF suite in Chrome for Testing 125.0.6422.141. Its result must pass before publishing this prerelease. No account, credential or real research PDF is used in those tests.

Public-page automation passed text creation and reload on Wikipedia and MDN. GitHub navigation timed out before DOMContentLoaded and was not verified in this run; see [raw site results](real-sites-v0.2.json).


## 0.1.3 — 2026-09-18

TypeScript/build passed; **53 unit tests across 9 files and 11 Playwright browser tests passed**. The new palette test verifies quiet-by-default selection, enabling, persistence across reload, hiding existing highlights on disable without deleting them, restoration after re-enable, and independence of another page's default state. The browser-restart test now checks that the stored enabled state survives without an automatic test-helper click.

Page-mode unit tests verify side-effect-free reads, current-page authorization, preserved annotations, preservation of mode on ordinary annotation writes and backup import, and rejection of enable requests on paused sites. The switch is an optional field in the existing pages store, so there is no database version migration or permission expansion. Older pages without a switch preference start quiet and require one deliberate enable click.

The native-PDF viewer remains unsupported; the palette does not add PDF capabilities. Synthetic off/on screenshots are in the browser test results. The native Chrome permission/side-panel manual acceptance boundary below remains unchanged.

## 0.1.2 — 2026-09-18

TypeScript/build passed; **46 unit tests across 8 files and 10 Playwright browser tests passed**. A repeated `Content scripts may only list their own page` popup was reproduced with an isolated page using history.pushState and streamed DOM updates. The pre-fix test failed on the visible repeated error; the fixed build passed pushState, replaceState, back-navigation, correct per-route storage, and a forged cross-page read denial.

The fix resolves the current URL through `chrome.scripting` targeted at the browser-supplied document ID, validates the document/frame/origin, and continues to reject requests for other pages. It does not simply trust the page URL supplied by a content message. Concurrent probes are coalesced, but URL results are not retained across later requests.

Notification tests verify success auto-dismiss, passive-error dismissal and auto-hide deduplication, independent error keys, safe text rendering, timer disposal and sticky failed-save protection. A browser fault-injection case additionally verifies that closing a recovery error survives repeated DOM updates, while a genuine failed write retains its retry button and does not report a saved record.

No schema or host-permission changes. The isolated SPA fixture reproduces the reported mechanism; this is not a comprehensive test of signed-in ChatGPT sessions. After replacing the visible install folder, reload the extension and refresh already-open web pages so old content-script contexts are removed.

## 0.1.1 — 2026-09-18

TypeScript/build passed; **35 unit tests across 6 files and 8 Playwright browser tests passed**. Added storage statistics cover UTF-8 byte counts, exact compact-backup size, unavailable browser estimates, trusted-page access and count updates after deletion. The UI check covers create/delete count refresh and explicit estimate labeling. Compact JSON export preserves the import size limit without indentation inflation.

The statistics endpoint is read-only. It does not remove records, impose a new save limit, or include developer tooling in usage estimates. No schema or permission migration is required. This version's native Chrome permission approval and user acceptance remain pending under the boundary described below.

## 0.1.0 baseline

Checked 2026-09-18, Asia/Shanghai. Local build runtime: Node.js 26.5.0; CI is configured for Node.js 24.15.0; current run results are available in GitHub Actions.

## Passed locally

- `npm run check`: TypeScript and generated WXT types.
- `npm test`: **30 tests across 5 files**. Includes precise text recovery, image geometry, duplicate-target refusal, CAS conflicts, cross-page record ownership, strict backup validation, literal Markdown export, a 200-anchor restore sample, and a 10,000-record database import/read sample.
- `npm run test:e2e`: **7 tests** using Playwright Chromium 153.0.8010.12, isolated profiles, and artificial fixture content.
- `npm run zip` and SHA-256 verification: packaged successfully; third-party license texts included.

The browser scenarios cover text selection and highlighting; reload and full browser restart; stopping the service worker and reading persisted records afterward; all four image tools; responsive image scaling; drawing undo/redo; source changes becoming unresolved; manual rebind; site pause/resume; editor conflict preservation; and JSON download/import through the library UI.

## Permission-test boundary

The production manifest is directly verified to have **optional** HTTP(S) access, a visible onboarding button, and no page injection before access is granted.

Functional browser tests use the same production JavaScript copied to a disposable directory. That copy's manifest pre-grants HTTP(S) access because headless Chromium cannot approve the native extension permission prompt. This is a test harness change, never a production manifest change. It is not evidence that the native permission approval UI has passed manual acceptance.

## Live public pages

The following text-create → refresh → restore checks passed on 2026-09-18 in the isolated functional-test configuration:

| Site | Page | Result |
| --- | --- | --- |
| Wikipedia | `https://en.wikipedia.org/wiki/Web_annotation` | PASS |
| MDN | `https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API` | PASS |
| GitHub | `https://github.com/wxt-dev/wxt` README | PASS |

Exact check timestamps and results: [real-sites-2026-09-18.json](real-sites-2026-09-18.json).

These checks cover selected text on these pages, not every page on those domains, all types of images, or site-wide compatibility. They found and led to fixing a selection toolbar disappearing during delayed scrolling. Image behavior is verified against the artificial responsive fixture, not these three public pages.

## Visual inspection

The library and image overlays were rendered and visually reviewed. Screenshots contain only artificial fixture content:

- [Library](images/library.png)
- [Four image tools](images/image-tools.png)

## Remaining manual acceptance

The headless suite does not establish native browser permission approval or native side-panel interaction. Manual acceptance checklist:

1. Load the production `.output/chrome-mv3` directory in regular Chrome.
2. Click the toolbar icon and confirm its native side panel opens.
3. Use **Enable page access**, approve Chrome's native prompt, then mark text and an image on a page you use.
4. Close Chrome, reopen it, verify the markings, and test JSON backup/restore.
5. With a backup retained, reload an updated build and verify existing records remain.

The GitHub release is a **prerelease candidate**. Publishing the source and install archive does not establish universal compatibility or complete this manual acceptance checklist.
