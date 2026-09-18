import { getStroke } from "perfect-freehand";
import type { ImageGeometry } from "../core/geometry";
import { imageToClient } from "../core/geometry";
import type { ImageShape } from "../core/model";
import { svgElement } from "./view-lite";
export function renderShape(
  shape: ImageShape,
  geometry: ImageGeometry,
  color: string,
): SVGElement {
  const points = shape.points.map((point) => imageToClient(point, geometry));
  const first = points[0] ?? { x: 0, y: 0 };
  const last = points.at(-1) ?? first;
  const width = Math.max(1, shape.width * geometry.imageRect.width);
  const attrs = {
    fill: "none",
    stroke: color,
    "stroke-width": width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  };
  if (shape.kind === "rectangle")
    return svgElement("rect", {
      ...attrs,
      x: Math.min(first.x, last.x),
      y: Math.min(first.y, last.y),
      width: Math.abs(last.x - first.x),
      height: Math.abs(last.y - first.y),
      rx: 2,
    });
  if (shape.kind === "ellipse")
    return svgElement("ellipse", {
      ...attrs,
      cx: (first.x + last.x) / 2,
      cy: (first.y + last.y) / 2,
      rx: Math.abs(last.x - first.x) / 2,
      ry: Math.abs(last.y - first.y) / 2,
    });
  if (shape.kind === "arrow") {
    const angle = Math.atan2(last.y - first.y, last.x - first.x),
      size = Math.max(9, width * 4),
      left = {
        x: last.x - size * Math.cos(angle - Math.PI / 6),
        y: last.y - size * Math.sin(angle - Math.PI / 6),
      },
      right = {
        x: last.x - size * Math.cos(angle + Math.PI / 6),
        y: last.y - size * Math.sin(angle + Math.PI / 6),
      };
    return svgElement("path", {
      ...attrs,
      d: `M ${first.x} ${first.y} L ${last.x} ${last.y} M ${left.x} ${left.y} L ${last.x} ${last.y} L ${right.x} ${right.y}`,
    });
  }
  const outline = getStroke(
    points.map((point, index) => [
      point.x,
      point.y,
      shape.points[index]?.pressure ?? 0.5,
    ]),
    {
      size: width,
      thinning: 0.2,
      smoothing: 0.55,
      streamline: 0.45,
      simulatePressure: true,
    },
  );
  return svgElement("path", {
    fill: color,
    stroke: "none",
    d: outline.length
      ? `${outline.map((point, index) => `${index ? "L" : "M"} ${point[0]} ${point[1]}`).join(" ")} Z`
      : "",
  });
}
