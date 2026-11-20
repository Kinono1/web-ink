import { reader, deferred, settle, mount, button, click, selectPage, puts, unloadBlocked } from "../helpers/pdf-reader";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";

describe("PDF reader workspace", () => {
  it("cancels a pending focus entry when opening annotations", async () => {
    const closeGate = deferred<void>();
    const close = vi.fn(() => closeGate.promise);
    Object.assign(chrome, { tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) }, sidePanel: { open: async () => {}, close } });
    await mount();
    await click("更多");
    await click("专注阅读");
    expect(close).toHaveBeenCalledWith({ windowId: 1 });
    await click("查看标注");
    await act(async () => closeGate.resolve());
    await settle();
    expect(reader.host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    await click("更多");
    expect(button("旋转页面").disabled).toBe(false);
  });

  it("cancels a pending focus entry when Escape closes More", async () => {
    const closeGate = deferred<void>();
    Object.assign(chrome, { tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) }, sidePanel: { open: async () => {}, close: () => closeGate.promise } });
    await mount();
    await click("更多");
    await click("专注阅读");
    const pages = reader.host.querySelector<HTMLElement>(".pdf-pages")!;
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await settle();
    expect(reader.host.querySelector(".pdf-more-menu")).toBeNull();
    expect(reader.host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    await act(async () => closeGate.resolve());
    await settle();
    expect(reader.host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    await click("更多");
    expect(button("旋转页面").disabled).toBe(false);
  });

  it("cancels a pending focus entry before opening another source", async () => {
    const closeGate = deferred<void>();
    Object.assign(chrome, { tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) }, sidePanel: { open: async () => {}, close: () => closeGate.promise } });
    await mount();
    await click("更多");
    await click("专注阅读");
    await click("打开其他文件");
    expect(reader.host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("打开其他 PDF");
    await act(async () => closeGate.resolve());
    await settle();
    expect(reader.host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    expect(reader.host.querySelector(".pdf-focus-controls")).toBeNull();
  });

  it("enters focus without changing zoom or saved records and exits by Escape", async () => {
    await mount();
    const pages = reader.host.querySelector<HTMLElement>(".pdf-pages")!;
    pages.scrollTop = 240;
    await click("更多");
    await click("专注阅读");
    expect(reader.host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("true");
    expect(reader.host.querySelector<HTMLElement>(".pdf-toolbar")?.hidden).toBe(true);
    expect(reader.host.querySelector(".pdf-focus-controls")).toBeTruthy();
    expect(pages.scrollTop).toBe(240);
    expect(puts()).toHaveLength(0);
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(reader.host.querySelector(".pdf-app")?.getAttribute("data-focus")).toBe("false");
    expect(reader.host.querySelector<HTMLElement>(".pdf-toolbar")?.hidden).toBe(false);
    expect(reader.host.querySelector(".pdf-focus-controls")).toBeNull();
  });

  it("requests closing only this window's panel and offers a manual hint on failure", async () => {
    const close = vi.fn(async () => { throw Error("close unavailable"); });
    Object.assign(chrome, { tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) }, sidePanel: { open: async () => {}, close } });
    await mount();
    await click("更多");
    await click("专注阅读");
    expect(close).toHaveBeenCalledWith({ windowId: 1 });
    expect(reader.host.querySelector(".pdf-focus-hint")?.textContent).toContain("手动");
    await click("退出专注");
    expect(reader.host.querySelector(".pdf-focus-controls")).toBeNull();
  });

  it("saves a preset with its label tag only on explicit action and rejects a collapsed stale shortcut", async () => {
    await mount();
    await selectPage();
    expect(puts()).toHaveLength(0);
    await click("重要");
    expect(puts()[0]!.annotation.color).toBe("#facd5a");
    expect(puts()[0]!.annotation.tags).toEqual(["重要"]);
    await selectPage();
    getSelection()?.removeAllRanges();
    const pages = reader.host.querySelector<HTMLElement>(".pdf-pages")!;
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", { key: "!", code: "Digit1", altKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    expect(puts()).toHaveLength(1);
    await selectPage();
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", { key: "@", code: "Digit2", altKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    await settle();
    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.annotation.tags).toEqual(["疑问"]);
  });

  it("updates shared preset choices from local preference changes without writing records", async () => {
    let listener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;
    const removeListener = vi.fn();
    Object.assign(chrome.storage, { onChanged: { addListener: (next: typeof listener) => { listener = next; }, removeListener } });
    await mount();
    await selectPage();
    await act(async () => listener?.({ "ui.annotationPresets": { newValue: [{ id: "review", label: "待复核", color: "#69b0f1" }] } }, "local"));
    await settle();
    expect(button("待复核")).toBeTruthy();
    expect(puts()).toHaveLength(0);
    await act(async () => reader.root!.unmount()); reader.root = undefined;
    expect(removeListener).toHaveBeenCalled();
  });

  it("restores a pending stored preset after cancelling its editor and writes its tag", async () => {
    const initialRead = deferred<Record<string, unknown>>();
    Object.assign(chrome.storage.local, { get: async (key: string) => {
      reader.readKeys.push(key);
      return key === "ui.annotationPresets" ? initialRead.promise : { [key]: reader.storedPosition };
    } });
    await mount();
    expect(reader.readKeys).toContain("ui.annotationPresets");
    await click("更多");
    await click("标注预设…");
    await click("取消");
    await act(async () => initialRead.resolve({ "ui.annotationPresets": [{ id: "review", label: "待复核", color: "#69b0f1" }] }));
    await settle();
    await selectPage();
    expect(button("待复核")).toBeTruthy();
    await click("待复核");
    expect(puts()[0]!.annotation.tags).toEqual(["待复核"]);
  });

  it("keeps an explicitly saved preset when an older initial read resolves later", async () => {
    const initialRead = deferred<Record<string, unknown>>();
    Object.assign(chrome.storage.local, { get: async (key: string) => {
      reader.readKeys.push(key);
      return key === "ui.annotationPresets" ? initialRead.promise : { [key]: reader.storedPosition };
    } });
    await mount();
    await click("更多");
    await click("标注预设…");
    const input = reader.host.querySelector<HTMLInputElement>('input[aria-label="名称 1"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "已保存");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("保存");
    await act(async () => initialRead.resolve({ "ui.annotationPresets": [{ id: "stale", label: "过期", color: "#69b0f1" }] }));
    await settle();
    await selectPage();
    expect(button("已保存")).toBeTruthy();
    expect([...reader.host.querySelectorAll("button")].some((node) => node.textContent?.trim() === "过期")).toBe(false);
    await click("已保存");
    expect(puts()[0]!.annotation.tags).toEqual(["已保存"]);
  });

  it("returns focus only when Escape closes an open More menu", async () => {
    await mount();
    const trigger = button("更多");
    await click("更多");
    const item = button("旋转页面");
    item.focus();
    expect(document.activeElement).toBe(item);
    await act(async () => item.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true,
    })));
    await settle();
    expect(reader.host.querySelector(".pdf-more-menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    const pages = reader.host.querySelector<HTMLElement>(".pdf-pages")!;
    pages.focus();
    await act(async () => pages.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true,
    })));
    expect(document.activeElement).toBe(pages);
  });

  it("offers selection actions immediately, keeps copying inert and separates overlay visibility", async () => {
    await mount();
    expect(reader.host.querySelector(".pdf-notes")?.hasAttribute("hidden")).toBe(true);
    await selectPage();
    expect(reader.host.querySelector(".pdf-selection")).toBeTruthy();
    await act(async () => document.dispatchEvent(new Event("copy", { bubbles: true })));
    expect(puts()).toHaveLength(0);
    expect(unloadBlocked()).toBe(false);
    await click("更多");
    await click("隐藏标注");
    await selectPage();
    await click("高亮 #facd5a");
    expect(puts()).toHaveLength(1);
    expect(reader.messages.some((message) => message.type === "page.mode.put")).toBe(false);
    expect(reader.host.querySelector("[data-pdf-annotation]")).toBeNull();
  });

  it("retains a failed selection and retries the same durable identity without a viewport anchor", async () => {
    await mount();
    await selectPage();
    reader.putGate = deferred();
    await click("高亮 #facd5a");
    expect(reader.host.querySelector(".pdf-selection")).toBeTruthy();
    expect(unloadBlocked()).toBe(true);
    const sent = puts()[0]!;
    expect(Object.keys(sent.annotation.target).sort()).toEqual(["documentHash", "exact", "fileName", "pageNumber", "prefix", "rects", "suffix"]);
    await act(async () => reader.putGate!.resolve({ ok: false, error: "disk full", code: "STORAGE_ERROR" }));
    await settle();
    expect(reader.host.querySelector(".pdf-selection")).toBeTruthy();
    reader.putGate = undefined;
    await click("重试保存");
    expect(puts()[1]!.annotation.id).toBe(sent.annotation.id);
    expect(reader.host.querySelector(".pdf-selection")).toBeNull();
    expect(window.getSelection()!.rangeCount).toBe(0);
    expect(unloadBlocked()).toBe(false);
  });

  it("saves the highlight before opening and focusing its note draft", async () => {
    await mount();
    await selectPage();
    reader.putGate = deferred();
    await click("添加笔记");
    expect(reader.host.querySelector("textarea")).toBeNull();
    const annotation = puts()[0]!.annotation;
    await act(async () => reader.putGate!.resolve({ ok: true, data: { ...annotation, revision: 7 } }));
    await settle();
    expect(reader.host.querySelector(".pdf-notes")?.hasAttribute("hidden")).toBe(false);
    const textarea = reader.host.querySelector(".pdf-note-editor textarea");
    expect(textarea).toBeTruthy();
    expect(document.activeElement).toBe(textarea);
    expect(unloadBlocked()).toBe(false);
  });

  it("rejects a cross-page selection explicitly without keeping a partial previous selection", async () => {
    await mount();
    await selectPage();
    const first = reader.host.querySelector('[data-page="1"] .textLayer span')!.firstChild!;
    const last = reader.host.querySelector('[data-page="2"] .textLayer span')!.firstChild!;
    const range = document.createRange();
    range.setStart(first, 2);
    range.setEnd(last, 10);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => reader.host.querySelector('[data-page="2"] .pdf-page')!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    expect(reader.host.querySelector('[role="alert"]')?.textContent ?? "").toContain("一页");
    expect(reader.host.querySelector(".pdf-selection")).toBeNull();
    expect(puts()).toHaveLength(0);
  });
});
