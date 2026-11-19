import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFPageProxy, RenderTask, TextItem } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import { errorText, type OpenDocument, type PdfApi } from "../../core/pdf-types";
import { alignPdfTextFonts } from "../geometry";

interface RenderOptions {
  opened: OpenDocument;
  number: number;
  zoom: number;
  rotation: number;
  measurementGeneration: number;
  onDimensions(generation: number, width: number, height: number): void;
}

interface PageGeometry {
  viewport: PageViewport;
  box: number[];
  intrinsicRotation: number;
  opened: OpenDocument;
  number: number;
}

/** Serializes PDF.js render generations and replaces a visible frame only when its layers are ready. */
export function usePdfPageRender({ opened, number, zoom, rotation, measurementGeneration, onDimensions }: RenderOptions) {
  const [ready, setReady] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [failure, setFailure] = useState<"image-too-large" | "render-failed">();
  const [geometry, setGeometry] = useState<PageGeometry>();
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const committedLayer = useRef<InstanceType<PdfApi["TextLayer"]> | undefined>(undefined);
  const pending = useRef(Promise.resolve());
  const cachedPage = useRef<PDFPageProxy | undefined>(undefined);
  const dimensions = useRef(onDimensions);
  dimensions.current = onDimensions;

  useEffect(() => {
    const pageRoot = root.current, c = canvas.current, layerRoot = text.current;
    return () => {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      layerRoot?.replaceChildren();
      committedLayer.current = undefined;
      // Zoom generations share PDF.js's cached page. Release it only after
      // this mounted page is gone and its last stage has settled.
      void pending.current.then(() => {
        if (!pageRoot?.isConnected) cachedPage.current?.cleanup();
      });
    };
  }, []);
  useLayoutEffect(() => {
    const previous = pending.current;
    let dead = false;
    let render: RenderTask | undefined,
      layer: InstanceType<PdfApi["TextLayer"]> | undefined,
      stagedCanvas: HTMLCanvasElement | undefined,
      stagedText: HTMLDivElement | undefined;
    setReady(false);
    setRendering(true);
    setFailure(undefined);
    if (root.current) {
      root.current.dataset.ready = "false";
      root.current.dataset.rendering = "true";
    }
    pending.current = (async () => {
      try {
        // A cancelled stage must settle before another one allocates a raster.
        // Superseded generations waiting here never allocate their own stage.
        await previous;
        if (dead) return;
        const page = await opened.document.getPage(number);
        cachedPage.current = page;
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
        stagedCanvas = document.createElement("canvas");
        stagedCanvas.width = Math.floor(viewport.width * ratio);
        stagedCanvas.height = Math.floor(viewport.height * ratio);
        stagedText = document.createElement("div");
        stagedText.className = "textLayer";
        render = page.render({
          canvas: stagedCanvas,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        await render.promise;
        render = undefined;
        if (dead) return;
        const textItems: TextItem[] = [];
        const textSource = page.streamTextContent().pipeThrough(new TransformStream({
          transform(chunk, controller) {
            for (const item of chunk.items) if ("str" in item) textItems.push(item);
            controller.enqueue(chunk);
          },
        }));
        layer = new opened.api.TextLayer({
          textContentSource: textSource,
          container: stagedText,
          viewport,
        });
        await layer.render();
        const finishedLayer = layer;
        layer = undefined;
        if (dead || !pageRoot.isConnected) return;
        alignPdfTextFonts(page, finishedLayer, textItems, viewport.scale);

        // Keep React's canvas node, then commit the finished image, text and
        // viewport in one task so the browser never paints an empty zoom frame.
        publishFrame(pageRoot, c, layerRoot, stagedCanvas, stagedText, viewport);
        committedLayer.current = finishedLayer;
        setGeometry({ viewport, box: page.view, intrinsicRotation: page.rotate, opened, number });
        pageRoot.dataset.ready = "true";
        pageRoot.dataset.rendering = "false";
        setReady(true);
        setRendering(false);
        dimensions.current(measurementGeneration, viewport.width, viewport.height);
      } catch (cause) {
        if (!dead) {
          setReady(false);
          setRendering(false);
          if (root.current) {
            root.current.dataset.ready = "false";
            root.current.dataset.rendering = "false";
          }
        }
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
          committedLayer.current = undefined;
          setFailure(errorText(cause).includes("Image exceeded maximum allowed size")
            ? "image-too-large" : "render-failed");
        }
      } finally {
        render?.cancel();
        layer?.cancel();
        if (stagedCanvas) {
          stagedCanvas.width = 0;
          stagedCanvas.height = 0;
        }
        stagedText?.replaceChildren();
      }
    })();
    return () => {
      dead = true;
      render?.cancel();
      render = undefined;
      layer?.cancel();
      layer = undefined;
    };
  }, [opened, number, zoom, rotation, measurementGeneration]);

  return { root, canvas, text, committedLayer, ready, rendering, failure, geometry };
}

function publishFrame(
  pageRoot: HTMLDivElement,
  canvas: HTMLCanvasElement,
  layerRoot: HTMLDivElement,
  stagedCanvas: HTMLCanvasElement,
  stagedText: HTMLDivElement,
  viewport: PageViewport,
): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PDF canvas context is unavailable");
  canvas.width = stagedCanvas.width;
  canvas.height = stagedCanvas.height;
  context.drawImage(stagedCanvas, 0, 0);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  layerRoot.style.cssText = stagedText.style.cssText;
  layerRoot.setAttribute("data-main-rotation", String(viewport.rotation));
  const finishedText = document.createDocumentFragment();
  while (stagedText.firstChild) finishedText.append(stagedText.firstChild);
  layerRoot.replaceChildren(finishedText);
  pageRoot.style.width = `${viewport.width}px`;
  pageRoot.style.height = `${viewport.height}px`;
  pageRoot.style.setProperty("--total-scale-factor", String(viewport.scale));
  pageRoot.style.setProperty("--scale-factor", String(viewport.scale));
}
