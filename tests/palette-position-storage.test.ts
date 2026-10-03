import { describe, expect, it, vi } from "vitest";
import type { PalettePosition } from "../src/content/palette-position";
import { createPalettePositionWriter } from "../src/content/palette-position-storage";

function position(x: number, y: number): PalettePosition {
  return { x, y };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushSettledWrites(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("palette position storage", () => {
  it("serializes writes and persists only the latest pending snapshot", async () => {
    const writes: PalettePosition[] = [];
    const completions: ReturnType<typeof deferred<void>>[] = [];
    const durable: { current?: PalettePosition } = {};
    let runningWrites = 0;
    let maximumRunningWrites = 0;

    const writer = createPalettePositionWriter((snapshot) => {
      const completion = deferred<void>();
      writes.push(snapshot);
      completions.push(completion);
      runningWrites += 1;
      maximumRunningWrites = Math.max(maximumRunningWrites, runningWrites);
      return completion.promise
        .then(() => {
          durable.current = snapshot;
        })
        .finally(() => {
          runningWrites -= 1;
        });
    });

    const first = position(0.1, 0.2);
    writer.save(first);
    expect(writes).toEqual([{ x: 0.1, y: 0.2 }]);
    expect(durable.current).toBeUndefined();

    first.x = 0.9;
    writer.save(position(0.4, 0.5));
    writer.save(position(0.8, 0.7));
    expect(writes).toEqual([{ x: 0.1, y: 0.2 }]);

    completions[0]!.resolve(undefined);
    await flushSettledWrites();

    expect(writes).toEqual([
      { x: 0.1, y: 0.2 },
      { x: 0.8, y: 0.7 },
    ]);
    expect(durable.current).toEqual({ x: 0.1, y: 0.2 });
    expect(runningWrites).toBe(1);
    expect(maximumRunningWrites).toBe(1);

    completions[1]!.resolve(undefined);
    await flushSettledWrites();

    expect(durable.current).toEqual({ x: 0.8, y: 0.7 });
    expect(runningWrites).toBe(0);
    expect(maximumRunningWrites).toBe(1);
    writer.dispose();
  });

  it("reports a failed write safely and drains the latest pending snapshot", async () => {
    const writes: PalettePosition[] = [];
    const completions: ReturnType<typeof deferred<void>>[] = [];
    const errors: unknown[] = [];
    const durable: { current?: PalettePosition } = {};
    const failure = new Error("storage unavailable");

    const writer = createPalettePositionWriter(
      (snapshot) => {
        const completion = deferred<void>();
        writes.push(snapshot);
        completions.push(completion);
        return completion.promise.then(() => {
          durable.current = snapshot;
        });
      },
      (cause) => {
        errors.push(cause);
        throw new Error("error handler failed");
      },
    );

    writer.save(position(0.1, 0.2));
    writer.save(position(0.4, 0.5));
    writer.save(position(0.8, 0.7));
    expect(completions).toHaveLength(1);
    completions[0]!.reject(failure);
    await flushSettledWrites();

    expect(errors).toEqual([failure]);
    expect(writes).toEqual([
      { x: 0.1, y: 0.2 },
      { x: 0.8, y: 0.7 },
    ]);
    expect(durable.current).toBeUndefined();

    completions[1]!.resolve(undefined);
    await flushSettledWrites();

    expect(durable.current).toEqual({ x: 0.8, y: 0.7 });
    writer.dispose();
  });

  it("does not retry a failed newest snapshot until the next save", async () => {
    const attempts: number[] = [];
    const errors: unknown[] = [];
    const writer = createPalettePositionWriter(
      async (snapshot) => {
        attempts.push(snapshot.x);
        if (attempts.length === 1) throw new Error("storage unavailable");
      },
      (cause) => errors.push(cause),
    );

    writer.save(position(0.1, 0.2));
    await flushSettledWrites();
    expect(attempts).toEqual([0.1]);
    expect(errors).toHaveLength(1);

    writer.save(position(0.4, 0.5));
    await flushSettledWrites();
    expect(attempts).toEqual([0.1, 0.4]);
    writer.dispose();
  });

  it("drains an accepted pending position after dispose but ignores future saves", async () => {
    const writes: PalettePosition[] = [];
    const completions: ReturnType<typeof deferred<void>>[] = [];
    const durable: { current?: PalettePosition } = {};
    const writer = createPalettePositionWriter((snapshot) => {
      const completion = deferred<void>();
      completions.push(completion);
      writes.push(snapshot);
      return completion.promise.then(() => {
        durable.current = snapshot;
      });
    });

    writer.save(position(0.1, 0.2));
    expect(writes).toEqual([{ x: 0.1, y: 0.2 }]);
    writer.save(position(0.4, 0.5));
    writer.dispose();
    writer.save(position(0.8, 0.7));
    completions[0]!.resolve(undefined);
    await flushSettledWrites();

    expect(writes).toEqual([{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }]);
    completions[1]!.resolve(undefined);
    await flushSettledWrites();
    expect(durable.current).toEqual({ x: 0.4, y: 0.5 });
  });

  it("suppresses the error callback when an in-flight write fails after dispose", async () => {
    const completion = deferred<void>();
    const onError = vi.fn();
    let dispatched = false;
    const writer = createPalettePositionWriter(() => {
      dispatched = true;
      return completion.promise;
    }, onError);

    writer.save(position(0.1, 0.2));
    expect(dispatched).toBe(true);
    writer.dispose();
    completion.reject(new Error("storage unavailable"));
    await flushSettledWrites();

    expect(onError).not.toHaveBeenCalled();
  });
});
