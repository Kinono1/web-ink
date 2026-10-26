import { clientToImage } from "../../core/geometry";
import type {
  Annotation, ImageAnnotation, ImageShape, Point, ShapeKind,
} from "../../core/model";
import { captureImage } from "../../core/image-anchor";
import { button, separator } from "../view-lite";
import { ICON_PATHS } from "../../ui/icons";
import type { AnnotationController } from "./AnnotationController";
import { glyph } from "./controls";

type ModeManagerContext = Pick<
  AnnotationController,
  | "enabled"
  | "fail"
  | "interactions"
  | "label"
  | "render"
  | "save"
  | "settings"
  | "toast"
  | "view"
>;

/** Owns image rebind mode and its transient drawing controls. */
export class ModeManager {
  rebinding: Annotation | undefined;
  mode: "idle" | "choose-image" | "drawing" = "idle";
  selectedImage: HTMLImageElement | undefined;
  private shapeKind: ShapeKind = "rectangle";
  currentColor: string;
  private drawingPoints: Point[] = [];
  private drawingPointer: number | undefined;
  previewShape: ImageShape | undefined;

  constructor(private readonly engine: ModeManagerContext) {
    this.currentColor = this.engine.settings.defaultColor;
  }

  exitDrawing = () => {
    const { view, render } = this.engine;
    this.mode = "idle";
    this.selectedImage = undefined;
    this.drawingPointer = undefined;
    this.drawingPoints = [];
    this.previewShape = undefined;
    view.svg.style.pointerEvents = "none";
    view.svg.style.cursor = "";
    view.drawing.style.display = "none";
    render.schedulePaint();
  };

  drawingToolbar = () => {
    const { view, label, save } = this.engine;
    view.drawing.replaceChildren();
    const title = document.createElement("span");
    title.className = "brand";
    title.textContent = "Web Ink";
    view.drawing.append(title, separator());
    if (this.mode === "choose-image") {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = label(
        "点击网页中的图片以重新绑定",
        "Click an image to rebind this annotation",
      );
      view.drawing.append(hint, button(label("完成", "Done"), this.exitDrawing));
      view.drawing.style.display = "flex";
      return;
    }
    const iconButton = (title: string, path: string, run: () => void) => {
      const control = button("", run, title);
      control.className = "icon";
      control.append(glyph(path));
      return control;
    };
    const kinds: Array<[ShapeKind, string, string, string]> = [
      ["rectangle", "方框", "Rectangle", "M4 5h16v14H4z"],
      ["ellipse", "椭圆", "Ellipse", "M4 12a8 5.5 0 1 0 16 0 8 5.5 0 1 0-16 0"],
      ["arrow", "箭头", "Arrow", "M4 12h14m-5-5 5 5-5 5"],
      ["pen", "画笔", "Pen", ICON_PATHS.draw],
    ];
    for (const [kind, cn, en, path] of kinds) {
      const b = iconButton(label(cn, en), path, () => {
        this.shapeKind = kind;
        this.drawingToolbar();
      });
      b.setAttribute("aria-pressed", String(this.shapeKind === kind));
      view.drawing.append(b);
    }
    const color = document.createElement("input");
    color.type = "color";
    color.value = this.currentColor;
    color.setAttribute("aria-label", label("画笔颜色", "Drawing color"));
    color.addEventListener("input", () => {
      this.currentColor = color.value;
    });
    view.drawing.append(
      color,
      separator(),
      iconButton(
        label("撤销", "Undo"),
        "M8 7 4 11l4 4M5 11h8a5 5 0 1 1 0 10",
        () => {
          void save.undoDrawing();
        },
      ),
      iconButton(
        label("重做", "Redo"),
        "m16 7 4 4-4 4m3-4h-8a5 5 0 1 0 0 10",
        () => {
          void save.redoDrawing();
        },
      ),
      separator(),
      iconButton(label("换图片", "Pick image"), ICON_PATHS.image, () => {
        this.selectedImage = undefined;
        this.mode = "choose-image";
        view.svg.style.pointerEvents = "none";
        this.drawingToolbar();
      }),
      iconButton(label("完成", "Done"), "m5 12 4 4L19 6", this.exitDrawing),
    );
    view.drawing.style.display = "flex";
  };

  chooseImage = (image: HTMLImageElement) => {
    const { render, toast, label, save, fail } = this.engine;
    if (!render.imageLayers.supports(image)) {
      toast(
        label(
          "此图片尚未加载，或使用了暂不支持的变换。",
          "Image is not loaded or has an unsupported transform.",
        ),
        true,
      );
      return;
    }
    if (this.rebinding?.kind === "image") {
      try {
        void save.commit({
          ...this.rebinding,
          target: captureImage(image),
          updatedAt: new Date().toISOString(),
        });
        this.exitDrawing();
      } catch (error) {
        fail(error);
      }
      return;
    }
    // A completed save can clear a newer rebind; never fall back to drawing.
    this.exitDrawing();
  };

  startDrawing = () => {
    const { enabled, toast, label, interactions, view } = this.engine;
    if (!enabled()) {
      toast(label("请先启用此网站。", "Enable this site first."), true);
      return;
    }
    interactions.hideSelection();
    this.mode = "choose-image";
    this.selectedImage = undefined;
    view.svg.style.pointerEvents = "none";
    this.drawingToolbar();
    toast(
      label(
        "点击网页中的图片以重新绑定。Esc 退出。",
        "Click an image to rebind this annotation. Esc to exit.",
      ),
    );
  };

  onPointerDown = (e: PointerEvent) => {
    const { save, render, view } = this.engine;
    if (
      this.mode !== "drawing" ||
      !this.selectedImage ||
      save.pendingSave ||
      save.unsaved ||
      e.button !== 0
    )
      return;
    const geometry = render.imageLayers.clippedGeometry(this.selectedImage);
    if (!geometry) return;
    const point = clientToImage(e.clientX, e.clientY, geometry);
    if (!point) return;
    e.preventDefault();
    this.drawingPointer = e.pointerId;
    view.svg.setPointerCapture(e.pointerId);
    this.drawingPoints = [{ ...point, pressure: e.pressure || 0.5 }];
    this.previewShape = {
      kind: this.shapeKind,
      points: this.drawingPoints,
      width: 3 / geometry.imageRect.width,
    };
  };

  onPointerMove = (e: PointerEvent) => {
    if (this.drawingPointer !== e.pointerId || !this.selectedImage || !this.previewShape)
      return;
    const geometry = this.engine.render.imageLayers.clippedGeometry(this.selectedImage);
    if (!geometry) return;
    const point = clientToImage(e.clientX, e.clientY, geometry);
    if (!point) return;
    if (this.shapeKind === "pen") {
      if (this.drawingPoints.length < 2000)
        this.drawingPoints.push({ ...point, pressure: e.pressure || 0.5 });
    } else this.drawingPoints = [this.drawingPoints[0]!, point];
    this.previewShape = { ...this.previewShape, points: this.drawingPoints };
    this.engine.render.schedulePaint();
  };

  onPointerCancel = () => {
    this.drawingPointer = undefined;
    this.previewShape = undefined;
    this.engine.render.schedulePaint();
  };

  onPointerUp = (e: PointerEvent) => {
    const { view, save, fail } = this.engine;
    if (e.pointerId !== this.drawingPointer || !this.selectedImage || !this.previewShape)
      return;
    this.drawingPointer = undefined;
    if (view.svg.hasPointerCapture(e.pointerId))
      view.svg.releasePointerCapture(e.pointerId);
    const shape = this.previewShape;
    this.previewShape = undefined;
    if (shape.points.length < 2) return;
    const a = shape.points[0]!,
      b = shape.points.at(-1)!;
    if (shape.kind !== "pen" && Math.hypot(a.x - b.x, a.y - b.y) < 0.003)
      return;
    try {
      const record: ImageAnnotation = {
        ...save.baseRecord(this.currentColor),
        kind: "image",
        target: captureImage(this.selectedImage),
        shape,
      };
      void save.commit(record, true);
    } catch (error) {
      fail(error);
    }
  };
}
