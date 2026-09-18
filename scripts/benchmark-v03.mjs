import { chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
const base = path.resolve(process.env.WEB_INK_BUILD || ".output/chrome-mv3");
const temp = await mkdtemp(path.join(tmpdir(), "web-ink-perf-"));
let context;
const result = {
  label: process.argv[2] || "working-tree",
  browser: "",
  restore: [],
  libraryQuery: [],
  libraryPaint: [],
  units: "milliseconds",
  fixture: { characters: 100000, annotations: 200, libraryRecords: 10000 },
  bundles: {},
};
const now = "2026-09-18T00:00:00.000Z";
const url = "https://web-ink.test/benchmark";
const paragraph = (i) =>
  `Marker ${String(i).padStart(4, "0")} unique text. ` +
  "Reading text with stable context. ".repeat(16).trim();
const records = Array.from({ length: 200 }, (_, i) => ({
  id: `bench-${i}`,
  pageUrl: url,
  pageTitle: "Synthetic benchmark",
  color: "#facc15",
  note: "",
  tags: [],
  createdAt: now,
  updatedAt: now,
  revision: 1,
  kind: "text",
  target: {
    exact: paragraph(i),
    prefix: "",
    suffix: "",
    start: 0,
    end: paragraph(i).length,
    rootSelector: "#bench",
  },
}));
result.fixture.characters = records.reduce(
  (n, r) => n + r.target.exact.length,
  0,
);
const rpc = async (manager, message) =>
  manager.evaluate(async (message) => {
    const r = await chrome.runtime.sendMessage(message);
    if (!r?.ok) throw Error(r?.error);
    return r.data;
  }, message);
try {
  const build = path.join(temp, "extension");
  await cp(base, build, { recursive: true });
  const manifest = JSON.parse(
    await readFile(path.join(build, "manifest.json"), "utf8"),
  );
  manifest.host_permissions = ["https://*/*", "http://*/*"];
  await writeFile(path.join(build, "manifest.json"), JSON.stringify(manifest));
  for (const filename of [
    "content-scripts/content.js",
    "engine.js",
    "background.js",
  ]) {
    try {
      const b = await readFile(path.join(build, filename));
      result.bundles[filename] = {
        bytes: b.length,
        gzipBytes: gzipSync(b).length,
      };
    } catch {}
  }
  context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  });
  result.browser = context.browser()?.version() || "persistent Chromium";
  const sw =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/library.html`);
  await rpc(manager, { type: "permissions.enable" });
  await rpc(manager, {
    type: "backup.import",
    backup: {
      format: "web-ink",
      schemaVersion: 1,
      exportedAt: now,
      annotations: records,
    },
    overwrite: false,
  });
  const page = await context.newPage();
  await page.route(url, (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main id="bench">${records.map((r) => `<p>${r.target.exact}</p>`).join("")}</main>`,
    }),
  );
  await page.goto(url);
  await page.locator(".web-ink-palette-toggle").waitFor();
  await page.bringToFront();
  for (let i = 0; i < 35; i++) {
    await rpc(manager, { type: "page.mode.put", pageUrl: url, enabled: false });
    await page.waitForFunction(() => CSS.highlights.size === 0);
    await page.evaluate(() => {
      window.__perfStart = performance.now();
      window.__perfDone = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("Restore exceeded 15 seconds")),
          15000,
        );
        const tick = () => {
          const count = Array.from(CSS.highlights.values()).reduce(
            (n, h) => n + h.size,
            0,
          );
          if (count === 200) {
            clearTimeout(timeout);
            resolve(performance.now() - window.__perfStart);
          } else setTimeout(tick, 5);
        };
        tick();
      });
    });
    await rpc(manager, { type: "page.mode.put", pageUrl: url, enabled: true });
    const elapsed = await page.evaluate(() => window.__perfDone);
    if (i >= 5) result.restore.push(elapsed);
  }
  await rpc(manager, { type: "page.mode.put", pageUrl: url, enabled: false });
  result.captureSave = [];
  await rpc(manager, { type: "page.mode.put", pageUrl: url, enabled: true });
  await page.waitForFunction(
    () =>
      Array.from(CSS.highlights.values()).reduce((n, h) => n + h.size, 0) ===
      200,
  );
  for (let i = 0; i < 35; i++) {
    await page.bringToFront();
    const elapsed = await page.evaluate(async () => {
      const node = document.querySelector("#bench p").firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 30);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const start = performance.now();
      node.parentElement.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true }),
      );
      document
        .querySelector("web-ink-ui")
        .shadowRoot.querySelector('button[aria-label="高亮 #4ade80"]')
        .click();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Capture/save timeout")),
          15000,
        );
        const tick = () => {
          if (
            Array.from(CSS.highlights.values()).reduce(
              (n, h) => n + h.size,
              0,
            ) === 201
          ) {
            clearTimeout(timer);
            resolve(performance.now() - start);
          } else setTimeout(tick, 2);
        };
        tick();
      });
    });
    if (i >= 5) result.captureSave.push(elapsed);
    await page.waitForTimeout(80);
    const added = (
      await rpc(manager, { type: "annotations.list", pageUrl: url })
    ).find((r) => !r.id.startsWith("bench-"));
    await rpc(manager, {
      type: "annotations.delete",
      id: added.id,
      expectedRevision: added.revision,
    });
    await page.waitForFunction(
      () =>
        Array.from(CSS.highlights.values()).reduce((n, h) => n + h.size, 0) ===
        200,
    );
  }
  await rpc(manager, { type: "page.mode.put", pageUrl: url, enabled: false });
  // Measure just the extension's rAF paint callback, in its isolated world.
  // Fifty visible pen marks share one image; each pen has 500 stored points.
  await page.route("https://web-ink.test/diagram.svg", (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="600" height="320" fill="silver"/></svg>',
    }),
  );
  await page.evaluate(() => {
    const img = document.createElement("img");
    img.id = "benchimage";
    img.src = "https://web-ink.test/diagram.svg";
    img.alt = "Synthetic image";
    img.style.cssText = "display:block;width:600px;height:320px;";
    document.body.prepend(img);
    scrollTo(0, 0);
  });
  await page.waitForFunction(
    () => document.getElementById("benchimage").naturalWidth === 600,
  );
  const drawings = Array.from({ length: 50 }, (_, i) => ({
    ...records[0],
    id: `paint-${i}`,
    kind: "image",
    target: {
      src: "https://web-ink.test/diagram.svg",
      sourceCandidates: ["https://web-ink.test/diagram.svg"],
      alt: "Synthetic image",
      naturalWidth: 600,
      naturalHeight: 320,
      selector: "#benchimage",
      occurrence: 0,
      context: "",
    },
    shape: {
      kind: "pen",
      width: 0.005,
      points: Array.from({ length: 500 }, (_, j) => ({
        x: 0.1 + j / 625,
        y: 0.2 + (i % 10) * 0.04 + Math.sin(j / 20) * 0.03,
        pressure: 0.5,
      })),
    },
  }));
  await rpc(manager, {
    type: "backup.import",
    backup: {
      format: "web-ink",
      schemaVersion: 1,
      exportedAt: now,
      annotations: drawings,
    },
    overwrite: false,
  });
  await rpc(manager, { type: "page.mode.put", pageUrl: url, enabled: true });
  await page.waitForFunction(
    () =>
      document
        .querySelector("web-ink-ui")
        .shadowRoot.querySelectorAll("g[data-annotation-id]").length === 50,
  );
  result.imagePaint = await manager.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    const [measurement] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const original = requestAnimationFrame.bind(window),
          samples = [];
        window.requestAnimationFrame = (callback) =>
          original((time) => {
            const start = performance.now();
            callback(time);
            samples.push(performance.now() - start);
          });
        try {
          for (let i = 0; i < 100; i++) {
            scrollTo(0, i % 2 ? 30 : 0);
            await new Promise(original);
            await new Promise(original);
          }
          return samples.slice(10);
        } finally {
          window.requestAnimationFrame = original;
        }
      },
    });
    return measurement.result;
  }, url);
  await rpc(manager, { type: "page.mode.put", pageUrl: url, enabled: false });
  for (const drawing of drawings)
    await rpc(manager, {
      type: "annotations.delete",
      id: drawing.id,
      expectedRevision: 1,
    });
  // No management UI mounted while importing large fixtures: measure the storage boundary separately.
  await manager.goto(`chrome-extension://${id}/sidepanel.html`);
  await manager.evaluate(() => document.querySelector("#root")?.remove());
  const many = Array.from({ length: 9800 }, (_, i) => ({
    ...records[0],
    id: `library-${i}`,
    pageUrl: `https://web-ink.test/library/${i}`,
    target: { ...records[0].target },
    note: i % 100 === 0 ? "rare_synthetic_needle" : "Synthetic note",
    tags: i % 100 === 0 ? ["sparse-tag"] : [],
  }));
  await rpc(manager, {
    type: "backup.import",
    backup: {
      format: "web-ink",
      schemaVersion: 1,
      exportedAt: now,
      annotations: many,
    },
    overwrite: false,
  });
  for (let i = 0; i < 35; i++) {
    const measurement = await manager.evaluate(async () => {
      const start = performance.now();
      let r = await chrome.runtime.sendMessage({
        type: "annotations.query",
        query: { limit: 50 },
      });
      let api = "annotations.query";
      if (!r?.ok) {
        api = "annotations.list";
        r = await chrome.runtime.sendMessage({ type: api });
      }
      if (!r?.ok) throw Error(r?.error);
      return {
        ms: performance.now() - start,
        api,
        count: Array.isArray(r.data) ? r.data.length : r.data.items.length,
      };
    });
    if (i >= 5) result.libraryQuery.push(measurement);
  }
  if (result.libraryQuery.at(-1)?.api === "annotations.query") {
    for (let i = 0; i < 35; i++) {
      await manager.goto(`chrome-extension://${id}/library.html`);
      await manager.bringToFront();
      await manager.waitForFunction(
        () => document.querySelectorAll(".annotation-row").length === 50,
      );
      const elapsed = await manager.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => resolve(performance.now())),
          ),
      );
      if (i >= 5) result.libraryPaint.push(elapsed);
    }
  }
  result.search = {};
  for (const [name, query] of [
    ["rare", { text: "rare_synthetic_needle", limit: 50 }],
    ["absent", { text: "no_match_zz_synthetic_xyz", limit: 50 }],
    ["tag", { tag: "sparse-tag", limit: 50 }],
  ]) {
    const samples = [];
    for (let i = 0; i < 35; i++) {
      const measured = await manager.evaluate(async (query) => {
        const start = performance.now();
        const r = await chrome.runtime.sendMessage({
          type: "annotations.query",
          query,
        });
        if (!r?.ok) throw Error(r?.error);
        return performance.now() - start;
      }, query);
      if (i >= 5) samples.push(measured);
    }
    result.search[name] = samples;
  }
  const summary = (values) => ({
    samples: values.length,
    p50: values.slice().sort((a, b) => a - b)[Math.floor(values.length * 0.5)],
    p95: values.slice().sort((a, b) => a - b)[
      Math.ceil(values.length * 0.95) - 1
    ],
  });
  result.restoreSummary = summary(result.restore);
  result.captureSaveSummary = summary(result.captureSave);
  result.searchSummary = Object.fromEntries(
    Object.entries(result.search).map(([name, values]) => [
      name,
      summary(values),
    ]),
  );
  result.imagePaintSummary = summary(result.imagePaint);
  result.libraryQuerySummary = summary(result.libraryQuery.map((v) => v.ms));
  if (result.libraryPaint.length)
    result.libraryPaintSummary = summary(result.libraryPaint);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context?.close();
  await rm(temp, { recursive: true, force: true });
}
