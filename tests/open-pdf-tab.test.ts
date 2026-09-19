import { afterEach, expect, it, vi } from 'vitest';
import { openPdfTab } from '../src/ui/management/openPdf';
afterEach(() => vi.unstubAllGlobals());
const base = 'chrome-extension://webink/pdf.html';
function browser(tabs: {id: number; url: string; windowId?: number}[]) {
  const create = vi.fn(async () => ({})), update = vi.fn(async () => ({})), focus = vi.fn(async () => ({}));
  vi.stubGlobal('chrome', { runtime: { getContexts: async () => tabs.map(t => ({ tabId: t.id, documentUrl: t.url, windowId: t.windowId })) }, tabs: { query: async () => tabs, create, update }, windows: { update: focus } });
  return { create, update, focus };
}
it('reuses the same document reader, preserving unsaved state', async () => {
  const c = browser([{ id: 2, windowId: 1, url: `${base}?source=https%3A%2F%2Fexample.test%2Fa.pdf&open=1` }]);
  await openPdfTab(`${base}?source=https%3A%2F%2Fexample.test%2Fa.pdf&open=1`);
  expect(c.create).not.toHaveBeenCalled(); expect(c.update).toHaveBeenCalledWith(2, { active: true });
});
it('does not reuse another extension or another source', async () => {
  const c = browser([{ id: 2, url: 'chrome-extension://other/pdf.html' }, { id: 3, url: `${base}?source=https%3A%2F%2Fexample.test%2Fb.pdf` }]);
  await openPdfTab(`${base}?source=https%3A%2F%2Fexample.test%2Fa.pdf`);
  expect(c.create).toHaveBeenCalledOnce(); expect(c.update).not.toHaveBeenCalled();
});
it('a generic entry returns to an existing reader without navigating its document', async () => {
  const c = browser([{ id: 2, url: `${base}?source=https%3A%2F%2Fexample.test%2Fa.pdf` }]);
  await openPdfTab(base);
  expect(c.update).toHaveBeenCalledWith(2, { active: true }); expect(c.create).not.toHaveBeenCalled();
});
it('matches a source-only request to its loaded identity and normalizes page fragments', async () => {
  const c = browser([{ id: 2, url: `${base}?source=https%3A%2F%2Fexample.test%2Fa.pdf&document=loaded` }]);
  await openPdfTab(`${base}?source=${encodeURIComponent('https://example.test/a.pdf#page=3')}&open=1`);
  expect(c.update).toHaveBeenCalledWith(2, { active: true }); expect(c.create).not.toHaveBeenCalled();
});
it('opens a requested saved PDF in a new tab after another file replaced the old source', async () => {
  const c = browser([{ id: 2, url: `${base}?document=different-local-file` }]);
  await openPdfTab(`${base}?source=https%3A%2F%2Fexample.test%2Fa.pdf&document=original`);
  expect(c.create).toHaveBeenCalledOnce(); expect(c.update).not.toHaveBeenCalled();
});
