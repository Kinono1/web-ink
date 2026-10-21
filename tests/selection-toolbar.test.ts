import { afterEach, expect, it, vi } from "vitest";
import {
  readSelectionToolbarEnabled,
  writeSelectionToolbarEnabled,
} from "../src/core/selection-toolbar";

afterEach(() => vi.unstubAllGlobals());

it.each([undefined, null, "false", 0, {}, true, false])(
  "defaults invalid automatic-toolbar preferences to enabled: %j",
  async (value) => {
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => ({ "ui.selectionToolbarEnabled": value }),
    } } });
    expect(await readSelectionToolbarEnabled()).toBe(value !== false);
  },
);

it("keeps the default when local storage is unavailable", async () => {
  vi.stubGlobal("chrome", { storage: { local: {
    get: async () => { throw Error("storage unavailable"); },
  } } });
  expect(await readSelectionToolbarEnabled()).toBe(true);
});

it("changes only the automatic-toolbar preference and reports failed writes", async () => {
  const values: Record<string, unknown> = { settings: { defaultColor: "#facd5a" } };
  vi.stubGlobal("chrome", { storage: { local: {
    set: async (entries: Record<string, unknown>) => { Object.assign(values, entries); },
  } } });
  await writeSelectionToolbarEnabled(false);
  expect(values).toEqual({ settings: { defaultColor: "#facd5a" }, "ui.selectionToolbarEnabled": false });
  await expect(writeSelectionToolbarEnabled("false" as unknown as boolean)).rejects.toThrow(/boolean/i);
  expect(values["ui.selectionToolbarEnabled"]).toBe(false);
  vi.stubGlobal("chrome", { storage: { local: {
    set: async () => { throw Error("storage denied"); },
  } } });
  await expect(writeSelectionToolbarEnabled(true)).rejects.toThrow("storage denied");
});
