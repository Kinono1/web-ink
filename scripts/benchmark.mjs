// Performance benchmarks on artificial fixtures and disposable browser profiles.
// Usage: node scripts/benchmark.mjs [--mode=v02|v03|pdf] [label]
//   v02  webpage restore, image paint and library timings (docs/performance-v0.2.json)
//   v03  v02 plus capture/save and search, 30 samples each (docs/performance-v0.3.json)
//   pdf  PDF reader open and page-jump timings (docs/performance-v0.3.json)
import { chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const mode =
  args.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ??
  "v02";
const label = args.find((arg) => !arg.startsWith("--"));
if (!["v02", "v03", "pdf"].includes(mode))
  throw Error(`Unknown --mode=${mode}; use v02, v03 or pdf`);
// [runs, discarded warm-up runs] per measurement.
const RUNS = {
  v02: { restore: [22, 2], query: [12, 2], paint: [6, 1] },
  v03: {
    restore: [35, 5],
    captureSave: [35, 5],
    query: [35, 5],
    paint: [35, 5],
    search: [35, 5],
  },
};
let context;

const percentiles = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
const summary = (values) => ({ samples: values.length, ...percentiles(values) });
const rpc = async (manager, message) =>
  manager.evaluate(async (message) => {
    const r = await chrome.runtime.sendMessage(message);
    if (!r?.ok) throw Error(r?.error);
    return r.data;
  }, message);
// Identical production JS, with host access pre-granted in a disposable manifest.
async function prepareExtension(directory) {
  await cp(
    path.resolve(process.env.WEB_INK_BUILD || ".output/chrome-mv3"),
    directory,
    { recursive: true },
  );
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["https://*/*", "http://*/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
}
const launch = (temp, extension, extraArgs = [], options = {}) =>
  chromium.launchPersistentContext(path.join(temp, "profile"), {
    channel: "chromium",
    headless: true,
    args: [
      ...extraArgs,
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
    ...options,
  });

async function benchmarkWebpage(temp) {
  const runs = RUNS[mode];
  const result = {
    label: label || "working-tree",
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
  const build = path.join(temp, "extension");
  await prepareExtension(build);
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
  context = await launch(temp, build);
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
  for (let i = 0; i < runs.restore[0]; i++) {
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
    if (i >= runs.restore[1]) result.restore.push(elapsed);
  }
  await rpc(manager, { type: "page.mode.put", pageUrl: url, enabled: false });
  if (runs.captureSave) {
    result.captureSave = [];
    await rpc(manager, { type: "page.mode.put", pageUrl: url, enabled: true });
    await page.waitForFunction(() =>
      Array.from(CSS.highlights.values()).reduce((n, h) => n + h.size, 0) ===
      200,
    );
    for (let i = 0; i < runs.captureSave[0]; i++) {
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
      if (i >= runs.captureSave[1]) result.captureSave.push(elapsed);
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
  }
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
  // v03 plants a rare note and tag in 1% of records for the search timings.
  const needle = (i) => Boolean(runs.search) && i % 100 === 0;
  const many = Array.from({ length: 9800 }, (_, i) => ({
    ...records[0],
    id: `library-${i}`,
    pageUrl: `https://web-ink.test/library/${i}`,
    target: { ...records[0].target },
    note: needle(i) ? "rare_synthetic_needle" : "Synthetic note",
    tags: needle(i) ? ["sparse-tag"] : [],
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
  for (let i = 0; i < runs.query[0]; i++) {
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
    if (i >= runs.query[1]) result.libraryQuery.push(measurement);
  }
  if (result.libraryQuery.at(-1)?.api === "annotations.query") {
    for (let i = 0; i < runs.paint[0]; i++) {
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
      if (i >= runs.paint[1]) result.libraryPaint.push(elapsed);
    }
  }
  if (runs.search) {
    result.search = {};
    for (const [name, query] of [
      ["rare", { text: "rare_synthetic_needle", limit: 50 }],
      ["absent", { text: "no_match_zz_synthetic_xyz", limit: 50 }],
      ["tag", { tag: "sparse-tag", limit: 50 }],
    ]) {
      const samples = [];
      for (let i = 0; i < runs.search[0]; i++) {
        const measured = await manager.evaluate(async (query) => {
          const start = performance.now();
          const r = await chrome.runtime.sendMessage({
            type: "annotations.query",
            query,
          });
          if (!r?.ok) throw Error(r?.error);
          return performance.now() - start;
        }, query);
        if (i >= runs.search[1]) samples.push(measured);
      }
      result.search[name] = samples;
    }
  }
  result.restoreSummary = summary(result.restore);
  if (runs.captureSave)
    result.captureSaveSummary = summary(result.captureSave);
  if (runs.search)
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
  return result;
}

// An unreferenced, valid PDF stream isolates byte input/hash cost from image decoding.
function largePdf(size) {
  const parts = ["%PDF-1.7\n"];
  const offsets = [0];
  let length = parts[0].length;
  const add = (value) => {
    offsets.push(length);
    const text = `${offsets.length - 1} 0 obj\n${value}\nendobj\n`;
    parts.push(text);
    length += Buffer.byteLength(text);
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Count 1 /Kids [4 0 R] >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
  );
  const content =
    "BT /F1 18 Tf 48 730 Td (Synthetic large PDF input benchmark.) Tj ET\n";
  add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  const padding = size - length - 1000;
  offsets.push(length);
  const header = `6 0 obj\n<< /Length ${padding} >>\nstream\n`;
  parts.push(header, Buffer.alloc(padding), "\nendstream\nendobj\n");
  length += header.length + padding + "\nendstream\nendobj\n".length;
  const xref = length;
  let tail = `xref\n0 7\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const remain = size - length - Buffer.byteLength(tail);
  if (remain < 0) throw Error("Fixture size overflow");
  parts.push(
    " ".repeat(remain),
    tail.replace(`\n${xref}\n%%EOF`, `\n${xref + remain}\n%%EOF`),
  );
  return Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p)),
  );
}

async function benchmarkPdf(temp) {
  const { fixturePdf } = await import("../tests/pdf-fixture.ts");
  const extension = path.join(temp, "extension");
  await prepareExtension(extension);
  context = await launch(temp, extension, ["--headless=new"], {
    viewport: { width: 1280, height: 900 },
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/pdf.html`);
  const cdp = await context.newCDPSession(page);
  const report = {
    label: label || "candidate",
    browser: context.browser()?.version(),
    fixture:
      "Synthetic PDF with inert stream for input cost; text-only 500/1000-page documents for layout.",
    samples: 30,
    cases: [],
  };
  for (const [name, bytes, pages] of [
    ["20MiB", largePdf(20 * 1024 * 1024), 1],
    ["50MiB", largePdf(50 * 1024 * 1024), 1],
    ["500pages", fixturePdf(500), 500],
    ["1000pages", fixturePdf(1000), 1000],
  ]) {
    const url = `https://pdf-benchmark.test/${name}.pdf`;
    await page.route(url, (r) =>
      r.fulfill({ contentType: "application/pdf", body: bytes }),
    );
    const times = [],
      jumps = [];
    let peakBacking = 0,
      maxCanvas = 0;
    for (let i = 0; i < 33; i++) {
      await page.getByLabel("公开 PDF 网址").fill(url);
      await page.evaluate(() => {
        window.__pdfStart = performance.now();
      });
      await page.getByRole("button", { name: "打开网址", exact: true }).click();
      await page.waitForFunction(
        (name) =>
          document.querySelector(".pdf-name")?.textContent === `${name}.pdf` &&
          document.querySelector(".pdf-page[data-ready=true]"),
        name,
        { timeout: 30000 },
      );
      const elapsed = await page.evaluate(
        () => performance.now() - window.__pdfStart,
      );
      if (i >= 3) times.push(elapsed);
      const usage = await cdp.send("Runtime.getHeapUsage");
      peakBacking = Math.max(peakBacking, usage.backingStorageSize ?? 0);
      if (pages > 1) {
        await page.evaluate(() => (window.__pdfJump = performance.now()));
        await page.getByLabel("页码", { exact: true }).fill(String(pages));
        await page
          .locator(`[data-page="${pages}"] .pdf-page[data-ready=true]`)
          .waitFor();
        if (i >= 3)
          jumps.push(
            await page.evaluate(() => performance.now() - window.__pdfJump),
          );
      }
      maxCanvas = Math.max(
        maxCanvas,
        await page.locator(".pdf-page canvas").count(),
      );
      // Each navigation closes the reader/worker; browser module cache remains warm.
      await page.goto(`chrome-extension://${id}/pdf.html`);
    }
    report.cases.push({
      name,
      bytes: bytes.length,
      pages,
      open: times,
      openSummary: percentiles(times),
      ...(jumps.length ? { jump: jumps, jumpSummary: percentiles(jumps) } : {}),
      maxCanvas,
      observedMainBackingBytes: peakBacking,
    });
  }
  await cdp.detach();
  return report;
}

const temp = await mkdtemp(
  path.join(tmpdir(), mode === "pdf" ? "web-ink-pdf-perf-" : "web-ink-perf-"),
);
try {
  const report =
    mode === "pdf" ? await benchmarkPdf(temp) : await benchmarkWebpage(temp);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context?.close();
  await rm(temp, { recursive: true, force: true });
}
