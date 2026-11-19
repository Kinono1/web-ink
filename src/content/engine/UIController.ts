import type { Annotation, ImageAnnotation, Settings, TextAnnotation } from "../../core/model";
import { captureImage } from "../../core/image-anchor";
import {
  defaultAnnotationPresets,
  presetIndexFromKey,
  readAnnotationPresets,
  type AnnotationPreset,
} from "../../core/annotation-presets";
import { SELECTION_TOOLBAR_KEY } from "../../core/selection-toolbar";
import { textLinkScope, textLinkUrl } from "../../core/text-link";
import { annotationsAtPoint, matchingTextSelection } from "../annotation-hit";
import { button, separator, type ContentView } from "../view-lite";
import { appendSelectionColors } from "./selection-colors";
import type { DataEngine } from "./DataEngine";
import type { Notifications } from "../notifications";

/** Host surface supplied by {@link AnnotationController}; the data half exists first. */
export interface UIControllerHost {
  readonly view: ContentView;
  readonly data: DataEngine;
  readonly notifications?: Pick<Notifications, "clear">;
  settings: Settings;
  disposed: boolean;
  enabled: () => boolean;
  label: (cn: string, en: string) => string;
  toast: (message: string, error?: boolean, retry?: () => void) => void;
  fail: (error: unknown) => void;
}

/**
 * Owns content interaction: image rebind, selection palettes and
 * shortcuts, plus browser listeners and reading-page observer lifetimes.
 */
export class UIController {
  rebinding: Annotation | undefined;
  mode: "idle" | "choose-image" = "idle";
  currentColor: string;

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
          return baseChanged && this.engine.data.annotations.some(record => record.kind === "text" && textLinkUrl(record.target, record.pageUrl));
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
            return true;
          if (m.attributeName !== "href" || !(m.target instanceof HTMLAnchorElement)) return false;
          const link = m.target;
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
        this.engine.data.sync.queueRefresh();
      }
      if (relevant.length) this.engine.data.schedulePaint();
    });
  }

  exitImageRebind = () => {
    this.mode = "idle";
    this.engine.view.drawing.style.display = "none";
  };

  chooseImage = (image: HTMLImageElement) => {
    const record = this.rebinding;
    if (record?.kind !== "image") {
      // A completed save can clear a newer rebind.
      this.exitImageRebind();
      return;
    }
    if (!this.engine.data.imageLayers.supports(image)) {
      this.engine.toast(this.engine.label(
        "此图片尚未加载，或使用了暂不支持的变换。",
        "Image is not loaded or has an unsupported transform.",
      ), true);
      return;
    }
    try {
      void this.engine.data.commit({
        ...record,
        target: captureImage(image),
        updatedAt: new Date().toISOString(),
      });
      this.exitImageRebind();
    } catch (error) {
      this.engine.fail(error);
    }
  };

  startImageRebind = () => {
    if (!this.engine.enabled()) {
      this.engine.toast(this.engine.label("请先启用此网站。", "Enable this site first."), true);
      return;
    }
    this.hideSelection();
    this.mode = "choose-image";
    const title = document.createElement("span");
    title.className = "brand";
    title.textContent = "Web Ink";
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = this.engine.label(
      "点击网页中的图片以重新绑定",
      "Click an image to rebind this annotation",
    );
    const done = button(this.engine.label("完成", "Done"), () => {
      this.rebinding = undefined;
      this.exitImageRebind();
    });
    this.engine.view.drawing.replaceChildren(title, separator(), hint, done);
    this.engine.view.drawing.style.display = "flex";
    this.engine.toast(
      this.engine.label("点击网页中的图片以重新绑定。Esc 退出。", "Click an image to rebind this annotation. Esc to exit."),
    );
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
    if (this.rebinding?.kind === "text") {
      const label = document.createElement("span");
      label.className = "brand";
      label.textContent = this.engine.label("重新绑定", "Rebind");
      this.engine.view.selection.append(label);
    }
    appendSelectionColors(this.engine.view.selection, {
      presets: this.annotationPresets,
      recentColors: this.engine.data.recentColors,
      color: () => this.currentColor,
      setColor: color => { this.currentColor = color; },
      save: this.engine.data.saveSelection,
      label: this.engine.label,
    });
    const matches = this.rebinding ? [] : matchingTextSelection(this.engine.data.annotations, this.engine.data.textRanges, range);
    if (matches.length) this.engine.view.selection.append(separator());
    if (matches.length === 1) this.engine.view.selection.append(this.removeButton(matches[0]!));
    else if (matches.length > 1)
      this.engine.view.selection.append(
        button(
          this.engine.label(
            `已有 ${matches.length} 条标注`,
            `${matches.length} existing annotations`,
          ),
          () => this.showAnnotationActions(matches, (this.selectedRange ?? range).getBoundingClientRect()),
        ),
      );
    if (this.rebinding) this.engine.view.selection.append(button(this.engine.label("取消", "Cancel"), () => {
      this.rebinding = undefined;
      this.hideSelection();
      this.engine.notifications?.clear("rebind.manual");
      this.engine.notifications?.clear("rebind.preview");
    }));
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
    return Boolean(element?.closest("input,textarea,select,option,button,[contenteditable],dialog,[role=dialog],toolbar,[role=toolbar]"));
  };

  applyPresetShortcut = (event: KeyboardEvent) => {
    const index = presetIndexFromKey(event);
    if (index === undefined || !this.engine.enabled() || this.mode !== "idle" || event.composedPath().includes(this.engine.view.host)) return false;
    if (event.composedPath().some((node) => this.blockedShortcutTarget(node))) return false;
    const preset = this.annotationPresets[index];
    const selection = window.getSelection();
    if (!preset || this.engine.data.pendingSave || this.engine.data.unsaved || !selection || selection.isCollapsed || !selection.rangeCount)
      return false;
    const range = selection.getRangeAt(0).cloneRange();
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
    if (this.rebinding) this.engine.notifications?.clear("rebind.preview");
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
      this.exitImageRebind();
      this.hideSelection();
      this.rebinding = undefined;
      this.engine.notifications?.clear("rebind.preview");
      this.engine.notifications?.clear("rebind.manual");
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
  };

  onScroll = () => {
    // A site may finish scrolling after mouseup (e.g. GitHub README hydration).
    // Reposition the palette instead of making an otherwise valid selection disappear.
    const range = this.selectedRange;
    if (range?.startContainer.isConnected && this.mode === "idle")
      this.placeSelection(range.getBoundingClientRect());
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
      void this.engine.data.sync.refresh();
    }
    if (!changes["ui.annotationPresets"]) return;
    const token = this.engine.data.sync.generation;
    const presetReadToken = ++this.engine.data.sync.presetReadGeneration;
    void readAnnotationPresets(this.engine.settings.language)
      .then((next) => {
        if (this.engine.disposed || token !== this.engine.data.sync.generation || presetReadToken !== this.engine.data.sync.presetReadGeneration) return;
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
    window.addEventListener("popstate", this.engine.data.sync.queueRefresh, { signal });
    window.addEventListener("hashchange", this.engine.data.sync.queueRefresh, { signal });
    document.addEventListener("load", (event) => {
      if (event.target instanceof HTMLImageElement) this.engine.data.sync.queueRefresh();
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
