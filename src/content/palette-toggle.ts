export interface PaletteToggleState {
  enabled: boolean;
  busy?: boolean;
  blocked?: boolean;
  language: 'zh-CN' | 'en';
}

export interface PaletteToggle {
  button: HTMLButtonElement;
  update: (state: PaletteToggleState) => void;
  dispose: () => void;
}

const NS = 'http://www.w3.org/2000/svg';

/** A fixed, small control that lives inside the extension shadow UI without taking page clicks. */
export function createPaletteToggle(root: ShadowRoot, onToggle: () => void): PaletteToggle {
  const style = document.createElement('style');
  style.dataset.webInkPaletteToggle = 'true';
  style.textContent = `
    .web-ink-palette-toggle { position:fixed; right:18px; bottom:18px; width:40px; height:40px; padding:0; border-radius:50%; border:1px solid #ffffffcc; box-shadow:0 3px 12px #17223542; display:grid; place-items:center; cursor:pointer; pointer-events:auto; color:#172235; background:#eef2f7; transition:background-color .16s ease, transform .16s ease, box-shadow .16s ease; }
    .web-ink-palette-toggle[data-enabled=true] { background:conic-gradient(from 210deg, #facc15, #fb7185, #c084fc, #38bdf8, #4ade80, #facc15); color:#10253e; }
    .web-ink-palette-toggle[data-enabled=false] svg { filter:grayscale(1); opacity:.72; }
    .web-ink-palette-toggle:not(:disabled):hover { transform:translateY(-1px); box-shadow:0 5px 16px #17223555; }
    .web-ink-palette-toggle:focus-visible { outline:3px solid #38bdf8; outline-offset:3px; }
    .web-ink-palette-toggle:disabled { cursor:not-allowed; opacity:.57; filter:grayscale(.75); }
    .web-ink-palette-toggle svg { width:22px; height:22px; } .web-ink-palette-toggle .state-dot { position:absolute; right:5px; bottom:5px; width:6px; height:6px; border:1px solid #fff; border-radius:50%; background:#8b98a9; } .web-ink-palette-toggle[data-enabled=true] .state-dot { background:#166534; }
    @media (prefers-reduced-motion: reduce) { .web-ink-palette-toggle { transition:none; } }
  `;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'web-ink-palette-toggle'; button.dataset.webInkPaletteToggle = 'true';
  button.append(paletteIcon());
  const dot = document.createElement('span'); dot.className = 'state-dot'; dot.setAttribute('aria-hidden', 'true'); button.append(dot);
  const click = () => { if (!button.disabled) onToggle(); };
  button.addEventListener('click', click);
  root.append(style, button);

  const update = (state: PaletteToggleState) => {
    const blocked = state.blocked === true;
    const busy = state.busy === true;
    const enabled = state.enabled;
    const normal = state.language === 'zh-CN'
      ? enabled ? '关闭本页标注' : '开启本页标注'
      : enabled ? 'Disable annotations on this page' : 'Enable annotations on this page';
    button.dataset.enabled = String(enabled);
    button.dataset.blocked = String(blocked);
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-busy', String(busy));
    button.disabled = busy || blocked;
    const label = blocked ? (state.language === 'zh-CN' ? '此网站已暂停，请从侧栏恢复' : 'This site is paused. Resume it from the side panel.') : normal;
    button.title = label; button.setAttribute('aria-label', label);
  };
  update({ enabled: false, language: 'zh-CN' });
  return { button, update, dispose: () => { button.removeEventListener('click', click); style.remove(); button.remove(); } };
}

function paletteIcon(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const outer = document.createElementNS(NS, 'path');
  outer.setAttribute('d', 'M12 3.2A8.8 8.8 0 1 0 12 20h1.1a1.9 1.9 0 0 0 0-3.8h-.5a1.5 1.5 0 0 1 0-3H15a5.8 5.8 0 0 0 0-11.6H12Z');
  outer.setAttribute('fill', '#ffffffdd'); outer.setAttribute('stroke', '#172235'); outer.setAttribute('stroke-width', '1.1');
  svg.append(outer);
  for (const [cx, cy, fill] of [['8', '8.5', '#f59e0b'], ['11.5', '6.8', '#ec4899'], ['15.5', '8.6', '#8b5cf6'], ['7.8', '12.6', '#22c55e']] as const) {
    const circle = document.createElementNS(NS, 'circle'); circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', '1.15'); circle.setAttribute('fill', fill); svg.append(circle);
  }
  return svg;
}
