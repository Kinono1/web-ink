import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPaletteToggle } from '../src/content/palette-toggle';

function fixture(): ShadowRoot { const host = document.createElement('web-ink-ui'); document.body.append(host); return host.attachShadow({ mode: 'open' }); }
afterEach(() => document.body.replaceChildren());

describe('palette toggle', () => {
  it('starts off with an accessible pressed state and toggles on click', () => {
    const toggle = vi.fn(); const control = createPaletteToggle(fixture(), toggle);
    expect(control.button.getAttribute('aria-pressed')).toBe('false');
    expect(control.button.title).toBe('开启本页标注');
    expect(control.button.querySelector('svg[aria-hidden=true]')).not.toBeNull();
    control.button.click(); expect(toggle).toHaveBeenCalledOnce();
    control.update({ enabled: true, language: 'zh-CN' });
    expect(control.button.getAttribute('aria-pressed')).toBe('true');
    expect(control.button.title).toBe('关闭本页标注');
  });

  it('does not toggle while busy or blocked and localizes normal titles', () => {
    const callback = vi.fn(); const control = createPaletteToggle(fixture(), callback);
    control.update({ enabled: false, busy: true, language: 'en' });
    expect(control.button.disabled).toBe(true); expect(control.button.title).toBe('Enable annotations on this page'); control.button.click();
    control.update({ enabled: true, blocked: true, language: 'en' });
    expect(control.button.title).toBe('This site is paused. Resume it from the side panel.'); control.button.click();
    expect(callback).not.toHaveBeenCalled();
  });

  it('updates in place and removes both button and style on dispose', () => {
    const root = fixture(); const control = createPaletteToggle(root, () => undefined); const button = control.button;
    control.update({ enabled: true, language: 'en' });
    expect(root.querySelector('button')).toBe(button);
    control.dispose();
    expect(root.querySelector('button')).toBeNull(); expect(root.querySelector('style')).toBeNull();
  });
});
