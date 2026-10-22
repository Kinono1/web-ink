import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PALETTE_SIZE_KEY,
  readPaletteSize,
  writePaletteSize,
} from "../src/core/palette-appearance";

afterEach(() => vi.unstubAllGlobals());

describe("palette appearance preferences", () => {
  it.each([
    [undefined, 40],
    [null, 40],
    ["40", 40],
    [39, 40],
    [41, 40],
    [65, 40],
    [Number.NaN, 40],
    [Number.POSITIVE_INFINITY, 40],
    [40, 40],
    [44, 44],
    [48, 48],
    [52, 52],
    [56, 56],
    [60, 60],
    [64, 64],
  ])("reads only supported palette sizes and otherwise defaults to 40: %j", async (value, expected) => {
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => ({ [PALETTE_SIZE_KEY]: value }),
    } } });

    expect(await readPaletteSize()).toBe(expected);
  });

  it("defaults to 40 when local preference storage is unavailable", async () => {
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => { throw Error("storage unavailable"); },
    } } });

    expect(await readPaletteSize()).toBe(40);
  });

  it("writes only supported palette sizes to the independent UI preference", async () => {
    const values: Record<string, unknown> = { settings: { defaultColor: "#facd5a" } };
    vi.stubGlobal("chrome", { storage: { local: {
      set: async (entries: Record<string, unknown>) => { Object.assign(values, entries); },
    } } });

    await writePaletteSize(64);

    expect(values).toEqual({ settings: { defaultColor: "#facd5a" }, [PALETTE_SIZE_KEY]: 64 });
    await expect(writePaletteSize(42)).rejects.toThrow(/palette size/i);
    await expect(writePaletteSize(Number.NaN)).rejects.toThrow(/palette size/i);
    expect(values[PALETTE_SIZE_KEY]).toBe(64);
  });
});
