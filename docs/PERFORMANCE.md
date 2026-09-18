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
