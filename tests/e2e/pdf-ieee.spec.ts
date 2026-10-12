import { test, expect, chromium, type BrowserContext, type Page, type Route } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixturePdf } from "../pdf-fixture";
import type { Annotation, PdfTextAnnotation } from "../../src/core/model";

const IEEE = "https://ieeexplore.ieee.org";
const WRAPPER = `${IEEE}/stamp/stamp.jsp?tp=&arnumber=11643626`;
const TICKET = "session-only-ticket";
const DOWNLOAD = `${IEEE}/rest/observed-download?ticket=${TICKET}`;
const PUBLIC = "https://papers.example.test/public.pdf";
const DOI = "10.9999/web-ink.synthetic-paper";

type RequestEvidence = {
  url: string;
  resourceType: string;
  cookie: string | undefined;
  origin: string | undefined;
};

let context: BrowserContext;
let control: Page;
let folder = "";
let extensionId = "";
let ieeeMode: "pdf" | "html" | "redirect" | "unavailable" = "pdf";
let requests: RequestEvidence[] = [];
let paperMetadata = false;
let pdfRevision = 0;

async function rpc<T>(message: object): Promise<T> {
  return control.evaluate(async (message) => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error ?? "Extension request failed");
    return response.data;
  }, message);
}

async function activeTab(page: Page): Promise<number> {
  const ownTabId = await page.evaluate(async () =>
    location.protocol === "chrome-extension:"
      ? (await chrome.tabs.getCurrent())?.id
      : undefined,
  );
  return control.evaluate(async ({ ownTabId, url }) => {
    const tab = ownTabId === undefined
      ? (await chrome.tabs.query({})).find((item) => item.url === url)
      : { id: ownTabId };
    if (tab?.id === undefined) throw new Error(`Fixture tab missing: ${url}`);
    await chrome.tabs.update(tab.id, { active: true });
    return tab.id;
  }, { ownTabId, url: page.url() });
}

async function requestEvidence(route: Route): Promise<RequestEvidence> {
  const headers = await route.request().allHeaders();
  return {
    url: route.request().url(),
    resourceType: route.request().resourceType(),
    cookie: headers.cookie,
    origin: headers.origin,
  };
}

async function ieeeRoute(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const evidence = await requestEvidence(route);
  requests.push(evidence);

  if (url.pathname === "/document/11643626") {
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><title>IEEE paper</title><a href="${WRAPPER}">PDF</a>` });
    return;
  }

  if (url.pathname === "/stamp/stamp.jsp") {
    const body = ieeeMode === "unavailable"
      ? "<!doctype html><title>IEEE fixture</title><h1>No visible file</h1>"
      : `<!doctype html><title>IEEE fixture</title><iframe src="/rest/observed-download?ticket=${TICKET}" width="640" height="480"></iframe>`;
    await route.fulfill({ contentType: "text/html", body });
    return;
  }

  if (url.pathname !== "/rest/observed-download") {
    await route.abort("blockedbyclient");
    return;
  }
  if (!evidence.cookie?.includes("ieee-session=granted")) {
    await route.fulfill({ status: 403, contentType: "text/html", body: "<title>Sign in</title>" });
    return;
  }
  if (ieeeMode === "html") {
    await route.fulfill({ contentType: "text/html", body: "<title>Unexpected HTML</title>" });
    return;
  }
  if (ieeeMode === "redirect") {
    await route.fulfill({ status: 302, headers: { location: `${IEEE}/login` }, body: "" });
    return;
  }
  await route.fulfill({ contentType: "application/pdf", body: fixturePdf(1, "IEEE session fixture", {
    ...(paperMetadata ? { metadata: { title: "Synthetic IEEE paper", doi: DOI } } : {}),
    ...(pdfRevision ? { paddingBytes: 20 } : {}),
  }) });
}

async function selectAndHighlight(reader: Page): Promise<PdfTextAnnotation> {
  await reader.locator(".textLayer span").first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await reader.getByRole("button", { name: "高亮 #facd5a", exact: true }).click();
  await expect.poll(async () => (await rpc<Annotation[]>({ type: "annotations.list" })).length).toBe(1);
  return (await rpc<Annotation[]>({ type: "annotations.list" }))[0]! as PdfTextAnnotation;
}

async function openThroughSidepanel(ieee: Page): Promise<void> {
  await activeTab(ieee);
  const action = control.locator("button.pdf-open-current");
  await expect(action).toBeVisible();
  await expect(action).toHaveText("用 Web Ink 标注当前 PDF");
  await action.click();
  await expect(ieee).toHaveURL(new RegExp(`^chrome-extension://${extensionId}/pdf\\.html\\?`));
  await expect(ieee.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
}

test.beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "web-ink-pdf-ieee-"));
  const extension = path.join(folder, "extension");
  const build = path.resolve(process.env.WEB_INK_BUILD || ".build-output/chrome-mv3");
  await cp(build, extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // Disposable test copy only: the real manifest and the user's profile remain untouched.
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
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
  extensionId = new URL(worker.url()).host;
  requests = [];
  ieeeMode = "pdf";
  paperMetadata = false;
  pdfRevision = 0;
  // The intercepted request already carries headers from Chromium's disposable
  // cookie jar. Record those headers before fulfilling the synthetic response;
  // this is cookie-routing evidence, not a real IEEE network assertion.
  await context.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.href === `https://doi.org/${DOI}`) {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Synthetic DOI resolver</title><a href="${IEEE}/document/11643626">Publisher paper</a>` });
    }
    if (url.origin === IEEE) return ieeeRoute(route);
    if (url.href === PUBLIC) {
      requests.push(await requestEvidence(route));
      return route.fulfill({ contentType: "application/pdf", body: fixturePdf(1, "Public fixture") });
    }
    return route.abort("blockedbyclient");
  });
  await context.addCookies([
    { name: "ieee-session", value: "granted", url: IEEE, secure: true, sameSite: "None" },
    { name: "public-cookie", value: "must-not-forward", url: PUBLIC, secure: true, sameSite: "None" },
  ]);
  control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  expect(await rpc<boolean>({ type: "permissions.enable" })).toBe(true);
});

test.afterEach(async () => {
  await context?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

test("legacy IEEE reader recovery opens the article page without replaying a download", async () => {
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/pdf.html?source=${encodeURIComponent(WRAPPER)}&document=${"a".repeat(64)}`);
  await expect(reader.getByRole("alert").first()).toBeVisible();
  await reader.getByRole("button", { name: "返回 IEEE", exact: true }).click();
  await expect(reader).toHaveURL(`${IEEE}/document/11643626`);
  expect(requests.filter(request => request.resourceType === "fetch")).toHaveLength(0);
});

test("saved IEEE records reopen through the article and a fresh same-tab session", async () => {
  const reader = await context.newPage();
  await reader.goto(WRAPPER);
  await openThroughSidepanel(reader);
  const record = await selectAndHighlight(reader);
  const library = await context.newPage();
  await library.goto(`chrome-extension://${extensionId}/library.html`);
  await library.getByRole("button", { name: new RegExp(record.target.exact) }).first().click();
  await library.locator(".detail-actions").getByRole("button", { name: "打开 PDF", exact: true }).click();
  await expect.poll(() => context.pages().map(page => page.url())).toContain(`${IEEE}/document/11643626`);
  const article = context.pages().find(page => page.url() === `${IEEE}/document/11643626`)!;
  await expect(article).toHaveURL(`${IEEE}/document/11643626`);
  // A tabs.create navigation can start before Playwright attaches the new
  // page. Reload the now-attached tab to serve the synthetic IEEE page.
  await article.reload();
  const tabId = await activeTab(article);
  await article.getByRole("link", { name: "PDF", exact: true }).click();
  await expect(article).toHaveURL(WRAPPER);
  await openThroughSidepanel(article);
  expect(await activeTab(article)).toBe(tabId);
  await expect(article.locator(`[data-pdf-annotation="${record.id}"]`)).toBeVisible();
});

test("legacy IEEE Open PDF prefers the learned DOI, restores the same file, and links changed copies to old marks", async () => {
  paperMetadata = true;
  const reader = await context.newPage();
  await reader.goto(WRAPPER);
  await openThroughSidepanel(reader);
  const record = await selectAndHighlight(reader);
  // Simulate a saved record from before DOI display existed. Its data remains
  // valid and the independent learned paper index supplies the stable entry.
  const legacy = await rpc<PdfTextAnnotation>({ type: "annotations.put", expectedRevision: record.revision,
    annotation: { ...record, pageTitle: "IEEE-11643626.pdf", target: { ...record.target, sourceUrl: WRAPPER, fileName: "IEEE-11643626.pdf" } } });
  const library = await context.newPage();
  await library.goto(`chrome-extension://${extensionId}/library.html`);
  await library.getByRole("button", { name: new RegExp(legacy.target.exact) }).first().click();
  const reopenLegacy = async () => {
    await library.locator(".detail-actions").getByRole("button", { name: "打开 PDF", exact: true }).click();
    await expect.poll(() => context.pages().map(page => page.url())).toContain(`https://doi.org/${DOI}`);
    const paper = context.pages().find(page => page.url() === `https://doi.org/${DOI}`)!;
    await paper.reload(); // Attach before serving the offline DOI resolver fixture.
    await paper.getByRole("link", { name: "Publisher paper", exact: true }).click();
    await paper.getByRole("link", { name: "PDF", exact: true }).click();
    await openThroughSidepanel(paper);
    return paper;
  };
  let paper = await reopenLegacy();
  await expect(paper.locator(`[data-pdf-annotation="${legacy.id}"]`)).toBeVisible();
  expect((await rpc<Annotation[]>({ type: "annotations.list" }))[0]?.id).toBe(legacy.id);

  pdfRevision = 1; // A synthetic watermark-only byte change still needs review.
  paper = await reopenLegacy();
  await expect(paper.locator(`[data-pdf-annotation="${legacy.id}"]`)).toHaveCount(0);
  await paper.getByRole("button", { name: "查看之前的标注", exact: true }).click();
  await expect(paper).toHaveURL(`chrome-extension://${extensionId}/library.html?document=${legacy.target.documentHash}`);
  await expect(paper.getByText("之前版本的标注", { exact: true })).toBeVisible();
  await expect(paper.getByRole("button", { name: new RegExp(legacy.target.exact) }).first()).toBeVisible();
  expect((await rpc<Annotation[]>({ type: "annotations.list" })).map(item => item.id)).toEqual([legacy.id]);
});

test("sidepanel IEEE session handoff keeps the ticket out of reader and persistent data, requires a fresh grant after reload, then restores saved marks in the same tab", async () => {
  const ieee = await context.newPage();
  await ieee.goto(WRAPPER);
  const tabId = await activeTab(ieee);
  const beforePages = context.pages().length;

  await openThroughSidepanel(ieee);
  const readerUrl = new URL(ieee.url());
  expect(readerUrl.searchParams.get("source")).toBe(`${IEEE}/stamp/stamp.jsp?arnumber=11643626`);
  expect(readerUrl.href).not.toContain(TICKET);
  expect(context.pages()).toHaveLength(beforePages);
  expect(await activeTab(ieee)).toBe(tabId);

  const ieeeFetch = requests.find((request) =>
    request.url === DOWNLOAD && request.resourceType === "fetch",
  );
  expect(ieeeFetch, "The original source must prepare one browser-session fetch before switching").toBeDefined();
  expect(ieeeFetch?.cookie).toContain("ieee-session=granted");

  const record = await selectAndHighlight(ieee);
  expect(record.target.sourceUrl).toBe(`${IEEE}/stamp/stamp.jsp?arnumber=11643626`);
  expect(JSON.stringify(await rpc({ type: "backup.export" }))).not.toContain(TICKET);
  expect(JSON.stringify(await control.evaluate(() => chrome.storage.local.get(null)))).not.toContain(TICKET);

  const credentialedFetches = requests.filter((request) =>
    request.url === DOWNLOAD && request.resourceType === "fetch" && request.cookie?.includes("ieee-session=granted"),
  ).length;
  await ieee.reload();
  await expect(ieee.getByRole("alert").first()).toBeVisible();
  await expect(ieee.getByLabel("选择本地 PDF", { exact: true })).toBeEnabled();
  expect(requests.filter((request) =>
    request.url === DOWNLOAD && request.resourceType === "fetch" && request.cookie?.includes("ieee-session=granted"),
  )).toHaveLength(credentialedFetches);

  const returnToIeee = ieee.getByRole("button", { name: /^(返回原阅读器|打开 PDF 来源)$/ });
  await expect(returnToIeee).toBeVisible();
  await returnToIeee.click();
  await expect(ieee).toHaveURL(WRAPPER);
  expect(await activeTab(ieee)).toBe(tabId);
  expect(context.pages()).toHaveLength(beforePages);

  await openThroughSidepanel(ieee);
  await expect(ieee.locator(`[data-pdf-annotation="${record.id}"]`)).toBeVisible();
  expect(requests.filter((request) =>
    request.url === DOWNLOAD && request.resourceType === "fetch" && request.cookie?.includes("ieee-session=granted"),
  )).toHaveLength(credentialedFetches + 1);
});

test("IEEE content menu delegates the site-session grant to the background and opens the same tab", async () => {
  const ieee = await context.newPage();
  await ieee.goto(WRAPPER);
  const tabId = await activeTab(ieee);
  const pen = ieee.locator(".web-ink-palette-toggle");
  await expect(pen).toBeEnabled();
  await pen.click();
  const action = ieee.getByRole("menuitem", { name: "用 Web Ink 标注当前 PDF", exact: true });
  await expect(action).toBeVisible();
  await action.click();
  await expect(ieee).toHaveURL(new RegExp(`^chrome-extension://${extensionId}/pdf\\.html\\?`));
  await expect(ieee.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
  expect(await activeTab(ieee)).toBe(tabId);
  const fetch = requests.find((request) => request.url === DOWNLOAD && request.resourceType === "fetch");
  expect(fetch?.cookie).toContain("ieee-session=granted");
});

test("sidepanel local PDF choice opens a file-only reader and preserves the IEEE tab", async () => {
  const ieee = await context.newPage();
  await ieee.goto(WRAPPER);
  await activeTab(ieee);
  const localChoice = control.locator(".pdf-local-link");
  await expect(localChoice).toBeVisible();
  const pickerOpened = context.waitForEvent("page");
  await localChoice.click();
  const picker = await pickerOpened;
  await expect(picker).toHaveURL(`chrome-extension://${extensionId}/pdf.html?open=local`);
  await expect(picker.getByLabel("选择本地 PDF", { exact: true })).toBeEnabled();
  expect(await picker.locator('input[type="url"]').count()).toBe(0);
  expect(ieee.url()).toBe(WRAPPER);
  await expect(control.getByText("Invalid floating action", { exact: true })).toHaveCount(0);
});

test("session-only IEEE source succeeds with the site session while ordinary public fetches omit cookies and ticket fetches fail safely", async () => {
  const ieee = await context.newPage();
  await ieee.goto(WRAPPER);
  await openThroughSidepanel(ieee);

  const publicReader = await context.newPage();
  await publicReader.goto(`chrome-extension://${extensionId}/pdf.html?source=${encodeURIComponent(PUBLIC)}`);
  await expect(publicReader.locator(".pdf-page[data-ready=true]").first()).toBeVisible();
  const publicFetch = requests.find((request) => request.url === PUBLIC && request.resourceType === "fetch");
  expect(publicFetch, "Public PDF loading must use a browser fetch").toBeDefined();
  expect(publicFetch?.cookie ?? "").not.toContain("public-cookie=must-not-forward");

  const ticketReader = await context.newPage();
  await ticketReader.goto(`chrome-extension://${extensionId}/pdf.html?source=${encodeURIComponent(DOWNLOAD)}`);
  await expect(ticketReader.getByRole("alert").first()).toContainText("403");
  await expect(ticketReader.getByLabel("选择本地 PDF", { exact: true })).toBeEnabled();
  const ticketFetch = requests.filter((request) => request.url === DOWNLOAD && request.resourceType === "fetch").at(-1);
  expect(ticketFetch?.cookie ?? "").not.toContain("ieee-session=granted");
});

test("unavailable, HTML, redirect, and expired IEEE grants leave clear recovery and safe return paths", async () => {
  for (const mode of ["unavailable", "html", "redirect"] as const) {
    ieeeMode = mode;
    const ieee = await context.newPage();
    await ieee.goto(`${WRAPPER}&case=${mode}`);
    await activeTab(ieee);
    const action = control.locator("button.pdf-open-current");
    await expect(action).toHaveText("用 Web Ink 标注当前 PDF");
    await action.click();
    await expect(control.getByRole("alert").first()).toBeVisible();
    await expect(ieee).toHaveURL(`${WRAPPER}&case=${mode}`);
    await expect(action).toBeEnabled();
    expect(await rpc({ type: 'annotations.list' })).toEqual([]);
    expect(ieee.url()).not.toContain(TICKET);
    await ieee.close();
  }

  ieeeMode = "pdf";
  const ieee = await context.newPage();
  await ieee.goto(WRAPPER);
  const tabId = await activeTab(ieee);
  await openThroughSidepanel(ieee);
  await control.evaluate(async () => {
    const values = await chrome.storage.session.get(null);
    const entry = Object.entries(values).find(([key]) => key.startsWith("pdf.handoff."));
    if (!entry) throw new Error("Missing IEEE handoff");
    const [key, value] = entry;
    await chrome.storage.session.set({ [key]: { ...(value as object), expiresAt: Date.now() - 1 } });
  });
  await ieee.reload();
  await expect(ieee.getByRole("alert").first()).toContainText("登录读取授权已过期");
  await expect(ieee.getByLabel("选择本地 PDF", { exact: true })).toBeEnabled();
  await ieee.getByRole("button", { name: "返回原阅读器", exact: true }).click();
  await expect(ieee).toHaveURL(WRAPPER);
  expect(await activeTab(ieee)).toBe(tabId);
});
