import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDataRequest } from "../src/background/data";
import { setDatabaseForTesting, WebInkDatabase } from "../src/background/database";
import type { Annotation, Notification, Request } from "../src/core/model";
import { useAnnotationSync } from "../src/ui/hooks/useAnnotationSync";

const pageUrl = "https://example.test/article";
const original: Annotation = {
  id: "target", kind: "text", pageUrl, pageTitle: "Article", color: "#facc15",
  note: "Original", tags: [], revision: 1,
  createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
  target: { exact: "hello", prefix: "", suffix: "", start: 0, end: 5, rootSelector: "article" },
};
type Sync = ReturnType<typeof useAnnotationSync>;
type Context = Pick<Parameters<typeof useAnnotationSync>[0], "mode" | "pageUrl">;
let db: WebInkDatabase;
let root: Root | undefined;
let sync: Sync;
let listeners: Set<(message: Notification) => void>;
let holdRead: ((response: unknown) => Promise<unknown>) | undefined;
const errors = vi.fn();
const notice = vi.fn();

beforeEach(async () => {
  db = new WebInkDatabase(`annotation-recovery-${crypto.randomUUID()}`);
  setDatabaseForTesting(db);
  await db.annotations.put(original);
  errors.mockClear();
  holdRead = undefined;
  listeners = new Set();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("chrome", { runtime: {
    sendMessage: async (message: Request) => {
      const response = await handleDataRequest(message, { trusted: true });
      return message.type === "annotations.get" && holdRead ? holdRead(response) : response;
    },
    onMessage: {
      addListener: (listener: (message: Notification) => void) => listeners.add(listener),
      removeListener: (listener: (message: Notification) => void) => listeners.delete(listener),
    },
  } });
});

afterEach(async () => {
  const mountedRoot = root;
  if (mountedRoot) await act(async () => mountedRoot.unmount());
  root = undefined;
  document.body.replaceChildren();
  setDatabaseForTesting(undefined);
  db.close();
  await db.delete();
  vi.unstubAllGlobals();
});

function Harness({ mode, pageUrl }: Context) {
  sync = useAnnotationSync({ mode, pageUrl, language: "zh-CN", setError: errors, setNotice: notice });
  return null;
}

async function mount(context: Context = { mode: "library" }) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness, context)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => sync.loadRecords());
  await act(async () => sync.startEdit(original));
  await act(async () => sync.updateDraft(original.id, { note: "My unsaved note" }));
}

function delayRead() {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  holdRead = async (response) => { started(); await gate; return response; };
  return { ready, release };
}

describe("annotation conflict recovery", () => {
  it("reloads an existing ID beyond the first 50 records and saves the retained draft against its latest revision", async () => {
    await mount();
    await db.annotations.put({ ...original, note: "External note", revision: 2 });
    await db.annotations.bulkPut(Array.from({ length: 50 }, (_, index) => ({
      ...original, id: `newer-${index}`, updatedAt: "2026-09-19T00:00:00.000Z",
    })));
    await act(async () => { await sync.saveRecord(original.id); await sync.loadRecords(); });
    expect(sync.conflicts[original.id]).toBe(true);
    errors.mockClear();

    await act(async () => sync.loadLatest(original.id));

    expect(errors).not.toHaveBeenCalled();
    expect(sync.drafts[original.id]).toMatchObject({ note: "My unsaved note", base: { revision: 2, note: "External note" } });
    expect(sync.conflicts[original.id]).toBeUndefined();
    await act(async () => sync.saveRecord(original.id));
    expect(await db.annotations.get(original.id)).toMatchObject({ note: "My unsaved note", revision: 3 });
  });

  it("reports an actually deleted annotation while retaining the local draft and conflict", async () => {
    await mount();
    await db.annotations.put({ ...original, revision: 2 });
    await act(async () => { await sync.saveRecord(original.id); await sync.loadRecords(); });
    await db.annotations.delete(original.id);
    errors.mockClear();
    await act(async () => sync.loadLatest(original.id));
    expect(errors).toHaveBeenCalledWith("标注已被删除。");
    expect(sync.drafts[original.id]).toMatchObject({ note: "My unsaved note", base: { revision: 1 } });
    expect(sync.conflicts[original.id]).toBe(true);
    expect(await db.annotations.get(original.id)).toBeUndefined();
  });

  it.each(["record", "missing", "failure"])("ignores a late %s read after switching the selected target", async (response) => {
    await mount();
    await db.annotations.put({ ...original, revision: 2 });
    await act(async () => { await sync.saveRecord(original.id); await sync.loadRecords(); });
    if (response === "missing") await db.annotations.delete(original.id);
    const delayed = delayRead();
    if (response === "failure") {
      const wait = holdRead!;
      holdRead = async () => wait({ ok: false, error: "Read failed" });
    }
    let pending!: Promise<void>;
    await act(async () => { pending = sync.loadLatest(original.id); await delayed.ready; });
    await act(async () => sync.setSelectedId("another-target"));
    errors.mockClear();
    await act(async () => { delayed.release(); await pending; });
    expect(errors).not.toHaveBeenCalled();
    expect(sync.drafts[original.id]).toMatchObject({ base: { revision: 1 } });
    expect(sync.conflicts[original.id]).toBe(true);
  });

  it("does not apply a record deleted after the ID read but before its response arrives", async () => {
    await mount();
    await db.annotations.put({ ...original, revision: 2 });
    await act(async () => { await sync.saveRecord(original.id); await sync.loadRecords(); });
    const delayed = delayRead();
    let pending!: Promise<void>;
    await act(async () => { pending = sync.loadLatest(original.id); await delayed.ready; });
    await db.annotations.delete(original.id);
    errors.mockClear();
    await act(async () => {
      for (const listener of listeners) listener({ type: "annotations.changed", deletedId: original.id });
    });
    await act(async () => { delayed.release(); await pending; });
    expect(sync.records.some((record) => record.id === original.id)).toBe(false);
    expect(sync.drafts[original.id]).toMatchObject({ base: { revision: 1 } });
    expect(sync.conflicts[original.id]).toBe(true);
    expect(errors).toHaveBeenCalledWith("标注已被删除。");
  });

  it("preserves edits typed while the current ID read is pending", async () => {
    await mount();
    await db.annotations.put({ ...original, revision: 2 });
    const delayed = delayRead();
    let pending!: Promise<void>;
    await act(async () => { pending = sync.loadLatest(original.id); await delayed.ready; });
    await act(async () => sync.updateDraft(original.id, { note: "Typed during read", tags: "new-tag", color: "#38bdf8" }));
    await act(async () => { delayed.release(); await pending; });
    expect(sync.drafts[original.id]).toMatchObject({ note: "Typed during read", tags: "new-tag", color: "#38bdf8", base: { revision: 2 } });
  });

  it("keeps the newest explicit read when an earlier response arrives last", async () => {
    await mount();
    await db.annotations.put({ ...original, revision: 2 });
    const delayed = delayRead();
    let pending!: Promise<void>;
    await act(async () => { pending = sync.loadLatest(original.id); await delayed.ready; });
    await db.annotations.put({ ...original, revision: 3 });
    holdRead = undefined;
    await act(async () => sync.loadLatest(original.id));
    await act(async () => { delayed.release(); await pending; });
    expect(sync.drafts[original.id]).toMatchObject({ base: { revision: 3 } });
  });

  it("still refuses to overwrite a revision changed after the latest read", async () => {
    await mount();
    await db.annotations.put({ ...original, revision: 2 });
    await act(async () => sync.loadLatest(original.id));
    await db.annotations.put({ ...original, note: "Changed after read", revision: 3 });
    await act(async () => { await sync.saveRecord(original.id); await sync.loadRecords(); });
    expect(await db.annotations.get(original.id)).toMatchObject({ note: "Changed after read", revision: 3 });
    expect(sync.drafts[original.id]).toMatchObject({ note: "My unsaved note", base: { revision: 2 } });
    expect(sync.conflicts[original.id]).toBe(true);
  });

  it("does not rebase from a read started before a generic backup import notification", async () => {
    await mount();
    await db.annotations.put({ ...original, revision: 2 });
    await act(async () => { await sync.saveRecord(original.id); await sync.loadRecords(); });
    const delayed = delayRead();
    let pending!: Promise<void>;
    await act(async () => { pending = sync.loadLatest(original.id); await delayed.ready; });
    const imported = await handleDataRequest({
      type: "backup.import", overwrite: true,
      backup: {
        format: "web-ink", schemaVersion: 1, exportedAt: "2026-09-19T00:00:00.000Z",
        annotations: [{ ...original, note: "Imported note", revision: 0 }],
      },
    }, { trusted: true });
    expect(imported).toMatchObject({ ok: true });
    await act(async () => {
      for (const listener of listeners) listener({ type: "annotations.changed" });
      await sync.loadRecords();
    });
    await act(async () => { delayed.release(); await pending; });
    expect(sync.drafts[original.id]).toMatchObject({ note: "My unsaved note", base: { revision: 1 } });
    expect(sync.conflicts[original.id]).toBe(true);
    expect(sync.records.find((record) => record.id === original.id)).toMatchObject({ note: "Imported note", revision: 3 });
  });

  for (const change of ["page", "mode", "unmount"] as const) {
    it.each(["record", "missing", "failure"])(`ignores a late %s read after ${change}`, async (response) => {
      await mount({ mode: "sidepanel", pageUrl });
      await db.annotations.put({ ...original, revision: 2 });
      await act(async () => { await sync.saveRecord(original.id); await sync.loadRecords(); });
      if (response === "missing") await db.annotations.delete(original.id);
      const delayed = delayRead();
      if (response === "failure") {
        const wait = holdRead!;
        holdRead = async () => wait({ ok: false, error: "Read failed" });
      }
      let pending!: Promise<void>;
      await act(async () => { pending = sync.loadLatest(original.id); await delayed.ready; });
      await act(async () => {
        if (change === "unmount") {
          root!.unmount();
          root = undefined;
        } else {
          root!.render(createElement(Harness, change === "page"
            ? { mode: "sidepanel", pageUrl: "https://another.example/page" }
            : { mode: "library", pageUrl }));
        }
      });
      errors.mockClear();
      await act(async () => { delayed.release(); await pending; });
      expect(errors).not.toHaveBeenCalled();
      expect(sync.drafts[original.id]).toMatchObject({ note: "My unsaved note", base: { revision: 1 } });
      expect(sync.conflicts[original.id]).toBe(true);
      if (change === "unmount") expect(listeners.size).toBe(0);
      else await act(async () => sync.loadRecords());
    });
  }
});
