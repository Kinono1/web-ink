import { describe, expect, it } from "vitest";
import { buildPdfOpenUrl, classifyPdfTab, getPdfContext } from "../src/pdf/context";

describe("PDF page context", () => {
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

  it("does not treat arbitrary untyped IEEE wrapper iframes as PDF sources", () => {
    expect(classifyPdfTab(7, "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123", [
      { url: "https://ads.example.test/frame", via: "iframe", mimeType: "" },
      { url: "https://ieeexplore.ieee.org/visible-download?document=123", via: "iframe", mimeType: "" },
      { url: "/navigation/footer", via: "iframe", mimeType: "" },
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
