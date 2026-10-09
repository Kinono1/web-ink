import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeHealth } from '../src/core/model';

const BUILD = { version: '0.3.2', commit: 'b'.repeat(40), dirty: false };
const SESSION_KEY = 'ui.runtimeGeneration';
type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown;
let onMessage: MessageListener;
let session: Record<string, unknown>;
let writes: Array<Record<string, unknown>>;
let injections: unknown[];
let permissionChanges: Array<() => void>;
let granted: boolean;

beforeEach(() => {
  session = {}; writes = []; injections = []; permissionChanges = []; granted = true;
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
      get: async (key: string) => ({ [key]: session[key] }),
      set: async (value: Record<string, unknown>) => { writes.push(value); Object.assign(session, value); },
    } },
    permissions: {
      contains: async () => granted,
      onAdded: { addListener: (listener: () => void) => permissionChanges.push(listener) },
      onRemoved: { addListener: (listener: () => void) => permissionChanges.push(listener) },
    },
    scripting: {
      getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {},
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
    expect(writes).toEqual([{ [SESSION_KEY]: first.data?.generation }]);
  });

  it('reinjects authorized supported tabs once per new lifecycle and reuses the generation across worker wakes', async () => {
    await wakeWorker();
    const first = await health();
    await vi.waitFor(() => expect(injections).toEqual([{ target: { tabId: 7 }, files: ['content-scripts/content.js'] }]));
    await wakeWorker();
    const second = await health();
    await Promise.resolve(); await Promise.resolve();
    expect(second.data?.generation).toBe(first.data?.generation);
    expect(injections).toHaveLength(1); expect(writes).toHaveLength(1);
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
});
