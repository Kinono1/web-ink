import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PdfRect, PdfTextAnnotation } from "../../src/core/model";

const previewColors = ["#facd5a", "#7cc868", "#69b0f1", "#fb5c89", "#c885da"];
const legacyColor = "#facc15";
const customColor = "#123456";
const textRect: PdfRect = { x: 0.07, y: 0.42, width: 0.55, height: 0.3 };
const paperRects: PdfRect[] = [0.03, 0.09, 0.15, 0.21, 0.27, 0.33].map((y) => ({
  x: 0.1, y, width: 0.25, height: 0.04,
}));

let context: BrowserContext;
let folder = "";
let page: Page;
let control: Page;
let id: string;

function blackTextPdf(): Buffer {
  const stream = [
    "1 1 1 rg 0 0 612 360 re f",
    "0 0 0 rg BT /F1 96 Tf 48 180 Td (MMMM) Tj ET",
  ].join("\n") + "\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 360] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let output = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function rpc<T>(message: object): Promise<T> {
  return control.evaluate(async (message) => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error ?? "Extension request failed");
    return response.data;
  }, message);
}

async function open() {
  await page.getByLabel("选择本地 PDF", { exact: true }).setInputFiles({
    name: "preview-color-fixture.pdf",
    mimeType: "application/pdf",
    buffer: blackTextPdf(),
  });
  await expect(page.locator(".pdf-page[data-ready=true]")).toBeVisible();
  const hash = new URL(page.url()).searchParams.get("document");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("PDF reader did not expose its document hash");
  return hash;
}

function textAnnotation(
  id: string,
  color: string,
  documentHash: string,
  rects: PdfRect[],
): PdfTextAnnotation {
  const now = "2026-10-11T00:00:00.000Z";
  return {
    id,
    pageUrl: `urn:web-ink:pdf:${documentHash}`,
    pageTitle: "preview-color-fixture.pdf",
    color,
    note: "",
    tags: [],
    createdAt: now,
    updatedAt: now,
    revision: 0,
    kind: "pdf-text",
    target: {
      documentHash,
      fileName: "preview-color-fixture.pdf",
      pageNumber: 1,
      rects,
      exact: "MMMM",
      prefix: "",
      suffix: "",
    },
  };
}

async function screenPixels(points: Array<{ id: string; x: number; y: number }>) {
  const screenshot = await page.screenshot();
  return page.evaluate(async ({ points, png }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const draw = canvas.getContext("2d");
    if (!draw) throw new Error("Screenshot canvas is unavailable");
    draw.drawImage(image, 0, 0);
    const pixels = draw.getImageData(0, 0, canvas.width, canvas.height).data;
    return points.map(({ id, x, y }) => {
      const screenshotX = Math.round(x * image.naturalWidth / innerWidth);
      const screenshotY = Math.round(y * image.naturalHeight / innerHeight);
      const offset = (screenshotY * image.naturalWidth + screenshotX) * 4;
      return { id, rgb: [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!] };
    });
  }, { points, png: screenshot.toString("base64") });
}

async function samplePoints(ids: string[]) {
  return page.evaluate((ids) => {
    const pdfCanvas = document.querySelector<HTMLCanvasElement>(".pdf-page canvas");
    const context = pdfCanvas?.getContext("2d", { willReadFrequently: true });
    if (!pdfCanvas || !context) throw new Error("PDF canvas is unavailable");
    const canvasBox = pdfCanvas.getBoundingClientRect();
    const pixels = context.getImageData(0, 0, pdfCanvas.width, pdfCanvas.height).data;
    const pointFor = (id: string, dark: boolean) => {
      const mark = document.querySelector<SVGRectElement>(`[data-pdf-annotation="${id}"]`);
      if (!mark) throw new Error(`Missing rendered mark ${id}`);
      const box = mark.getBoundingClientRect();
      for (let y = Math.ceil(box.top + 3); y < Math.floor(box.bottom - 3); y++)
        for (let x = Math.ceil(box.left + 3); x < Math.floor(box.right - 3); x++) {
          const sourceX = Math.floor((x - canvasBox.left) * pdfCanvas.width / canvasBox.width);
          const sourceY = Math.floor((y - canvasBox.top) * pdfCanvas.height / canvasBox.height);
          const offset = (sourceY * pdfCanvas.width + sourceX) * 4;
          const [red, green, blue] = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
          if (dark ? red < 20 && green < 20 && blue < 20 : red > 245 && green > 245 && blue > 245)
            return { id, x, y };
        }
      throw new Error(`No ${dark ? "black text" : "white paper"} pixel inside ${id}`);
    };
    return {
      paper: ids.map((id) => pointFor(id, false)),
      blackText: pointFor("preview-yellow", true),
    };
  }, ids);
}

function hexRgb(hex: string) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

test.beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "web-ink-pdf-highlight-colors-"));
  const extension = path.join(folder, "extension");
  await cp(path.resolve(process.env.WEB_INK_BUILD || ".build-output/chrome-mv3"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["https://*/*", "http://*/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(path.join(folder, "profile"), {
    channel: "chromium",
    headless: true,
    ...(process.env.WEB_INK_TEST_BROWSER_PATH ? { executablePath: process.env.WEB_INK_TEST_BROWSER_PATH } : {}),
    args: ["--headless=new", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1280, height: 900 },
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  id = new URL(worker.url()).host;
  await context.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
  control = await context.newPage();
  await control.goto(`chrome-extension://${id}/sidepanel.html`);
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/pdf.html`);
});

test.afterEach(async () => {
  await context?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

test("PDF highlights multiply Preview colors over white paper and preserve black text", async () => {
  const hash = await open();
  const records = [
    textAnnotation("preview-yellow", previewColors[0]!, hash, [textRect, { ...textRect }]),
    ...previewColors.slice(1).map((color, index) => textAnnotation(`preview-${index + 1}`, color, hash, [paperRects[index]!])),
    textAnnotation("legacy-yellow", legacyColor, hash, [paperRects[4]!]),
    textAnnotation("custom-color", customColor, hash, [paperRects[5]!]),
  ];
  for (const annotation of records)
    await rpc({ type: "annotations.put", annotation, expectedRevision: 0 });
  await expect(page.locator("[data-pdf-annotation]")).toHaveCount(records.length);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const stored = await rpc<PdfTextAnnotation[]>({ type: "annotations.list" });
  expect(stored.map((record) => record.color).sort()).toEqual(records.map((record) => record.color).sort());
  expect(stored.find((record) => record.id === "preview-yellow")?.target.rects).toEqual([textRect, textRect]);

  const ids = records.map((record) => record.id);
  const samples = await samplePoints(ids);
  const pixels = await screenPixels([...samples.paper, { ...samples.blackText, id: "black-text" }]);
  const byId = new Map(pixels.map((pixel) => [pixel.id, pixel.rgb]));
  for (const record of records) {
    const rgb = byId.get(record.id);
    expect(rgb, `${record.id} must have a sampled white-paper pixel`).toBeDefined();
    expect(rgb!).toEqual(hexRgb(record.color));
  }
  const black = byId.get("black-text");
  expect(black, "A black glyph interior must remain sampled through the yellow mark").toBeDefined();
  expect(Math.max(...black!)).toBeLessThanOrEqual(8);
});
