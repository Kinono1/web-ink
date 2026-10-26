import { afterEach, expect, it, vi } from "vitest";
import { RenderScheduler } from "../../../src/content/engine/RenderScheduler";
import type { AnnotationController } from "../../../src/content/engine/AnnotationController";
import { createView } from "../../../src/content/view-lite";
import type { TextAnnotation } from "../../../src/core/model";

const record = (id: string, color: string): TextAnnotation => ({
  id, color, kind: "text", pageUrl: location.href, pageTitle: "Test", note: "", tags: [],
  createdAt: "2026-10-26", updatedAt: "2026-10-26", revision: 1,
  target: { rootSelector: "body", exact: id, prefix: "", suffix: "", start: 0, end: id.length },
});
const sessions: RenderScheduler[] = [];
afterEach(() => {
  for (const render of sessions.splice(0)) render.textSession.dispose();
  document.body.replaceChildren();
  document.querySelectorAll("style[data-web-ink]").forEach(node => node.remove());
  vi.unstubAllGlobals();
});

it("replaces obsolete highlight groups and releases its owned ranges on clear", () => {
  const highlights = new Map();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", class { constructor(..._ranges: Range[]) {} });
  const view = createView();
  const store = { annotations: [record("one", "#ffff00"), record("two", "#00ff00")] };
  const render = new RenderScheduler({ view, store } as AnnotationController);
  sessions.push(render);
  const range = document.createRange();
  render.textRanges.set("one", range);
  render.textRanges.set("two", range);
  render.applyTextStyles();
  expect([...highlights.keys()]).toEqual(["web-ink-ffff00", "web-ink-00ff00"]);
  store.annotations = [record("two", "#00ff00")];
  render.applyTextStyles();
  expect([...highlights.keys()]).toEqual(["web-ink-00ff00"]);
  render.clearText();
  expect(highlights.size).toBe(0);
  expect(render.textRanges.size).toBe(0);
  expect(render.highlightStyle.textContent).toBe("");
});

it("coalesces paint requests and refuses work after disposal", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const engine = { view: createView(), disposed: false, enabled: () => false } as AnnotationController;
  const render = new RenderScheduler(engine);
  sessions.push(render);
  render.schedulePaint();
  render.schedulePaint();
  expect(frames).toHaveLength(1);
  frames[0]!(0);
  render.schedulePaint();
  expect(frames).toHaveLength(2);
  engine.disposed = true;
  frames[1]!(0);
  render.schedulePaint();
  expect(frames).toHaveLength(2);
});

it("disposes pending paint, DOM markers, and transient image output", () => {
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(1, callback);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const view = createView();
  const render = new RenderScheduler({ view, disposed: false } as AnnotationController);
  render.schedulePaint();
  view.svg.append(document.createElementNS("http://www.w3.org/2000/svg", "g"));
  render.dispose();
  expect(frames.size).toBe(0);
  expect(render.highlightStyle.isConnected).toBe(false);
  expect(view.svg.children).toHaveLength(0);
  expect(view.svg.style.pointerEvents).toBe("none");
});
