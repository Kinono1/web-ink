---
name: Web Ink
description: Local-first annotation surfaces for web and PDF reading.
colors:
  light-canvas: "#f6f7f9"
  light-panel: "#ffffff"
  light-text: "#18181b"
  light-secondary: "#52525b"
  light-tertiary: "#71717a"
  light-separator: "#e4e4e7"
  light-fill: "#eef0f4"
  light-fill-hover: "#e4e4e7"
  light-accent: "#2563eb"
  light-accent-fill: "#dbeafe"
  light-primary: "#27272a"
  light-primary-text: "#ffffff"
  light-danger: "#b42318"
  light-warning: "#9b5b00"
  light-warning-fill: "#fff7df"
  light-success: "#16803c"
  raised-shadow: "rgb(0 0 0 / 14%)"
  raised-outline: "rgb(0 0 0 / 6%)"
  dark-canvas: "#111318"
  dark-panel: "#191c23"
  dark-text: "#f4f4f5"
  dark-secondary: "#a1a1aa"
  dark-separator: "#2b303b"
  dark-fill: "#252a34"
  dark-fill-hover: "#2b303b"
  dark-accent: "#60a5fa"
  dark-accent-fill: "#1e3a5f"
  dark-primary: "#f4f4f5"
  dark-primary-text: "#18181b"
  dark-danger: "#fda4af"
  dark-warning: "#facc15"
  dark-warning-fill: "#4b3c00"
  dark-success: "#86efac"
typography:
  meta: { fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif', fontSize: "12px" }
  body: { fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif', fontSize: "14px" }
  title: { fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif', fontSize: "16px" }
  display: { fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif', fontSize: "22px" }
  excerpt: { fontFamily: '"New York", "Iowan Old Style", Charter, Georgia, "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", "Microsoft YaHei", serif' }
rounded: { control: "8px", surface: "12px", pill: "999px" }
spacing: { 4: "4px", 8: "8px", 12: "12px", 16: "16px", 24: "24px", 32: "32px" }
components:
  primary-action: { backgroundColor: "{colors.light-primary}", textColor: "{colors.light-primary-text}", rounded: "{rounded.control}", padding: "4px 10px", height: "36px" }
  quiet-action: { backgroundColor: "transparent", textColor: "{colors.light-secondary}", rounded: "{rounded.control}", padding: "4px 10px", height: "36px" }
  search-field: { backgroundColor: "{colors.light-fill}", textColor: "{colors.light-text}", rounded: "{rounded.control}", padding: "0 10px 0 32px", height: "36px" }
  record-row: { backgroundColor: "transparent", textColor: "{colors.light-text}", rounded: "{rounded.control}", padding: "8px 12px 8px 22px" }
  floating-surface: { backgroundColor: "{colors.light-panel}", textColor: "{colors.light-text}", rounded: "{rounded.surface}", padding: "8px" }
---

## Overview

Web Ink is an **Operate** interface for local web and PDF annotation: calm,
document-first, and clear about the active document, current state, and local
data boundary. Shared theme and component CSS are the production visual source;
the Stage A direction supplies the intended reader layout.

Light and dark roles reverse deliberately. Accent indicates focus, selection,
or explicit active state. Primary action uses stone roles. Stored annotation
colors belong to each record's narrow rule or swatch, never the UI accent.

**Key Characteristics:** document identity precedes utilities; state uses fill,
outline, and labels together; PDF paper remains white in a dark workspace.

## Colors

The frontmatter holds paired semantic roles for canvas, panel, text, control
fill, separator, accent, primary action, and status. Use the matching theme
role rather than creating a surface-local palette.

**The Accent-For-State Rule.** Accent roles are for keyboard focus, selection,
and explicit active state; ordinary committed actions use the primary pair.

## Typography

System sans serves UI, fields, metadata, and notes. The excerpt face is only
for captured reading material. Meta supports dates and tags; body supports
controls and notes; title supports compact headings; display supports empty and
detail hierarchy. Use source-applied 400/500/600 weights; do not load web fonts.

## Layout

Management uses a centered column. The approved 700px library threshold changes
the list/detail split into list-or-detail and Back restores list position.

The integrated PDF contract is one 52px reader
row, a 320px notes rail at 900px and wider that overlays below it, and essential
Back/page/Notes/More controls below 600px. Source definitions and actual
local synthetic browser geometry are recorded in `docs/VALIDATION-v0.3.2.md`;
native-surface acceptance remains a separate gate.

## Elevation & Depth

Persistent UI is separated by canvas/panel roles and one-pixel separators.
Menus, dialogs, and selection surfaces use the implemented soft shadow plus a
separator ring; page paper has its thin document edge.

**The Quiet-Surface Rule.** Keep page chrome and rows flat at rest; lift only
transient or selected surfaces.

## Shapes

Controls, rows, inputs, and note cards use the control radius. Splits, dialogs,
and panels use the surface radius. Pills remain for segmented controls and
small status treatments. Controls retain the shared 36px hit target; focus is
an offset outline rather than a shape change.

## Components

### Buttons

Primary is the one committed action; quiet utilities are transparent until
hover. Keyboard focus uses the accent outline with offset. Fast transitions
are removed for reduced motion.

### Inputs / Fields

Search, note, tag, and source fields use surface or fill roles, separator
borders, and control geometry. Source choices name local-file and public-URL
boundaries explicitly. Placeholders use the secondary text role. Selected
small labels use the text role over the accent fill so text contrast does not
depend on the focus accent. The tag filter uses the same 36px/8px field rules.

### Navigation

Segmented controls use a filled pill with a raised selected segment. The PDF
header is one compact row for document identity and essential actions.

### Cards / Containers

Library splits, dialogs, menus, and PDF transient surfaces use panel roles.
Record rows and PDF notes apply a record-owned left rule while normal text roles
carry their content.

### Empty and Recovery States

Empty library copy directs a reader to mark text or an image from Current page.
Alerts name a failure, retain existing work, and offer bounded recovery.

## Do's and Don'ts

### Do:

- **Do** use paired semantic roles, including the inverted dark primary pair.
- **Do** label selection and status as well as applying a fill or color.
- **Do** preserve white PDF paper and disable motion when requested.

### Don't:

- **Don't** turn stored annotation colors into the global accent or CTA palette.
- **Don't** add a second reader bar, remote font, or decorative imagery.
- **Don't** treat static prototype or CSS evidence as proof of native behavior,
  PDF handoff, persistence, or responsive visual acceptance.

## Production reference boundary

`docs/design/v032-prototype.html` is static synthetic prototype material. This
document is grounded in `src/ui/theme.ts`, `src/ui/page-theme.ts`, management and
side-panel CSS, and `src/pdf/pdf.css`. Candidate synthetic-browser and package
evidence is recorded in `docs/VALIDATION-v0.3.2.md`; native activation and final
PR/main/installation acceptance remain pending.
