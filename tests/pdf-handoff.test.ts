import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfHandoff, PdfOpenResult, PdfTabContext, Result } from '../src/core/model';

const ID = 'webinkid';
const READER = `chrome-extension://${ID}/pdf.html`;
const ORIGINAL = 'https://papers.example.test/paper.pdf#page=3';
const UI: chrome.runtime.MessageSender = { id: ID, url: `chrome-extension://${ID}/sidepanel.html`, documentId: 'sidebar-document', documentLifecycle: 'active' };
type Listener = (raw: unknown, sender: chrome.runtime.MessageSender, respond: (response: unknown) => void) => unknown;
let listener: Listener;
let tabs: Map<number, chrome.tabs.Tab>;
let contexts: chrome.runtime.ExtensionContext[];
let session: Record<string, unknown>;
let updates: Array<{ tabId: number; url?: string }>;
let created: string[];
let onUpdated: Array<(tabId: number, info: { url?: string; status?: string }) => void>;
let onActivated: Array<(info: { tabId: number; windowId: number }) => void>;
let documentId: string;
let failStorage: boolean;
let failUpdate: boolean;
let afterWrite: (() => void | Promise<void>) | undefined;
let afterRead: (() => void | Promise<void>) | undefined;

const event = () => ({ addListener: () => {} });
function context(tabId: number, url: string, doc: string, contextType: 'TAB' | 'SIDE_PANEL' = 'TAB'): chrome.runtime.ExtensionContext {
  return { contextId: `context-${doc}`, contextType, documentId: doc, documentUrl: url, documentOrigin: `chrome-extension://${ID}`, frameId: contextType === 'SIDE_PANEL' ? -1 : 0, tabId, windowId: 1, incognito: false };
}
function setUrl(url: string, doc = 'source-document') {
  documentId = doc;
  tabs.set(7, { ...tabs.get(7), id: 7, url, active: true, windowId: 1 } as chrome.tabs.Tab);
  vi.stubGlobal('location', { href: url });
  // The real browser document resolves relative attributes from its actual URL.
  const base = document.createElement('base');
  base.href = url;
  document.head.replaceChildren(base);
}
function loadedReader(tabId: number, url: string, doc = `reader-${tabId}`) {
  tabs.set(tabId, { ...tabs.get(tabId), id: tabId, url, windowId: 1, active: true } as chrome.tabs.Tab);
  contexts = contexts.filter(entry => entry.tabId !== tabId);
  contexts.push(context(tabId, url, doc));
}
function readerSender(tabId = 7): chrome.runtime.MessageSender {
  const found = contexts.find(entry => entry.tabId === tabId)!;
  // Reader tab identity must work from getContexts even without MessageSender.tab.
  return { id: ID, url: found.documentUrl, documentId: found.documentId, frameId: 0, documentLifecycle: 'active' };
}
function hideOwnTabUrls() {
  const originalGet = chrome.tabs.get;
  chrome.tabs.get = (async (tabId: number) => {
    const tab = await originalGet(tabId);
    if (tab.url?.startsWith(`chrome-extension://${ID}/`)) delete tab.url;
    return tab;
  }) as typeof chrome.tabs.get;
}
function visibleEmbeds(html: string) {
  document.body.innerHTML = html;
  for (const element of document.querySelectorAll<HTMLElement>('iframe,embed,object'))
    element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, toJSON: () => ({}) });
}
const handoffs = () => Object.entries(session).filter(([key]) => key.startsWith('pdf.handoff.'));
async function rpc<T>(message: object, sender = UI): Promise<Result<T>> {
  return new Promise(resolve => { expect(listener(message, sender, response => resolve(response as Result<T>))).toBe(true); });
}
function value<T>(response: Result<T>): T {
  expect(response.ok).toBe(true);
  if (!response.ok) throw Error(response.error);
  return response.data;
}
const inspect = () => rpc<PdfTabContext>({ type: 'pdf.context.get', tabId: 7, expectedUrl: tabs.get(7)!.url });
const open = (extra: object = {}) => rpc<PdfOpenResult>({ type: 'pdf.openCurrent', tabId: 7, expectedUrl: tabs.get(7)!.url, ...extra });

beforeEach(async () => {
  tabs = new Map(); contexts = [context(-1, UI.url!, UI.documentId!, 'SIDE_PANEL')];
  session = {}; updates = []; created = []; onUpdated = []; onActivated = []; failStorage = false; failUpdate = false; afterWrite = undefined; afterRead = undefined;
  document.body.replaceChildren(); setUrl(ORIGINAL);
  vi.stubGlobal('defineBackground', (main: () => void) => ({ main }));
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: '0.3.2', commit: 'a'.repeat(40), dirty: false }) }));
  vi.stubGlobal('chrome', {
    runtime: {
      id: ID, getURL: (path: string) => `chrome-extension://${ID}/${path.replace(/^\//, '')}`,
      getManifest: () => ({ version: '0.3.2' }), onInstalled: event(), sendMessage: async () => {},
      onMessage: { addListener: (next: Listener) => { listener = next; } },
      getContexts: async (filter: chrome.runtime.ContextFilter) => contexts.filter(entry =>
        (!filter.documentIds || filter.documentIds.includes(entry.documentId!)) &&
        (!filter.documentUrls || filter.documentUrls.includes(entry.documentUrl!)) &&
        (!filter.contextIds || filter.contextIds.includes(entry.contextId)) &&
        (!filter.contextTypes || filter.contextTypes.includes(entry.contextType)) &&
        (!filter.tabIds || filter.tabIds.includes(entry.tabId))),
    },
    storage: { session: {
      get: async (keys: string | string[]) => {
        const result = Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, session[key]]));
        if (typeof keys === 'string' && keys.startsWith('pdf.handoff.')) await afterRead?.();
        return result;
      },
      set: async (data: Record<string, unknown>) => {
        const navigation = Object.keys(data).some(key => key.startsWith('pdf.handoff.'));
        if (navigation && failStorage) throw Error('Session storage unavailable');
        Object.assign(session, structuredClone(data));
        if (navigation) await afterWrite?.();
      },
      remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key]; },
    } },
    permissions: { contains: async () => false, onAdded: event(), onRemoved: event() },
    scripting: {
      getRegisteredContentScripts: async () => [], unregisterContentScripts: async () => {},
      executeScript: async (options: { target: { tabId: number; documentIds?: string[] }; func?: (...args: unknown[]) => unknown }) => {
        if (!options.func) return [];
        if (options.target.tabId !== 7 || (options.target.documentIds && !options.target.documentIds.includes(documentId))) throw Error('Document was replaced');
        if (tabs.get(7)!.url!.startsWith('chrome-extension:')) throw Error('Protected viewer DOM must not be read');
        // Serialization catches references to module closures inside the Chrome probe.
        const probe = new Function(`return (${options.func.toString()})`)() as () => unknown;
        return [{ frameId: 0, documentId, result: probe() }];
      },
    },
    tabs: {
      get: async (tabId: number) => { if (!tabs.has(tabId)) throw Error('Tab closed'); return { ...tabs.get(tabId) }; },
      query: async (filter: { active?: boolean; windowId?: number }) => [...tabs.values()].filter(tab => (!filter.active || tab.active) && (filter.windowId === undefined || tab.windowId === filter.windowId)),
      update: async (tabId: number, change: { url?: string }) => {
        if (failUpdate) throw Error('Navigation denied');
        updates.push({ tabId, ...change });
        if (change.url) {
          if (change.url.startsWith(READER)) {
            expect(handoffs()).toHaveLength(1);
            loadedReader(tabId, change.url);
          } else { tabs.set(tabId, { ...tabs.get(tabId), url: change.url } as chrome.tabs.Tab); contexts = contexts.filter(entry => entry.tabId !== tabId); }
        }
        return tabs.get(tabId);
      },
      create: async ({ url }: { url: string }) => { created.push(url); loadedReader(9, url); return tabs.get(9); },
      onUpdated: { addListener: (next: typeof onUpdated[number]) => onUpdated.push(next) }, onRemoved: event(),
      onActivated: { addListener: (next: typeof onActivated[number]) => onActivated.push(next) },
    },
    sidePanel: { setPanelBehavior: async () => {} },
  });
  vi.resetModules(); (await import('../entrypoints/background')).default.main();
});

describe('native extension UI authority', () => {
  it.each([
    ['document present, frame absent', UI.documentId, undefined],
    ['document present, frame -1', UI.documentId, -1],
    ['document absent, frame absent', undefined, undefined],
    ['document absent, frame -1', undefined, -1],
  ] as const)('accepts native sidebar metadata: %s', async (_label, senderDocumentId, frameId) => {
    const sender = { ...UI, documentId: senderDocumentId, frameId };
    expect(value(await rpc<PdfTabContext>({ type: 'pdf.context.get', tabId: 7 }, sender))).toMatchObject({ tabId: 7, kind: 'direct' });
    expect(value(await rpc<PdfOpenResult>({ type: 'pdf.openCurrent', tabId: 7, expectedUrl: ORIGINAL }, sender))).toMatchObject({ tabId: 7, navigation: 'same-tab' });
    expect(updates).toHaveLength(1);
  });

  it('rejects ambiguous sidebar URLs across windows when sender documentId is absent', async () => {
    contexts.push({ ...context(-1, UI.url!, 'second-sidebar', 'SIDE_PANEL'), windowId: 2 });
    expect(await rpc({ type: 'pdf.openCurrent', tabId: 7 }, { ...UI, documentId: undefined })).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0); expect(handoffs()).toHaveLength(0);
  });

  it.each(['documentId', 'contextId'] as const)('rejects a native sidebar without browser %s', async field => {
    contexts[0] = { ...contexts[0]!, [field]: undefined } as chrome.runtime.ExtensionContext;
    expect(await rpc({ type: 'pdf.context.get', tabId: 7 }, { ...UI, documentId: undefined })).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0);
  });

  it('matches the complete sender URL when resolving a missing documentId', async () => {
    contexts[0] = { ...contexts[0]!, documentUrl: `${UI.url}?another-view=1` };
    expect(await rpc({ type: 'pdf.context.get', tabId: 7 }, { ...UI, documentId: undefined })).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
  });

  it('rejects unsupported extension UI context kinds', async () => {
    contexts[0] = { ...contexts[0]!, contextType: 'POPUP', frameId: 0 };
    expect(await rpc({ type: 'pdf.openCurrent', tabId: 7 }, UI)).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0);
  });

  it('rejects nested own UI and keeps content callers strict', async () => {
    for (const sender of [
      { ...UI, frameId: 1, documentId: undefined },
      { ...UI, id: 'another-extension', documentId: undefined },
      { ...UI, documentLifecycle: 'cached', documentId: undefined },
      { ...UI, url: ORIGINAL, tab: tabs.get(7), frameId: 0, documentId: undefined },
      { ...UI, url: ORIGINAL, tab: tabs.get(7), frameId: -1, documentId },
    ] satisfies chrome.runtime.MessageSender[]) {
      expect(await rpc({ type: 'pdf.openCurrent', tabId: 7 }, sender)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    contexts[0] = { ...contexts[0]!, frameId: 1 };
    expect(await rpc({ type: 'pdf.openCurrent', tabId: 7 }, { ...UI, documentId: undefined })).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0);
  });

  it.each(['documentId', 'contextId', 'windowId'] as const)('pins native sidebar %s before asynchronous persistence', async field => {
    afterWrite = () => {
      contexts[0] = { ...contexts[0]!, [field]: field === 'windowId' ? 2 : `replacement-${field}` };
    };
    expect(await rpc({ type: 'pdf.openCurrent', tabId: 7, expectedUrl: ORIGINAL }, { ...UI, documentId: undefined })).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0); expect(handoffs()).toHaveLength(0);
    expect(tabs.get(7)!.url).toBe(ORIGINAL);
  });

  it('binds a documentless reader sender to its browser TAB document and token', async () => {
    const opened = value(await open());
    const sender = { ...readerSender(), documentId: undefined };
    expect(value(await rpc<PdfHandoff | null>({ type: 'pdf.handoff.get', token: opened.token }, sender))).toMatchObject({ tabId: 7, returnUrl: ORIGINAL });
    expect(value(await rpc({ type: 'pdf.returnOriginal', token: opened.token }, sender))).toEqual({ tabId: 7, url: ORIGINAL });
  });

  it('rejects a documentless reader replaced during session lookup', async () => {
    const opened = value(await open());
    const sender = { ...readerSender(), documentId: undefined };
    afterRead = () => { loadedReader(7, opened.readerUrl, 'replacement-reader-document'); };
    expect(await rpc({ type: 'pdf.returnOriginal', token: opened.token }, sender)).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(1);
  });
});
afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); vi.unstubAllGlobals(); });

describe('observed PDF sources', () => {
  it('classifies a direct HTTPS PDF without fetching bytes', async () => {
    expect(value(await inspect())).toMatchObject({ tabId: 7, kind: 'direct', currentReader: false, candidates: [{ url: ORIGINAL, via: 'url' }] });
  });

  it.each(['dahenjhkoodjbpjheillcadbppiidmhp/reader.html?url=', 'mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file='])('reads known viewer URL parameters without reading its protected DOM: %s', async viewer => {
    setUrl(`chrome-extension://${viewer}${encodeURIComponent('https://papers.example.test/download?id=8')}`);
    expect(value(await inspect())).toMatchObject({ kind: 'wrapper', candidates: [{ url: 'https://papers.example.test/download?id=8', via: 'viewer' }] });
  });

  it.each([ORIGINAL, `chrome-extension://dahenjhkoodjbpjheillcadbppiidmhp/reader.html?url=${encodeURIComponent(ORIGINAL)}`])('opens a recognized protected PDF from its observed URL even when scripting is denied: %s', async url => {
    setUrl(url);
    const script = vi.fn(async () => { throw Error('Protected PDF document'); });
    chrome.scripting.executeScript = script as typeof chrome.scripting.executeScript;
    expect(value(await open())).toMatchObject({ navigation: 'same-tab', sourceUrl: ORIGINAL });
    expect(script).not.toHaveBeenCalled();
    expect(handoffs()[0]![1]).toMatchObject({ returnUrl: url });
  });

  it.each(['iframe', 'embed', 'object'])('recognizes only visible top-document %s PDF candidates', async tag => {
    setUrl('https://papers.example.test/reading');
    visibleEmbeds(`<${tag} ${tag === 'object' ? 'data' : 'src'}="/public.PDF?id=8" type="application/pdf"></${tag}><embed src="https://papers.example.test/hidden.pdf" type="application/pdf" style="display:none">`);
    expect(value(await inspect())).toMatchObject({ kind: 'embedded', candidates: [{ url: 'https://papers.example.test/public.PDF?id=8', via: tag }] });
  });

  it.each(['iframe', 'embed', 'object'])('uses the actual document base URI for a relative %s source', async tag => {
    const original = 'https://papers.example.test/reading';
    const source = 'https://cdn.example.test/documents/paper.pdf';
    setUrl(original);
    document.head.innerHTML = '<base href="https://cdn.example.test/documents/">';
    visibleEmbeds(`<${tag} ${tag === 'object' ? 'data' : 'src'}="paper.pdf" type="application/pdf"></${tag}>`);
    expect(document.baseURI).toBe('https://cdn.example.test/documents/');
    expect(value(await inspect()).candidates).toEqual([{ url: source, via: tag }]);
    expect(value(await open())).toMatchObject({ navigation: 'same-tab', sourceUrl: source });
    expect(handoffs()[0]![1]).toMatchObject({ returnUrl: original, sourceUrl: source });
  });

  it('does not forward a credentialed source resolved from a document base URI', async () => {
    setUrl('https://papers.example.test/reading');
    document.head.innerHTML = '<base href="https://user:secret@cdn.example.test/documents/">';
    visibleEmbeds('<embed src="paper.pdf" type="application/pdf">');
    expect(value(await inspect())).toMatchObject({ candidates: [], reason: 'unsafe-source' });
    expect(new URL(value(await open()).readerUrl).searchParams.has('source')).toBe(false);
  });

  it('does not invent a different source by truncating an oversized observed URL', async () => {
    setUrl('https://papers.example.test/reading');
    const source = `https://papers.example.test/paper.pdf?padding=${'x'.repeat(9000)}`;
    visibleEmbeds(`<embed type="application/pdf" src="${source}">`);
    expect(value(await inspect()).candidates).toHaveLength(0);
    const opened = value(await open());
    expect(new URL(opened.readerUrl).searchParams.has('source')).toBe(false);
    expect(tabs.get(7)!.url).toBe('https://papers.example.test/reading');
  });

  it('uses the observed IEEE stamp iframe URL without inventing a download endpoint', async () => {
    setUrl('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123');
    visibleEmbeds('<iframe src="/visible-download?document=123"></iframe>');
    expect(value(await inspect())).toMatchObject({ kind: 'wrapper', candidates: [{ url: 'https://ieeexplore.ieee.org/visible-download?document=123', via: 'iframe' }] });
  });

  it('keeps an inaccessible IEEE stamp wrapper classified as manual source fallback', async () => {
    setUrl('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=123');
    chrome.scripting.executeScript = (async () => { throw Error('Permission denied'); }) as typeof chrome.scripting.executeScript;
    expect(value(await inspect())).toMatchObject({ kind: 'wrapper', candidates: [], reason: 'permission-denied' });
  });

  it('leaves an unknown protected page intact and opens a separate manual reader', async () => {
    setUrl('chrome://extensions/');
    chrome.scripting.executeScript = (async () => { throw Error('Protected page'); }) as typeof chrome.scripting.executeScript;
    expect(value(await inspect())).toMatchObject({ kind: 'unavailable', candidates: [], reason: 'permission-denied' });
    expect(value(await open())).toMatchObject({ navigation: 'new-tab', readerUrl: READER });
    expect(tabs.get(7)!.url).toBe('chrome://extensions/');
    expect(updates).toHaveLength(0);
  });

  it('does not take over a normal PDF anchor or explicit non-PDF embed', async () => {
    setUrl('https://papers.example.test/article');
    visibleEmbeds('<a href="/linked.pdf">Download PDF</a><embed src="/not-a-document.pdf" type="text/html">');
    expect(value(await inspect())).toMatchObject({ kind: 'unavailable', candidates: [], reason: 'not-pdf' });
    expect(value(await open())).toMatchObject({ navigation: 'new-tab', readerUrl: READER });
    expect(tabs.get(7)!.url).toBe('https://papers.example.test/article');
    expect(handoffs()).toHaveLength(0);
  });

  it.each(['http://papers.example.test/paper.pdf', 'file:///tmp/public.pdf'])('keeps non-HTTPS PDF %s in a manual local flow', async original => {
    setUrl(original);
    expect(value(await inspect())).toMatchObject({ kind: 'local', candidates: [], reason: 'local-source' });
    const opened = value(await open());
    expect(opened.navigation).toBe('same-tab');
    expect(new URL(opened.readerUrl).searchParams.has('source')).toBe(false);
    expect(value(await rpc<PdfHandoff | null>({ type: 'pdf.handoff.get', token: opened.token }, readerSender()))?.returnUrl).toBe(original);
  });

  it('requires an explicit choice for multiple candidates and rejects unobserved source URLs', async () => {
    setUrl('https://papers.example.test/reading');
    visibleEmbeds('<iframe src="/one.pdf"></iframe><object data="/two.pdf" type="application/pdf"></object>');
    expect(await open()).toMatchObject({ ok: false, code: 'PDF_CHOICE_REQUIRED' });
    expect(await open({ candidateUrl: 'https://papers.example.test/unobserved.pdf' })).toMatchObject({ ok: false, code: 'PDF_SOURCE_UNAVAILABLE' });
    expect(updates).toHaveLength(0);
    const opened = value(await open({ candidateUrl: 'https://papers.example.test/two.pdf' }));
    expect(opened.sourceUrl).toBe('https://papers.example.test/two.pdf');
  });

  it.each(['javascript:alert(1)', 'data:application/pdf;base64,JVBERi0=', 'https://user:secret@papers.example.test/a.pdf'])('never forwards unsafe candidate %s to the reader', async unsafe => {
    setUrl('https://papers.example.test/reading');
    visibleEmbeds(`<embed type="application/pdf" src="${unsafe}">`);
    expect(value(await inspect())).toMatchObject({ candidates: [], reason: 'unsafe-source' });
    expect(await open({ candidateUrl: unsafe })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(updates).toHaveLength(0);
  });
});

describe('same-tab navigation authority', () => {
  it('stores the browser-observed original URL before navigating and never accepts a return URL', async () => {
    expect(await open({ returnUrl: 'https://attacker.test/' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    const opened = value(await open());
    expect(opened).toMatchObject({ tabId: 7, navigation: 'same-tab', sourceUrl: ORIGINAL });
    expect(opened.token).toMatch(/^[0-9a-f-]{36}$/);
    const reader = new URL(opened.readerUrl);
    expect(reader.searchParams.get('handoff')).toBe(opened.token);
    expect(reader.searchParams.get('source')).toBe(ORIGINAL);
    expect(reader.searchParams.get('open')).toBe('1');
    expect(reader.searchParams.has('returnUrl')).toBe(false);
    expect(handoffs()[0]![1]).toMatchObject({ token: opened.token, tabId: 7, returnUrl: ORIGINAL, sourceUrl: ORIGINAL });
    expect(updates).toHaveLength(1);
  });

  it('accepts only the declared fields of each PDF request', async () => {
    expect(await rpc({ type: 'pdf.context.get', tabId: 7, candidateUrl: ORIGINAL })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(updates).toHaveLength(0);
  });

  it('rejects a stale expected URL and a sidebar request for a different active tab', async () => {
    expect(await open({ expectedUrl: 'https://papers.example.test/old.pdf' })).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    tabs.set(7, { ...tabs.get(7), active: false } as chrome.tabs.Tab);
    tabs.set(8, { id: 8, active: true, windowId: 1, url: 'https://papers.example.test/other.pdf' } as chrome.tabs.Tab);
    expect(await open()).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0);
  });

  it('derives content scope from the sending top document and rejects payload tab substitution', async () => {
    const sender: chrome.runtime.MessageSender = { id: ID, url: ORIGINAL, frameId: 0, documentId, documentLifecycle: 'active', tab: tabs.get(7) };
    expect(await rpc({ type: 'pdf.openCurrent', tabId: 8 }, sender)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await rpc({ type: 'pdf.openCurrent' }, { ...sender, frameId: 1 })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await rpc({ type: 'pdf.openCurrent' }, { ...sender, documentId: 'replaced-document' })).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(value(await rpc<PdfOpenResult>({ type: 'pdf.openCurrent' }, sender)).tabId).toBe(7);
  });

  it('rejects same-URL document replacement during session persistence', async () => {
    afterWrite = () => { documentId = 'replacement-document'; for (const callback of onUpdated) callback(7, { status: 'loading' }); };
    expect(await open()).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0); expect(tabs.get(7)!.url).toBe(ORIGINAL);
  });

  it('rechecks the observed HTML document identity before navigating even without a navigation event', async () => {
    setUrl('https://papers.example.test/reading');
    visibleEmbeds('<iframe src="/paper.pdf"></iframe>');
    afterWrite = () => { documentId = 'replacement-document'; };
    expect(await open()).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0);
    expect(handoffs()).toHaveLength(0);
  });

  it('rechecks the active tab after asynchronous session operations', async () => {
    afterWrite = () => {
      tabs.set(7, { ...tabs.get(7), active: false } as chrome.tabs.Tab);
      tabs.set(8, { id: 8, active: true, windowId: 1, url: 'https://papers.example.test/other.pdf' } as chrome.tabs.Tab);
    };
    expect(await open()).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0);
  });

  it('rejects a sidebar caller that moves to another window during session persistence', async () => {
    contexts = [context(40, UI.url!, UI.documentId!, 'TAB')];
    afterWrite = () => { contexts[0] = { ...contexts[0]!, windowId: 2 }; };
    expect(await open()).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(tabs.get(7)!.url).toBe(ORIGINAL);
    expect(updates).toHaveLength(0);
    expect(handoffs()).toHaveLength(0);
  });

  it('rejects an active-tab change during the final asynchronous browser check', async () => {
    afterWrite = () => {
      const originalGet = chrome.tabs.get;
      chrome.tabs.get = (async (tabId: number) => {
        const tab = await originalGet(tabId);
        tabs.set(7, { ...tabs.get(7), active: false } as chrome.tabs.Tab);
        tabs.set(8, { id: 8, active: true, windowId: 1, url: 'https://papers.example.test/other.pdf' } as chrome.tabs.Tab);
        for (const callback of onActivated) callback({ tabId: 8, windowId: 1 });
        return tab;
      }) as typeof chrome.tabs.get;
    };
    expect(await open()).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(0);
    expect(handoffs()).toHaveLength(0);
  });

  it('coalesces a double click into one session and one same-tab navigation', async () => {
    let release!: () => void;
    afterWrite = () => new Promise<void>(resolve => { release = resolve; });
    const first = open(), second = open();
    await vi.waitFor(() => expect(handoffs()).toHaveLength(1));
    release();
    expect(value(await first).token).toBe(value(await second).token);
    expect(updates).toHaveLength(1); expect(handoffs()).toHaveLength(1);
  });

  it('leaves the original untouched when session persistence or navigation fails', async () => {
    failStorage = true;
    expect(await open()).toMatchObject({ ok: false, code: 'STORAGE_UNAVAILABLE' });
    expect(updates).toHaveLength(0); expect(tabs.get(7)!.url).toBe(ORIGINAL);
    failStorage = false; failUpdate = true;
    expect(await open()).toMatchObject({ ok: false, code: 'NAVIGATION_FAILED' });
    expect(tabs.get(7)!.url).toBe(ORIGINAL);
  });

  it('does not reopen the current own reader or discard its session', async () => {
    const first = value(await open());
    const inspected = value(await inspect());
    expect(inspected).toMatchObject({ currentReader: true, handoffToken: first.token });
    expect(value(await open())).toMatchObject({ navigation: 'current-reader', tabId: 7, token: first.token });
    expect(updates).toHaveLength(1); expect(created).toHaveLength(0); expect(handoffs()).toHaveLength(1);
  });

  it('recognizes the current own reader from Chrome context metadata when tabs permission withholds Tab.url', async () => {
    const first = value(await open());
    hideOwnTabUrls();
    expect(value(await inspect())).toMatchObject({ currentReader: true, url: first.readerUrl, handoffToken: first.token });
    expect(value(await open())).toMatchObject({ navigation: 'current-reader', readerUrl: first.readerUrl });
    expect(updates).toHaveLength(1);
    expect(created).toHaveLength(0);
  });
});

describe('reader handoff and return', () => {
  it('accepts a refreshed document in the same own reader tab and returns to the exact observed URL', async () => {
    const opened = value(await open());
    loadedReader(7, opened.readerUrl, 'refreshed-reader-document');
    const sender = readerSender();
    expect(value(await rpc<PdfHandoff | null>({ type: 'pdf.handoff.get', token: opened.token }, sender))).toMatchObject({ tabId: 7, returnUrl: ORIGINAL });
    expect(value(await rpc({ type: 'pdf.returnOriginal', token: opened.token }, sender))).toEqual({ tabId: 7, url: ORIGINAL });
    expect(tabs.get(7)!.url).toBe(ORIGINAL); expect(handoffs()).toHaveLength(0);
  });

  it('gets and returns a refreshed own-reader session using getContexts when Tab.url is withheld', async () => {
    const opened = value(await open());
    loadedReader(7, opened.readerUrl, 'refreshed-reader-document');
    hideOwnTabUrls();
    const sender = readerSender();
    expect(value(await rpc<PdfHandoff | null>({ type: 'pdf.handoff.get', token: opened.token }, sender))).toMatchObject({ returnUrl: ORIGINAL });
    expect(value(await rpc({ type: 'pdf.returnOriginal', token: opened.token }, sender))).toEqual({ tabId: 7, url: ORIGINAL });
  });

  it('rejects own-reader document replacement during sidebar inspection even if the URL is unchanged and withheld', async () => {
    const opened = value(await open());
    hideOwnTabUrls();
    afterRead = () => { loadedReader(7, opened.readerUrl, 'replacement-reader-document'); };
    expect(await inspect()).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(1);
  });

  it('rejects a stolen token in another tab, a wrong token, and a non-reader sender', async () => {
    const opened = value(await open());
    loadedReader(8, opened.readerUrl);
    expect(await rpc({ type: 'pdf.returnOriginal', token: opened.token }, readerSender(8))).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await rpc({ type: 'pdf.returnOriginal', token: '12345678-1234-4123-8123-123456789abc' }, readerSender())).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await rpc({ type: 'pdf.handoff.get', token: opened.token }, UI)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await rpc({ type: 'pdf.context.get', tabId: 7 }, { ...UI, id: 'foreign-extension' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(updates).toHaveLength(1);
  });

  it('returns an explicit missing session and cannot fabricate a return target after expiry', async () => {
    const opened = value(await open());
    const sender = readerSender();
    for (const [key] of handoffs()) delete session[key];
    expect(value(await rpc<PdfHandoff | null>({ type: 'pdf.handoff.get', token: opened.token }, sender))).toBeNull();
    expect(await rpc({ type: 'pdf.returnOriginal', token: opened.token }, sender)).toMatchObject({ ok: false, code: 'PDF_SOURCE_UNAVAILABLE' });
    expect(updates).toHaveLength(1);
    expect(new URL(opened.readerUrl).searchParams.get('source')).toBe(ORIGINAL);
  });

  it('reports session storage errors as reader fallback and never navigates on an unavailable return context', async () => {
    const opened = value(await open());
    const sender = readerSender();
    const originalGet = chrome.storage.session.get;
    chrome.storage.session.get = (async (keys: string | string[]) => {
      if (typeof keys === 'string' && keys.startsWith('pdf.handoff.')) throw Error('Session read failed');
      return originalGet(keys);
    }) as unknown as typeof chrome.storage.session.get;
    expect(value(await inspect())).toMatchObject({ currentReader: true, reason: 'session-unavailable' });
    expect(await rpc({ type: 'pdf.handoff.get', token: opened.token }, sender)).toMatchObject({ ok: false, code: 'STORAGE_UNAVAILABLE' });
    expect(await rpc({ type: 'pdf.returnOriginal', token: opened.token }, sender)).toMatchObject({ ok: false, code: 'STORAGE_UNAVAILABLE' });
    expect(updates).toHaveLength(1);
  });

  it('does not authorize a reader when its Chrome context cannot be confirmed', async () => {
    const opened = value(await open());
    const sender = readerSender();
    chrome.runtime.getContexts = (async () => { throw Error('Context API unavailable'); }) as typeof chrome.runtime.getContexts;
    expect(await rpc({ type: 'pdf.returnOriginal', token: opened.token }, sender)).toMatchObject({ ok: false, code: 'CONTEXT_UNAVAILABLE' });
    expect(updates).toHaveLength(1);
  });

  it('rejects reader document replacement during asynchronous session reads', async () => {
    const opened = value(await open());
    const sender = readerSender();
    afterRead = () => { loadedReader(7, opened.readerUrl, 'replacement-reader-document'); };
    expect(await rpc({ type: 'pdf.returnOriginal', token: opened.token }, sender)).toMatchObject({ ok: false, code: 'PAGE_CHANGED' });
    expect(updates).toHaveLength(1);
  });
});
