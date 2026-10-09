# Web Ink v0.3.2 design baseline

**Status:** approved design specification for Stage A. The accompanying HTML
is a static prototype, not production UI. It records the values already fixed
in `docs/superpowers/plans/2026-10-09-web-ink-v032.md`; it does not change
runtime tokens yet.

## Surface mode and character

Each extension surface is **Operate**: the reader needs to finish a task with
minimal visual ceremony. The system is light, calm, and document-first. Brand
appears in precise blue focus/action states, a compact document mark, and clear
local-data language rather than decorative imagery.

The incumbent baseline is the authority for product wording and icon language.
The prototype fixes its observed empty-state problem: the library does not
leave a thin, unexplained bar above a nearly blank page, and the current-page
surface says what it applies to instead of using library copy.

## Fixed tokens

| Role | Light | Dark |
| --- | --- | --- |
| canvas | `#F6F7F9` | `#111318` |
| surface | `#FFFFFF` | `#191C23` |
| primary text | `#18181B` | `#F4F4F5` |
| secondary text | `#52525B` | `#A1A1AA` |
| separator | `#E4E4E7` | `#2B303B` |
| accent | `#2563EB` | `#60A5FA` |

- System sans stack only: `-apple-system`, `BlinkMacSystemFont`, `PingFang SC`,
  `Hiragino Sans GB`, `Segoe UI`, `Microsoft YaHei`, `system-ui`, `sans-serif`.
- Type scale: body 14px, meta 12px, title/headings 16px, empty-state heading
  22px. Use 500/600 weight for hierarchy; do not load a web font.
- Spacing steps: 4, 8, 12, 16, 24, 32px. Controls use 8px radius; surfaces
  use 12px radius; hit targets are at least 36px.
- Icons are the existing 16–18px outline paths from `src/ui/icons.ts`; SVG is
  geometric UI affordance, not illustration.
- Motion is at most 120ms and is removed under `prefers-reduced-motion`.
  PDF content remains normal rather than automatically inverted in dark mode.

## Layout rules

- Reader: one 52px toolbar row after the compact app bar. Notes are closed by
  default. At 900px and above, a 320px note rail may sit beside pages; below
  that it overlays the reader. Below 600px, retain Back, page, Notes, and More;
  zoom moves into More.
- Sidebar/current page: name the active page, source host, and annotation
  state first. The empty state has a concrete next action and a stable bottom
  image-drawing entry.
- Library: a compact list starts without automatically opening a record.
  Search/filter controls have clear labels. At 700px and above it can become a
  list/detail split; otherwise the detail replaces the list and keeps its
  scroll position.
- Settings: one readable column with grouped preferences and explicit local
  backup language. Destructive or irreversible import paths stay visually
  distinct.

## States and feedback

| State | Required treatment |
| --- | --- |
| Empty library | Explain that no saved annotations match; offer the current-page route without implying lost data. |
| PDF source selection | Offer local file and public URL as separate choices; disclose local-only annotations. |
| Error/recovery | Use an alert that names what failed, retains existing notes, and gives a bounded recovery action. |
| Active selection | Accent fill plus text label; never color alone. |
| Focus/keyboard | 2px accent outline with offset; Escape closes transient More/menu UI. |
| Reduced motion | Instant state changes; no decorative transition. |

## Prototype boundary

The prototype uses synthetic records and static interactions to validate
hierarchy, responsive structure, and light/dark readability. It deliberately
does not prove storage, permission, PDF handoff, native side-panel behavior,
or annotation persistence. Those are implementation and test work in later
tasks.
