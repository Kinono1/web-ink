import { afterEach, expect, it, vi } from "vitest";
import { SaveCoordinator } from "../../../src/content/engine/SaveCoordinator";
import type { AnnotationController } from "../../../src/content/engine/AnnotationController";
import type { TextAnnotation } from "../../../src/core/model";

const record: TextAnnotation = {
  id: "one", revision: 7, kind: "text", color: "#ffff00",
  pageUrl: location.href, pageTitle: "Test", note: "", tags: [],
  createdAt: "2026-10-26", updatedAt: "2026-10-26",
  target: {
    rootSelector: "body", exact: "text", prefix: "", suffix: "", start: 0, end: 4,
  },
};
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const notices: string[] = [];
  const changes: unknown[] = [];
  const engine = {
    label: (_cn: string, en: string) => en,
    toast: (message: string) => notices.push(message),
    notifications: { show: (message: string) => notices.push(message) },
    mode: { rebinding: record },
    disposed: false,
    store: { applyAnnotationDelta: (...args: unknown[]) => changes.push(args) },
    render: { schedulePaint: () => {} },
  } as unknown as AnnotationController;
  return { save: new SaveCoordinator(engine), notices, changes };
}

it("blocks concurrent writes and publishes success only after durable confirmation", async () => {
  let complete!: (value: unknown) => void;
  const messages: unknown[] = [];
  vi.stubGlobal("chrome", { runtime: {
    sendMessage: (message: unknown) => {
      messages.push(message);
      return new Promise(resolve => { complete = resolve; });
    },
  } });
  const { save, notices, changes } = fixture();
  const pending = save.commit(record);
  await save.commit({ ...record, id: "two" });
  expect(messages).toEqual([{
    type: "annotations.put", annotation: record, expectedRevision: 7,
  }]);
  expect(save.unsaved).toBe(record);
  expect(notices).toEqual(["Saving…"]);
  expect(changes).toEqual([]);
  complete({ ok: true, data: { ...record, revision: 8 } });
  await pending;
  expect(save.pendingSave).toBe(false);
  expect(save.unsaved).toBeUndefined();
  expect(notices).toContain("Saved on this device");
  expect(changes).toHaveLength(1);
});

it("retains a conflicted draft without retrying or claiming success", async () => {
  const messages: unknown[] = [];
  vi.stubGlobal("chrome", { runtime: {
    sendMessage: async (message: unknown) => {
      messages.push(message);
      return { ok: false, code: "CONFLICT", error: "Changed elsewhere" };
    },
  } });
  const { save, notices, changes } = fixture();
  await save.commit(record);
  expect(save.unsaved).toBe(record);
  expect(save.pendingSave).toBe(false);
  expect(messages).toHaveLength(1);
  expect(changes).toEqual([]);
  expect(notices).toEqual(["Saving…", "Not saved: Changed elsewhere"]);
});
