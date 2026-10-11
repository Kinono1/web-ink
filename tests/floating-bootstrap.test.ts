import { afterEach, expect, it, vi } from 'vitest';
import { startBootstrap } from '../src/content/bootstrap';
import { DEFAULT_SETTINGS } from '../src/core/model';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function fixture(context: () => Promise<unknown>, opening: () => Promise<unknown> = async () => ({ navigation: 'same-tab' })) {
  const messages: any[] = [];
  let enabled = false;
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (message: any) => {
        messages.push(message);
        let data: unknown;
        if (message.type === 'settings.get') data = { ...DEFAULT_SETTINGS, language: 'en' };
        else if (message.type === 'page.mode.get') data = { enabled };
        else if (message.type === 'page.mode.put') { enabled = message.enabled; data = { enabled }; }
        else if (message.type === 'pdf.context.get') data = await context();
        else if (message.type === 'pdf.openCurrent') data = await opening();
        return { ok: true, data };
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  });
  dispose = startBootstrap({ generation: 'floating-test', version: '0.3.2', commit: 'test', dirty: true });
  const root = document.querySelector('web-ink-ui')!.shadowRoot!;
  const pen = root.querySelector<HTMLButtonElement>('.web-ink-palette-toggle')!;
  await vi.waitFor(() => expect(pen.disabled).toBe(false));
  const item = (action: string) => root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  return { root, pen, item, messages };
}
const pdf = () => ({ tabId: 7, url: location.href, kind: 'direct', currentReader: false, candidates: [{ url: 'https://papers.example.test/paper.pdf', via: 'url' }] });

it('reads context on demand and directly opens the current PDF without enabling the webpage engine', async () => {
  const f = await fixture(async () => pdf());
  expect(f.messages.some(m => m.type === 'pdf.context.get')).toBe(false);
  f.pen.click(); await vi.waitFor(() => expect(f.item('open-pdf')).not.toBeNull());
  f.item('open-pdf')!.click();
  await vi.waitFor(() => expect(f.messages).toContainEqual({ type: 'pdf.openCurrent', expectedUrl: location.href, candidateUrl: 'https://papers.example.test/paper.pdf' }));
  expect(f.messages.some(m => ['page.mode.put', 'engine.ensure', 'ui.open'].includes(m.type))).toBe(false);
  await vi.waitFor(() => expect(f.pen.getAttribute('aria-expanded')).toBe('false'));
});

it('ignores late context after closing and never navigates a changed route', async () => {
  let finish!: (value: unknown) => void;
  const f = await fixture(() => new Promise(resolve => { finish = resolve; }));
  f.pen.click(); f.pen.click(); finish(pdf());
  await Promise.resolve(); await Promise.resolve();
  expect(f.pen.getAttribute('aria-expanded')).toBe('false'); expect(f.item('open-pdf')).toBeNull();
});

it('single-flights opening, preserves a failed menu for retry, and routes fixed navigation targets', async () => {
  let finish!: () => void; let attempts = 0;
  const f = await fixture(async () => pdf(), async () => { attempts++; await new Promise<void>(resolve => { finish = resolve; }); throw Error('PDF unavailable'); });
  f.pen.click(); await vi.waitFor(() => expect(f.item('open-pdf')).not.toBeNull());
  f.item('open-pdf')!.click(); f.item('open-pdf')!.click();
  expect(attempts).toBe(1); finish();
  await vi.waitFor(() => expect(f.root.querySelector('[role=alert]')?.textContent).toContain('PDF unavailable'));
  expect(f.pen.getAttribute('aria-expanded')).toBe('true'); expect(f.item('open-pdf')!.disabled).toBe(false);
  f.item('sidebar')!.click();
  await vi.waitFor(() => expect(f.messages).toContainEqual({ type: 'ui.open', target: 'sidebar' }));
});

it('offers explicit source choices and only changes webpage mode from its menu action', async () => {
  const f = await fixture(async () => ({ ...pdf(), kind: 'unavailable', reason: 'not-pdf', candidates: [] }));
  f.pen.click(); await vi.waitFor(() => expect(f.item('toggle')).not.toBeNull());
  expect(f.messages.some(m => m.type === 'page.mode.put')).toBe(false);
  f.item('toggle')!.click();
  await vi.waitFor(() => expect(f.messages).toContainEqual({ type: 'page.mode.put', pageUrl: location.href.split('#')[0], enabled: true }));
});

it('lets a failed context lookup be retried without loading the annotation engine', async () => {
  let reads = 0;
  const f = await fixture(async () => { if (++reads === 1) throw Error('Context unavailable'); return pdf(); });
  f.pen.click(); await vi.waitFor(() => expect(f.item('retry')).not.toBeNull());
  f.item('retry')!.click(); await vi.waitFor(() => expect(f.item('open-pdf')).not.toBeNull());
  expect(reads).toBe(2); expect(f.messages.some(m => m.type === 'engine.ensure')).toBe(false);
});
