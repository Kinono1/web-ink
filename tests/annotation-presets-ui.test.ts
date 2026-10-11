import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AnnotationPresetActions, AnnotationPresetEditor } from "../src/ui/AnnotationPresets";
import type { AnnotationPreset } from "../src/core/annotation-presets";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const presets: AnnotationPreset[] = [
  { id: "important", label: "Important", color: "#facd5a" },
  { id: "question", label: "Question", color: "#69b0f1" },
  { id: "insight", label: "Insight", color: "#7cc868" },
];
let root: Root | undefined;

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function mountEditor(patch: Partial<ComponentProps<typeof AnnotationPresetEditor>> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(AnnotationPresetEditor, {
    presets,
    language: "en",
    onSave: async () => undefined,
    onClose: () => undefined,
    ...patch,
  })));
  return host;
}

function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === text);
  expect(found, `button ${text}`).toBeTruthy();
  return found!;
}

function labelInput(host: HTMLElement, index = 1) {
  return host.querySelector<HTMLInputElement>(`input[aria-label="Label ${index}"]`)!;
}

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe("annotation preset actions", () => {
  it("preserves a live selection on pointer down and chooses the labeled color", async () => {
    const host = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Keep this selection";
    document.body.append(paragraph, host);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const onChoose = vi.fn();
    root = createRoot(host);
    await act(async () => root!.render(createElement(AnnotationPresetActions, { presets, language: "en", disabled: false, onChoose })));

    const choices = host.querySelectorAll<HTMLButtonElement>(".annotation-presets button");
    expect([...choices].map((choice) => choice.textContent)).toEqual(["Important", "Question", "Insight"]);
    expect(choices[1]!.title).toContain("Alt+Shift+2");
    expect(choices[1]!.getAttribute("aria-keyshortcuts")).toBe("Alt+Shift+2");
    expect(choices[1]!.querySelector<HTMLElement>(".annotation-preset-swatch")?.style.backgroundColor).toBe("rgb(105, 176, 241)");
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    await act(async () => { choices[1]!.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    expect(selection.toString()).toBe("Keep this selection");
    await act(async () => choices[1]!.click());
    expect(onChoose).toHaveBeenCalledWith({ id: "question", label: "Question", color: "#69b0f1" });
  });

  it("keeps disabled actions inert", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onChoose = vi.fn();
    await act(async () => root!.render(createElement(AnnotationPresetActions, { presets, language: "zh-CN", disabled: true, onChoose })));
    const choices = host.querySelectorAll<HTMLButtonElement>("button");
    expect([...choices].every((choice) => choice.disabled)).toBe(true);
    await act(async () => choices[0]!.click());
    expect(onChoose).not.toHaveBeenCalled();
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("快捷标注");
  });
});

describe("annotation preset editor", () => {
  it("retains edited fields and reports storage failure before an explicit successful retry", async () => {
    const completion = deferred();
    let attempts = 0;
    let durable: AnnotationPreset[] | undefined;
    const onClose = vi.fn();
    const host = await mountEditor({ onClose, onSave: async (value) => {
      attempts += 1;
      if (attempts === 1) throw new Error("Storage quota exceeded");
      await completion.promise;
      durable = value;
    } });
    await inputValue(labelInput(host), "  Evidence  ");
    await inputValue(host.querySelector<HTMLInputElement>('input[aria-label="Color 1"]')!, "#c885da");
    await act(async () => button(host, "Save").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Storage quota exceeded");
    expect(labelInput(host).value).toBe("  Evidence  ");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Color 1"]')!.value).toBe("#c885da");
    expect(onClose).not.toHaveBeenCalled();
    expect(durable).toBeUndefined();

    await act(async () => button(host, "Save").click());
    expect(onClose).not.toHaveBeenCalled();
    expect(durable).toBeUndefined();
    await act(async () => completion.resolve());
    expect(durable?.[0]).toEqual({ id: "important", label: "Evidence", color: "#c885da" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
  });

  it("locks fields and cancel while pending, then closes only after the write resolves", async () => {
    const completion = deferred();
    const onSave = vi.fn(() => completion.promise);
    const onClose = vi.fn();
    const dirty: boolean[] = [];
    const saving: boolean[] = [];
    const host = await mountEditor({ onSave, onClose, onDirtyChange: (value) => dirty.push(value), onSavingChange: (value) => saving.push(value) });
    expect(dirty).toEqual([false]);
    expect(saving).toEqual([false]);
    await inputValue(labelInput(host), "Edited");
    expect(dirty).toEqual([false, true]);
    const save = button(host, "Save");
    await act(async () => { save.click(); save.click(); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saving).toEqual([false, true]);
    expect(labelInput(host).disabled).toBe(true);
    expect(button(host, "Cancel").disabled).toBe(true);
    expect(button(host, "Add preset").disabled).toBe(true);
    await act(async () => {
      button(host, "Cancel").click();
      labelInput(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => completion.resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saving).toEqual([false, true, false]);
    expect(button(host, "Cancel").disabled).toBe(false);
  });

  it("validates labels before saving and counts Unicode code points", async () => {
    const onSave = vi.fn(async (_value: AnnotationPreset[]) => undefined);
    const host = await mountEditor({ onSave });
    await inputValue(labelInput(host), " ");
    expect(button(host, "Save").disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("24");
    await act(async () => button(host, "Save").click());
    expect(onSave).not.toHaveBeenCalled();
    await inputValue(labelInput(host), "📖".repeat(25));
    expect(button(host, "Save").disabled).toBe(true);
    await inputValue(labelInput(host), "📖".repeat(24));
    expect(button(host, "Save").disabled).toBe(false);
    await act(async () => button(host, "Save").click());
    expect(onSave.mock.calls[0]?.[0]?.[0]?.label).toBe("📖".repeat(24));
  });

  it("bounds add and remove to one through five presets and saves stable unique IDs", async () => {
    let saved: AnnotationPreset[] | undefined;
    const host = await mountEditor({ onSave: async (value) => { saved = value; } });
    await act(async () => button(host, "Add preset").click());
    await act(async () => button(host, "Add preset").click());
    expect(host.querySelectorAll('input[type="text"]')).toHaveLength(5);
    expect(button(host, "Add preset").disabled).toBe(true);
    await act(async () => button(host, "Add preset").click());
    expect(host.querySelectorAll('input[type="text"]')).toHaveLength(5);
    await act(async () => button(host, "Save").click());
    expect(saved).toHaveLength(5);
    expect(new Set(saved!.map((value) => value.id)).size).toBe(5);
    expect(saved!.slice(0, 3)).toEqual(presets);
    for (let index = 0; index < 4; index += 1) await act(async () => button(host, "Remove").click());
    expect(host.querySelectorAll('input[type="text"]')).toHaveLength(1);
    expect(button(host, "Remove").disabled).toBe(true);
    await act(async () => button(host, "Remove").click());
    expect(host.querySelectorAll('input[type="text"]')).toHaveLength(1);
  });

  it("preserves unsaved local drafts when a late stored snapshot changes props", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async (_value: AnnotationPreset[]) => undefined);
    const host = await mountEditor({ onClose, onSave });
    await inputValue(labelInput(host), "Local draft");
    await act(async () => root!.render(createElement(AnnotationPresetEditor, {
      presets: [{ id: "late", label: "Late stored value", color: "#fb5c89" }], language: "en", onClose, onSave,
    })));
    expect(labelInput(host).value).toBe("Local draft");
    expect(host.querySelectorAll('input[type="text"]')).toHaveLength(3);
    await act(async () => button(host, "Save").click());
    expect(onSave.mock.calls[0]?.[0]?.[0]?.label).toBe("Local draft");
  });

  it("focuses accessible fields, traps Tab, and cancels on Escape without saving", async () => {
    const onSave = vi.fn(async (_value: AnnotationPreset[]) => undefined);
    const onClose = vi.fn();
    const host = await mountEditor({ onSave, onClose });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Annotation presets");
    expect(document.activeElement).toBe(labelInput(host));
    const backwards = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => { labelInput(host).dispatchEvent(backwards); });
    expect(backwards.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button(host, "Cancel"));
    await act(async () => { button(host, "Cancel").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(labelInput(host));
    await act(async () => { labelInput(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("resets lifecycle callbacks on unmount and ignores the later save result", async () => {
    const completion = deferred();
    const dirty: boolean[] = [];
    const saving: boolean[] = [];
    const onClose = vi.fn();
    const host = await mountEditor({ onSave: () => completion.promise, onClose,
      onDirtyChange: (value) => dirty.push(value), onSavingChange: (value) => saving.push(value) });
    await inputValue(labelInput(host), "Pending draft");
    await act(async () => button(host, "Save").click());
    await act(async () => root!.unmount());
    root = undefined;
    expect(dirty.at(-1)).toBe(false);
    expect(saving.at(-1)).toBe(false);
    await act(async () => completion.resolve());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog when controls are pending and after a failed write", async () => {
    const completion = deferred();
    const host = await mountEditor({ onSave: () => completion.promise });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => button(host, "Save").click());
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(dialog);
    await act(async () => completion.reject(new Error("Storage unavailable")));
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(button(host, "Cancel"));
  });

  it("localizes editor controls and cancels without mutating supplied presets", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async (_value: AnnotationPreset[]) => undefined);
    const host = await mountEditor({ language: "zh-CN", onClose, onSave });
    const first = host.querySelector<HTMLInputElement>('input[aria-label="名称 1"]')!;
    await inputValue(first, "阅读");
    expect(host.querySelector('input[aria-label="颜色 1"]')).toBeTruthy();
    await act(async () => button(host, "取消").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(presets[0]!.label).toBe("Important");
  });
});
