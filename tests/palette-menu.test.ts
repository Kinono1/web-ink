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
