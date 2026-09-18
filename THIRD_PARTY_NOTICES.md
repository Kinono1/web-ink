# Third-party notices

The exact bundled set is generated during packaging. The release ZIP contains full license texts under `licenses/`, including `THIRD_PARTY_LICENSES.txt` and the resource-specific PDF.js notices described below.

| Component | Version | License | Use |
| --- | ---: | --- | --- |
| WXT | 0.21.4 | MIT | Extension build tooling |
| React / React DOM | 19.3.0 | MIT | Extension UI |
| Dexie | 4.4.6 | Apache-2.0 | IndexedDB storage |
| perfect-freehand | 1.2.3 | MIT | Freehand stroke rendering |
| PDF.js / `pdfjs-dist` | 6.3.289 | Apache-2.0 for the PDF.js library | PDF rendering and text extraction |

## PDF.js packaged resources

Web Ink packages the PDF.js legacy build with the **matching 6.3.289 worker**, plus required `cmaps`, `standard_fonts`, `wasm`, and related PDF.js assets. These resources are not all licensed solely by the PDF.js library's Apache-2.0 notice. Each resource keeps and ships its own upstream `LICENSE`, `LICENSE_*`, or notice file where provided.

In particular, do not infer one uniform license for standard fonts, CMaps, WASM codecs, ICC data, or their fallback scripts from the PDF.js library license. Consult the matching files in the release ZIP's `pdfjs/` and `licenses/` directories before redistributing a modified package.

Design references may be mentioned in source history or documentation, but their full clients are not bundled unless explicitly listed in the generated release notices.
