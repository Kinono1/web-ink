# v0.3 performance evidence

## Local working-tree comparison (2026-10-31)

On the same Mac with headless Chromium 153.0.8010.12, the existing benchmark compared clean `4a55ef6` with this working-tree candidate. The candidate was uncommitted (`dirty: true`), so its build identity is not a release. Each P95 below uses 60 samples per build, collected in baseline–candidate–candidate–baseline order after warmups. All configured latency and PDF resource gates passed for these synthetic fixtures.

| P95 measurement | Baseline | Working tree |
| --- | ---: | ---: |
| Restore 200 webpage annotations | 44.4 ms | 44.2 ms |
| Select text through saved highlight | 6.7 ms | 6.7 ms |
| Library first 50 rows painted | 31.8 ms | 32.8 ms |
| Open a 1,000-page PDF | 133.6 ms | 134.8 ms |
| Jump to its last page | 31.0 ms | 30.7 ms |
| Main-page JS heap after closing the 1,000-page PDF | 2.64 MB | 2.67 MB |

Both builds mounted at most three PDF canvases, with zero page workers observed after closing the reader. Heap values exclude browser, GPU and worker process memory. This run did not measure idle CPU, whole-browser memory, or the new on-demand recovery flow; the timing differences do not establish a speedup.

To repeat the comparison, build the candidate with `npm run build`, then run `WEB_INK_BENCHMARK_BASELINE=/absolute/path/to/baseline npm run test:benchmark`. The baseline path must contain a separately built runtime, and the working tree must still contain the candidate changes being compared.

## v0.3.14 refactor verification (2026-10-26)

The refactor preserves the annotation database, JSON format, extension identity,
permissions and runtime dependencies. Compared with the pre-refactor source
`301819d`, the three entry files are now 30 lines (`controller.ts`), 188 lines
(`PdfReader.tsx`) and 238 lines (`ManagementApp.tsx`). The content engine has eight
classes, the reader has 11 custom hooks and 13 UI components, and management has
three screens. These are ownership boundaries; line counts alone do not measure
maintainability. A source traversal found no cycles among static runtime imports.

PDF callbacks increased from 3 to 26, and memoized derived values from 6 to 9.
The counts come from parsed call expressions, rather than comments or string
matches. Stable actions retain session/intent checks; a callback from an old
document cannot write to a new session, including one with the same content hash.
`PdfPage` and `PdfNote` use React's default shallow memo comparison. Per-note
bindings stay stable without ignoring changed records, callbacks or revisions.

The render tests invoke real production component functions and hooks in jsdom;
only external browser/message boundaries are faked. Counts exclude mounting.

| Tested update | Before | After |
| --- | ---: | ---: |
| Open notes: PDF page executions (`301819d`) | 2 | 0 |
| Edit a draft: PDF page executions (`301819d`) | 1 | 0 |
| Change native-note filter: PDF page executions (`301819d`) | 2 | 0 |
| Show a notice: PDF page executions (`301819d`) | 1 | 0 |
| Edit one of three notes: note executions (`4dd631d`) | 3 | 1 |
| Type in that note: note executions (`4dd631d`) | 3 | 1 |
| Change theme: unrelated library executions (`4dd631d`) | 1 | 0 |
| Type a library draft: unrelated settings executions (`4dd631d`) | 1 | 0 |
| Display then dismiss export failure: unrelated library/settings executions (`4dd631d`) | 2 each | 0 each |
| Change tag filter: runtime listener registrations (`4dd631d`) | 4 → 5 | 4 → 4 |

These deterministic workloads demonstrate fewer redundant executions. Single-run
jsdom elapsed times do not establish a browser latency improvement. Reproduce the
counts with `npm test -- tests/pdf-reader-ui.test.ts
tests/management-dependencies.test.ts --silent=false`.

### Management dependency audit

The original planning estimate of 68 hooks was inaccurate. The parsed
`301819d:src/ui/ManagementApp.tsx` has 65 calls: 35 state, 16 ref, seven effect,
two layout-effect, four callback and one custom query-hook call. Thirteen sites
have dependency arrays. The table maps every original site to its current owner;
paths below are relative to `src/ui`.

| Original line and role | Current owner | Dependency and lifecycle contract |
| --- | --- | --- |
| 141, selection preference listener | `hooks/useManagementSettings.ts` | Mount once; version/inactive guards reject late reads; remove storage listener. |
| 162, preset leave guard | `screens/SettingsScreen.tsx` | Mount once; read current dirty/saving refs; remove beforeunload handler. Hidden screens stay mounted. |
| 170, theme layout | `hooks/useManagementSettings.ts` | React only to theme; no subscription. |
| 190, document observer | `hooks/useTabObserver.ts` | Stable callback reads/writes current document ref and increments document version. |
| 200, page-state callback | `hooks/useTabObserver.ts` | Mode dependency; explicit tab/URL plus request/version guards reject stale replies. |
| 240, page-state effect | `hooks/useTabObserver.ts` | Current mode, URL, tab, manual-selection policy and page-state callback. |
| 244, context refresh | `hooks/useTabObserver.ts` | Mode and stable context/settings callbacks; request ID rejects superseded async results. |
| 295, initial context effect | `hooks/useTabObserver.ts` | Refresh callback dependency; same async guards. |
| 298, close menu | `screens/PageScreen.tsx` | Stable callback restores focus using the current trigger ref. |
| 302, menu listeners | `screens/PageScreen.tsx` | Menu state and close callback; remove Escape/outside-pointer listeners. |
| 319, tab listeners | `hooks/useTabObserver.ts` | Mode and document/context callbacks; current tab ref filters events; remove both listeners. |
| 344, combined runtime listener | Four controller hooks | Settings: stable receiver and pending-write refs. PDF progress: current mode/tab and pending ref. Context: current mode/tab/URL and refresh callbacks. Annotations: stable query callbacks and latest filter ref. Each branch removes its listener. |
| 778, detail scroll restoration | `screens/LibraryScreen.tsx` | Detail state; consume and clear the captured scroll position. |

The combined listener now occupies four dependency sites, so these mappings cover
16 current sites. Two existing extracted sites cover the stable settings receiver
and document-version error reset. Seven new memo factories cover the four hook
snapshots and three context values. Each lists its captured state/callback inputs;
root error/notice state is excluded from library/settings contexts. React setters
and refs retain their stable identities. This yields 25 arrays in the extracted
management tree. The unchanged `management/useAnnotationQuery.ts` adds three:
stable cancellation, ref-backed loading and a key/cancel/load layout effect with
debounce cancellation. All 28 arrays were audited.

`tests/management-dependencies.test.ts` checks current filters after notifications,
new tab/URL identity, listener counts, single PDF-sidebar ownership and unmount
cleanup. Existing management tests retain drafts, expected-revision conflict
handling, pending settings writes and stale-context rejection.

### Coverage, malformed files and performance gates

The full source/entrypoint coverage run passes with 87.48% lines, 84.40%
statements, 84.67% functions and 78.75% branches. CI now requires at least 85%
line coverage; the other gates are unchanged. Ten small, authored PDF files cover
independent catalog, page-tree, object-header, stream-length and xref defects.
Seven must fail visibly; three must safely recover their expected text. Unit
tests use real PDF.js, and browser regressions use the reader, verify annotation
state and open a healthy file afterwards. Password-protected files remain a
separate case and are not counted among the ten corruption samples.

`npm run test:benchmark` retains at least 30 post-warmup samples per producer run
and the canvas/worker checks. With `WEB_INK_BENCHMARK_BASELINE` set, it runs the
baseline and candidate in the fixed order A → B → B → A. Both independent rounds
contribute all their samples, giving 60 samples per version and metric, without
trimming, choosing the fastest round or retrying a failing metric. Each P95 may
increase by at most the larger of 20% or 2 ms. It rejects different browsers,
fixtures, query API/count workloads, PDF sizes/pages and sample counts. Resource
limits apply to every round. Raw synthetic reports are printed before validation
so a failed gate retains the underlying samples. CI builds the pinned
pre-refactor `301819d` and uses the current producer for both versions.
The latency gate evaluates the pooled distribution; a passing aggregate does not
establish that each round's separate P95 met the same limit.

The initial A → B CI protocol failed at capture/save (12.30 ms versus a 12.12 ms
limit) and, on one unchanged-commit retest, absent search (222.80 ms versus
191.64 ms). No source-level cause was established. The fixed-order runs did not
retain raw samples on failure. Counterbalancing and preserving samples correct
those measurement limitations; they do not establish a runtime speedup or remove
all shared-host variation. The thresholds remain unchanged, and the extra rounds
roughly double benchmark work. Tool tests still reject genuine aggregate timing
regressions, mismatched workloads and a resource violation in either round.

The first ABBA CI run passed the webpage gates but failed the 500-page jump
(30.40 ms against a 29.28 ms limit). Inspection then found a separate benchmark
error: repeated opens could restore the last-page position, and the jump check
accepted a target that was already rendered. A 12-iteration diagnostic for both
long documents and both builds reproduced that mixture. Explicit `page=1`
removed it in the controlled comparison. This does not identify the cause of
the CI overrun; it establishes that those samples did not consistently measure
the intended first-page-to-last-page operation.

PDF iterations now explicitly open page 1 and include page-1 readiness in the
open interval. Immediately before starting the jump timer, they record and
assert page 1 ready, toolbar page 1, and an unmounted, unready last-page target.
The actual page-number input and target rendering remain inside the interval.
Every long-document round retains 30 `jumpInitialStates`; the pooled result
retains all 60 and rejects restored-page or already-mounted-target samples.
Earlier refactor PDF timings in this section are superseded by the controlled
measurements below. Chrome 125/120 checks precede performance in CI so an
independent performance failure no longer skips compatibility evidence; every
gate remains required with the same job timeout.

The local counterbalanced run used Chromium 153.0.8010.12, Node 26.5.0 and the
same Apple M4 Pro described below. Each row pools 60 measured samples per version,
after each producer's warmups. Runtime source is unchanged since `e70096b`;
subsequent fixture assertions, benchmark tooling and this section do not change
runtime behavior. All rows pass the relative budget. Long-document startup and
jumps are slower in this run; no PDF speedup is claimed.

| P95, milliseconds | `301819d` | Refactored runtime |
| --- | ---: | ---: |
| Restore 200 webpage annotations | 32.9 | 31.5 |
| Selection to saved highlight | 6.6 | 7.0 |
| Library first paint / first-page query | 46.9 / 1.3 | 42.4 / 1.2 |
| Sparse / absent / tag search | 31.9 / 66.0 / 34.6 | 31.7 / 60.7 / 33.0 |
| 20 MiB PDF open | 282.3 | 281.9 |
| 50 MiB PDF open | 529.9 | 534.2 |
| 500-page PDF open / last-page jump | 132.5 / 32.3 | 134.1 / 35.2 |
| 1,000-page PDF open / last-page jump | 133.7 / 32.0 | 138.6 / 37.2 |

The PDF runs retain at most three visible canvases and observe zero page workers
after reader teardown. Main-page retained JS heap stays within about 2.68 MB at
P95 in these samples. This is a repeated-navigation page-resource check, excluding
worker-process, GPU and whole-browser memory; it does not prove absence of all
leaks. Reproduce with a separately built `301819d` runtime:

```bash
WEB_INK_BENCHMARK_BASELINE=/path/to/baseline/chrome-mv3 npm run test:benchmark
```

## PDF remote startup follow-up (2026-10-11)

Baseline `4e74a0f` and the source hashes in
[performance-pdf-startup-v0.3.2.json](performance-pdf-startup-v0.3.2.json) identify
this comparison. The public 11-page MICCAI PDF contains 836,561 bytes. This uses
disposable, preauthorized Chromium profiles and interface timing, without
Computer Use or screenshots; it is separate from native Chrome acceptance.
These startup timings precede the subsequent highlight-compositing and palette
changes; they identify the measured source, not every later candidate build.

| Observation | Baseline | Candidate |
| --- | --- | --- |
| First remote open | 2,121.8 ms | 2,009.1 ms |
| Subsequent two remote opens | 2,007.2 / 776.6 ms | 1,029.4 / 347.6 ms |
| Response transfer per subsequent open | 836,861 bytes | 300 bytes |
| Same bytes replayed locally, 30 samples: P50 / P95 | 118.3 / 130.6 ms | 119.4 / 131.2 ms |
| Maximum observed page canvases | 3 | 3 |

The baseline spent 80%–93% of first-page waiting time reading the network
response. `no-cache` permits Chrome's HTTP cache to reuse an unchanged body
after server validation, unlike the previous `no-store`. It still waits for the
server, respects server cache policy and hashes the actual verified bytes.
The small remote sample demonstrates reduced body transfers, **not a stable
speedup percentage**. The local timings show no meaningful rendering speedup.
First visits, slow servers, noncacheable responses and heavy image decoding
remain outside this improvement. The full-byte validation barrier is retained.

Byte reading and PDF.js module loading now overlap; document parsing and saved
annotation reading overlap too. Both document and records must be ready before
publishing an editable reader. Deferred unit tests cover this barrier, failed
record loading and stale results after disposal. The HTTPS browser regression
in `tests/e2e/pdf-cache.spec.ts` verifies `200 → 304 → changed 200 → 503`, content
hash isolation, omitted cookies and no stale-success fallback. It fails on the
baseline at the expected second response (`200` instead of `304`).

Reproduce the interface timing with a tested build:

```bash
npm run benchmark:pdf-startup -- .build-output/chrome-mv3 /tmp/pdf-startup.json https://papers.miccai.org/miccai-2026/paper/2353_paper.pdf
```

An optional fourth argument supplies downloaded public fixture bytes and runs
three warmups plus 30 measured navigations without network transfer. Remote
mode makes three requests; do not run timing alongside tests or builds. Raw
samples, source identity, environment and limitations remain in the single
linked final report.

## Earlier v0.3 measurements

Measured 2026-09-19, Asia/Shanghai, on an Apple M4 Pro (14 logical cores, 48 GiB), macOS 26.6.2, Node 26.5.0 and Playwright Chromium 153.0.8010.12. Baseline: published v0.2.1 `282ac0c`; candidate webpage runtime/benchmark source: `69bdd60`. PDF measurements use `0326026`; the PDF source and dependencies are unchanged by the later isolated SVGPoint compatibility fix. Raw samples, archive identities, environment, and Boolean acceptance gates are in [performance-v0.3.json](performance-v0.3.json).

## Method

Both versions run the same scripts, machine, browser, isolated-profile configuration, artificial fixtures and warmups. Webpage capture/restore, library queries, first paint and search each have **30 measured samples after five warmups**. Image paint has **89 callback samples after ten warmups**. PDF cases each have **30 samples after three warmups**, with a fresh reader navigation per sample and a warm browser module cache. P95 is the sorted sample at `ceil(N × 0.95) - 1`, not an average or an extrapolation.

The article has **113,600 characters / 200 annotations**; the library has **10,000 annotations** with 98 sparse matches. Capture/save is measured from synthetic mouseup through appearance of the 201st saved highlight. It includes capture, the actual background database write and visible highlight update. Query timing includes runtime IPC. First paint runs from document navigation to the next animation frame after 50 rows exist. This is one local synthetic workload, not a cross-device guarantee.

| P95 measurement | v0.2.1 | v0.3.0 |
| --- | ---: | ---: |
| Restore 200 annotations | 43.4 ms | 42.3 ms |
| Selection to saved highlight | 29.9 ms | 6.2 ms |
| Library query, first 50 | 1.4 ms | 1.0 ms |
| Library first 50 rows painted | 31.8 ms | 31.2 ms |
| Image paint callback | 4.2 ms | 5.6 ms |
| Sparse substring query | 51.7 ms | 30.4 ms |
| No-match substring query | 83.1 ms | 58.1 ms |
| Sparse tag filter | 45.7 ms | 30.7 ms |

All stated webpage gates pass: capture/save improves by about **79%** (target ≥30%); no-match search is below 65 ms; sparse search is below 40 ms. Restore, pagination and first paint stay within the larger of 20% or 2 ms of baseline. The image callback also stays inside that tolerance, but its P95 is higher than the baseline: this run does **not** establish an image-scroll speedup.

Tests count one root-index build across unchanged selection capture/save/resolve and verify rebuilding after pending text/structure/editability changes. Saves update ID/revision deltas. Query tests compare complete ordered results at 1k, 10k and 50k records against a reference, and verify read caps/cancellation. Faster search is not an early stop that drops matches.

An initial candidate image P95 of 6.9 ms prompted a source comparison. Extraction itself retained the original algorithm; no causal attribution to extraction was established. A confirmed existing hotspot read the same image/ancestor geometry once per annotation. A frame-local cache now reads shared image geometry once per paint, with fresh measurements on the next frame. The initial candidate samples are retained in the raw report.

## PDF and resource limits

| Synthetic input | Open to interactive P95, baseline → candidate | Jump to last page P95 | Maximum observed canvases |
| --- | ---: | ---: | ---: |
| 20MiB | 260.8 → 260.4 ms | n/a | 1 |
| 50MiB | 492.9 → 523.9 ms | n/a | 1 |
| 500pages | 165.9 → 111.9 ms | 46.8 → 28.5 ms | 3 |
| 1000pages | 114.0 → 112.3 ms | 30.5 → 31.4 ms | 3 |

20/50 MiB fixtures use a valid PDF with an inert unreferenced stream; they measure full-byte read, SHA-256 and first-page startup, **not** expensive scanned-image decoding. The 500/1000-page timing fixtures contain text. Mixed-size pages, zoom/rotation and reading-anchor retention are checked separately by browser regressions. Input/open and jump timings include Playwright interaction and polling overhead.

The 50 MiB open P95 is about 6% slower in this run; no large-file startup speedup is claimed. Known uncompressed Content-Length input now owns one final destination buffer plus the current incoming chunk, without retaining a full chunks array and a second joined copy. Unknown-length/compressed responses still use bounded chunks and enforce the 50 MiB decoded limit. This structural reduction is verified in code and boundary tests; Web Crypto, PDF.js and browser-internal allocations are outside that ownership statement.

`observedMainBackingBytes` is CDP main-page backing storage sampled after the interactive page, **not** total browser memory or a measured download peak. It can include GC leftovers from prior cases and excludes worker/GPU/process resources. No whole-browser peak-memory reduction is claimed. Observable canvas counts remain 1 for single-page input and at most 3 for these long-document samples. The virtual window only mounts visible pages plus one neighbor on each side; session tests verify one loading-task destruction per replaced document and stale-result rejection.

Page-height updates use a Fenwick tree, O(log N), with O(1) per-page dimension map writes. A full O(N) layout rebuild is reserved for a new document, zoom or rotation. Measurements are batched per frame and scroll compensation follows the DOM commit. PDF notes are grouped by page and shown in 50-row batches; drafts live outside row components.

## Runtime size and reproduction

The resident webpage entry is unchanged at **14,236 raw / 5,121 gzip bytes**. The full v0.3.0 ZIP is **2,857,784 bytes (about 2.73 MiB)**, 3,356 bytes larger than v0.2.1. PDF.js and its resources remain separate from ordinary webpage loading. There are no new runtime dependencies, schema changes or persistent indexes.

Run `npm run build`, then `npm run benchmark:v03` and `npm run benchmark:pdf`. To measure a baseline archive, extract it outside the source tree and set `WEB_INK_BUILD` to that directory for the same scripts. Do not run competing browser/unit workloads during timing. All fixtures/profiles are temporary; no personal PDFs or annotations enter the repository.

---

# v0.2 performance evidence

Measured locally on macOS arm64 with Playwright Chromium 153.0.8010.12. Artificial fixtures only. Raw samples and exact byte counts are in [performance-v0.2.json](performance-v0.2.json); repeat with `npm run build` and `npm run benchmark`.

The reading fixture contains **113,600 characters and 200 annotations**. The library contains **10,000 annotations**. Restoration has 20 measured samples after two warmups; query timing has ten samples after two warmups. First-paint timing has five measured navigations after one warmup. These small local samples describe this setup, not a cross-device performance guarantee.

| Measurement | v0.1.3 | v0.2 candidate |
| --- | ---: | ---: |
| Resident webpage JS, raw bytes | 39,576 | 14,236 |
| Resident webpage JS, gzip bytes | 14,995 | 5,121 |
| Restore 200 annotations, P95 | 42.7 ms | 44.4 ms |
| Library request, P95 | 52.4 ms (all 10,000 records) | 2.3 ms (first 50 records) |
| First 50 library rows painted, P95 | not measured | 32.0 ms |
| Image paint callback, P95 | not measured | 5.6 ms |

The resident gzip payload is about **66% smaller**. Full-page restoration is effectively unchanged in this sample; the result does not establish a restoration speedup. The library result compares the old full-library operation with the new bounded first-page operation, not two identical queries. Substring search may still scan many records, but does so in cancellable batches rather than loading the entire library into the UI.

PDF.js, its worker, fonts, CMaps and decoders are packaged separately and loaded only by the PDF reader. The complete install archive is larger than v0.1.3. Development dependencies and test browsers are not part of browser runtime storage.

Browser regressions verify that metadata-only changes preserve the existing text Range and that scrolling reuses image SVG nodes. A separate synthetic image workload measures 50 visible pen marks, each with 500 points. A test-only isolated-world wrapper times the extension requestAnimationFrame callbacks: 89 callbacks after ten warmups, P95 5.6 ms. This is JavaScript callback time, not the complete browser layout/GPU frame time. PDF tests verify bounded page slots/canvases while jumping to page 35 in a 40-page synthetic document.
