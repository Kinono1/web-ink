import { afterEach, expect, it, vi } from 'vitest';
import { createPaletteMenu } from '../src/content/palette-menu';
import { createPaletteToggle } from '../src/content/palette-toggle';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function fixture() {
  const host = document.createElement('web-ink-ui'); document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const anchor = document.createElement('button'); root.append(anchor);
  anchor.style.left = '1142px'; anchor.style.top = '842px';
  vi.stubGlobal('innerWidth', 1200); vi.stubGlobal('innerHeight', 900);
  const visible = vi.fn(), action = vi.fn();
  const menu = createPaletteMenu(root, anchor, visible, action); dispose = menu.dispose;
  menu.update({ language: 'en', items: [
    { action: 'open-pdf', label: 'Annotate this PDF', icon: 'pdf', primary: true },
    { action: 'sidebar', label: 'Page annotations', icon: 'note' },
  ] });
  return { root, anchor, menu, visible, action, panel: root.querySelector<HTMLElement>('[role=menu]')! };
}

it('keeps explicit cancel reachable while the PDF action is pending', () => {
  const f = fixture(); f.menu.toggle();
  f.menu.update({ pending: true, status: 'Reading PDF…', items: [
    { action: 'open-ieee', label: 'Read current PDF', icon: 'pdf' },
    { action: 'cancel', label: 'Cancel reading', icon: 'close' },
  ] });
  const cancel = f.panel.querySelector<HTMLButtonElement>('[data-action=cancel]')!;
  expect(cancel.disabled).toBe(false); cancel.click();
  expect(f.action).toHaveBeenCalledWith('cancel', undefined);
  f.menu.toggle(); expect(f.panel.hidden).toBe(true);
  expect(f.action).toHaveBeenCalledTimes(1);
});

it('opens and closes without running an action, and retains errors for retry', () => {
  const f = fixture(); f.menu.toggle();
  expect(f.panel.hidden).toBe(false); expect(f.anchor.getAttribute('aria-expanded')).toBe('true');
  expect(f.action).not.toHaveBeenCalled();
  f.root.querySelector<HTMLButtonElement>('[data-action=open-pdf]')!.click();
  expect(f.action).toHaveBeenCalledWith('open-pdf', undefined);
  f.menu.update({ error: 'Network unavailable. Try again.' });
  expect(f.panel.querySelector('[role=alert]')?.textContent).toContain('Network unavailable');
  expect(f.panel.hidden).toBe(false);
  f.menu.toggle(); expect(f.panel.hidden).toBe(true); expect(f.visible.mock.calls).toEqual([[true], [false]]);
});

it('does not run an IEEE session action from an untrusted page click', () => {
  const f = fixture();
  f.menu.update({ language: 'en', items: [
    { action: 'open-ieee', label: 'Open using IEEE sign-in', icon: 'pdf', primary: true },
    { action: 'sidebar', label: 'Page annotations', icon: 'note' },
  ] });
  f.menu.toggle();

  f.panel.querySelector<HTMLButtonElement>('[data-action=open-ieee]')!.click();
  expect(f.action).not.toHaveBeenCalled();
  f.panel.querySelector<HTMLButtonElement>('[data-action=sidebar]')!.click();
  expect(f.action).toHaveBeenCalledWith('sidebar', undefined);
});

it('runs a mouse action without letting an embedded reader steal focus before click', () => {
  const f = fixture(); f.menu.toggle();
  const item = f.panel.querySelector<HTMLButtonElement>('[data-action=open-pdf]')!;
  const down = new MouseEvent('pointerdown', { bubbles: true, composed: true, cancelable: true, button: 0 });
  Object.defineProperty(down, 'pointerType', { value: 'mouse' });
  item.dispatchEvent(down);
  if (!down.defaultPrevented) document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  // The same pointer releases after focus has moved; a hidden menu receives no click.
  if (!f.panel.hidden) item.click();
  expect(f.action).toHaveBeenCalledWith('open-pdf', undefined);
});

it('keeps a focused common action when PDF detection prepends menu items', () => {
  const f = fixture(); f.menu.toggle();
  const sidebar = f.panel.querySelector<HTMLButtonElement>('[data-action=sidebar]')!;
  sidebar.focus();
  f.menu.update({ items: [
    { action: 'retry', label: 'Retry detection', icon: 'refresh' },
    { action: 'open-pdf', label: 'Annotate this PDF', icon: 'pdf', primary: true },
    { action: 'sidebar', label: 'Page annotations', icon: 'note' },
  ] });
  expect(f.root.activeElement?.getAttribute('data-action')).toBe('sidebar');
});

it('keeps the focused PDF source when another candidate changes its index', () => {
  const f = fixture(); f.menu.update({ items: [
    { action: 'open-pdf', label: 'Alpha.pdf', icon: 'pdf', candidateUrl: 'https://example.test/alpha.pdf' },
    { action: 'open-pdf', label: 'Beta.pdf', icon: 'pdf', candidateUrl: 'https://example.test/beta.pdf' },
    { action: 'sidebar', label: 'Page annotations', icon: 'note' },
  ] }); f.menu.toggle();
  [...f.panel.querySelectorAll<HTMLButtonElement>('[data-action=open-pdf]')][1]!.focus();
  f.menu.update({ items: [
    { action: 'retry', label: 'Retry detection', icon: 'refresh' },
    { action: 'open-pdf', label: 'Alpha.pdf', icon: 'pdf', candidateUrl: 'https://example.test/alpha.pdf' },
    { action: 'open-pdf', label: 'Beta.pdf', icon: 'pdf', candidateUrl: 'https://example.test/beta.pdf' },
    { action: 'sidebar', label: 'Page annotations', icon: 'note' },
  ] });
  expect(f.root.activeElement?.textContent).toContain('Beta.pdf');
  (f.root.activeElement as HTMLButtonElement).click();
  expect(f.action).toHaveBeenCalledWith('open-pdf', 'https://example.test/beta.pdf');
});

it('returns focus to the pen when the focused menu action is removed', () => {
  const f = fixture(); f.menu.toggle();
  f.panel.querySelector<HTMLButtonElement>('[data-action=sidebar]')!.focus();
  f.menu.update({ items: [
    { action: 'retry', label: 'Retry detection', icon: 'refresh' },
    { action: 'open-pdf', label: 'Annotate this PDF', icon: 'pdf', primary: true },
  ] });
  expect(f.root.activeElement).toBe(f.anchor);
});

it('restores the focused action after pending menu updates complete', () => {
  const f = fixture(); f.menu.update({ items: [
    { action: 'library', label: 'Library', icon: 'library' },
    { action: 'sidebar', label: 'Page annotations', icon: 'note' },
  ] }); f.menu.toggle();
  f.panel.querySelector<HTMLButtonElement>('[data-action=library]')!.focus();
  f.menu.update({ pending: true });
  f.menu.update({ error: 'Open failed.' });
  f.menu.update({ pending: false });
  expect(f.root.activeElement?.getAttribute('data-action')).toBe('library');
  (f.root.activeElement as HTMLButtonElement).click();
  expect(f.action).toHaveBeenCalledWith('library', undefined);
});

it('does not restore pending menu focus after the menu closes', () => {
  const f = fixture(); f.menu.toggle();
  f.panel.querySelector<HTMLButtonElement>('[data-action=sidebar]')!.focus();
  f.menu.update({ pending: true });
  f.menu.close();
  const outside = document.createElement('button'); document.body.append(outside); outside.focus();
  f.menu.update({ error: 'Open failed.' });
  f.menu.update({ pending: false });
  expect(document.activeElement).toBe(outside);
});

it('dismisses on outside input or Escape, keeps inside clicks open and supports arrow focus', () => {
  const f = fixture(); f.menu.toggle();
  f.panel.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
  expect(f.menu.isOpen()).toBe(true);
  f.anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
  expect(f.root.activeElement).toBe(f.panel.querySelector('[data-action=open-pdf]'));
  f.panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
  expect(f.root.activeElement).toBe(f.panel.querySelector('[data-action=sidebar]'));
  f.panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
  expect(f.menu.isOpen()).toBe(false); expect(f.root.activeElement).toBe(f.anchor);
  f.menu.toggle(); document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
  expect(f.menu.isOpen()).toBe(false);
});

it('keeps the menu within a small viewport and closes during a real drag', () => {
  const f = fixture(); vi.stubGlobal('innerWidth', 320); vi.stubGlobal('innerHeight', 240);
  f.anchor.style.left = '12px'; f.anchor.style.top = '12px';
  f.menu.toggle();
  expect(Number.parseFloat(f.panel.style.left)).toBeGreaterThanOrEqual(12);
  expect(Number.parseFloat(f.panel.style.top)).toBeGreaterThanOrEqual(12);
  expect(f.panel.style.maxWidth).toBe('296px'); expect(f.panel.style.maxHeight).toBe('216px');
  f.anchor.dataset.dragging = 'false'; f.anchor.dispatchEvent(new Event('pointermove'));
  expect(f.menu.isOpen()).toBe(true);
  f.anchor.dataset.dragging = 'true'; f.anchor.dispatchEvent(new Event('pointermove'));
  expect(f.menu.isOpen()).toBe(false);
});

it('places the menu below a 64px pen without overlapping its lower edge', () => {
  const f = fixture();
  f.anchor.style.left = '800px'; f.anchor.style.top = '12px';
  f.anchor.getBoundingClientRect = () => ({
    x: 800, y: 12, left: 800, top: 12, right: 864, bottom: 76, width: 64, height: 64, toJSON: () => ({}),
  });

  f.menu.toggle();

  expect(f.panel.style.left).toBe('624px');
  expect(Number.parseFloat(f.panel.style.top)).toBeGreaterThanOrEqual(84);
});

it('uses the configured size when layout has not measured the pen yet', () => {
  const f = fixture();
  f.anchor.style.left = '800px'; f.anchor.style.top = '12px';
  f.anchor.style.setProperty('--web-ink-palette-size', '64px');
  f.anchor.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}),
  });

  f.menu.toggle();

  expect(f.panel.style.left).toBe('624px');
  expect(Number.parseFloat(f.panel.style.top)).toBeGreaterThanOrEqual(84);
});

it('blocks repeat actions while pending but still allows dismissing the menu and cleans up', () => {
  const f = fixture(); f.menu.toggle(); f.menu.update({ pending: true });
  f.panel.querySelector<HTMLButtonElement>('button')!.click(); expect(f.action).not.toHaveBeenCalled();
  f.menu.toggle(); expect(f.menu.isOpen()).toBe(false);
  f.menu.dispose(); expect(f.root.querySelector('[role=menu]')).toBeNull();
  f.anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(f.visible).toHaveBeenCalledTimes(2);
});

it('starts reverse keyboard navigation at the last available action', () => {
  const f = fixture();
  f.anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, composed: true }));
  expect(f.menu.isOpen()).toBe(true);
  expect(f.root.activeElement).toBe(f.panel.querySelector('[data-action=sidebar]'));
});

it('Escape closes an open menu and releases an unfinished pen gesture', () => {
  const host = document.createElement('web-ink-ui'); document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const pen = createPaletteToggle(root, () => menu.toggle());
  const menu = createPaletteMenu(root, pen.button, () => {}, () => {});
  dispose = () => { menu.dispose(); pen.dispose(); };
  const captures = new Set<number>();
  pen.button.setPointerCapture = id => { captures.add(id); };
  pen.button.hasPointerCapture = id => captures.has(id);
  pen.button.releasePointerCapture = id => { captures.delete(id); };
  pen.button.focus(); pen.button.click();
  const down = new MouseEvent('pointerdown', { bubbles: true, composed: true, button: 0 });
  Object.defineProperties(down, { pointerId: { value: 1 }, isPrimary: { value: true } });
  pen.button.dispatchEvent(down); expect(captures.size).toBe(1);
  pen.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
  expect(menu.isOpen()).toBe(false); expect(captures.size).toBe(0);
});
