import { expect, it, vi } from "vitest";
import { createChromeMock } from "./helpers/chrome-mock";

it("keeps storage areas isolated and returns copies with Chrome-style key/default queries", async () => {
  const mock = createChromeMock({ local: { enabled: false, nested: { value: 1 } } });
  expect(await mock.storage.local.get({ enabled: true, absent: "fallback" })).toEqual({ enabled: false, absent: "fallback" });
  expect(await mock.storage.session.get(null)).toEqual({});
  const copy = await mock.storage.local.get(["nested"]);
  (copy.nested as { value: number }).value = 9;
  expect(await mock.storage.local.get("nested")).toEqual({ nested: { value: 1 } });
});
it("emits scoped changes asynchronously and removes the actual registered listener", async () => {
  const mock = createChromeMock({ local: { enabled: false } });
  const listener = vi.fn();
  mock.storage.onChanged.addListener(listener);
  const pending = mock.storage.local.set({ enabled: true });
  expect(listener).not.toHaveBeenCalled();
  await pending;
  expect(listener).toHaveBeenCalledWith({ enabled: { oldValue: false, newValue: true } }, "local");
  mock.storage.onChanged.removeListener(listener);
  await mock.storage.session.set({ enabled: false });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(mock.storage.onChanged.hasListener(listener)).toBe(false);
});
it("routes promise messages and exposes missing fixture routes and rejections", async () => {
  const route = vi.fn(async (message: unknown) => {
    if (message === "fail") throw Error("Context invalidated");
    return { ok: true, data: message };
  });
  const mock = createChromeMock({ sendMessage: route });
  await expect(mock.runtime.sendMessage({ type: "test" })).resolves.toEqual({ ok: true, data: { type: "test" } });
  await expect(mock.runtime.sendMessage("fail")).rejects.toThrow("Context invalidated");
  await expect(createChromeMock().runtime.sendMessage("unhandled")).rejects.toThrow(/handler/i);
});
