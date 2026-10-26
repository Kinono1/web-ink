import { test, expect, rpc } from "./fixtures/extension";
import type { Annotation } from "../../src/core/model";

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
  await b.getByRole("button", { name: "载入最新版本", exact: true }).click();
  await expect(b.getByRole("textbox", { name: "笔记", exact: true })).toHaveValue("Second tab unsaved draft");
  await b.getByRole("button", { name: "保存", exact: true }).click();
  await expect(b.locator(".note")).toHaveText("Second tab unsaved draft");
  await expect(a.locator(".note")).toHaveText("Second tab unsaved draft");
  const [resolved] = await rpc<Annotation[]>(second, { type: "annotations.list" });
  expect(resolved?.revision).toBe(3);
  expect(resolved?.id).toBe(record.id);
  await second.reload();
  await second.locator(".annotation-row").click();
  await expect(second.locator(".annotation-detail .note")).toHaveText("Second tab unsaved draft");
});
