import { chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixturePdf } from "../tests/pdf-fixture.ts";

const temp = await mkdtemp(path.join(tmpdir(), "web-ink-pdf-perf-"));
let context;
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
try {
  const extension = path.join(temp, "extension");
  await cp(
    path.resolve(process.env.WEB_INK_BUILD || ".output/chrome-mv3"),
    extension,
    { recursive: true },
  );
  const manifest = JSON.parse(
    await readFile(path.join(extension, "manifest.json"), "utf8"),
  );
  manifest.host_permissions = ["https://*/*", "http://*/*"];
  await writeFile(
    path.join(extension, "manifest.json"),
    JSON.stringify(manifest),
  );
  context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    channel: "chromium",
    headless: true,
    args: [
      "--headless=new",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
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
    label: process.argv[2] || "candidate",
    browser: context.browser()?.version(),
    fixture:
      "Synthetic PDF with inert stream for input cost; text-only 500/1000-page documents for layout.",
    samples: 30,
    cases: [],
  };
  const summaries = (a) => {
    const v = a.slice().sort((x, y) => x - y);
    return {
      p50: v[Math.floor(v.length * 0.5)],
      p95: v[Math.ceil(v.length * 0.95) - 1],
    };
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
      openSummary: summaries(times),
      ...(jumps.length ? { jump: jumps, jumpSummary: summaries(jumps) } : {}),
      maxCanvas,
      observedMainBackingBytes: peakBacking,
    });
  }
  console.log(JSON.stringify(report, null, 2));
  await cdp.detach();
} finally {
  await context?.close();
  await rm(temp, { recursive: true, force: true });
}
