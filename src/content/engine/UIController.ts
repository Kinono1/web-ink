import { COLORS, type Annotation, type ImageAnnotation, type ImageShape, type Point, type Settings, type ShapeKind, type TextAnnotation } from "../../core/model";
import { clientToImage } from "../../core/geometry";
import { captureImage } from "../../core/image-anchor";
import { ICON_PATHS } from "../../core/icons";
import {
  defaultAnnotationPresets,
  presetIndexFromKey,
  readAnnotationPresets,
  type AnnotationPreset,
} from "../../core/annotation-presets";
import { SELECTION_TOOLBAR_KEY } from "../../core/selection-toolbar";
import { textLinkScope, textLinkUrl } from "../../core/text-link";
import { annotationsAtPoint, matchingTextSelection } from "../annotation-hit";
import { button, separator, svgElement, type ContentView } from "../view-lite";
import type { DataEngine } from "./DataEngine";

/** Host surface supplied by {@link AnnotationController}; the data half exists first. */
export interface UIControllerHost {
  readonly view: ContentView;
  readonly data: DataEngine;
  settings: Settings;
  disposed: boolean;
  enabled: () => boolean;
  label: (cn: string, en: string) => string;
  toast: (message: string, error?: boolean, retry?: () => void) => void;
  fail: (error: unknown) => void;
}

/**
 * Owns content interaction: image rebind/drawing modes, selection palettes and
 * shortcuts, plus browser listeners and reading-page observer lifetimes.
 */
export class UIController {
  rebinding: Annotation | undefined;
  mode: "idle" | "choose-image" | "drawing" = "idle";
  selectedImage: HTMLImageElement | undefined;
  private shapeKind: ShapeKind = "rectangle";
  currentColor: string;
  private drawingPoints: Point[] = [];
  private drawingPointer: number | undefined;
  previewShape: ImageShape | undefined;

  selectedRange: Range | undefined;
  selectionToolbarEnabled: boolean = false;
  selectionPaletteAutomatic: boolean = false;
  actionRecords: Array<TextAnnotation | ImageAnnotation> = [];
  annotationPresets: AnnotationPreset[];

  private readonly observers: AbortController = new AbortController();

  private readonly signal: AbortSignal;

  private presetStorageListenerRegistered: boolean = false;
  readonly resizeObserver: ResizeObserver;
  readonly mutationObserver: MutationObserver;

  constructor(private readonly engine: UIControllerHost) {
    this.currentColor = this.engine.settings.defaultColor;
    this.annotationPresets = defaultAnnotationPresets(
      this.engine.settings.language,
    );
    this.signal = this.observers.signal;
    this.resizeObserver = new ResizeObserver(this.engine.data.schedulePaint);
    this.mutationObserver = new MutationObserver((mutations) => {
      const relevant = mutations.filter((m) => {
        if (
          this.engine.view.host.contains(m.target) ||
          m.target === this.engine.data.highlightStyle ||
          (m.target instanceof Element && m.target.closest("[data-web-ink]"))
        )
          return false;
        // Head updates are ignored except for a base change affecting linked
        // records. Inserting styles or metadata must not trigger text rescans.
        if (document.head?.contains(m.target)) {
          const baseChanged = m.target instanceof HTMLBaseElement ||
            [...m.addedNodes, ...m.removedNodes].some(node =>
              node instanceof Element &&
              (node.tagName === "BASE" || node.querySelector("base[href]")),
            );
          return baseChanged && this.engine.data.annotations.some(record => record.kind === "text" && textLinkUrl(record.target, record.pageUrl),);
        }
        return true;
      });
      if (
        relevant.some((m) => {
          if (
            m.type !== "attributes" ||
            m.attributeName === "src" ||
            m.attributeName === "srcset" ||
            m.attributeName === "contenteditable" ||
            m.attributeName === "id" ||
            m.target instanceof HTMLBaseElement
          )
            return true; if (m.attributeName !== "href" || !(m.target instanceof HTMLAnchorElement)) return false; const link = m.target;
          // A recycled recommendation can change destination without changing its
          // title. Only affected linked annotations need another restore pass.
          return this.engine.data.annotations.some((record) => {
            if (record.kind !== "text") return false;
            const scope = textLinkScope(record.target, record.pageUrl);
            if (!scope) return false;
            const range = this.engine.data.textRanges.get(record.id);
            return link.matches(scope.selector) || Boolean(range && link.contains(range.startContainer));
          });
        })
      ) {
        this.engine.data.queueRefresh();
      }
      if (relevant.length) this.engine.data.schedulePaint();
    });
  }

  exitDrawing = () => {
    this.mode = "idle";
    this.selectedImage = undefined;
    this.drawingPointer = undefined;
    this.drawingPoints = [];
    this.previewShape = undefined;
    this.engine.view.svg.style.pointerEvents = "none";
    this.engine.view.svg.style.cursor = "";
    this.engine.view.drawing.style.display = "none";
    this.engine.data.schedulePaint();
  };

  drawingToolbar = () => {
    this.engine.view.drawing.replaceChildren();
    const title = document.createElement("span");
    title.className = "brand";
    title.textContent = "Web Ink";
    this.engine.view.drawing.append(title, separator());
    if (this.mode === "choose-image") {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = this.engine.label(
        "点击网页中的图片以重新绑定",
        "Click an image to rebind this annotation",
      );
      this.engine.view.drawing.append(hint, button(this.engine.label("完成", "Done"), this.exitDrawing));
      this.engine.view.drawing.style.display = "flex";
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
      const b = iconButton(this.engine.label(cn, en), path, () => {
        this.shapeKind = kind;
        this.drawingToolbar();
      });
      b.setAttribute("aria-pressed", String(this.shapeKind === kind));
      this.engine.view.drawing.append(b);
    }
    const color = document.createElement("input");
    color.type = "color";
    color.value = this.currentColor;
    color.setAttribute("aria-label", this.engine.label("画笔颜色", "Drawing color"));
    color.addEventListener("input", () => {
      this.currentColor = color.value;
    });
    this.engine.view.drawing.append(
      color,
      separator(),
      iconButton(
        this.engine.label("撤销", "Undo"),
        "M8 7 4 11l4 4M5 11h8a5 5 0 1 1 0 10",
        () => {
          void this.engine.data.undoDrawing();
        },
      ),
      iconButton(
        this.engine.label("重做", "Redo"),
        "m16 7 4 4-4 4m3-4h-8a5 5 0 1 0 0 10",
        () => {
          void this.engine.data.redoDrawing();
        },
      ),
      separator(),
      iconButton(this.engine.label("换图片", "Pick image"), ICON_PATHS.image, () => {
        this.selectedImage = undefined;
        this.mode = "choose-image";
        this.engine.view.svg.style.pointerEvents = "none";
        this.drawingToolbar();
      }),
      iconButton(this.engine.label("完成", "Done"), "m5 12 4 4L19 6", this.exitDrawing),
    );
    this.engine.view.drawing.style.display = "flex";
  };

  /** Error toasts are sticky-retryless variants of the controller toast. */
  private warn = (message: string) => this.engine.toast(message, true);

  chooseImage = (image: HTMLImageElement) => {
    if (!this.engine.data.imageLayers.supports(image)) {
      this.warn(this.engine.label("此图片尚未加载，或使用了暂不支持的变换。", "Image is not loaded or has an unsupported transform."));
      return;
    }
    if (this.rebinding?.kind === "image") {
      try {
        void this.engine.data.commit({
          ...this.rebinding,
          target: captureImage(image),
          updatedAt: new Date().toISOString(),
        });
        this.exitDrawing();
      } catch (error) {
        this.engine.fail(error);
      }
      return;
    }
    // A completed save can clear a newer rebind; never fall back to drawing.
    this.exitDrawing();
  };

  startDrawing = () => {
    if (!this.engine.enabled()) {
      this.warn(this.engine.label("请先启用此网站。", "Enable this site first."));
      return;
    }
    this.hideSelection();
    this.mode = "choose-image";
    this.selectedImage = undefined;
    this.engine.view.svg.style.pointerEvents = "none";
    this.drawingToolbar();
    this.engine.toast(
      this.engine.label("点击网页中的图片以重新绑定。Esc 退出。", "Click an image to rebind this annotation. Esc to exit."),
    );
  };

  onDrawingPointerDown = (e: PointerEvent) => {
    if (this.mode !== "drawing" || !this.selectedImage || this.engine.data.pendingSave || this.engine.data.unsaved || e.button !== 0) return;
    const geometry = this.engine.data.imageLayers.clippedGeometry(this.selectedImage);
    if (!geometry) return;
    const point = clientToImage(e.clientX, e.clientY, geometry);
    if (!point) return;
    e.preventDefault();
    this.drawingPointer = e.pointerId;
    this.engine.view.svg.setPointerCapture(e.pointerId);
    this.drawingPoints = [{ ...point, pressure: e.pressure || 0.5 }];
    this.previewShape = {
      kind: this.shapeKind,
      points: this.drawingPoints,
      width: 3 / geometry.imageRect.width,
    };
  };

  onDrawingPointerMove = (e: PointerEvent) => {
    if (this.drawingPointer !== e.pointerId || !this.selectedImage || !this.previewShape) return;
    const geometry = this.engine.data.imageLayers.clippedGeometry(this.selectedImage);
    if (!geometry) return;
    const point = clientToImage(e.clientX, e.clientY, geometry);
    if (!point) return;
    if (this.shapeKind === "pen") {
      if (this.drawingPoints.length < 2000)
        this.drawingPoints.push({ ...point, pressure: e.pressure || 0.5 });
    } else this.drawingPoints = [this.drawingPoints[0]!, point];
    this.previewShape = { ...this.previewShape, points: this.drawingPoints };
    this.engine.data.schedulePaint();
  };

  onDrawingPointerCancel = () => {
    this.drawingPointer = undefined;
    this.previewShape = undefined;
    this.engine.data.schedulePaint();
  };

  onDrawingPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this.drawingPointer || !this.selectedImage || !this.previewShape) return;
    this.drawingPointer = undefined;
    if (this.engine.view.svg.hasPointerCapture(e.pointerId))
      this.engine.view.svg.releasePointerCapture(e.pointerId);
    const shape = this.previewShape;
    this.previewShape = undefined;
    if (shape.points.length < 2) return;
    const a = shape.points[0]!,
      b = shape.points.at(-1)!;
    if (shape.kind !== "pen" && Math.hypot(a.x - b.x, a.y - b.y) < 0.003) return;
    try {
      const record: ImageAnnotation = {
        ...this.engine.data.baseRecord(this.currentColor),
        kind: "image",
        target: captureImage(this.selectedImage),
        shape,
      };
      void this.engine.data.commit(record, true);
    } catch (error) {
      this.engine.fail(error);
    }
  };

  hideSelection = () => {
    this.selectedRange = undefined;
    this.selectionPaletteAutomatic = false;
    this.actionRecords = [];
    this.engine.view.selection.style.display = "none";
  };

  showPalette = (range: Range) => {
    this.selectionPaletteAutomatic = !this.rebinding;
    this.actionRecords = [];
    this.selectedRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    this.engine.view.selection.replaceChildren();
    const primary = [
      ...new Set([...this.engine.data.recentColors, this.currentColor, ...COLORS.slice(0, 3)]),
    ].slice(0, 4);
    const addColor = (color: string) => {
      const b = button(
        "",
        () => {
          void this.engine.data.saveSelection(color);
        },
        `${this.engine.label("高亮", "Highlight")} ${color}`,
      );
      b.className = "swatch";
      b.style.backgroundColor = color;
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      this.engine.view.selection.append(b);
    };
    const addPreset = (preset: AnnotationPreset) => {
      const control = button(
        preset.label,
        () => {
          void this.engine.data.saveSelection(preset.color, [preset.label]);
        },
        `${preset.label} ${preset.color}`,
      );
      control.className = "preset";
      control.dataset.annotationPreset = preset.id;
      const swatch = document.createElement("span");
      Object.assign(swatch.style, {
        width: "10px",
        height: "10px",
        borderRadius: "50%",
        backgroundColor: preset.color,
        boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 12%)",
      });
      swatch.setAttribute("aria-hidden", "true");
      control.prepend(swatch);
      control.addEventListener("pointerdown", (event) => event.preventDefault());
      this.engine.view.selection.append(control);
    };
    this.annotationPresets.slice(0, 5).forEach(addPreset);
    if (this.annotationPresets.length) this.engine.view.selection.append(separator());
    primary.forEach(addColor);
    const more = button(
      "",
      () => {
        more.remove();
        for (const color of COLORS)
          if (!primary.includes(color)) addColor(color);
        const custom = document.createElement("input");
        custom.type = "color";
        custom.value = this.currentColor;
        custom.title = this.engine.label("自定义颜色", "Custom color");
        custom.setAttribute("aria-label", custom.title);
        custom.addEventListener("input", () => {
          this.currentColor = custom.value;
        });
        const apply = button(this.engine.label("应用", "Apply"), () => {
          void this.engine.data.saveSelection(custom.value);
        });
        apply.addEventListener("pointerdown", (event) =>
          event.preventDefault(),
        );
        this.engine.view.selection.append(custom, apply);
      },
      this.engine.label("更多颜色", "More colors"),
    );
    more.className = "more";
    more.append(glyph(ICON_PATHS.more, 3));
    this.engine.view.selection.append(more);
    const matches = matchingTextSelection(this.engine.data.annotations, this.engine.data.textRanges, range);
    if (matches.length) this.engine.view.selection.append(separator());
    if (matches.length === 1) this.engine.view.selection.append(this.removeButton(matches[0]!));
    else if (matches.length > 1)
      this.engine.view.selection.append(
        button(
          this.engine.label(
            `已有 ${matches.length} 条标注`,
            `${matches.length} existing annotations`,
          ),
          () => this.showAnnotationActions(matches, rect),
        ),
      );
    this.placeSelection(rect);
  };

  placeSelection = (rect: { left: number; bottom: number }) => {
    this.engine.view.selection.style.display = "flex";
    this.engine.view.selection.style.flexWrap = "wrap";
    this.engine.view.selection.style.maxWidth = `${Math.max(160, innerWidth - 16)}px`;
    const bounds = this.engine.view.selection.getBoundingClientRect();
    this.engine.view.selection.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8))}px`;
    this.engine.view.selection.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - bounds.height - 8))}px`;
  };

  removeButton = (record: TextAnnotation | ImageAnnotation, index?: number) => {
    const name =
      this.engine.label("取消标注", "Remove annotation") +
      (index === undefined ? "" : ` ${index + 1}`);
    const control = button(name, () => {
      void this.engine.data.removeAnnotation(record);
    });
    control.className = "danger";
    control.title =
      record.kind === "text" ? record.target.exact : record.target.alt || this.engine.label("图片标注", "Image annotation");
    control.addEventListener("pointerdown", (event) => event.preventDefault());
    return control;
  };

  showAnnotationActions = (
    records: Array<TextAnnotation | ImageAnnotation>,
    rect: { left: number; bottom: number },
  ) => {
    this.selectedRange = undefined;
    this.selectionPaletteAutomatic = false;
    this.actionRecords = records;
    this.engine.view.selection.replaceChildren();
    for (const [index, record] of records.entries()) {
      if (records.length > 1) {
        const summary = document.createElement("span");
        const text = record.kind === "text" ? record.target.exact.slice(0, 28) : this.engine.label("图片标注", "Image annotation");
        summary.textContent = `${index + 1}. ${text}`;
        summary.style.borderLeft = `3px solid ${record.color}`;
        summary.style.paddingLeft = "5px";
        this.engine.view.selection.append(summary);
      }
      this.engine.view.selection.append(
        this.removeButton(record, records.length > 1 ? index : undefined),
      );
    }
    this.engine.view.selection.append(button(this.engine.label("关闭", "Close"), this.hideSelection));
    this.placeSelection(rect);
  };

  blockedShortcutTarget = (node: EventTarget | null) => {
    const element =
      node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    return Boolean(element?.closest("input,textarea,select,option,button,[contenteditable],dialog,[role=dialog],toolbar,[role=toolbar]",),);
  };

  applyPresetShortcut = (event: KeyboardEvent) => {
    const index = presetIndexFromKey(event);
    if (index === undefined || !this.engine.enabled() || this.mode !== "idle" || event.composedPath().includes(this.engine.view.host)) return false;
    if (event.composedPath().some((node) => this.blockedShortcutTarget(node))) return false;
    const preset = this.annotationPresets[index];
    const selection = window.getSelection();
    if (!preset || this.engine.data.pendingSave || this.engine.data.unsaved || !selection || selection.isCollapsed || !selection.rangeCount)
      return false; const range = selection.getRangeAt(0).cloneRange();
    if (
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected ||
      this.blockedShortcutTarget(range.commonAncestorContainer) ||
      this.engine.view.host.contains(range.commonAncestorContainer)
    )
      return false;
    try {
      this.engine.data.textSession.captureSelected(range);
    } catch {
      return false;
    }
    event.preventDefault();
    void this.engine.data.saveSelection(preset.color, [preset.label], range);
    return true;
  };

  onInteractionPointerDown = (e: PointerEvent) => {
    if (!this.engine.enabled() || e.composedPath().includes(this.engine.view.host)) return;
    if (this.mode === "choose-image") {
      const target = e.target;
      if (target instanceof HTMLImageElement) {
        e.preventDefault();
        e.stopPropagation();
        this.chooseImage(target);
      }
    } else if (this.mode === "idle") this.hideSelection();
  };

  onMouseUp = (e: MouseEvent) => {
    if (!this.engine.enabled() || this.mode !== "idle" || e.button !== 0 || e.composedPath().includes(this.engine.view.host)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      this.hideSelection();
      const element = e.target instanceof Element ? e.target : undefined;
      // Do not intercept native links, form fields, editors, or page controls.
      if (element?.closest( 'a,button,input,textarea,select,summary,[role="button"],[contenteditable]')) return;
      const matches = annotationsAtPoint(
        {
          annotations: this.engine.data.annotations,
          textRanges: this.engine.data.textRanges,
          images: this.engine.data.images,
          imageShape: (id) => this.engine.data.imageLayers.shapeFor(id),
          geometryForImage: (image) => this.engine.data.imageLayers.clippedGeometry(image),
        },
        e.clientX,
        e.clientY,
      );
      if (matches.length)
        this.showAnnotationActions(matches, {
          left: e.clientX,
          bottom: e.clientY,
        });
      return;
    }
    const range = selection.getRangeAt(0);
    if (!this.selectionToolbarEnabled && !this.rebinding) {
      this.hideSelection();
      return;
    }
    try {
      this.engine.data.textSession.capture(range);
      this.showPalette(range);
    } catch {
      this.hideSelection();
    }
  };

  onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      this.exitDrawing();
      this.hideSelection();
      this.rebinding = undefined;
      return;
    }
    if (this.applyPresetShortcut(e)) return;
    if (
      this.mode === "idle" &&
      !e.shiftKey &&
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === "z" &&
      this.engine.data.canUndoRemoval &&
      !e
        .composedPath()
        .some(
          (n) =>
            n instanceof HTMLElement &&
            (n.matches("input,textarea") || n.isContentEditable),
        )
    ) {
      e.preventDefault();
      void this.engine.data.undoRemoval();
      return;
    }
    if (this.mode === "idle" || e.composedPath().some((n) => n instanceof HTMLElement && (n.matches("input,textarea") || n.isContentEditable)))
      return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) void this.engine.data.redoDrawing();
      else void this.engine.data.undoDrawing();
    }
  };

  onScroll = () => {
    // A site may finish scrolling after mouseup (e.g. GitHub README hydration).
    // Reposition the palette instead of making an otherwise valid selection disappear.
    if (this.selectedRange && this.selectedRange.startContainer.isConnected && this.mode === "idle")
      this.showPalette(this.selectedRange);
    else this.hideSelection();
    this.engine.data.schedulePaint();
  };

  private onPresetStorageChanged = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ) => {
    if (areaName !== "local" || this.engine.disposed) return;
    if (changes[SELECTION_TOOLBAR_KEY]) {
      if (changes[SELECTION_TOOLBAR_KEY]!.newValue !== true) {
        // Fail closed until the effective page mode has been read again.
        this.selectionToolbarEnabled = false;
        if (this.selectionPaletteAutomatic) this.hideSelection();
      }
      void this.engine.data.refresh();
    }
    if (!changes["ui.annotationPresets"]) return;
    const token = this.engine.data.generation;
    const presetReadToken = ++this.engine.data.presetReadGeneration;
    void readAnnotationPresets(this.engine.settings.language)
      .then((next) => {
        if (this.engine.disposed || token !== this.engine.data.generation || presetReadToken !== this.engine.data.presetReadGeneration) return;
        this.annotationPresets = next;
        if (this.selectedRange?.startContainer.isConnected && this.mode === "idle")
          this.showPalette(this.selectedRange);
      })
      .catch(() => undefined);
  };

  observeReadingPage = () => {
    if (document.head)
      this.mutationObserver.observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href"],
      });
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "src",
        "srcset",
        "class",
        "style",
        "contenteditable",
        "id",
        "href",
      ],
    });
  };

  start = () => {
    const { signal } = this;
    this.engine.view.svg.addEventListener("pointerdown", this.onDrawingPointerDown, { signal });
    this.engine.view.svg.addEventListener("pointermove", this.onDrawingPointerMove, { signal });
    this.engine.view.svg.addEventListener("pointerup", this.onDrawingPointerUp, { signal });
    this.engine.view.svg.addEventListener("pointercancel", this.onDrawingPointerCancel, { signal });
    document.addEventListener("pointerdown", this.onInteractionPointerDown, {
      capture: true,
      signal,
    });
    document.addEventListener("mouseup", this.onMouseUp, { signal });
    document.addEventListener("keydown", this.onKeyDown, { signal });
    try {
      chrome.storage.onChanged?.addListener(this.onPresetStorageChanged);
      this.presetStorageListenerRegistered = Boolean(chrome.storage.onChanged);
    } catch {
      // Chrome can invalidate storage before the engine finishes DOM cleanup.
    }
    window.addEventListener("scroll", this.onScroll, {
      capture: true,
      passive: true,
      signal,
    });
    window.addEventListener("resize", this.engine.data.schedulePaint, { signal });
    window.addEventListener("popstate", this.engine.data.queueRefresh, { signal });
    window.addEventListener("hashchange", this.engine.data.queueRefresh, { signal });
    document.addEventListener("load", (event) => {
      if (event.target instanceof HTMLImageElement) this.engine.data.queueRefresh();
    }, { capture: true, signal });
  };

  stop = () => {
    this.observers.abort();
    this.mutationObserver.disconnect();
    this.resizeObserver.disconnect();
    if (this.presetStorageListenerRegistered) {
      try {
        chrome.storage.onChanged.removeListener(this.onPresetStorageChanged);
      } catch {
        // Chrome can invalidate storage before the engine finishes DOM cleanup.
      }
      this.presetStorageListenerRegistered = false;
    }
  };

}

/** Small monochrome icon used by the floating selection and drawing controls. */
function glyph(path: string, strokeWidth = 1.8) {
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

