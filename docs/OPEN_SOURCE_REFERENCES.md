# Web Ink v0.3.2 open-source reference boundary

**Status:** Stage A design/provenance record with a current source mapping.
It supplements the immutable technical audit at
`.superpowers/sdd/2026-10-09-web-ink-v032/source-audit.md`. The mapping below
was checked at integration `2e95042b931d6d4db89e06fc7f20ad4781a0f9c3`, which
contains runtime `b7137e3`, reading `c8f1cac`, management `cae074c`, theme
`4db975d`, notice preparation `fbc9f6d`, and PDF UI `9b3d368`. Source and
declared unit-test mappings are verified at that head. The clean `6df483c`
checkpoint subsequently passed all 57 local E2E cases and
an actual ZIP/resource-notice audit; see [the validation record](VALIDATION-v0.3.2.md).
Native acceptance, CI, final main and installation remain separate pending gates.

| Pinned reference | Exact commit and license | Examined contract | Web Ink boundary |
| --- | --- | --- | --- |
| [mozilla/pdf.js](https://github.com/mozilla/pdf.js/tree/f5e56f0af970e1fe5eb8faa9eb3212281eb97d07) | `f5e56f0af970e1fe5eb8faa9eb3212281eb97d07`, Apache-2.0 | conservative embedded-PDF recognition | Adapt a safe observed candidate to `embedded` or `unavailable`; do not copy the content-script replacement flow. |
| [agentcooper/react-pdf-highlighter](https://github.com/agentcooper/react-pdf-highlighter/tree/ae0968f22f8aedcf9eb62207bee31bd71bf095f6) | `ae0968f22f8aedcf9eb62207bee31bd71bf095f6`, MIT | page-bound rectangles and proportional restoration | Keep Web Ink normalized geometry and virtual pages; do not adopt reference types/components. |
| [hypothesis/client](https://github.com/hypothesis/client/tree/b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a) | `b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a`, BSD-2-Clause; `src/annotator` also carries an MIT notice | same-page PDF selection guard | Return Web Ink’s own `SelectionTarget`; do not use selector classes or anchoring architecture. |
| [shadcn/ui](https://github.com/shadcn-ui/ui/tree/c003e96852fa9534aee40b2cb85a96d8bd38732d) | `c003e96852fa9534aee40b2cb85a96d8bd38732d`, MIT | fixed header plus contained scrolling sidebar content | Use ordinary React/CSS; do not copy Tailwind strings, utilities, portals, or dependency graph. |

## Current verified implementation map

This section maps only what is present at the stated integration head. It
separates retained Web Ink code from new PDF UI wiring and does not determine
legal independence or final distribution-notice sufficiency.

- **PDF.js eligibility reference → verified runtime boundary.** Runtime
  `b7137e3` uses `probePdfDocument` in `src/pdf/context.ts:130-153` to inspect
  visible top-document `iframe`, `embed`, and `object` elements, and
  `classifyPdfTab` at `:171-222` to retain only safe candidates. The handoff
  handler calls that probe at `src/background/pdf-handoff.ts:241-256`, preserves
  observed tab/session context before same-tab navigation at `:273-311`, and
  tests visible candidates, base-URI resolution, unsafe credentials, normal
  anchor non-takeover, and return-token binding in
  `tests/pdf-handoff.test.ts:137-225,372-447`. New PDF UI wiring reads the
  bound handoff at `src/pdf/PdfReader.tsx:249-260` and returns only through the
  typed token at `:764-786`; its declared unit cases are at
  `tests/pdf-reader-ui.test.ts:464-483,515-561`. This is a Web Ink-specific
  observed-context and session contract, not the upstream replacement flow.
- **react-pdf-highlighter rectangle/jump reference → retained geometry plus
  new Web Ink UI wiring.** `src/pdf/geometry.ts`,
  `src/pdf/PdfReader.tsx:915-927`, and `tests/pdf.test.ts:37-69,246-279` are
  retained Web Ink geometry/layout code that predates the approved base and
  are not credited as a newly adopted react-pdf-highlighter implementation.
  The integrated UI now captures one page's client rects in
  `src/pdf/PdfPage.tsx:163-205`, creates its own `PdfTarget` in
  `PdfReader.tsx:887-913`, and clears browser selection only after the local
  annotation write succeeds at `:698-717`. The declared unit cases for failed
  retry and save-before-note are `tests/pdf-reader-ui.test.ts:412-445`.
- **Hypothesis same-page guard → retained boundary with explicit new UI
  rejection.** The retained Web Ink text-layer ownership check is at
  `src/pdf/PdfPage.tsx:163-170`; the integrated UI now reports an explicit
  cross-page rejection there, with declared unit coverage at
  `tests/pdf-reader-ui.test.ts:448-461`. It is not the Hypothesis selector,
  offset, quote-anchoring, or anchoring architecture.
- **shadcn contained-scroll reference → existing Web Ink layout, not a copied
  primitive.** `src/ui/management.css:635-653` contains the library grid and
  one bounded `overflow: auto` list. Management `cae074c` adds narrow-library
  scroll restoration in `src/ui/ManagementApp.tsx:601-616`, with declared unit
  coverage at `tests/management-ui.test.ts:111-151`; current-tab PDF source
  choice remains covered at `:152-201`. The source uses ordinary
  React/CSS, not the shadcn component, Tailwind utility string, portal, or
  dependency graph. The reference remains a pattern boundary rather than a
  claim that this task adopted upstream code.
- **Non-reference work.** Reading `c8f1cac` implements only the local
  reading-position writer in `src/pdf/reading-position.ts:58-178`, with
  focused tests at `tests/reading-position.test.ts:58-220`. The new reader
  integration restores only after layout/read readiness at
  `src/pdf/PdfReader.tsx:442-455` and is covered in declared unit cases at
  `tests/pdf-reader-ui.test.ts:564-631`; theme `4db975d` adjusts the Web Ink
  toast scale. Neither is attributed to one of the four pinned references.

## Examined excerpts and distinct proposed adaptations

### Mozilla PDF.js — embed eligibility

Source: [`extensions/chromium/contentscript.js:36-78`](https://github.com/mozilla/pdf.js/blob/f5e56f0af970e1fe5eb8faa9eb3212281eb97d07/extensions/chromium/contentscript.js#L36-L78).

**Short original core excerpt (examined; not copied):**

```js
if (mimeType && mimeType.toLowerCase() !== "application/pdf") return;
if (!mimeType && !/\.pdf(?:$|[?#])/i.test(path)) return;
if (elem.__I_saw_this_element) return;
```

**Input → output:** `object`/`embed` MIME, source/data URL, identity, and page
location → rejected candidate or once-only eligible candidate.

**Minimal adaptation pseudocode (proposal, distinct from the original):**

```text
candidate = readAllowedTopDocumentEmbed(observedTab)
if candidate is absent, unsafe, native-shell, blank, or handled: return unavailable
return { kind: "embedded", sourceUrl: candidate.publicHttpsUrl }
```

**Verified source/unit mapping; local browser checkpoint is recorded above,
with native and final installation acceptance pending:**
`tests/pdf-handoff.test.ts:137-225,372-447` covers iframe/embed/object
candidates, known viewers, normal-link non-takeover, hostile URLs, changed
tab/document handling, and return-token boundaries. The current reader's
handoff unit mapping is recorded above; this does not mark browser/E2E or
release-ZIP review complete.

### react-pdf-highlighter — page-bound rectangles

Sources: [`get-client-rects.ts:21-54`](https://github.com/agentcooper/react-pdf-highlighter/blob/ae0968f22f8aedcf9eb62207bee31bd71bf095f6/src/lib/get-client-rects.ts#L21-L54) and [`coordinates.ts:14-78`](https://github.com/agentcooper/react-pdf-highlighter/blob/ae0968f22f8aedcf9eb62207bee31bd71bf095f6/src/lib/coordinates.ts#L14-L78).

**Short original core excerpts (examined; not copied):**

```ts
top: clientRect.top + page.node.scrollTop - pageRect.top
pageNumber: page.number
```

```ts
x1: rect.left; x2: rect.left + rect.width
left: (width * scaled.x1) / scaled.width
```

**Input → output:** DOM range, page DOM and PDF viewport → page-numbered
rectangles, stored coordinates, and a scroll target.

**Minimal adaptation pseudocode (proposal, distinct from the original):**

```text
if range endpoints are not in the same page text layer: return undefined
rects = normalizeEach(range.clientRects, pdfViewport, cropBox)
return SelectionTarget(pageNumber, rects, exact, prefix, suffix)
```

**Verified retained-code tests:** `tests/pdf.test.ts:37-69` covers rotation and
zoom coordinate round trips, while `:246-279` covers stable layout offsets.
The integrated selection/save unit mapping is recorded above. This record does
not relabel retained geometry as a newly implemented reference adoption.

### Hypothesis client — same-page guard

Source: [`src/annotator/anchoring/pdf.ts:711-801`](https://github.com/hypothesis/client/blob/b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a/src/annotator/anchoring/pdf.ts#L711-L801).

**Short original core excerpt (examined; not copied):**

```ts
if (startTextLayer !== endTextLayer) {
  throw new Error("Selecting across page breaks is not supported")
}
```

**Input → output:** a PDF text-layer DOM range → normalized same-page range and
selectors, or an error.

**Minimal adaptation pseudocode (proposal, distinct from the original):**

```text
range = browserSelection.firstRange
if startTextLayer(range) !== endTextLayer(range): return undefined
if text is empty or limits fail: return undefined
return SelectionTarget(pageNumber, normalizedRects, exact, prefix, suffix)
```

**Verified source/unit mapping:** `PdfPage.tsx:163-197` checks that both
endpoints are in its one text layer and bounds selection text and rectangles;
the integrated UI's cross-page unit case is recorded above. It is not the
Hypothesis selector architecture. The local browser checkpoint passed; native and final acceptance remain pending.

### shadcn/ui — contained sidebar scroll

Source: [`apps/v4/registry/new-york-v4/ui/sidebar.tsx:371-381`](https://github.com/shadcn-ui/ui/blob/c003e96852fa9534aee40b2cb85a96d8bd38732d/apps/v4/registry/new-york-v4/ui/sidebar.tsx#L371-L381).

**Short original core excerpt (examined; not copied):**

```tsx
"flex min-h-0 flex-1 flex-col gap-2 overflow-auto"
```

**Input → output:** sidebar child content → one flexible scrollable content
region.

**Minimal adaptation pseudocode (proposal, distinct from the original):**

```text
sidebar = fixedHeader + scrollableList(minHeight: 0, flex: 1)
onSelect(record): preserve list.scrollTop; show record detail
moreMenu: clamp its box to the reader viewport
```

**Current verified tests:** `tests/management-ui.test.ts:92-109` verifies no
initial detail expansion; `:111-151` covers narrow scroll restoration; and
`:152-201` verifies a selected observed PDF source is sent to the background.
Local synthetic visual/browser evidence is recorded separately; none of these tests establish
a shadcn-derived implementation.

## License gate before release

These pins are source references, not a blanket license conclusion. Before a
distribution, compare the shipped diff and bundled packages with the material
above. A material PDF.js package/source change keeps the applicable Apache-2.0
notices; a material copy from react-pdf-highlighter or shadcn/ui carries the
relevant MIT notice; a material copy from Hypothesis `src/annotator` carries
the root BSD-2-Clause and annotator MIT notices. Inspect generated license
artifacts in the release ZIP; this Stage A record is not that verification.

## PDF.js strict rendering error correction (6.3.289)

Native acceptance found that the public MICCAI 3466 PDF includes images above
the existing 16,777,216-pixel resource limit. PDF.js normally omits these images.
Web Ink enables `stopAtErrors` so an affected page can offer an explicit fallback
instead of presenting incomplete content for annotation.

The pinned `pdfjs-dist/legacy/build/pdf.mjs` source SHA-256 is
`91e29f812c593904e8d48d022db5ddf93e3443575d4765ac9bfbb42494cfbd8d`.
In `_pumpOperatorList` (upstream lines 22694-22714), the rejected stream sets
`lastChunk` and calls `operatorListChanged` before rejecting the ready promise.
A real-PDF.js regression confirms that this can resolve an incomplete operator
list; a browser regression confirms that the page can also appear successfully
rendered. `scripts/pdfjs-render-errors.ts` changes only that failure branch:
reject the operator-list promise, cancel active render tasks with the actual
error, then run the original cleanup/rejection. Iterate over a snapshot because
cancellation removes tasks from the set.

WXT applies the correction at build time, without editing `node_modules` or
changing the worker. A source-hash or target mismatch stops the build and
requires review when upgrading PDF.js. The distributed PDF.js Apache-2.0
license remains included. Resource budgets are unchanged. Tests use an original
synthetic oversized image declaration and a healthy follow-up file, with actual
PDF.js operator-list and browser rendering coverage.
