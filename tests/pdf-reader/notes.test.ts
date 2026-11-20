import { HASH, TOKEN, baseRecord, reader, deferred, settle, mount, chooseLocalPdf, button, click, openNotes, selectPage, puts, unloadBlocked, editNote, runtimeListeners, sidebarPort } from "../helpers/pdf-reader";
import { describe, expect, it } from "vitest";
import { act } from "react";

describe("PDF reader workspace", () => {
  it("keeps sidebar edits in the reader leave guard and rejects an old document command", async () => {
    reader.records = [baseRecord()];
    const { outgoing, listeners } = sidebarPort();
    await mount(`?handoff=${TOKEN}`);
    const state = outgoing.filter((message) => message.type === "state").at(-1).state;
    const draft = { note: "sidebar draft", tags: "", color: "#facc15", base: reader.records[0], editing: true };
    const command = { type: "command", commandId: "draft-1", pageUrl: state.pageUrl, sessionId: "expired", command: { type: "draft", id: "saved-highlight", draft } };
    await act(async () => { for (const listener of listeners) listener(command); });
    expect(unloadBlocked()).toBe(false);
    await act(async () => { for (const listener of listeners) listener({ ...command, sessionId: state.sessionId }); });
    await settle();
    expect(unloadBlocked()).toBe(true);
    await click("返回原阅读器");
    expect(reader.host.querySelector('[role="dialog"]')?.textContent).toContain("未保存");
    expect(reader.messages.some((message) => message.type === "pdf.returnOriginal")).toBe(false);
    await click("继续编辑");
    reader.putError = "changed elsewhere";
    await act(async () => { for (const listener of listeners) listener({ ...command, commandId: "save-1", sessionId: state.sessionId, command: { type: "save", id: "saved-highlight" } }); });
    await settle();
    const failed = outgoing.filter((message) => message.type === "state").at(-1).state;
    expect(failed.drafts["saved-highlight"].note).toBe("sidebar draft");
    expect(failed.conflicts["saved-highlight"]).toBe(true);
    expect(reader.records[0]!.note).toBe("");
    expect(unloadBlocked()).toBe(true);
  });

  it("rejects every old-session command after reopening the same PDF bytes", async () => {
    reader.records = [baseRecord()];
    const { outgoing, listeners } = sidebarPort();
    await mount();
    const old = outgoing.filter((message) => message.type === "state").at(-1).state;
    await click("更多");
    await click("打开其他文件");
    await chooseLocalPdf(new File(["%PDF-"], "same-bytes.pdf", { type: "application/pdf" }));
    const current = outgoing.filter((message) => message.type === "state").at(-1).state;
    expect(current.pageUrl).toBe(old.pageUrl);
    expect(current.sessionId).not.toBe(old.sessionId);
    const draft = { note: "stale session input", tags: "", color: reader.records[0]!.color, base: reader.records[0], editing: true };
    const commands = [
      { type: "draft", id: "saved-highlight", draft },
      { type: "save", id: "saved-highlight" },
      { type: "remove", id: "saved-highlight" },
      { type: "focus", id: "saved-highlight" },
      { type: "filter", filter: "original" },
      { type: "undo" },
    ];
    const before = reader.messages.length;
    outgoing.length = 0;
    await act(async () => {
      for (const [index, command] of commands.entries()) {
        for (const listener of listeners) listener({ type: "command", commandId: `stale-${index}`, pageUrl: old.pageUrl, sessionId: old.sessionId, command });
      }
    });
    await settle();
    expect(reader.messages.slice(before).some((message) => message.type.startsWith("annotations."))).toBe(false);
    expect(outgoing.some((message) => message.ack?.startsWith("stale-"))).toBe(false);
    expect(unloadBlocked()).toBe(false);
    expect(reader.host.querySelector(".pdf-mark-menu")).toBeNull();
    expect(reader.records[0]!.note).toBe("");
  });

  it("preserves an older sidebar draft as a conflict before any database write", async () => {
    const old = baseRecord();
    reader.records = [{ ...old, revision: 4, note: "Updated elsewhere" }];
    const { outgoing, listeners } = sidebarPort();
    await mount();
    const state = outgoing.filter((message) => message.type === "state").at(-1).state;
    await act(async () => { for (const listener of listeners) listener({ type: "command", commandId: "replayed", pageUrl: state.pageUrl, sessionId: state.sessionId,
      command: { type: "draft", id: old.id, draft: { note: "Recovered typed input", color: old.color, tags: "", base: old, editing: true } } }); });
    await settle();
    const recovered = outgoing.filter((message) => message.type === "state").at(-1).state;
    expect(recovered.drafts[old.id].note).toBe("Recovered typed input");
    expect(recovered.conflicts[old.id]).toBe(true);
    expect(unloadBlocked()).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it("opens the existing Chrome sidebar instead of a second notes rail", async () => {
    reader.records = [baseRecord()];
    const openedPanels: number[] = [];
    const { listeners } = sidebarPort();
    Object.assign(chrome, {
      tabs: { getCurrent: async () => ({ id: 8, windowId: 1 }) },
      sidePanel: { open: async ({ tabId }: { tabId: number }) => { openedPanels.push(tabId); } },
    });
    await mount();
    expect(reader.host.querySelector('.pdf-toolbar button[aria-label="笔记"]')).toBeNull();
    await click("更多");
    await click("查看标注");
    expect(openedPanels).toEqual([8]);
    await act(async () => { for (const listener of listeners) listener({ type: "attached", attached: true }); });
    await click("更多");
    expect(reader.host.querySelector(".pdf-more-menu")?.textContent).not.toContain("查看标注");
    await act(async () => { for (const listener of listeners) listener({ type: "attached", attached: false }); });
    expect(button("查看标注")).toBeTruthy();
    expect(reader.host.querySelector(".pdf-workspace")?.classList.contains("notes-open")).toBe(false);
    expect(reader.host.querySelector<HTMLElement>(".pdf-notes")?.hidden ?? true).toBe(true);
    expect(reader.records).toHaveLength(1);
  });

  it("opens the sidebar on the Add note gesture before the asynchronous save", async () => {
    const openedPanels: number[] = [];
    Object.assign(chrome, {
      tabs: { getCurrent: async () => ({ id: 8 }) },
      sidePanel: { open: async ({ tabId }: { tabId: number }) => { openedPanels.push(tabId); } },
    });
    await mount();
    await selectPage();
    reader.putGate = deferred<unknown>();
    await click("添加笔记");
    expect(openedPanels).toEqual([8]);
    expect(reader.host.querySelector(".pdf-workspace")?.classList.contains("notes-open")).toBe(false);
    const pending = puts().at(-1)!;
    if (pending.type !== "annotations.put") throw Error("Missing highlight write");
    reader.putGate.resolve({ ok: true, data: { ...pending.annotation, revision: 1 } });
    await settle();
    expect(reader.host.querySelector(".pdf-workspace")?.classList.contains("notes-open")).toBe(false);
  });

  it.each(["open", "closed"])("restores orphan draft focus after Keep editing when Notes was %s", async (notes) => {
    const listeners = runtimeListeners();
    reader.records = [baseRecord()];
    await mount(`?handoff=${TOKEN}`);
    await editNote("recover editor focus");
    await act(async () => {
      reader.records = [];
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`, deletedId: "saved-highlight" });
    });
    await settle();
    const textarea = reader.host.querySelector<HTMLTextAreaElement>("textarea")!;
    if (notes === "closed") await click("关闭笔记");
    await click("返回原阅读器");
    const keep = button("继续编辑");
    keep.focus();
    expect(document.activeElement).toBe(keep);
    await click("继续编辑");
    expect(reader.host.querySelector('[role="dialog"]')).toBeNull();
    expect(reader.host.querySelector(".pdf-notes")?.hasAttribute("hidden")).toBe(false);
    expect(document.activeElement).toBe(textarea);
  });

  it("keeps focus inside an open leave dialog when its dirty annotation is deleted", async () => {
    const listeners = runtimeListeners();
    reader.records = [baseRecord()];
    await mount(`?handoff=${TOKEN}`);
    await editNote("retain modal focus");
    await click("返回原阅读器");
    const keep = button("继续编辑");
    keep.focus();
    await act(async () => {
      reader.records = [];
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`, deletedId: "saved-highlight" });
    });
    await settle();
    expect(reader.host.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.activeElement).toBe(keep);
    await click("继续编辑");
    expect(document.activeElement).toBe(reader.host.querySelector("textarea"));
  });

  it.each(["deletedId", "list refresh"])("keeps a dirty deleted note editable after %s without resurrecting its record", async (route) => {
    const listeners = runtimeListeners();
    reader.records = [baseRecord(), ...Array.from({ length: 55 }, (_, index) => ({
      ...baseRecord(), id: `other-saved-${index}`,
      target: { ...baseRecord().target, pageNumber: 2, exact: "other passage" },
    }))];
    await mount(`?handoff=${TOKEN}`);
    await editNote("preserve this orphan draft");
    await act(async () => {
      reader.records = reader.records.filter((record) => record.id !== "saved-highlight");
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`,
        ...(route === "deletedId" ? { deletedId: "saved-highlight" } : {}) });
    });
    await settle();
    expect(reader.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("preserve this orphan draft");
    expect(reader.host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    const orphan = reader.host.querySelector('[data-pdf-note="saved-highlight"]');
    expect(orphan?.textContent).toContain("saved passage");
    expect(orphan?.textContent).toContain("原标注已被删除");
    expect(orphan?.textContent).not.toContain("载入最新版本");
    expect(reader.host.querySelector(".pdf-notes h2 span")?.textContent).toBe("55");
    await click("关闭笔记");
    await click("返回原阅读器");
    await click("继续编辑");
    expect(reader.host.querySelector(".pdf-notes")?.hasAttribute("hidden")).toBe(false);
    await click("返回原阅读器");
    await click("保存并继续");
    expect(puts()).toHaveLength(0);
    expect(reader.messages.some((message) => message.type === "pdf.returnOriginal")).toBe(false);
    expect(reader.host.querySelector('[role="dialog"]')).toBeTruthy();
    await click("继续编辑");
    const textarea = reader.host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("preserve this orphan draft");
    expect(textarea.disabled).toBe(false);
    textarea.select();
    expect(textarea.selectionEnd - textarea.selectionStart).toBe(textarea.value.length);
    expect(unloadBlocked()).toBe(true);
    await click("放弃草稿");
    expect(unloadBlocked()).toBe(false);
    expect(reader.records).toHaveLength(55);
    expect(reader.records.some((record) => record.id === "saved-highlight")).toBe(false);
    expect(puts()).toHaveLength(0);
    expect(reader.messages.some((message) => message.type === "annotations.restore" || message.type === "annotations.delete")).toBe(false);
  });

  it("does not re-add a deleted note from a save response that arrives after deletion", async () => {
    const listeners = runtimeListeners();
    reader.records = [baseRecord()];
    await mount();
    await editNote("draft being saved");
    reader.putGate = deferred();
    await click("保存");
    await act(async () => {
      reader.records = [];
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: `urn:web-ink:pdf:${HASH}`, deletedId: "saved-highlight" });
      reader.putGate!.resolve({ ok: true, data: { ...baseRecord(), note: "draft being saved", revision: 4 } });
    });
    await settle();
    expect(reader.host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    expect(reader.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("draft being saved");
    expect(unloadBlocked()).toBe(true);
    expect(puts()).toHaveLength(1);
  });

  it("guards changed note return, stays after failed save and uses the saved base revision", async () => {
    reader.records = [baseRecord()];
    await mount(`?handoff=${TOKEN}`);
    await editNote("retain this draft");
    expect(unloadBlocked()).toBe(true);
    await click("返回原阅读器");
    expect(reader.host.querySelector('[role="dialog"][aria-label="未保存的内容"]')).toBeTruthy();
    reader.putError = "changed elsewhere";
    await click("保存并继续");
    expect(reader.host.querySelector("textarea")?.value).toBe("retain this draft");
    expect(reader.messages.some((message) => message.type === "pdf.returnOriginal")).toBe(false);
    expect(puts()[0]!.expectedRevision).toBe(3);
    await click("继续编辑");
    expect(reader.host.querySelector('[role="dialog"]')).toBeNull();
    expect(reader.host.querySelector("textarea")?.value).toBe("retain this draft");
    reader.putError = "";
    await click("返回原阅读器");
    await click("保存并继续");
    expect(reader.messages.filter((message) => message.type === "pdf.returnOriginal")).toEqual([{ type: "pdf.returnOriginal", token: TOKEN }]);
  });

  it("keeps clean editors and bookmark timers out of beforeunload, but observes note writes in flight", async () => {
    reader.records = [baseRecord()];
    await mount();
    await openNotes();
    await click("编辑");
    expect(unloadBlocked()).toBe(false);
    reader.putGate = deferred();
    await click("保存");
    expect(unloadBlocked()).toBe(true);
    await act(async () => reader.putGate!.resolve({ ok: true, data: { ...baseRecord(), revision: 4 } }));
    await settle();
    expect(unloadBlocked()).toBe(false);
  });

  it("preserves a dirty note when changing file until discard is chosen", async () => {
    reader.records = [baseRecord()];
    await mount();
    await editNote("draft");
    await click("更多");
    await click("打开其他文件");
    expect(reader.host.querySelector('[role="dialog"]')).toBeTruthy();
    await click("继续编辑");
    expect(reader.host.querySelector("textarea")?.value).toBe("draft");
    await click("更多");
    await click("打开其他文件");
    await click("放弃并继续");
    expect(reader.host.querySelector('[aria-label="打开其他 PDF"]')).toBeTruthy();
    expect(unloadBlocked()).toBe(false);
  });
});
