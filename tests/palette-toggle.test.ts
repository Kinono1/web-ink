import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPaletteToggle } from '../src/content/palette-toggle';

const controls: ReturnType<typeof createPaletteToggle>[] = [];
function fixture(): ShadowRoot { const host = document.createElement('web-ink-ui'); document.body.append(host); return host.attachShadow({ mode: 'open' }); }
afterEach(() => {
  controls.splice(0).forEach(control => control.dispose());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function gestureFixture() {
  let width = 1200, height = 900;
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback); return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const toggle = vi.fn(), saved = vi.fn();
  const control = createPaletteToggle(fixture(), toggle, saved);
  controls.push(control);
  const button = control.button;
  const captured = new Set<number>();
  button.setPointerCapture = id => { captured.add(id); };
  button.hasPointerCapture = id => captured.has(id);
  button.releasePointerCapture = id => {
    captured.delete(id);
    pointer('lostpointercapture', 0, 0, { pointerId: id });
  };
  button.getBoundingClientRect = () => ({
    x: Number.parseFloat(button.style.left) || width - 58,
    y: Number.parseFloat(button.style.top) || height - 58,
    left: Number.parseFloat(button.style.left) || width - 58,
    top: Number.parseFloat(button.style.top) || height - 58,
    right: 0, bottom: 0, width: 40, height: 40, toJSON: () => ({}),
  });
  function pointer(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ pointerId: 1, isPrimary: true, pointerType: 'mouse', ...extra }).map(([key, value]) => [key, { value }])));
    button.dispatchEvent(event);
  }
  const click = (detail = 1) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  const resize = (w: number, h: number) => { width = w; height = h; vi.stubGlobal('innerWidth', w); vi.stubGlobal('innerHeight', h); window.dispatchEvent(new Event('resize')); };
  return { control, button, toggle, saved, pointer, click, frame, frames, captured, resize };
}

describe('palette dragging', () => {
  it('keeps small diagonal motion clickable but latches a drag after returning to the start', () => {
    const f = gestureFixture();
    f.pointer('pointerdown', 1162, 862); f.pointer('pointermove', 1158, 858); f.pointer('pointerup', 1158, 858); f.click();
    expect(f.toggle).toHaveBeenCalledOnce(); expect(f.saved).not.toHaveBeenCalled();
    f.pointer('pointerdown', 1162, 862); f.pointer('pointermove', 1157, 857); f.pointer('pointerup', 1162, 862); f.click();
    expect(f.toggle).toHaveBeenCalledOnce(); expect(f.saved).toHaveBeenCalledOnce();
    expect(f.captured.size).toBe(0);
    f.click(0); expect(f.toggle).toHaveBeenCalledTimes(2);
    f.pointer('pointerdown', 1162, 862); f.pointer('pointerup', 1162, 862); f.click();
    expect(f.toggle).toHaveBeenCalledTimes(3);
  });

  it('uses the release coordinates, keeps the pointer offset, and cancels an older animation frame', () => {
    const f = gestureFixture();
    f.pointer('pointerdown', 1162, 862);
    f.pointer('pointermove', 300, 220); f.pointer('pointermove', 250, 200);
    expect(f.frames.size).toBe(1);
    f.pointer('pointerup', 220, 160);
    expect(f.button.style.left).toBe('200px'); expect(f.button.style.top).toBe('140px');
    expect(f.frames.size).toBe(0); f.frame();
    expect(f.button.style.left).toBe('200px'); expect(f.saved).toHaveBeenCalledOnce();
    expect(f.button.dataset.dragging).toBe('false'); expect(f.captured.size).toBe(0);
  });

  it.each(['pointercancel', 'lostpointercapture', 'escape', 'blur', 'disabled', 'dispose'])('cleans up %s without saving or letting a stale frame move the button', reason => {
    const f = gestureFixture();
    f.pointer('pointerdown', 1162, 862); f.pointer('pointermove', 300, 220); f.frame();
    f.pointer('pointermove', 250, 200);
    if (reason === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    else if (reason === 'disabled') f.control.update({ enabled: false, busy: true, language: 'zh-CN' });
    else if (reason === 'dispose') f.control.dispose();
    else f.pointer(reason, 250, 200);
    expect(f.captured.size).toBe(0); expect(f.frames.size).toBe(0); expect(f.saved).not.toHaveBeenCalled();
    f.frame(); expect(f.button.style.left).toBe('1142px'); expect(f.button.style.top).toBe('842px');
    if (reason !== 'dispose') {
      f.control.update({ enabled: false, language: 'zh-CN' });
      f.pointer('pointerdown', 1162, 862); f.pointer('pointerup', 1162, 862); f.click();
      expect(f.toggle).toHaveBeenCalledOnce();
    }
  });

  it('clamps at the edges and restores the original relative position after resizing during a drag', () => {
    const f = gestureFixture(); f.control.setPosition({ x: 0.5, y: 0.5 });
    expect(f.button.style.left).toBe('580px'); expect(f.button.style.top).toBe('430px');
    f.pointer('pointerdown', 600, 450); f.pointer('pointermove', -100, -100); f.frame();
    expect(f.button.style.left).toBe('12px'); expect(f.button.style.top).toBe('12px');
    f.resize(320, 240);
    expect(f.button.style.left).toBe('140px'); expect(f.button.style.top).toBe('100px');
    expect(f.captured.size).toBe(0); expect(f.saved).not.toHaveBeenCalled();
    f.resize(1200, 900); expect(f.button.style.left).toBe('580px');
  });

  it('ignores late restoration and unrelated pointers without losing the active drag state', () => {
    const f = gestureFixture();
    f.pointer('pointerdown', 1162, 862, { button: 2 }); expect(f.captured.size).toBe(0);
    f.pointer('pointerdown', 1162, 862, { isPrimary: false }); expect(f.captured.size).toBe(0);
    f.pointer('pointerdown', 1162, 862); f.pointer('pointermove', 300, 220);
    f.control.setPosition({ x: 0, y: 0 });
    f.control.update({ enabled: true, language: 'en' });
    expect(f.button.dataset.dragging).toBe('true');
    f.pointer('pointerup', 0, 0, { pointerId: 2 }); expect(f.captured.size).toBe(1);
    f.pointer('pointerup', 300, 220); expect(f.button.style.left).toBe('280px');
    expect(f.saved).toHaveBeenCalledOnce();
  });
});

describe('palette toggle', () => {
  it('starts off with an accessible pressed state and toggles on click', () => {
    const toggle = vi.fn(); const control = createPaletteToggle(fixture(), toggle);
    controls.push(control);
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
    controls.push(control);
    control.update({ enabled: false, busy: true, language: 'en' });
    expect(control.button.disabled).toBe(true); expect(control.button.title).toBe('Enable annotations on this page'); control.button.click();
    control.update({ enabled: true, blocked: true, language: 'en' });
    expect(control.button.title).toBe('This site is paused. Resume it from the side panel.'); control.button.click();
    expect(callback).not.toHaveBeenCalled();
  });

  it('updates in place and removes both button and style on dispose', () => {
    const root = fixture(); const control = createPaletteToggle(root, () => undefined); const button = control.button;
    controls.push(control);
    control.update({ enabled: true, language: 'en' });
    expect(root.querySelector('button')).toBe(button);
    control.dispose();
    expect(root.querySelector('button')).toBeNull(); expect(root.querySelector('style')).toBeNull();
  });
});
