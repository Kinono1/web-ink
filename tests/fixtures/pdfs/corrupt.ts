import { readFile } from "node:fs/promises";
import path from "node:path";

export type CorruptPdfRejection = {
  id: string;
  file: string;
  /** The authored fault, reviewed independently of PDF.js recovery behavior. */
  defect: string;
  outcome: "reject";
  /** Where PDF.js detects this defect with the reader's strict load settings. */
  failure: { stage: "load" | "page"; diagnostic: RegExp };
};

export type CorruptPdfRecovery = {
  id: string;
  file: string;
  /** The authored fault, reviewed independently of PDF.js recovery behavior. */
  defect: string;
  outcome: "recover";
  /** Meaning preserved by a safe recovery. */
  expectedText: string;
};

export type CorruptPdfFixture = CorruptPdfRejection | CorruptPdfRecovery;

/**
 * Small, authored malformed PDFs. They are neither downloaded papers nor user
 * content. The expected outcomes are measured by pdf-corrupt-fixtures.test.ts
 * through the reader's PDF.js loading settings.
 */
export const corruptPdfCases: readonly CorruptPdfFixture[] = [
  { id: "missing-root", file: "missing-root.pdf", defect: "trailer omits /Root", outcome: "reject", failure: { stage: "load", diagnostic: /invalid root reference/i } },
  { id: "dangling-root", file: "dangling-root.pdf", defect: "trailer /Root references a missing object", outcome: "reject", failure: { stage: "load", diagnostic: /invalid root reference/i } },
  { id: "root-is-page", file: "root-is-page.pdf", defect: "trailer /Root points at a /Page instead of a catalog", outcome: "reject", failure: { stage: "load", diagnostic: /invalid PDF structure/i } },
  { id: "missing-kids", file: "missing-kids.pdf", defect: "catalog /Pages points to a missing object", outcome: "reject", failure: { stage: "load", diagnostic: /invalid root reference/i } },
  { id: "dangling-page", file: "dangling-page.pdf", defect: "/Pages /Kids references a missing page object", outcome: "reject", failure: { stage: "page", diagnostic: /page dictionary kid reference points to wrong type/i } },
  { id: "cyclic-pages", file: "cyclic-pages.pdf", defect: "/Pages includes itself as its only kid", outcome: "reject", failure: { stage: "page", diagnostic: /pages tree contains circular reference/i } },
  { id: "malformed-object-header", file: "malformed-object-header.pdf", defect: "catalog object header has a nonnumeric generation", outcome: "reject", failure: { stage: "load", diagnostic: /invalid PDF structure/i } },
  { id: "negative-stream-length", file: "negative-stream-length.pdf", defect: "page content stream declares a negative /Length", outcome: "recover", expectedText: "Recovered negative length marker" },
  { id: "xref-offset-recovery", file: "xref-offset-recovery.pdf", defect: "xref entry for the page points outside the file", outcome: "recover", expectedText: "Recovered xref marker" },
  { id: "oversized-stream-length", file: "oversized-stream-length.pdf", defect: "page content stream declares a length beyond its endstream", outcome: "recover", expectedText: "Recovered stream marker" },
];

export async function readCorruptPdfFixture(fixture: CorruptPdfFixture): Promise<Buffer> {
  return readFile(path.resolve("tests/fixtures/pdfs/corrupt", fixture.file));
}
