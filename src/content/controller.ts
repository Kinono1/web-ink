import { request, RequestError } from "../core/client";
import {
  COLORS,
  DEFAULT_SETTINGS,
  type Annotation,
  type AnchorState,
  type ImageAnnotation,
  type ImageShape,
  type PageMode,
  type Point,
  type Settings,
  type ShapeKind,
  type TextAnnotation,
} from "../core/model";
import { TextAnchorSession } from "../core/text-anchor";
import { captureImage, resolveImage } from "../core/image-anchor";
import { clientToImage } from "../core/geometry";
import { pageKey } from "../core/url";
import { button, createView, svgElement } from "./view-lite";
import { renderShape } from "./render-shape";
import { createNotifications } from "./notifications";
import { ICON_PATHS } from "../ui/icons";
import { annotationsAtPoint, matchingTextSelection } from "./annotation-hit";
import { ImageLayerManager } from "./image-layers";

export interface ContentEngine {
  stop: () => void;
  dispatch: (
    action: "focus" | "rebind" | "draw" | "refresh",
    id?: string,
  ) => void;
  snapshot: () => { pageUrl: string; states: AnchorState[]; enabled: boolean };
  canStop: () => boolean;
}

/** Heavy DOM work lives in engine.js. The runtime bootstrap owns the host and palette. */
export function startEngine(
  view: ReturnType<typeof createView>,
): ContentEngine {
  const notifications = createNotifications(view.toast);
  const highlightStyle = document.createElement("style");
  highlightStyle.dataset.webInk = "true";
  document.documentElement.append(highlightStyle);
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  let annotations: Annotation[] = [];
  let states: AnchorState[] = [];
  let currentUrl = pageKey(location.href);
  let pageEnabled = false;
  let modeReady = false;
  let toggleBusy = false;
  let stopped = false;
  let disabled = false;
  let disposed = false;
  let generation = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let renderFrame = 0;
  let refreshDepth = 0;
  let selectedRange: Range | undefined;
  let actionRecords: Array<TextAnnotation | ImageAnnotation> = [];
  const removedRecords: Array<TextAnnotation | ImageAnnotation> = [];
  let rebinding: Annotation | undefined;
  let mode: "idle" | "choose-image" | "drawing" = "idle";
  let selectedImage: HTMLImageElement | undefined;
  let shapeKind: ShapeKind = "rectangle";
  let currentColor: string = settings.defaultColor;
  let drawingPoints: Point[] = [];
  let drawingPointer: number | undefined;
  let previewShape: ImageShape | undefined;
  let unsaved: Annotation | undefined;
  let pendingSave = false;
  let focusId: string | undefined;
  let passiveRetryCount = 0;
  let passiveRetryTimer: ReturnType<typeof setTimeout> | undefined;
  // One session owns every reading index and DOM reference for this engine run.
  // It is flushed by capture/resolve, so a save cannot reuse a stale mouseup index.
  const textSession = new TextAnchorSession(document);
  const images = new Map<string, HTMLImageElement>();
  const textRanges = new Map<string, Range>();
  const highlightNames = new Set<string>();
  const appliedRevisions = new Map<string, number>();
  const deletedRevisions = new Map<string, number>();
  const imageLayers = new ImageLayerManager(view.svg);
  const transientLayer = svgElement("g", { "data-web-ink-transient": "true" });
  const recentColors: string[] = [];
  const undo: ImageAnnotation[] = [];
  const redo: ImageAnnotation[] = [];
  const observers = new AbortController();
  const signal = observers.signal;
  const zh = () => settings.language === "zh-CN";
  const label = (cn: string, en: string) => (zh() ? cn : en);
  // Bootstrap is deliberately the only persistent control. Keep this no-op for
  // the engine's save/mode state transitions until the bootstrap next refreshes.
  const updatePalette = () => undefined;
  const toast = (message: string, error = false, retry?: () => void) => {
    notifications.show(message, {
      kind: error ? "error" : "info",
      sticky: !!retry,
      dismissLabel: label("关闭提示", "Dismiss"),
      actions: retry
        ? [
            { label: label("重试保存", "Retry save"), run: retry },
            {
              label: label("放弃本次修改", "Discard this change"),
              run: () => {
                unsaved = undefined;
                rebinding = undefined;
                notifications.hide();
                schedulePaint();
              },
            },
          ]
        : [],
    });
  };
  const fail = (error: unknown) =>
    toast(error instanceof Error ? error.message : String(error), true);
  const enabled = () => pageEnabled && !disabled && !stopped && !disposed;
  const clearText = () => {
    if (typeof CSS !== "undefined" && "highlights" in CSS)
      for (const name of highlightNames) CSS.highlights.delete(name);
    highlightNames.clear();
    textRanges.clear();
    highlightStyle.textContent = "";
  };
  const applyTextStyles = () => {
    if (
      typeof CSS === "undefined" ||
      !("highlights" in CSS) ||
      typeof Highlight === "undefined"
    )
      return;
    for (const name of highlightNames) CSS.highlights.delete(name);
    highlightNames.clear();
    const groups = new Map<string, Range[]>();
    for (const record of annotations)
      if (record.kind === "text") {
        const range = textRanges.get(record.id);
        if (!range) continue;
        const group = groups.get(record.color) ?? [];
        group.push(range);
        groups.set(record.color, group);
      }
    const rules: string[] = [];
    for (const [color, ranges] of groups) {
      const name = `web-ink-${color.slice(1)}`;
      CSS.highlights.set(name, new Highlight(...ranges));
      highlightNames.add(name);
      rules.push(
        `::highlight(${name}) { background-color: ${color}99; color: inherit; }`,
      );
    }
    highlightStyle.textContent = rules.join("\n");
  };
  const hideSelection = () => {
    selectedRange = undefined;
    actionRecords = [];
    view.selection.style.display = "none";
  };
  const exitDrawing = () => {
    mode = "idle";
    selectedImage = undefined;
    drawingPointer = undefined;
    drawingPoints = [];
    previewShape = undefined;
    view.svg.style.pointerEvents = "none";
    view.svg.style.cursor = "";
    view.drawing.style.display = "none";
    schedulePaint();
  };

  async function changePageMode(next: boolean): Promise<boolean> {
    if (toggleBusy || pendingSave || disabled || stopped || disposed)
      return false;
    if (unsaved) {
      const record = unsaved;
      toast(
        label(
          "请先处理尚未保存的修改。",
          "Resolve the unsaved change before switching modes.",
        ),
        true,
        () => {
          void commit(record);
        },
      );
      return false;
    }
    toggleBusy = true;
    updatePalette();
    const url = pageKey(location.href);
    try {
      const result = await request<PageMode>({
        type: "page.mode.put",
        pageUrl: url,
        enabled: next,
      });
      if (disposed) return false;
      if (pageKey(location.href) !== url) {
        queueRefresh();
        return false;
      }
      pageEnabled = result.enabled;
      notifications.hide();
      await refresh();
      return enabled();
    } catch (error) {
      fail(error);
      return false;
    } finally {
      toggleBusy = false;
      updatePalette();
    }
  }

  async function withPageEnabled(action: () => void) {
    if (!modeReady) await refresh();
    if (!enabled() && !(await changePageMode(true))) return;
    action();
  }

  function showPalette(range: Range) {
    actionRecords = [];
    selectedRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    view.selection.replaceChildren();
    const primary = [
      ...new Set([...recentColors, currentColor, ...COLORS.slice(0, 3)]),
    ].slice(0, 4);
    const addColor = (color: string) => {
      const b = button(
        "",
        () => {
          void saveSelection(color);
        },
        `${label("高亮", "Highlight")} ${color}`,
      );
      b.className = "swatch";
      b.style.backgroundColor = color;
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      view.selection.append(b);
    };
    primary.forEach(addColor);
    const more = button(
      "•••",
      () => {
        more.remove();
        for (const color of COLORS)
          if (!primary.includes(color)) addColor(color);
        const custom = document.createElement("input");
        custom.type = "color";
        custom.value = currentColor;
        custom.title = label("自定义颜色", "Custom color");
        custom.setAttribute("aria-label", custom.title);
        custom.addEventListener("input", () => {
          currentColor = custom.value;
        });
        const apply = button(label("应用", "Apply"), () => {
          void saveSelection(custom.value);
        });
        apply.addEventListener("pointerdown", (event) =>
          event.preventDefault(),
        );
        view.selection.append(custom, apply);
      },
      label("更多颜色", "More colors"),
    );
    view.selection.append(more);
    const matches = matchingTextSelection(annotations, textRanges, range);
    if (matches.length === 1) view.selection.append(removeButton(matches[0]!));
    else if (matches.length > 1)
      view.selection.append(
        button(
          label(
            `已有 ${matches.length} 条标注`,
            `${matches.length} existing annotations`,
          ),
          () => showAnnotationActions(matches, rect),
        ),
      );
    placeSelection(rect);
  }

  function placeSelection(rect: { left: number; bottom: number }) {
    view.selection.style.display = "flex";
    view.selection.style.flexWrap = "wrap";
    view.selection.style.maxWidth = `${Math.max(160, innerWidth - 16)}px`;
    const bounds = view.selection.getBoundingClientRect();
    view.selection.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8))}px`;
    view.selection.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - bounds.height - 8))}px`;
  }
  function removeButton(
    record: TextAnnotation | ImageAnnotation,
    index?: number,
  ) {
    const name =
      label("取消标注", "Remove annotation") +
      (index === undefined ? "" : ` ${index + 1}`);
    const control = button(name, () => {
      void removeAnnotation(record);
    });
    control.style.color = "var(--ink-danger)";
    control.title =
      record.kind === "text"
        ? record.target.exact
        : record.target.alt || label("图片标注", "Image annotation");
    control.addEventListener("pointerdown", (event) => event.preventDefault());
    return control;
  }
  function showAnnotationActions(
    records: Array<TextAnnotation | ImageAnnotation>,
    rect: { left: number; bottom: number },
  ) {
    selectedRange = undefined;
    actionRecords = records;
    view.selection.replaceChildren();
    for (const [index, record] of records.entries()) {
      if (records.length > 1) {
        const summary = document.createElement("span");
        summary.textContent = `${index + 1}. ${record.kind === "text" ? record.target.exact.slice(0, 28) : label("图片标注", "Image annotation")}`;
        summary.style.borderLeft = `3px solid ${record.color}`;
        summary.style.paddingLeft = "5px";
        view.selection.append(summary);
      }
      view.selection.append(
        removeButton(record, records.length > 1 ? index : undefined),
      );
    }
    view.selection.append(button(label("关闭", "Close"), hideSelection));
    placeSelection(rect);
  }
  async function removeAnnotation(record: TextAnnotation | ImageAnnotation) {
    if (!enabled() || pendingSave || unsaved) return;
    pendingSave = true;
    try {
      await request({
        type: "annotations.delete",
        id: record.id,
        expectedRevision: record.revision,
      });
      if (disposed || record.pageUrl !== pageKey(location.href)) return;
      applyAnnotationDelta(undefined, record.id, record.pageUrl);
      hideSelection();
      getSelection()?.removeAllRanges();
      removedRecords.push(record);
      if (removedRecords.length > 20) removedRecords.shift();
      notifications.show(label("已取消标注", "Annotation removed"), {
        kind: "success",
        sticky: true,
        dismissLabel: label("关闭提示", "Dismiss"),
        actions: [
          {
            label: label("撤销取消", "Undo removal"),
            run: () => {
              void undoRemoval(record);
            },
          },
        ],
      });
    } catch (error) {
      if (error instanceof RequestError && error.code === "CONFLICT") {
        hideSelection();
        void refresh();
      }
      notifications.show(
        label("取消失败：", "Could not remove: ") +
          (error instanceof Error ? error.message : String(error)),
        {
          kind: "error",
          sticky: true,
          dismissLabel: label("关闭提示", "Dismiss"),
          actions:
            error instanceof RequestError && error.code === "CONFLICT"
              ? []
              : [
                  {
                    label: label("重试取消", "Retry removal"),
                    run: () => {
                      void removeAnnotation(record);
                    },
                  },
                ],
        },
      );
    } finally {
      pendingSave = false;
    }
  }
  async function undoRemoval(record = removedRecords.at(-1)) {
    if (
      !record ||
      pendingSave ||
      unsaved ||
      !enabled() ||
      record.pageUrl !== pageKey(location.href)
    )
      return;
    pendingSave = true;
    try {
      const restored = await request<Annotation>({
        type: "annotations.restore",
        annotation: { ...record, updatedAt: new Date().toISOString() },
      });
      if (disposed || record.pageUrl !== pageKey(location.href)) return;
      applyAnnotationDelta(restored, undefined, record.pageUrl);
      const index = removedRecords.lastIndexOf(record);
      if (index >= 0) removedRecords.splice(index, 1);
      notifications.show(label("已恢复标注", "Annotation restored"), {
        kind: "success",
        dismissLabel: label("关闭提示", "Dismiss"),
      });
    } catch (error) {
      notifications.show(
        label("无法恢复：", "Could not restore: ") +
          (error instanceof Error ? error.message : String(error)),
        {
          kind: "error",
          sticky: true,
          dismissLabel: label("关闭提示", "Dismiss"),
          actions: [
            {
              label: label("重试恢复", "Retry restore"),
              run: () => {
                void undoRemoval(record);
              },
            },
          ],
        },
      );
    } finally {
      pendingSave = false;
    }
  }

  function baseRecord(color: string) {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      pageUrl: pageKey(location.href),
      pageTitle: document.title,
      color,
      note: "",
      tags: [],
      createdAt: now,
      updatedAt: now,
      revision: 0,
    };
  }
  async function commit(record: Annotation, track = false) {
    if (pendingSave) return;
    pendingSave = true;
    unsaved = record;
    updatePalette();
    toast(label("正在保存…", "Saving…"));
    try {
      const stored = await request<Annotation>({
        type: "annotations.put",
        annotation: record,
        expectedRevision: record.revision,
      });
      recentColors.splice(
        0,
        recentColors.length,
        stored.color,
        ...recentColors.filter((color) => color !== stored.color).slice(0, 2),
      );
      unsaved = undefined;
      if (
        track &&
        stored.kind === "image" &&
        stored.pageUrl === pageKey(location.href)
      ) {
        undo.push(stored);
        redo.length = 0;
      }
      rebinding = undefined;
      notifications.show(label("已保存到本机", "Saved on this device"), {
        kind: "success",
        dismissLabel: label("关闭提示", "Dismiss"),
      });
      if (!disposed && stored.pageUrl === pageKey(location.href))
        applyAnnotationDelta(stored, undefined, stored.pageUrl);
    } catch (error) {
      const reason =
        error instanceof RequestError && error.code === "PAGE_CHANGED"
          ? label(
              "网页已切换，请回到原页面重试。",
              "The page changed. Return to the original page to retry.",
            )
          : error instanceof Error
            ? error.message
            : String(error);
      toast(
        `${label("保存失败，记录尚未落盘：", "Not saved: ")}${reason}`,
        true,
        () => {
          void commit(record, track);
        },
      );
    } finally {
      pendingSave = false;
      updatePalette();
      schedulePaint();
    }
  }
  async function saveSelection(color: string) {
    if (!selectedRange || !enabled() || pendingSave || unsaved) return;
    try {
      // Mouseup captured this once for the palette. Reuse only if the session
      // can prove that no queued DOM change or range-boundary drift occurred.
      const target = textSession.captureSelected(selectedRange);
      const record: TextAnnotation =
        rebinding?.kind === "text"
          ? { ...rebinding, target, updatedAt: new Date().toISOString() }
          : { ...baseRecord(color), kind: "text", target };
      hideSelection();
      window.getSelection()?.removeAllRanges();
      await commit(record);
    } catch (error) {
      fail(error);
    }
  }

  function drawingToolbar() {
    view.drawing.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "Web Ink";
    view.drawing.append(title);
    if (mode === "choose-image") {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = label(
        "点击网页中的图片开始绘制",
        "Click an image to start drawing",
      );
      view.drawing.append(hint, button(label("完成", "Done"), exitDrawing));
      view.drawing.style.display = "flex";
      return;
    }
    const iconButton = (title: string, path: string, run: () => void) => {
      const control = button("", run, title);
      const icon = svgElement("svg", {
        viewBox: "0 0 24 24",
        "aria-hidden": "true",
      });
      icon.append(
        svgElement("path", {
          d: path,
          fill: "none",
          stroke: "currentColor",
          "stroke-width": 1.8,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      );
      control.append(icon);
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
        shapeKind = kind;
        drawingToolbar();
      });
      b.setAttribute("aria-pressed", String(shapeKind === kind));
      view.drawing.append(b);
    }
    const color = document.createElement("input");
    color.type = "color";
    color.value = currentColor;
    color.setAttribute("aria-label", label("画笔颜色", "Drawing color"));
    color.addEventListener("input", () => {
      currentColor = color.value;
    });
    view.drawing.append(
      color,
      iconButton(
        label("撤销", "Undo"),
        "M8 7 4 11l4 4M5 11h8a5 5 0 1 1 0 10",
        () => {
          void undoDrawing();
        },
      ),
      iconButton(
        label("重做", "Redo"),
        "m16 7 4 4-4 4m3-4h-8a5 5 0 1 0 0 10",
        () => {
          void redoDrawing();
        },
      ),
      iconButton(label("换图片", "Pick image"), ICON_PATHS.image, () => {
        selectedImage = undefined;
        mode = "choose-image";
        view.svg.style.pointerEvents = "none";
        drawingToolbar();
      }),
      iconButton(label("完成", "Done"), "m5 12 4 4L19 6", exitDrawing),
    );
    view.drawing.style.display = "flex";
  }
  function chooseImage(image: HTMLImageElement) {
    if (!imageLayers.supports(image)) {
      toast(
        label(
          "此图片尚未加载，或使用了暂不支持的变换。",
          "Image is not loaded or has an unsupported transform.",
        ),
        true,
      );
      return;
    }
    if (rebinding?.kind === "image") {
      try {
        void commit({
          ...rebinding,
          target: captureImage(image),
          updatedAt: new Date().toISOString(),
        });
        exitDrawing();
      } catch (error) {
        fail(error);
      }
      return;
    }
    selectedImage = image;
    mode = "drawing";
    view.svg.style.pointerEvents = "auto";
    view.svg.style.cursor = "crosshair";
    drawingToolbar();
    schedulePaint();
  }
  function startDrawing() {
    if (!enabled()) {
      toast(label("请先启用此网站。", "Enable this site first."), true);
      return;
    }
    hideSelection();
    mode = "choose-image";
    selectedImage = undefined;
    view.svg.style.pointerEvents = "none";
    drawingToolbar();
    toast(
      label(
        "点击网页中的图片，然后圈画。Esc 退出。",
        "Click an image, then draw. Esc to exit.",
      ),
    );
  }
  async function undoDrawing() {
    if (pendingSave || unsaved) return;
    const old = undo.at(-1);
    if (!old) return;
    try {
      await request({
        type: "annotations.delete",
        id: old.id,
        expectedRevision: old.revision,
      });
      undo.pop();
      redo.push(old);
      await refresh();
    } catch (error) {
      fail(error);
    }
  }
  async function redoDrawing() {
    if (pendingSave || unsaved) return;
    const old = redo.at(-1);
    if (!old) return;
    try {
      const record = { ...old, updatedAt: new Date().toISOString() };
      const saved = await request<ImageAnnotation>({
        type: "annotations.restore",
        annotation: record,
      });
      redo.pop();
      undo.push(saved);
      await refresh();
    } catch (error) {
      fail(error);
    }
  }

  function paintImages() {
    renderFrame = 0;
    if (disposed) return;
    if (!enabled()) return;
    imageLayers.beginPaint();
    transientLayer.replaceChildren();
    const validLayers = new Set<string>();
    for (const record of annotations)
      if (record.kind === "image") {
        validLayers.add(record.id);
        const image = images.get(record.id);
        if (image?.isConnected) imageLayers.draw(record, image, focusId);
        else imageLayers.hide(record.id);
      }
    if (selectedImage?.isConnected) {
      const geometry = imageLayers.clippedGeometry(selectedImage);
      if (geometry)
        transientLayer.append(
          svgElement("rect", {
            ...geometry.clipRect,
            fill: "none",
            stroke: "#2563eb",
            "stroke-width": 1,
            "stroke-dasharray": "5 4",
          }),
        );
      if (previewShape && geometry)
        transientLayer.append(
          renderShape(previewShape, geometry, currentColor),
        );
    }
    if (unsaved?.kind === "image") {
      validLayers.add(`${unsaved.id}-unsaved`);
      const match = resolveImage(unsaved.target);
      if (match.image)
        imageLayers.draw(unsaved, match.image, focusId, "-unsaved");
    }
    imageLayers.reconcile(validLayers);
    view.svg.append(transientLayer);
  }
  function schedulePaint() {
    if (!renderFrame && !disposed)
      renderFrame = requestAnimationFrame(paintImages);
  }

  async function refresh() {
    const token = ++generation;
    refreshDepth++;
    let requestedUrl = currentUrl;
    try {
      const nextUrl = pageKey(location.href);
      if (nextUrl !== currentUrl) {
        notifications.resetScope();
        passiveRetryCount = 0;
        clearTimeout(passiveRetryTimer);
        passiveRetryTimer = undefined;
        currentUrl = nextUrl;
        annotations = [];
        states = [];
        appliedRevisions.clear();
        deletedRevisions.clear();
        images.clear();
        clearText();
        textSession.invalidate();
        exitDrawing();
        pageEnabled = false;
        modeReady = false;
        updatePalette();
        mutationObserver.disconnect();
        resizeObserver.disconnect();
        undo.length = 0;
        redo.length = 0;
        removedRecords.length = 0;
        rebinding = undefined;
        hideSelection();
      }
      requestedUrl = currentUrl;
      const [newSettings, pageMode] = await Promise.all([
        request<Settings>({ type: "settings.get" }),
        request<PageMode>({ type: "page.mode.get", pageUrl: requestedUrl }),
      ]);
      if (token !== generation || disposed) return;
      if (pageKey(location.href) !== requestedUrl) {
        queueRefresh();
        return;
      }
      passiveRetryCount = 0;
      clearTimeout(passiveRetryTimer);
      passiveRetryTimer = undefined;
      if (settings.defaultColor !== newSettings.defaultColor || mode === "idle")
        currentColor = newSettings.defaultColor;
      settings = newSettings;
      view.applyPreferences(settings);
      disabled = settings.disabledOrigins.includes(location.origin);
      pageEnabled = pageMode.enabled;
      modeReady = true;
      updatePalette();
      if (!enabled()) {
        mutationObserver.disconnect();
        resizeObserver.disconnect();
        annotations = [];
        states = [];
        clearText();
        images.clear();
        imageLayers.clear();
        transientLayer.replaceChildren();
        exitDrawing();
        hideSelection();
        notifications.hide();
        publishStates();
        return;
      }
      observeReadingPage();
      const records = await request<Annotation[]>({
        type: "annotations.list",
        pageUrl: requestedUrl,
      });
      if (token !== generation || disposed) return;
      if (pageKey(location.href) !== requestedUrl) {
        queueRefresh();
        return;
      }
      annotations = records.filter(
        (record) => (deletedRevisions.get(record.id) ?? -1) < record.revision,
      );
      clearText();
      resizeObserver.disconnect();
      images.clear();
      states = [];
      appliedRevisions.clear();
      for (const record of annotations)
        appliedRevisions.set(record.id, record.revision);
      imageLayers.clear();
      if (!enabled()) {
        exitDrawing();
        publishStates();
        return;
      }
      const supportsHighlight =
        "highlights" in CSS && typeof Highlight !== "undefined";
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        // A response started before a delete is never allowed to restore the
        // deleted version into this engine's local state.
        if (
          (deletedRevisions.get(record.id) ?? -1) >= record.revision ||
          annotations.find((item) => item.id === record.id)?.revision !==
            record.revision
        )
          continue;
        if (record.kind === "text") {
          if (!supportsHighlight)
            states.push({
              id: record.id,
              status: "unsupported",
              reason: "CSS Custom Highlight is unavailable",
            });
          else {
            const match = textSession.resolve(record.target);
            states.push({
              id: record.id,
              status: match.status,
              reason: match.reason,
            });
            if (match.range) {
              textRanges.set(record.id, match.range);
            }
          }
        } else if (record.kind === "image") {
          const match = resolveImage(record.target);
          states.push({
            id: record.id,
            status: match.status,
            reason: match.reason,
          });
          if (match.image) {
            images.set(record.id, match.image);
            resizeObserver.observe(match.image);
          }
        }
        // Yield for large pages, while a newer refresh can cancel this work.
        if (i % 20 === 19) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (token !== generation || disposed) return;
          if (pageKey(location.href) !== requestedUrl) {
            queueRefresh();
            return;
          }
        }
      }
      if (token !== generation || disposed) return;
      applyTextStyles();
      publishStates();
      schedulePaint();
    } catch (error) {
      if (disposed || token !== generation) return;
      if (
        (error instanceof RequestError && error.code === "PAGE_CHANGED") ||
        pageKey(location.href) !== requestedUrl
      ) {
        // Navigation races are expected background work, not a failed user save.
        // Retry a bounded number of times; never flood the page with an internal error.
        if (passiveRetryCount < 2 && !passiveRetryTimer) {
          passiveRetryCount++;
          passiveRetryTimer = setTimeout(() => {
            passiveRetryTimer = undefined;
            if (!disposed && !stopped) void refresh();
          }, 300);
        }
        return;
      }
      if (!pageEnabled) {
        modeReady = true;
        updatePalette();
        return;
      }
      notifications.show(
        label(
          "暂时无法恢复此页标注，可刷新网页重试。",
          "Annotations could not be restored. Reload this page to retry.",
        ),
        {
          kind: "error",
          key: `restore:${error instanceof RequestError ? error.code : "unavailable"}`,
          passive: true,
          dismissLabel: label("关闭提示", "Dismiss"),
        },
      );
    } finally {
      refreshDepth--;
    }
  }
  function publishStates() {
    void request({ type: "page.states", states, pageUrl: currentUrl }).catch(
      () => undefined,
    );
  }
  function queueRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!disposed && (enabled() || pageKey(location.href) !== currentUrl))
        void refresh();
    }, 250);
  }
  function focusRecord(id?: string) {
    const range = id ? textRanges.get(id) : undefined;
    const image = id ? images.get(id) : undefined;
    if (range) {
      const node =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      node?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (image)
      image.scrollIntoView({ block: "center", behavior: "smooth" });
    else
      toast(
        label(
          "找不到原位置，可在侧栏选择重新定位。",
          "Original location not found. Use Rebind in the sidebar.",
        ),
        true,
      );
    focusId = id;
    schedulePaint();
  }

  view.svg.addEventListener(
    "pointerdown",
    (e) => {
      if (
        mode !== "drawing" ||
        !selectedImage ||
        pendingSave ||
        unsaved ||
        e.button !== 0
      )
        return;
      const geometry = imageLayers.clippedGeometry(selectedImage);
      if (!geometry) return;
      const point = clientToImage(e.clientX, e.clientY, geometry);
      if (!point) return;
      e.preventDefault();
      drawingPointer = e.pointerId;
      view.svg.setPointerCapture(e.pointerId);
      drawingPoints = [{ ...point, pressure: e.pressure || 0.5 }];
      previewShape = {
        kind: shapeKind,
        points: drawingPoints,
        width: 3 / geometry.imageRect.width,
      };
    },
    { signal },
  );
  view.svg.addEventListener(
    "pointermove",
    (e) => {
      if (drawingPointer !== e.pointerId || !selectedImage || !previewShape)
        return;
      const geometry = imageLayers.clippedGeometry(selectedImage);
      if (!geometry) return;
      const point = clientToImage(e.clientX, e.clientY, geometry);
      if (!point) return;
      if (shapeKind === "pen") {
        if (drawingPoints.length < 2000)
          drawingPoints.push({ ...point, pressure: e.pressure || 0.5 });
      } else drawingPoints = [drawingPoints[0]!, point];
      previewShape = { ...previewShape, points: drawingPoints };
      schedulePaint();
    },
    { signal },
  );
  const endPointer = (e: PointerEvent) => {
    if (e.pointerId !== drawingPointer || !selectedImage || !previewShape)
      return;
    drawingPointer = undefined;
    if (view.svg.hasPointerCapture(e.pointerId))
      view.svg.releasePointerCapture(e.pointerId);
    const shape = previewShape;
    previewShape = undefined;
    if (shape.points.length < 2) return;
    const a = shape.points[0]!,
      b = shape.points.at(-1)!;
    if (shape.kind !== "pen" && Math.hypot(a.x - b.x, a.y - b.y) < 0.003)
      return;
    try {
      const record: ImageAnnotation = {
        ...baseRecord(currentColor),
        kind: "image",
        target: captureImage(selectedImage),
        shape,
      };
      void commit(record, true);
    } catch (error) {
      fail(error);
    }
  };
  view.svg.addEventListener("pointerup", endPointer, { signal });
  view.svg.addEventListener(
    "pointercancel",
    () => {
      drawingPointer = undefined;
      previewShape = undefined;
      schedulePaint();
    },
    { signal },
  );

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!enabled() || e.composedPath().includes(view.host)) return;
      if (mode === "choose-image") {
        const target = e.target;
        if (target instanceof HTMLImageElement) {
          e.preventDefault();
          e.stopPropagation();
          chooseImage(target);
        }
      } else if (mode === "idle") hideSelection();
    },
    { capture: true, signal },
  );
  document.addEventListener(
    "mouseup",
    (e) => {
      if (
        !enabled() ||
        mode !== "idle" ||
        e.button !== 0 ||
        e.composedPath().includes(view.host)
      )
        return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        hideSelection();
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
            annotations,
            textRanges,
            images,
            imageShape: (id) => imageLayers.shapeFor(id),
            geometryForImage: (image) => imageLayers.clippedGeometry(image),
          },
          e.clientX,
          e.clientY,
        );
        if (matches.length)
          showAnnotationActions(matches, {
            left: e.clientX,
            bottom: e.clientY,
          });
        return;
      }
      const range = selection.getRangeAt(0);
      try {
        textSession.capture(range);
        showPalette(range);
      } catch {
        hideSelection();
      }
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        exitDrawing();
        hideSelection();
        rebinding = undefined;
        return;
      }
      if (
        mode === "idle" &&
        !e.shiftKey &&
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "z" &&
        removedRecords.length &&
        !e
          .composedPath()
          .some(
            (n) =>
              n instanceof HTMLElement &&
              (n.matches("input,textarea") || n.isContentEditable),
          )
      ) {
        e.preventDefault();
        void undoRemoval();
        return;
      }
      if (
        mode === "idle" ||
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
        if (e.shiftKey) void redoDrawing();
        else void undoDrawing();
      }
    },
    { signal },
  );
  window.addEventListener(
    "scroll",
    () => {
      // A site may finish scrolling after mouseup (e.g. GitHub README hydration).
      // Reposition the palette instead of making an otherwise valid selection disappear.
      if (
        selectedRange &&
        selectedRange.startContainer.isConnected &&
        mode === "idle"
      )
        showPalette(selectedRange);
      else hideSelection();
      schedulePaint();
    },
    { capture: true, passive: true, signal },
  );
  window.addEventListener("resize", schedulePaint, { signal });
  window.addEventListener("popstate", queueRefresh, { signal });
  window.addEventListener("hashchange", queueRefresh, { signal });
  document.addEventListener(
    "load",
    (e) => {
      if (e.target instanceof HTMLImageElement) queueRefresh();
    },
    { capture: true, signal },
  );
  const resizeObserver = new ResizeObserver(schedulePaint);
  const mutationObserver = new MutationObserver((mutations) => {
    const relevant = mutations.filter(
      (m) =>
        !view.host.contains(m.target) &&
        m.target !== highlightStyle &&
        !(m.target instanceof Element && m.target.closest("[data-web-ink]")),
    );
    if (
      relevant.some(
        (m) =>
          m.type !== "attributes" ||
          m.attributeName === "src" ||
          m.attributeName === "srcset" ||
          m.attributeName === "contenteditable" ||
          m.attributeName === "id",
      )
    ) {
      queueRefresh();
    }
    if (relevant.length) schedulePaint();
  });
  function observeReadingPage() {
    mutationObserver.observe(document.body, {
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
      ],
    });
  }
  function applyAnnotationDelta(
    annotation?: Annotation,
    deletedId?: string,
    pageUrl?: string,
  ): boolean {
    if (!enabled() || (pageUrl && pageUrl !== currentUrl)) return true;
    if (!annotation && !deletedId) return false;
    if (deletedId) {
      if (refreshDepth) {
        generation++;
        queueRefresh();
      }
      const deleted = annotations.find((record) => record.id === deletedId);
      const known = appliedRevisions.get(deletedId) ?? deleted?.revision;
      if (known !== undefined)
        deletedRevisions.set(
          deletedId,
          Math.max(deletedRevisions.get(deletedId) ?? -1, known),
        );
      annotations = annotations.filter((record) => record.id !== deletedId);
      textRanges.delete(deletedId);
      images.delete(deletedId);
      appliedRevisions.delete(deletedId);
      states = states.filter((state) => state.id !== deletedId);
      if (actionRecords.some((record) => record.id === deletedId))
        hideSelection();
      imageLayers.drop(deletedId);
      applyTextStyles();
      publishStates();
      schedulePaint();
      return true;
    }
    if (
      !annotation ||
      (annotation.kind !== "text" && annotation.kind !== "image") ||
      annotation.pageUrl !== currentUrl
    )
      return true;
    const known = appliedRevisions.get(annotation.id);
    if (known !== undefined && known >= annotation.revision) return true;
    if ((deletedRevisions.get(annotation.id) ?? -1) >= annotation.revision)
      return true;
    const previous = annotations.find((record) => record.id === annotation.id);
    annotations = previous
      ? annotations.map((record) =>
          record.id === annotation!.id ? annotation! : record,
        )
      : [...annotations, annotation];
    appliedRevisions.set(annotation.id, annotation.revision);
    if ((deletedRevisions.get(annotation.id) ?? -1) < annotation.revision)
      deletedRevisions.delete(annotation.id);
    if (annotation.kind === "text") {
      const targetChanged =
        previous?.kind !== "text" ||
        JSON.stringify(previous.target) !== JSON.stringify(annotation.target);
      if (targetChanged) {
        const match = textSession.resolve(annotation.target);
        textRanges.delete(annotation.id);
        states = states.filter((state) => state.id !== annotation!.id);
        states.push({
          id: annotation.id,
          status: match.status,
          reason: match.reason,
        });
        if (match.range) textRanges.set(annotation.id, match.range);
      }
      applyTextStyles();
    } else {
      const match = resolveImage(annotation.target);
      images.delete(annotation.id);
      imageLayers.drop(annotation.id);
      states = states.filter((state) => state.id !== annotation!.id);
      states.push({
        id: annotation.id,
        status: match.status,
        reason: match.reason,
      });
      if (match.image) {
        images.set(annotation.id, match.image);
        resizeObserver.observe(match.image);
      }
    }
    publishStates();
    schedulePaint();
    return true;
  }
  const dispatch = (
    action: "focus" | "rebind" | "draw" | "refresh",
    id?: string,
  ) => {
    if (action === "refresh") {
      void refresh();
      return;
    }
    if (action === "focus") {
      void withPageEnabled(() => focusRecord(id));
      return;
    }
    if (action === "draw") {
      rebinding = undefined;
      void withPageEnabled(startDrawing);
      return;
    }
    const record = annotations.find((item) => item.id === id);
    if (!record || (record.kind !== "text" && record.kind !== "image")) return;
    rebinding = record;
    if (record.kind === "image") startDrawing();
    else {
      exitDrawing();
      toast(
        label(
          "重新选择原文，再点击高亮颜色以绑定。",
          "Select the intended text and apply a color to rebind.",
        ),
      );
    }
  };
  const onMessage = (
    message: {
      type?: string;
      pageUrl?: string;
      annotation?: Annotation;
      deletedId?: string;
    },
    _sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => {
    if (message.type === "page.snapshot") {
      respond({ pageUrl: currentUrl, states, enabled: enabled() });
      return false;
    }
    if (message.type === "permissions.revoked") {
      stopped = true;
      clearText();
      exitDrawing();
      view.svg.replaceChildren();
      mutationObserver.disconnect();
      textSession.invalidate();
      notifications.hide();
      updatePalette();
    }
    if (message.type === "permissions.restored") {
      stopped = false;
      void refresh();
    }
    if (message.type === "annotations.changed") {
      if (
        !applyAnnotationDelta(
          message.annotation,
          message.deletedId,
          message.pageUrl,
        )
      )
        void refresh();
    }
    if (
      message.type === "settings.changed" ||
      message.type === "page.mode.changed"
    )
      void refresh();
    return false;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  void refresh();
  const stop = () => {
    disposed = true;
    generation++;
    observers.abort();
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    textSession.dispose();
    clearTimeout(refreshTimer);
    clearTimeout(passiveRetryTimer);
    cancelAnimationFrame(renderFrame);
    clearText();
    notifications.dispose();
    // The bootstrap keeps the host alive; every engine-owned visual must go away.
    hideSelection();
    view.drawing.style.display = "none";
    view.svg.replaceChildren();
    view.svg.style.pointerEvents = "none";
    view.svg.style.cursor = "";
    images.clear();
    imageLayers.clear();
    chrome.runtime.onMessage.removeListener(onMessage);
    highlightStyle.remove();
  };
  const canStop = () => {
    if (!unsaved && !pendingSave) return true;
    const record = unsaved;
    toast(
      label(
        "请先处理尚未保存的修改。",
        "Resolve the unsaved change before turning annotations off.",
      ),
      true,
      record
        ? () => {
            void commit(record);
          }
        : undefined,
    );
    return false;
  };
  return {
    stop,
    dispatch,
    snapshot: () => ({ pageUrl: currentUrl, states, enabled: enabled() }),
    canStop,
  };
}
