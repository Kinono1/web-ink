import { afterEach, describe, expect, it } from "vitest";
import {
  defaultAnnotationPresets,
  presetIndexFromKey,
  readAnnotationPresets,
  saveAnnotationPresets,
  validateAnnotationPresets,
  type AnnotationPreset,
} from "../src/core/annotation-presets";

const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");

function installStorage(
  get: (key: string) => Promise<Record<string, unknown>>,
  set: (entries: Record<string, AnnotationPreset[]>) => Promise<void>,
) {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: { get, set } } },
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function preset(label: string): AnnotationPreset[] {
  return [{ id: "custom", label, color: "#facc15" }];
}

afterEach(() => {
  if (chromeDescriptor) Object.defineProperty(globalThis, "chrome", chromeDescriptor);
  else Reflect.deleteProperty(globalThis, "chrome");
});

it("rejects invalid presets before replacing the saved preference", async () => {
  const saved = [{ id: "important", label: "Important", color: "#facd5a" }];
  const values: Record<string, unknown> = { "ui.annotationPresets": saved, settings: { defaultColor: "#facc15" } };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: {
      set: async (entries: Record<string, unknown>) => { Object.assign(values, entries); },
    } } },
  });

  await expect(saveAnnotationPresets([{ id: "question", label: "Question", color: "blue" }]))
    .rejects.toThrow(/color/i);
  expect(values).toEqual({ "ui.annotationPresets": saved, settings: { defaultColor: "#facc15" } });
});

describe("annotation preset validation", () => {
  it("normalizes labels and HEX without changing valid stored colors", () => {
    const input = [{ id: "custom:1", label: "  阅读 📖  ", color: "#FaCc15" }];
    expect(validateAnnotationPresets(input)).toEqual([{ id: "custom:1", label: "阅读 📖", color: "#facc15" }]);
    expect(input[0]!.label).toBe("  阅读 📖  ");
    expect(validateAnnotationPresets(preset("📖".repeat(24)))[0]!.label).toBe("📖".repeat(24));
  });

  it.each([
    [undefined, /1.*5|array/i],
    [[], /1.*5/i],
    [Array.from({ length: 6 }, (_, index) => ({ id: `preset-${index}`, label: "Label", color: "#facd5a" })), /1.*5/i],
    [[null], /object/i],
    [[[]], /object/i],
    [[{ id: "valid", label: "", color: "#facd5a" }], /label/i],
    [[{ id: "valid", label: "   ", color: "#facd5a" }], /label/i],
    [[{ id: "valid", label: "📖".repeat(25), color: "#facd5a" }], /24|label/i],
    [[{ id: "valid", label: "Line\nBreak", color: "#facd5a" }], /label|control/i],
    [[{ id: "valid", label: "Tab\tLabel", color: "#facd5a" }], /label|control/i],
    [[{ id: "valid", label: "Hidden\u0085Label", color: "#facd5a" }], /label|control/i],
    [[{ id: "valid", label: "Hidden\u0000Label", color: "#facd5a" }], /label|control/i],
    [[{ id: "valid", label: 7, color: "#facd5a" }], /label/i],
    [[{ id: "", label: "Label", color: "#facd5a" }], /id/i],
    [[{ id: "unsafe id", label: "Label", color: "#facd5a" }], /id/i],
    [[{ id: "x".repeat(129), label: "Label", color: "#facd5a" }], /id/i],
    [[{ id: "valid", label: "Label", color: "#fff" }], /color/i],
    [[{ id: "valid", label: "Label", color: "url(https://example.test)" }], /color/i],
    [[{ id: "valid", label: "Label", color: "#facd5a", extra: true }], /field/i],
    [[{ id: "same", label: "First", color: "#facd5a" }, { id: "same", label: "Second", color: "#69b0f1" }], /unique|duplicate/i],
  ])("rejects malformed preference %#", (value, message) => {
    expect(() => validateAnnotationPresets(value)).toThrow(message as RegExp);
  });
});

describe("annotation preset preferences", () => {
  it("returns localized defaults without sharing mutable entries", async () => {
    Reflect.deleteProperty(globalThis, "chrome");
    const first = await readAnnotationPresets("zh-CN");
    expect(first).toEqual([
      { id: "important", label: "重要", color: "#facd5a" },
      { id: "question", label: "疑问", color: "#69b0f1" },
      { id: "insight", label: "精彩", color: "#7cc868" },
    ]);
    first[0]!.label = "Changed";
    expect(defaultAnnotationPresets("en")).toEqual([
      { id: "important", label: "Important", color: "#facd5a" },
      { id: "question", label: "Question", color: "#69b0f1" },
      { id: "insight", label: "Insight", color: "#7cc868" },
    ]);
    expect(defaultAnnotationPresets("zh-CN")[0]!.label).toBe("重要");
  });

  it("reads valid custom labels independently from legacy settings", async () => {
    const values = { "ui.annotationPresets": [{ id: "custom", label: "  Custom  ", color: "#FaCc15" }], settings: { defaultColor: "#fb5c89" } };
    const requests: string[] = [];
    installStorage(async (key) => { requests.push(key); return values; }, async () => { throw new Error("read must not repair storage"); });
    const read = await readAnnotationPresets("zh-CN");
    expect(read).toEqual([{ id: "custom", label: "Custom", color: "#facc15" }]);
    read[0]!.label = "Changed";
    expect(values["ui.annotationPresets"][0]!.label).toBe("  Custom  ");
    expect(requests).toEqual(["ui.annotationPresets"]);
  });

  it.each([[undefined], [[]], [[{ id: "broken", label: "Bad", color: "red" }]]])("uses defaults for corrupt or missing storage without writing", async (value) => {
    let writes = 0;
    installStorage(async () => ({ "ui.annotationPresets": value }), async () => { writes += 1; });
    expect((await readAnnotationPresets("en"))[0]).toEqual({ id: "important", label: "Important", color: "#facd5a" });
    expect(writes).toBe(0);
  });

  it("falls back on read failure", async () => {
    installStorage(async () => { throw new Error("storage unavailable"); }, async () => undefined);
    expect((await readAnnotationPresets("en"))[1]).toEqual({ id: "question", label: "Question", color: "#69b0f1" });
  });

  it("serializes concurrent saves and snapshots each request before later edits", async () => {
    const completions: ReturnType<typeof deferred>[] = [];
    const writes: AnnotationPreset[][] = [];
    let durable: AnnotationPreset[] | undefined;
    let running = 0;
    let maximumRunning = 0;
    installStorage(async () => ({}), async (entries) => {
      expect(Object.keys(entries)).toEqual(["ui.annotationPresets"]);
      const snapshot = entries["ui.annotationPresets"]!;
      const completion = deferred();
      completions.push(completion);
      writes.push(snapshot);
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      try { await completion.promise; durable = snapshot; }
      finally { running -= 1; }
    });
    const input = preset("First");
    const first = saveAnnotationPresets(input);
    const second = saveAnnotationPresets(preset("Second"));
    const third = saveAnnotationPresets(preset("Newest"));
    input[0]!.label = "Mutation after request";
    await settle();
    expect(writes.map((entries) => entries[0]!.label)).toEqual(["First"]);
    completions[0]!.resolve();
    await first;
    await settle();
    expect(durable?.[0]!.label).toBe("First");
    expect(writes.map((entries) => entries[0]!.label)).toEqual(["First", "Second"]);
    completions[1]!.resolve();
    await second;
    await settle();
    expect(durable?.[0]!.label).toBe("Second");
    completions[2]!.resolve();
    await third;
    expect(durable?.[0]!.label).toBe("Newest");
    expect(running).toBe(0);
    expect(maximumRunning).toBe(1);
  });

  it("reports each failure and lets queued and explicit later saves proceed without retries", async () => {
    const completions: ReturnType<typeof deferred>[] = [];
    const attempts: string[] = [];
    let durable: AnnotationPreset[] | undefined;
    installStorage(async () => ({}), async (entries) => {
      const snapshot = entries["ui.annotationPresets"]!;
      const completion = deferred();
      completions.push(completion);
      attempts.push(snapshot[0]!.label);
      await completion.promise;
      durable = snapshot;
    });
    const failure = new Error("storage quota exceeded");
    const first = saveAnnotationPresets(preset("Failed"));
    const firstResult = first.catch((cause: unknown) => cause);
    const second = saveAnnotationPresets(preset("Newest"));
    await settle();
    completions[0]!.reject(failure);
    expect(await firstResult).toBe(failure);
    await settle();
    expect(durable).toBeUndefined();
    expect(attempts).toEqual(["Failed", "Newest"]);
    completions[1]!.resolve();
    await second;
    await settle();
    expect(durable?.[0]!.label).toBe("Newest");
    expect(attempts).toEqual(["Failed", "Newest"]);
    const retry = saveAnnotationPresets(preset("Retry"));
    await settle();
    completions[2]!.resolve();
    await retry;
    expect(durable?.[0]!.label).toBe("Retry");
  });

  it("handles ignored synchronous write failures and invalid requests without poisoning the queue", async () => {
    let attempts = 0;
    let durable: AnnotationPreset[] | undefined;
    installStorage(async () => ({}), (entries) => {
      attempts += 1;
      if (attempts === 1) throw new Error("extension unavailable");
      durable = entries["ui.annotationPresets"];
      return Promise.resolve();
    });
    void saveAnnotationPresets(preset("Ignored failure"));
    void saveAnnotationPresets([]);
    await settle();
    expect(attempts).toBe(1);
    await saveAnnotationPresets(preset("Explicit retry"));
    expect(durable?.[0]!.label).toBe("Explicit retry");
    expect(attempts).toBe(2);
  });
});

describe("annotation preset shortcuts", () => {
  const shortcut = { code: "Digit1", altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, isComposing: false, repeat: false };

  it.each([["Digit1", 0], ["Digit2", 1], ["Digit3", 2], ["Digit4", 3], ["Digit5", 4]])("maps %s to its preset position", (code, want) => {
    expect(presetIndexFromKey({ ...shortcut, code })).toBe(want);
  });

  it.each([
    { altKey: false }, { shiftKey: false }, { ctrlKey: true }, { metaKey: true },
    { isComposing: true }, { repeat: true }, { code: "Digit0" }, { code: "Digit6" },
    { code: "Numpad1" }, { code: "KeyA" },
  ])("ignores browser and composing shortcut variant %#", (patch) => {
    expect(presetIndexFromKey({ ...shortcut, ...patch })).toBeUndefined();
  });
});
