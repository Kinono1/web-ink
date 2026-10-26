import { textLinkScope, textLinkUrl } from "../../core/text-link";
import { readAnnotationPresets } from "../../core/annotation-presets";
import { SELECTION_TOOLBAR_KEY } from "../../core/selection-toolbar";
import type { AnnotationController } from "./AnnotationController";

type EventControllerContext = Pick<
  AnnotationController,
  | "disposed"
  | "interactions"
  | "mode"
  | "render"
  | "settings"
  | "store"
  | "sync"
  | "view"
>;

/** Owns browser listeners and reading-page observer lifetimes. */
export class EventController {
  private readonly observers: AbortController = new AbortController();

  private readonly signal: AbortSignal;

  private presetStorageListenerRegistered: boolean = false;
  readonly resizeObserver: ResizeObserver;
  readonly mutationObserver: MutationObserver;

  constructor(private readonly engine: EventControllerContext) {
    const { render, view, store, sync } = this.engine;
    this.signal = this.observers.signal;
    this.resizeObserver = new ResizeObserver(render.schedulePaint);
    this.mutationObserver = new MutationObserver((mutations) => {
      const relevant = mutations.filter((m) => {
        if (
          view.host.contains(m.target) ||
          m.target === render.highlightStyle ||
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
          return baseChanged && store.annotations.some(record =>
            record.kind === "text" && textLinkUrl(record.target, record.pageUrl),
          );
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
          if (m.attributeName !== "href" || !(m.target instanceof HTMLAnchorElement))
            return false;
          const link = m.target;
          // A recycled recommendation can change destination without changing its
          // title. Only affected linked annotations need another restore pass.
          return store.annotations.some((record) => {
            if (record.kind !== "text") return false;
            const scope = textLinkScope(record.target, record.pageUrl);
            if (!scope) return false;
            const range = render.textRanges.get(record.id);
            return link.matches(scope.selector) ||
              Boolean(range && link.contains(range.startContainer));
          });
        })
      ) {
        sync.queueRefresh();
      }
      if (relevant.length) render.schedulePaint();
    });
  }

  private onPresetStorageChanged = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ) => {
    const { sync, interactions, mode } = this.engine;
    if (areaName !== "local" || this.engine.disposed) return;
    if (changes[SELECTION_TOOLBAR_KEY]) {
      sync.selectionToolbarReadGeneration++;
      interactions.selectionToolbarEnabled = changes[SELECTION_TOOLBAR_KEY]!.newValue === true;
      if (!interactions.selectionToolbarEnabled && interactions.selectionPaletteAutomatic)
        interactions.hideSelection();
    }
    if (!changes["ui.annotationPresets"])
      return;
    const token = sync.generation;
    const presetReadToken = ++sync.presetReadGeneration;
    void readAnnotationPresets(this.engine.settings.language)
      .then((next) => {
        if (
          this.engine.disposed ||
          token !== sync.generation ||
          presetReadToken !== sync.presetReadGeneration
        )
          return;
        interactions.annotationPresets = next;
        if (interactions.selectedRange?.startContainer.isConnected && mode.mode === "idle")
          interactions.showPalette(interactions.selectedRange);
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
    const { view, mode, interactions, render, sync } = this.engine;
    const { signal } = this;
    view.svg.addEventListener("pointerdown", mode.onPointerDown, { signal });
    view.svg.addEventListener("pointermove", mode.onPointerMove, { signal });
    view.svg.addEventListener("pointerup", mode.onPointerUp, { signal });
    view.svg.addEventListener("pointercancel", mode.onPointerCancel, { signal });
    document.addEventListener("pointerdown", interactions.onPointerDown, {
      capture: true,
      signal,
    });
    document.addEventListener("mouseup", interactions.onMouseUp, { signal });
    document.addEventListener("keydown", interactions.onKeyDown, { signal });
    try {
      chrome.storage.onChanged?.addListener(this.onPresetStorageChanged);
      this.presetStorageListenerRegistered = Boolean(chrome.storage.onChanged);
    } catch {
      // Chrome can invalidate storage before the engine finishes DOM cleanup.
    }
    window.addEventListener("scroll", interactions.onScroll, {
      capture: true,
      passive: true,
      signal,
    });
    window.addEventListener("resize", render.schedulePaint, { signal });
    window.addEventListener("popstate", sync.queueRefresh, { signal });
    window.addEventListener("hashchange", sync.queueRefresh, { signal });
    document.addEventListener("load", (event) => {
      if (event.target instanceof HTMLImageElement) sync.queueRefresh();
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
