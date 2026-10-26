import { vi } from "vitest";

/** Focused promise-based fixture APIs. Add an explicit route for runtime work;
 * unhandled messages reject rather than silently passing a product test. */
export function createMockEvent<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => unknown>();
  return {
    addListener: vi.fn((listener: (...args: Args) => unknown) => { listeners.add(listener); }),
    removeListener: vi.fn((listener: (...args: Args) => unknown) => { listeners.delete(listener); }),
    hasListener: (listener: (...args: Args) => unknown) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    emit: (...args: Args) => { for (const listener of [...listeners]) listener(...args); },
  };
}

export function createChromeMock(options: {
  local?: Record<string, unknown>;
  session?: Record<string, unknown>;
  sendMessage?: (message: unknown) => unknown | Promise<unknown>;
  tabs?: Array<Partial<chrome.tabs.Tab>>;
} = {}) {
  const changes = createMockEvent<[Record<string, chrome.storage.StorageChange>, string]>();
  const area = (name: string, initial: Record<string, unknown> = {}) => {
    const values = structuredClone(initial);
    return {
      get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
        await Promise.resolve();
        const result = keys && !Array.isArray(keys) && typeof keys === "object" ? { ...keys } : {};
        for (const key of keys == null ? Object.keys(values) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys))
          if (Object.hasOwn(values, key)) result[key] = values[key];
        return structuredClone(result);
      }),
      set: vi.fn(async (entries: Record<string, unknown>) => {
        await Promise.resolve();
        const changed: Record<string, chrome.storage.StorageChange> = {};
        for (const [key, value] of Object.entries(structuredClone(entries))) {
          changed[key] = { oldValue: values[key], newValue: value };
          values[key] = value;
        }
        changes.emit(changed, name);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        await Promise.resolve();
        const changed: Record<string, chrome.storage.StorageChange> = {};
        for (const key of typeof keys === "string" ? [keys] : keys) {
          if (!Object.hasOwn(values, key)) continue;
          changed[key] = { oldValue: values[key] };
          delete values[key];
        }
        changes.emit(changed, name);
      }),
    };
  };
  return {
    storage: { local: area("local", options.local), session: area("session", options.session), onChanged: changes },
    runtime: {
      getURL: (name: string) => `chrome-extension://test/${name.replace(/^\//, "")}`,
      sendMessage: vi.fn(async (message: unknown) => {
        if (!options.sendMessage) throw Error("No runtime message handler configured for this fixture");
        return options.sendMessage(message);
      }),
      onMessage: createMockEvent<[unknown, Partial<chrome.runtime.MessageSender>, (response: unknown) => void]>(),
    },
    tabs: {
      query: vi.fn(async () => structuredClone(options.tabs ?? [])),
      onActivated: createMockEvent<[chrome.tabs.OnActivatedInfo]>(),
      onUpdated: createMockEvent<[number, chrome.tabs.OnUpdatedInfo, Partial<chrome.tabs.Tab>]>(),
    },
  };
}
