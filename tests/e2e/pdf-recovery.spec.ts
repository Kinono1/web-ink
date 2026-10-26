import { test, expect, rpc } from "./fixtures/extension";
import { fixturePdf } from "../pdf-fixture";
import { encryptedPdf } from "../fixtures/pdfs/encrypted";
import { corruptPdfCases, readCorruptPdfFixture } from "../fixtures/pdfs/corrupt";
import { truncatedPdf, brokenXrefPdf, prefixedPdf, missingFontPdf } from "../fixtures/pdfs/damaged";

for (const [name, fixture, error] of [
  ["truncated", truncatedPdf, /invalid|无效/i],
  ["password-protected", encryptedPdf, /password|密码|加密/i],
] as const) {
  test(`a ${name} PDF fails visibly without partial annotations and the next valid file opens`, async ({ extension }) => {
    const { context, id, library } = extension;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/pdf.html`);
    const before = await rpc(library, { type: "annotations.list" });
    await page.getByLabel("选择本地 PDF", { exact: true }).setInputFiles({
      name: `${name}.pdf`, mimeType: "application/pdf", buffer: fixture(),
    });
    await expect(page.getByRole("alert")).toContainText(error);
    await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(0);
    expect(await rpc(library, { type: "annotations.list" })).toEqual(before);
    await page.getByLabel("选择本地 PDF", { exact: true }).setInputFiles({
      name: "healthy.pdf", mimeType: "application/pdf", buffer: fixturePdf(),
    });
    await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(1);
    await expect(page.locator(".pdf-name")).toHaveText("healthy.pdf");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
for (const [name, fixture] of [
  ["reconstructed-xref", brokenXrefPdf], ["binary-prefix", prefixedPdf], ["missing-font", missingFontPdf],
] as const) {
  test(`PDF.js recovers a ${name} synthetic PDF with a selectable text layer`, async ({ extension }) => {
    const page = await extension.context.newPage();
    await page.goto(`chrome-extension://${extension.id}/pdf.html`);
    await page.getByLabel("选择本地 PDF", { exact: true }).setInputFiles({
      name: `${name}.pdf`, mimeType: "application/pdf", buffer: fixture(),
    });
    await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(1);
    await expect(page.locator(".textLayer")).toContainText(name === "missing-font" ? "Missing font fallback fixture" : "Web Ink PDF highlights survive a return visit.");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await rpc(extension.library, { type: "annotations.list" })).toEqual([]);
  });
}

for (const fixture of corruptPdfCases) {
  test(`a ${fixture.id} corrupt PDF keeps annotation state safe before a healthy file opens`, async ({ extension }) => {
    const { context, id, library } = extension;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/pdf.html`);
    const before = await rpc(library, { type: "annotations.list" });
    await page.getByLabel("选择本地 PDF", { exact: true }).setInputFiles({
      name: fixture.file, mimeType: "application/pdf", buffer: await readCorruptPdfFixture(fixture),
    });

    if (fixture.outcome === "reject") {
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(0);
    } else {
      if (!fixture.expectedText) throw Error(`Recoverable fixture ${fixture.id} needs expected text`);
      await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(1);
      await expect(page.locator(".textLayer")).toContainText(fixture.expectedText);
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    expect(await rpc(library, { type: "annotations.list" })).toEqual(before);

    await page.getByLabel("选择本地 PDF", { exact: true }).setInputFiles({
      name: `healthy-after-${fixture.id}.pdf`, mimeType: "application/pdf", buffer: fixturePdf(),
    });
    await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(1);
    await expect(page.locator(".pdf-name")).toHaveText(`healthy-after-${fixture.id}.pdf`);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await rpc(library, { type: "annotations.list" })).toEqual(before);
  });
}
