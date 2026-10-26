import { afterEach, expect, it, vi } from "vitest";
import { SyncCoordinator } from "../../../src/content/engine/SyncCoordinator";
import type { AnnotationController } from "../../../src/content/engine/AnnotationController";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("cancels a queued refresh before it can issue a browser request", async () => {
  vi.useFakeTimers();
  const messages: unknown[] = [];
  vi.stubGlobal("chrome", { runtime: { sendMessage: async (message: unknown) => { messages.push(message); } } });
  const sync = new SyncCoordinator({ disposed: false, enabled: () => true, currentUrl: location.href } as AnnotationController);
  sync.queueRefresh();
  sync.dispose();
  await vi.runAllTimersAsync();
  expect(messages).toEqual([]);
  expect(sync.generation).toBe(1);
});
