import { afterEach, expect, it, vi } from "vitest";
import { createChromeMock } from "./helpers/chrome-mock";
import {
  readSelectionToolbarEnabled,
  writeSelectionToolbarEnabled,
} from "../src/core/selection-toolbar";

afterEach(() => vi.unstubAllGlobals());

it.each([
  [undefined, false], [null, false], ["false", false], ["true", false],
  [0, false], [1, false], [{}, false], [[], false], [true, true], [false, false],
])(
  "preserves valid automatic-reminder preferences and defaults invalid values off: %j",
  async (value, expected) => {
    vi.stubGlobal("chrome", createChromeMock({ local: { "ui.selectionToolbarEnabled": value } }));
    expect(await readSelectionToolbarEnabled()).toBe(expected);
  },
);

it("keeps automatic reminders off when local storage is unavailable", async () => {
  const mock = createChromeMock();
  mock.storage.local.get.mockRejectedValue(Error("storage unavailable"));
  vi.stubGlobal("chrome", mock);
  expect(await readSelectionToolbarEnabled()).toBe(false);
});

it("changes only the automatic-toolbar preference and reports failed writes", async () => {
  const values: Record<string, unknown> = { settings: { defaultColor: "#facd5a" } };
  const mock = createChromeMock({ local: values });
  vi.stubGlobal("chrome", mock);
  await writeSelectionToolbarEnabled(false);
  expect(await mock.storage.local.get(null)).toEqual({ settings: { defaultColor: "#facd5a" }, "ui.selectionToolbarEnabled": false });
  await expect(writeSelectionToolbarEnabled("false" as unknown as boolean)).rejects.toThrow(/boolean/i);
  expect((await mock.storage.local.get("ui.selectionToolbarEnabled"))["ui.selectionToolbarEnabled"]).toBe(false);
  mock.storage.local.set.mockRejectedValue(Error("storage denied"));
  await expect(writeSelectionToolbarEnabled(true)).rejects.toThrow("storage denied");
});
