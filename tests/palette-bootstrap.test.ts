import { afterEach, expect, it, vi } from 'vitest';
import { startBootstrap } from '../src/content/bootstrap';
import { DEFAULT_SETTINGS } from '../src/core/model';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.(); dispose = undefined;
  document.querySelectorAll('web-ink-ui').forEach(node => node.remove());
  vi.unstubAllGlobals();
});

function fixture(get: () => Promise<Record<string, unknown>>) {
  let settings = { ...DEFAULT_SETTINGS };
  let listener: ((message: { type: string }) => void) | undefined;
  let reads = 0;
  const stored: Record<string, unknown> = {};
  vi.stubGlobal('innerWidth', 1200); vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (message: { type: string }) => ({ ok: true, data: message.type === 'settings.get' ? settings : { enabled: false } }),
      onMessage: { addListener: (next: typeof listener) => { listener = next; }, removeListener: () => {} },
    },
    storage: { local: {
      get: () => { reads++; return get(); },
      set: async (value: object) => { Object.assign(stored, value); },
    } },
  });
  dispose = startBootstrap();
  const host = document.querySelector('web-ink-ui') as HTMLElement;
  const button = host.shadowRoot!.querySelector('button')!;
  button.setPointerCapture = () => {};
  button.hasPointerCapture = () => false;
  const point = () => ({ left: Number.parseFloat(button.style.left), top: Number.parseFloat(button.style.top) });
  return { host, button, point, stored, reads: () => reads, settings: () => { settings = { ...settings, theme: 'dark' }; listener?.({ type: 'settings.changed' }); } };
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
