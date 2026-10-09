# Web Ink product truth

## Confirmed scope

Web Ink is a **local-first Chrome extension for annotating webpages and PDFs**.
It helps one person keep text highlights, image marks, PDF highlights/areas, and
notes while reading. Its working context is a private Chrome profile on one
device, not a shared workspace or a cloud service.

- Annotations and settings live in the current browser. JSON and Markdown
  export are explicit user actions; changing devices, clearing browser data, or
  uninstalling can remove local data.
- The PDF reader accepts a local PDF or an allowed public HTTPS PDF. It keeps
  annotations locally; it does not upload a PDF or claim to preserve the PDF
  file in the library.
- A native/current-tab PDF is opened through the side-panel action, then the
  dedicated reader can return to the observed original tab context. The return
  target must not be invented from user input.
- The extension has no account, synchronization, cloud storage, OCR, AI, or
  knowledge-base feature.

## People and jobs

The primary user reads research papers and ordinary technical webpages in
Chrome. They need to capture a passage or image quickly, find it later, and
return to its source without learning a separate note system.

The product must make three boundaries legible:

1. **Where an action applies:** current webpage, reader, or all saved notes.
2. **Where data stays:** the current browser/device.
3. **What needs a choice:** selecting a PDF source, saving an annotation, or
   resolving a recovery/error state.

## Non-goals and constraints

- Preserve the existing annotation database and JSON backup schema.
- Keep normalized PDF geometry and virtual page layout; this documentation
  does not propose a replacement reader engine.
- Keep system fonts, existing dependencies, existing annotation colors, and
  local-only data. No remote asset, new dependency, or production behavior is
  introduced by the Stage A prototype.
- “Current PDF”, handoff, restore, and error controls shown in the prototype
  describe approved interaction intent. They are **not evidence that the
  runtime behavior has shipped**.

## Prototype data notice

`docs/design/v032-prototype.html` is a static clickable prototype. Its reading
records, counts, filename, source URL, storage number, and errors are
**synthetic illustrative data**, not a user profile, browser state, or
production screen capture.
