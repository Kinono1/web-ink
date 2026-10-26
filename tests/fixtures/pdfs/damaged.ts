import { fixturePdf } from "../../pdf-fixture";

// Only original synthetic bytes. The recoverable cases intentionally exercise
// PDF.js fallback rather than declaring every irregular file corrupt.
export const truncatedPdf = () => fixturePdf().subarray(0, 80);
export const brokenXrefPdf = () => Buffer.from(fixturePdf().toString("latin1").replace(/startxref\n\d+/, "startxref\n0"), "latin1");
export const prefixedPdf = () => Buffer.concat([Buffer.from("\n% synthetic prefix\n"), fixturePdf()]);
export const missingFontPdf = () => Buffer.from(fixturePdf(1, "Missing font fallback fixture").toString("latin1").replace("/BaseFont /Helvetica", "/BaseFont /WebInkXYZ"), "latin1");
