import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageContextError } from '../src/background/content-page';
import { WebInkDatabase, setDatabaseForTesting } from '../src/background/database';
import { createMessageRouter, type PageState, type RouterDeps } from '../src/background/router';
import type { Annotation, Result } from '../src/core/model';

const EXTENSION = 'chrome-extension://web-ink-id/';
const page = 'https://example.test/article';
const extensionPage = { id: 'web-ink-id', url: `${EXTENSION}sidepanel.html` } as chrome.runtime.MessageSender;
const content = (url = page) => ({ id: 'web-ink-id', url, frameId: 0, tab: { id: 7 } as chrome.tabs.Tab, documentId: 'doc-1' }) as chrome.runtime.MessageSender;

let db: WebInkDatabase;
let local: Record<string, unknown>;
let tabMessages: Array<[number, unknown]>;
let injections: unknown[];
let broadcasts: Array<[object, string | undefined]>;
let pageStates: Map<number, PageState>;
let deps: RouterDeps;

function annotation(id = 'one', revision = 0): Annotation {
  return {
    id, pageUrl: page, pageTitle: 'Article', color: '#facc15', note: '', tags: [],
    createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', revision, kind: 'text',
    target: { exact: 'hello', prefix: '', suffix: '', start: 0, end: 5, rootSelector: 'article' },
  };
}

beforeEach(() => {
  db = new WebInkDatabase(`web-ink-router-${crypto.randomUUID()}`);
  setDatabaseForTesting(db);
  local = {}; tabMessages = []; injections = []; broadcasts = [];
  pageStates = new Map();
  vi.stubGlobal('chrome', {
    runtime: { id: 'web-ink-id', getURL: (path: string) => `${EXTENSION}${path}`, sendMessage: async () => undefined },
    tabs: { sendMessage: async (tabId: number, message: unknown) => { tabMessages.push([tabId, message]); return undefined; } },
    scripting: { executeScript: async (injection: unknown) => { injections.push(injection); return []; } },
    storage: { local: {
      get: async (key: string | null) => (key === null ? { ...local } : { [key]: local[key] }),
      set: async (value: Record<string, unknown>) => { Object.assign(local, value); },
      remove: async (keys: string[]) => { for (const key of keys) delete local[key]; },
    } },
  });
  deps = {
    runtimeHealth: Promise.resolve({ generation: 'gen', version: '1.0.0', commit: 'c', dirty: false }),
    register: async () => true,
    resolveContentPage: async (sender) => sender.url!,
    handleFloatingAction: async () => ({ ok: true, data: 'floating' }),
    handlePdfRequest: async () => ({ ok: true, data: 'pdf' }),
    broadcast: async (message, pageUrl) => { broadcasts.push([message, pageUrl]); },
    pageStates,
  };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  setDatabaseForTesting(undefined);
  db.close();
  await db.delete();
});

const send = (message: unknown, sender: chrome.runtime.MessageSender) =>
  createMessageRouter(deps)(message, sender) as Promise<Result<unknown>>;

describe('message router', () => {
  it('leaves non-requests and worker notifications unanswered', () => {
    const route = createMessageRouter(deps);
    for (const message of [null, 'text', {}, { type: 1 }, { type: 'annotations.changed' }, { type: 'permissions.revoked' },
      { type: 'permissions.restored' }, { type: 'page.action.execute' }])
      expect(route(message, extensionPage)).toBeUndefined();
  });

  it('serves health only to this extension', async () => {
    expect(await send({ type: 'runtime.health' }, content())).toMatchObject({ ok: true, data: { generation: 'gen' } });
    expect(await send({ type: 'runtime.health' }, { id: 'other' })).toEqual({ ok: false, error: 'Not allowed' });
  });

  it('delegates floating-action and PDF requests', async () => {
    expect(await send({ type: 'ui.open' }, content())).toEqual({ ok: true, data: 'floating' });
    expect(await send({ type: 'pdf.handoff.get' }, content())).toEqual({ ok: true, data: 'pdf' });
  });

  it('refuses trusted-only routes from content scripts', async () => {
    for (const message of [{ type: 'permissions.enable' }, { type: 'page.state.get', tabId: 7 },
      { type: 'page.action', tabId: 7, action: 'focus' }])
      expect(await send(message, content())).toEqual({ ok: false, error: 'Not allowed' });
    expect(tabMessages).toEqual([]);
  });

  it('refuses a content script that names another page', async () => {
    const result = await send({ type: 'annotations.list', pageUrl: 'https://other.test/' }, content());
    expect(result).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
  });

  it('reports a page that changed while the request was in flight', async () => {
    deps.resolveContentPage = async () => { throw new PageContextError(); };
    expect(await send({ type: 'annotations.list', pageUrl: page }, content())).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
  });

  it('does not let a content script delete the library', async () => {
    expect(await send({ type: 'library.clear' }, content())).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(broadcasts).toEqual([]);
  });

  describe('engine.ensure', () => {
    it('is only for content scripts', async () => {
      expect(await send({ type: 'engine.ensure' }, extensionPage)).toEqual({ ok: false, error: 'Invalid engine request' });
    });

    it('does not inject on a page that is off', async () => {
      expect(await send({ type: 'engine.ensure' }, content())).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect(injections).toEqual([]);
    });

    it('injects into the sending document when the page is on', async () => {
      await send({ type: 'page.mode.put', pageUrl: page, enabled: true }, extensionPage);
      expect(await send({ type: 'engine.ensure' }, content())).toEqual({ ok: true, data: true });
      expect(injections).toEqual([{ target: { tabId: 7, documentIds: ['doc-1'] }, files: ['engine.js'], world: 'ISOLATED' }]);
    });
  });

  it('stores bounded, valid page states for the sending tab', async () => {
    const states = [
      { id: 'x'.repeat(300), status: 'located' },
      { id: 'bad', status: 'exploded' },
      { id: 'kept', status: 'unresolved', reason: 'r'.repeat(600) },
    ];
    expect(await send({ type: 'page.states', pageUrl: page, states }, content())).toEqual({ ok: true, data: true });
    const stored = pageStates.get(7)!;
    expect(stored.states.map((s) => s.id)).toEqual(['x'.repeat(200), 'kept']);
    expect(stored.states[1]?.reason).toHaveLength(500);
    expect(await send({ type: 'page.states', pageUrl: page, states: 'nope' }, content()))
      .toEqual({ ok: false, error: 'Invalid page state' });
  });

  it('falls back to cached state when the tab does not answer', async () => {
    pageStates.set(7, { pageUrl: page, states: [] });
    expect(await send({ type: 'page.state.get', tabId: 7 }, extensionPage)).toEqual({ ok: true, data: { pageUrl: page, states: [] } });
  });

  it('validates page actions before messaging the tab', async () => {
    expect(await send({ type: 'page.action', tabId: 7, action: 'draw' }, extensionPage)).toEqual({ ok: false, error: 'Invalid page action' });
    expect(await send({ type: 'page.action', tabId: 7, action: 'focus', id: 'a' }, extensionPage)).toEqual({ ok: true, data: true });
    expect(tabMessages).toEqual([[7, { type: 'page.action.execute', action: 'focus', id: 'a' }]]);
  });

  it('broadcasts successful writes to matching pages only', async () => {
    const put = await send({ type: 'annotations.put', annotation: annotation(), expectedRevision: 0 }, content());
    expect(put.ok).toBe(true);
    await send({ type: 'annotations.delete', id: 'one', expectedRevision: 1 }, content());
    await send({ type: 'annotations.delete', id: 'one', expectedRevision: 1 }, content());
    await send({ type: 'library.clear' }, extensionPage);
    expect(broadcasts).toEqual([
      [{ type: 'annotations.changed', pageUrl: page, annotation: { ...annotation(), revision: 1 } }, page],
      [{ type: 'annotations.changed', pageUrl: page, deletedId: 'one' }, page],
      [{ type: 'annotations.changed' }, undefined],
    ]);
  });
});
