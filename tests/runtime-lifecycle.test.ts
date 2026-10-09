import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBootstrap } from '../src/content/bootstrap';
import { startEngine } from '../src/content/controller';
import { createView } from '../src/content/view-lite';
import { DEFAULT_SETTINGS } from '../src/core/model';

const HEALTH = { generation: 'generation-a', version: '0.3.2', commit: 'a'.repeat(40), dirty: false };
const NEXT_HEALTH = { ...HEALTH, generation: 'generation-b' };
type Listener = (message: { type: string }, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown;
let listeners: Set<Listener>;
let messages: Array<{ type: string; enabled?: boolean }>;
let disposers: Array<() => void>;
let removeListener: ReturnType<typeof vi.fn>;
let modeEnabled: boolean;
let frames: Map<number, FrameRequestCallback>;
let observers: Array<{ disconnected: boolean }>;

beforeEach(() => {
  listeners = new Set(); messages = []; disposers = []; frames = new Map(); observers = []; modeEnabled = false;
  window.history.replaceState(null, '', '/runtime-page');
  vi.stubGlobal('innerWidth', 1200); vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = frames.size + 1; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    disconnected = false;
    constructor() { observers.push(this); }
    observe() {} unobserve() {} disconnect() { this.disconnected = true; }
  });
  removeListener = vi.fn((listener: Listener) => listeners.delete(listener));
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'web-ink-test',
      sendMessage: async (message: { type: string; enabled?: boolean }) => {
        messages.push(message);
        if (message.type === 'runtime.health') return { ok: true, data: HEALTH };
        if (message.type === 'settings.get') return { ok: true, data: DEFAULT_SETTINGS };
        if (message.type === 'page.mode.put') modeEnabled = message.enabled!;
        if (message.type.startsWith('page.mode.')) return { ok: true, data: { enabled: modeEnabled } };
        if (message.type === 'annotations.list') return { ok: true, data: [] };
        return { ok: true, data: true };
      },
      onMessage: { addListener: (listener: Listener) => listeners.add(listener), removeListener },
    },
    storage: { local: { get: async () => ({ 'ui.palettePosition': { x: .5, y: .5 } }), set: async () => {} } },
  });
  vi.stubGlobal('defineContentScript', (definition: unknown) => definition);
  vi.stubGlobal('defineUnlistedScript', (definition: unknown) => definition);
});

afterEach(() => {
  removeListener.mockImplementation((listener: Listener) => listeners.delete(listener));
  for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
  try { window.__webInkEngine?.stop(); } catch {}
  try { window.__webInkBootstrap?.dispose(); } catch {}
  delete window.__webInkEngine; delete window.__webInkBootstrap;
  document.querySelectorAll('web-ink-ui, style[data-web-ink]').forEach(node => node.remove());
  document.body.replaceChildren();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

function bootstrap(health = HEALTH) {
  disposers.push(startBootstrap(health));
  return window.__webInkBootstrap!;
}
const idle = () => vi.waitFor(() => expect(window.__webInkBootstrap?.view.root.querySelector<HTMLButtonElement>('.web-ink-palette-toggle')?.disabled).toBe(false));

describe('content runtime generations', () => {
  it('replaces an old bootstrap and force-stops its engine while retaining saved mode and palette position', async () => {
    modeEnabled = true;
    const old = bootstrap();
    await vi.waitFor(() => expect(old.isEnabled()).toBe(true));
    let stopped = false;
    window.__webInkEngine = {
      generation: HEALTH.generation,
      start: () => {}, stop: () => { stopped = true; }, canStop: () => false,
      dispatch: () => {}, snapshot: () => ({ pageUrl: location.href, states: [], enabled: true }),
    };
    const next = bootstrap(NEXT_HEALTH);
    expect(next).not.toBe(old);
    expect(stopped).toBe(true);
    expect(old.view.host.isConnected).toBe(false);
    expect(document.querySelectorAll('web-ink-ui')).toHaveLength(1);
    await vi.waitFor(() => expect(next.isEnabled()).toBe(true));
    const button = next.view.root.querySelector<HTMLButtonElement>('.web-ink-palette-toggle')!;
    expect([button.style.left, button.style.top]).toEqual(['580px', '430px']);
    expect(messages.filter(message => message.type === 'page.mode.put')).toHaveLength(0);
    expect(next.health).toEqual(NEXT_HEALTH);
  });

  it('keeps same-generation duplicate injection idempotent and its disposer cannot stop the owner', async () => {
    const first = bootstrap();
    await idle();
    const duplicate = startBootstrap(HEALTH);
    duplicate();
    expect(window.__webInkBootstrap).toBe(first);
    expect(document.querySelectorAll('web-ink-ui')).toHaveLength(1);
    expect(listeners.size).toBe(1);
    expect(first.health.generation).toBe(HEALTH.generation);
  });

  it('finishes own invalid-runtime cleanup even when the old Chrome listener API throws', async () => {
    const owner = bootstrap();
    await idle();
    removeListener.mockImplementation(() => { throw Error('Extension context invalidated.'); });
    expect(() => owner.dispose()).not.toThrow();
    expect(window.__webInkBootstrap).toBeUndefined();
    expect(owner.view.host.isConnected).toBe(false);
    expect(frames.size).toBe(0);
    const count = messages.length;
    window.dispatchEvent(new PopStateEvent('popstate'));
    await Promise.resolve();
    expect(messages).toHaveLength(count);
  });

  it('recovers from a legacy disposer throwing after marking itself disposed without duplicate mode writes', async () => {
    const view = createView();
    let disposed = false, stopped = false;
    const legacyButton = document.createElement('button');
    legacyButton.addEventListener('click', () => {
      if (!disposed) void chrome.runtime.sendMessage({ type: 'page.mode.put', pageUrl: location.href, enabled: true });
    });
    view.root.append(legacyButton);
    window.__webInkBootstrap = { view, isEnabled: () => true, dispose: () => { disposed = true; throw Error('Extension context invalidated.'); } } as unknown as typeof window.__webInkBootstrap;
    const marker = document.createElement('style'); marker.dataset.webInk = 'true'; document.head.append(marker);
    window.__webInkEngine = { start: () => {}, stop: () => { stopped = true; throw Error('Extension context invalidated.'); }, canStop: () => false, dispatch: () => {}, snapshot: () => ({ pageUrl: location.href, states: [], enabled: true }) } as unknown as typeof window.__webInkEngine;
    bootstrap();
    await idle();
    expect(disposed).toBe(true); expect(stopped).toBe(true);
    expect(view.host.isConnected).toBe(false); expect(marker.isConnected).toBe(false);
    expect(document.querySelectorAll('web-ink-ui')).toHaveLength(1);
    legacyButton.click();
    window.__webInkBootstrap!.view.root.querySelector<HTMLButtonElement>('.web-ink-palette-toggle')!.click();
    await vi.waitFor(() => expect(messages.filter(message => message.type === 'page.mode.put')).toHaveLength(1));
  });

  it('ignores an old bootstrap request rejection after its replacement is enabled', async () => {
    const send = chrome.runtime.sendMessage;
    let reject!: (cause: Error) => void;
    let first = true;
    chrome.runtime.sendMessage = ((message: { type: string }) => {
      if (first && message.type === 'settings.get') {
        first = false;
        return new Promise((_resolve, fail) => { reject = fail; });
      }
      return send(message);
    }) as typeof send;
    const old = bootstrap();
    modeEnabled = true;
    const next = bootstrap(NEXT_HEALTH);
    await vi.waitFor(() => expect(next.isEnabled()).toBe(true));
    let stopped = false;
    window.__webInkEngine = { generation: NEXT_HEALTH.generation, start: () => {}, stop: () => { stopped = true; }, canStop: () => true, dispatch: () => {}, snapshot: () => ({ pageUrl: location.href, states: [], enabled: true }) };
    reject(Error('Extension context invalidated.'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(next).not.toBe(old); expect(next.isEnabled()).toBe(true); expect(stopped).toBe(false);
  });

  it('cannot restore a pending mode response after permissions have been revoked', async () => {
    modeEnabled = true;
    const send = chrome.runtime.sendMessage;
    let resolve!: (value: unknown) => void;
    chrome.runtime.sendMessage = ((message: { type: string }) => message.type === 'settings.get'
      ? new Promise<unknown>(done => { resolve = done; }) : send(message)) as typeof send;
    const owner = bootstrap();
    for (const listener of listeners) listener({ type: 'permissions.revoked' }, {}, () => {});
    resolve({ ok: true, data: DEFAULT_SETTINGS });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(owner.isEnabled()).toBe(false);
    expect(owner.view.root.querySelector<HTMLButtonElement>('.web-ink-palette-toggle')!.dataset.blocked).toBe('true');
    expect(messages.filter(message => message.type === 'engine.ensure')).toHaveLength(0);
  });
});

describe('async content entry', () => {
  it('does not create UI until health arrives and cannot revive after invalidation while health is pending', async () => {
    let resolve!: (value: unknown) => void;
    chrome.runtime.sendMessage = vi.fn(() => new Promise(done => { resolve = done; })) as typeof chrome.runtime.sendMessage;
    let invalidate!: () => void;
    const entry = (await import('../entrypoints/content')).default;
    entry.main({ onInvalidated: (callback: () => void) => { invalidate = callback; } } as NonNullable<Parameters<typeof entry.main>[0]>);
    expect(document.querySelector('web-ink-ui')).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'runtime.health' });
    invalidate();
    resolve({ ok: true, data: HEALTH });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(window.__webInkBootstrap).toBeUndefined();
    expect(document.querySelector('web-ink-ui')).toBeNull();
  });

  it('retains the live singleton through real WXT duplicate invalidation and cleans it when Chrome becomes invalid', async () => {
    vi.resetModules();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { ContentScriptContext } = await import('wxt/utils/content-script-context');
    const entry = (await import('../entrypoints/content')).default;
    const first = new ContentScriptContext('content', { noScriptStartedPostMessage: true });
    disposers.push(() => first.notifyInvalidated());
    entry.main(first);
    await idle();
    const owner = window.__webInkBootstrap;
    const second = new ContentScriptContext('content', { noScriptStartedPostMessage: true });
    disposers.push(() => second.notifyInvalidated());
    entry.main(second);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(window.__webInkBootstrap).toBe(owner);
    expect(document.querySelectorAll('web-ink-ui')).toHaveLength(1);
    Object.defineProperty(chrome.runtime, 'id', { value: undefined });
    second.notifyInvalidated();
    expect(window.__webInkBootstrap).toBeUndefined();
    expect(document.querySelector('web-ink-ui')).toBeNull();
  });
});

describe('engine bridge ownership', () => {
  it('never reuses a stale bridge closure and duplicate engine injection owns only one running engine', async () => {
    modeEnabled = true;
    bootstrap(NEXT_HEALTH);
    await vi.waitFor(() => expect(window.__webInkBootstrap!.isEnabled()).toBe(true));
    let stopped = false;
    const stale = { generation: HEALTH.generation, start: () => { throw Error('stale closure called'); }, stop: () => { stopped = true; }, canStop: () => false, dispatch: () => {}, snapshot: () => ({ pageUrl: location.href, states: [], enabled: true }) };
    window.__webInkEngine = stale;
    const entry = (await import('../entrypoints/engine')).default;
    expect(() => entry.main()).not.toThrow();
    expect(stopped).toBe(true);
    expect(window.__webInkEngine).not.toBe(stale);
    expect(window.__webInkEngine?.generation).toBe(NEXT_HEALTH.generation);
    const owned = window.__webInkEngine;
    entry.main();
    expect(window.__webInkEngine).toBe(owned);
    expect(document.querySelectorAll('style[data-web-ink]')).toHaveLength(1);
  });

  it('does not retain an engine bridge or load controller resources on a closed page', async () => {
    bootstrap(); await idle();
    const entry = (await import('../entrypoints/engine')).default;
    entry.main();
    expect(window.__webInkEngine).toBeUndefined();
    expect(document.querySelector('style[data-web-ink]')).toBeNull();
    expect(observers).toHaveLength(0);
    expect(messages.filter(message => message.type === 'annotations.list')).toHaveLength(0);
  });

  it('ignores mutating bridge calls from an abandoned legacy handler without a generation token', async () => {
    modeEnabled = true;
    const owner = bootstrap();
    await vi.waitFor(() => expect(owner.isEnabled()).toBe(true));
    const entry = (await import('../entrypoints/engine')).default;
    entry.main();
    await vi.waitFor(() => expect(window.__webInkEngine?.snapshot().enabled).toBe(true));
    const legacyRoute = () => window.__webInkEngine?.stop();
    window.addEventListener('popstate', legacyRoute);
    try {
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(document.querySelectorAll('style[data-web-ink]')).toHaveLength(1);
      expect(window.__webInkEngine?.snapshot().enabled).toBe(true);
      window.__webInkEngine?.dispatch('draw');
      expect(owner.view.drawing.style.display).not.toBe('flex');
    } finally {
      window.removeEventListener('popstate', legacyRoute);
    }
  });

  it('clears controller markers, observer work and pending frames when Chrome removeListener throws', async () => {
    modeEnabled = true;
    const owner = bootstrap();
    await vi.waitFor(() => expect(owner.isEnabled()).toBe(true));
    const engine = startEngine(owner.view); disposers.push(engine.stop);
    await vi.waitFor(() => expect(engine.snapshot().enabled).toBe(true));
    window.dispatchEvent(new Event('resize'));
    expect(frames.size).toBeGreaterThan(0);
    removeListener.mockImplementation(() => { throw Error('Extension context invalidated.'); });
    expect(() => engine.stop()).not.toThrow();
    expect(document.querySelector('style[data-web-ink]')).toBeNull();
    expect(observers.every(observer => observer.disconnected)).toBe(true);
    expect(frames.size).toBe(0);
    expect(engine.snapshot().enabled).toBe(false);
    const count = messages.length;
    window.dispatchEvent(new Event('resize'));
    await Promise.resolve();
    expect(messages).toHaveLength(count); expect(frames.size).toBe(0);
  });

  it('releases controller resources if Chrome becomes invalid while registering the engine listener', async () => {
    modeEnabled = true;
    const owner = bootstrap();
    await vi.waitFor(() => expect(owner.isEnabled()).toBe(true));
    chrome.runtime.onMessage.addListener = () => { throw Error('Extension context invalidated.'); };
    expect(() => startEngine(owner.view)).toThrow('Extension context invalidated.');
    expect(document.querySelector('style[data-web-ink]')).toBeNull();
    expect(observers.every(observer => observer.disconnected)).toBe(true);
    window.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(0);
  });

  it('cancels and settles a large restoration yield when the engine stops', async () => {
    vi.useFakeTimers(); modeEnabled = true;
    const owner = bootstrap();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: { type: string }) => {
      if (message.type === 'annotations.list') return Promise.resolve({ ok: true, data: Array.from({ length: 21 }, (_, i) => ({ id: `annotation-${i}`, kind: 'text', pageUrl: location.href, revision: 1, color: '#facc15', target: { exact: 'text' } })) });
      return send(message);
    }) as typeof send;
    const engine = startEngine(owner.view); disposers.push(engine.stop);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    engine.stop();
    expect(vi.getTimerCount()).toBe(0);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('style[data-web-ink]')).toBeNull();
  });
});
