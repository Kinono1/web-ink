import { createHash } from "node:crypto";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { corruptPdfCases, readCorruptPdfFixture } from "./fixtures/pdfs/corrupt";

let api: typeof import("pdfjs-dist");

beforeAll(async () => {
  const workerModule = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  vi.stubGlobal("pdfjsWorker", await import(workerModule));
  api = await import("pdfjs-dist/legacy/build/pdf.mjs");
});

async function readFirstPageText(bytes: Uint8Array): Promise<string> {
  const task = api.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    verbosity: api.VerbosityLevel.ERRORS,
    standardFontDataUrl: `${path.resolve("node_modules/pdfjs-dist/standard_fonts")}/`,
  });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const text = await page.getTextContent();
    return text.items.map(item => "str" in item ? item.str : "").join("");
  } finally {
    await task.destroy();
  }
}

describe("authored corrupt PDF fixtures", () => {
  it("contains ten distinct corrupt PDF byte samples with independently declared outcomes", async () => {
    expect(corruptPdfCases).toHaveLength(10);
    expect(new Set(corruptPdfCases.map(fixture => fixture.id)).size).toBe(10);
    expect(new Set(corruptPdfCases.map(fixture => fixture.file)).size).toBe(10);
    expect(corruptPdfCases.every(fixture => fixture.defect.length > 0)).toBe(true);

    const fingerprints = await Promise.all(corruptPdfCases.map(async fixture =>
      createHash("sha256").update(await readCorruptPdfFixture(fixture)).digest("hex"),
    ));
    expect(new Set(fingerprints).size).toBe(10);
  });

  for (const fixture of corruptPdfCases) {
    it(`has the declared PDF.js ${fixture.outcome} outcome for ${fixture.id}`, async () => {
      const bytes = await readCorruptPdfFixture(fixture);
      if (fixture.outcome === "reject") {
        await expect(readFirstPageText(bytes)).rejects.toBeInstanceOf(Error);
      } else {
        await expect(readFirstPageText(bytes)).resolves.toContain(fixture.expectedText);
      }
    });
  }
});
