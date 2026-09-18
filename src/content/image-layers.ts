import type { ImageAnnotation } from "../core/model";
import { getImageGeometry, type ImageGeometry } from "../core/geometry";
import { renderShape } from "./render-shape";
import { svgElement } from "./view-lite";

export type ImageLayer = {
  group: SVGGElement;
  clip: SVGRectElement;
  shape?: SVGElement;
  shapeKey?: string;
};

/** Owns the live SVG nodes for persisted image annotations in one engine run. */
export class ImageLayerManager {
  private readonly layers = new Map<string, ImageLayer>();
  // Geometry is valid only for one rAF paint: scroll, resize, and layout changes
  // schedule a new paint and must recompute it.
  private readonly paintGeometry = new Map<
    HTMLImageElement,
    ImageGeometry | null
  >();

  constructor(private readonly svg: SVGSVGElement) {}

  /** Matches the drawing-mode admission rule before any viewport clipping. */
  supports(image: HTMLImageElement): boolean {
    return getImageGeometry(image) !== null;
  }

  /** Apply viewport and ancestor overflow clipping to an image's content box. */
  clippedGeometry(image: HTMLImageElement): ImageGeometry | null {
    const geometry = getImageGeometry(image);
    if (!geometry) return null;
    let left = Math.max(0, geometry.clipRect.x);
    let top = Math.max(0, geometry.clipRect.y);
    let right = Math.min(
      innerWidth,
      geometry.clipRect.x + geometry.clipRect.width,
    );
    let bottom = Math.min(
      innerHeight,
      geometry.clipRect.y + geometry.clipRect.height,
    );
    for (
      let parent = image.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.right);
      }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
    }
    if (right <= left || bottom <= top) return null;
    return {
      imageRect: geometry.imageRect,
      clipRect: { x: left, y: top, width: right - left, height: bottom - top },
    };
  }

  shapeFor(id: string): SVGElement | undefined {
    return this.layers.get(id)?.shape;
  }

  beginPaint(): void {
    this.paintGeometry.clear();
  }

  draw(
    record: ImageAnnotation,
    image: HTMLImageElement,
    focusId?: string,
    suffix = "",
  ): void {
    const key = `${record.id}${suffix}`;
    let layer = this.layers.get(key);
    const geometry = this.geometryForPaint(image);
    if (!geometry) {
      if (layer) layer.group.style.display = "none";
      return;
    }
    if (!layer) {
      const clipId = `clip-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const defs = svgElement("defs");
      const clipPath = svgElement("clipPath", { id: clipId });
      const clip = svgElement("rect");
      clipPath.append(clip);
      defs.append(clipPath);
      const group = svgElement("g", {
        "clip-path": `url(#${clipId})`,
        "data-annotation-id": record.id,
      });
      group.append(defs);
      this.svg.append(group);
      layer = { group, clip };
      this.layers.set(key, layer);
    }
    const visible =
      geometry.clipRect.x < innerWidth &&
      geometry.clipRect.y < innerHeight &&
      geometry.clipRect.x + geometry.clipRect.width > 0 &&
      geometry.clipRect.y + geometry.clipRect.height > 0;
    layer.group.style.display = visible ? "" : "none";
    if (!visible) return;
    const local = {
      imageRect: {
        x: 0,
        y: 0,
        width: geometry.imageRect.width,
        height: geometry.imageRect.height,
      },
      clipRect: {
        x: geometry.clipRect.x - geometry.imageRect.x,
        y: geometry.clipRect.y - geometry.imageRect.y,
        width: geometry.clipRect.width,
        height: geometry.clipRect.height,
      },
    };
    layer.group.setAttribute(
      "transform",
      `translate(${geometry.imageRect.x} ${geometry.imageRect.y})`,
    );
    layer.clip.setAttribute("x", String(local.clipRect.x));
    layer.clip.setAttribute("y", String(local.clipRect.y));
    layer.clip.setAttribute("width", String(local.clipRect.width));
    layer.clip.setAttribute("height", String(local.clipRect.height));
    const shapeKey = `${record.revision}:${record.color}:${record.shape.kind}:${record.shape.width}:${JSON.stringify(record.shape.points)}:${local.imageRect.width}:${local.imageRect.height}`;
    if (layer.shapeKey !== shapeKey) {
      layer.shape?.remove();
      layer.shape = renderShape(record.shape, local, record.color);
      layer.group.append(layer.shape);
      layer.shapeKey = shapeKey;
    }
    if (record.id === focusId) layer.shape?.setAttribute("opacity", "0.6");
    else layer.shape?.removeAttribute("opacity");
  }

  hide(id: string): void {
    const layer = this.layers.get(id);
    if (layer) layer.group.style.display = "none";
  }

  drop(id: string): void {
    for (const [key, layer] of this.layers)
      if (key === id || key.startsWith(`${id}-`)) {
        layer.group.remove();
        this.layers.delete(key);
      }
  }

  reconcile(validKeys: ReadonlySet<string>): void {
    for (const [key, layer] of this.layers)
      if (!validKeys.has(key)) {
        layer.group.remove();
        this.layers.delete(key);
      }
  }

  clear(): void {
    for (const layer of this.layers.values()) layer.group.remove();
    this.layers.clear();
    this.paintGeometry.clear();
  }

  private geometryForPaint(image: HTMLImageElement): ImageGeometry | null {
    if (this.paintGeometry.has(image)) return this.paintGeometry.get(image)!;
    const geometry = this.clippedGeometry(image);
    this.paintGeometry.set(image, geometry);
    return geometry;
  }
}
