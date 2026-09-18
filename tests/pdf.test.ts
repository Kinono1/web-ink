import { describe, expect, it } from "vitest";
import { fromPdfRect, toPdfRect, type PdfViewport } from "../src/pdf/geometry";
import {
  MAX_PDF_BYTES,
  pdfSourceUrl,
  readLocalPdf,
  readRemotePdf,
  verifyPdf,
} from "../src/pdf/source";
import { PageLayoutIndex } from "../src/pdf/layout";
import { PdfSession } from "../src/pdf/session";
import { fixturePdf } from "./pdf-fixture";
function viewport(rotation: number, scale: number): PdfViewport {
  const transform = (x: number, y: number): number[] =>
    rotation === 0
      ? [x * scale, (800 - y) * scale]
      : rotation === 90
        ? [y * scale, x * scale]
        : rotation === 180
          ? [(600 - x) * scale, y * scale]
          : [(800 - y) * scale, (600 - x) * scale];
  const inverse = (x: number, y: number): number[] =>
    rotation === 0
      ? [x / scale, 800 - y / scale]
      : rotation === 90
        ? [y / scale, x / scale]
        : rotation === 180
          ? [600 - x / scale, y / scale]
          : [600 - y / scale, 800 - x / scale];
  return {
    width: (rotation % 180 ? 800 : 600) * scale,
    height: (rotation % 180 ? 600 : 800) * scale,
    convertToViewportPoint: transform,
    convertToPdfPoint: inverse,
  };
}
describe("PDF coordinate identity", () => {
  for (const rotation of [0, 90, 180, 270])
    for (const scale of [0.5, 1, 2.5])
      it(`restores original coordinates at ${rotation} degrees / ${scale} scale`, () => {
        const stored = { x: 0.17, y: 0.29, width: 0.34, height: 0.21 };
        const v = viewport(rotation, scale),
          view = fromPdfRect(stored, v, [0, 0, 600, 800]);
        const back = toPdfRect(
          {
            left: view.x,
            top: view.y,
            right: view.x + view.width,
            bottom: view.y + view.height,
          },
          v,
          [0, 0, 600, 800],
        )!;
        for (const k of ["x", "y", "width", "height"] as const)
          expect(back[k]).toBeCloseTo(stored[k], 8);
      });
  it("rejects empty rectangles and clamps selection outside the page", () => {
    const v = viewport(0, 1);
    expect(
      toPdfRect({ left: 0, top: 0, right: 0, bottom: 0 }, v, [0, 0, 600, 800]),
    ).toBeUndefined();
    expect(
      toPdfRect(
        { left: -10, top: -10, right: 700, bottom: 900 },
        v,
        [0, 0, 600, 800],
      ),
    ).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});
describe("PDF source boundary", () => {
  it("accepts public HTTPS and strips view fragments only", () => {
    expect(
      pdfSourceUrl("https://example.com/p.pdf?version=2#page=3").href,
    ).toBe("https://example.com/p.pdf?version=2");
  });
  it.each([
    "http://example.com/p.pdf",
    "file:///private/p.pdf",
    "javascript:alert(1)",
    "https://user:secret@example.com/p.pdf",
  ])("rejects unsafe source %s", (source) =>
    expect(() => pdfSourceUrl(source)).toThrow(),
  );
  it("rejects HTML login responses and files over the byte limit", () => {
    expect(() =>
      verifyPdf(new TextEncoder().encode("<html>Sign in</html>")),
    ).toThrow("not a PDF");
    expect(() => verifyPdf(new Uint8Array(MAX_PDF_BYTES + 1))).toThrow(
      "50 MiB",
    );
    expect(
      verifyPdf(new TextEncoder().encode("%PDF-1.7\nfixture")).length,
    ).toBeGreaterThan(0);
  });
  it("uses exact identity Content-Length storage and rejects truncated responses", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nidentity");
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { permissions: { contains: async () => true } },
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200, headers: { "content-length": String(bytes.length) } },
      );
    await expect(
      readRemotePdf("https://example.test/a.pdf", new AbortController().signal),
    ).resolves.toSatisfy(
      (value) => Array.from(value).join(",") === Array.from(bytes).join(","),
    );
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-length": String(bytes.length + 1) },
        },
      );
    await expect(
      readRemotePdf("https://example.test/a.pdf", new AbortController().signal),
    ).rejects.toThrow("Content-Length");
    globalThis.fetch = original;
  });
  it("does not trust compressed Content-Length as decoded allocation size", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\ncompressed-output");
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { permissions: { contains: async () => true } },
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-length": "1", "content-encoding": "gzip" },
        },
      );
    await expect(
      readRemotePdf("https://example.test/a.pdf", new AbortController().signal),
    ).resolves.toSatisfy(
      (value) => Array.from(value).join(",") === Array.from(bytes).join(","),
    );
    globalThis.fetch = original;
  });
  it.each([20, 50])(
    "accepts a real %i MiB identity PDF without chunk accumulation",
    async (mib) => {
      const base = fixturePdf();
      const bytes = fixturePdf(
        1,
        "Web Ink PDF highlights survive a return visit.",
        { paddingBytes: mib * 1024 * 1024 - base.length },
      );
      Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: { permissions: { contains: async () => true } },
      });
      const original = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              "content-length": String(bytes.length),
              "content-encoding": "identity",
            },
          },
        );
      const result = await readRemotePdf(
        "https://example.test/large.pdf",
        new AbortController().signal,
      );
      expect(result.length).toBe(mib * 1024 * 1024);
      globalThis.fetch = original;
    },
  );
  it.each([20, 50])(
    "accepts a real %i MiB local PDF as one ArrayBuffer view",
    async (mib) => {
      const base = fixturePdf();
      const bytes = fixturePdf(
        1,
        "Web Ink PDF highlights survive a return visit.",
        { paddingBytes: mib * 1024 * 1024 - base.length },
      );
      const content = new Uint8Array(bytes.length);
      content.set(bytes);
      const file = new File([content], "large.pdf", {
        type: "application/pdf",
      });
      expect((await readLocalPdf(file)).length).toBe(mib * 1024 * 1024);
    },
  );
  it("rejects 50 MiB plus one identity response before consuming its body", async () => {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { permissions: { contains: async () => true } },
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-length": String(MAX_PDF_BYTES + 1) },
      });
    await expect(
      readRemotePdf(
        "https://example.test/large.pdf",
        new AbortController().signal,
      ),
    ).rejects.toThrow("50 MiB");
    expect(cancelled).toBe(true);
    globalThis.fetch = original;
  });
});

describe("incremental PDF layout", () => {
  it("maps 1,000 mixed-height pages with local updates and stable offsets", () => {
    const layout = new PageLayoutIndex();
    layout.reset(1000, 800);
    expect(layout.offsetBefore(501)).toBe(500 * 820);
    layout.update(500, 1200);
    layout.update(1000, 400);
    expect(layout.offsetBefore(501)).toBe(499 * 820 + 1220);
    expect(layout.pageAt(layout.offsetBefore(500) + 1)).toBe(500);
    expect(layout.pageAt(layout.totalHeight() - 1)).toBe(1000);
  });
  it("keeps a mixed-size reading anchor at the same page-relative pixel after earlier measurements", () => {
    const layout = new PageLayoutIndex();
    layout.reset(500, 800);
    const anchorPage = 250,
      relative = 137;
    const before = layout.offsetBefore(anchorPage) + relative;
    const anchorBefore = layout.offsetBefore(anchorPage);
    layout.update(4, 1200);
    layout.update(120, 400);
    layout.update(249, 1000);
    const compensated = before + layout.offsetBefore(anchorPage) - anchorBefore;
    expect(layout.pageAt(compensated)).toBe(anchorPage);
    expect(compensated - layout.offsetBefore(anchorPage)).toBe(relative);
  });
});

describe("PDF session ownership", () => {
  it("invalidates A/B before C and destroys each replaced task once", async () => {
    const session = new PdfSession();
    const a = await session.begin();
    let aDestroyed = 0,
      bDestroyed = 0;
    session.setTask(a.token, {
      destroy: async () => {
        aDestroyed++;
      },
    } as any);
    const b = await session.begin();
    session.setTask(b.token, {
      destroy: async () => {
        bDestroyed++;
      },
    } as any);
    const c = await session.begin();
    expect(session.isCurrent(a.token)).toBe(false);
    expect(session.isCurrent(b.token)).toBe(false);
    expect(session.isCurrent(c.token)).toBe(true);
    expect(aDestroyed).toBe(1);
    expect(bDestroyed).toBe(1);
  });
});
