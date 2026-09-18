import { isWebPage, pageKey } from '../core/url';

export class PageContextError extends Error {
  readonly code = 'PAGE_CHANGED';
  constructor() { super('The page changed. Please retry on the current page.'); }
}

/**
 * MessageSender.url can describe the URL at content-script creation time, even
 * after history.pushState changes the route. Resolve the current URL inside the
 * browser-identified sending document, not from a URL asserted in the payload.
 * A tab ID alone is insufficient: a replaced document must not inherit access.
 */
export function createContentPageResolver() {
  const inflight = new Map<string, Promise<string>>();
  return (sender: chrome.runtime.MessageSender): Promise<string> => {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined ||
      !sender.documentId || !isWebPage(sender.url) || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) {
      return Promise.reject(new PageContextError());
    }
    const documentId = sender.documentId, tabId = sender.tab.id;
    const key = `${tabId}:${documentId}`;
    const pending = inflight.get(key); if (pending) return pending;
    const probe = (async () => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId, documentIds: [documentId] },
          func: () => ({ href: location.href, top: window === window.top }),
        });
        const result = results.find(value => value.frameId === 0 && value.documentId === documentId);
        const locationResult = result?.result;
        if (!locationResult?.top || !isWebPage(locationResult.href) ||
          new URL(locationResult.href).origin !== new URL(sender.url!).origin) throw new PageContextError();
        return pageKey(locationResult.href);
      } catch { throw new PageContextError(); }
    })();
    inflight.set(key, probe);
    // Do not retain route results: the next request may be after another pushState.
    void probe.finally(() => { if (inflight.get(key) === probe) inflight.delete(key); }).catch(() => undefined);
    return probe;
  };
}
