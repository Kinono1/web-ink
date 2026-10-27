import { test, expect, rpc } from "./fixtures/extension";
import type { Annotation, AnnotationPage } from "../../src/core/model";

// Both editors and persistence are real; no simulated runtime write races.
test("two library tabs retain a stale draft, reject its revision, and explicitly resolve the conflict", async ({ extension }) => {
  const { context, library: first, id } = extension;
  const record: Annotation = {
    id: "concurrent-note", kind: "text", pageUrl: "https://example.test/article", pageTitle: "Shared article",
    color: "#facd5a", note: "Original note", tags: ["concurrency"], revision: 1,
    createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z",
    target: { rootSelector: "body", exact: "Shared annotation", prefix: "", suffix: "", start: 0, end: 17 },
  };
  await rpc(first, { type: "backup.import", backup: { format: "web-ink", schemaVersion: 1,
    exportedAt: record.createdAt, annotations: [record] }, overwrite: false });
  const second = await context.newPage();
  await second.goto(`chrome-extension://${id}/library.html`);
  for (const page of [first, second]) {
    await page.getByRole("textbox", { name: "搜索文字、笔记、网址或标签" }).fill("Shared annotation");
    await page.locator(".annotation-row").click();
    await page.locator(".annotation-detail").getByRole("button", { name: "笔记", exact: true }).click();
  }
  const a = first.locator(".annotation-detail"), b = second.locator(".annotation-detail");
  await a.getByRole("textbox", { name: "笔记", exact: true }).fill("First tab confirmed write");
  await b.getByRole("textbox", { name: "笔记", exact: true }).fill("Second tab unsaved draft");
  await a.getByRole("button", { name: "保存", exact: true }).click();
  await expect(a.locator(".note")).toHaveText("First tab confirmed write");
  await b.getByRole("button", { name: "保存", exact: true }).click();
  await expect(second.getByRole("alert")).toContainText("草稿仍已保留");
  await expect(b.getByRole("textbox", { name: "笔记", exact: true })).toHaveValue("Second tab unsaved draft");
  const [saved] = await rpc<Annotation[]>(first, { type: "annotations.list" });
  expect(saved?.note).toBe("First tab confirmed write");
  expect(saved?.revision).toBe(2);
  if (!saved) throw new Error("Expected the first tab’s saved annotation");
  const newerRecords: Annotation[] = Array.from({ length: 51 }, (_, index) => ({
    ...record,
    id: `newer-note-${index}`,
    pageTitle: "Other article",
    note: "Other note",
    tags: [],
    updatedAt: "2099-01-01T00:00:00.000Z",
    target: { ...record.target, exact: "Other annotation", end: 16 },
  }));
  await rpc(first, { type: "backup.import", backup: { format: "web-ink", schemaVersion: 1,
    exportedAt: record.createdAt, annotations: newerRecords }, overwrite: false });
  const allRecords = await rpc<Annotation[]>(first, { type: "annotations.list" });
  expect(allRecords.filter(item => item.id !== record.id && item.updatedAt > saved.updatedAt)).toHaveLength(51);
  const firstPage = await rpc<AnnotationPage>(first, { type: "annotations.query", query: { limit: 50 } });
  expect(firstPage.items).toHaveLength(50);
  expect(firstPage.nextCursor).toBeDefined();
  expect(firstPage.items.every(item => item.updatedAt > saved.updatedAt)).toBe(true);
  expect(firstPage.items.some(item => item.id === record.id)).toBe(false);
  await expect(b.getByRole("button", { name: "载入最新版本", exact: true })).toBeVisible();
  await b.getByRole("button", { name: "载入最新版本", exact: true }).click();
  await expect(b.getByRole("button", { name: "载入最新版本", exact: true })).toHaveCount(0);
  await expect(second.getByText("标注已被删除。", { exact: true })).toHaveCount(0);
  await expect(b.getByRole("textbox", { name: "笔记", exact: true })).toHaveValue("Second tab unsaved draft");
  await b.getByRole("button", { name: "保存", exact: true }).click();
  await expect(b.locator(".note")).toHaveText("Second tab unsaved draft");
  await expect(a.locator(".note")).toHaveText("Second tab unsaved draft");
  const resolved = await rpc<Annotation>(second, { type: "annotations.get", id: record.id });
  expect(resolved?.revision).toBe(3);
  expect(resolved?.id).toBe(record.id);
  await second.reload();
  await second.getByRole("textbox", { name: "搜索文字、笔记、网址或标签" }).fill("Shared annotation");
  await second.locator(".annotation-row").filter({ hasText: "Shared annotation" }).click();
  await expect(second.locator(".annotation-detail .note")).toHaveText("Second tab unsaved draft");
});
