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
  it.each([
    "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=11643626",
    "https://ieeexplore.ieee.org/document/11643626/?ticket=old#page=3",
  ])("returns an IEEE record to its stable article page: %s", (source) => {
    expect(pdfReaderUrl("chrome-extension://test/pdf.html", record(source)))
      .toBe("https://ieeexplore.ieee.org/document/11643626");
  });
  it.each([
    "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=not-a-number",
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
