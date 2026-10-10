import { useEffect, useRef, useState } from "react";
import type {
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import type { Language, PdfRect } from "../core/model";
import { fromPdfRect, toPdfRect } from "./geometry";
import {
  errorText,
  type OpenDocument,
  type PdfAnnotation,
  type PdfApi,
  type SelectionTarget,
  type SelectionPreview,
} from "./types";
export function PdfPage({
  language = "zh-CN",
  opened,
  number,
  zoom,
  rotation,
  records,
  area,
  color,
  measurementGeneration,
  onSelection,
  onPick,
  onArea,
  onDimensions,
  onError,
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
  onSelection: (v: SelectionPreview | undefined) => void;
  onPick: (record: PdfAnnotation) => void;
  onArea: (v: SelectionTarget) => void;
  onDimensions: (generation: number, w: number, h: number) => void;
  onError: (e: string) => void;
}) {
  const t = (zh: string, en: string) => language === "zh-CN" ? zh : en;
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<"image-too-large" | "render-failed">();
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
    setReady(false);
    setFailure(undefined);
    text.current?.replaceChildren();
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
        if (!dead && pageRoot.isConnected) {
          pageRoot.dataset.ready = "true";
          setReady(true);
        }
      } catch (cause) {
        if (
          !dead &&
          !(
            cause instanceof Error &&
            cause.name === "RenderingCancelledException"
          )
        ) {
          // A rejected render can leave a partial canvas. Never present it as
          // a complete page or allow annotations against stale text/geometry.
          if (canvas.current) {
            canvas.current.width = 0;
            canvas.current.height = 0;
          }
          text.current?.replaceChildren();
          setFailure(errorText(cause).includes("Image exceeded maximum allowed size")
            ? "image-too-large" : "render-failed");
        }
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
    if (area || !ready || !geometry || !text.current || !root.current) return;
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
      {failure && <div className="pdf-page-error" role="alert">
        <h2>{t(`第 ${number} 页无法完整显示`, `Page ${number} could not be displayed completely`)}</h2>
        <p>{failure === "image-too-large"
          ? t("图片过大，已停止显示以保护内存。", "An image is too large to display safely.")
          : t("这页暂时无法显示，请重新打开 PDF。", "This page could not be displayed. Reopen the PDF to try again.")}</p>
        <p>{t("标注仍保存在本机。请用原阅读器或其他 PDF 工具查看这一页。", "Your annotations remain saved locally. View this page in the original reader or another PDF tool.")}</p>
      </div>}
      {ready && geometry && (
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
      {area && ready && geometry && (
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
