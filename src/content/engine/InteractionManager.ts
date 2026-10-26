import { annotationsAtPoint } from "../annotation-hit";
import { COLORS, type ImageAnnotation, type TextAnnotation } from "../../core/model";
import { button, separator } from "../view-lite";
import { ICON_PATHS } from "../../ui/icons";
import { matchingTextSelection } from "../annotation-hit";
import { defaultAnnotationPresets, presetIndexFromKey, type AnnotationPreset } from "../../core/annotation-presets";
import type { AnnotationController } from "./AnnotationController";
import { glyph } from "./controls";

type InteractionManagerContext = Pick<
  AnnotationController,
  | "enabled"
  | "label"
  | "mode"
  | "render"
  | "save"
  | "settings"
  | "store"
  | "view"
>;

/** Owns selection controls and preset shortcut admission. */
export class InteractionManager {
  selectedRange: Range | undefined;
  selectionToolbarEnabled: boolean = false;
  selectionPaletteAutomatic: boolean = false;
  actionRecords: Array<TextAnnotation | ImageAnnotation> = [];
  annotationPresets: AnnotationPreset[];

  constructor(private readonly engine: InteractionManagerContext) {
    this.annotationPresets = defaultAnnotationPresets(
      this.engine.settings.language,
    );
  }

  hideSelection = () => {
    this.selectedRange = undefined;
    this.selectionPaletteAutomatic = false;
    this.actionRecords = [];
    this.engine.view.selection.style.display = "none";
  };

  showPalette = (range: Range) => {
    const { mode, view, save, label, store, render } = this.engine;
    this.selectionPaletteAutomatic = !mode.rebinding;
    this.actionRecords = [];
    this.selectedRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    view.selection.replaceChildren();
    const primary = [
      ...new Set([...save.recentColors, mode.currentColor, ...COLORS.slice(0, 3)]),
    ].slice(0, 4);
    const addColor = (color: string) => {
      const b = button(
        "",
        () => {
          void save.saveSelection(color);
        },
        `${label("高亮", "Highlight")} ${color}`,
      );
      b.className = "swatch";
      b.style.backgroundColor = color;
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      view.selection.append(b);
    };
    const addPreset = (preset: AnnotationPreset) => {
      const control = button(
        preset.label,
        () => {
          void save.saveSelection(preset.color, [preset.label]);
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
      view.selection.append(control);
    };
    this.annotationPresets.slice(0, 5).forEach(addPreset);
    if (this.annotationPresets.length) view.selection.append(separator());
    primary.forEach(addColor);
    const more = button(
      "",
      () => {
        more.remove();
        for (const color of COLORS)
          if (!primary.includes(color)) addColor(color);
        const custom = document.createElement("input");
        custom.type = "color";
        custom.value = mode.currentColor;
        custom.title = label("自定义颜色", "Custom color");
        custom.setAttribute("aria-label", custom.title);
        custom.addEventListener("input", () => {
          mode.currentColor = custom.value;
        });
        const apply = button(label("应用", "Apply"), () => {
          void save.saveSelection(custom.value);
        });
        apply.addEventListener("pointerdown", (event) =>
          event.preventDefault(),
        );
        view.selection.append(custom, apply);
      },
      label("更多颜色", "More colors"),
    );
    more.className = "more";
    more.append(glyph(ICON_PATHS.more, 3));
    view.selection.append(more);
    const matches = matchingTextSelection(store.annotations, render.textRanges, range);
    if (matches.length) view.selection.append(separator());
    if (matches.length === 1) view.selection.append(this.removeButton(matches[0]!));
    else if (matches.length > 1)
      view.selection.append(
        button(
          label(
            `已有 ${matches.length} 条标注`,
            `${matches.length} existing annotations`,
          ),
          () => this.showAnnotationActions(matches, rect),
        ),
      );
    this.placeSelection(rect);
  };

  placeSelection = (rect: { left: number; bottom: number }) => {
    const { view } = this.engine;
    view.selection.style.display = "flex";
    view.selection.style.flexWrap = "wrap";
    view.selection.style.maxWidth = `${Math.max(160, innerWidth - 16)}px`;
    const bounds = view.selection.getBoundingClientRect();
    view.selection.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8))}px`;
    view.selection.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - bounds.height - 8))}px`;
  };

  removeButton = (record: TextAnnotation | ImageAnnotation, index?: number) => {
    const { label, save } = this.engine;
    const name =
      label("取消标注", "Remove annotation") +
      (index === undefined ? "" : ` ${index + 1}`);
    const control = button(name, () => {
      void save.removeAnnotation(record);
    });
    control.className = "danger";
    control.title =
      record.kind === "text"
        ? record.target.exact
        : record.target.alt || label("图片标注", "Image annotation");
    control.addEventListener("pointerdown", (event) => event.preventDefault());
    return control;
  };

  showAnnotationActions = (
    records: Array<TextAnnotation | ImageAnnotation>,
    rect: { left: number; bottom: number },
  ) => {
    const { view, label } = this.engine;
    this.selectedRange = undefined;
    this.selectionPaletteAutomatic = false;
    this.actionRecords = records;
    view.selection.replaceChildren();
    for (const [index, record] of records.entries()) {
      if (records.length > 1) {
        const summary = document.createElement("span");
        const text = record.kind === "text"
          ? record.target.exact.slice(0, 28)
          : label("图片标注", "Image annotation");
        summary.textContent = `${index + 1}. ${text}`;
        summary.style.borderLeft = `3px solid ${record.color}`;
        summary.style.paddingLeft = "5px";
        view.selection.append(summary);
      }
      view.selection.append(
        this.removeButton(record, records.length > 1 ? index : undefined),
      );
    }
    view.selection.append(button(label("关闭", "Close"), this.hideSelection));
    this.placeSelection(rect);
  };

  blockedShortcutTarget = (node: EventTarget | null) => {
    const element =
      node instanceof Element
        ? node
        : node instanceof Node
          ? node.parentElement
          : null;
    return Boolean(
      element?.closest(
        "input,textarea,select,option,button,[contenteditable],dialog,[role=dialog],toolbar,[role=toolbar]",
      ),
    );
  };

  applyPresetShortcut = (event: KeyboardEvent) => {
    const { enabled, mode, view, save, render } = this.engine;
    const index = presetIndexFromKey(event);
    if (
      index === undefined ||
      !enabled() ||
      mode.mode !== "idle" ||
      event.composedPath().includes(view.host)
    )
      return false;
    if (event.composedPath().some((node) => this.blockedShortcutTarget(node)))
      return false;
    const preset = this.annotationPresets[index];
    const selection = window.getSelection();
    if (
      !preset ||
      save.pendingSave ||
      save.unsaved ||
      !selection ||
      selection.isCollapsed ||
      !selection.rangeCount
    )
      return false;
    const range = selection.getRangeAt(0).cloneRange();
    if (
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected ||
      this.blockedShortcutTarget(range.commonAncestorContainer) ||
      view.host.contains(range.commonAncestorContainer)
    )
      return false;
    try {
      render.textSession.captureSelected(range);
    } catch {
      return false;
    }
    event.preventDefault();
    void save.saveSelection(preset.color, [preset.label], range);
    return true;
  };

  onPointerDown = (e: PointerEvent) => {
    const { enabled, view, mode } = this.engine;
    if (!enabled() || e.composedPath().includes(view.host)) return;
    if (mode.mode === "choose-image") {
      const target = e.target;
      if (target instanceof HTMLImageElement) {
        e.preventDefault();
        e.stopPropagation();
        mode.chooseImage(target);
      }
    } else if (mode.mode === "idle") this.hideSelection();
  };

  onMouseUp = (e: MouseEvent) => {
    const { enabled, mode, view, store, render } = this.engine;
    if (
      !enabled() ||
      mode.mode !== "idle" ||
      e.button !== 0 ||
      e.composedPath().includes(view.host)
    )
      return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      this.hideSelection();
      const element = e.target instanceof Element ? e.target : undefined;
      // Do not intercept native links, form fields, editors, or page controls.
      if (
        element?.closest(
          'a,button,input,textarea,select,summary,[role="button"],[contenteditable]',
        )
      )
        return;
      const matches = annotationsAtPoint(
        {
          annotations: store.annotations,
          textRanges: render.textRanges,
          images: render.images,
          imageShape: (id) => render.imageLayers.shapeFor(id),
          geometryForImage: (image) => render.imageLayers.clippedGeometry(image),
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
    if (!this.selectionToolbarEnabled && !mode.rebinding) {
      this.hideSelection();
      return;
    }
    try {
      render.textSession.capture(range);
      this.showPalette(range);
    } catch {
      this.hideSelection();
    }
  };

  onKeyDown = (e: KeyboardEvent) => {
    const { mode, save } = this.engine;
    if (e.key === "Escape") {
      mode.exitDrawing();
      this.hideSelection();
      mode.rebinding = undefined;
      return;
    }
    if (this.applyPresetShortcut(e)) return;
    if (
      mode.mode === "idle" &&
      !e.shiftKey &&
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === "z" &&
      save.canUndoRemoval &&
      !e
        .composedPath()
        .some(
          (n) =>
            n instanceof HTMLElement &&
            (n.matches("input,textarea") || n.isContentEditable),
        )
    ) {
      e.preventDefault();
      void save.undoRemoval();
      return;
    }
    if (
      mode.mode === "idle" ||
      e
        .composedPath()
        .some(
          (n) =>
            n instanceof HTMLElement &&
            (n.matches("input,textarea") || n.isContentEditable),
        )
    )
      return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) void save.redoDrawing();
      else void save.undoDrawing();
    }
  };

  onScroll = () => {
    // A site may finish scrolling after mouseup (e.g. GitHub README hydration).
    // Reposition the palette instead of making an otherwise valid selection disappear.
    if (
      this.selectedRange &&
      this.selectedRange.startContainer.isConnected &&
      this.engine.mode.mode === "idle"
    )
      this.showPalette(this.selectedRange);
    else this.hideSelection();
    this.engine.render.schedulePaint();
  };
}
