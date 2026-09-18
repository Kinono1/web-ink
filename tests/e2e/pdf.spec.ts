import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fixturePdf } from "../pdf-fixture";
let context: BrowserContext, folder: string, page: Page, id: string;
const rpc = async (message: object) =>
  page.evaluate(async (message) => {
    const r = await chrome.runtime.sendMessage(message);
    if (!r?.ok) throw Error(r?.error);
    return r.data;
  }, message);
test.beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "web-ink-pdf-"));
  const extension = path.join(folder, "extension");
  await cp(path.resolve(".output/chrome-mv3"), extension, { recursive: true });
  const manifest = JSON.parse(
    await readFile(path.join(extension, "manifest.json"), "utf8"),
  );
  manifest.host_permissions = ["https://*/*", "http://*/*"];
  await writeFile(
    path.join(extension, "manifest.json"),
    JSON.stringify(manifest),
  );
  context = await chromium.launchPersistentContext(
    path.join(folder, "profile"),
    {
      channel: "chromium",
      ...(process.env.WEB_INK_TEST_BROWSER_PATH
        ? { executablePath: process.env.WEB_INK_TEST_BROWSER_PATH }
        : {}),
      headless: true,
      // Chrome 125 defaults to old headless, which cannot load extensions.
      // https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing
      args: [
        "--headless=new",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
      viewport: { width: 1280, height: 900 },
    },
  );
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  id = new URL(worker.url()).host;
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/pdf.html`);
});
test.afterEach(async () => {
  await context?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});
async function open(buffer = fixturePdf(), name = "reading.pdf") {
  await expect(page.getByLabel("选择本地 PDF", { exact: true })).toBeEnabled();
  await page
    .getByLabel("选择本地 PDF", { exact: true })
    .setInputFiles({ name, mimeType: "application/pdf", buffer });
  await expect(page.locator(".pdf-name")).toHaveText(name);
  await expect(
    page.locator(".pdf-page[data-ready=true]").first(),
  ).toBeVisible();
}
test("PDF text and area annotations survive reselect, zoom and rotation without storing bytes", async () => {
  await open();
  await page.getByRole("button", { name: "开启标注", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "关闭标注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".textLayer span")
    .first()
    .evaluate((element) => {
      const r = document.createRange();
      r.selectNodeContents(element);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await page.getByRole("button", { name: "高亮 #facc15", exact: true }).click();
  await expect
    .poll(async () => (await rpc({ type: "annotations.list" })).length)
    .toBe(1);
  await expect(page.locator("[data-pdf-annotation]")).toHaveCount(1);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.getByRole("button", { name: "旋转", exact: true }).click();
  await expect(page.locator(".pdf-page[data-ready=true]")).toBeVisible();
  await expect(page.locator("[data-pdf-annotation]")).toHaveCount(1);
  await page.getByRole("button", { name: "区域标注", exact: true }).click();
  const box = await page.locator(".pdf-area-capture").boundingBox();
  await page.mouse.move(box!.x + 70, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 200, box!.y + 190, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await rpc({ type: "annotations.list" })).length)
    .toBe(2);
  const before = await rpc({ type: "annotations.list" });
  await page.reload();
  await open(fixturePdf(), "renamed.pdf");
  await expect(page.locator("[data-pdf-annotation]")).toHaveCount(2);
  expect(
    (await rpc({ type: "annotations.list" })).map((r: any) => r.id).sort(),
  ).toEqual(before.map((r: any) => r.id).sort());
  const backup = await rpc({ type: "backup.export" });
  expect(backup.schemaVersion).toBe(2);
  expect(JSON.stringify(backup)).not.toContain("%PDF");
  expect(
    backup.annotations.every((r: any) => r.target.documentHash.length === 64),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/pdf-reader.png",
    fullPage: true,
  });
});
test("PDF mark removal is explicit and does not return after reselecting the same file", async () => {
  await open();
  await page.getByRole("button", { name: "开启标注", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "关闭标注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".textLayer span")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await page.getByRole("button", { name: "高亮 #facc15", exact: true }).click();
  await expect
    .poll(async () => (await rpc({ type: "annotations.list" })).length)
    .toBe(1);
  await page
    .locator(".textLayer span")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await expect(page.locator(".pdf-selection")).toBeVisible();
  await page
    .locator(".pdf-selection")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  const markBox = await page
    .locator("[data-pdf-annotation]")
    .first()
    .boundingBox();
  await page.mouse.click(
    markBox!.x + markBox!.width / 2,
    markBox!.y + markBox!.height / 2,
  );
  await page
    .locator(".pdf-mark-menu")
    .getByRole("button", { name: "取消标注", exact: true })
    .click();
  await expect
    .poll(async () => (await rpc({ type: "annotations.list" })).length)
    .toBe(0);
  await expect(page.locator("[data-pdf-annotation]")).toHaveCount(0);
  await open(fixturePdf(), "reading.pdf");
  await expect(page.locator("[data-pdf-annotation]")).toHaveCount(0);
});

test("PDF undo restore keeps the deleted annotation fields and revision-safe identity", async () => {
  await open();
  await page.getByRole("button", { name: "开启标注", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "关闭标注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".textLayer span")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await page.getByRole("button", { name: "高亮 #facc15", exact: true }).click();
  await expect
    .poll(
      async () => ((await rpc({ type: "annotations.list" })) as any[]).length,
    )
    .toBe(1);
  const [initial] = (await rpc({ type: "annotations.list" })) as any[];
  await rpc({
    type: "annotations.put",
    annotation: {
      ...initial,
      note: "keep this note",
      tags: ["undo", "PDF"],
      updatedAt: new Date().toISOString(),
    },
    expectedRevision: initial.revision,
  });
  const [beforeDelete] = (await rpc({ type: "annotations.list" })) as any[];
  await expect(
    page.locator(`[data-pdf-annotation="${beforeDelete.id}"]`),
  ).toBeVisible();
  const markBox = await page
    .locator(`[data-pdf-annotation="${beforeDelete.id}"]`)
    .first()
    .boundingBox();
  await page.mouse.click(
    markBox!.x + markBox!.width / 2,
    markBox!.y + markBox!.height / 2,
  );
  await page
    .locator(".pdf-mark-menu")
    .getByRole("button", { name: "取消标注", exact: true })
    .click();
  await expect
    .poll(
      async () => ((await rpc({ type: "annotations.list" })) as any[]).length,
    )
    .toBe(0);
  await page
    .locator(".pdf-undo")
    .getByRole("button", { name: "撤销移除", exact: true })
    .click();
  await expect
    .poll(
      async () => ((await rpc({ type: "annotations.list" })) as any[]).length,
    )
    .toBe(1);
  const [restored] = (await rpc({ type: "annotations.list" })) as any[];
  expect(restored).toMatchObject({
    id: beforeDelete.id,
    color: beforeDelete.color,
    note: "keep this note",
    tags: ["undo", "PDF"],
    target: beforeDelete.target,
  });
  expect(restored.revision).toBeGreaterThan(beforeDelete.revision);
});
test("changed PDF identity leaves previous notes intact and canvas count remains bounded", async () => {
  await open();
  await page.getByRole("button", { name: "开启标注", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "关闭标注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "区域标注", exact: true }).click();
  const area = page.locator(".pdf-area-capture");
  const box = await area.boundingBox();
  await page.mouse.move(box!.x + 40, box!.y + 60);
  await page.mouse.down();
  await page.mouse.move(box!.x + 160, box!.y + 160, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await rpc({ type: "annotations.list" })).length)
    .toBe(1);
  // 40 pages must not allocate 40 canvases or text layers.
  await open(fixturePdf(40), "long-paper.pdf");
  await expect(page.getByLabel("页码", { exact: true })).toHaveAttribute(
    "max",
    "40",
  );
  expect(await page.locator(".pdf-slot").count()).toBeLessThan(10);
  expect(await page.locator(".pdf-page canvas").count()).toBeLessThan(10);
  await page.getByLabel("页码", { exact: true }).fill("35");
  await expect(
    page.locator('[data-page="35"] .pdf-page[data-ready=true]'),
  ).toBeVisible();
  expect(await page.locator(".pdf-page canvas").count()).toBeLessThan(10);
  await page.goto(
    `chrome-extension://${id}/pdf.html?document=${"a".repeat(64)}`,
  );
  await open(fixturePdf(1, "A different document version."));
  await expect(page.getByRole("status")).toContainText("文档版本已变化");
  expect(await page.locator("[data-pdf-annotation]").count()).toBe(0);
  expect((await rpc({ type: "annotations.list" })).length).toBe(1);
});
test("500 and 1000 page mixed-size PDFs jump, zoom, and rotate within the virtual window", async () => {
  const sizes = Array.from({ length: 1000 }, (_, index) =>
    index % 2 ? { width: 792, height: 612 } : { width: 612, height: 792 },
  );
  await open(
    fixturePdf(500, "Long synthetic PDF", { pageSizes: sizes }),
    "500-pages.pdf",
  );
  await page.getByLabel("页码", { exact: true }).fill("250");
  await expect(
    page.locator('[data-page="250"] .pdf-page[data-ready=true]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.getByRole("button", { name: "旋转", exact: true }).click();
  await expect(
    page.locator('[data-page="250"] .pdf-page[data-ready=true]'),
  ).toBeVisible();
  expect(await page.locator(".pdf-slot").count()).toBeLessThan(12);
  await open(
    fixturePdf(1000, "Long synthetic PDF", { pageSizes: sizes }),
    "1000-pages.pdf",
  );
  await page.getByLabel("页码", { exact: true }).fill("1000");
  await expect(
    page.locator('[data-page="1000"] .pdf-page[data-ready=true]'),
  ).toBeVisible();
  expect(await page.locator(".pdf-page canvas").count()).toBeLessThan(12);
});
test("PDF notes load beyond 50 and keep an edited draft when the list reorders", async () => {
  await open();
  await page.getByRole("button", { name: "开启标注", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "关闭标注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".textLayer span")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await page.getByRole("button", { name: "高亮 #facc15", exact: true }).click();
  const [base] = (await rpc({ type: "annotations.list" })) as any[];
  const annotations = Array.from({ length: 55 }, (_, index) => ({
    ...base,
    id: `note-${index}`,
    createdAt: `2026-09-19T00:${String(index).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-09-19T00:${String(index).padStart(2, "0")}:00.000Z`,
    revision: 0,
  }));
  await rpc({
    type: "backup.import",
    backup: {
      format: "web-ink",
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      annotations,
    },
    overwrite: false,
  });
  await expect(page.locator(".pdf-note")).toHaveCount(50);
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.locator(".pdf-note")).toHaveCount(56);
  const note = page.locator(`[data-pdf-note="${base.id}"]`);
  await note.getByRole("button", { name: "编辑", exact: true }).click();
  await note
    .getByRole("textbox", { name: "笔记", exact: true })
    .fill("draft survives reorder");
  const current = ((await rpc({ type: "annotations.list" })) as any[]).find(
    (record) => record.id === base.id,
  );
  await rpc({
    type: "annotations.put",
    annotation: {
      ...current,
      target: { ...current.target, pageNumber: 2 },
      updatedAt: new Date().toISOString(),
    },
    expectedRevision: current.revision,
  });
  await expect(
    note.getByRole("textbox", { name: "笔记", exact: true }),
  ).toHaveValue("draft survives reorder");
  await page
    .getByLabel("选择本地 PDF", { exact: true })
    .setInputFiles({
      name: "blocked.pdf",
      mimeType: "application/pdf",
      buffer: fixturePdf(1, "blocked"),
    });
  await expect(page.getByRole("alert")).toContainText("笔记草稿");
  await page.getByRole("button", { name: "放弃笔记草稿", exact: true }).click();
  await page
    .getByLabel("选择本地 PDF", { exact: true })
    .setInputFiles({
      name: "next.pdf",
      mimeType: "application/pdf",
      buffer: fixturePdf(1, "next"),
    });
  await expect(page.locator(".pdf-name")).toHaveText("next.pdf");
});

test("rapid A/B/C file selection leaves only the final PDF session visible", async () => {
  const input = page.getByLabel("选择本地 PDF", { exact: true });
  await input.setInputFiles({
    name: "A.pdf",
    mimeType: "application/pdf",
    buffer: fixturePdf(1, "A only"),
  });
  await input.setInputFiles({
    name: "B.pdf",
    mimeType: "application/pdf",
    buffer: fixturePdf(1, "B only"),
  });
  await input.setInputFiles({
    name: "C.pdf",
    mimeType: "application/pdf",
    buffer: fixturePdf(1, "C only"),
  });
  await expect(page.locator(".pdf-name")).toHaveText("C.pdf");
  await expect(page.locator(".textLayer")).toContainText("C only");
  await expect(page.locator(".textLayer")).not.toContainText("A only");
  await expect(page.locator(".textLayer")).not.toContainText("B only");
});
test("online public PDF uses authorized reader fetch and rejects HTML", async () => {
  await page.route("https://papers.example.test/paper.pdf", (route) =>
    route.fulfill({ contentType: "application/pdf", body: fixturePdf() }),
  );
  await page
    .getByLabel("公开 PDF 网址")
    .fill("https://papers.example.test/paper.pdf");
  await page.getByRole("button", { name: "打开网址", exact: true }).click();
  await expect(page.locator(".pdf-page[data-ready=true]")).toBeVisible();
  await page.route("https://papers.example.test/login", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html>Sign in</html>" }),
  );
  await page
    .getByLabel("公开 PDF 网址")
    .fill("https://papers.example.test/login");
  await page.getByRole("button", { name: "打开网址", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("不是有效 PDF");
});

test("Chinese multicolumn text uses packaged CMaps and remains separate from area marks", async () => {
  await open(fixturePdf(1, "中文论文：阅读、标注与回顾"), "chinese-paper.pdf");
  await expect(page.locator(".textLayer")).toContainText("中文论文");
  await expect(page.locator(".textLayer")).toContainText("右栏独立的研究结果");
  await page.getByRole("button", { name: "开启标注", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "关闭标注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".textLayer span")
    .filter({ hasText: "右栏独立的研究结果" })
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await page.getByRole("button", { name: "高亮 #facc15", exact: true }).click();
  await expect
    .poll(async () => (await rpc({ type: "annotations.list" })).length)
    .toBe(1);
  const [record] = await rpc({ type: "annotations.list" });
  expect(record.target.exact).toBe("右栏独立的研究结果");
  await expect(page.locator(".pdf-note")).toHaveCount(1);
  await page.screenshot({
    path: "test-results/pdf-chinese.png",
    fullPage: true,
  });
});
