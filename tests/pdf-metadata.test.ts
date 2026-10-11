import { expect, it, vi } from "vitest";
import { pdfDisplayName } from "../src/pdf/metadata";

function metadata(values: Record<string, unknown>) {
  return { get: (name: string) => values[name] };
}

it("prefers dc:title and appends the publisher DOI", () => {
  expect(
    pdfDisplayName(
      {
        info: { Title: "PDF info title" },
        metadata: metadata({
          "dc:title": "Full DPD-SAM paper title",
          "prism:doi": "10.1109/TII.2026.3716639",
        }),
      },
      "IEEE-11643626.pdf",
    ),
  ).toBe("Full DPD-SAM paper title — DOI: 10.1109/TII.2026.3716639");
});

it("uses info.Title when dc:title is missing or invalid", () => {
  expect(
    pdfDisplayName(
      {
        info: { Title: "  Fallback\nPDF\tTitle  " },
        metadata: metadata({
          "dc:title": 123,
          "prism:doi": "doi:10.1109/TII.2026.3716639",
        }),
      },
      "fallback.pdf",
    ),
  ).toBe("Fallback PDF Title — DOI: 10.1109/TII.2026.3716639");
});

it.each([
  ["10.1109/TII.2026.3716639", "10.1109/TII.2026.3716639"],
  ["doi:10.1109/TII.2026.3716639", "10.1109/TII.2026.3716639"],
  ["https://doi.org/10.1109/TII.2026.3716639", "10.1109/TII.2026.3716639"],
])("normalizes a DOI identifier %j", (identifier, doi) => {
  expect(
    pdfDisplayName(
      { metadata: metadata({ "dc:identifier": identifier }) },
      "fallback.pdf",
    ),
  ).toBe(`DOI: ${doi}`);
});

it("uses the fallback when no valid title or DOI is available", () => {
  expect(
    pdfDisplayName(
      {
        info: { Title: "" },
        metadata: metadata({
          "dc:title": "\u0001invalid title",
          "prism:doi": "https://publisher.example/paper/10.1109/TII.2026.3716639",
          "dc:identifier": "https://doi.org/10.1109/TII.2026.3716639?download=1",
        }),
      },
      "IEEE-11643626.pdf",
    ),
  ).toBe("IEEE-11643626.pdf");
});

it("ignores throwing getters and rejects userinfo, non-DOI URLs, queries, and malformed text", () => {
  const values: Record<string, unknown> = {
    "dc:title": "Safe title",
    "prism:doi": "https://user@doi.org/10.1109/TII.2026.3716639",
    "dc:identifier": "https://doi.org/10.1109/TII.2026.3716639#section",
  };
  const get = vi.fn((name: string) => {
    if (name === "prism:doi") throw new Error("unavailable metadata");
    return values[name];
  });

  expect(pdfDisplayName({ metadata: { get } }, "fallback.pdf")).toBe(
    "Safe title",
  );
  expect(get).toHaveBeenCalledWith("prism:doi");
  expect(get).toHaveBeenCalledWith("dc:identifier");
});

it.each([
  { "dc:title": "Bad\u0000Title", "prism:doi": "not-a-doi" },
  { "dc:title": "Bad\uD800Title", "prism:doi": "not-a-doi" },
  { "dc:title": "Safe title", "prism:doi": "10.1109/TII.2026.3716639?x=1" },
  { "dc:title": "Safe title", "prism:doi": "http://doi.org/10.1109/TII.2026.3716639" },
  { "dc:title": "Safe title", "prism:doi": "https://user@doi.org/10.1109/TII.2026.3716639" },
  { "dc:title": "Safe title", "prism:doi": "https://@doi.org/10.1109/TII.2026.3716639" },
  { "dc:title": "Safe title", "prism:doi": "https://doi.org.evil.test/10.1109/TII.2026.3716639" },
])("rejects hostile or malformed metadata values: %j", (values) => {
  const result = pdfDisplayName(
    { metadata: metadata(values) },
    "fallback.pdf",
  );
  expect(result).not.toContain("Bad");
  expect(result).not.toContain("DOI:");
});

it.each([
  ["trailing high surrogate", "Bad\uD800"],
  ["isolated low surrogate", "Bad\uDC00Title"],
])("rejects a %s in a title", (_name, title) => {
  expect(
    pdfDisplayName(
      { metadata: metadata({ "dc:title": title }) },
      "fallback.pdf",
    ),
  ).toBe("fallback.pdf");
});

it("accepts a valid surrogate pair in a title", () => {
  expect(
    pdfDisplayName(
      { metadata: metadata({ "dc:title": "DPD-SAM 😀 title" }) },
      "fallback.pdf",
    ),
  ).toBe("DPD-SAM 😀 title");
});

it("rejects oversized metadata values and falls back", () => {
  expect(
    pdfDisplayName(
      {
        info: { Title: "x".repeat(4097) },
        metadata: metadata({ "dc:title": "x".repeat(4097) }),
      },
      "fallback.pdf",
    ),
  ).toBe("fallback.pdf");
});

it("bounds the display name without splitting a surrogate pair", () => {
  const title = `${"x".repeat(499)}😀tail`;
  const result = pdfDisplayName(
    { metadata: metadata({ "dc:title": title }) },
    "fallback.pdf",
  );

  expect(result.length).toBeLessThanOrEqual(500);
  expect(result).toBe("x".repeat(499));
});

it("reserves room for a DOI when truncating the title", () => {
  const doi = "10.1109/TII.2026.3716639";
  const result = pdfDisplayName(
    {
      metadata: metadata({
        "dc:title": `${"x".repeat(600)}😀tail`,
        "prism:doi": doi,
      }),
    },
    "fallback.pdf",
  );

  expect(result.length).toBeLessThanOrEqual(500);
  expect(result).toBe(`${"x".repeat(500 - ` — DOI: ${doi}`.length)} — DOI: ${doi}`);
  expect(result).not.toContain("\uD83D");
});
