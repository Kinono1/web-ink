import { getStroke } from "perfect-freehand";
import type { ImageShape, Point, Settings, ShapeKind } from "../core/model";
import type { ImageGeometry } from "../core/geometry";
import { imageToClient } from "../core/geometry";

const NS = "http://www.w3.org/2000/svg";
export function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs))
    element.setAttribute(key, String(value));
  return element;
}
export function renderShape(
  shape: ImageShape,
  geometry: ImageGeometry,
  color: string,
): SVGElement {
  const points = shape.points.map((p) => imageToClient(p, geometry));
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
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const size = Math.max(9, width * 4);
    const left = {
      x: last.x - size * Math.cos(angle - Math.PI / 6),
      y: last.y - size * Math.sin(angle - Math.PI / 6),
    };
    const right = {
      x: last.x - size * Math.cos(angle + Math.PI / 6),
      y: last.y - size * Math.sin(angle + Math.PI / 6),
    };
    return svgElement("path", {
      ...attrs,
      d: `M ${first.x} ${first.y} L ${last.x} ${last.y} M ${left.x} ${left.y} L ${last.x} ${last.y} L ${right.x} ${right.y}`,
    });
  }
  // Pressure smoothing is the only third-party drawing logic. Points remain normalized on disk.
  const outline = getStroke(
    points.map((p, i) => [p.x, p.y, shape.points[i]?.pressure ?? 0.5]),
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
      ? `${outline.map((p, i) => `${i ? "L" : "M"} ${p[0]} ${p[1]}`).join(" ")} Z`
      : "",
  });
}

export function createView() {
  const host = document.createElement("web-ink-ui");
  host.dataset.webInk = "true";
  host.dataset.webInkUi = "true";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    pointerEvents: "none",
  });
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; font: 13px/1.5 system-ui, sans-serif; color: #172235; }
    * { box-sizing: border-box; }
    button,input { font: inherit; } button { cursor: pointer; }
    button:focus-visible,input:focus-visible { outline: 3px solid #38bdf8; outline-offset: 2px; }
    .bar { position: fixed; display:flex; align-items:center; gap:6px; padding:8px; background:#fff;
      border:1px solid #dbe3ef; border-radius:12px; box-shadow:0 6px 24px #17223526; pointer-events:auto; }
    .selection { display:none; } .drawing { top:14px; left:50%; transform:translateX(-50%); display:none; flex-wrap:wrap; max-width:calc(100vw - 24px); }
    button { border:1px solid #dce4ef; background:#f8fafc; color:#22334d; padding:5px 9px; border-radius:7px; min-height:30px; }
    button[aria-pressed=true] { border-color:#1d4ed8; background:#e8f0ff; color:#163b82; }
    .swatch { width:26px; height:26px; min-height:26px; padding:0; border-radius:50%; border:2px solid #ffffff; box-shadow:0 0 0 1px #d6deeb; }
    input[type=color] { width:30px; height:30px; padding:0; border:0; background:transparent; }
    .toast { display:none; position:fixed; bottom:22px; left:50%; transform:translateX(-50%); max-width:min(560px,90vw);
      border:1px solid #ccd8e8; background:#fff; border-radius:10px; padding:10px 14px; box-shadow:0 6px 24px #17223526; pointer-events:auto; }
    .toast.error { border-color:#dc2626; color:#991b1b; } .hint { color:#64748b; padding:0 4px; }
    svg.layer { position:fixed; inset:0; width:100vw; height:100vh; overflow:hidden; pointer-events:none; }
  `;
  const svg = svgElement("svg", { class: "layer", "aria-hidden": "true" });
  const selection = document.createElement("div");
  selection.className = "bar selection";
  selection.setAttribute("role", "toolbar");
  selection.setAttribute("aria-label", "Web Ink highlight colors");
  const drawing = document.createElement("div");
  drawing.className = "bar drawing";
  drawing.setAttribute("role", "toolbar");
  drawing.setAttribute("aria-label", "Web Ink image tools");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  root.append(style, svg, selection, drawing, toast);
  document.documentElement.append(host);
  return { host, root, svg, selection, drawing, toast };
}
export function button(
  label: string,
  action: () => void,
  title?: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.setAttribute("aria-label", title ?? label);
  b.title = title ?? label;
  b.addEventListener("click", action);
  return b;
}
