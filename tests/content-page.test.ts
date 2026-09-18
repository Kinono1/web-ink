import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContentPageResolver } from '../src/background/content-page';

const sender = (): chrome.runtime.MessageSender => ({ id: 'web-ink-id', frameId: 0, documentId: 'document-a', documentLifecycle: 'active', url: 'https://example.test/start', tab: { id: 7 } as chrome.tabs.Tab });
const injection = (href = 'https://example.test/conversation/b') => [{ frameId: 0, documentId: 'document-a', result: { href, top: true } }];
let executeScript: ReturnType<typeof vi.fn>;
beforeEach(() => {
  executeScript = vi.fn().mockResolvedValue(injection());
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { id: 'web-ink-id' }, scripting: { executeScript } } });
});

describe('SPA-aware browser-authenticated document scope', () => {
  it('resolves pushState routes from the exact sending document rather than a stale sender URL', async () => {
    expect(await createContentPageResolver()(sender())).toBe('https://example.test/conversation/b');
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, documentIds: ['document-a'] } }));
  });
  it('does not cache route URLs across subsequent requests', async () => {
    const resolve = createContentPageResolver();
    expect(await resolve(sender())).toContain('/conversation/b');
    executeScript.mockResolvedValueOnce(injection('https://example.test/conversation/c'));
    expect(await resolve(sender())).toContain('/conversation/c');
  });
  it('coalesces only concurrent probes for the same browser document', async () => {
    let complete!: (value: unknown) => void;
    executeScript.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const resolve = createContentPageResolver();
    const first = resolve(sender()), second = resolve(sender());
    expect(executeScript).toHaveBeenCalledTimes(1);
    complete(injection());
    expect(await first).toBe(await second);
  });
  it('refuses child frames, missing document IDs, stale documents and foreign extensions', async () => {
    const resolve = createContentPageResolver();
    const changes: Partial<chrome.runtime.MessageSender>[] = [{ frameId: 1 }, { documentId: undefined }, { documentLifecycle: 'cached' }, { id: 'other-extension' }];
    for (const change of changes) {
      await expect(resolve({ ...sender(), ...change })).rejects.toMatchObject({ code: 'PAGE_CHANGED' });
    }
    expect(executeScript).not.toHaveBeenCalled();
  });
  it('refuses another document, another origin, missing targets and denied injection', async () => {
    const resolve = createContentPageResolver();
    executeScript.mockResolvedValueOnce([{ ...injection()[0], documentId: 'replacement-document' }]);
    await expect(resolve(sender())).rejects.toMatchObject({ code: 'PAGE_CHANGED' });
    executeScript.mockResolvedValueOnce(injection('https://other.test/private'));
    await expect(resolve(sender())).rejects.toMatchObject({ code: 'PAGE_CHANGED' });
    executeScript.mockResolvedValueOnce([]);
    await expect(resolve(sender())).rejects.toMatchObject({ code: 'PAGE_CHANGED' });
    executeScript.mockRejectedValueOnce(new Error('document is gone'));
    await expect(resolve(sender())).rejects.toMatchObject({ code: 'PAGE_CHANGED' });
  });
});
