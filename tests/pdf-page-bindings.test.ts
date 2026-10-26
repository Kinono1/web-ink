import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePdfPageBindings } from "../src/pdf/hooks/usePdfPageBindings";
import { PageLayoutIndex } from "../src/pdf/layout";
import type { SelectionTarget } from "../src/pdf/types";

type Inputs = Parameters<typeof usePdfPageBindings>[0];
type Commands = Parameters<typeof usePdfPageBindings>[1];
let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function fixture() {
  const scroller = document.createElement("div");
  scroller.scrollTo = vi.fn();
  const layout = new PageLayoutIndex();
  layout.reset(3, 800);
  const state: Inputs = {
    annotationWrites: { current: new Set() },
    container: { current: scroller },
    documentSession: 1,
    documentSessionRef: { current: 1 },
    intentEpoch: { current: 0 },
    layoutIndex: { current: layout },
    pendingSearchPosition: { current: undefined },
    setError: vi.fn(), setNativeError: vi.fn(), setPicked: vi.fn(),
    setSelection: vi.fn(), unsavedRef: { current: undefined },
  };
  const commands: Commands = { mark: vi.fn(), onPageDimensions: vi.fn(), pagesPadding: () => 8 };
  let bindings!: ReturnType<typeof usePdfPageBindings>;
  function Capture({ state, commands }: { state: Inputs; commands: Commands }) {
    bindings = usePdfPageBindings(state, commands);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = async (nextState = state, nextCommands = commands) => {
    await act(async () => root!.render(createElement(Capture, { state: nextState, commands: nextCommands })));
    return bindings;
  };
  return { state, commands, scroller, render };
}
const target: SelectionTarget = { pageNumber: 1, rects: [], exact: "", prefix: "", suffix: "" };

it("keeps page callbacks stable while dispatching the latest current-session commands", async () => {
  const { state, commands, render } = fixture();
  const before = (await render())(1);
  const latest = { ...commands, mark: vi.fn() };
  const after = (await render({ ...state }, latest))(1);
  expect(after.onArea).toBe(before.onArea);
  expect(after.onSelection).toBe(before.onSelection);
  expect(after.onDimensions).toBe(before.onDimensions);
  expect(after.onSearchPosition).toBe(before.onSearchPosition);
  before.onArea(target);
  expect(commands.mark).not.toHaveBeenCalled();
  expect(latest.mark).toHaveBeenCalledWith(target, "pdf-area");
});

it("rejects removed-page callbacks after replacement even when the PDF hash is unchanged", async () => {
  const { state, commands, render } = fixture();
  const old = (await render())(1);
  state.documentSessionRef.current = 2;
  const current = (await render({ ...state, documentSession: 2 }))(1);
  old.onArea(target);
  old.onSelection(undefined);
  old.onError("Old document error");
  old.onDimensions(9, 600, 800);
  expect(commands.mark).not.toHaveBeenCalled();
  expect(state.setSelection).not.toHaveBeenCalled();
  expect(state.setError).not.toHaveBeenCalled();
  expect(commands.onPageDimensions).not.toHaveBeenCalled();
  current.onArea(target);
  expect(commands.mark).toHaveBeenCalledOnce();
});

it("lets user intent supersede delayed search positioning and consumes a valid target once", async () => {
  const { state, render, scroller } = fixture();
  const page = (await render())(2);
  state.pendingSearchPosition.current = { pageNumber: 2, intent: 0 };
  state.intentEpoch.current = 1;
  page.onSearchPosition?.(100);
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  state.pendingSearchPosition.current = { pageNumber: 2, intent: 1 };
  page.onSearchPosition?.(100);
  expect(scroller.scrollTo).toHaveBeenCalledOnce();
  expect(state.pendingSearchPosition.current).toBeUndefined();
  page.onSearchPosition?.(100);
  expect(scroller.scrollTo).toHaveBeenCalledOnce();
});
