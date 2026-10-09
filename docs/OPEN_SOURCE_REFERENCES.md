# Web Ink v0.3.2 open-source reference boundary

**Status:** Stage A design/provenance record. It supplements the immutable
technical audit at
`.superpowers/sdd/2026-10-09-web-ink-v032/source-audit.md`. No upstream source
was copied into this prototype, no new package was installed, and no license
notice is added by this documentation alone.

| Pinned reference | Exact commit and license | Core examined idea | Web Ink boundary |
| --- | --- | --- | --- |
| [mozilla/pdf.js](https://github.com/mozilla/pdf.js/tree/f5e56f0af970e1fe5eb8faa9eb3212281eb97d07) | `f5e56f0af970e1fe5eb8faa9eb3212281eb97d07`, Apache-2.0 | `extensions/chromium/contentscript.js:36-78` rejects non-PDF MIME types, blank/internal embeds, and repeats before eligibility. | Adapt only the conservative input/output policy: observed candidate → accepted safe public source or unavailable. Do not copy content-script replacement flow, globals, or URL handling. Existing `pdfjs-dist` notices remain governed by `THIRD_PARTY_NOTICES.md`. |
| [agentcooper/react-pdf-highlighter](https://github.com/agentcooper/react-pdf-highlighter/tree/ae0968f22f8aedcf9eb62207bee31bd71bf095f6) | `ae0968f22f8aedcf9eb62207bee31bd71bf095f6`, MIT | `src/lib/get-client-rects.ts:21-54` and `coordinates.ts:14-78` express page-bound rectangles and proportional restoration. | Retain Web Ink’s existing normalized geometry and virtual layout. Adapt the contract only: same-page range → page number + normalized rectangles → local jump. Do not adopt reference types, components, or conversion implementation. |
| [hypothesis/client](https://github.com/hypothesis/client/tree/b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a) | `b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a`, BSD-2-Clause; `src/annotator` carries a separate MIT notice | `src/annotator/anchoring/pdf.ts:711-801` rejects cross-page ranges before producing selectors. | Adapt one validation rule: a valid selection has non-empty text and both endpoints in one PDF text layer. Do not adopt selector classes, anchoring architecture, or source implementation. |
| [shadcn/ui](https://github.com/shadcn-ui/ui/tree/c003e96852fa9534aee40b2cb85a96d8bd38732d) | `c003e96852fa9534aee40b2cb85a96d8bd38732d`, MIT | `apps/v4/registry/new-york-v4/ui/sidebar.tsx:371-381` uses a flexible, min-height-zero scrolling child. | Adapt the generic layout result: fixed header + one contained scroll list + bounded More menu. Do not copy Tailwind strings, `cn`/CVA utilities, portal structure, or dependency graph. |

## Reference contracts and planned verification

| Reference input → output | Original/rewrite distinction | Planned test, not yet implemented |
| --- | --- | --- |
| Embed MIME/source/tag/page context → reject or once-only eligible candidate | Web Ink’s background-observed context must own URL validation and sender/tab binding; it is not PDF.js DOM replacement. | direct/embedded/wrapper/local/unavailable cases; unsafe URL, blank shell, stale tab, and duplicate handling. |
| DOM range + page viewport → page-bound rectangle + jump target | Web Ink uses its own normalized rectangle storage and `PageLayoutIndex`, not the highlighter’s position model. | rotation/zoom matrix, multiline same-page selection, cross-page rejection, one local jump per saved item. |
| PDF text-layer range → valid same-page selection or rejection | Web Ink returns its own `SelectionTarget`, not Hypothesis selectors. | empty/outside/cross-page range, limits, listener disposal, and save-success-only clearing. |
| Sidebar children → one scrollable bounded list | Web Ink uses ordinary React/CSS already in the repository, not shadcn primitives. | no automatic first-detail expansion, preserved list scroll, no horizontal overflow, reachable 320px More item, Escape close. |

## License gate before release

These pins are source references, not a blanket license conclusion. Before a
distribution, compare the shipped diff and bundled packages with the material
above. A material PDF.js package/source change keeps the applicable Apache-2.0
notices; a material copy from react-pdf-highlighter or shadcn/ui carries the
relevant MIT notice; a material copy from Hypothesis `src/annotator` carries
the root BSD-2-Clause and annotator MIT notices. Inspect generated license
artifacts in the release ZIP; this Stage A record is not that verification.
