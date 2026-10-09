import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeHealth } from '../src/core/model';

const BUILD = { version: '0.3.2', commit: 'b'.repeat(40), dirty: false };
const SESSION_KEY = 'ui.runtimeGeneration';
const REGISTRATION_KEY = 'ui.runtimeRegisteredGeneration';
type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown;
let onMessage: MessageListener;
let session: Record<string, unknown>;
let writes: Array<Record<string, unknown>>;
let injections: unknown[];
let permissionChanges: Array<() => void>;
let granted: boolean;
let registrationAttempts: number;
let registerScript: () => Promise<void>;

beforeEach(() => {
  session = {}; writes = []; injections = []; permissionChanges = []; granted = true;
  registrationAttempts = 0; registerScript = async () => {};
  const event = () => ({ addListener: () => {} });
  vi.stubGlobal('defineBackground', (main: () => void) => ({ main }));
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => BUILD }));
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'web-ink-id', getURL: (path: string) => `chrome-extension://web-ink-id/${path}`,
      getManifest: () => ({ version: BUILD.version }),
      onMessage: { addListener: (listener: MessageListener) => { onMessage = listener; } },
      onInstalled: event(), onStartup: event(), sendMessage: async () => {},
    },
    storage: { session: {
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, session[key]])),
      set: async (value: Record<string, unknown>) => { writes.push(value); Object.assign(session, value); },
      remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key]; },
    } },
    permissions: {
      contains: async () => granted,
      onAdded: { addListener: (listener: () => void) => permissionChanges.push(listener) },
      onRemoved: { addListener: (listener: () => void) => permissionChanges.push(listener) },
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => { registrationAttempts++; await registerScript(); },
      unregisterContentScripts: async () => {},
      executeScript: async (injection: unknown) => { injections.push(injection); return []; },
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://example.test/page' }, { id: 8, url: 'chrome://extensions' }, { id: 9, url: 'file:///private.pdf' }],
      sendMessage: async () => {}, onRemoved: event(), onUpdated: event(),
      reload: () => { throw Error('Tab reload is forbidden'); }, update: () => { throw Error('Tab navigation is forbidden'); },
    },
    sidePanel: { setPanelBehavior: async () => {} },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function wakeWorker() {
  vi.resetModules();
  (await import('../entrypoints/background')).default.main();
}
function health(sender: chrome.runtime.MessageSender = { id: 'web-ink-id', url: 'chrome-extension://web-ink-id/sidepanel.html' }) {
  return new Promise<{ ok: boolean; data?: RuntimeHealth; error?: string }>(resolve => {
    expect(onMessage({ type: 'runtime.health' }, sender, value => resolve(value as { ok: boolean; data?: RuntimeHealth; error?: string }))).toBe(true);
  });
}

describe('background runtime lifecycle', () => {
  it('serves health before annotation data work and stores one UUID for concurrent requests', async () => {
    await wakeWorker();
    const [first, second] = await Promise.all([health(), health()]);
    expect(first.ok).toBe(true); expect(first.data).toEqual(second.data);
    expect(first.data).toMatchObject(BUILD);
    expect(first.data?.generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(writes.filter(write => SESSION_KEY in write)).toEqual([{ [SESSION_KEY]: first.data?.generation }]);
  });

  it('reinjects authorized supported tabs once per new lifecycle and reuses the generation across worker wakes', async () => {
    await wakeWorker();
    const first = await health();
    await vi.waitFor(() => expect(injections).toEqual([{ target: { tabId: 7 }, files: ['content-scripts/content.js'] }]));
    await vi.waitFor(() => expect(session[REGISTRATION_KEY]).toBe(first.data?.generation));
    await wakeWorker();
    const second = await health();
    await Promise.resolve(); await Promise.resolve();
    expect(second.data?.generation).toBe(first.data?.generation);
    expect(injections).toHaveLength(1); expect(writes.filter(write => SESSION_KEY in write)).toHaveLength(1);
    session = {};
    await wakeWorker();
    const reloaded = await health();
    expect(reloaded.data?.generation).not.toBe(first.data?.generation);
    await vi.waitFor(() => expect(injections).toHaveLength(2));
  });

  it('does not inject without host authorization but restores registration when permissions change', async () => {
    granted = false;
    await wakeWorker();
    expect((await health()).ok).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(injections).toHaveLength(0);
    granted = true;
    permissionChanges[0]!();
    await vi.waitFor(() => expect(injections).toHaveLength(1));
  });

  it('does not expose health to a foreign extension', async () => {
    await wakeWorker();
    expect((await health({ id: 'foreign-extension', url: 'https://example.test/' })).ok).toBe(false);
  });

  it('retries failed lifecycle registration on the next worker wake with the same generation', async () => {
    registerScript = async () => { if (registrationAttempts === 1) throw Error('Registration temporarily unavailable'); };
    await wakeWorker();
    const first = await health();
    await vi.waitFor(() => expect(registrationAttempts).toBe(1));
    expect(injections).toHaveLength(0); expect(session[REGISTRATION_KEY]).toBeUndefined();
    await wakeWorker();
    const second = await health();
    expect(second.data?.generation).toBe(first.data?.generation);
    await vi.waitFor(() => expect(injections).toHaveLength(1));
    await vi.waitFor(() => expect(session[REGISTRATION_KEY]).toBe(first.data?.generation));
    await wakeWorker();
    expect((await health()).data?.generation).toBe(first.data?.generation);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(registrationAttempts).toBe(2); expect(injections).toHaveLength(1);
    expect(writes.filter(write => SESSION_KEY in write)).toHaveLength(1);
  });

  it('acknowledges permissions recovery so a later worker wake does not reinject', async () => {
    registerScript = async () => { if (registrationAttempts === 1) throw Error('Registration temporarily unavailable'); };
    await wakeWorker();
    const first = await health();
    await vi.waitFor(() => expect(registrationAttempts).toBe(1));
    const recovered = await new Promise<{ ok: boolean; data?: boolean }>(resolve => {
      onMessage({ type: 'permissions.enable' }, { id: 'web-ink-id', url: 'chrome-extension://web-ink-id/sidepanel.html' }, value => resolve(value as { ok: boolean; data?: boolean }));
    });
    expect(recovered).toEqual({ ok: true, data: true });
    expect(session[REGISTRATION_KEY]).toBe(first.data?.generation);
    expect(injections).toHaveLength(1);
    await wakeWorker();
    expect((await health()).data?.generation).toBe(first.data?.generation);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(registrationAttempts).toBe(2); expect(injections).toHaveLength(1);
  });

  it('serves health while reinjection waits for health and only acknowledges the completed registration', async () => {
    let finishInjection!: () => void;
    chrome.scripting.executeScript = (async (injection: unknown) => {
      expect((await health()).ok).toBe(true);
      injections.push(injection);
      await new Promise<void>(resolve => { finishInjection = resolve; });
      return [];
    }) as typeof chrome.scripting.executeScript;
    await wakeWorker();
    const first = await health();
    expect(first.ok).toBe(true);
    await vi.waitFor(() => expect(injections).toHaveLength(1));
    expect(session[REGISTRATION_KEY]).toBeUndefined();
    finishInjection();
    await vi.waitFor(() => expect(session[REGISTRATION_KEY]).toBe(first.data?.generation));
  });

  it('invalidates an earlier registration acknowledgement when a new serialized registration fails', async () => {
    const generation = '12345678-1234-4123-8123-123456789abc';
    session = { [SESSION_KEY]: generation, [REGISTRATION_KEY]: generation };
    registerScript = async () => { if (registrationAttempts === 1) throw Error('Registration temporarily unavailable'); };
    await wakeWorker();
    expect((await health()).data?.generation).toBe(generation);
    const failed = await new Promise<{ ok: boolean }>(resolve => {
      onMessage({ type: 'permissions.enable' }, { id: 'web-ink-id', url: 'chrome-extension://web-ink-id/sidepanel.html' }, value => resolve(value as { ok: boolean }));
    });
    expect(failed.ok).toBe(false);
    expect(session[REGISTRATION_KEY]).toBeUndefined();
    await wakeWorker();
    expect((await health()).data?.generation).toBe(generation);
    await vi.waitFor(() => expect(injections).toHaveLength(1));
    await vi.waitFor(() => expect(session[REGISTRATION_KEY]).toBe(generation));
  });
});
