import { svgElement } from "../view-lite";

export function glyph(path: string, strokeWidth = 1.8) {
  const icon = svgElement("svg", {
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
  });
  icon.append(
    svgElement("path", {
      d: path,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": strokeWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  return icon;
}
