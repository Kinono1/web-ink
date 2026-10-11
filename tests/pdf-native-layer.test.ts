import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import type { PdfApi } from "../src/pdf/types";
import { createNativeLayer } from "../src/pdf/native-layer";

let api: PdfApi;
beforeAll(async () => {
  // The DOM layer needs no raster matrix operations; JSDOM omits DOMMatrix.
  vi.stubGlobal("DOMMatrix", class {});
  api = await import("pdfjs-dist/legacy/build/pdf.mjs");
  vi.unstubAllGlobals();
});
const page = { view: [0, 0, 600, 800] } as unknown as PDFPageProxy;
const viewport = {
  width: 600, height: 800, scale: 1, rotation: 0,
  rawDims: { pageWidth: 600, pageHeight: 800, pageX: 0, pageY: 0 },
  clone: () => viewport,
} as unknown as PageViewport;
const note = (id: string, extra: Record<string, unknown> = {}) => ({
  id, subtype: "Text", rect: [20, 40, 40, 60], borderStyle: { width: 1 }, rotation: 0,
  contentsObj: { str: "Original plain-text note", dir: "ltr" }, titleObj: { str: "Author", dir: "ltr" },
  color: new Uint8ClampedArray([255, 255, 0]), ...extra,
});

describe("safe official original PDF layer", () => {
  it("exposes only HTTPS links while omitting scripts, Launch, forms, media and embedded files", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const layer = await createNativeLayer(api, page, viewport, [
      note("valid", { subtype: "Link", url: "https://example.test/paper#section", actions: new Map([["Mouse Up", ["alert(1)"]]]) }),
      ...["javascript:alert(1)", "http://example.test/", "file:///private/p.pdf", "data:text/html,script", "https://user:secret@example.test/"].map((url, i) => note(`unsafe-${i}`, { subtype: "Link", url })),
      note("launch", { subtype: "Link", action: "Launch", dest: "external.pdf" }),
      note("form", { subtype: "Widget", fieldType: "Tx", fieldValue: "Sensitive data" }),
      note("embedded", { subtype: "FileAttachment", file: { content: new Uint8Array([1]), filename: "file.pdf" } }),
      note("movie", { subtype: "Movie", url: "https://example.test/autoplay" }),
    ], "/pdfjs/images/");
    try {
      const links = [...layer.div.querySelectorAll("a")];
      expect(links.map(link => link.href)).toEqual(["https://example.test/paper#section"]);
      expect(links[0]?.target).toBe("_blank");
      expect(links[0]?.rel).toBe("noopener noreferrer");
      expect(layer.div.querySelectorAll("input, textarea, select, iframe, video, audio, object, embed")).toHaveLength(0);
      expect(layer.div.querySelectorAll("section")).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally { layer.destroy(); fetch.mockRestore(); }
  });

  it("uses a fixed local note icon and plain text instead of PDF-controlled rich HTML or image paths", async () => {
    const raw = note("unsafe-rich", { name: "../../remote/attack", open: true,
      richText: { str: "Plain rich fallback", html: { name: "img", attributes: { src: "https://example.test/track" } } } });
    const layer = await createNativeLayer(api, page, viewport, [raw], "/pdfjs/images/");
    try {
      expect(layer.div.querySelector("img")?.getAttribute("src")).toBe("/pdfjs/images/annotation-note.svg");
      expect(layer.div.querySelectorAll("a")).toHaveLength(0);
      expect(layer.div.querySelector(".popupAnnotation")?.hasAttribute("hidden")).toBe(true);
      layer.div.querySelector(".textAnnotation")?.dispatchEvent(new MouseEvent("click"));
      expect(layer.div.querySelector(".popupContent")?.textContent).toBe("Original plain-text note");
      expect(layer.div.querySelector(".popup img")).toBeNull();
      expect((raw as Record<string, unknown>).name).toBe("../../remote/attack");
    } finally { layer.destroy(); }
  });

  it("keeps an existing Text appearance on canvas exactly once with a transparent official hit target", async () => {
    const raw = note("existing-ap", { hasAppearance: true });
    const originalRect = raw.rect;
    const layer = await createNativeLayer(api, page, viewport, [raw], "/pdfjs/images/");
    try {
      const hit = layer.div.querySelector<HTMLElement>('[data-annotation-id="existing-ap"]')!;
      expect(hit).not.toBeNull();
      expect(hit.querySelector("img, canvas")).toBeNull();
      expect(hit.style.borderWidth).toBe("");
      hit.dispatchEvent(new MouseEvent("click"));
      expect(layer.div.querySelector(".popupContent")?.textContent).toBe("Original plain-text note");
      expect(raw.rect).toBe(originalRect);
      expect(raw.rect).toEqual([20, 40, 40, 60]);
    } finally { layer.destroy(); }
    expect(layer.div.childElementCount).toBe(0);
  });

  it("does not show a normalized invented date for an invalid original PDF date", async () => {
    const layer = await createNativeLayer(api, page, viewport, [
      note("invalid-date", { modificationDate: "D:20230229090102Z" }),
    ], "/pdfjs/images/");
    try {
      layer.div.querySelector(".textAnnotation")?.dispatchEvent(new MouseEvent("click"));
      expect(layer.div.querySelector(".popupDate")).toBeNull();
    } finally { layer.destroy(); }
  });

  it("keeps rich-text-only original notes readable as inert plain text", async () => {
    const layer = await createNativeLayer(api, page, viewport, [
      note("rich-only", { contentsObj: { str: "" }, richText: {
        str: "Original rich-only body", html: { name: "a", attributes: { href: "javascript:alert(1)" } },
      } }),
    ], "/pdfjs/images/");
    try {
      layer.div.querySelector(".textAnnotation")?.dispatchEvent(new MouseEvent("click"));
      expect(layer.div.querySelector(".popupContent")?.textContent).toBe("Original rich-only body");
      expect(layer.div.querySelector(".popup a")).toBeNull();
    } finally { layer.destroy(); }
  });
});
