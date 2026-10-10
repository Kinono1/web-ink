import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectPdfSidebar } from "../src/pdf/sidebar-connection";

type Listener<T> = (value: T) => void;

class TestEvent<T> {
  readonly listeners = new Set<Listener<T>>();
  addListener = (listener: Listener<T>) => this.listeners.add(listener);
  removeListener = (listener: Listener<T>) => this.listeners.delete(listener);
  emit(value: T) {
    for (const listener of [...this.listeners]) listener(value);
  }
}

class TestPort {
  readonly onMessage = new TestEvent<unknown>();
  readonly onDisconnect = new TestEvent<void>();
  readonly postMessage = vi.fn();
  readonly disconnect = vi.fn(() => this.onDisconnect.emit());
}

const invalidated = () => Error("Extension context invalidated.");
let ports: TestPort[];
let connect: ReturnType<typeof vi.fn>;
let runtimeInvalid = false;
let lastErrorInvalid = false;

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  ports = [];
  runtimeInvalid = false;
  lastErrorInvalid = false;
  connect = vi.fn(() => {
    const port = new TestPort();
    ports.push(port);
    return port;
  });
  vi.stubGlobal("chrome", {
    runtime: {
      get id() {
        if (runtimeInvalid) throw invalidated();
        return "web-ink-test";
      },
      get lastError() {
        if (lastErrorInvalid) throw invalidated();
        return undefined;
      },
      connect,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PDF sidebar connection lifecycle", () => {
  it("stops cleanly when the runtime ID becomes invalid before its initial connection", async () => {
    runtimeInvalid = true;
    const received: unknown[] = [];
    const connection = connectPdfSidebar("web-ink-pdf-reader", (message) => received.push(message), vi.fn());

    await flushMicrotasks();

    expect(connect).not.toHaveBeenCalled();
    expect(received).toEqual([{ type: "unavailable" }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => connection.dispose()).not.toThrow();
  });

  it("does not reconnect after runtime.connect reports an invalidated context", async () => {
    connect.mockImplementationOnce(() => {
      throw invalidated();
    });
    const received: unknown[] = [];
    connectPdfSidebar("web-ink-pdf-reader", (message) => received.push(message), vi.fn());

    await flushMicrotasks();

    expect(received).toEqual([{ type: "unavailable" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes invalidated disconnect cleanup without retrying an old context", async () => {
    const received: unknown[] = [];
    const connection = connectPdfSidebar("web-ink-pdf-reader", (message) => received.push(message), vi.fn());
    await flushMicrotasks();
    const first = ports[0]!;

    lastErrorInvalid = true;
    first.onMessage.removeListener = vi.fn(() => {
      throw invalidated();
    });

    expect(() => first.onDisconnect.emit()).not.toThrow();
    expect(received).toEqual([{ type: "unavailable" }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => connection.dispose()).not.toThrow();
  });

  it("disposes an invalidated port even when both cleanup calls throw", async () => {
    const connection = connectPdfSidebar("web-ink-pdf-reader", vi.fn(), vi.fn());
    await flushMicrotasks();
    const first = ports[0]!;
    first.onMessage.removeListener = vi.fn(() => {
      throw invalidated();
    });
    first.disconnect.mockImplementation(() => {
      throw invalidated();
    });

    expect(() => connection.dispose()).not.toThrow();
    expect(first.onMessage.removeListener).toHaveBeenCalledTimes(1);
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not turn an unrelated port failure into an unavailable reconnect", async () => {
    const received: unknown[] = [];
    const connection = connectPdfSidebar("web-ink-pdf-reader", (message) => received.push(message), vi.fn());
    await flushMicrotasks();
    ports[0]!.postMessage.mockImplementation(() => {
      throw Error("unexpected port failure");
    });

    expect(() => connection.send({ type: "state" })).toThrow("unexpected port failure");
    expect(received).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconnects after an ordinary disconnect and ignores a late disconnect from the old port", async () => {
    const received: unknown[] = [];
    const connected = vi.fn();
    const connection = connectPdfSidebar("web-ink-pdf-reader", (message) => received.push(message), connected);
    await flushMicrotasks();
    const first = ports[0]!;

    first.onDisconnect.emit();
    expect(received).toEqual([{ type: "unavailable" }]);
    vi.advanceTimersByTime(1_000);
    const second = ports[1]!;
    expect(connected).toHaveBeenCalledTimes(2);

    first.onDisconnect.emit();
    expect(vi.getTimerCount()).toBe(0);
    connection.send({ type: "state" });
    expect(second.postMessage).toHaveBeenCalledWith({ type: "state" });
  });
});
