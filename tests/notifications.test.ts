import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotifications } from '../src/content/notifications';

function toast(): HTMLElement {
  document.body.innerHTML = '<div class="toast"></div>';
  return document.querySelector('.toast')!;
}

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('content notifications', () => {
  it('does not reopen a manually dismissed passive error until its scope resets', () => {
    const container = toast(); const notices = createNotifications(container);
    notices.show('refresh failed', { kind: 'error', passive: true, key: 'refresh' });
    (container.querySelector('button:last-child') as HTMLButtonElement).click();
    notices.show('refresh failed again', { kind: 'error', passive: true, key: 'refresh' });
    expect(container.style.display).toBe('none');
    notices.resetScope(); notices.show('refresh failed next route', { kind: 'error', passive: true, key: 'refresh' });
    expect(container.textContent).toContain('refresh failed next route');
  });

  it('auto-hides success after about 2.5 seconds', () => {
    vi.useFakeTimers(); const container = toast(); const notices = createNotifications(container);
    notices.show('saved', { kind: 'success' });
    vi.advanceTimersByTime(2_499); expect(container.style.display).toBe('block');
    vi.advanceTimersByTime(1); expect(container.style.display).toBe('none');
  });

  it('shows a keyed passive error once per scope even after its automatic hide', () => {
    vi.useFakeTimers(); const container = toast(); const notices = createNotifications(container);
    notices.show('first refresh failure', { kind: 'error', passive: true, key: 'refresh' });
    vi.advanceTimersByTime(4_000); expect(container.style.display).toBe('none');
    notices.show('same refresh failure', { kind: 'error', passive: true, key: 'refresh' });
    expect(container.style.display).toBe('none');
    notices.show('different failure', { kind: 'error', passive: true, key: 'image' });
    expect(container.textContent).toContain('different failure');
    notices.resetScope(); notices.show('new route refresh failure', { kind: 'error', passive: true, key: 'refresh' });
    expect(container.textContent).toContain('new route refresh failure');
  });

  it('does not let a passive recovery error replace a sticky save failure', () => {
    const container = toast(); const notices = createNotifications(container);
    notices.show('save failed', { kind: 'error', sticky: true, actions: [{ label: 'retry', run: () => undefined }] });
    notices.show('background recovery failed', { kind: 'error', passive: true, key: 'recovery' });
    expect(container.textContent).toContain('save failed');
    expect(container.textContent).not.toContain('background recovery failed');
    expect(container.querySelector('button')?.textContent).toBe('retry');
  });

  it('renders message and action labels as text, not HTML', () => {
    const container = toast(); const notices = createNotifications(container);
    notices.show('<img src=x onerror=alert(1)>', { actions: [{ label: '<b>Retry</b>', run: () => undefined }] });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('button')?.textContent).toBe('<b>Retry</b>');
  });

  it('runs action callbacks and clears pending timers on dispose', () => {
    vi.useFakeTimers(); const container = toast(); const notices = createNotifications(container); const callback = vi.fn();
    notices.show('saved', { kind: 'success', actions: [{ label: 'open', run: callback }] });
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(callback).toHaveBeenCalledOnce();
    notices.dispose(); vi.advanceTimersByTime(10_000);
    expect(container.style.display).toBe('none');
    notices.show('after dispose'); expect(container.style.display).toBe('none');
  });
});
