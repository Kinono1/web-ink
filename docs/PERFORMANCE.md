# v0.3 performance evidence

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
