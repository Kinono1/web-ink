import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfTarget } from "../src/core/model";
import { rememberPdfPaperReopen, readPdfPaperReopen } from "../src/pdf/paper-reopen";

const target: PdfTarget = { documentHash: "a".repeat(64), pageNumber: 3,
  fileName: "IEEE-11643626.pdf", sourceUrl: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626&ticket=expired",
  rects: [], exact: "priors", prefix: "", suffix: "" };
const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
let values: Record<string, unknown>;
beforeEach(() => {
  values = {};
  vi.stubGlobal("chrome", { storage: { session: {
    get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, values[key]])),
    set: async (entries: Record<string, unknown>) => { Object.assign(values, entries); },
    remove: async (key: string) => { delete values[key]; },
  } } });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "chrome", original);
  else Reflect.deleteProperty(globalThis, "chrome");
});

describe("saved paper navigation", () => {
  it("carries a legacy record's file and page across a fresh publisher PDF handoff", async () => {
    await rememberPdfPaperReopen(target, undefined, 8);
    expect(await readPdfPaperReopen("https://ieeexplore.ieee.org/document/11643626", undefined, 8))
      .toEqual({ documentHash: "a".repeat(64), pageNumber: 3 });
    expect(JSON.stringify(values)).not.toContain("expired");
    expect(await readPdfPaperReopen("https://ieeexplore.ieee.org/document/99999999", undefined, 8)).toBeUndefined();
  });
  it("carries the request through its explicit DOI without changing saved annotations", async () => {
    const before = structuredClone(target);
    await rememberPdfPaperReopen(target, "10.1109/TII.2026.3716639", 8);
    expect(await readPdfPaperReopen(undefined, "10.1109/TII.2026.3716639", 8))
      .toEqual({ documentHash: "a".repeat(64), pageNumber: 3 });
    expect(await readPdfPaperReopen(undefined, "10.1109/TII.2026.9999999", 8)).toBeUndefined();
    expect(target).toEqual(before);
  });
  it("rejects invalid file identities and corrupt session values", async () => {
    await rememberPdfPaperReopen({ ...target, documentHash: "invalid" }, undefined, 8);
    expect(Object.keys(values)).toHaveLength(0);
    await rememberPdfPaperReopen(target, undefined, 8);
    for (const key of Object.keys(values)) values[key] = { documentHash: "a".repeat(64), pageNumber: -1 };
    expect(await readPdfPaperReopen(target.sourceUrl, undefined, 8)).toBeUndefined();
  });
  it("a storage failure does not prevent opening or reading a paper", async () => {
    vi.stubGlobal("chrome", { storage: { session: { get: async () => { throw Error("unavailable"); },
      set: async () => { throw Error("unavailable"); } } } });
    await expect(rememberPdfPaperReopen(target, undefined, 8)).resolves.toBeUndefined();
    await expect(readPdfPaperReopen(target.sourceUrl, undefined, 8)).resolves.toBeUndefined();
  });
  it("isolates simultaneous choices for the same paper and consumes each intent once", async () => {
    await rememberPdfPaperReopen(target, undefined, 8);
    await rememberPdfPaperReopen({ ...target, documentHash: "b".repeat(64), pageNumber: 9 }, undefined, 9);
    expect(await readPdfPaperReopen(target.sourceUrl, undefined, 8)).toEqual({ documentHash: "a".repeat(64), pageNumber: 3 });
    expect(await readPdfPaperReopen(target.sourceUrl, undefined, 9)).toEqual({ documentHash: "b".repeat(64), pageNumber: 9 });
    expect(await readPdfPaperReopen(target.sourceUrl, undefined, 8)).toBeUndefined();
  });
  it("expires recovery hints and does not create them when no destination tab exists", async () => {
    await rememberPdfPaperReopen(target);
    expect(Object.keys(values)).toHaveLength(0);
    await rememberPdfPaperReopen(target, undefined, 8);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60000);
    expect(await readPdfPaperReopen(target.sourceUrl, undefined, 8)).toBeUndefined();
    clock.mockRestore();
  });
});
