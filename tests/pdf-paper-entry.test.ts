import { describe, expect, it } from "vitest";
import type { PdfTextAnnotation } from "../src/core/model";
import { pdfReaderUrl } from "../src/ui/management/helpers";

function record(sourceUrl: string): PdfTextAnnotation {
  return {
    id: "paper-mark", kind: "pdf-text", pageUrl: `urn:web-ink:pdf:${"a".repeat(64)}`,
    pageTitle: "IEEE paper", color: "#facd5a", note: "", tags: [], revision: 1,
    createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z",
    target: { documentHash: "a".repeat(64), fileName: "IEEE-11643626.pdf", sourceUrl,
      pageNumber: 3, rects: [{ x: .1, y: .2, width: .3, height: .1 }], exact: "priors", prefix: "", suffix: "" },
  };
}

describe("saved PDF reopening", () => {
  it("opens an explicit DOI source directly even after preferences are lost or a backup is imported", () => {
    expect(pdfReaderUrl("chrome-extension://test/pdf.html", record("https://doi.org/10.1109/TII.2026.3716639")))
      .toBe("https://doi.org/10.1109/TII.2026.3716639");
  });
  it("prefers the confirmed DOI for an old IEEE record without altering its stored source", () => {
    const old = record("https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626&ticket=expired");
    const before = structuredClone(old);
    expect(pdfReaderUrl("chrome-extension://test/pdf.html", old, { doi: "10.1109/TII.2026.3716639" }))
      .toBe("https://doi.org/10.1109/TII.2026.3716639");
    expect(old).toEqual(before);
  });
  it("rejects a malformed DOI and still uses the stable IEEE paper entry", () => {
    expect(pdfReaderUrl("chrome-extension://test/pdf.html", record("https://ieeexplore.ieee.org/document/11643626"), { doi: "https://evil.test/10.1109/paper" }))
      .toBe("https://ieeexplore.ieee.org/document/11643626");
  });
  it("does not trust an imported record title as a DOI source", () => {
    const imported = record("https://ieeexplore.ieee.org/document/11643626");
    imported.pageTitle = "Different paper — DOI: 10.9999/incorrect-paper";
    expect(pdfReaderUrl("chrome-extension://test/pdf.html", imported))
      .toBe("https://ieeexplore.ieee.org/document/11643626");
  });
  it.each([
    "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=11643626",
    "https://ieeexplore.ieee.org/document/11643626/?ticket=old#page=3",
  ])("returns an IEEE record to its stable article page: %s", (source) => {
    expect(pdfReaderUrl("chrome-extension://test/pdf.html", record(source)))
      .toBe("https://ieeexplore.ieee.org/document/11643626");
  });
  it("uses the confirmed paper identity for a legacy temporary PDF URL", () => {
    expect(pdfReaderUrl("chrome-extension://test/pdf.html", record("https://ieeexplore.ieee.org/temporary/paper.pdf?ticket=expired"),
      { doi: "10.1109/TII.2026.3716639", paperUrl: "https://ieeexplore.ieee.org/document/11643626" }))
      .toBe("https://doi.org/10.1109/TII.2026.3716639");
  });
  it("does not replay a temporary IEEE PDF when no paper identity can be verified", () => {
    const url = new URL(pdfReaderUrl("chrome-extension://test/pdf.html", record("https://ieeexplore.ieee.org/temporary/paper.pdf?ticket=expired")));
    expect(url.searchParams.get("document")).toBe("a".repeat(64));
    expect(url.searchParams.has("source")).toBe(false);
  });
  it.each([
    "https://ieeexplore.ieee.org.evil.test/stamp/stamp.jsp?arnumber=11643626",
    "https://user@ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626",
    "https://papers.example.test/paper.pdf",
  ])("does not manufacture an IEEE article entry for %s", (source) => {
    const url = new URL(pdfReaderUrl("chrome-extension://test/pdf.html", record(source)));
    expect(url.protocol).toBe("chrome-extension:");
    expect(url.searchParams.get("document")).toBe("a".repeat(64));
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("source")).toBe(source);
  });
});
