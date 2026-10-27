import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnnotationController } from "../../../src/content/engine/AnnotationController";
import { createView } from "../../../src/content/view-lite";
import { DEFAULT_SETTINGS, type Annotation } from "../../../src/core/model";
import { SELECTION_TOOLBAR_KEY } from "../../../src/core/selection-toolbar";

type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

let controller: AnnotationController;
let automatic: boolean;
let pageOverride: boolean | undefined;
let storageListener: StorageListener;
let saveHandler: (record: Annotation) => Promise<unknown>;
let saved: Annotation[];

beforeEach(() => {
  window.history.replaceState(null, "", "/manual-palette");
  automatic = false;
  pageOverride = true;
  saved = [];
  saveHandler = async record => {
    saved.push(record);
    return { ok: true, data: { ...record, revision: 1 } };
  };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: async (message: { type: string; annotation: Annotation }) => {
        if (message.type === "settings.get") return { ok: true, data: DEFAULT_SETTINGS };
        if (message.type === "page.mode.get") {
          const enabled = pageOverride ?? automatic;
          return { ok: true, data: { enabled, selectionToolsEnabled: enabled && (automatic || pageOverride === true) } };
        }
        if (message.type === "annotations.list") return { ok: true, data: saved };
        if (message.type === "annotations.put") return saveHandler(message.annotation);
        return { ok: true, data: true };
      },
    },
    storage: {
      local: { get: async () => ({ [SELECTION_TOOLBAR_KEY]: automatic }) },
      onChanged: { addListener(listener: StorageListener) { storageListener = listener; }, removeListener() {} },
    },
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true, value: () => new DOMRect(20, 20, 100, 20),
  });
});

afterEach(() => {
  controller?.stop();
  controller?.view.host.remove();
  getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  if (rangeRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRect);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.unstubAllGlobals();
});

async function start() {
  controller = new AnnotationController(createView());
  await vi.waitFor(() => expect(controller.modeReady).toBe(true));
  await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
  return controller.view;
}

function selectText() {
  const paragraph = document.createElement("p");
  paragraph.textContent = "A passage to highlight";
  document.body.append(paragraph);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
}

function changeAutomatic(value: boolean) {
  const oldValue = automatic;
  automatic = value;
  storageListener({ [SELECTION_TOOLBAR_KEY]: { oldValue, newValue: value } }, "local");
}

it("shows colors for a manually enabled page when automatic selection is off", async () => {
  const view = await start();
  selectText();
  expect(view.selection.style.display).toBe("flex");
  expect(view.selection.querySelector(".swatch")).not.toBeNull();
});

it.each([true, undefined])("respects page override %s when the global setting is turned off", async override => {
  automatic = true;
  pageOverride = override;
  const view = await start();
  selectText();
  expect(view.selection.style.display).toBe("flex");
  changeAutomatic(false);
  await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
  selectText();
  expect(controller.enabled()).toBe(override === true);
  expect(view.selection.style.display).toBe(override === true ? "flex" : "none");
});

it("ignores a stale page-mode read after the global setting changes", async () => {
  automatic = true;
  const view = await start();
  let finish!: (value: unknown) => void;
  const send = chrome.runtime.sendMessage;
  let defer = true;
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === "page.mode.get" && defer) {
      defer = false;
      return new Promise<unknown>(resolve => { finish = resolve; });
    }
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  const staleRefresh = controller.sync.refresh();
  changeAutomatic(false);
  await controller.sync.refresh();
  finish({ ok: true, data: { enabled: false } });
  await staleRefresh;
  selectText();
  expect(controller.enabled()).toBe(true);
  expect(view.selection.style.display).toBe("flex");
});

it("blocks closing during a save and retains a failed draft for retry", async () => {
  const view = await start();
  let finish!: (value: unknown) => void;
  saveHandler = () => new Promise(resolve => { finish = resolve; });
  selectText();
  view.selection.querySelector<HTMLButtonElement>(".swatch")!.click();
  expect(controller.save.pendingSave).toBe(true);
  expect(controller.canStop()).toBe(false);
  finish({ ok: false, error: "write failed", code: "FAILED" });
  await vi.waitFor(() => expect(controller.save.pendingSave).toBe(false));
  const draft = controller.save.unsaved;
  expect(draft?.kind).toBe("text");
  expect(controller.canStop()).toBe(false);
  expect(controller.save.unsaved).toEqual(draft);
  saveHandler = async record => {
    saved.push(record);
    return { ok: true, data: { ...record, revision: 1 } };
  };
  const retry = [...view.toast.querySelectorAll("button")].find(button => button.textContent === "重试保存");
  expect(retry).toBeDefined();
  retry!.click();
  await vi.waitFor(() => expect(controller.save.unsaved).toBeUndefined());
  expect(saved).toHaveLength(1);
  expect(saved[0]).toEqual(draft);
});
