import { useEffect, useRef, useState } from "react";
import type {
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import type { PdfRect } from "../core/model";
import { fromPdfRect, toPdfRect } from "./geometry";
import {
  errorText,
  type OpenDocument,
  type PdfAnnotation,
  type PdfApi,
  type SelectionTarget,
} from "./types";
export function PdfPage({
  opened,
  number,
  zoom,
  rotation,
  records,
  enabled,
  area,
  color,
  measurementGeneration,
  onSelection,
  onPick,
  onArea,
  onDimensions,
  onError,
}: {
  opened: OpenDocument;
  number: number;
  zoom: number;
  rotation: number;
  records: PdfAnnotation[];
  enabled: boolean;
  area: boolean;
  color: string;
  measurementGeneration: number;
  onSelection: (v: SelectionTarget | undefined) => void;
  onPick: (record: PdfAnnotation) => void;
  onArea: (v: SelectionTarget) => void;
  onDimensions: (generation: number, w: number, h: number) => void;
  onError: (e: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; y: number; pointer: number } | undefined>(
      undefined,
    );
  const [geometry, setGeometry] = useState<{
      viewport: PageViewport;
      box: number[];
    }>(),
    [preview, setPreview] = useState<PdfRect>();
  const callbacks = useRef({ onDimensions, onError });
  callbacks.current = { onDimensions, onError };
  useEffect(() => {
    const generation = measurementGeneration;
    let dead = false;
    let page: PDFPageProxy | undefined,
      render: RenderTask | undefined,
      layer: InstanceType<PdfApi["TextLayer"]> | undefined;
    setGeometry(undefined);
    if (root.current) root.current.dataset.ready = "false";
    void (async () => {
      try {
        page = await opened.document.getPage(number);
        const pageRoot = root.current,
          c = canvas.current,
          layerRoot = text.current;
        if (dead || !pageRoot || !c || !layerRoot) return;
        const viewport = page.getViewport({
          scale: zoom,
          rotation: (page.rotate + rotation) % 360,
        });
        const ratio = Math.min(
          devicePixelRatio || 1,
          2,
          Math.sqrt(16777216 / (viewport.width * viewport.height)),
        );
        c.width = Math.floor(viewport.width * ratio);
        c.height = Math.floor(viewport.height * ratio);
        c.style.width = `${viewport.width}px`;
        c.style.height = `${viewport.height}px`;
        pageRoot.style.setProperty(
          "--total-scale-factor",
          String(viewport.scale),
        );
        pageRoot.style.setProperty("--scale-factor", String(viewport.scale));
        callbacks.current.onDimensions(
          generation,
          viewport.width,
          viewport.height,
        );
        setGeometry({ viewport, box: page.view });
        render = page.render({
          canvas: c,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        await render.promise;
        if (dead) return;
        layerRoot.replaceChildren();
        layer = new opened.api.TextLayer({
          textContentSource: page.streamTextContent(),
          container: layerRoot,
          viewport,
        });
        await layer.render();
        if (!dead && pageRoot.isConnected) pageRoot.dataset.ready = "true";
      } catch (cause) {
        if (
          !dead &&
          !(
            cause instanceof Error &&
            cause.name === "RenderingCancelledException"
          )
        )
          callbacks.current.onError(errorText(cause));
      } finally {
        if (dead) page?.cleanup();
      }
    })();
    return () => {
      dead = true;
      render?.cancel();
      layer?.cancel();
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
      text.current?.replaceChildren();
      void Promise.resolve(render?.promise)
        .catch(() => undefined)
        .finally(() => page?.cleanup());
    };
  }, [opened, number, zoom, rotation, measurementGeneration]);
  function capture(event: React.MouseEvent<HTMLDivElement>) {
    if (!enabled || area || !geometry || !text.current || !root.current) return;
    const s = getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) {
      const page = root.current.getBoundingClientRect();
      const x = event.clientX - page.left,
        y = event.clientY - page.top;
      const picked = [...records].reverse().find((record) =>
        record.target.rects.some((rect) => {
          const bounds = fromPdfRect(rect, geometry.viewport, geometry.box);
          return (
            x >= bounds.x &&
            x <= bounds.x + bounds.width &&
            y >= bounds.y &&
            y <= bounds.y + bounds.height
          );
        }),
      );
      if (picked) onPick(picked);
      else onSelection(undefined);
      return;
    }
    const range = s.getRangeAt(0);
    if (
      !text.current.contains(range.startContainer) ||
      !text.current.contains(range.endContainer)
    ) {
      onSelection(undefined);
      return;
    }
    const exact = s.toString().trim();
    if (!exact || exact.length > 20000) return;
    const box = root.current.getBoundingClientRect();
    const rects: PdfRect[] = [];
    const seen = new Set<string>();
    for (const rect of range.getClientRects()) {
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
    onSelection({
      pageNumber: number,
      rects,
      exact,
      prefix: before.toString().slice(-64),
      suffix: after.toString().slice(0, 64),
    });
  }
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
      onMouseUp={capture}
      onClick={capture}
      style={{
        width: geometry?.viewport.width,
        height: geometry?.viewport.height,
      }}
    >
      <canvas ref={canvas} aria-label={`PDF ${number}`} />
      <div className="textLayer" ref={text} />
      {geometry && (
        <svg
          className="pdf-marks"
          width={geometry.viewport.width}
          height={geometry.viewport.height}
          aria-hidden="true"
        >
          {records.flatMap((r) =>
            r.target.rects.map((rect, i) => (
              <rect
                key={`${r.id}-${i}`}
                data-pdf-annotation={r.id}
                {...fromPdfRect(rect, geometry.viewport, geometry.box)}
                fill={r.kind === "pdf-text" ? r.color : "none"}
                fillOpacity=".32"
                stroke={r.kind === "pdf-area" ? r.color : "none"}
                strokeWidth="2"
              />
            )),
          )}
          {preview && (
            <rect
              {...fromPdfRect(preview, geometry.viewport, geometry.box)}
              fill="none"
              stroke={color}
              strokeWidth="2"
            />
          )}
        </svg>
      )}
      {enabled && area && geometry && (
        <div
          className="pdf-area-capture"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
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
            drag.current = undefined;
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
            if (preview)
              onArea({
                pageNumber: number,
                rects: [preview],
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
}
