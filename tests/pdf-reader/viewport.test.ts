import { HASH, TOKEN, bookmark, baseRecord, reader, deferred, settle, mount, button, click, openNotes, puts, io, noteRenderMetrics, pageRenderMetrics } from "../helpers/pdf-reader";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { type PdfReadingPosition } from "../../src/pdf/reading-position";

function takePageRenderMetric() {
  const renders = pageRenderMetrics.renders.splice(0);
  return {
    renderInvocations: renders.length,
    pages: [...new Set(renders.map((render) => `PdfPage:${render.page}`))].sort(),
  };
}

it("[perf] reports real PdfPage render invocations for unrelated reader UI and draft updates", async () => {
  // One visible page keeps the metric stable while retaining the production
  // PdfPage source, PDF.js mock, rendering, and native-annotation path.
  io.pageCount = 1;
  reader.records = [baseRecord()];
  await mount();
  const initial = takePageRenderMetric();
  expect(initial.renderInvocations).toBeGreaterThan(0);

  await openNotes();
  const notesOpened = takePageRenderMetric();

  await click("编辑");
  const noteInput = reader.host.querySelector<HTMLTextAreaElement>(".pdf-note-editor textarea")!;
  await act(async () => {
    noteInput.value = "Draft-only update";
    noteInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  const draftChanged = takePageRenderMetric();

  await click("原文件");
  const nativeFilterChanged = takePageRenderMetric();

  const zoomInput = reader.host.querySelector<HTMLInputElement>(".pdf-zoom")!;
  await act(async () => {
    zoomInput.value = "999%";
    zoomInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  takePageRenderMetric(); // Input editing is not the notice stage.
  await act(async () => zoomInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
  expect(reader.host.textContent).toContain("请输入 10%～500% 的缩放比例。");
  const noticeShown = takePageRenderMetric();

  const metric = { initial, notesOpened, draftChanged, nativeFilterChanged, noticeShown };
  process.stdout.write(`PDF_RENDER_BASELINE ${JSON.stringify(metric)}\n`);
});

it("[perf] edits one draft without invoking unrelated PdfNote render functions", async () => {
  io.pageCount = 1;
  reader.records = [baseRecord(), { ...baseRecord(), id: "second", note: "Second note" }, { ...baseRecord(), id: "third", note: "Third note" }];
  await mount();
  await openNotes();
  noteRenderMetrics.renders.length = 0;
  const article = reader.host.querySelector<HTMLElement>('[data-pdf-note="saved-highlight"]')!;
  const edit = [...article.querySelectorAll("button")].find(node => node.textContent === "编辑")!;
  await act(async () => edit.click());
  await settle();
  const editing = noteRenderMetrics.renders.splice(0);
  const textarea = article.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, "Only the first draft changed");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  const typing = noteRenderMetrics.renders.splice(0);
  process.stdout.write(`PDF_NOTE_RENDER_COUNTS ${JSON.stringify({ editing, typing })}\n`);
  expect(textarea.value).toBe("Only the first draft changed");
  expect(editing).toEqual(["saved-highlight"]);
  expect(typing).toEqual(["saved-highlight"]);
  expect(reader.host.querySelector('[data-pdf-note="second"]')?.textContent).toContain("Second note");
  expect(reader.host.querySelector('[data-pdf-note="third"]')?.textContent).toContain("Third note");
});

describe("PDF reader workspace", () => {
  it("opens PDF search with Cmd+F and closes it with Escape", async () => {
    await mount();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true })));
    await settle();
    const input = reader.host.querySelector<HTMLInputElement>('[aria-label="搜索 PDF 文字"]');
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    await act(async () => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(reader.host.querySelector('[aria-label="搜索 PDF 文字"]')).toBeNull();
  });

  it("searches document text and navigates matches without saving annotations", async () => {
    vi.useFakeTimers();
    io.pageCount = 3;
    await mount();
    await click("搜索 PDF");
    const input = reader.host.querySelector<HTMLInputElement>('[aria-label="搜索 PDF 文字"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "scientific");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
    });
    await settle();
    expect(reader.host.querySelector('.pdf-find-count')?.textContent).toBe("1 / 3");
    expect(reader.host.querySelectorAll(".pdf-search-match")).toHaveLength(1);
    await click("下一处");
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("2");
    await click("上一处");
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("1");
    expect(puts()).toHaveLength(0);
  });

  it("offers bounded previous and next page actions", async () => {
    io.pageCount = 3;
    await mount();
    expect(button("上一页").disabled).toBe(true);
    await click("下一页");
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("2");
    await click("下一页");
    expect(button("下一页").disabled).toBe(true);
    await click("上一页");
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("2");
  });

  it("keeps the requested last page when browser scroll clamping leaves a preceding page gap visible", async () => {
    io.pageCount = 3;
    await mount();
    await click("下一页");
    await click("下一页");
    const scroller = reader.host.querySelector<HTMLElement>(".pdf-pages")!;
    await act(async () => { scroller.scrollTop = 1632; scroller.dispatchEvent(new Event("scroll")); });
    await settle();
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("3");
    expect(button("下一页").disabled).toBe(true);
  });

  it("accepts an explicit percentage and rejects invalid zoom without changing the document", async () => {
    await mount();
    const input = reader.host.querySelector<HTMLInputElement>('[aria-label="缩放比例"]');
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "231%");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(input!.value).toBe("231%");
    expect(reader.host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')?.style.width).toBe("1386px");
    await act(async () => {
      setter.call(input, "900%");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(input!.value).toBe("231%");
    expect(puts()).toHaveLength(0);
  });

  it("fits the current page width and rotates from More", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 300 });
    await mount();
    await click("适合宽度");
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="缩放比例"]')?.value).toBe("50%");
    expect(reader.host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')?.style.width).toBe("300px");
    await click("更多");
    expect(reader.host.querySelector('.pdf-toolbar [aria-label="旋转页面"]')).toBeTruthy();
    await click("旋转页面");
    expect(reader.host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')?.style.width).toBe("300px");
  });

  it("keeps rotation out of the closed toolbar and toggles it from More", async () => {
    await mount();
    const toolbar = reader.host.querySelector(".pdf-toolbar")!;
    const trigger = button("更多");

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(toolbar.querySelector('[aria-label="旋转页面"]')).toBeNull();
    expect(reader.host.querySelector(".pdf-more-menu")).toBeNull();

    await click("更多");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(reader.host.querySelector('[role="group"][aria-label="阅读"] [aria-label="旋转页面"]')).toBeTruthy();

    await click("更多");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(reader.host.querySelector(".pdf-more-menu")).toBeNull();
  });

  it("shows the five area-color swatches only while area annotation is active", async () => {
    await mount();
    await click("更多");
    expect(reader.host.querySelector('[aria-label="标注颜色"]')).toBeNull();
    expect(reader.host.querySelectorAll('[aria-label^="标注颜色 #"]')).toHaveLength(0);

    await click("区域标注");
    await click("更多");
    const colors = [...reader.host.querySelectorAll<HTMLButtonElement>('[aria-label^="标注颜色 #"]')]
      .map((swatch) => swatch.getAttribute("aria-label"));
    expect(colors).toEqual([
      "标注颜色 #facd5a",
      "标注颜色 #7cc868",
      "标注颜色 #69b0f1",
      "标注颜色 #fb5c89",
      "标注颜色 #c885da",
    ]);

    await click("文字选择");
    await click("更多");
    expect(reader.host.querySelectorAll('[aria-label^="标注颜色 #"]')).toHaveLength(0);
  });

  it("retains the same page and relative reading position during zoom", async () => {
    io.pageCount = 3;
    await mount();
    const scroller = reader.host.querySelector<HTMLElement>(".pdf-pages")!;
    await act(async () => { scroller.scrollTop = 400; scroller.dispatchEvent(new Event("scroll")); });
    await settle();
    await click("放大");
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("1");
    expect(scroller.scrollTop).toBeCloseTo(500);
  });

  it("keeps the previous zoom frame while rendering and blocks a failed page", async () => {
    await mount();
    const page = reader.host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')!;
    expect(page.dataset.ready).toBe("true");
    expect(page.querySelector(".textLayer span")).toBeTruthy();

    const rerender = deferred<void>();
    io.renderGates[1] = rerender.promise;
    await click("放大");
    expect(page.dataset.ready).toBe("false");
    expect(page.querySelector(".textLayer span")).toBeTruthy();
    expect(page.dataset.rendering).toBe("true");
    expect(page.querySelector("canvas")!.width).toBeGreaterThan(0);

    const technicalError = "internal PDF.js raster worker failure";
    await act(async () => rerender.reject(new Error(technicalError)));
    await settle();

    const alert = page.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("第 1 页");
    expect(alert?.textContent).toMatch(/失败|无法|错误/);
    expect(alert?.textContent).not.toContain(technicalError);
    expect(page.dataset.ready).toBe("false");
    expect(page.querySelector("canvas")?.width).toBe(0);
    expect(page.querySelector("canvas")?.height).toBe(0);
    expect(page.querySelector(".textLayer")?.childElementCount).toBe(0);
  });

  it("waits for page rendering before showing the area capture layer", async () => {
    io.pageCount = 1;
    const render = deferred<void>();
    io.renderGates[1] = render.promise;

    await mount();
    const page = reader.host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')!;
    expect(page.dataset.ready).toBe("false");
    await click("更多");
    await click("区域标注");
    expect(page.querySelector(".pdf-area-capture")).toBeNull();

    await act(async () => render.resolve());
    await settle();
    expect(page.dataset.ready).toBe("true");
    expect(page.querySelector(".pdf-area-capture")).toBeTruthy();
  });

  it("saves an area from pointerup coordinates before a preview render or pointermove", async () => {
    io.pageCount = 1;
    await mount();
    await click("更多");
    await click("区域标注");
    const page = reader.host.querySelector<HTMLElement>('.pdf-page')!;
    page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 } as DOMRect);
    const capture = page.querySelector<HTMLElement>('.pdf-area-capture')!;
    capture.setPointerCapture = vi.fn();
    capture.hasPointerCapture = () => true;
    capture.releasePointerCapture = vi.fn();
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      capture.dispatchEvent(event);
    };
    await act(async () => {
      pointer('pointerdown', 60, 80);
      pointer('pointerup', 180, 240);
    });
    await settle();
    expect(reader.records).toHaveLength(1);
    expect(reader.records[0]).toMatchObject({ kind: 'pdf-area', target: {
      pageNumber: 1, rects: [{ x: expect.closeTo(0.1), y: expect.closeTo(0.7), width: expect.closeTo(0.2), height: expect.closeTo(0.2) }],
    } });
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});

describe("PDF reading position integration", () => {
  it("keeps the content anchor stable when container padding reaches the next estimated page", async () => {
    reader.readGate = deferred();
    await mount();
    const scroller = reader.host.querySelector<HTMLElement>(".pdf-pages")!;
    scroller.style.paddingTop = "24px";
    scroller.scrollTop = 827;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    await settle();
    // The toolbar shows the most visible page; the scroll anchor remains at
    // the preceding page's end while the storage read is still pending.
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("2");
    await click("放大");
    expect(scroller.scrollTop).toBe(827);
  });
  it("waits for initial read and a real target height, then restores without scanning all pages", async () => {
    reader.readGate = deferred();
    await mount();
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(reader.writes).toHaveLength(0);
    await act(async () => reader.readGate!.resolve({ [`ui.pdfReadingPosition.${HASH}`]: bookmark }));
    await settle();
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("500");
    expect(reader.host.querySelector<HTMLInputElement>(".pdf-zoom")?.value).toBe("150%");
    expect(new Set(io.pagesRead).size).toBeLessThan(20);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const latest = reader.writes.at(-1)?.[`ui.pdfReadingPosition.${HASH}`] as PdfReadingPosition;
    expect(latest).toMatchObject({ pageNumber: 500, zoom: 1.5, rotation: 90 });
    expect(latest.pageOffsetRatio).toBeCloseTo(0.5);
  });

  it.each(["wheel", "key", "zoom", "area"])("does not apply late saved values after %s intent", async (intent) => {
    reader.readGate = deferred();
    await mount();
    expect(reader.readKeys).toContain(`ui.pdfReadingPosition.${HASH}`);
    const scroller = reader.host.querySelector<HTMLElement>(".pdf-pages")!;
    if (intent === "wheel") await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 80 })));
    if (intent === "key") await act(async () => scroller.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageDown" })));
    if (intent === "zoom") await click("放大");
    if (intent === "area") { await click("更多"); await click("区域标注"); }
    await act(async () => reader.readGate!.resolve({ [`ui.pdfReadingPosition.${HASH}`]: bookmark }));
    await settle();
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("1");
    expect(reader.host.querySelector<HTMLInputElement>(".pdf-zoom")?.value).toBe(intent === "zoom" ? "125%" : "100%");
  });

  it("uses the matching historical target page at top, retaining same-hash zoom/rotation", async () => {
    reader.storedPosition = bookmark;
    await mount(`?document=${HASH}&page=4`);
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("4");
    expect(reader.host.querySelector<HTMLInputElement>(".pdf-zoom")?.value).toBe("150%");
    expect(new URL(location.href).searchParams.has("page")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(reader.writes.at(-1)?.[`ui.pdfReadingPosition.${HASH}`]).toMatchObject({ pageNumber: 4, pageOffsetRatio: 0 });
  });

  it("does not apply an old annotation page to changed document bytes", async () => {
    io.hash = "b".repeat(64);
    await mount(`?document=${HASH}&page=4`);
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')!.value).toBe("1");
    expect(reader.host.textContent).toContain("文档版本已变化");
  });

  it("keeps bookmark failure recoverable without blocking a clean return", async () => {
    await mount(`?handoff=${TOKEN}`);
    reader.prefFailure = true;
    await click("返回原阅读器");
    expect(reader.messages).toContainEqual({ type: "pdf.returnOriginal", token: TOKEN });
    expect(reader.host.querySelector('[role="dialog"]')).toBeNull();
  });
});
