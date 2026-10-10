# Web Ink v0.3.2 — validation checkpoint

Updated 2026-10-10 (Asia/Shanghai). This record separates the current native Chrome acceptance from earlier synthetic-browser and package evidence. The current tested candidate is v0.3.2 at `9281febd05766fad18d5b5d55df0cd1d58c40457`. Native acceptance used the existing user Chrome window; no extension uninstall, new QA window, profile replacement, or browser restart was used. PR and post-merge validation remain separate gates.

## Latest candidate acceptance — 9281feb, 2026-10-10

| Check | Result on the clean candidate |
| --- | --- |
| Type check | Passed |
| Ordinary units | 313 passed / 27 files |
| Serial bulk correctness | 3 passed / 2 files |
| Release/install tools and real PDF.js error regression | 31 passed |
| Full CFT browser regression | 58 passed / 5 files, including pinned upgrade and three Reload transitions |
| Release-mode local ZIP | 227 files, matching both the tested staging build and current installation byte for byte |

ZIP SHA-256: `1348e1fa177d37d2091b7683ce20f1dde4147ccef69767d27f74c6960d8ba287`.
The published v0.3.0 upgrade fixture was downloaded again, verified against both
the published checksum and the pinned hash below, then extracted into a fresh
temporary directory. The separate Reload fixture was the verified clean v0.3.1
build at `d375558`. Missing fixtures were not skipped.

The production installation remains
`/Users/kino/Files/work_projects/code/web-ink/.output/chrome-mv3`, with extension
ID `cmllmmnfiefikhcbelokclankodgcdog`. Source/build/backup separation and file
hashes were checked by the installation command. After actual native Reload,
settings showed `v0.3.2 · 9281feb`, runtime generation
`22bcd191-1c40-45ec-9969-83a58ecf54a4` (before the final repeated Reload).

Native checks in the original Chrome 154.0.8037.98 window:

- Reload to `5516bc1`, Reload to `9281feb`, and a repeated Reload at `9281feb`
  each showed Chrome's own `Reloaded` status. No uninstall or alternate load
  directory was used. On the already open Deep Image Prior webpage, exactly one
  palette remained, its saved off state was retained, and click-on/click-off
  worked. The page was left in its original off state.
- The existing public MICCAI 3466 PDF tab switched from Scholar to Web Ink through
  the real side panel. It restored page 3 and the earlier saved test note. A new
  text highlight showed a confirmed local-save notice, survived actual page
  refresh, and appeared alongside the earlier note. Returning after the reader
  updated its URL went back to the original public URL and Scholar in the same
  tab.
- Page 4 of that PDF has an oversized image. The reader now displays an explicit
  incomplete-page notice and preserves saved annotations; it does not silently
  omit the figure while permitting annotation on that page. The synthetic
  actual-PDF.js regression verifies that a second healthy page still renders
  and that failed pages have no text/area/annotation capture surface.
- Automated native drag input did not establish area creation. After the final
  pointer-coordinate fix, the user manually confirmed a save notice or new
  area record in the same window. This is **manual native evidence**, separate
  from the passing synthetic area, deletion/undo and failure-retry tests.

The additional fixes were driven by failed regressions: strict PDF.js stream
errors previously resolved partial operator lists/render tasks; Chrome retains
`MessageSender.url` after the reader's same-document `replaceState`; and area
save previously depended on React committing a preview before pointerup.
The PDF.js correction is pinned and documented in `OPEN_SOURCE_REFERENCES.md`.

Local logs and receipts are excluded from Git under
`.superpowers/sdd/2026-10-09-web-ink-v032/scratch/current-chrome-acceptance/`:
`area-candidate-{check,unit,bulk,release,build,e2e,zip}.log`,
`native-area-{build,update}.log`, `area-package.json`, and the earlier
`image-stream-*`, `return-unit-*`, `area-final-*` failure/repair evidence.
Only authored fixtures and public PDFs were used. Personal notes, profiles,
exports and screenshots are not repository inputs.

## Earlier native Chrome checkpoint — 6efd02d, 2026-10-10

The user’s existing Chrome 154.0.8037.98 window was kept open. The existing extension ID `cmllmmnfiefikhcbelokclankodgcdog` was unchanged. The loaded directory `/Users/kino/Files/work_projects/code/web-ink/.output/chrome-mv3` was reloaded with the v0.3.2 build at `6efd02d` (`dirty:false`). Its `build-info.json` SHA-256 is `c60adac8e07638521c11e2911c0cc2acd6978a05da9b69f1c6648a67acabbf01`. The observed runtime identity was `v0.3.2 · 6efd02d`, generation `953439d3-d086-4e19-83bd-71dbec390cdc`.

The native side panel reported Chrome’s `SIDE_PANEL` context with `windowId = -1`. The candidate handled this context successfully. From the Google Scholar PDF Reader page for public MICCAI paper 3466, the side panel opened the extension reader in the same tab. A real text selection was highlighted, a note was explicitly added and saved, and the note and highlight remained after refreshing on page 3. The reader’s return action went back to the original Scholar URL.

The three local artificial PDFs were identified by SHA-256 and exercised in the existing Chrome window:

| Fixture | SHA-256 | Observed result |
| --- | --- | --- |
| `中文多栏原版.pdf` | `f22ab5b9e585a652844ef267c319fbf16d87ccef19264f606229c1dc78a24bbc` | Created a green highlight. After refresh, the reader asked to reselect the local file; selecting the same file restored page 2 and its annotation. |
| `中文多栏内容变更.pdf` | `9259b30e1deb53219c400c5399fd2355ca6a6d7fe0053457c2c47872b4636d6f` | The prior annotation remained stored, while the changed document showed zero annotations. |
| `原创图像扫描样例.pdf` | `5e2317f95a0405c28f7d3ab03a518839e4b12d766612e44230010feaef08ba23` | The scan displayed correctly and area mode opened. A native drag did not create a selection, so native area annotation is **not verified**. |

The profile already had site access set to “On all sites”; this run did not change personal permissions and did not exercise native allow/deny prompts. The browser was not restarted, to preserve the user’s existing window. These observations are limited to the flows listed above.

The local artifacts remain outside the repository under `/private/tmp/web-ink-v032-native-fixtures/`. The local update receipt (`.superpowers/sdd/2026-10-09-web-ink-v032/scratch/current-chrome-acceptance/window-update.log`, excluded from Git) records the synchronized build, output path, extension ID, and file count. The older local `current-chrome-acceptance/native-first-pass.json` records the pre-fix `6aaefff` failure and is superseded by this `6efd02d` acceptance. No personal notes, profile data, or screenshots were added to this repository.

## Earlier automated regression checkpoint — 6efd02d

The integration checkout is on `feat/pdf-workspace` at `6efd02da4da459ecd1cbc37b9182790a501f26c3`. The focused regression for the native `windowId = -1` context and its UI message handling passed along with the following checks:

| Check | Result |
| --- | --- |
| Focused PDF handoff and management UI tests | 77 passed / 2 files |
| Ordinary unit suite | 308 passed / 27 files |
| Type check (`npm run check`) | Passed, exit code 0 |
| Large-data suite | 3 passed / 2 files |
| Release/installation tools | 30 passed |

Local receipts are under `.superpowers/sdd/2026-10-09-web-ink-v032/scratch/native-context-fix/`: `window-green.log`, `window-unit.log`, `window-check.log`, `window-bulk.log`, and `window-release.log`. They are excluded from Git. The full Playwright suite was **not** rerun on `6efd02d` in this checkpoint.

## Earlier synthetic-browser and package evidence — historical

These results belong to earlier builds and remain useful only for those recorded builds; they are not a full-suite result for `6efd02d` and are not native-profile proof. Earlier PDF automation and visual receipts on `b0c4765` and the `cfdc565` visual repair are retained as historical evidence.

The earlier clean `6df483c80c995dc8ceab5fa1029c103928c509e3` build was v0.3.2 with `dirty:false`, tested with Node 26.5.0, Playwright 1.63.0, and Chrome for Testing 153.0.8010.12:

| Check | Earlier result on 6df |
| --- | --- |
| Type check | Passed |
| Ordinary unit suite | 285 passed / 27 files |
| Serial large-data suite | 3 passed / 2 files |
| Release/installation tools | 17 passed; no skipped tests |
| Production build | Passed; 226 sealed entries plus integrity manifest |
| Full browser suite | 57 passed / 5 files; 69.854 seconds |
| Release-mode local ZIP | Passed; 227 runtime files matched after extraction |

That CFT run exercised text/image creation and recovery, deletion/undo and conflicts, PDF selection/save/failed retry, same-tab handoff and return, hash-bound bookmarks, bounded large-PDF rendering, synthetic browser restart, three extension Reload transitions, and the old-version upgrade. Its functional host fixtures used synthetic responses and disposable pre-granted manifests. They do not establish native prompt behavior or access to external publisher content. The CFT run included area-mode coverage; that remains synthetic evidence and does not change the incomplete native area drag result above.

The prior public v0.3.0 ZIP used as the upgrade baseline had SHA-256 `d8298aca8ff085ad282595cef898d96bfaef7657e2ec8f4e28110aeb72dfe9a2`; the separate historical v0.3.1 Reload baseline was `d37555855f4d3f8cec0bbd27d28de8afa12f49fc`. The earlier 6df local ZIP had SHA-256 `0617b8bc488801af293701336c18ca5607c58ce2574e271e16ab4bea9b467008`; an independent extraction audit found no missing, extra, or changed files. These are historical package receipts, not a ZIP built from `6efd02d`.

The earlier package audit confirmed the existing extension ID, required PDF.js and implementation-reference notices, and absence of test profiles, artificial PDFs, source maps, or common credential patterns in the ZIP. Pinned snippets, adapted contracts, retained Web Ink logic, and license boundaries are recorded in [OPEN_SOURCE_REFERENCES.md](OPEN_SOURCE_REFERENCES.md). No runtime dependency, annotation database/backup schema, or extension identity change was introduced in those earlier checkpoints.

Earlier CFT visual captures measured the 52px reader bar, 320px notes rail/overlay, light and dark surfaces, real 200% tab zoom, 320px side panel, saved Chinese highlight/note, and bounded canvas counts. Three Management captures with incorrect theme naming, unsettled filtered results, or clipped full-page zoom were excluded and replaced by asserted captures; these were harness errors, not product defects. A later visual review found low-contrast placeholder/selected-label colors and a 24px tag field. `cfdc565d02c6c1d38c027f46d84f892b077e8527` corrected those styles using existing roles and field tokens. The measured CFT contrast ratios were: placeholders 6.77:1 light and 5.61:1 dark; selected labels 14.52:1 light and 10.46:1 dark. These measurements describe the earlier visual-repair captures, not the current native run.

## Remaining delivery gates and coverage boundaries

- Exact PR-head CI, including Chrome 120 webpage and Chrome 125 PDF checks,
  merge commit to `main`, final `main` CI/build/ZIP, and final same-directory
  installation plus native runtime readback remain pending at this checkpoint.
- The existing profile was already allowed on all sites. Native allow/deny
  prompts were not exercised and personal permissions were not revoked to
  manufacture those cases; production absence/denial paths have synthetic
  automated coverage.
- The browser was kept open as requested. Browser-restart recovery and exact
  durable-record upgrade verification have disposable-profile evidence, not
  a restart or full export audit of the user's personal profile.
- Local Chinese-file recovery and changed-file isolation have the earlier
  native observations above. The scan displayed natively; its area gesture
  initially remained unverified. The later manual area confirmation used the
  public paper, so no separate native scan-area completion is claimed.

No push, PR, merge to `main`, public Release or tag has been performed at this
checkpoint. These candidate results do not replace final post-merge readback.
