import { PdfMarks, PdfSearchMarks } from "./components/PdfMarks";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Language, PdfRect } from "../core/model";
import type { PdfSearchMatch } from "./search";
import { fromPdfRect, mergePdfTextRects, toPdfRect } from "./geometry";
import { createNativeLayer, parseNativePdfAnnotations } from "./native-annotations";
import { usePdfPageRender } from "./hooks/usePdfPageRender";
import { textFor } from "./components/labels";
import {
  type OpenDocument,
  type PdfAnnotation,
  type SelectionTarget,
  type SelectionPreview,
  type NativePdfAnnotation,
} from "../core/pdf-types";
export const PdfPage = memo(function PdfPage({
  language = "zh-CN",
  opened,
  number,
  zoom,
  rotation,
  records,
  area,
  color,
  measurementGeneration,
  searchRanges,
  onSearchPosition,
  onSelection,
  onPick,
  onArea,
  onDimensions,
  onError,
  onNativeRecords,
  recoveryPreview,
}: {
  language?: Language;
  opened: OpenDocument;
  number: number;
  zoom: number;
  rotation: number;
  records: PdfAnnotation[];
  area: boolean;
  color: string;
  measurementGeneration: number;
  searchRanges?: PdfSearchMatch["itemRanges"];
  onSearchPosition?: (top: number) => void;
  onSelection: (v: SelectionPreview | undefined) => void;
  onPick: (record: PdfAnnotation) => void;
  onArea: (v: SelectionTarget) => void;
  onDimensions: (generation: number, w: number, h: number) => void;
  onError: (e: string) => void;
  onNativeRecords?: (records: NativePdfAnnotation[]) => void;
  recoveryPreview?: { rect: PdfRect; color: string };
}) {
  const t = textFor(language);
  const native = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; pointer: number } | undefined>(undefined);
  const [preview, setPreview] = useState<PdfRect>();
  useLayoutEffect(() => {
    setPreview(undefined);
    drag.current = undefined;
  }, [opened, number, zoom, rotation, measurementGeneration]);
  const { root, canvas, text, committedLayer, ready, rendering, failure, geometry } = usePdfPageRender({
    opened, number, zoom, rotation, measurementGeneration, onDimensions,
  });
  const marks = useMemo(() => {
    if (!geometry || geometry.opened !== opened || geometry.number !== number) return [];
    return records.map((record) => ({
      record,
      rects: (record.kind === "pdf-text"
        ? mergePdfTextRects(record.target.rects, geometry.box, geometry.intrinsicRotation)
        : record.target.rects
      ).map((rect) => fromPdfRect(rect, geometry.viewport, geometry.box)),
    }));
  }, [geometry, number, opened, records]);
  const [searchRects, setSearchRects] = useState<PdfRect[]>([]);
  const callbacks = useRef({ onError, onSearchPosition, onNativeRecords });
  callbacks.current = { onError, onSearchPosition, onNativeRecords };
  useEffect(() => {
    const layerRoot = native.current;
    if (!ready || !geometry || geometry.opened !== opened || geometry.number !== number || !layerRoot) return;
    let dead = false;
    let committed: Awaited<ReturnType<typeof createNativeLayer>> | undefined;
    void (async () => {
      try {
        const page = await opened.document.getPage(number);
        if (dead || typeof page.getAnnotations !== "function") return;
        const annotations = await page.getAnnotations({ intent: "display" });
        if (dead) return;
        const records = opened.nativeAnnotations
          ? await opened.nativeAnnotations.readPage(number)
          : parseNativePdfAnnotations(annotations, opened.hash, number);
        if (dead) return;
        callbacks.current.onNativeRecords?.(records);
        if (!opened.api.AnnotationLayer) return;
        const imageResourcesPath = typeof chrome !== "undefined" && chrome.runtime?.getURL
          ? chrome.runtime.getURL("/pdfjs/images/") : "/pdfjs/images/";
        const layer = await createNativeLayer(opened.api, page, geometry.viewport, annotations, imageResourcesPath);
        if (dead || !layerRoot.isConnected) { layer.destroy(); return; }
        committed = layer;
        layerRoot.replaceChildren(layer.div);
      } catch (error) {
        if (!dead && !(error instanceof Error && error.name === "AbortError"))
          callbacks.current.onError("原文件笔记暂时无法读取。 / Original-file notes could not be read.");
      }
    })();
    return () => {
      dead = true;
      committed?.destroy();
      layerRoot.replaceChildren();
    };
  }, [opened, number, geometry, ready]);
  useLayoutEffect(() => {
    setSearchRects([]);
    const layer = committedLayer.current;
    const pageRoot = root.current;
    if (!ready || !geometry || !layer || !pageRoot || !searchRanges?.length) return;
    const bounds = pageRoot.getBoundingClientRect();
    const rects: PdfRect[] = [];
    let firstTop: number | undefined;
    for (const item of searchRanges) {
      const element = layer.textDivs?.[item.itemIndex];
      const node = element?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE || item.end > (node.textContent?.length ?? 0)) continue;
      const range = document.createRange();
      range.setStart(node, item.start);
      range.setEnd(node, item.end);
      for (const client of range.getClientRects()) {
        if (!client.width || !client.height) continue;
        const rect = toPdfRect({ left: client.left - bounds.left, top: client.top - bounds.top,
          right: client.right - bounds.left, bottom: client.bottom - bounds.top }, geometry.viewport, geometry.box);
        if (rect) { rects.push(rect); firstTop ??= client.top - bounds.top; }
      }
    }
    setSearchRects(rects);
    if (firstTop !== undefined) callbacks.current.onSearchPosition?.(firstTop);
  }, [ready, geometry, searchRanges]);
  function capture(event: React.MouseEvent<HTMLDivElement> | KeyboardEvent) {
    if (event.target instanceof Element && event.target.closest(".pdf-native-layer")) return;
    if (area || !ready || !geometry || !text.current || root.current?.dataset.ready !== "true") return;
    const s = getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) {
      if (event instanceof KeyboardEvent) {
        onSelection(undefined);
        return;
      }
      const page = root.current.getBoundingClientRect();
      const x = event.clientX - page.left,
        y = event.clientY - page.top;
      // Area outlines paint above the text SVG, regardless of record age.
      const picked = [
        ...marks.filter(({ record }) => record.kind === "pdf-area").reverse(),
        ...marks.filter(({ record }) => record.kind === "pdf-text").reverse(),
      ].find(({ rects }) =>
        rects.some((bounds) => x >= bounds.x && x <= bounds.x + bounds.width &&
          y >= bounds.y && y <= bounds.y + bounds.height),
      );
      if (picked) onPick(picked.record);
      else onSelection(undefined);
      return;
    }
    const range = s.getRangeAt(0);
    if (
      !text.current.contains(range.startContainer) ||
      !text.current.contains(range.endContainer)
    ) {
      onSelection(undefined);
      onError("请在同一页内选择文字；跨页选择不会保存。 / Select text within one page; cross-page selections are not saved.");
      return;
    }
    const exact = s.toString().trim();
    if (!exact || exact.length > 20000) return;
    const box = root.current.getBoundingClientRect();
    const rects: PdfRect[] = [];
    const seen = new Set<string>();
    const clientRects = [...range.getClientRects()];
    for (const rect of clientRects) {
      const normalized = toPdfRect(
        {
          left: rect.left - box.left,
          top: rect.top - box.top,
          right: rect.right - box.left,
          bottom: rect.bottom - box.top,
        },
        geometry.viewport,
        geometry.box,
      );
      if (normalized) {
        const key = Object.values(normalized)
          .map((v) => v.toFixed(5))
          .join(",");
        if (!seen.has(key)) {
          seen.add(key);
          rects.push(normalized);
        }
      }
    }
    if (!rects.length || rects.length > 1000) return;
    const before = range.cloneRange();
    before.selectNodeContents(text.current);
    before.setEnd(range.startContainer, range.startOffset);
    const after = range.cloneRange();
    after.selectNodeContents(text.current);
    after.setStart(range.endContainer, range.endOffset);
    onSelection({ target: {
      pageNumber: number,
      rects,
      exact,
      prefix: before.toString().slice(-64),
      suffix: after.toString().slice(0, 64),
    }, anchor: {
      left: Math.min(...clientRects.map((rect) => rect.left)),
      top: Math.min(...clientRects.map((rect) => rect.top)),
      right: Math.max(...clientRects.map((rect) => rect.right)),
      bottom: Math.max(...clientRects.map((rect) => rect.bottom)),
    } });
  }
  useEffect(() => {
    // Keyboard selection can originate from the focusable page scroller,
    // outside this page node. Only the page owning its anchor may capture it.
    const recapture = (event: KeyboardEvent) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest(
        ".pdf-native-layer, input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox']",
      )) return;
      const selection = getSelection();
      if (!text.current || !selection || !text.current.contains(selection.anchorNode)) return;
      capture(event);
    };
    document.addEventListener("keyup", recapture);
    return () => document.removeEventListener("keyup", recapture);
  }, [area, ready, geometry, records, number, onSelection, onPick, onError]);
  function position(e: React.PointerEvent) {
    const r = root.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
      y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
    };
  }
  return (
    <div
      className="pdf-page"
      ref={root}
      data-ready={ready}
      data-rendering={rendering}
      onMouseUp={capture}
      onClick={capture}
      style={{
        width: geometry?.viewport.width,
        height: geometry?.viewport.height,
      }}
    >
      <canvas ref={canvas} aria-label={`PDF ${number}`} />
      <div className="textLayer" ref={text} style={{
        pointerEvents: ready ? undefined : "none",
        userSelect: ready ? undefined : "none",
      }} />
      <div className="pdf-native-layer" ref={native} aria-label={t("原文件标注只读", "Original-file annotations are read-only")} />
      {failure && <div className="pdf-page-error" role="alert">
        <h2>{t(`第 ${number} 页无法完整显示`, `Page ${number} could not be displayed completely`)}</h2>
        <p>{failure === "image-too-large"
          ? t("图片过大，已停止显示以保护内存。", "An image is too large to display safely.")
          : t("这页暂时无法显示，请重新打开 PDF。", "This page could not be displayed. Reopen the PDF to try again.")}</p>
        <p>{t("标注仍保存在本机。请用原阅读器或其他 PDF 工具查看这一页。", "Your annotations remain saved locally. View this page in the original reader or another PDF tool.")}</p>
      </div>}
      {geometry && !failure && geometry.opened === opened && geometry.number === number &&
        <PdfMarks geometry={geometry} marks={marks} preview={preview ?? recoveryPreview?.rect} color={preview ? color : recoveryPreview?.color ?? color} />}
      {ready && geometry && searchRects.length > 0 &&
        <PdfSearchMarks geometry={geometry} rects={searchRects} />}
      {area && ready && geometry && (
        <div
          className="pdf-area-capture"
          onPointerDown={(e) => {
            if (e.button !== 0 || root.current?.dataset.ready !== "true") return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { ...position(e), pointer: e.pointerId };
            onSelection(undefined);
          }}
          onPointerMove={(e) => {
            const a = drag.current;
            if (!a || a.pointer !== e.pointerId) return;
            const b = position(e);
            setPreview(
              toPdfRect(
                {
                  left: Math.min(a.x, b.x),
                  top: Math.min(a.y, b.y),
                  right: Math.max(a.x, b.x),
                  bottom: Math.max(a.y, b.y),
                },
                geometry.viewport,
                geometry.box,
              ),
            );
          }}
          onPointerUp={(e) => {
            if (drag.current?.pointer !== e.pointerId) return;
            const start = drag.current;
            const end = position(e);
            // Pointerup may arrive before React commits the last preview.
            const finalRect = toPdfRect({
              left: Math.min(start.x, end.x),
              top: Math.min(start.y, end.y),
              right: Math.max(start.x, end.x),
              bottom: Math.max(start.y, end.y),
            }, geometry.viewport, geometry.box);
            drag.current = undefined;
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
            if (finalRect)
              onArea({
                pageNumber: number,
                rects: [finalRect],
                exact: "",
                prefix: "",
                suffix: "",
              });
            setPreview(undefined);
          }}
          onPointerCancel={() => {
            drag.current = undefined;
            setPreview(undefined);
          }}
        />
      )}
    </div>
  );
});
