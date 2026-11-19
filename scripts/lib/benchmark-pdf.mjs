import { percentiles } from "./benchmark-statistics.mjs";

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

export async function benchmarkPdf(context, label) {
  const { fixturePdf } = await import("../../tests/pdf-fixture.ts");
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const readerUrl = `chrome-extension://${id}/pdf.html?page=1`;
  await page.goto(readerUrl);
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
      jumps = [],
      jumpInitialStates = [],
      retainedMainHeapBytes = [];
    let peakBacking = 0,
      maxCanvas = 0,
      maxWorkersAfterClose = 0;
    for (let i = 0; i < 33; i++) {
      await page.getByLabel("公开 PDF 网址").fill(url);
      await page.evaluate(() => {
        window.__pdfStart = performance.now();
      });
      await page.getByRole("button", { name: "打开网址", exact: true }).click();
      await page.waitForFunction(
        (name) =>
          document.querySelector(".pdf-name")?.textContent === `${name}.pdf` &&
          document.querySelector('[data-page="1"] .pdf-page[data-ready=true]') &&
          document.querySelector(".pdf-page-field input")?.value === "1",
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
        const initialState = await page.evaluate((targetPage) => {
          const target = document.querySelector(`.pdf-slot[data-page="${targetPage}"]`);
          const state = {
            page: Number(document.querySelector(".pdf-page-field input")?.value),
            page1Ready: Boolean(document.querySelector('[data-page="1"] .pdf-page[data-ready=true]')),
            targetPage,
            targetMounted: Boolean(target),
            targetReady: Boolean(target?.querySelector(".pdf-page[data-ready=true]")),
          };
          if (state.page !== 1 || !state.page1Ready || state.targetMounted || state.targetReady)
            throw Error(`PDF jump requires ready page 1 and an unmounted target: ${JSON.stringify(state)}`);
          window.__pdfJump = performance.now();
          return state;
        }, pages);
        await page.getByLabel("页码", { exact: true }).fill(String(pages));
        await page
          .locator(`[data-page="${pages}"] .pdf-page[data-ready=true]`)
          .waitFor();
        if (i >= 3) {
          jumps.push(
            await page.evaluate(() => performance.now() - window.__pdfJump),
          );
          jumpInitialStates.push(initialState);
        }
      }
      maxCanvas = Math.max(
        maxCanvas,
        await page.locator(".pdf-page canvas").count(),
      );
      // Each navigation closes the reader/worker; browser module cache remains warm.
      await page.goto(readerUrl);
      maxWorkersAfterClose = Math.max(maxWorkersAfterClose, page.workers().length);
      await cdp.send("HeapProfiler.collectGarbage");
      if (i >= 3)
        retainedMainHeapBytes.push((await cdp.send("Runtime.getHeapUsage")).usedSize);
    }
    report.cases.push({
      name,
      bytes: bytes.length,
      pages,
      open: times,
      openSummary: percentiles(times),
      ...(jumps.length ? { jump: jumps, jumpSummary: percentiles(jumps), jumpInitialStates } : {}),
      maxCanvas,
      maxWorkersAfterClose,
      retainedMainHeapBytes,
      observedMainBackingBytes: peakBacking,
    });
  }
  await cdp.detach();
  return report;
}
