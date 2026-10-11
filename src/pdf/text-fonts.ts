import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";

/** Match known font styles without replacing PDF.js's Unicode fallback family. */
export function alignPdfTextFonts(
  page: Pick<PDFPageProxy, "commonObjs">,
  layer: { textDivs: HTMLElement[] },
  items: TextItem[],
  scale: number,
): void {
  const pixelScale = scale * (globalThis.devicePixelRatio || 1);
  if (!Number.isFinite(pixelScale) || pixelScale <= 0) return;
  let context: CanvasRenderingContext2D | null | undefined;

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const element = layer.textDivs[index];
    if (!element || !item.str || item.dir === "ttb") continue;
    let name: unknown;
    try { name = page.commonObjs.get(item.fontName)?.name; } catch { continue; }
    if (typeof name !== "string" || !name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) continue;

    let bold = false, italic = false;
    // Subset prefixes and explicit style suffixes are reliable; family names
    // such as NotBold or Boldface are not font-weight declarations.
    const tokens = name.replace(/^[A-Z]{6}\+/, "").split(/[-_,\s]+/).slice(1);
    for (const token of tokens) {
      const style = /^(?:(SemiBold|DemiBold|Bold|Black|Heavy)(Italic|Oblique)?|(Italic|Oblique))(?:MT|PS)?$/i.exec(token);
      if (!style) continue;
      bold ||= Boolean(style[1]);
      italic ||= Boolean(style[2] || style[3]);
    }
    if (!bold && !italic) continue;

    const height = Math.hypot(item.transform[2], item.transform[3]) * pixelScale;
    const width = item.width * pixelScale;
    const family = element.style.fontFamily;
    if (!family || !Number.isFinite(height) || height <= 0 || !Number.isFinite(width) || width <= 0) continue;
    const weight = bold ? "700" : element.style.fontWeight || "400";
    const style = italic ? "italic" : element.style.fontStyle || "normal";
    let measured: number;
    try {
      context ??= document.createElement("canvas").getContext("2d");
      if (!context) return;
      // Preserve PDF.js's Unicode fallback family; embedded glyph fonts can
      // use a different character mapping from the text-layer strings.
      context.font = `${style} ${weight} ${height}px ${family}`;
      measured = context.measureText(item.str).width;
    } catch { continue; }
    const horizontalScale = width / measured;
    if (!Number.isFinite(measured) || measured <= 0 || !Number.isFinite(horizontalScale) || horizontalScale <= 0) continue;

    if (bold) element.style.fontWeight = weight;
    if (italic) element.style.fontStyle = style;
    if (item.str.length > 1) element.style.setProperty("--scale-x", String(horizontalScale));
  }
}
