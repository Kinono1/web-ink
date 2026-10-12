import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIeeePreparation } from '../src/background/ieee-preparation';
import { installIeeePreparation } from '../src/content/ieee-prepare';

function event<T>() {
  const listeners = new Set<(item: T) => void>();
  return { addListener: (fn: (item: T) => void) => listeners.add(fn), removeListener: (fn: (item: T) => void) => listeners.delete(fn),
    emit: (item: T) => { for (const listener of listeners) listener(item); } };
}
describe('source-origin IEEE preparation', () => {
  const pageUrl = 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123';
  const sourceUrl = 'https://ieeexplore.ieee.org/paper.pdf?ticket=private-fixture';
  const bytes = new TextEncoder().encode('%PDF-1.7\nPrepared in the original source document\n');
  let broker: ReturnType<typeof createIeeePreparation>;
  let dispose: () => void;
  let fetches: string[];
  let allowed: boolean;
  beforeEach(() => {
    fetches = []; allowed = true;
    const onConnect = event<chrome.runtime.Port>();
    vi.stubGlobal('location', { href: pageUrl, origin: 'https://ieeexplore.ieee.org' });
    vi.stubGlobal('chrome', {
      runtime: { id: 'fixture', onConnect, sendMessage: async (m: { type: string }) => m.type === 'runtime.health'
        ? { ok: true, data: { generation: 'generation' } } : undefined },
      scripting: { executeScript: async () => [] },
      tabs: { sendMessage: async () => undefined, connect: (_id: number, options: { name: string }) => {
        const outgoing = event<unknown>(), incoming = event<unknown>();
        const backgroundClosed = event<chrome.runtime.Port>(), sourceClosed = event<chrome.runtime.Port>();
        let disconnected = false;
        const close = (sourceSide: boolean) => { if (!disconnected) { disconnected = true; (sourceSide ? backgroundClosed : sourceClosed).emit(background); } };
        const background = { name: options.name, onMessage: incoming, onDisconnect: backgroundClosed,
          postMessage: (m: unknown) => queueMicrotask(() => { if (!disconnected) outgoing.emit(m); }), disconnect: () => close(false) } as unknown as chrome.runtime.Port;
        const source = { name: options.name, sender: { id: 'fixture' }, onMessage: outgoing, onDisconnect: sourceClosed,
          postMessage: (m: unknown) => queueMicrotask(() => { if (!disconnected) incoming.emit(m); }), disconnect: () => close(true) } as unknown as chrome.runtime.Port;
        onConnect.emit(source);
        return background;
      } },
    });
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      fetches.push(url.href);
      expect(options.credentials).toBe('include');
      expect(options.mode).toBe('same-origin');
      expect(options.redirect).toBe('follow');
      return allowed ? new Response(bytes, { headers: { 'content-type': 'application/pdf' } }) : new Response('Access denied', { status: 403 });
    });
    dispose = installIeeePreparation();
    broker = createIeeePreparation(async () => 'generation');
  });
  afterEach(async () => { vi.useRealTimers(); broker.releaseTab(7); (await broker.getStore()).dispose(); dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('prepares once, checks the source before success, and exposes bytes only to the replacement reader', async () => {
    let checks = 0;
    const info = await broker.prepare(7, 'source-document', pageUrl, sourceUrl, async () => { checks++; });
    expect(checks).toBe(3);
    expect(fetches).toEqual([sourceUrl]);
    expect(info.byteLength).toBe(bytes.length);
    const store = await broker.getStore();
    const reader = { tabId: 7, documentId: 'reader-document', generation: 'generation' };
    expect(store.claim(info.token, reader).hash).toMatch(/^[a-f0-9]{64}$/);
    expect(new TextDecoder().decode(Uint8Array.from(atob(store.chunk(info.token, reader, 0)), c => c.charCodeAt(0))))
      .toBe('%PDF-1.7\nPrepared in the original source document\n');
  });
  it('a late expired task closes only its own source port, not the replacement task', async () => {
    vi.useFakeTimers();
    const timeouts: Array<() => void> = [];
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      if (delay === 60_000 && String(callback).includes('inactive')) timeouts.push(callback);
      return schedule(callback, delay);
    }) as typeof setTimeout);
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', async (_url: URL, options: RequestInit) => {
      signals.push(options.signal as AbortSignal);
      return new Response(new ReadableStream<Uint8Array>({ start() {} }));
    });
    const a = broker.prepare(7, 'source-a', pageUrl, sourceUrl, async () => {}).catch(error => error);
    for (let index = 0; index < 50; index++) await Promise.resolve();
    const staleTimeout = timeouts.at(-1)!;
    expect(staleTimeout).toBeDefined();
    vi.setSystemTime(Date.now() + 60_001);
    expect((await broker.getStore()).peekToken(7)).toBeUndefined();
    const b = broker.prepare(8, 'source-b', pageUrl, sourceUrl, async () => {}).catch(error => error);
    for (let index = 0; index < 50; index++) await Promise.resolve();
    expect(signals).toHaveLength(2);
    staleTimeout();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect((await broker.getStore()).peekToken(8)).toBeDefined();
    expect(await a).toBeInstanceOf(Error);
    broker.cancelTab(8); await b;
    vi.restoreAllMocks();
  });
  it('accepts an active source download that lasts beyond one minute', async () => {
    vi.useFakeTimers();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } })));
    const task = broker.prepare(7, 'source-document', pageUrl, sourceUrl, async () => {});
    const caught = task.catch(error => error);
    for (let index = 0; index < 50; index++) await Promise.resolve();
    expect(body).toBeDefined();
    body!.enqueue(bytes.subarray(0, 10));
    await vi.advanceTimersByTimeAsync(40_000);
    body!.enqueue(bytes.subarray(10, 20));
    await vi.advanceTimersByTimeAsync(40_000);
    body!.enqueue(bytes.subarray(20)); body!.close();
    expect(await caught).toMatchObject({ byteLength: bytes.length });
  });
  it('does not let waiting heartbeats keep an inactive download alive', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({ start() {} })));
    const task = broker.prepare(7, 'source-document', pageUrl, sourceUrl, async () => {});
    const caught = task.catch(error => error);
    for (let index = 0; index < 50; index++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await caught).toMatchObject({ message: expect.stringMatching(/timed out|inactive/i) });
    expect((await broker.getStore()).peekToken(7)).toBeUndefined();
  });
  it('prepares a browser-owned direct IEEE PDF without injecting into the viewer', async () => {
    const source = 'https://ieeexplore.ieee.org/authorized.pdf?ticket=private-fixture';
    const script = vi.fn(async () => { throw Error('Protected native viewer'); });
    chrome.scripting.executeScript = script as typeof chrome.scripting.executeScript;
    chrome.permissions = { contains: async () => true } as unknown as typeof chrome.permissions;
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      expect(url.href).toBe(source);
      expect(options.credentials).toBe('include');
      expect(options.redirect).toBe('error');
      expect(options.mode).toBeUndefined();
      return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
    });
    let checks = 0;
    const info = await broker.prepareDirect(7, source, async () => { checks++; });
    expect(checks).toBe(2);
    expect(script).not.toHaveBeenCalled();
    expect(info.byteLength).toBe(bytes.length);
    expect((await broker.getStore()).peekToken(7)).toBe(info.token);
  });
  it('rejects an arbitrary direct-source URL without requesting it', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(broker.prepareDirect(7, 'https://other.test/file.pdf', async () => {})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels a protected direct read and releases the one slot', async () => {
    chrome.permissions = { contains: async () => true } as unknown as typeof chrome.permissions;
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: URL, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    });
    const task = broker.prepareDirect(7, 'https://ieeexplore.ieee.org/paper.pdf', async () => {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    broker.cancelTab(7);
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal!.aborted).toBe(true);
    expect((await broker.getStore()).peekToken(7)).toBeUndefined();
  });
  it('reports a denied source with safe HTTP diagnostics instead of creating a reader', async () => {
    allowed = false;
    const failure = await broker.prepare(7, 'source-document', pageUrl, sourceUrl, async () => {}).catch(e => e);
    expect(failure).toMatchObject({ reason: 'access-restricted', diagnostic: { phase: 'file', status: 403 } });
    expect(JSON.stringify(failure.diagnostic)).not.toContain('ticket');
    expect((await broker.getStore()).peekToken(7)).toBeUndefined();
  });
  it('removes signed URLs from Chrome setup errors', async () => {
    chrome.scripting.executeScript = (async () => { throw Error('Cannot access https://ieeexplore.ieee.org/paper.pdf?ticket=private-fixture'); }) as typeof chrome.scripting.executeScript;
    const failure = await broker.prepare(7, 'source-document', pageUrl, sourceUrl, async () => {}).catch(e => e);
    expect(failure).toMatchObject({ reason: 'network', diagnostic: { phase: 'identify' } });
    expect(failure.message).not.toContain('ticket');
    expect(JSON.stringify(failure)).not.toContain('private-fixture');
    expect(fetches).toEqual([]);
  });
  it('cancels a waiting read and rejects a late result without retaining bytes', async () => {
    let finish: (() => void) | undefined;
    vi.stubGlobal('fetch', async () => { await new Promise<void>(resolve => { finish = resolve; }); return new Response(bytes); });
    const task = broker.prepare(7, 'source-document', pageUrl, sourceUrl, async () => {});
    await vi.waitFor(() => expect(finish).toBeDefined());
    broker.cancelTab(7);
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    finish!();
    expect((await broker.getStore()).peekToken(7)).toBeUndefined();
  });
  it('immediately aborts a source request when its local content script is disposed', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: URL, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    });
    const task = broker.prepare(7, 'source-document', pageUrl, sourceUrl, async () => {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    dispose();
    expect(signal!.aborted).toBe(true);
    await expect(task).rejects.toThrow(/connection closed/i);
  });
});
