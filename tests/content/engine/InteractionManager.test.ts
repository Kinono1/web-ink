import { afterEach, expect, it, vi } from "vitest";
import { UIController, type UIControllerHost } from "../../../src/content/engine/UIController";
import { TextAnchorSession } from "../../../src/core/text-anchor";
import { DEFAULT_SETTINGS } from "../../../src/core/model";
import { createView } from "../../../src/content/view-lite";

afterEach(() => {
  getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
it("accepts a live preset selection and leaves editable selections to the page", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const paragraph = document.createElement("p");
  paragraph.textContent = "A live selected passage";
  document.body.append(paragraph);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  getSelection()!.addRange(range);
  const saves: Array<{ color: string; tags: string[]; text: string }> = [];
  const session = new TextAnchorSession(document);
  const engine = {
    settings: DEFAULT_SETTINGS, view: createView(), enabled: () => true, disposed: false,
    data: {
      pendingSave: false, textSession: session,
      saveSelection: (color: string, tags: string[], selected: Range) => {
        saves.push({ color, tags, text: selected.toString() });
      },
    },
  } as unknown as UIControllerHost;
  const interactions = new UIController(engine);
  interactions.annotationPresets = [{ id: "evidence", label: "Evidence", color: "#00ff00" }];
  const shortcut = () => new KeyboardEvent("keydown", {
    code: "Digit1", altKey: true, shiftKey: true, cancelable: true,
  });
  const event = shortcut();
  expect(interactions.applyPresetShortcut(event)).toBe(true);
  expect(event.defaultPrevented).toBe(true);
  expect(saves).toEqual([{ color: "#00ff00", tags: ["Evidence"], text: "A live selected passage" }]);
  paragraph.setAttribute("contenteditable", "true");
  expect(interactions.applyPresetShortcut(shortcut())).toBe(false);
  expect(saves).toHaveLength(1);
  session.dispose();
});

it("preserves expanded color controls when scrolling repositions a selected range", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const paragraph = document.createElement("p");
  paragraph.textContent = "Text with an open color palette";
  document.body.append(paragraph);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = range.cloneRange();
  let bottom = 100;
  const rect = () => new DOMRect(20, bottom - 18, 80, 18);
  Object.defineProperties(range, {
    cloneRange: { value: () => selection },
    getBoundingClientRect: { value: rect },
  });
  Object.defineProperty(selection, "getBoundingClientRect", { value: rect });

  const view = createView();
  const saveSelection = vi.fn(async () => {});
  const interactions = new UIController({
    view, settings: DEFAULT_SETTINGS, disposed: false,
    label: (_chinese: string, english: string) => english,
    data: { annotations: [], textRanges: new Map(), recentColors: [], schedulePaint: vi.fn(), saveSelection },
  } as unknown as UIControllerHost);
  interactions.showPalette(range);
  view.selection.querySelector<HTMLButtonElement>('button[aria-label="More colors"]')!.click();
  const custom = view.selection.querySelector<HTMLInputElement>('input[type="color"]')!;
  expect(custom).toBeTruthy();
  expect(view.selection.style.top).toBe("108px");

  bottom = 140;
  interactions.onScroll();
  expect(view.selection.style.top).toBe("148px");
  expect(view.selection.querySelector('input[type="color"]')).toBe(custom);
  custom.value = "#123456";
  view.selection.querySelector<HTMLButtonElement>('button[aria-label="Apply"]')!.click();
  expect(saveSelection).toHaveBeenCalledExactlyOnceWith("#123456");
});
