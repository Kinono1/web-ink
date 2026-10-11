import { afterEach, expect, it, vi } from 'vitest';
import { startBootstrap } from '../src/content/bootstrap';
import { DEFAULT_SETTINGS } from '../src/core/model';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.(); dispose = undefined;
  document.querySelectorAll('web-ink-ui').forEach(node => node.remove());
  vi.unstubAllGlobals();
});
function fixture(
  get: () => Promise<Record<string, unknown>>,
  pdfContext?: () => Promise<unknown>,
  openPdf?: () => Promise<unknown>,
) {
  let settings = { ...DEFAULT_SETTINGS };
  let listener: ((message: { type: string }) => void) | undefined;
  let reads = 0;
  const stored: Record<string, unknown> = {};
  const messages: Array<Record<string, unknown>> = [];
  vi.stubGlobal('innerWidth', 1200); vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (message: Record<string, unknown>) => {
        messages.push(message);
        if (message.type === 'settings.get') return { ok: true, data: settings };
        if (message.type === 'pdf.context.get' && pdfContext)
          return { ok: true, data: await pdfContext() };
        if (message.type === 'pdf.openCurrent' && openPdf)
          return await openPdf();
        return { ok: true, data: { enabled: false } };
      },
      onMessage: { addListener: (next: typeof listener) => { listener = next; }, removeListener: () => {} },
    },
    storage: { local: {
      get: () => { reads++; return get(); },
      set: async (value: object) => { Object.assign(stored, value); },
    } },
  });
  dispose = startBootstrap({ generation: 'palette-test', version: '0.3.2', commit: 'test', dirty: true });
  const host = document.querySelector('web-ink-ui') as HTMLElement;
  const button = host.shadowRoot!.querySelector('button')!;
  button.setPointerCapture = () => {};
  button.hasPointerCapture = () => false;
  const point = () => ({ left: Number.parseFloat(button.style.left), top: Number.parseFloat(button.style.top) });
  return { host, button, point, stored, messages, reads: () => reads, settings: () => { settings = { ...settings, theme: 'dark' }; listener?.({ type: 'settings.changed' }); } };
}

it('restores the local preference once and does not re-read it for theme updates', async () => {
  const f = fixture(async () => ({ 'ui.palettePosition': { x: .5, y: .5 } }));
  await vi.waitFor(() => expect(f.point()).toEqual({ left: 580, top: 430 }));
  f.settings();
  await vi.waitFor(() => expect(f.host.dataset.webInkTheme).toBe('dark'));
  expect(f.reads()).toBe(1);
  expect(f.point()).toEqual({ left: 580, top: 430 });
});

it.each([async () => { throw Error('storage unavailable'); }, async () => ({ 'ui.palettePosition': { x: Infinity, y: 'wrong' } })])('keeps the default button usable when local restoration fails', async get => {
  const f = fixture(get);
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  expect(f.point()).toEqual({ left: 1142, top: 842 });
});

it('does not let a late storage result replace an interaction that has already started', async () => {
  let resolve!: (value: Record<string, unknown>) => void;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  const event = new MouseEvent('pointerdown', { clientX: 1162, clientY: 862, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  f.button.dispatchEvent(event);
  resolve({ 'ui.palettePosition': { x: 0, y: 0 } });
  await Promise.resolve(); await Promise.resolve();
  expect(f.point()).toEqual({ left: 1142, top: 842 });
});

it('renders an IEEE wrapper action without the content-script permissions API', async () => {
  const f = fixture(async () => ({}), async () => ({
    tabId: 7,
    url: location.href,
    publisher: 'ieee',
    kind: 'wrapper',
    currentReader: false,
    candidates: [],
  }));
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  f.button.click();
  const root = f.host.shadowRoot!;
  await vi.waitFor(() => expect(root.querySelector('[data-action="open-ieee"]')).not.toBeNull());
  expect(root.querySelector<HTMLButtonElement>('[data-action="open-ieee"]')!.textContent)
    .toBe('使用 IEEE 登录状态打开');
});

it('renders explicit IEEE candidate choices when the wrapper observed several sources', async () => {
  const first = 'https://ieeexplore.ieee.org/download?document=one';
  const second = 'https://ieeexplore.ieee.org/download?document=two';
  const f = fixture(async () => ({}), async () => ({
    tabId: 7,
    url: location.href,
    publisher: 'ieee',
    kind: 'wrapper',
    currentReader: false,
    candidates: [{ url: first, via: 'iframe' }, { url: second, via: 'iframe' }],
  }));
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  f.button.click();
  const root = f.host.shadowRoot!;
  await vi.waitFor(() => expect(root.querySelectorAll('[data-action="open-ieee"]')).toHaveLength(2));
  const choices = root.querySelectorAll<HTMLButtonElement>('[data-action="open-ieee"]');
  expect(choices[0]!.textContent).toContain(first.split('/').pop()!);
  expect(choices[1]!.textContent).toContain(second.split('/').pop()!);

});

it('keeps a cross-origin PDF candidate public on an IEEE wrapper', async () => {
  const second = 'https://papers.example.test/second.pdf';
  const f = fixture(async () => ({}), async () => ({
    tabId: 7,
    url: location.href,
    publisher: 'ieee',
    kind: 'wrapper',
    currentReader: false,
    candidates: [{ url: second, via: 'object' }],
  }));
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  f.button.click();
  const root = f.host.shadowRoot!;
  await vi.waitFor(() => expect(root.querySelector('[data-action="open-ieee"]')).not.toBeNull());
  expect(root.querySelector<HTMLButtonElement>('[data-action="open-ieee"]')!.dataset.primary).toBe('true');
  expect(root.querySelector<HTMLButtonElement>('[data-action="open-pdf"]')!.textContent)
    .toBe('打开 second.pdf');
});

it('keeps an ordinary PDF opening public', async () => {
  const candidateUrl = 'https://papers.example.test/paper.pdf';
  const f = fixture(async () => ({}), async () => ({
    tabId: 7,
    url: location.href,
    kind: 'direct',
    currentReader: false,
    candidates: [{ url: candidateUrl, via: 'url' }],
  }));
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  f.button.click();
  const root = f.host.shadowRoot!;
  await vi.waitFor(() => expect(root.querySelector('[data-action="open-pdf"]')).not.toBeNull());

  root.querySelector<HTMLButtonElement>('[data-action="open-pdf"]')!.click();
  await vi.waitFor(() => expect(f.messages).toContainEqual({
    type: 'pdf.openCurrent',
    expectedUrl: location.href,
    candidateUrl,
  }));
  expect(f.messages).not.toContainEqual(expect.objectContaining({
    type: 'pdf.openCurrent',
    accessMode: 'site-session',
  }));
});
it('keeps the local PDF action manual on an IEEE wrapper', async () => {
  const f = fixture(async () => ({}), async () => ({
    tabId: 7,
    url: location.href,
    publisher: 'ieee',
    kind: 'wrapper',
    currentReader: false,
    candidates: [],
  }));
  await vi.waitFor(() => expect(f.button.disabled).toBe(false));
  f.button.click();
  const root = f.host.shadowRoot!;
  await vi.waitFor(() => expect(root.querySelector('[data-action="local-pdf"]')).not.toBeNull());

  root.querySelector<HTMLButtonElement>('[data-action="local-pdf"]')!.click();
  await vi.waitFor(() => expect(f.messages).toContainEqual({ type: 'ui.open', target: 'local-pdf' }));
  expect(f.messages).not.toContainEqual(expect.objectContaining({
    type: 'pdf.openCurrent',
    accessMode: 'site-session',
  }));
});
