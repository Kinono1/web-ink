# v0.3.6 — refined reading and quick annotation presets

Baseline: main `47437737df9ed9751bf9d37a6d700dd992eb5c40`, v0.3.5. Date: 2026-10-12, Asia/Shanghai. Exact commit, CI, ZIP, install hashes and final delivery state are recorded in the local receipt. This document does not claim a public release or actual native Chrome activation.

## Delivered behavior

- Paired elevation and small optional translucent floating controls; flat persistent rows, system fonts, unchanged Apple five colors, opaque PDF paper and no animation dependency. Existing system/product reduced motion and transparency are supported.
- Reader-session focus mode hides the top row and keeps navigation, annotations and exit in a bottom capsule. It preserves document identity and zoom. Dirty notes block entering focus. Only the current window's panel is closed when Chrome supports it; failure/older versions show a manual-close instruction. Escape in editors/dialogs keeps its local meaning.
- One to five editable color/label presets, shared by webpage text and PDF selections. Presets use the independent local `ui.annotationPresets` key, not Settings, the database or backups. Explicit choice saves the label using the existing tag field; ordinary selection and copying remain inert. Alt+Shift+Digit1–5 avoids browser tab shortcuts and excludes editing, composition, repeat and invalid selections.
- Preset drafts survive save failure and late incoming props. Initial restoration, accepted saves and storage changes use generation guards. Same-view writes serialize; different views have no transaction lock and use the last successful write.

No account, cloud, remote asset, permission, schema migration, statistics, gamification or sharing URL was added. Native PDF read-only annotations, annotated PDF export, IEEE access recovery, draggable launcher and original-directory update contracts remain in scope for regression.

## Verification evidence

- Typecheck passed. Full unit suite: 1,054 passed, two existing opt-in cases skipped by default. The two opt-in export evidence cases were exercised in v0.3.5; this round does not claim fresh performance measurements from them.
- Bulk correctness: three passed. Installation/release tools: 32 passed. Read-only skill: 26 passed.
- Focused real Chromium cases passed for focus/navigation/preset save, editor preference persistence, live webpage shortcut/copy behavior, shared sidebar and narrowed/reduced-effect layouts. The first complete browser run passed 92/92, including checksum-verified upgrade and pinned Reload baselines. After the final focus-cancellation fix, typecheck, the complete 1,054-case unit suite and five affected Chromium checks passed again. Exact-head CI is the remaining complete browser gate; its result is recorded in the receipt rather than inferred from the earlier run.
- First visual batch inspected light/dark wide PDF, 320px focus and editor, and the Library editor. One confirmation pass corrected swatch consistency and recovery-message truncation. Small synthetic PDFs were used; files, screenshots and isolated profiles are excluded from Git. New visual captures are opt-in via `WEB_INK_CAPTURE_VISUAL=1`.
- The English recovery message was tested at 320px and at a 640px viewport with CSS scale 2. This is a bounded magnification check, not native Chrome's zoom or an OS-level accessibility acceptance claim. Subsequent functional assertions verify all capsule button bounds; there is no continuing visual-polish loop.
- Independent review exposed and fixed cancellation-before-late-read and reversed content preference reads. Controlled tests confirm cancelled editing still restores stored presets, older initial reads cannot overwrite accepted saves, and reversed storage completion retains the newest label/tag.
- Final review also found a pending side-panel close could leave ordinary reader controls busy after opening annotations, pressing Escape or choosing another source. The shared cancellation path now invalidates late completion and clears busy state. Three deferred-close tests failed before the repair and passed afterward; independent scoped rereview accepted the repair.
- A pending-save keyboard focus candidate was checked in actual headless Chromium with a controlled unresolved preference write. Focus remained inside the dialog after Save and Tab, and Escape did not close it; no production patch was warranted for that candidate.

## Reference boundary

[Goodnotes' linked redesign article](https://www.goodnotes.com/blog/goodnotes-new-look) is dated August 25, 2023; it is not evidence for an iOS 26 Liquid Glass implementation. [MarginNote's immersive mode](https://www.marginnote.com/en/features/immersive-mode/) provides a reference for reducing reading chrome to a contextual capsule. Interaction principles were adapted to existing Web Ink code; no proprietary code, illustration or branding was copied. Chrome's [side-panel close API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-close) is feature-detected; its current global-panel window semantics are respected.

## Native boundary and morning check

The user explicitly requested continuing without Computer Use while the computer may be locked. No native UI was operated in this run. Candidate automated acceptance, final-main packaging and original installation synchronization do not establish actual Chrome Reload activation.

When back at the computer: save open edits, click Web Ink Reload in the original extension card, verify the final main build in Settings, and refresh the test page if needed. Check pen drag/menu, current-tab PDF entry, focus entry/exit, live presets and original annotations/export. Existing user files and notes must remain untouched. The installation remains `.output/chrome-mv3`; uninstalling or selecting a new directory is not required.
