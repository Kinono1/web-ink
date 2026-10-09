import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePdfReadingPosition,
  createPdfReadingPositionWriter,
  readPdfReadingPosition,
  restorePdfReadingPosition,
  type PdfReadingPosition,
} from "../src/pdf/reading-position";
import { PageLayoutIndex } from "../src/pdf/layout";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function position(pageNumber = 1): PdfReadingPosition {
  return {
    version: 1,
    pageNumber,
    pageOffsetRatio: 0.25,
    zoom: 1.5,
    rotation: 90,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installStorage(
  values: Record<string, unknown> = {},
  set: (entries: Record<string, unknown>) => Promise<void> = async (entries) => {
    Object.assign(values, entries);
  },
) {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: values[key] }),
          set,
        },
      },
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("PDF reading positions", () => {
  it("reads only a complete, bounded record at the exact hash key", async () => {
    const key = `ui.pdfReadingPosition.${HASH_A}`;
    const valid = position(7);
    installStorage({
      [key]: valid,
      [`ui.pdfReadingPosition.${HASH_B}`]: {
        ...valid,
        pageNumber: 0,
      },
    });

    await expect(readPdfReadingPosition(HASH_A)).resolves.toEqual(valid);
    await expect(readPdfReadingPosition(HASH_B)).resolves.toBeUndefined();
    await expect(readPdfReadingPosition("not-a-document-hash")).resolves.toBeUndefined();
  });

  it("round-trips against the actual page height and clamps a gap to the page end", () => {
    const layout = new PageLayoutIndex();
    layout.reset(2, 100, 20);

    const captured = capturePdfReadingPosition(layout, 110, 1, 0);

    expect(captured).toEqual({
      version: 1,
      pageNumber: 1,
      pageOffsetRatio: 1,
      zoom: 1,
      rotation: 0,
    });
    expect(restorePdfReadingPosition(layout, captured)).toBe(100);
  });

  it("keeps zero-height pages finite without inventing a position", () => {
    const layout = new PageLayoutIndex();
    layout.reset(1, 0, 20);

    const captured = capturePdfReadingPosition(layout, 0, 1, 0);

    expect(captured).toEqual({
      version: 1,
      pageNumber: 1,
      pageOffsetRatio: 0,
      zoom: 1,
      rotation: 0,
    });
    expect(restorePdfReadingPosition(layout, captured)).toBe(0);
  });

  it("saves a validated snapshot only after 500ms of idle time", async () => {
    vi.useFakeTimers();
    const set = vi.fn(async () => undefined);
    installStorage({}, set);
    const writer = createPdfReadingPositionWriter(HASH_A);

    writer.save(position());
    writer.save({ ...position(), zoom: 0 });
    await vi.advanceTimersByTimeAsync(499);
    expect(set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      [`ui.pdfReadingPosition.${HASH_A}`]: position(),
    });
    await writer.flush();
  });

  it("serializes A/B/C and writes only the latest pending record", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const second = deferred<void>();
    const completions = [first, second];
    const writes: Record<string, unknown>[] = [];
    installStorage({}, (entries) => {
      writes.push(entries);
      return completions[writes.length - 1]!.promise;
    });
    const writer = createPdfReadingPositionWriter(HASH_A);

    writer.save(position(1));
    await vi.advanceTimersByTimeAsync(500);
    writer.save(position(2));
    writer.save(position(3));
    expect(writes).toEqual([
      { [`ui.pdfReadingPosition.${HASH_A}`]: position(1) },
    ]);

    first.resolve();
    await vi.runAllTicks();
    expect(writes).toEqual([
      { [`ui.pdfReadingPosition.${HASH_A}`]: position(1) },
      { [`ui.pdfReadingPosition.${HASH_A}`]: position(3) },
    ]);
    second.resolve();
    await writer.flush();
  });

  it("flushes a pending idle record and waits for its in-flight write", async () => {
    vi.useFakeTimers();
    const completion = deferred<void>();
    const set = vi.fn(() => completion.promise);
    installStorage({}, set);
    const writer = createPdfReadingPositionWriter(HASH_A);

    writer.save(position());
    const flushed = writer.flush();
    expect(set).toHaveBeenCalledTimes(1);
    let settled = false;
    void flushed.then(() => {
      settled = true;
    });
    await vi.runAllTicks();
    expect(settled).toBe(false);

    completion.resolve();
    await expect(flushed).resolves.toBeUndefined();
  });

  it("drops a failed record, then persists a newer record without retrying the failure", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const second = deferred<void>();
    const writes: Record<string, unknown>[] = [];
    installStorage({}, (entries) => {
      writes.push(entries);
      return [first, second][writes.length - 1]!.promise;
    });
    const writer = createPdfReadingPositionWriter(HASH_A);

    writer.save(position(1));
    await vi.advanceTimersByTimeAsync(500);
    writer.save(position(2));
    first.reject(new Error("storage unavailable"));
    await vi.runAllTicks();
    expect(writes).toEqual([
      { [`ui.pdfReadingPosition.${HASH_A}`]: position(1) },
      { [`ui.pdfReadingPosition.${HASH_A}`]: position(2) },
    ]);

    second.resolve();
    await expect(writer.flush()).resolves.toBeUndefined();
  });

  it("keeps writers isolated by document hash", async () => {
    vi.useFakeTimers();
    const writes: Record<string, unknown>[] = [];
    installStorage({}, async (entries) => {
      writes.push(entries);
    });
    const writerA = createPdfReadingPositionWriter(HASH_A);
    const writerB = createPdfReadingPositionWriter(HASH_B);

    writerA.save(position(1));
    writerB.save(position(2));
    await vi.advanceTimersByTimeAsync(500);

    expect(writes).toEqual([
      { [`ui.pdfReadingPosition.${HASH_A}`]: position(1) },
      { [`ui.pdfReadingPosition.${HASH_B}`]: position(2) },
    ]);
  });

  it("dispose clears timers and never sends a queued later snapshot", async () => {
    vi.useFakeTimers();
    const completion = deferred<void>();
    const writes: Record<string, unknown>[] = [];
    installStorage({}, (entries) => {
      writes.push(entries);
      return completion.promise;
    });
    const writer = createPdfReadingPositionWriter(HASH_A);

    writer.save(position(1));
    await vi.advanceTimersByTimeAsync(500);
    writer.save(position(2));
    writer.dispose();
    completion.resolve();
    await vi.runAllTicks();
    writer.save(position(3));
    await vi.advanceTimersByTimeAsync(500);

    expect(writes).toEqual([
      { [`ui.pdfReadingPosition.${HASH_A}`]: position(1) },
    ]);
  });

  it("dispose drops an idle snapshot before storage is called", async () => {
    vi.useFakeTimers();
    const set = vi.fn(async () => undefined);
    installStorage({}, set);
    const writer = createPdfReadingPositionWriter(HASH_A);

    writer.save(position());
    writer.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(set).not.toHaveBeenCalled();
  });
});
