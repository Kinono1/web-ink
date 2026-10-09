# Web Ink v0.3.2 open-source reference boundary

**Status:** Stage A design/provenance record. It supplements the immutable
technical audit at `.superpowers/sdd/2026-10-09-web-ink-v032/source-audit.md`.
No upstream source was copied into this prototype, no package was installed,
and no license notice is added by this documentation alone.

| Pinned reference | Exact commit and license | Examined contract | Web Ink boundary |
| --- | --- | --- | --- |
| [mozilla/pdf.js](https://github.com/mozilla/pdf.js/tree/f5e56f0af970e1fe5eb8faa9eb3212281eb97d07) | `f5e56f0af970e1fe5eb8faa9eb3212281eb97d07`, Apache-2.0 | conservative embedded-PDF recognition | Adapt a safe observed candidate to `embedded` or `unavailable`; do not copy the content-script replacement flow. |
| [agentcooper/react-pdf-highlighter](https://github.com/agentcooper/react-pdf-highlighter/tree/ae0968f22f8aedcf9eb62207bee31bd71bf095f6) | `ae0968f22f8aedcf9eb62207bee31bd71bf095f6`, MIT | page-bound rectangles and proportional restoration | Keep Web Ink normalized geometry and virtual pages; do not adopt reference types/components. |
| [hypothesis/client](https://github.com/hypothesis/client/tree/b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a) | `b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a`, BSD-2-Clause; `src/annotator` also carries an MIT notice | same-page PDF selection guard | Return Web Ink’s own `SelectionTarget`; do not use selector classes or anchoring architecture. |
| [shadcn/ui](https://github.com/shadcn-ui/ui/tree/c003e96852fa9534aee40b2cb85a96d8bd38732d) | `c003e96852fa9534aee40b2cb85a96d8bd38732d`, MIT | fixed header plus contained scrolling sidebar content | Use ordinary React/CSS; do not copy Tailwind strings, utilities, portals, or dependency graph. |

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

**Minimal adaptation pseudocode (proposed, distinct):**

```text
candidate = readAllowedTopDocumentEmbed(observedTab)
if candidate is absent, unsafe, native-shell, blank, or handled: return unavailable
return { kind: "embedded", sourceUrl: candidate.publicHttpsUrl }
```

**Planned, not implemented tests:** iframe/embed/object candidates, known
wrapper, normal-link negative case, hostile URL, stale tab/document, duplicate
handling, and no return target.

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

**Minimal adaptation pseudocode (proposed, distinct):**

```text
if range endpoints are not in the same page text layer: return undefined
rects = normalizeEach(range.clientRects, pdfViewport, cropBox)
return SelectionTarget(pageNumber, rects, exact, prefix, suffix)
```

**Planned, not implemented tests:** rotation/zoom matrix, multiline same-page
selection, cross-page rejection, and one `PageLayoutIndex` jump per saved item.

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

**Minimal adaptation pseudocode (proposed, distinct):**

```text
range = browserSelection.firstRange
if startTextLayer(range) !== endTextLayer(range): return undefined
if text is empty or limits fail: return undefined
return SelectionTarget(pageNumber, normalizedRects, exact, prefix, suffix)
```

**Planned, not implemented tests:** no/collapsed/outside-page selection,
cross-page endpoints, selection limits, listener disposal, and save-success-only
clearing.

### shadcn/ui — contained sidebar scroll

Source: [`apps/v4/registry/new-york-v4/ui/sidebar.tsx:371-381`](https://github.com/shadcn-ui/ui/blob/c003e96852fa9534aee40b2cb85a96d8bd38732d/apps/v4/registry/new-york-v4/ui/sidebar.tsx#L371-L381).

**Short original core excerpt (examined; not copied):**

```tsx
"flex min-h-0 flex-1 flex-col gap-2 overflow-auto"
```

**Input → output:** sidebar child content → one flexible scrollable content
region.

**Minimal adaptation pseudocode (proposed, distinct):**

```text
sidebar = fixedHeader + scrollableList(minHeight: 0, flex: 1)
onSelect(record): preserve list.scrollTop; show record detail
moreMenu: clamp its box to the reader viewport
```

**Planned, not implemented tests:** no initial detail expansion, preserved list
scroll, long-item truncation, reachable 320px menu item, keyboard activation,
and Escape close.

## License gate before release

These pins are source references, not a blanket license conclusion. Before a
distribution, compare the shipped diff and bundled packages with the material
above. A material PDF.js package/source change keeps the applicable Apache-2.0
notices; a material copy from react-pdf-highlighter or shadcn/ui carries the
relevant MIT notice; a material copy from Hypothesis `src/annotator` carries
the root BSD-2-Clause and annotator MIT notices. Inspect generated license
artifacts in the release ZIP; this Stage A record is not that verification.
