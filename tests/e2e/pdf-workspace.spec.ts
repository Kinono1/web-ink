import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixturePdf } from "../pdf-fixture";
import type { Annotation, PdfTabContext, PdfOpenResult, PdfHandoff, RuntimeHealth, Settings } from "../../src/core/model";
import type { PdfReadingPosition } from "../../src/pdf/reading-position";

const source = "https://papers.example.test/current.pdf";
const wrapper = "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=987654321";
let context: BrowserContext;
let control: Page;
let folder: string;
let id: string;
let buildInfo: Pick<RuntimeHealth, "version" | "commit" | "dirty">;
let observations: object[];

async function rawRpc(page: Page, message: object) {
  return page.evaluate((message) => chrome.runtime.sendMessage(message), message);
}
async function rpc<T>(page: Page, message: object): Promise<T> {
  const response = await rawRpc(page, message);
  if (!response?.ok) throw new Error(response?.error ?? "No extension response");
  return response.data;
}
async function activeTab(page: Page) {
  const ownTabId = await page.evaluate(async () =>
    location.protocol === "chrome-extension:"
      ? (await chrome.tabs.getCurrent())?.id
      : undefined,
  );
  return control.evaluate(async ({ ownTabId, url }) => {
    const tab = ownTabId === undefined
      ? (await chrome.tabs.query({})).find((item) => item.url === url)
      : { id: ownTabId };
    if (tab?.id === undefined) throw new Error(`Synthetic fixture tab missing: ${url}`);
    await chrome.tabs.update(tab.id, { active: true });
    return tab.id;
  }, { ownTabId, url: page.url() });
}
async function htmlPage(url: string, body: string) {
  await context.route(url, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><title>Synthetic PDF context</title><main>${body}</main>`,
  }));
  const page = await context.newPage();
  await page.goto(url);
  return page;
}
async function publicPdfOriginal(url = source, bytes = fixturePdf()) {
  await context.route(url, (route) => route.fulfill(
    route.request().resourceType() === "document"
      ? { contentType: "text/html", body: "<title>Synthetic PDF source</title><p>Controlled viewer placeholder.</p>" }
      : { contentType: "application/pdf", body: bytes },
  ));
  const original = await context.newPage();
  await original.goto(url);
  return { original, tabId: await activeTab(original) };
}
async function openCurrent(url = source, bytes = fixturePdf()) {
  const { original, tabId } = await publicPdfOriginal(url, bytes);
  const result = await rpc<PdfOpenResult>(control, {
    type: "pdf.openCurrent", tabId, expectedUrl: url,
  });
  await expect(original).toHaveURL(result.readerUrl);
  await expect(original.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
  // The extension page below is a synthetic sidepanel surface. Make the reader
  // the real active tab so ManagementApp observes its current-PDF context.
  await activeTab(original);
  return { reader: original, tabId, result };
}
async function readerPage(query = "") {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/pdf.html${query}`);
  return page;
}
async function openLocal(reader: Page, bytes = fixturePdf(), name = "reading.pdf") {
  if (await reader.locator(".pdf-toolbar").isVisible()) {
    await moreAction(reader, "打开其他文件");
    await expect(reader.getByRole("dialog", { name: "打开其他 PDF", exact: true })).toBeVisible();
  }
  await reader.getByLabel("选择本地 PDF", { exact: true }).setInputFiles({
    name, mimeType: "application/pdf", buffer: bytes,
  });
  await expect(reader.locator(".pdf-name")).toHaveText(name);
  await expect(reader.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
  await activeTab(reader);
}
async function selectText(reader: Page) {
  await reader.locator(".textLayer span").first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}
async function highlight(reader: Page) {
  await selectText(reader);
  await reader.getByRole("button", { name: "高亮 #facc15", exact: true }).click();
  await expect.poll(async () => (await rpc<Annotation[]>(control, { type: "annotations.list" })).length).toBe(1);
  return (await rpc<Annotation[]>(control, { type: "annotations.list" }))[0]!;
}
async function editNote(reader: Page, record: Annotation, draft: string) {
  await openPdfSidebar(reader);
  const note = control.locator(`[data-pdf-note="${record.id}"]`);
  await note.getByRole("button", { name: "编辑", exact: true }).click();
  const input = note.getByRole("textbox", { name: "笔记", exact: true });
  await input.fill(draft);
  return input;
}
async function openPdfSidebar(reader: Page) {
  await activeTab(reader);
  await reader.locator(".pdf-toolbar").getByRole("button", { name: "笔记", exact: true }).click();
  await activeTab(reader);
  await expect(control.locator(".pdf-sidebar")).toBeVisible();
  await expect(reader.locator(".pdf-notes")).toBeHidden();
  await expect(reader.locator(".pdf-workspace")).not.toHaveClass(/notes-open/);
}
async function moreAction(reader: Page, name: string) {
  await reader.locator(".pdf-toolbar").getByRole("button", { name: "更多", exact: true }).click();
  await reader.locator(".pdf-more-menu").getByRole("button", { name, exact: true }).click();
}
async function viewAction(reader: Page, name: "旋转页面" | "适合宽度") {
  const toolbarAction = reader.locator(".pdf-toolbar").getByRole("button", { name, exact: true });
  if (await toolbarAction.isVisible()) await toolbarAction.click();
  else await moreAction(reader, name);
}
async function expectToolbarBounds(reader: Page, viewportWidth: number) {
  const toolbar = reader.locator(".pdf-toolbar");
  const more = toolbar.getByRole("button", { name: "更多", exact: true });
  const { scrollWidth, clientWidth } = await toolbar.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  const box = await more.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
}
async function readingPosition(hash: string): Promise<PdfReadingPosition | undefined> {
  const value = await control.evaluate(async (hash) =>
    (await chrome.storage.local.get(`ui.pdfReadingPosition.${hash}`))[`ui.pdfReadingPosition.${hash}`],
  hash);
  return value as PdfReadingPosition | undefined;
}

test.beforeEach(async ({}, info) => {
  observations = [];
  folder = await mkdtemp(path.join(tmpdir(), "web-ink-pdf-workspace-"));
  const extension = path.join(folder, "extension");
  const build = path.resolve(process.env.WEB_INK_BUILD || ".build-output/chrome-mv3");
  await cp(build, extension, { recursive: true });
  buildInfo = JSON.parse(await readFile(path.join(build, "build-info.json"), "utf8"));
  if (!info.title.startsWith("production permission")) {
    // Host consent remains a separate native check. Only the temporary manifest
    // grants synthetic-route access; source manifests and personal profiles stay untouched.
    const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
    manifest.host_permissions = ["https://*/*", "http://*/*"];
    await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
  }
  context = await chromium.launchPersistentContext(path.join(folder, "profile"), {
    channel: "chromium",
    headless: true,
    ...(process.env.WEB_INK_TEST_BROWSER_PATH
      ? { executablePath: process.env.WEB_INK_TEST_BROWSER_PATH }
      : {}),
    args: ["--headless=new", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1280, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  id = new URL(worker.url()).host;
  expect(id).toBe("cmllmmnfiefikhcbelokclankodgcdog");
  // Every public HTTP(S) route is explicitly fulfilled below. Unexpected network
  // requests are refused, including the synthetic IEEE-host classifier fixture.
  await context.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
  control = await context.newPage();
  await control.goto(`chrome-extension://${id}/sidepanel.html`);
  if (!info.title.startsWith("production permission"))
    await rpc(control, { type: "permissions.enable" });
});
test.afterEach(async ({}, info) => {
  const receipt = info.outputPath("pdf-workspace-observations.json");
  await writeFile(receipt, JSON.stringify({
    build: buildInfo,
    browser: context?.browser()?.version(),
    permissionEvidence: info.title.startsWith("production permission") ? "production manifest; no native grant" : "pre-granted disposable manifest",
    sourceEvidence: "synthetic intercepted responses; not actual IEEE/Scholar content",
    surfaceEvidence: "sidepanel.html is a synthetic extension page for headless tests, not a native Chrome side panel",
    observations,
  }, null, 2));
  await info.attach("pdf-workspace-observations", { path: receipt, contentType: "application/json" });
  await context?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

test("current PDF API preserves the tab through single-flight same-tab opening and return", async () => {
  const { original, tabId } = await publicPdfOriginal();
  const before = context.pages().length;
  const response = await rawRpc(control, { type: "pdf.context.get", tabId, expectedUrl: source });
  observations.push({ boundary: "pdf.context.get", response });
  expect(response?.ok, "The candidate must expose the approved current-PDF context API").toBe(true);
  const detected = response.data as PdfTabContext;
  expect(detected).toMatchObject({ tabId, url: source, kind: "direct", currentReader: false });
  expect(detected.candidates).toEqual([{ url: source, via: "url" }]);
  const health = await rpc<RuntimeHealth>(control, { type: "runtime.health" });
  expect(health).toMatchObject({ version: buildInfo.version, commit: buildInfo.commit, dirty: buildInfo.dirty });
  expect(health.generation).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  observations.push({ boundary: "runtime.health", health });
  const [opened, duplicate] = await Promise.all([
    rpc<PdfOpenResult>(control, { type: "pdf.openCurrent", tabId, expectedUrl: source }),
    rpc<PdfOpenResult>(control, { type: "pdf.openCurrent", tabId, expectedUrl: source }),
  ]);
  expect(opened).toMatchObject({ tabId, navigation: "same-tab", sourceUrl: source });
  expect(duplicate.readerUrl).toBe(opened.readerUrl);
  expect(duplicate.token).toBe(opened.token);
  const readerUrl = new URL(opened.readerUrl);
  expect(readerUrl.searchParams.get("handoff")).toBe(opened.token);
  expect(readerUrl.searchParams.get("source")).toBe(source);
  await expect(original).toHaveURL(opened.readerUrl);
  await expect(original.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
  expect(context.pages().length).toBe(before);
  const ownContext = await rpc<PdfTabContext>(control, { type: "pdf.context.get", tabId, expectedUrl: original.url() });
  expect(ownContext).toMatchObject({ tabId, currentReader: true, handoffToken: opened.token });
  const returned = await rpc(original, { type: "pdf.returnOriginal", token: opened.token });
  expect(returned).toEqual({ tabId, url: source });
  await expect(original).toHaveURL(source);
  expect(await activeTab(original)).toBe(tabId);
  expect(context.pages().length).toBe(before);
  observations.push({ tabId, before, after: context.pages().length, opened, returned });
});

test("handoff tokens cannot navigate another reader and expired sessions keep public-source recovery", async () => {
  const { reader, result } = await openCurrent();
  const other = await readerPage(`?handoff=${result.token}&source=${encodeURIComponent(source)}`);
  const originalUrl = reader.url();
  const otherUrl = other.url();
  const rejected = await rawRpc(other, { type: "pdf.returnOriginal", token: result.token });
  expect(rejected?.ok).toBe(false);
  await expect(reader).toHaveURL(originalUrl);
  await expect(other).toHaveURL(otherUrl);
  const session = await rpc<PdfHandoff | null>(reader, { type: "pdf.handoff.get", token: result.token });
  expect(session?.token).toBe(result.token);
  const removed = await control.evaluate(async (token) => {
    const values = await chrome.storage.session.get(null);
    const keys = Object.keys(values).filter((key) => key.includes(token!) || JSON.stringify(values[key]).includes(token!));
    if (!keys.length) throw new Error("The synthetic handoff was not found in session storage");
    await chrome.storage.session.remove(keys);
    return keys;
  }, result.token);
  expect(await rpc(reader, { type: "pdf.handoff.get", token: result.token })).toBeNull();
  const expired = await rawRpc(reader, { type: "pdf.returnOriginal", token: result.token });
  expect(expired?.ok).toBe(false);
  await reader.reload();
  await expect(reader.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
  expect(new URL(reader.url()).searchParams.get("source")).toBe(source);
  const back = reader.getByRole("button", { name: "返回原阅读器", exact: true });
  if (await back.count()) await expect(back).toBeDisabled();
  expect(new URL(reader.url()).searchParams.has("returnUrl")).toBe(false);
  observations.push({ rejected, expired, removed });
});

test("ordinary HTML PDF anchors remain normal links and never become source candidates", async () => {
  const url = "https://article.example.test/reading";
  const original = await htmlPage(url, `<a id="ordinary" href="#ending">普通阅读链接</a><a href="${source}">PDF citation</a><p id="ending">End</p>`);
  const tabId = await activeTab(original);
  const detected = await rpc<PdfTabContext>(control, { type: "pdf.context.get", tabId, expectedUrl: url });
  expect(detected).toMatchObject({ kind: "unavailable", candidates: [], currentReader: false });
  await original.locator("#ordinary").click();
  await expect(original).toHaveURL(`${url}#ending`);
  expect(new URL(original.url()).protocol).toBe("https:");
});

test("synthetic IEEE wrapper exposes visible PDF choices and does not guess an absent source", async () => {
  const first = "https://papers.example.test/visible-a.pdf";
  const second = "https://papers.example.test/visible-b.pdf";
  for (const url of [first, second])
    await context.route(url, (route) => route.fulfill({ contentType: "application/pdf", body: fixturePdf() }));
  const original = await htmlPage(wrapper, `<h1>Synthetic IEEE wrapper</h1><iframe src="${first}" title="Visible paper"></iframe><object data="${second}" type="application/pdf" width="300" height="200"></object><a href="https://papers.example.test/unshown.pdf">Ordinary download link</a>`);
  const tabId = await activeTab(original);
  const detected = await rpc<PdfTabContext>(control, { type: "pdf.context.get", tabId, expectedUrl: wrapper });
  expect(detected.kind).toBe("wrapper");
  expect(detected.candidates.map((candidate) => candidate.url).sort()).toEqual([first, second]);
  const unchosen = await rawRpc(control, { type: "pdf.openCurrent", tabId, expectedUrl: wrapper });
  expect(unchosen).toMatchObject({ ok: false, code: "PDF_CHOICE_REQUIRED" });
  await expect(original).toHaveURL(wrapper);
  const opened = await rpc<PdfOpenResult>(control, { type: "pdf.openCurrent", tabId, expectedUrl: wrapper, candidateUrl: second });
  expect(opened.sourceUrl).toBe(second);
  await expect(original).toHaveURL(opened.readerUrl);
  const missingUrl = `${wrapper}&unavailable=1`;
  const missing = await htmlPage(missingUrl, "<h1>Synthetic wrapper without a displayed PDF source</h1>");
  const missingId = await activeTab(missing);
  const unavailable = await rpc<PdfTabContext>(control, { type: "pdf.context.get", tabId: missingId, expectedUrl: missing.url() });
  expect(unavailable.candidates).toEqual([]);
  expect(unavailable.kind).toBe("wrapper");
  const fallback = await rpc<PdfOpenResult>(control, { type: "pdf.openCurrent", tabId: missingId, expectedUrl: missing.url() });
  expect(fallback).toMatchObject({ tabId: missingId, navigation: "same-tab" });
  await expect(missing).toHaveURL(fallback.readerUrl);
  expect(new URL(fallback.readerUrl).searchParams.has("source")).toBe(false);
  expect(new URL(fallback.readerUrl).searchParams.get("handoff")).toBe(fallback.token);
  await expect(missing.getByLabel("选择本地 PDF", { exact: true })).toBeEnabled();
  await missing.getByRole("button", { name: "返回原阅读器", exact: true }).click();
  await expect(missing).toHaveURL(missingUrl);
  observations.push({ detected, unchosen, opened, fallback });
});

test("actual Chrome PDF viewer context opens the intercepted public PDF in the same tab", async () => {
  await context.route(source, (route) => route.fulfill({ contentType: "application/pdf", body: fixturePdf() }));
  const original = await context.newPage();
  const response = await original.goto(source);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toBe("application/pdf");
  const viewer = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
  // Chrome 125 renders the native viewer through a generated PDF embed without
  // exposing its extension frame to Playwright. Inspect only the outer wrapper.
  await expect.poll(async () =>
    original.frames().some((frame) => frame.url().startsWith(viewer)) ||
    await original.locator('body > embed[type="application/pdf"][internalid][src="about:blank"]').count() === 1,
  ).toBe(true);
  const tabId = await activeTab(original);
  const detected = await rpc<PdfTabContext>(control, { type: "pdf.context.get", tabId, expectedUrl: source });
  expect(detected).toMatchObject({ kind: "direct", currentReader: false });
  const before = context.pages().length;
  const opened = await rpc<PdfOpenResult>(control, { type: "pdf.openCurrent", tabId, expectedUrl: source });
  expect(opened).toMatchObject({ navigation: "same-tab", tabId, sourceUrl: source });
  await expect(original).toHaveURL(opened.readerUrl);
  await expect(original.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
  expect(context.pages().length).toBe(before);
  await original.getByRole("button", { name: "返回原阅读器", exact: true }).click();
  await expect(original).toHaveURL(source);
  expect(await activeTab(original)).toBe(tabId);
  expect(context.pages().length).toBe(before);
  observations.push({ sourceEvidence: "intercepted bytes rendered by Chrome's real PDF viewer", detected, opened });
});

test("selection and copy events create no record and color selection works immediately", async () => {
  const reader = await readerPage();
  await openLocal(reader);
  await expect(reader.getByRole("button", { name: /^(开启标注|关闭标注)$/ })).toHaveCount(0);
  await expect(reader.locator(".pdf-notes")).toBeHidden();
  await expect(reader.locator(".pdf-workspace")).not.toHaveClass(/notes-open/);
  await selectText(reader);
  await reader.evaluate(() => document.dispatchEvent(new ClipboardEvent("copy", { bubbles: true })));
  expect(await rpc(control, { type: "annotations.list" })).toEqual([]);
  await reader.getByRole("button", { name: "高亮 #facc15", exact: true }).click();
  await expect.poll(async () => (await rpc<Annotation[]>(control, { type: "annotations.list" })).length).toBe(1);
  const [record] = await rpc<Annotation[]>(control, { type: "annotations.list" });
  expect(record).toMatchObject({ kind: "pdf-text", color: "#facc15", target: { exact: "Web Ink PDF highlights survive a return visit.", pageNumber: 1 } });
  await expect.poll(() => reader.evaluate(() => getSelection()?.toString())).toBe("");
});

test("abandoned readers retain one return session per tab and closing reclaims it", async () => {
  const { reader, tabId } = await openCurrent();
  const sessions = () => control.evaluate(async (tabId) => Object.entries(await chrome.storage.session.get(null))
    .filter(([key, value]) => key.startsWith("pdf.handoff.") && (value as PdfHandoff).tabId === tabId),
  tabId);
  for (let index = 0; index < 3; index++) {
    await reader.goto(source);
    const opened = await rpc<PdfOpenResult>(control, { type: "pdf.openCurrent", tabId, expectedUrl: source });
    await expect(reader).toHaveURL(opened.readerUrl);
    await expect(reader.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
    expect(await sessions()).toHaveLength(1);
  }
  await reader.close();
  await expect.poll(sessions).toEqual([]);
});

test("adding a note opens a ready synthetic sidepanel editor after a deliberate text selection", async () => {
  const reader = await readerPage();
  await openLocal(reader);
  await selectText(reader);
  await reader.getByRole("button", { name: "添加笔记", exact: true }).click();
  await activeTab(reader);
  await expect.poll(async () => (await rpc<Annotation[]>(control, { type: "annotations.list" })).length).toBe(1);
  await expect(control.locator(".pdf-sidebar")).toBeVisible();
  await expect(reader.locator(".pdf-notes")).toBeHidden();
  await expect(reader.locator(".pdf-workspace")).not.toHaveClass(/notes-open/);
  const editor = control.locator(".pdf-note").getByRole("textbox", { name: "笔记", exact: true });
  // This surface is a background extension tab, not the native side panel.
  // Keep the reader active for context routing; test native focus separately.
  await expect(editor).toBeVisible();
  await expect(editor).toBeEnabled();
  expect(await reader.evaluate(async () => (await chrome.tabs.getCurrent())?.active)).toBe(true);
  await editor.fill("Synthetic note draft");
  expect((await rpc<Annotation[]>(control, { type: "annotations.list" }))[0]?.note).toBe("");
});

test("a note draft can stay in the reader or save before returning to the original tab", async () => {
  const { reader, tabId } = await openCurrent();
  const record = await highlight(reader);
  const input = await editNote(reader, record, "Save this deliberate note before returning");
  const readerUrl = reader.url();
  await reader.getByRole("button", { name: "返回原阅读器", exact: true }).click();
  const guard = reader.getByRole("dialog", { name: "未保存的内容", exact: true });
  await guard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(reader).toHaveURL(readerUrl);
  await expect(input).toHaveValue("Save this deliberate note before returning");
  await reader.getByRole("button", { name: "返回原阅读器", exact: true }).click();
  await guard.getByRole("button", { name: "保存并继续", exact: true }).click();
  await expect(reader).toHaveURL(source);
  expect(await activeTab(reader)).toBe(tabId);
  expect((await rpc<Annotation[]>(control, { type: "annotations.list" }))[0]?.note).toBe("Save this deliberate note before returning");
});

test("a revision-conflict save keeps the draft and discard returns without overwriting newer data", async () => {
  const { reader } = await openCurrent();
  const record = await highlight(reader);
  const input = await editNote(reader, record, "Keep my unresolved draft");
  await rpc(control, { type: "annotations.put", annotation: { ...record, note: "Newer saved value" }, expectedRevision: record.revision });
  const readerUrl = reader.url();
  await reader.getByRole("button", { name: "返回原阅读器", exact: true }).click();
  const guard = reader.getByRole("dialog", { name: "未保存的内容", exact: true });
  await guard.getByRole("button", { name: "保存并继续", exact: true }).click();
  await expect(reader.getByRole("alert").first()).toBeVisible();
  await expect(reader).toHaveURL(readerUrl);
  await expect(input).toHaveValue("Keep my unresolved draft");
  expect((await rpc<Annotation[]>(control, { type: "annotations.list" }))[0]?.note).toBe("Newer saved value");
  await guard.getByRole("button", { name: "放弃并继续", exact: true }).click();
  await expect(reader).toHaveURL(source);
  expect((await rpc<Annotation[]>(control, { type: "annotations.list" }))[0]?.note).toBe("Newer saved value");
});

test("synthetic sidepanel restores saved notes and focuses the same reader tab without inline notes", async () => {
  const bytes = fixturePdf(3, "Sidebar record focus fixture");
  const reader = await readerPage();
  await openLocal(reader, bytes, "sidebar-focus.pdf");
  await reader.getByLabel("页码", { exact: true }).fill("2");
  await expect(reader.locator('[data-page="2"] .pdf-page[data-ready=true]')).toBeVisible();
  await reader.locator('[data-page="2"] .textLayer span').first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await reader.getByRole("button", { name: "高亮 #facc15", exact: true }).click();
  await expect.poll(async () => (await rpc<Annotation[]>(control, { type: "annotations.list" })).length).toBe(1);
  const record = (await rpc<Annotation[]>(control, { type: "annotations.list" }))[0]!;
  expect(record.target).toMatchObject({ pageNumber: 2 });
  await openPdfSidebar(reader);
  const beforePanels = context.pages().filter((item) => item.url() === `chrome-extension://${id}/sidepanel.html`);
  expect(beforePanels).toHaveLength(1);
  const note = control.locator(`[data-pdf-note="${record.id}"]`);
  await note.getByRole("button", { name: "编辑", exact: true }).click();
  await note.getByRole("textbox", { name: "笔记", exact: true }).fill("Saved sidebar note");
  await note.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(async () => (await rpc<Annotation[]>(control, { type: "annotations.list" }))[0]?.note).toBe("Saved sidebar note");
  await reader.getByLabel("页码", { exact: true }).fill("1");
  await note.locator(".pdf-note-source").click();
  await expect(reader.getByLabel("页码", { exact: true })).toHaveValue("2");
  expect(await activeTab(reader)).toBeGreaterThanOrEqual(0);
  await reader.reload();
  await openLocal(reader, bytes, "sidebar-focus-restored.pdf");
  await expect(control.locator(`[data-pdf-note="${record.id}"]`)).toContainText("Saved sidebar note");
  await expect(reader.locator(".pdf-notes")).toBeHidden();
  await expect(reader.locator(".pdf-workspace")).not.toHaveClass(/notes-open/);
  expect(context.pages().filter((item) => item.url() === `chrome-extension://${id}/sidepanel.html`)).toHaveLength(1);
});

test("mixed-page bookmarks restore after local reselect and explicit pages beat stored positions", async () => {
  const bytes = fixturePdf(12, "Bookmark fixture", {
    pageSizes: Array.from({ length: 12 }, (_, index) => index % 2 ? { width: 792, height: 612 } : { width: 612, height: 792 }),
  });
  const hash = createHash("sha256").update(bytes).digest("hex");
  const reader = await readerPage();
  await openLocal(reader, bytes, "mixed-pages.pdf");
  await reader.getByLabel("页码", { exact: true }).fill("7");
  await reader.getByRole("button", { name: "放大", exact: true }).click();
  await viewAction(reader, "旋转页面");
  await expect(reader.locator('[data-page="7"] .pdf-page[data-ready=true]')).toBeVisible();
  await reader.locator(".pdf-pages").evaluate((element) => {
    const slot = element.querySelector<HTMLElement>('[data-page="7"]')!;
    const page = slot.getBoundingClientRect();
    const viewport = element.getBoundingClientRect();
    element.scrollTop += page.top - viewport.top + page.height * 0.3;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => readingPosition(hash)).toMatchObject({ version: 1, pageNumber: 7, zoom: 1.25, rotation: 90 });
  const saved = (await readingPosition(hash))!;
  expect(saved.pageOffsetRatio).toBeGreaterThan(0.2);
  expect(saved.pageOffsetRatio).toBeLessThan(0.4);
  await reader.reload();
  await expect(reader.locator(".pdf-page canvas")).toHaveCount(0);
  await openLocal(reader, bytes, "same-bytes-renamed.pdf");
  await expect(reader.getByLabel("页码", { exact: true })).toHaveValue("7");
  await expect(reader.getByLabel("缩放比例", { exact: true })).toHaveValue("125%");
  await expect(reader.locator('[data-page="7"] .pdf-page[data-ready=true]')).toBeVisible();
  await expect.poll(async () => {
    const box = await reader.locator('[data-page="7"]').boundingBox();
    return box && { width: box.width, height: box.height };
  }).toEqual({ width: 990, height: 765 });
  await expect.poll(() => reader.locator(".pdf-pages").evaluate((element) => {
    const page = element.querySelector('[data-page="7"]')!.getBoundingClientRect();
    return (element.getBoundingClientRect().top - page.top) / page.height;
  })).toBeCloseTo(saved.pageOffsetRatio, 2);
  await expect.poll(() => readingPosition(hash)).toMatchObject({ pageNumber: 7, zoom: 1.25, rotation: 90 });
  await context.route(source, (route) => route.fulfill({ contentType: "application/pdf", body: bytes }));
  await reader.goto(`chrome-extension://${id}/pdf.html?open=1&source=${encodeURIComponent(source)}&page=3`);
  await expect(reader.getByLabel("页码", { exact: true })).toHaveValue("3");
  await reader.goto(`chrome-extension://${id}/pdf.html`);
  await openLocal(reader, fixturePdf(1, "Different exact bytes"), "different.pdf");
  await expect(reader.getByLabel("页码", { exact: true })).toHaveValue("1");
  await expect(reader.getByLabel("缩放比例", { exact: true })).toHaveValue("100%");
  expect((await readingPosition(hash))?.rotation).toBe(90);
  expect(JSON.stringify(await rpc(control, { type: "backup.export" }))).not.toContain("ui.pdfReadingPosition");
  observations.push({ hash, saved });
});

test("Chinese PDF search scans packaged CMaps text and marks the current result", async () => {
  const reader = await readerPage();
  await openLocal(reader, fixturePdf(1, "中文论文：阅读、标注与回顾"), "chinese-search.pdf");
  await reader.keyboard.press("Control+f");
  const find = reader.getByRole("search", { name: "PDF 文内搜索", exact: true });
  await expect(find).toBeVisible();
  await find.getByRole("textbox", { name: "搜索 PDF 文字", exact: true }).fill("右栏独立的研究结果");
  await expect(find.getByRole("status")).toHaveText("1 / 1");
  await expect(reader.locator(".pdf-search-match")).toHaveCount(1);
  await expect(reader.getByLabel("页码", { exact: true })).toHaveValue("1");
});

for (const failure of ["login", "redirect"] as const) {
  test(`a ${failure} response leaves explicit local-file recovery available`, async () => {
    const url = `https://papers.example.test/${failure}.pdf`;
    let escapedRequests = 0;
    await context.route("https://papers.example.test/redirect-target.pdf", (route) => { escapedRequests++; return route.abort("blockedbyclient"); });
    await context.route(url, (route) => route.fulfill(failure === "login"
      ? { contentType: "text/html", body: "<h1>Synthetic login required</h1>" }
      : { status: 302, headers: { location: "https://papers.example.test/redirect-target.pdf" } },
    ));
    const reader = await readerPage(`?open=1&source=${encodeURIComponent(url)}`);
    await expect(reader.getByRole("alert").first()).toBeVisible();
    await expect(reader.getByLabel("选择本地 PDF", { exact: true })).toBeEnabled();
    await expect(reader.getByLabel("公开 PDF 网址", { exact: true })).toHaveValue(url);
    expect(escapedRequests).toBe(0);
    await openLocal(reader);
  });
}

test("production permission absence prevents automatic fetch while local-file recovery remains usable", async () => {
  let requests = 0;
  await context.route(source, (route) => { requests++; return route.fulfill({ contentType: "application/pdf", body: fixturePdf() }); });
  const reader = await readerPage(`?open=1&source=${encodeURIComponent(source)}`);
  expect(await reader.evaluate((origin) => chrome.permissions.contains({ origins: [origin] }), "https://papers.example.test/*")).toBe(false);
  await expect(reader.getByLabel("公开 PDF 网址", { exact: true })).toHaveValue(source);
  await expect(reader.getByRole("button", { name: "打开网址", exact: true })).toBeEnabled();
  expect(requests).toBe(0);
  await openLocal(reader);
});

test("the 320px dark reader keeps its toolbar usable while the synthetic sidepanel shows notes", async () => {
  const reader = await readerPage();
  const settings = await rpc<Settings>(control, { type: "settings.get" });
  await rpc(control, { type: "settings.put", settings: { ...settings, theme: "dark", reduceMotion: true } });
  await reader.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await reader.setViewportSize({ width: 320, height: 640 });
  await control.setViewportSize({ width: 320, height: 640 });
  await openLocal(reader, fixturePdf(40), "long-paper.pdf");
  const toolbar = reader.locator(".pdf-toolbar");
  for (const name of ["笔记", "更多"])
    await expect(toolbar.getByRole("button", { name, exact: true })).toBeVisible();
  await expectToolbarBounds(reader, 320);
  await expect(reader.getByLabel("页码", { exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "下一页", exact: true })).toBeHidden();
  await toolbar.getByRole("button", { name: "更多", exact: true }).click();
  await reader.locator(".pdf-more-menu").getByRole("button", { name: "下一页", exact: true }).click();
  await expect(reader.getByLabel("页码", { exact: true })).toHaveValue("2");
  expect(Math.abs((await toolbar.boundingBox())!.height - 52)).toBeLessThanOrEqual(1);
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await reader.locator(".pdf-app").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(17, 19, 24)");
  expect(await reader.locator(".pdf-page canvas").first().evaluate((element) => getComputedStyle(element).filter)).toBe("none");
  await openPdfSidebar(reader);
  await expect(control.locator(".pdf-sidebar")).toBeVisible();
  expect(await control.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reader.getByLabel("页码", { exact: true }).fill("35");
  await expect(reader.locator('[data-page="35"] .pdf-page[data-ready=true]')).toBeVisible();
  expect(await reader.locator(".pdf-page canvas").count()).toBeLessThan(12);
  const motion = await toolbar.getByRole("button", { name: "更多", exact: true }).evaluate((element) => ({ transition: getComputedStyle(element).transitionDuration, animation: getComputedStyle(element).animationDuration }));
  expect(motion).toEqual({ transition: "0s", animation: "0s" });
  await reader.screenshot({ path: test.info().outputPath("pdf-reader-dark-320.png") });
  await control.screenshot({ path: test.info().outputPath("pdf-synthetic-sidepanel-dark-320.png") });
});

test("the 600px reader toolbar stays within its viewport and keeps More reachable", async () => {
  const reader = await readerPage();
  await reader.setViewportSize({ width: 600, height: 720 });
  await openLocal(reader, fixturePdf(3), "medium-toolbar.pdf");
  await expectToolbarBounds(reader, 600);
  await expect(reader.locator(".pdf-toolbar").getByRole("button", { name: "更多", exact: true })).toBeVisible();
});
