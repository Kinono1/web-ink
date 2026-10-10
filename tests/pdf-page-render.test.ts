import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PdfPage } from "../src/pdf/PdfPage";
import type { OpenDocument } from "../src/pdf/types";

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Plan = {
  raster?: ReturnType<typeof deferred>;
  text?: ReturnType<typeof deferred>;
  ignoreCancellation?: boolean;
};
type Attempt = {
  scale: number;
  canvas: HTMLCanvasElement;
  rasterCancelled: boolean;
  textCancelled: boolean;
  textContainer?: HTMLDivElement;
};

let root: Root | undefined;
let host: HTMLDivElement;
let props: ComponentProps<typeof PdfPage>;
let plans: Map<number, Plan>;
let attempts: Attempt[];
let pixels: WeakMap<HTMLCanvasElement, string>;
let cleanupPage: ReturnType<typeof vi.fn>;
let getPageGate: ReturnType<typeof deferred> | undefined;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  plans = new Map();
  attempts = [];
  pixels = new WeakMap();
  cleanupPage = vi.fn();
  getPageGate = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("devicePixelRatio", 1);
  // JSDOM does not implement raster contexts. Track completed image copies at
  // the canvas boundary while exercising the real PdfPage lifecycle and DOM.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const destination = this;
    return {
      drawImage(source: HTMLCanvasElement) {
        pixels.set(destination, pixels.get(source) ?? "");
      },
    } as unknown as CanvasRenderingContext2D;
  });

  const page = {
    rotate: 0,
    view: [0, 0, 600, 800],
    getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => ({
      width: (rotation % 180 ? 800 : 600) * scale,
      height: (rotation % 180 ? 600 : 800) * scale,
      rotation,
      scale,
      convertToPdfPoint: (x: number, y: number) => [x / scale, 800 - y / scale],
      convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale],
    }),
    render: ({ canvas, viewport }: { canvas: HTMLCanvasElement; viewport: { scale: number } }) => {
      const plan = plans.get(viewport.scale);
      const attempt: Attempt = { scale: viewport.scale, canvas, rasterCancelled: false, textCancelled: false };
      attempts.push(attempt);
      const promise = (plan?.raster?.promise ?? Promise.resolve()).then(() => {
        pixels.set(canvas, `raster ${viewport.scale}`);
      });
      return {
        promise,
        cancel() {
          attempt.rasterCancelled = true;
          if (!plan?.ignoreCancellation) {
            const error = new Error("Cancelled raster");
            error.name = "RenderingCancelledException";
            plan?.raster?.reject(error);
          }
        },
      };
    },
    streamTextContent: () => undefined,
    cleanup: cleanupPage,
  };
  class TextLayer {
    private attempt: Attempt;
    private plan: Plan | undefined;
    constructor(private options: { container: HTMLDivElement; viewport: { scale: number; rotation: number } }) {
      this.attempt = attempts.at(-1)!;
      this.plan = plans.get(options.viewport.scale);
      this.attempt.textContainer = options.container;
      options.container.style.width = `${600 * options.viewport.scale}px`;
      options.container.style.height = `${800 * options.viewport.scale}px`;
      options.container.style.setProperty("--min-font-size", "2");
      options.container.dataset.mainRotation = String(options.viewport.rotation);
    }
    render() {
      const span = document.createElement("span");
      span.textContent = `text ${this.options.viewport.scale}`;
      this.options.container.append(span);
      return this.plan?.text?.promise ?? Promise.resolve();
    }
    cancel() {
      this.attempt.textCancelled = true;
      if (!this.plan?.ignoreCancellation) this.plan?.text?.reject(new Error("Cancelled text"));
    }
  }
  const opened = {
    document: {
      async getPage() {
        await getPageGate?.promise;
        return page;
      },
    },
    api: { TextLayer },
    hash: "a".repeat(64),
    fileName: "fixture.pdf",
  } as unknown as OpenDocument;
  props = {
    opened,
    number: 1,
    zoom: 1,
    rotation: 0,
    measurementGeneration: 1,
    area: false,
    color: "#facc15",
    records: [{
      id: "saved-mark", kind: "pdf-text", pageUrl: `urn:web-ink:pdf:${opened.hash}`,
      pageTitle: "fixture.pdf", color: "#facc15", note: "", tags: [], revision: 1,
      createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
      target: { documentHash: opened.hash, fileName: "fixture.pdf", pageNumber: 1,
        rects: [{ x: 0.1, y: 0.7, width: 0.2, height: 0.05 }], exact: "saved passage", prefix: "", suffix: "" },
    }],
    onSelection: vi.fn(),
    onPick: vi.fn(),
    onArea: vi.fn(),
    onDimensions: vi.fn(),
    onError: vi.fn(),
  };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    root = undefined;
    getPageGate?.resolve();
    for (const plan of plans.values()) {
      plan.raster?.resolve();
      plan.text?.resolve();
    }
    await Promise.resolve();
  });
  window.getSelection()?.removeAllRanges();
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function paint(changes: Partial<ComponentProps<typeof PdfPage>> = {}) {
  props = { ...props, ...changes };
  await act(async () => root!.render(createElement(PdfPage, props)));
}
function pageRoot() { return host.querySelector<HTMLDivElement>(".pdf-page")!; }
function visibleCanvas() { return host.querySelector<HTMLCanvasElement>("canvas")!; }
function visibleText() { return host.querySelector<HTMLDivElement>(".textLayer")!; }

describe("PdfPage staged rendering", () => {
  it("keeps the committed page visible until the new raster and text both finish", async () => {
    await paint();
    const canvas = visibleCanvas();
    const oldText = visibleText().firstChild;
    const oldMark = host.querySelector(".pdf-marks rect")!.getAttribute("x");
    const widthWrites = vi.spyOn(HTMLCanvasElement.prototype, "width", "set");
    const heightWrites = vi.spyOn(HTMLCanvasElement.prototype, "height", "set");
    const raster = deferred(), text = deferred();
    plans.set(2, { raster, text });

    await paint({ zoom: 2, measurementGeneration: 2 });

    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(800);
    expect(pixels.get(canvas)).toBe("raster 1");
    expect(visibleText().firstChild).toBe(oldText);
    expect(pageRoot().style.width).toBe("600px");
    expect(pageRoot().style.height).toBe("800px");
    expect(pageRoot().style.getPropertyValue("--total-scale-factor")).toBe("1");
    expect(host.querySelector(".pdf-marks rect")!.getAttribute("x")).toBe(oldMark);
    expect(pageRoot().dataset.ready).toBe("false");
    expect(pageRoot().dataset.rendering).toBe("true");
    expect(widthWrites.mock.contexts.filter(context => context === canvas)).toHaveLength(0);
    expect(heightWrites.mock.contexts.filter(context => context === canvas)).toHaveLength(0);
    expect(visibleText().style.pointerEvents).toBe("none");
    expect(visibleText().style.userSelect).toBe("none");
    expect(host.querySelectorAll("canvas")).toHaveLength(1);
    expect(attempts[1]!.canvas.isConnected).toBe(false);
    expect(props.onDimensions).toHaveBeenCalledTimes(1);

    const range = document.createRange();
    range.selectNodeContents(oldText!);
    window.getSelection()!.addRange(range);
    await act(async () => pageRoot().dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    expect(props.onSelection).not.toHaveBeenCalled();
    expect(props.onPick).not.toHaveBeenCalled();
    await paint({ area: true });
    expect(host.querySelector(".pdf-area-capture")).toBeNull();

    await act(async () => raster.resolve());
    expect(visibleCanvas()).toBe(canvas);
    expect(pixels.get(canvas)).toBe("raster 1");
    expect(visibleText().firstChild).toBe(oldText);
    expect(attempts[1]!.textContainer?.isConnected).toBe(false);
    expect(props.onDimensions).toHaveBeenCalledTimes(1);
    expect(widthWrites.mock.contexts.filter(context => context === canvas)).toHaveLength(0);
    expect(heightWrites.mock.contexts.filter(context => context === canvas)).toHaveLength(0);

    await act(async () => text.resolve());
    expect(visibleCanvas()).toBe(canvas);
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(1600);
    expect(pixels.get(canvas)).toBe("raster 2");
    expect(visibleText().textContent).toBe("text 2");
    expect(visibleText().style.getPropertyValue("--min-font-size")).toBe("2");
    expect(visibleText().dataset.mainRotation).toBe("0");
    expect(pageRoot().style.width).toBe("1200px");
    expect(pageRoot().style.height).toBe("1600px");
    expect(pageRoot().style.getPropertyValue("--total-scale-factor")).toBe("2");
    expect(pageRoot().dataset.ready).toBe("true");
    expect(pageRoot().dataset.rendering).toBe("false");
    expect(visibleText().style.pointerEvents).toBe("");
    expect(visibleText().style.userSelect).toBe("");
    expect(host.querySelector(".pdf-area-capture")).toBeTruthy();
    expect(props.onDimensions).toHaveBeenLastCalledWith(2, 1200, 1600);
    expect(attempts[1]!.canvas.width).toBe(0);
    expect(attempts[1]!.textContainer?.childElementCount).toBe(0);
  });

  it("cancels obsolete zooms and bounds staging to one unfinished render per page", async () => {
    await paint();
    const obsolete = deferred(), latest = deferred();
    plans.set(2, { raster: obsolete, ignoreCancellation: true });
    plans.set(3, { raster: latest });
    await paint({ zoom: 2, measurementGeneration: 2 });
    await paint({ zoom: 3, measurementGeneration: 3 });

    expect(attempts[1]!.rasterCancelled).toBe(true);
    expect(attempts.map(attempt => attempt.scale)).toEqual([1, 2]);
    expect(visibleCanvas().width).toBe(600);
    expect(visibleText().textContent).toBe("text 1");
    expect(cleanupPage).not.toHaveBeenCalled();

    await act(async () => obsolete.resolve());
    expect(attempts.map(attempt => attempt.scale)).toEqual([1, 2, 3]);
    expect(attempts[1]!.canvas.width).toBe(0);
    expect(visibleCanvas().width).toBe(600);
    expect(visibleText().textContent).toBe("text 1");
    expect(pageRoot().dataset.ready).toBe("false");
    expect(cleanupPage).not.toHaveBeenCalled();

    await act(async () => latest.resolve());
    expect(visibleCanvas().width).toBe(1800);
    expect(pixels.get(visibleCanvas())).toBe("raster 3");
    expect(visibleText().textContent).toBe("text 3");
    expect(vi.mocked(props.onDimensions).mock.calls).toEqual([[1, 600, 800], [3, 1800, 2400]]);
  });

  it("never commits a cancelled text layer that resolves after a newer zoom", async () => {
    await paint();
    const obsoleteText = deferred();
    plans.set(2, { text: obsoleteText, ignoreCancellation: true });
    await paint({ zoom: 2, measurementGeneration: 2 });
    const obsoleteContainer = attempts[1]!.textContainer!;
    expect(obsoleteContainer.textContent).toBe("text 2");
    await paint({ zoom: 3, measurementGeneration: 3 });
    expect(attempts[1]!.textCancelled).toBe(true);
    expect(visibleText().textContent).toBe("text 1");

    await act(async () => obsoleteText.resolve());
    expect(obsoleteContainer.childElementCount).toBe(0);
    expect(pixels.get(visibleCanvas())).toBe("raster 3");
    expect(visibleText().textContent).toBe("text 3");
    expect(vi.mocked(props.onDimensions).mock.calls).toEqual([[1, 600, 800], [3, 1800, 2400]]);
    expect(cleanupPage).not.toHaveBeenCalled();
  });

  it.each(["raster", "text"] as const)("clears the visible page and exposes an error if the newest %s fails", async (phase) => {
    await paint();
    const failure = deferred();
    plans.set(2, { [phase]: failure });
    await paint({ zoom: 2, measurementGeneration: 2 });
    expect(visibleText().textContent).toBe("text 1");

    await act(async () => failure.reject(new Error("internal rendering failure")));

    expect(visibleCanvas().width).toBe(0);
    expect(visibleCanvas().height).toBe(0);
    expect(visibleText().childElementCount).toBe(0);
    expect(pageRoot().dataset.ready).toBe("false");
    expect(pageRoot().dataset.rendering).toBe("false");
    expect(host.querySelector(".pdf-marks")).toBeNull();
    expect(host.querySelector(".pdf-area-capture")).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("第 1 页");
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("internal rendering failure");
    expect(props.onDimensions).toHaveBeenCalledTimes(1);
    expect(attempts[1]!.canvas.width).toBe(0);
  });

  it.each(["raster", "text"] as const)("cancels and releases a pending %s stage on unmount without committing it", async (phase) => {
    await paint();
    const pending = deferred();
    plans.set(2, { [phase]: pending, ignoreCancellation: true });
    await paint({ zoom: 2, measurementGeneration: 2 });
    const canvas = visibleCanvas(), text = visibleText(), stage = attempts[1]!;
    await act(async () => { root!.unmount(); root = undefined; });
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(text.childElementCount).toBe(0);
    expect(phase === "raster" ? stage.rasterCancelled : stage.textCancelled).toBe(true);

    await act(async () => pending.resolve());
    expect(host.childElementCount).toBe(0);
    expect(stage.canvas.width).toBe(0);
    expect(stage.canvas.height).toBe(0);
    expect(stage.textContainer?.childElementCount ?? 0).toBe(0);
    expect(props.onDimensions).toHaveBeenCalledTimes(1);
    expect(cleanupPage).toHaveBeenCalledTimes(1);
  });

  it("does not allocate a stage when getPage resolves after unmount", async () => {
    getPageGate = deferred();
    await paint();
    await act(async () => { root!.unmount(); root = undefined; });
    await act(async () => getPageGate!.resolve());

    expect(attempts).toHaveLength(0);
    expect(props.onDimensions).not.toHaveBeenCalled();
    expect(cleanupPage).toHaveBeenCalledTimes(1);
  });
});
