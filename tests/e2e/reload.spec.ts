import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { createHash } from "node:crypto";
import {
  cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Annotation, Settings } from "../../src/core/model";

const expectedId = "cmllmmnfiefikhcbelokclankodgcdog";
const origins = ["http://*/*", "https://*/*"];
const oldBuild = path.resolve(
  process.env.WEB_INK_RELOAD_OLD_BUILD || ".local-install/reload-baseline/chrome-mv3",
);
const newBuild = path.resolve(process.env.WEB_INK_BUILD || ".build-output/chrome-mv3");

type BuildInfo = { version: string; commit: string; dirty: boolean };
type RuntimeHealth = BuildInfo & { generation: string };

async function readBuild(folder: string, label: string) {
  let manifest;
  let info: BuildInfo;
  try {
    manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
    const build = JSON.parse(await readFile(path.join(folder, "build-info.json"), "utf8"));
    info = { version: build.version, commit: build.commit, dirty: build.dirty };
  } catch (error) {
    throw new Error(
      `${label} build is required at ${folder}; this Reload test cannot skip a missing baseline.`,
      { cause: error },
    );
  }
  expect(manifest.key, `${label} must retain the extension identity`).toEqual(expect.any(String));
  expect(info.version).toBe(manifest.version);
  expect(info.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(typeof info.dirty).toBe("boolean");
  return { manifest, info };
}

async function fingerprint(folder: string): Promise<string> {
  const digest = createHash("sha256");
  async function visit(relative: string) {
    const entries = await readdir(path.join(folder, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else {
        if (!entry.isFile()) throw new Error(`Build contains a non-file entry: ${name}`);
        digest.update(name).update("\0");
        digest.update(await readFile(path.join(folder, name))).update("\0");
      }
    }
  }
  await visit("");
  return digest.digest("hex");
}

async function rpc<T>(manager: Page, message: object): Promise<T> {
  return manager.evaluate(async (message) => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error ?? "No extension response");
    return result.data;
  }, message);
}

async function pageRuntime(manager: Page, tabId: number) {
  return manager.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => {
        const content = window as unknown as {
          __webInkBootstrap?: { health?: RuntimeHealth };
          __webInkEngine?: { generation?: string };
        };
        return {
          health: content.__webInkBootstrap?.health ?? null,
          engineLoaded: Boolean(content.__webInkEngine),
          engineGeneration: content.__webInkEngine?.generation ?? null,
          engineStyles: document.querySelectorAll("style[data-web-ink='true']").length,
        };
      },
    });
    if (!result?.result) throw new Error(`No content runtime in tab ${tabId}`);
    return result.result;
  }, tabId);
}

async function palettePoint(page: Page) {
  return page.locator(".web-ink-palette-toggle").evaluate((button) => ({
    left: Number.parseFloat((button as HTMLElement).style.left),
    top: Number.parseFloat((button as HTMLElement).style.top),
  }));
}

async function mark(page: Page, selector: string) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.locator(selector).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "高亮 #facc15", exact: true }).click();
}

test("in-place extension Reload replaces old runtimes three times without navigating existing pages", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const baseline = await readBuild(oldBuild, "Old");
  const candidate = await readBuild(newBuild, "New");
  expect(candidate.manifest.key).toBe(baseline.manifest.key);
  const addedPermissions: string[] = (candidate.manifest.permissions ?? []).filter(
    (permission: string) => !(baseline.manifest.permissions ?? []).includes(permission),
  );
  expect(addedPermissions.every((permission) => permission === "activeTab")).toBe(true);
  const sourceHashes = {
    old: await fingerprint(oldBuild),
    new: await fingerprint(newBuild),
  };
  const root = await mkdtemp(path.join(tmpdir(), "web-ink-reload-"));
  const extension = path.join(root, "extension");
  const profile = path.join(root, "profile");
  await mkdir(extension);
  const installInode = (await stat(extension)).ino;
  const rounds: object[] = [];
  const healthResponses: object[] = [];
  let context: BrowserContext | undefined;
  let browserVersion: string | undefined;
  let browserUserAgent: string | undefined;
  let manager: Page;
  let worker: Worker;

  // Only this disposable copy receives pre-granted hosts. Production manifests
  // and the user's loaded directory remain read-only; native approval is separate.
  const copyInPlace = async (source: string) => {
    for (const name of await readdir(extension))
      await rm(path.join(extension, name), { recursive: true, force: true });
    await cp(source, extension, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
    manifest.host_permissions = origins;
    await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
    expect((await stat(extension)).ino).toBe(installInode);
  };
  const reload = async () => {
    await manager.close();
    const previous = worker;
    const next = context!.waitForEvent("serviceworker", {
      predicate: (value) => value !== previous && new URL(value.url()).host === expectedId,
      timeout: 20_000,
    });
    // This invokes Chrome's extension lifecycle, including context invalidation
    // and re-reading this same directory. No host-page navigation is requested.
    const [replacement] = await Promise.all([
      next,
      previous.evaluate(() => chrome.runtime.reload()).catch((error: Error) => {
        // Reload may invalidate the caller before Chrome returns its result.
        if (!/Target.*closed|Execution context.*destroyed/i.test(error.message)) throw error;
      }),
    ]);
    worker = replacement;
    expect(new URL(worker.url()).host).toBe(expectedId);
    manager = await context!.newPage();
    await manager.goto(`chrome-extension://${expectedId}/library.html`);
  };

  try {
    await copyInPlace(oldBuild);
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      ...(process.env.WEB_INK_TEST_BROWSER_PATH
        ? { executablePath: process.env.WEB_INK_TEST_BROWSER_PATH }
        : {}),
      args: [
        "--headless=new",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
      viewport: { width: 1200, height: 900 },
    });
    worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    expect(new URL(worker.url()).host).toBe(expectedId);
    // Command-line loading initially works without Developer mode, but Chrome
    // disables that unpacked extension on real Reload unless this profile opts in.
    const extensions = await context.newPage();
    await extensions.goto("chrome://extensions");
    const developerMode = extensions.locator("extensions-toolbar #devMode");
    await developerMode.click();
    await expect.poll(() => developerMode.evaluate((element) =>
      (element as HTMLElement & { checked: boolean }).checked,
    )).toBe(true);
    await extensions.close();
    manager = await context.newPage();
    await manager.goto(`chrome-extension://${expectedId}/library.html`);
    browserVersion = context.browser()?.version();
    browserUserAgent = await manager.evaluate(() => navigator.userAgent);
    await rpc(manager, { type: "permissions.enable" });
    if (process.env.WEB_INK_RELOAD_BASELINE_CAPTURE) {
      const captures = path.resolve(process.env.WEB_INK_RELOAD_BASELINE_CAPTURE);
      await mkdir(captures, { recursive: true });
      await manager.emulateMedia({ colorScheme: "light" });
      await expect(manager.locator(".ink-app")).toBeVisible();
      await manager.screenshot({ path: path.join(captures, "library-light.png") });
      const fixture = await context.newPage();
      await fixture.goto("http://127.0.0.1:4173/article?baseline=capture");
      await manager.goto(`chrome-extension://${expectedId}/sidepanel.html`);
      await manager.setViewportSize({ width: 320, height: 640 });
      await manager.evaluate(async (url) => {
        const tab = (await chrome.tabs.query({})).find((value) => value.url === url);
        if (tab?.id === undefined) throw new Error("Baseline capture fixture tab missing");
        await chrome.tabs.update(tab.id, { active: true });
      }, fixture.url());
      await expect(manager.locator(".page-header strong")).toHaveText("Web Ink · Reading fixture");
      await manager.screenshot({ path: path.join(captures, "sidebar-320-light.png") });
      await manager.setViewportSize({ width: 1200, height: 900 });
      await manager.goto(`chrome-extension://${expectedId}/pdf.html`);
      await expect(manager.getByLabel("选择本地 PDF", { exact: true })).toBeVisible();
      await manager.screenshot({ path: path.join(captures, "pdf-empty-light.png") });
      await writeFile(path.join(captures, "build.json"), JSON.stringify({
        baseline: baseline.info,
        browserVersion,
        permissionEvidence: "pre-granted disposable copy",
        sidebarSurface: "regular extension tab at 320px; not native side panel",
        fixture: "authored tests/fixtures/article.html; no user files",
      }, null, 2));
      await fixture.close();
      await manager.goto(`chrome-extension://${expectedId}/library.html`);
    }
    const settings = await rpc<Settings>(manager, { type: "settings.get" });
    await rpc(manager, {
      type: "settings.put",
      settings: {
        ...settings,
        theme: "dark",
        reduceMotion: true,
        reduceTransparency: true,
        disabledOrigins: ["https://paused.example.test"],
      },
    });

    const enabled = await context.newPage();
    await enabled.goto("http://127.0.0.1:4173/article?reload=enabled");
    const disabled = await context.newPage();
    await disabled.goto("http://127.0.0.1:4173/article?reload=disabled");
    await expect(enabled.locator(".web-ink-palette-toggle")).toBeEnabled();
    await enabled.locator(".web-ink-palette-toggle").click();
    await expect(enabled.locator(".web-ink-palette-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(disabled.locator(".web-ink-palette-toggle")).toHaveAttribute("aria-pressed", "false");
    await mark(enabled, "#selection strong");
    await expect.poll(async () => (await rpc<Annotation[]>(manager, { type: "annotations.list" })).length).toBe(1);
    const [record] = await rpc<Annotation[]>(manager, { type: "annotations.list" });
    await rpc(manager, {
      type: "annotations.put",
      annotation: { ...record!, note: "Reload preserves this saved note", tags: ["reload-fixture"] },
      expectedRevision: record!.revision,
    });
    const box = (await enabled.locator(".web-ink-palette-toggle").boundingBox())!;
    await enabled.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await enabled.mouse.down();
    await enabled.mouse.move(220 + box.width / 2, 160 + box.height / 2, { steps: 6 });
    await enabled.mouse.up();
    await expect.poll(() => manager.evaluate(async () =>
      (await chrome.storage.local.get("ui.palettePosition"))["ui.palettePosition"],
    )).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    const position = await palettePoint(enabled);
    expect(Math.abs(position.left - 220)).toBeLessThan(2);
    expect(Math.abs(position.top - 160)).toBeLessThan(2);

    const pages = [enabled, disabled];
    const navigationCounts = [0, 0];
    const documents = await Promise.all(pages.map(async (page, index) => {
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigationCounts[index]!++;
      });
      return page.evaluate(() => {
        document.documentElement.dataset.reloadDocument = crypto.randomUUID();
        const input = document.querySelector<HTMLInputElement>("#normal-input")!;
        input.value = `Keep this input ${document.documentElement.dataset.reloadDocument}`;
        return {
          marker: document.documentElement.dataset.reloadDocument,
          timeOrigin: performance.timeOrigin,
          input: input.value,
        };
      });
    }));
    const tabs = await manager.evaluate(() => chrome.tabs.query({}));
    const tabIds = pages.map((page) => {
      const id = tabs.find((tab) => tab.url === page.url())?.id;
      if (id === undefined) throw new Error(`Fixture tab missing: ${page.url()}`);
      return id;
    });
    expect(await pageRuntime(manager, tabIds[1]!)).toMatchObject({ engineLoaded: false, engineStyles: 0 });

    const durableState = async () => ({
      records: (await rpc<Annotation[]>(manager, { type: "annotations.list" })).sort((a, b) => a.id.localeCompare(b.id)),
      settings: await rpc<Settings>(manager, { type: "settings.get" }),
      modes: await Promise.all(pages.map((page) => rpc(manager, { type: "page.mode.get", pageUrl: page.url() }))),
      permissions: await manager.evaluate(async () => {
        const granted = await chrome.permissions.getAll();
        return { origins: granted.origins?.sort(), permissions: granted.permissions?.sort() };
      }),
      palette: await manager.evaluate(async () => (await chrome.storage.local.get("ui.palettePosition"))["ui.palettePosition"]),
    });
    const generations = new Set<string>();
    for (let round = 0; round < 3; round++) {
      if (round > 0) {
        // Restore the real old files and Reload within this same browser/profile.
        // Each candidate transition is therefore old -> new, not new -> new.
        await copyInPlace(oldBuild);
        await reload();
        expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe(baseline.info.version);
        await expect(enabled.locator(".web-ink-palette-toggle")).toBeEnabled();
        await expect(enabled.locator(".web-ink-palette-toggle")).toHaveAttribute("aria-pressed", "true");
      }
      await expect.poll(() => pageRuntime(manager, tabIds[0]!)).toMatchObject({
        health: null, engineLoaded: true, engineGeneration: null, engineStyles: 1,
      });
      expect(await pageRuntime(manager, tabIds[1]!)).toMatchObject({
        health: null, engineLoaded: false, engineStyles: 0,
      });
      const before = await durableState();
      const oldSessionGeneration = await manager.evaluate(async () =>
        (await chrome.storage.session.get("ui.runtimeGeneration"))["ui.runtimeGeneration"] ?? null,
      );
      await copyInPlace(newBuild);
      await reload();
      const response = await manager.evaluate(() => chrome.runtime.sendMessage({ type: "runtime.health" }));
      healthResponses.push({ round: round + 1, response });
      expect(response?.ok, "The reloaded candidate must answer runtime.health").toBe(true);
      const health = response.data as RuntimeHealth;
      expect(health).toMatchObject(candidate.info);
      expect(health.generation).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
      expect(health.generation).not.toBe(oldSessionGeneration);
      expect(generations.has(health.generation)).toBe(false);
      generations.add(health.generation);
      expect(sourceHashes.new, "A successful upgrade must use different runtime files").not.toBe(sourceHashes.old);
      expect(await manager.evaluate(() => chrome.runtime.id)).toBe(expectedId);
      expect(await manager.evaluate(async () =>
        (await chrome.storage.session.get("ui.runtimeGeneration"))["ui.runtimeGeneration"],
      )).toBe(health.generation);
      for (const [index, page] of pages.entries()) {
        await expect(page.locator("web-ink-ui")).toHaveCount(1);
        await expect(page.locator(".web-ink-palette-toggle")).toHaveCount(1);
        await expect(page.locator(".web-ink-palette-toggle")).toBeEnabled();
        await expect(page.locator("web-ink-ui")).toHaveAttribute("data-web-ink-generation", health.generation);
        await expect(page.locator(".web-ink-palette-toggle")).toHaveAttribute("aria-pressed", String(index === 0));
        await expect.poll(() => palettePoint(page)).toEqual(position);
        expect(await page.evaluate(() => ({
          marker: document.documentElement.dataset.reloadDocument,
          timeOrigin: performance.timeOrigin,
          input: document.querySelector<HTMLInputElement>("#normal-input")!.value,
        }))).toEqual(documents[index]);
      }
      await expect.poll(() => pageRuntime(manager, tabIds[0]!)).toMatchObject({ health, engineLoaded: true, engineGeneration: health.generation, engineStyles: 1 });
      expect(await pageRuntime(manager, tabIds[1]!)).toEqual({ health, engineLoaded: false, engineGeneration: null, engineStyles: 0 });
      await expect.poll(() => enabled.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
      expect(await durableState()).toEqual({
        ...before,
        permissions: {
          ...before.permissions,
          permissions: [...new Set([
            ...(before.permissions.permissions ?? []),
            ...addedPermissions,
          ])].sort(),
        },
      });
      expect(navigationCounts).toEqual([0, 0]);
      await mark(enabled, ["#repeat-a", "#repeat-b", "#ending"][round]!);
      await expect.poll(async () => (await rpc<Annotation[]>(manager, { type: "annotations.list" })).length).toBe(before.records.length + 1);
      const after = await durableState();
      for (const saved of before.records) expect(after.records.find((row) => row.id === saved.id)).toEqual(saved);
      expect(await rpc<RuntimeHealth>(manager, { type: "runtime.health" })).toEqual(health);
      expect(await pageRuntime(manager, tabIds[1]!)).toEqual({ health, engineLoaded: false, engineGeneration: null, engineStyles: 0 });
      await expect(enabled.locator("web-ink-ui")).toHaveCount(1);
      await expect(enabled.locator(".web-ink-palette-toggle")).toHaveCount(1);
      expect((await pageRuntime(manager, tabIds[0]!)).engineStyles).toBe(1);
      expect(navigationCounts).toEqual([0, 0]);
      rounds.push({
        round: round + 1,
        transition: "old -> new",
        oldSessionGeneration,
        health,
        annotationCount: after.records.length,
        navigationCounts: [...navigationCounts],
        palette: after.palette,
      });
    }
  } finally {
    await context?.close();
    const receipt = testInfo.outputPath("reload-observations.json");
    await writeFile(receipt, JSON.stringify({
      trigger: "chrome.runtime.reload()",
      browserVersion,
      browserUserAgent,
      permissionEvidence: "pre-granted disposable manifests; not native consent",
      oldBuild,
      newBuild,
      sourceHashes,
      baseline: baseline.info,
      candidate: candidate.info,
      fixedInstallPath: extension,
      installInode,
      healthResponses,
      rounds,
    }, null, 2));
    await testInfo.attach("reload-observations", {
      path: receipt,
      contentType: "application/json",
    });
    await rm(root, { recursive: true, force: true });
    expect(await fingerprint(oldBuild), "The old build source must remain unchanged").toBe(sourceHashes.old);
    expect(await fingerprint(newBuild), "The new build source must remain unchanged").toBe(sourceHashes.new);
  }
});
