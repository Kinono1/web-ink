# Refined reading implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Work in the existing isolated checkout; ownership below is exclusive.

**Goal:** Refine the existing interface and deliver PDF focus mode and editable quick annotation presets without making reading heavier.

**Architecture:** Shared presentation tokens retain the existing palette and system fonts. Focus is a reader-session state, not browser fullscreen. Presets are a small independent local preference; selecting a preset explicitly saves the live selection through the existing write/conflict path.

**Tech stack:** Existing React, CSS, Chrome APIs, PDF.js, Vitest and Playwright. No new dependencies.

**Spec:** User-supplied refinement proposal, [PRODUCT.md](../../PRODUCT.md) and [DESIGN.md](../../DESIGN.md); the user explicitly requests overnight completion without Computer Use.

## Global constraints

- No Computer Use, native app operations or personal browser/profile access in this run. Headless isolated browser automation is allowed.
- Preserve database v3, JSON backup v2, extension ID, permissions, stored colors, original PDF annotations, virtual pages, export guards and source files.
- Version 0.3.6. Primary installation remains `.output/chrome-mv3`; builds use `.build-output`. Only primary can install.
- Shared paired elevation/material/motion tokens. Flat persistent rows; lift transient tools. Glass only on small floating controls, with solid fallback and OS/product reduced transparency/motion support.
- Keep 4/8/12/16/24/32 spacing for dense controls; generous spacing between groups. Do not force 48/64px gaps into a 320px sidebar.
- Focus hides the reader bar and requests closing the existing notes panel when supported. Always-visible keyboard-accessible capsule offers page navigation, notes and exit. Escape exits without swallowing editor/dialog Escape. Older browsers retain a manual-close hint if native side panel cannot close. No fullscreen permission.
- Presets: at most five `{id,label,color}` entries; default important/question/insight in current language using existing Apple yellow/blue/green. Independent `ui.annotationPresets` preference. Trimmed labels 1–24 characters, valid HEX and unique IDs. No database/backup migration or automatic marking.
- Shortcut Alt+Shift+1/2/3… only for an active live PDF/text selection; exclude composing, repeat, editable fields and dialogs. Cmd+1 is not used because Chrome owns tab selection. Explicit preset writes its label as an existing annotation tag.
- Editor validates locally, preserves unsaved input on storage failure, and only closes/reports success after write succeeds. Serialized writes cannot regress the latest accepted value. No cloud, external upload, stats/gamification/share URL.
- PR exact-head CI and final main CI before updating the original installation. Actual Chrome Reload/visual acceptance remains pending until the user returns; no native acceptance claims.

## Review focus

1. Focus cannot strand the reader or hide unsaved edits; keyboard exit restores page position without changing zoom/hash.
2. Preset key shortcuts do not steal browser tabs or save stale/collapsed/cross-page selections.
3. Preference read/write failure and late restoration do not lose edited presets or falsely claim saving.
4. Glass/motion have accessible solid/reduced fallbacks; 320px/200% zoom controls remain reachable.
5. Existing PDF export/native notes/IEEE/Reload/drag flows continue working and no writer is loaded during startup.

## Tasks

- [x] Visual task: theme.ts, pdf.css, management.css, sidepanel.css; tests only where behavior/fallback invariants need checks. Inspect automated light/dark/narrow captures in one batch and one confirmation pass at most.
- [x] Focus task: standalone FocusControls.tsx and focused tests. Root integrates reader state, side-panel lifecycle, Escape and draft protection.
- [x] Preset task: annotation-presets.ts, AnnotationPresets.tsx and focused tests. Root integrates live PDF selection and editor; content integration uses same model.
- [x] Integration: meaningful failing component/browser tests first, implement reader/content wiring, check all scoped tests then complete check/unit/bulk/release/skill/build/E2E.
- [x] Independent review: complete diff plus brief and test report. Resolve blocking findings, verify affected paths.
- [ ] Delivery: clean candidate, exact-head CI, merge commit main, final main CI/build/ZIP, original install hashes/backup. Record native acceptance as pending and provide morning checklist.

## Source boundary

Goodnotes' linked article describes the 2023 redesign, not evidence for a Liquid Glass release. MarginNote's official immersive page supports reducing chrome to a contextual capsule. Borrow interaction principles, not proprietary code/assets or an entire study workflow. Existing project source remains the implementation base.
