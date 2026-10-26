import { TextAnchorSession } from "../../core/text-anchor";
import { resolveImage } from "../../core/image-anchor";
import { svgElement } from "../view-lite";
import { renderShape } from "../render-shape";
import { ImageLayerManager } from "../image-layers";
import type { AnnotationController } from "./AnnotationController";

type RenderSchedulerContext = Pick<
  AnnotationController,
  | "disposed"
  | "enabled"
  | "label"
  | "mode"
  | "save"
  | "store"
  | "toast"
  | "view"
>;

/** Owns DOM anchor caches and coalesced highlight/image rendering. */
export class RenderScheduler {
  readonly highlightStyle: HTMLStyleElement = document.createElement("style");
  private renderFrame: number = 0;
  readonly textSession: TextAnchorSession = new TextAnchorSession(document);
  readonly images: Map<string, HTMLImageElement> = new Map<string, HTMLImageElement>();
  readonly textRanges: Map<string, Range> = new Map<string, Range>();
  private highlightNames: Set<string> = new Set<string>();
  readonly imageLayers: ImageLayerManager;
  readonly transientLayer: SVGGElement = svgElement("g", { "data-web-ink-transient": "true" });
  private focusId: string | undefined;

  constructor(private readonly engine: RenderSchedulerContext) {
    this.imageLayers = new ImageLayerManager(this.engine.view.svg);
    this.highlightStyle.dataset.webInk = "true";
    document.documentElement.append(this.highlightStyle);
  }

  clearText = () => {
    if (typeof CSS !== "undefined" && "highlights" in CSS)
      for (const name of this.highlightNames) CSS.highlights.delete(name);
    this.highlightNames.clear();
    this.textRanges.clear();
    this.highlightStyle.textContent = "";
  };

  applyTextStyles = () => {
    if (
      typeof CSS === "undefined" ||
      !("highlights" in CSS) ||
      typeof Highlight === "undefined"
    )
      return;
    for (const name of this.highlightNames) CSS.highlights.delete(name);
    this.highlightNames.clear();
    const groups = new Map<string, Range[]>();
    for (const record of this.engine.store.annotations)
      if (record.kind === "text") {
        const range = this.textRanges.get(record.id);
        if (!range) continue;
        const group = groups.get(record.color) ?? [];
        group.push(range);
        groups.set(record.color, group);
      }
    const rules: string[] = [];
    for (const [color, ranges] of groups) {
      const name = `web-ink-${color.slice(1)}`;
      CSS.highlights.set(name, new Highlight(...ranges));
      this.highlightNames.add(name);
      rules.push(
        `::highlight(${name}) { background-color: ${color}99; color: inherit; }`,
      );
    }
    this.highlightStyle.textContent = rules.join("\n");
  };

  paintImages = () => {
    const { enabled, store, mode, save, view } = this.engine;
    this.renderFrame = 0;
    if (this.engine.disposed) return;
    if (!enabled()) return;
    this.imageLayers.beginPaint();
    this.transientLayer.replaceChildren();
    const validLayers = new Set<string>();
    for (const record of store.annotations)
      if (record.kind === "image") {
        validLayers.add(record.id);
        const image = this.images.get(record.id);
        if (image?.isConnected) this.imageLayers.draw(record, image, this.focusId);
        else this.imageLayers.hide(record.id);
      }
    if (mode.selectedImage?.isConnected) {
      const geometry = this.imageLayers.clippedGeometry(mode.selectedImage);
      if (geometry)
        this.transientLayer.append(
          svgElement("rect", {
            ...geometry.clipRect,
            fill: "none",
            stroke: "#2563eb",
            "stroke-width": 1,
            "stroke-dasharray": "5 4",
          }),
        );
      if (mode.previewShape && geometry)
        this.transientLayer.append(
          renderShape(mode.previewShape, geometry, mode.currentColor),
        );
    }
    if (save.unsaved?.kind === "image") {
      validLayers.add(`${save.unsaved.id}-unsaved`);
      const match = resolveImage(save.unsaved.target);
      if (match.image)
        this.imageLayers.draw(save.unsaved, match.image, this.focusId, "-unsaved");
    }
    this.imageLayers.reconcile(validLayers);
    view.svg.append(this.transientLayer);
  };

  schedulePaint = () => {
    if (!this.renderFrame && !this.engine.disposed)
      this.renderFrame = requestAnimationFrame(this.paintImages);
  };

  focusRecord = (id?: string) => {
    const range = id ? this.textRanges.get(id) : undefined;
    const image = id ? this.images.get(id) : undefined;
    if (range) {
      const node =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      node?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (image)
      image.scrollIntoView({ block: "center", behavior: "smooth" });
    else
      this.engine.toast(
        this.engine.label(
          "找不到原位置，可在侧栏选择重新定位。",
          "Original location not found. Use Rebind in the sidebar.",
        ),
        true,
      );
    this.focusId = id;
    this.schedulePaint();
  };

  dispose = () => {
    const { view } = this.engine;
    this.textSession.dispose();
    cancelAnimationFrame(this.renderFrame);
    this.clearText();
    // The bootstrap keeps the host alive; every engine-owned visual must go away.
    view.svg.replaceChildren();
    view.svg.style.pointerEvents = "none";
    view.svg.style.cursor = "";
    this.images.clear();
    this.imageLayers.clear();
    this.highlightStyle.remove();
  };
}
