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

type PdfInspection =
  | { stage: "load" | "page" | "text"; message: string }
  | { stage: "recovered"; text: string };

const messageFor = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const task = api.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    verbosity: api.VerbosityLevel.ERRORS,
    standardFontDataUrl: `${path.resolve("node_modules/pdfjs-dist/standard_fonts")}/`,
  });
  try {
    let document: Awaited<typeof task.promise>;
    try {
      document = await task.promise;
    } catch (cause) {
      return { stage: "load", message: messageFor(cause) };
    }
    let page: Awaited<ReturnType<typeof document.getPage>>;
    try {
      page = await document.getPage(1);
    } catch (cause) {
      return { stage: "page", message: messageFor(cause) };
    }
    try {
      const text = await page.getTextContent();
      return { stage: "recovered", text: text.items.map(item => "str" in item ? item.str : "").join("") };
    } catch (cause) {
      return { stage: "text", message: messageFor(cause) };
    }
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
      const observed = await inspectPdf(bytes);
      if (fixture.outcome === "reject") {
        expect(observed.stage).toBe(fixture.failure.stage);
        expect(observed).not.toHaveProperty("text");
        if ("message" in observed) expect(observed.message).toMatch(fixture.failure.diagnostic);
      } else {
        expect(observed).toEqual({ stage: "recovered", text: expect.stringContaining(fixture.expectedText) });
      }
    });
  }
});
