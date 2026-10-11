import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FocusControls } from "../src/pdf/FocusControls";

let root: Root;
let host: HTMLDivElement;
let props: ComponentProps<typeof FocusControls>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  props = {
    language: "en",
    pageNumber: 2,
    totalPages: 5,
    blocked: false,
    onJump: vi.fn(),
    onNotes: vi.fn(),
    onExit: vi.fn(),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(overrides: Partial<ComponentProps<typeof FocusControls>> = {}) {
  props = { ...props, ...overrides };
  await act(async () => root.render(createElement(FocusControls, props)));
}

function button(label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

describe("focus controls", () => {
  it("disables previous and next navigation at their page boundaries", async () => {
    await render({ pageNumber: 1 });
    expect(button("Previous page").disabled).toBe(true);
    expect(button("Next page").disabled).toBe(false);

    await render({ pageNumber: 5 });
    expect(button("Previous page").disabled).toBe(false);
    expect(button("Next page").disabled).toBe(true);
  });

  it("sends the adjacent page and utility actions through its callbacks", async () => {
    await render();
    await act(async () => {
      button("Previous page").click();
      button("Next page").click();
      button("View annotations").click();
      button("Exit focus reading").click();
    });

    expect(props.onJump).toHaveBeenNthCalledWith(1, 1);
    expect(props.onJump).toHaveBeenNthCalledWith(2, 3);
    expect(props.onNotes).toHaveBeenCalledOnce();
    expect(props.onExit).toHaveBeenCalledOnce();
  });

  it("keeps exit available while blocked while disabling reader actions", async () => {
    await render({ blocked: true });

    expect(button("Previous page").disabled).toBe(true);
    expect(button("Next page").disabled).toBe(true);
    expect(button("View annotations").disabled).toBe(true);
    expect(button("Exit focus reading").disabled).toBe(false);
    await act(async () => button("Exit focus reading").click());
    expect(props.onExit).toHaveBeenCalledOnce();
  });

  it("uses native buttons for keyboard-accessible controls", async () => {
    await render({ sidebarHint: true });

    const controls = [...host.querySelectorAll(".pdf-focus-controls button")];
    expect(controls).toHaveLength(4);
    expect(controls.every((control) => control instanceof HTMLButtonElement)).toBe(true);
    const navigation = host.querySelector<HTMLElement>(".pdf-focus-controls")!;
    expect(navigation.tagName).toBe("NAV");
    expect(navigation.getAttribute("aria-label")).toBe("Focus reading controls");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Close Chrome's annotations sidebar manually.");

    await render({ language: "zh-CN", sidebarHint: true });
    expect(host.querySelector('[role="status"]')?.textContent).toBe("请手动关闭 Chrome 标注侧栏。");
  });
});
