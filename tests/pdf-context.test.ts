import { afterEach, describe, expect, it } from "vitest";
import { buildPdfOpenUrl, classifyPdfTab, getPdfContext, probePdfDocument } from "../src/pdf/context";

function makeVisible(element: Element) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400 }),
  });
}

function attachSameOriginFrame(frame: HTMLIFrameElement, content: string) {
  const child = document.implementation.createHTMLDocument("same-origin frame");
  child.head.innerHTML = `<base href="${location.href}">`;
  child.body.innerHTML = content;
  Object.defineProperty(frame, "contentDocument", { configurable: true, value: child });
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: {
      location: { origin: location.origin },
      innerHeight: innerHeight,
      innerWidth: innerWidth,
      getComputedStyle: getComputedStyle.bind(window),
    },
  });
  return child;
}

afterEach(() => document.body.replaceChildren());

describe("PDF page context", () => {
  it("observes a visible PDF embed inside an accessible same-origin iframe", () => {
    document.body.innerHTML = '<iframe src="/frame"></iframe>';
    const frame = document.querySelector("iframe")!;
    makeVisible(frame);
    const child = attachSameOriginFrame(
      frame,
      '<embed src="https://papers.example.test/download?document=123" type="application/pdf">',
    );
    makeVisible(child.querySelector("embed")!);

    expect(probePdfDocument().candidates).toContainEqual({
      url: "https://papers.example.test/download?document=123",
      via: "embed",
      mimeType: "application/pdf",
    });
  });

  it("does not inspect the DOM of a third-party extension iframe", () => {
    document.body.innerHTML = '<iframe src="chrome-extension://third-party/reader.html"></iframe>';
    const frame = document.querySelector("iframe")!;
    makeVisible(frame);
    const child = document.implementation.createHTMLDocument("foreign frame");
    child.body.innerHTML = '<embed src="https://papers.example.test/should-not-be-seen.pdf" type="application/pdf">';
    makeVisible(child.querySelector("embed")!);
    Object.defineProperty(frame, "contentDocument", { configurable: true, value: child });
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: { location: { origin: "chrome-extension://third-party" } },
    });

    expect(probePdfDocument().candidates).not.toContainEqual({
      url: "https://papers.example.test/should-not-be-seen.pdf",
      via: "embed",
      mimeType: "application/pdf",
    });
  });

  it("does not collect hidden embeds or ordinary PDF links", () => {
    document.body.innerHTML = [
      '<a href="https://papers.example.test/download?document=123">download</a>',
      '<embed hidden src="https://papers.example.test/hidden.pdf" type="application/pdf">',
    ].join("");
    makeVisible(document.querySelector("embed")!);

    expect(probePdfDocument().candidates).toEqual([]);
  });

  it("recurses through two same-origin iframe documents but stops before a third", () => {
    document.body.innerHTML = '<iframe src="/one"></iframe>';
    const first = document.querySelector("iframe")!;
    makeVisible(first);
    const firstDocument = attachSameOriginFrame(first, '<iframe src="/two"></iframe>');
    const second = firstDocument.querySelector("iframe")!;
    makeVisible(second);
    const secondDocument = attachSameOriginFrame(second, '<iframe src="/three"></iframe>');
    const third = secondDocument.querySelector("iframe")!;
    makeVisible(third);
    const thirdDocument = attachSameOriginFrame(
      third,
      '<embed src="https://papers.example.test/too-deep.pdf" type="application/pdf">',
    );
    makeVisible(thirdDocument.querySelector("embed")!);

    const candidates = probePdfDocument().candidates;
    expect(candidates).toContainEqual({ url: "http://localhost:3000/three", via: "iframe", mimeType: "" });
    expect(candidates).not.toContainEqual({
      url: "https://papers.example.test/too-deep.pdf",
      via: "embed",
      mimeType: "application/pdf",
    });
  });

  it("caps candidates across a recursively inspected iframe tree", () => {
    document.body.innerHTML = '<iframe src="/frame"></iframe>';
    const frame = document.querySelector("iframe")!;
    makeVisible(frame);
    const child = attachSameOriginFrame(
      frame,
      Array.from({ length: 100 }, (_, index) =>
        `<embed src="https://papers.example.test/${index}.pdf" type="application/pdf">`,
      ).join(""),
    );
    for (const embed of child.querySelectorAll("embed")) makeVisible(embed);

    const candidates = probePdfDocument().candidates;
    expect(candidates).toHaveLength(100);
    expect(candidates).toContainEqual({ url: "https://papers.example.test/98.pdf", via: "embed", mimeType: "application/pdf" });
    expect(candidates).not.toContainEqual({ url: "https://papers.example.test/99.pdf", via: "embed", mimeType: "application/pdf" });
  });

  it('marks actual HTTPS IEEE wrapper context for an explicit session action', () => {
    expect(classifyPdfTab(7, 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1')).toMatchObject({ publisher: 'ieee', kind: 'wrapper' });
    expect(classifyPdfTab(7, 'https://other.test/stamp/stamp.jsp')).not.toHaveProperty('publisher');
  });
  it("recognizes HTTPS PDF paths case-insensitively and preserves query/hash", () => {
    const source = "https://papers.example.test/Study.PdF?token=a%2Bb#page=4";
    expect(getPdfContext(source)).toEqual({ kind: "remote", sourceUrl: source });
  });

  it("recognizes common extensionless arXiv PDF paths", () => {
    expect(getPdfContext("https://arxiv.org/pdf/2401.01234v2?download=1")).toEqual({
      kind: "remote",
      sourceUrl: "https://arxiv.org/pdf/2401.01234v2?download=1",
    });
    expect(getPdfContext("https://arxiv.org/pdf/hep-th/9901001")).toEqual({
      kind: "remote",
      sourceUrl: "https://arxiv.org/pdf/hep-th/9901001",
    });
  });

  it("recognizes HTTP and file PDFs without marking them remotely loadable", () => {
    expect(getPdfContext("http://papers.example.test/paper.pdf?download=1")).toEqual({
      kind: "local",
    });
    expect(getPdfContext("file:///Users/reader/paper.PDF#page=2")).toEqual({
      kind: "local",
    });
  });

  it("unwraps known viewer pages to a safe HTTPS source, including download endpoints", () => {
    const source = "https://papers.example.test/download?token=x#page=3";
    const encoded = encodeURIComponent(source);
    expect(
      getPdfContext(
        `chrome-extension://dahenjhkoodjbpjheillcadbppiidmhp/reader.html?url=${encoded}`,
      ),
    ).toEqual({ kind: "remote", sourceUrl: source });
    expect(
      getPdfContext(
        `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=${encoded}`,
      ),
    ).toEqual({ kind: "remote", sourceUrl: source });
    expect(
      getPdfContext(`chrome-extension://untrusted/reader.html?url=${encoded}`),
    ).toBeUndefined();
    expect(
      getPdfContext(
        "chrome-extension://dahenjhkoodjbpjheillcadbppiidmhp/reader.html",
      ),
    ).toEqual({ kind: "viewer" });
  });

  it("does not classify malicious protocols or credentialed remote URLs", () => {
    for (const raw of [
      "javascript:alert('paper.pdf')",
      "data:application/pdf;base64,JVBERi0=",
      "https://user:secret@papers.example.test/paper.pdf",
      "chrome-extension://dahenjhkoodjbpjheillcadbppiidmhp/reader.html?url=javascript%3Aalert%281%29",
    ])
      expect(getPdfContext(raw)).toBeUndefined();
  });

  it("opens only safe remote sources and otherwise returns the reader unchanged", () => {
    const reader = "chrome-extension://webink/pdf.html?theme=dark";
    const remote = getPdfContext("https://papers.example.test/paper.pdf?token=x#page=2")!;
    const opened = new URL(buildPdfOpenUrl(reader, remote));
    expect(opened.searchParams.get("source")).toBe(
      "https://papers.example.test/paper.pdf?token=x#page=2",
    );
    expect(opened.searchParams.get("open")).toBe("1");

    expect(
      buildPdfOpenUrl(reader, getPdfContext("file:///Users/reader/paper.pdf")),
    ).toBe(reader);
    expect(
      buildPdfOpenUrl(
        reader,
        getPdfContext(
          "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=file%3A%2F%2F%2FUsers%2Freader%2Fpaper.pdf",
        ),
      ),
    ).toBe(reader);
  });

  it("returns an unavailable context for a malformed observed URL", () => {
    expect(classifyPdfTab(7, "invalid URL")).toMatchObject({ kind: "unavailable", candidates: [], reason: "context-unavailable" });
  });

  it("keeps credentialed PDF embeds in an explicit unsafe manual fallback even without a MIME hint", () => {
    expect(classifyPdfTab(7, "https://papers.example.test/article", [
      { url: "https://user:secret@papers.example.test/paper.pdf", via: "iframe", mimeType: "" },
    ])).toMatchObject({ kind: "embedded", candidates: [], reason: "unsafe-source" });
  });

  it("labels known viewers wrapping HTTP or file sources as a local-source fallback", () => {
    for (const source of ["http://papers.example.test/paper.pdf", "file:///tmp/paper.pdf"])
      expect(classifyPdfTab(7, `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=${encodeURIComponent(source)}`))
        .toMatchObject({ kind: "wrapper", candidates: [], reason: "local-source" });
  });

  it("keeps observed same-origin IEEE iframe endpoints for later byte validation", () => {
    expect(classifyPdfTab(7, "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123", [
      { url: "https://ads.example.test/frame", via: "iframe", mimeType: "" },
      { url: "https://ieeexplore.ieee.org/visible-download?document=123", via: "iframe", mimeType: "" },
      { url: "/navigation/footer", via: "iframe", mimeType: "" },
    ])).toMatchObject({ kind: "wrapper", candidates: [
      { url: "https://ieeexplore.ieee.org/visible-download?document=123", via: "iframe" },
      { url: "https://ieeexplore.ieee.org/navigation/footer", via: "iframe" },
    ] });
  });

  it("does not infer extensionless PDF sources from ordinary pages or non-iframe elements", () => {
    const endpoint = "https://papers.example.test/download?document=123";
    expect(classifyPdfTab(7, "https://papers.example.test/article", [
      { url: endpoint, via: "iframe", mimeType: "" },
    ])).toMatchObject({ kind: "unavailable", candidates: [], reason: "not-pdf" });
    expect(classifyPdfTab(7, "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123", [
      { url: "https://ieeexplore.ieee.org/download?document=123", via: "object", mimeType: "" },
    ])).toMatchObject({ kind: "wrapper", candidates: [], reason: "source-unknown" });
  });

  it("selects only the PDF-hinted iframe from mixed IEEE wrapper content", () => {
    expect(classifyPdfTab(7, "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123", [
      { url: "https://ads.example.test/frame", via: "iframe", mimeType: "" },
      { url: "https://papers.example.test/paper.PDF?download=1", via: "iframe", mimeType: "" },
      { url: "https://papers.example.test/login.pdf", via: "iframe", mimeType: "text/html" },
    ])).toMatchObject({ kind: "wrapper", candidates: [
      { url: "https://papers.example.test/paper.PDF?download=1", via: "iframe" },
    ] });
  });

  it.each([
    { url: "https://papers.example.test/paper.pdf", mimeType: "", source: "https://papers.example.test/paper.pdf" },
    { url: "https://arxiv.org/pdf/2401.01234v2", mimeType: "", source: "https://arxiv.org/pdf/2401.01234v2" },
    { url: "https://papers.example.test/download?document=123", mimeType: "application/pdf; charset=binary", source: "https://papers.example.test/download?document=123" },
    { url: `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=${encodeURIComponent("https://papers.example.test/download?document=123")}`, mimeType: "", source: "https://papers.example.test/download?document=123" },
  ])("keeps an observed IEEE PDF hint for $url", ({ url, mimeType, source }) => {
    expect(classifyPdfTab(7, "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123", [
      { url, via: "iframe", mimeType },
    ])).toMatchObject({ kind: "wrapper", candidates: [{ url: source, via: "iframe" }] });
  });
});
