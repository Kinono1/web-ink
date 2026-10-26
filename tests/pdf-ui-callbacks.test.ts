import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS } from "../src/core/model";
import { useReaderUI, useReaderUIState } from "../src/pdf/hooks/useReaderUI";
import { useViewport, useViewportState } from "../src/pdf/hooks/useViewport";
import type { OpenDocument } from "../src/pdf/types";

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener() {}, removeListener() {} }, sendMessage: async () => ({ ok: true, data: DEFAULT_SETTINGS }) },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } },
    sidePanel: { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function fixture() {
  const opened = { hash: "a".repeat(64), fileName: "first.pdf", document: { numPages: 5 } } as OpenDocument;
  const fixed = {
    deletedDrafts: [], dirtyNotes: false, draftsRef: { current: {} }, inlineNotes: false,
    locked: false, pendingLeave: undefined, readerTab: { current: undefined as number | undefined },
    readerWindow: { current: 10 }, setFallbackNotes: vi.fn(), sidebarAttachedRef: { current: false },
    supportsSidebar: true, setError: vi.fn(), setPicked: vi.fn(), documentSessionRef: { current: 1 },
  };
  const actions = { current: { mark: vi.fn(), tell: vi.fn() } };
  let ui!: ReturnType<typeof useReaderUIState>;
  let viewport!: ReturnType<typeof useViewportState>;
  let uiActions!: ReturnType<typeof useReaderUI>;
  let viewportActions!: ReturnType<typeof useViewport>;
  function Capture({ document = opened, session = 1, locked = false }: { document?: OpenDocument; session?: number; locked?: boolean }) {
    ui = useReaderUIState();
    viewport = useViewportState();
    const state = { ...fixed, ...ui, ...viewport, opened: document, documentSession: session, locked };
    uiActions = useReaderUI(state, actions);
    viewportActions = useViewport(state, actions);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = async (document = opened, session = 1, locked = false) => {
    await act(async () => root!.render(createElement(Capture, { document, session, locked })));
  };
  return { render, fixed, opened, actions,
    get ui() { return ui; }, get viewport() { return viewport; },
    get uiActions() { return uiActions; }, get viewportActions() { return viewportActions; },
  };
}

it("keeps UI commands and note navigation stable across unrelated menu updates", async () => {
  const view = fixture();
  await view.render();
  const before = view.uiActions;
  const viewportBefore = view.viewportActions;
  await act(async () => view.ui.setMoreOpen(true));
  for (const name of Object.keys(before) as Array<keyof typeof before>) expect(view.uiActions[name], name).toBe(before[name]);
  for (const name of ["jump", "userIntent", "pagesPadding"] as const) expect(view.viewportActions[name], name).toBe(viewportBefore[name]);
});

it("uses current language and focus locks, and rejects a cancelled focus intent", async () => {
  const view = fixture();
  await view.render();
  await act(async () => view.ui.setSettings(settings => ({ ...settings, language: "en" })));
  await act(async () => view.uiActions.openNotes());
  expect(view.fixed.setError).toHaveBeenCalledWith("Click Web Ink in the browser toolbar to open annotations.");
  await view.render(view.opened, 1, true);
  await act(async () => view.uiActions.enterFocus());
  expect(chrome.sidePanel.close).not.toHaveBeenCalled();
  await view.render();
  let resolve!: () => void;
  vi.mocked(chrome.sidePanel.close).mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  let entering!: Promise<void>;
  await act(async () => { entering = view.uiActions.enterFocus(); });
  expect(view.ui.focusBusy).toBe(true);
  await act(async () => view.uiActions.exitFocus());
  await act(async () => { resolve(); await entering; });
  expect(view.ui.focusMode).toBe(false);
  expect(view.ui.focusBusy).toBe(false);
});

it("clamps note navigation to the latest document and rejects an older same-hash session", async () => {
  const view = fixture();
  await view.render();
  const staleJump = view.viewportActions.jump;
  view.fixed.documentSessionRef.current = 2;
  await view.render({ ...view.opened, fileName: "replacement.pdf", document: { numPages: 2 } } as OpenDocument, 2);
  const before = view.viewport.intentEpoch.current;
  await act(async () => staleJump(5));
  expect(view.viewport.intentEpoch.current).toBe(before);
  expect(view.viewport.pageNumber).toBe(1);
  await act(async () => view.viewportActions.jump(5));
  expect(view.viewport.pageNumber).toBe(2);
  expect(view.viewport.pageWindow).toEqual({ start: 0, end: 2 });
  expect(view.viewport.intentEpoch.current).toBe(before + 1);
});

it("rejects old preset and focus commands after a same-hash document session is replaced", async () => {
  const view = fixture();
  await view.render();
  const scroller = document.createElement("div");
  scroller.innerHTML = '<div data-page="1"><div class="textLayer">Passage</div></div>';
  document.body.append(scroller);
  const text = scroller.querySelector(".textLayer")!.firstChild!;
  const range = document.createRange();
  range.selectNodeContents(text);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  view.viewport.container.current = scroller;
  await act(async () => view.viewport.setSelection({
    target: { pageNumber: 1, exact: "Passage", prefix: "", suffix: "", rects: [] },
    anchor: { left: 0, top: 0, right: 20, bottom: 20 },
  }));
  const stale = view.uiActions;
  view.fixed.documentSessionRef.current = 2;
  await view.render({ ...view.opened, fileName: "replacement.pdf" }, 2);
  await act(async () => {
    expect(stale.choosePreset({ id: "green", label: "Green", color: "#22c55e" })).toBe(false);
    await stale.enterFocus();
  });
  expect(view.actions.current.mark).not.toHaveBeenCalled();
  expect(chrome.sidePanel.close).not.toHaveBeenCalled();
  expect(view.ui.focusMode).toBe(false);
  getSelection()!.removeAllRanges();
});
