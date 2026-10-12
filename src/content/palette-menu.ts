import { ICON_PATHS, type IconName } from '../ui/icons';

export type PaletteAction = 'toggle' | 'open-pdf' | 'open-ieee' | 'local-pdf' | 'sidebar' | 'library' | 'retry' | 'cancel';
export interface PaletteMenuItem {
  action: PaletteAction;
  label: string;
  icon: IconName;
  primary?: boolean;
  disabled?: boolean;
  candidateUrl?: string;
}
interface MenuState {
  language: 'zh-CN' | 'en';
  items: PaletteMenuItem[];
  loading?: boolean;
  pending?: boolean;
  error?: string;
  status?: string;
  diagnostic?: string;
}

/** A transient launcher; annotation records continue to live in the side panel. */
export function createPaletteMenu(
  root: ShadowRoot,
  anchor: HTMLButtonElement,
  onVisibilityChange: (open: boolean) => void,
  onAction: (action: PaletteAction, candidateUrl?: string) => void,
) {
  const events = new AbortController();
  const style = document.createElement('style');
  style.textContent = `
    .web-ink-palette-menu[hidden] { display:none!important; }
    .web-ink-palette-menu { position:fixed; width:260px; padding:6px; border-radius:12px; background:var(--ink-surface-solid); color:var(--ink-text); box-shadow:0 0 0 1px var(--ink-separator),var(--ink-shadow); pointer-events:auto; overflow:auto; }
    .web-ink-palette-menu button { display:flex; align-items:center; gap:10px; width:100%; min-height:36px; padding:8px 10px; border:0; border-radius:8px; text-align:left; background:transparent; color:var(--ink-text); font:inherit; line-height:20px; overflow-wrap:anywhere; }
    .web-ink-palette-menu button:hover { background:var(--ink-fill); }
    .web-ink-palette-menu button[data-primary=true] { font-weight:600; }
    .web-ink-palette-menu button:disabled { opacity:.5; cursor:default; }
    .web-ink-palette-menu button:focus-visible { outline:2px solid var(--ink-accent); outline-offset:-2px; }
    .web-ink-palette-menu svg { width:18px; height:18px; flex:none; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
    .web-ink-palette-menu p { margin:6px 10px; font-size:12px; line-height:18px; color:var(--ink-secondary); overflow-wrap:anywhere; }
    .web-ink-palette-menu [role=alert] { color:var(--ink-danger); }
  `;
  const panel = document.createElement('div');
  panel.className = 'web-ink-palette-menu';
  panel.id = 'web-ink-palette-menu';
  panel.setAttribute('role', 'menu');
  panel.hidden = true;
  root.append(style, panel);
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-controls', panel.id);
  anchor.setAttribute('aria-expanded', 'false');
  let state: MenuState = { language: 'zh-CN', items: [] };
  let disposed = false;
  let pendingFocus: PaletteMenuItem | undefined;
  const position = () => {
    const width = Math.min(260, Math.max(0, innerWidth - 24));
    const left = Number.parseFloat(anchor.style.left) || 0;
    const top = Number.parseFloat(anchor.style.top) || 0;
    panel.style.width = `${width}px`;
    panel.style.maxWidth = `${Math.max(0, innerWidth - 24)}px`;
    panel.style.maxHeight = `${Math.max(0, innerHeight - 24)}px`;
    const height = Math.min(panel.offsetHeight || state.items.length * 36 + 16, Math.max(0, innerHeight - 24));
    panel.style.left = `${Math.max(12, Math.min(left + 40 - width, innerWidth - width - 12))}px`;
    const preferredTop = top - height - 8 >= 12 ? top - height - 8 : top + 48;
    panel.style.top = `${Math.max(12, Math.min(preferredTop, innerHeight - height - 12))}px`;
  };
  const close = (restoreFocus = false) => {
    if (panel.hidden) return;
    panel.hidden = true;
    pendingFocus = undefined;
    anchor.setAttribute('aria-expanded', 'false');
    onVisibilityChange(false);
    if (restoreFocus) anchor.focus();
  };
  const toggle = () => {
    if (disposed || anchor.disabled) return;
    if (!panel.hidden) { close(); return; }
    panel.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    onVisibilityChange(true);
    position();
  };
  const buttons = () => [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const key = (event: KeyboardEvent) => {
    const path = event.composedPath();
    const atAnchor = path.includes(anchor);
    if (disposed || (panel.hidden && !atAnchor)) return;
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault(); event.stopPropagation(); close(true); return;
    }
    if (!atAnchor && !path.includes(panel)) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (panel.hidden) toggle();
    const items = buttons();
    const index = items.indexOf(root.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : index === -1 ? event.key === 'ArrowUp' ? items.length - 1 : 0
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  document.addEventListener('pointerdown', event => {
    const path = event.composedPath();
    if (!path.includes(panel) && !path.includes(anchor)) close();
  }, { signal: events.signal });
  document.addEventListener('focusin', event => {
    const path = event.composedPath();
    if (!path.includes(panel) && !path.includes(anchor)) {
      close();
      return;
    }
    const index = [...panel.querySelectorAll('button')].indexOf(path[0] as HTMLButtonElement);
    pendingFocus = index >= 0 ? state.items[index] : undefined;
  }, { signal: events.signal });
  // Runs after the pen's capture handler, so Escape also releases a pressed pointer.
  window.addEventListener('keydown', key, { signal: events.signal, capture: true });
  anchor.addEventListener('pointermove', () => {
    if (anchor.dataset.dragging === 'true') close();
  }, { signal: events.signal });
  anchor.addEventListener('pointerup', () => {
    if (anchor.dataset.dragging === 'true') close();
  }, { signal: events.signal });
  window.addEventListener('resize', position, { signal: events.signal });
  window.addEventListener('blur', event => { if (event.target === window) close(); }, { signal: events.signal });
  const update = (next: Partial<MenuState>) => {
    if (disposed) return;
    const focused = root.activeElement as HTMLButtonElement | null;
    const activeIndex = [...panel.querySelectorAll('button')].indexOf(focused!);
    const focusedItem = activeIndex >= 0 ? state.items[activeIndex] : undefined;
    if (focusedItem) pendingFocus = focusedItem;
    state = { ...state, ...next };
    const label = state.language === 'zh-CN' ? '打开 Web Ink 菜单' : 'Open Web Ink menu';
    anchor.title = label; anchor.setAttribute('aria-label', label);
    panel.setAttribute('aria-label', 'Web Ink');
    panel.setAttribute('aria-busy', String(Boolean(state.pending || state.loading)));
    panel.replaceChildren();
    for (const item of state.items) {
      const button = document.createElement('button'); button.type = 'button';
      button.setAttribute('role', 'menuitem'); button.dataset.action = item.action;
      button.dataset.primary = String(Boolean(item.primary));
      button.disabled = Boolean(item.disabled || (state.pending && item.action !== 'cancel'));
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(icon.namespaceURI, 'path'); path.setAttribute('d', ICON_PATHS[item.icon]); icon.append(path);
      const text = document.createElement('span'); text.textContent = item.label; button.append(icon, text);
      // Keep an embedded reader from stealing focus and closing the menu before click.
      button.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button === 0) event.preventDefault();
      });
      button.addEventListener('click', event => {
        if (!disposed && (!state.pending || item.action === 'cancel') && !button.disabled &&
          (item.action !== 'open-ieee' || event.isTrusted))
          onAction(item.action, item.candidateUrl);
      });
      panel.append(button);
    }
    if (state.loading || state.pending || state.error) {
      const message = document.createElement('p');
      message.setAttribute('role', state.error ? 'alert' : 'status');
      message.textContent = state.error || state.status || (state.language === 'zh-CN'
        ? state.pending ? '正在打开…' : '正在识别页面…'
        : state.pending ? 'Opening…' : 'Checking this page…');
      panel.append(message);
    }
    if (state.diagnostic) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = state.language === 'zh-CN' ? '诊断详情' : 'Diagnostic details';
      const pre = document.createElement('pre'); pre.textContent = state.diagnostic;
      pre.style.cssText = 'font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px;user-select:text';
      const copy = document.createElement('button'); copy.type = 'button';
      copy.textContent = state.language === 'zh-CN' ? '复制诊断摘要' : 'Copy diagnostic summary';
      copy.addEventListener('click', () => { void navigator.clipboard.writeText(state.diagnostic!).then(() => {
        copy.textContent = state.language === 'zh-CN' ? '已复制' : 'Copied';
      }).catch(() => { pre.focus(); }); });
      details.append(summary, pre, copy); panel.append(details);
    }
    if (!panel.hidden) {
      position();
      const focusToRestore = pendingFocus;
      if (!state.pending && focusToRestore) {
        const nextIndex = state.items.findIndex(item =>
          item.action === focusToRestore.action && item.candidateUrl === focusToRestore.candidateUrl,
        );
        const next = panel.querySelectorAll<HTMLButtonElement>('button')[nextIndex];
        if (next && !next.disabled) next.focus();
        else anchor.focus();
        pendingFocus = undefined;
      }
    }
  };
  update({});
  return {
    toggle, close, update, isOpen: () => !disposed && !panel.hidden,
    dispose: () => {
      if (disposed) return;
      close(); disposed = true; events.abort(); panel.remove(); style.remove();
      anchor.removeAttribute('aria-haspopup'); anchor.removeAttribute('aria-controls'); anchor.removeAttribute('aria-expanded');
    },
  };
}
