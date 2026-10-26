import { test as base, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

export const test = base.extend<{ extension: { context: BrowserContext; id: string; library: Page } }>({
  extension: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), "web-ink-regression-"));
    let context: BrowserContext | undefined;
    try {
      const runtime = path.join(directory, "extension");
      await cp(path.resolve(process.env.WEB_INK_BUILD || ".build-output/chrome-mv3"), runtime, { recursive: true });
      const manifestPath = path.join(runtime, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      // Only this disposable test copy receives pre-granted hosts.
      manifest.host_permissions = ["https://*/*", "http://*/*"];
      await writeFile(manifestPath, JSON.stringify(manifest));
      context = await chromium.launchPersistentContext(path.join(directory, "profile"), {
        channel: "chromium", headless: true,
        ...(process.env.WEB_INK_TEST_BROWSER_PATH ? { executablePath: process.env.WEB_INK_TEST_BROWSER_PATH } : {}),
        args: ["--headless=new", `--disable-extensions-except=${runtime}`, `--load-extension=${runtime}`],
      });
      await context.route(/^https?:\/\//, route => route.abort("blockedbyclient"));
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const id = new URL(worker.url()).host;
      const library = await context.newPage();
      await library.goto(`chrome-extension://${id}/library.html`);
      await use({ context, id, library });
    } finally {
      try { await context?.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  },
});
export { expect };

export async function rpc<T>(page: Page, message: object): Promise<T> {
  return page.evaluate(async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw Error(response?.error || "Missing extension response");
    return response.data;
  }, message);
}
