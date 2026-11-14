import type { PdfSearchMatch } from "../search";
import {
  errorText, type PdfAnnotation, type SelectionPreview, type SelectionTarget,
} from "../../core/pdf-types";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PageLayoutIndex } from "../reading-position";
import {
  PDF_MIN_ZOOM, PDF_MAX_ZOOM, capturePdfReadingPosition, restorePdfReadingPosition,
  type PdfRotation,
} from "../reading-position";
import {
  type PositionSession, type ReaderSnapshot, type ReaderActions, type ReaderActionsRef,
} from "./contracts";

const FALLBACK_SELECTION_STYLE: React.CSSProperties = {};

export function useViewportState() {
  const nativeFocus = useRef<{ session: number; pageNumber: number; top: number; intent: number } | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<PdfRotation>(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [searchMatch, setSearchMatch] = useState<PdfSearchMatch>();
  const pendingSearchPosition = useRef<{ pageNumber: number; intent: number } | undefined>(undefined);
  const [zoomText, setZoomText] = useState("100%");
  const [fitWidth, setFitWidth] = useState(false);
  const intrinsicDimensions = useRef(new Map<number, { width: number; height: number }>());
  const currentView = useRef({ zoom, rotation });
  const [selection, setSelection] = useState<SelectionPreview>();
  const selectionBar = useRef<HTMLDivElement>(null);
  const [selectionStyle, setSelectionStyle] = useState(FALLBACK_SELECTION_STYLE);
  const [positionError, setPositionError] = useState("");
  const [positionEpoch, setPositionEpoch] = useState(0);
  const positionSession = useRef<PositionSession | undefined>(undefined);
  const intentEpoch = useRef(0);
  const [pageWindow, setPageWindow] = useState({ start: 0, end: 3 });
  const container = useRef<HTMLDivElement>(null);
  const layoutIndex = useRef(new PageLayoutIndex());
  const measureFrame = useRef(0);
  const layoutGeneration = useRef(0);
  const pendingScrollAdjustment = useRef(0);
  const pendingMeasures = useRef(
      new Map<number, { width: number; height: number }>(),
    );
  const dimensions = useRef(new Map<number, { width: number; height: number }>());
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [measurementGeneration, setMeasurementGeneration] = useState(0);
  currentView.current = { zoom, rotation };
  return {
    nativeFocus, zoom, setZoom, rotation, setRotation, pageNumber, setPageNumber, searchMatch,
    setSearchMatch, pendingSearchPosition, zoomText, setZoomText, fitWidth, setFitWidth,
    intrinsicDimensions, currentView, selection, setSelection, selectionBar, selectionStyle,
    setSelectionStyle, positionError, setPositionError, positionEpoch, setPositionEpoch,
    positionSession, intentEpoch, pageWindow, setPageWindow, container, layoutIndex,
    measureFrame, layoutGeneration, pendingScrollAdjustment, pendingMeasures, dimensions,
    layoutEpoch, setLayoutEpoch, measurementGeneration, setMeasurementGeneration,
  };
}
type Inputs = Pick<ReaderSnapshot,
  "container" | "currentView" | "dimensions" | "documentSession" | "documentSessionRef" |
  "fitWidth" | "focusMode" | "intentEpoch" | "intrinsicDimensions" | "layoutEpoch" |
  "layoutGeneration" | "layoutIndex" | "measureFrame" | "nativeFocus" | "opened" |
  "pageNumber" | "pageWindow" | "pendingMeasures" | "pendingScrollAdjustment" | "positionEpoch" |
  "positionSession" | "rotation" | "selection" | "selectionBar" | "setError" | "setFitWidth" |
  "setLayoutEpoch" | "setMeasurementGeneration" | "setPageNumber" | "setPageWindow" |
  "setPicked" | "setPositionEpoch" | "setPositionError" | "setRotation" | "setSelection" |
  "setSelectionStyle" | "setZoom" | "setZoomText" | "t" | "zoom"
>;

export function useViewport(state: Inputs, actions: ReaderActionsRef<"tell">,) {
  const {
    container, currentView, dimensions, documentSession, documentSessionRef, fitWidth,
    focusMode, intentEpoch, intrinsicDimensions, layoutEpoch, layoutGeneration, layoutIndex,
    measureFrame, nativeFocus, opened, pageNumber, pageWindow, pendingMeasures, pendingScrollAdjustment,
    positionEpoch, positionSession, rotation, selection, selectionBar, setError, setFitWidth,
    setLayoutEpoch, setMeasurementGeneration, setPageNumber, setPageWindow, setPicked,
    setPositionEpoch, setPositionError, setRotation, setSelection, setSelectionStyle, setZoom,
    setZoomText, t, zoom,
  } = state;
  useEffect(() => () => {
    const position = positionSession.current;
    positionSession.current = undefined;
    if (position) void position.writer.flush().catch(() => undefined).finally(() => position.writer.dispose());
    cancelAnimationFrame(measureFrame.current);
    measureFrame.current = 0;
  }, []);
  const userIntent = useCallback(() => {
    intentEpoch.current++;
    nativeFocus.current = undefined;
    const position = positionSession.current;
    if (position?.pending) {
      position.pending = undefined;
      setPositionEpoch((epoch) => epoch + 1);
    }
  }, [intentEpoch, nativeFocus, positionSession, setPositionEpoch]);
  const pagesPadding = useCallback(() => {
    return container.current ? parseFloat(getComputedStyle(container.current).paddingTop) || 0 : 0;
  }, [container]);
  function currentPosition(top?: number) {
    const active = positionSession.current;
    const scroller = container.current;
    if (!active || !scroller || active.session !== documentSessionRef.current || !active.readReady || active.pending) return;
    const offset = top ?? Math.max(0, scroller.scrollTop - pagesPadding());
    if (!dimensions.current.has(layoutIndex.current.pageAt(offset))) return;
    return capturePdfReadingPosition(layoutIndex.current, offset, zoom, rotation);
  }
  function savePosition(top?: number) {
    const snapshot = currentPosition(top);
    if (snapshot) positionSession.current?.writer.save(snapshot);
  }
  async function flushPosition() {
    savePosition();
    try {
      await positionSession.current?.writer.flush();
      setPositionError("");
    } catch {
      setPositionError(t("阅读位置暂未保存，可重试；标注不受影响。", "Reading position was not saved. Retry is available; annotations are unaffected."));
    }
  }
  useLayoutEffect(() => {
    if (!opened) return;
    const scroller = container.current;
    const oldScroll = scroller?.scrollTop ?? 0;
    const padding = pagesPadding();
    const anchor = scroller ? layoutIndex.current.pageAt(Math.max(0, oldScroll - padding)) : 1;
    const relative = Math.max(0, oldScroll - padding) - layoutIndex.current.offsetBefore(anchor);
    cancelAnimationFrame(measureFrame.current);
    measureFrame.current = 0;
    pendingMeasures.current.clear();
    pendingScrollAdjustment.current = 0;
    layoutGeneration.current++;
    setMeasurementGeneration(layoutGeneration.current);
    const fallback = (rotation % 180 ? 612 : 792) * zoom;
    layoutIndex.current.reset(opened.document.numPages, fallback);
    dimensions.current.clear();
    for (const [page, size] of intrinsicDimensions.current) {
      const width = (rotation % 180 ? size.height : size.width) * zoom;
      const height = (rotation % 180 ? size.width : size.height) * zoom;
      dimensions.current.set(page, { width, height });
      layoutIndex.current.update(page, height);
    }
    pendingScrollAdjustment.current = scroller
      ? layoutIndex.current.offsetBefore(anchor) + relative + padding - oldScroll
      : 0;
    setLayoutEpoch((value) => value + 1);
  }, [documentSession, zoom, rotation]);
  const onPageDimensions = useCallback(
    (page: number, generation: number, width: number, height: number) => {
      if (generation !== layoutGeneration.current) return;
      const view = currentView.current;
      intrinsicDimensions.current.set(page, {
        width: (view.rotation % 180 ? height : width) / view.zoom,
        height: (view.rotation % 180 ? width : height) / view.zoom,
      });
      pendingMeasures.current.set(page, { width, height });
      if (measureFrame.current) return;
      measureFrame.current = requestAnimationFrame(() => {
        measureFrame.current = 0;
        const scroller = container.current;
        const anchor = scroller
          ? layoutIndex.current.pageAt(Math.max(0, scroller.scrollTop - pagesPadding()))
          : 1;
        const before = scroller ? layoutIndex.current.offsetBefore(anchor) : 0;
        if (generation !== layoutGeneration.current) return;
        const measurements = [...pendingMeasures.current];
        let changed = false;
        for (const [number, size] of measurements) {
          if (layoutIndex.current.update(number, size.height)) changed = true;
        }
        pendingMeasures.current.clear();
        if (scroller && changed)
          pendingScrollAdjustment.current +=
            layoutIndex.current.offsetBefore(anchor) - before;
        let dimensionsChanged = false;
        for (const [number, size] of measurements) {
          const previous = dimensions.current.get(number);
          if (
            previous?.width !== size.width ||
            previous?.height !== size.height
          ) {
            dimensions.current.set(number, size);
            dimensionsChanged = true;
          }
        }
        if (changed || dimensionsChanged) setLayoutEpoch((value) => value + 1);
      });
    },
    [],
  );
  useLayoutEffect(() => {
    const adjustment = pendingScrollAdjustment.current;
    if (!adjustment) return;
    const scroller = container.current;
    if (scroller) scroller.scrollTop += adjustment;
    pendingScrollAdjustment.current = 0;
  }, [layoutEpoch]);
  useLayoutEffect(() => {
    const pending = nativeFocus.current;
    const scroller = container.current;
    if (!pending || !scroller || pending.session !== documentSessionRef.current || pending.intent !== intentEpoch.current || !dimensions.current.has(pending.pageNumber)) return;
    nativeFocus.current = undefined;
    const start = layoutIndex.current.offsetBefore(pending.pageNumber) + pagesPadding();
    scroller.scrollTo({ top: Math.max(start, start + pending.top - scroller.clientHeight / 4), behavior: "instant" });
  }, [layoutEpoch, positionEpoch]);
  useLayoutEffect(() => {
    const active = positionSession.current;
    const pending = active?.pending;
    const scroller = container.current;
    if (!active || !pending || !scroller || active.session !== documentSessionRef.current) return;
    if (active.intent !== intentEpoch.current) { active.pending = undefined; return; }
    if (!dimensions.current.has(pending.pageNumber)) return;
    const top = restorePdfReadingPosition(layoutIndex.current, pending);
    if (top === undefined) return;
    pendingScrollAdjustment.current = 0;
    scroller.scrollTop = top + pagesPadding();
    active.pending = undefined;
    setPageNumber(pending.pageNumber);
    setPositionEpoch((epoch) => epoch + 1);
  }, [layoutEpoch, positionEpoch, documentSession, zoom, rotation]);
  useLayoutEffect(() => {
    const bar = selectionBar.current;
    const scroller = container.current;
    if (!selection || !bar || !scroller) return;
    const page = scroller.getBoundingClientRect();
    const bounds = bar.getBoundingClientRect();
    const left = Math.max(8, page.left), right = Math.min(innerWidth - 8, page.right);
    const top = Math.max(focusMode ? 8 : 60, page.top), bottom = Math.min(innerHeight - (focusMode ? 80 : 8), page.bottom);
    const anchor = selection.anchor;
    const above = anchor.top - bounds.height - 8;
    const below = anchor.bottom + 8;
    if (bounds.width > right - left || anchor.bottom < top || anchor.top > bottom || (above < top && below + bounds.height > bottom)) {
      setSelectionStyle(FALLBACK_SELECTION_STYLE);
      return;
    }
    setSelectionStyle({ left: Math.max(left, Math.min(right - bounds.width, (anchor.left + anchor.right - bounds.width) / 2)),
      top: above >= top ? above : below, bottom: "auto", transform: "none" });
  }, [selection, layoutEpoch, focusMode]);
  const updateVisiblePages = useEffectEvent((scroller: HTMLDivElement) => {
    if (!opened || positionSession.current?.pending) return;
    const layout = layoutIndex.current;
    const top = Math.max(0, scroller.scrollTop - pagesPadding());
    const bottom = top + scroller.clientHeight;
    const first = layout.pageAt(top);
    const last = layout.pageAt(bottom);
    const start = Math.max(0, first - 2);
    const end = Math.min(opened.document.numPages, last + 1);
    if (pageWindow.start !== start || pageWindow.end !== end) setPageWindow({ start, end });

    let chosen = first, largest = -1;
    for (let page = first; page <= last; page++) {
      const start = layout.offsetBefore(page);
      const height = layout.pageHeight(page) ?? 0;
      const visible = Math.max(0, Math.min(bottom, start + height) - Math.max(top, start));
      const fraction = height > 0 ? visible / height : 0;
      // Scroll clamping near the end can leave two pages equally visible.
      if (fraction > largest + 0.0001 || (Math.abs(fraction - largest) < 0.0001 && page === pageNumber)) {
        chosen = page;
        largest = fraction;
      }
    }
    if (chosen !== pageNumber) setPageNumber(chosen);
    savePosition(top);
  });
  useEffect(() => {
    const scroller = container.current;
    if (!opened || !scroller) return;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (selectionBar.current) setSelectionStyle(FALLBACK_SELECTION_STYLE);
        updateVisiblePages(scroller);
      });
    };
    const resize = new ResizeObserver(scheduleUpdate);
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    resize.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", scheduleUpdate);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [opened, container, selectionBar, setSelectionStyle]);
  useEffect(() => {
    if (container.current) updateVisiblePages(container.current);
  }, [layoutEpoch, positionEpoch, documentSession, zoom, rotation]);
  const jump = useCallback((n: number) => {
    if (!opened || documentSession !== documentSessionRef.current) return;
    userIntent();
    const page = Math.min(opened.document.numPages, Math.max(1, n));
    setPageNumber(page);
    setPageWindow({
      start: Math.max(0, page - 2),
      end: Math.min(opened.document.numPages, page + 2),
    });
    container.current?.scrollTo({
      top: layoutIndex.current.offsetBefore(page) + pagesPadding(),
      behavior: "instant",
    });
  }, [
    opened, documentSession, documentSessionRef, userIntent, setPageNumber, setPageWindow,
    container, layoutIndex, pagesPadding,
  ]);
  function applyView(nextZoom: number, nextRotation: PdfRotation = rotation) {
    if (nextZoom === zoom && nextRotation === rotation) return;
    const anchor = positionSession.current?.pending ?? currentPosition();
    userIntent();
    const active = positionSession.current;
    if (active && anchor) {
      active.intent = intentEpoch.current;
      active.pending = { ...anchor, zoom: nextZoom, rotation: nextRotation };
      setPageWindow({ start: Math.max(0, anchor.pageNumber - 2), end: Math.min(opened?.document.numPages ?? 0, anchor.pageNumber + 2) });
    }
    setSelection(undefined);
    setPicked(undefined);
    getSelection()?.removeAllRanges();
    setZoom(nextZoom);
    setRotation(nextRotation);
  }
  function changeZoom(delta: number) {
    setFitWidth(false);
    applyView(Math.max(PDF_MIN_ZOOM, Math.min(PDF_MAX_ZOOM, Math.round((zoom + delta) * 1000) / 1000)));
  }
  function commitZoom(raw: string) {
    const value = /^\d+(?:\.\d+)?\s*%?$/.test(raw.trim()) ? Number(raw.trim().replace(/%$/, "").trim()) / 100 : NaN;
    if (Number.isFinite(value) && value >= PDF_MIN_ZOOM && value <= PDF_MAX_ZOOM) {
      setFitWidth(false);
      applyView(value);
      setZoomText(`${Math.round(value * 100)}%`);
    } else {
      setZoomText(`${Math.round(zoom * 100)}%`);
      actions.current.tell(t("请输入 10%～500% 的缩放比例。", "Enter a zoom percentage between 10% and 500%."));
    }
  }
  useEffect(() => { setZoomText(`${Math.round(zoom * 100)}%`); }, [zoom]);
  useEffect(() => {
    const scroller = container.current;
    if (!fitWidth || !opened || !scroller) return;
    let dead = false, request = 0;
    const fit = async () => {
      const token = ++request;
      try {
        const page = await opened.document.getPage(pageNumber);
        if (dead || token !== request) return;
        const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
        const style = getComputedStyle(scroller);
        const available = (scroller.clientWidth || scroller.getBoundingClientRect().width) - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
        const value = Math.max(PDF_MIN_ZOOM, Math.min(PDF_MAX_ZOOM, available / viewport.width));
        if (Number.isFinite(value) && Math.abs(value - zoom) > 0.0001) applyView(value);
      } catch (cause) { if (!dead) setError(errorText(cause)); }
    };
    void fit();
    const resize = new ResizeObserver(() => void fit());
    resize.observe(scroller);
    return () => { dead = true; resize.disconnect(); };
  }, [opened, fitWidth, pageNumber, rotation, zoom]);
  return {
    userIntent, pagesPadding, currentPosition, savePosition, flushPosition, onPageDimensions,
    jump, applyView, changeZoom, commitZoom,
  };
}
type PageBindingsInputs = Pick<ReaderSnapshot,
  "annotationWrites" | "container" | "documentSession" | "documentSessionRef" |
  "intentEpoch" | "layoutIndex" | "pendingSearchPosition" | "setError" |
  "setNativeError" | "setPicked" | "setSelection" | "unsavedRef"
>;
type Commands = Pick<ReaderActions, "mark" | "onPageDimensions" | "pagesPadding">;
type PageProps = { onSelection: (value: SelectionPreview | undefined) => void; onPick: (record: PdfAnnotation) => void; onArea: (target:
  SelectionTarget) => void; onError: (message: string) => void; onDimensions: (generation: number, width: number, height: number) => void;
  onSearchPosition?: (top: number) => void; };
// Page callbacks keep their identity across toolbar/draft updates, but read the
// current commands. Their captured session prevents a removed page from writing
// to a later document, including a replacement with the same byte hash.
export function usePdfPageBindings(state: PageBindingsInputs, actions: Commands) {
  const latest = useRef({ state, actions });
  latest.current = { state, actions };
  return useMemo(() => {
    const active = state.documentSession;
    const current = () => active === latest.current.state.documentSessionRef.current
      ? latest.current : undefined;
    const shared = {
      onSelection: ((next) => {
        const value = current();
        if (value && !value.state.unsavedRef.current && !value.state.annotationWrites.current.size) {
          value.state.setSelection(next);
          value.state.setPicked(undefined);
        }
      }) satisfies PageProps["onSelection"],
      onPick: ((record) => {
        const value = current();
        if (!value) return;
        value.state.setPicked(record);
        if (!value.state.unsavedRef.current) value.state.setSelection(undefined);
      }) satisfies PageProps["onPick"],
      onArea: ((target) => current()?.actions.mark(target, "pdf-area")) satisfies PageProps["onArea"],
      onError: ((message) => {
        const value = current();
        if (!value) return;
        value.state.setError(message);
        if (/原文件|Original-file/.test(message)) value.state.setNativeError(message);
      }) satisfies PageProps["onError"],
    };
    const pages = new Map<number, Pick<PageProps, "onSearchPosition" | "onDimensions">>();
    return (number: number) => {
      let bindings = pages.get(number);
      if (!bindings) {
        bindings = {
          onDimensions: (generation, width, height) => {
            current()?.actions.onPageDimensions(number, generation, width, height);
          },
          onSearchPosition: (top) => {
            const value = current();
            if (!value) return;
            const { pendingSearchPosition, container, intentEpoch, layoutIndex } = value.state;
            const pending = pendingSearchPosition.current;
            const scroller = container.current;
            if (!pending || pending.pageNumber !== number || pending.intent !== intentEpoch.current || !scroller) return;
            pendingSearchPosition.current = undefined;
            const start = layoutIndex.current.offsetBefore(number) + value.actions.pagesPadding();
            scroller.scrollTo({ top: Math.max(start, start + top - scroller.clientHeight / 4), behavior: "instant" });
          },
        };
        pages.set(number, bindings);
      }
      return { ...shared, ...bindings };
    };
  }, [state.documentSession]);
}
