import type { Page } from "@playwright/test";
import type { TextAnnotation } from "../../src/core/model";
import { test, expect, rpc } from "./fixtures/extension";
import { fixturePdf } from "../pdf-fixture";
import { encryptedPdf } from "../fixtures/pdfs/encrypted";
import { corruptPdfCases, readCorruptPdfFixture } from "../fixtures/pdfs/corrupt";
import { truncatedPdf, brokenXrefPdf, prefixedPdf, missingFontPdf } from "../fixtures/pdfs/damaged";

async function seedExistingAnnotation(library: Page, fixtureId: string): Promise<TextAnnotation[]> {
  const exact = "Keep this complete existing annotation";
  const annotation: TextAnnotation = {
    id: `preserve-${fixtureId}`,
    kind: "text",
    pageUrl: `https://example.test/pdf-recovery/${fixtureId}`,
    pageTitle: "Existing annotation must survive corrupt PDF handling",
    color: "#facd5a",
    note: "Keep this note, tags, target, identity, and revision unchanged.",
    tags: ["pdf-recovery", "preserve"],
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    revision: 0,
    target: { exact, prefix: "Before ", suffix: " after", start: 7, end: 7 + exact.length, rootSelector: "#existing-annotation" },
  };
  await rpc(library, { type: "annotations.put", annotation, expectedRevision: 0 });
  const records = await rpc<TextAnnotation[]>(library, { type: "annotations.list" });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ ...annotation, revision: expect.any(Number) });
  return records;
}

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
    const before = await seedExistingAnnotation(library, fixture.id);
    await page.getByLabel("选择本地 PDF", { exact: true }).setInputFiles({
      name: fixture.file, mimeType: "application/pdf", buffer: await readCorruptPdfFixture(fixture),
    });

    if (fixture.outcome === "reject") {
      if (fixture.failure.stage === "load") {
        await expect(page.getByRole("alert")).toContainText(fixture.failure.diagnostic);
      } else {
        const firstPage = page.locator(".pdf-page").filter({ has: page.getByLabel("PDF 1", { exact: true }) });
        const pageError = firstPage.locator(".pdf-page-error[role=alert]");
        await expect(firstPage).toHaveCount(1);
        await expect(pageError.getByRole("heading", { name: "第 1 页无法完整显示", exact: true })).toBeVisible();
        await expect(pageError).toContainText("这页暂时无法显示，请重新打开 PDF。");
        await expect(pageError).toContainText("标注仍保存在本机。");
        await expect(page.locator(".pdf-welcome")).toHaveCount(0);
      }
      await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(0);
    } else {
      await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(1);
      await expect(page.locator(".textLayer")).toContainText(fixture.expectedText);
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    expect(await rpc(library, { type: "annotations.list" })).toEqual(before);

    if (await page.locator(".pdf-toolbar").isVisible()) {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await page.getByRole("button", { name: "打开其他文件", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "打开其他 PDF", exact: true })).toBeVisible();
    }
    await page.getByLabel("选择本地 PDF", { exact: true }).setInputFiles({
      name: `healthy-after-${fixture.id}.pdf`, mimeType: "application/pdf", buffer: fixturePdf(),
    });
    await expect(page.locator(".pdf-page[data-ready=true]")).toHaveCount(1);
    await expect(page.locator(".pdf-name")).toHaveText(`healthy-after-${fixture.id}.pdf`);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await rpc(library, { type: "annotations.list" })).toEqual(before);
  });
}
