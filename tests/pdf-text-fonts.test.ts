import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { alignPdfTextFonts } from "../src/pdf/text-fonts";

let context: CanvasRenderingContext2D;
let measuredWidth: number;
let measuredFonts: string[];

beforeEach(() => {
  vi.stubGlobal("devicePixelRatio", 2);
  measuredWidth = 80;
  measuredFonts = [];
  // JSDOM has no canvas text metrics; keep font selection and DOM updates real.
  context = {
    font: "10px sans-serif",
    measureText(this: CanvasRenderingContext2D) {
      measuredFonts.push(this.font);
      return { width: measuredWidth } as TextMetrics;
    },
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function item(overrides: Partial<TextItem> = {}): TextItem {
  return { str: "priors are dynamically", dir: "ltr", transform: [10, 0, 0, 10, 12, 24],
    width: 120, height: 10, fontName: "f1", hasEOL: false, ...overrides };
}
function span(): HTMLSpanElement {
  const element = document.createElement("span");
  element.textContent = "priors are dynamically";
  element.style.cssText = "left:12%;top:24%;font-family:sans-serif;font-weight:400;font-style:normal;--scale-x:1.25;--font-height:10px";
  return element;
}
function page(fonts: Record<string, unknown>): Pick<PDFPageProxy, "commonObjs"> {
  return { commonObjs: { get: (name: string) => fonts[name] } } as unknown as Pick<PDFPageProxy, "commonObjs">;
}

it.each([
  ["APJJEB+Helvetica-Bold", "700", "normal"],
  ["Helvetica-SemiBold", "700", "normal"],
  ["Helvetica-DemiBold", "700", "normal"],
  ["Helvetica-Black", "700", "normal"],
  ["Helvetica-Heavy", "700", "normal"],
  ["Helvetica-Italic", "400", "italic"],
  ["Helvetica-Oblique", "400", "italic"],
  ["TimesNewRomanPS-BoldItalicMT", "700", "italic"],
  ["Helvetica-BoldOblique", "700", "italic"],
])("aligns explicit style %s while preserving the PDF.js family and item width", (name, weight, style) => {
  const element = span();
  alignPdfTextFonts(page({ f1: { name } }), { textDivs: [element] }, [item()], 2);
  expect(element.style.fontWeight).toBe(weight);
  expect(element.style.fontStyle).toBe(style);
  expect(element.style.fontFamily).toBe("sans-serif");
  expect(element.style.getPropertyValue("--scale-x")).toBe("6");
  expect(80 * Number(element.style.getPropertyValue("--scale-x"))).toBe(480);
  expect(measuredFonts).toEqual([`${style} ${weight} 40px sans-serif`]);
  expect(element.style.left).toBe("12%");
  expect(element.style.top).toBe("24%");
  expect(element.style.getPropertyValue("--font-height")).toBe("10px");
  expect(element.textContent).toBe("priors are dynamically");
});

it.each([
  "APJJEB+Helvetica", "Helvetica-Regular", "notbold", "Helvetica-NotBold",
  "Bold-Regular", "Italicized-Regular", "Helvetica-Boldface", "Helvetica-Heavyweight",
])("leaves a plain font or non-style name %s untouched", name => {
  const element = span(), original = element.style.cssText;
  alignPdfTextFonts(page({ f1: { name } }), { textDivs: [element] }, [item()], 1);
  expect(element.style.cssText).toBe(original);
  expect(measuredFonts).toEqual([]);
});

it.each([undefined, null, {}, { name: 700 }, { name: "" }, { name: "x".repeat(201) }, { name: "Helvetica-Bold\n" }])(
  "leaves unresolved or invalid font metadata unchanged: %j", font => {
    const element = span(), original = element.style.cssText;
    expect(() => alignPdfTextFonts(page({ f1: font }), { textDivs: [element] }, [item()], 1)).not.toThrow();
    expect(element.style.cssText).toBe(original);
  },
);

it("ignores a font object that has not resolved", () => {
  const element = span(), original = element.style.cssText;
  const unresolved = { commonObjs: { get() { throw new Error("unresolved font"); } } } as unknown as Pick<PDFPageProxy, "commonObjs">;
  expect(() => alignPdfTextFonts(unresolved, { textDivs: [element] }, [item()], 1)).not.toThrow();
  expect(element.style.cssText).toBe(original);
});

it.each([0, -1, NaN, Infinity])("keeps the original style when text width cannot be measured: %s", width => {
  measuredWidth = width;
  const element = span(), original = element.style.cssText;
  expect(() => alignPdfTextFonts(page({ f1: { name: "Helvetica-Bold" } }), { textDivs: [element] }, [item()], 1)).not.toThrow();
  expect(element.style.cssText).toBe(original);
});

it.each(["missing", "throws"])("keeps the original style when canvas measurement %s", failure => {
  if (failure === "missing") vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
  else context.measureText = () => { throw new Error("measurement unavailable"); };
  const element = span(), original = element.style.cssText;
  expect(() => alignPdfTextFonts(page({ f1: { name: "Helvetica-Bold" } }), { textDivs: [element] }, [item()], 1)).not.toThrow();
  expect(element.style.cssText).toBe(original);
});

it("skips vertical text", () => {
  const element = span(), original = element.style.cssText;
  alignPdfTextFonts(page({ f1: { name: "Helvetica-Bold" } }), { textDivs: [element] }, [item({ dir: "ttb" })], 1);
  expect(element.style.cssText).toBe(original);
});

it.each([{ width: 0 }, { transform: [10, 0, 0, NaN, 12, 24] }])("does not change invalid item geometry: %j", invalid => {
  const element = span(), original = element.style.cssText;
  alignPdfTextFonts(page({ f1: { name: "Helvetica-Bold" } }), { textDivs: [element] }, [item(invalid)], 1);
  expect(element.style.cssText).toBe(original);
});

it("keeps empty items in the text-layer index without styling their neighbour", () => {
  const empty = span(), plain = span(), bold = span();
  empty.textContent = "";
  const emptyStyle = empty.style.cssText, plainStyle = plain.style.cssText;
  alignPdfTextFonts(page({ f1: { name: "Helvetica" }, f2: { name: "Helvetica-Bold" } }),
    { textDivs: [empty, plain, bold] },
    [item({ str: "", width: 0 }), item(), item({ fontName: "f2" })], 1);
  expect(empty.style.cssText).toBe(emptyStyle);
  expect(plain.style.cssText).toBe(plainStyle);
  expect(bold.style.fontWeight).toBe("700");
  expect(bold.style.getPropertyValue("--scale-x")).toBe("3");
});

it("styles a single glyph without replacing its existing horizontal scale", () => {
  const element = span();
  element.textContent = "A";
  alignPdfTextFonts(page({ f1: { name: "Helvetica-Bold" } }), { textDivs: [element] }, [item({ str: "A" })], 1);
  expect(element.style.fontWeight).toBe("700");
  expect(element.style.getPropertyValue("--scale-x")).toBe("1.25");
});

it("uses viewport scale, device ratio and the transform's font height", () => {
  vi.stubGlobal("devicePixelRatio", 1);
  measuredWidth = 50;
  const element = span();
  alignPdfTextFonts(page({ f1: { name: "Helvetica-Bold" } }), { textDivs: [element] },
    [item({ transform: [10, 0, 6, 8, 12, 24] })], 1.5);
  expect(measuredFonts).toEqual(["normal 700 15px sans-serif"]);
  expect(element.style.getPropertyValue("--scale-x")).toBe("3.6");
});

it("calibrates different styled spans with one canvas context", () => {
  const bold = span(), italic = span();
  alignPdfTextFonts(page({ f1: { name: "Helvetica-Bold" }, f2: { name: "Helvetica-Italic" } }),
    { textDivs: [bold, italic] }, [item(), item({ fontName: "f2", width: 60 })], 1);
  expect(bold.style.fontWeight).toBe("700");
  expect(bold.style.getPropertyValue("--scale-x")).toBe("3");
  expect(italic.style.fontStyle).toBe("italic");
  expect(italic.style.getPropertyValue("--scale-x")).toBe("1.5");
  expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledTimes(1);
});
