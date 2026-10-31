import { afterEach, expect, it, vi } from "vitest";
import { DataEngine, type DataEngineHost } from "../../../src/content/engine/DataEngine";
import { createView } from "../../../src/content/view-lite";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("cancels a queued refresh before it can issue a browser request", async () => {
  vi.useFakeTimers();
  const messages: unknown[] = [];
  vi.stubGlobal("chrome", { runtime: { sendMessage: async (message: unknown) => { messages.push(message); } } });
  const sync = new DataEngine({
    disposed: false, enabled: () => true, currentUrl: location.href, view: createView(),
  } as unknown as DataEngineHost);
  sync.queueRefresh();
  sync.disposeSync();
  await vi.runAllTimersAsync();
  expect(messages).toEqual([]);
  expect(sync.generation).toBe(1);
});
