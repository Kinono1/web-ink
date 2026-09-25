import { ICON_PATHS } from "../ui/icons";

export interface PaletteToggleState {
  enabled: boolean;
  busy?: boolean;
  blocked?: boolean;
  language: "zh-CN" | "en";
}

export interface PaletteToggle {
  button: HTMLButtonElement;
  update: (state: PaletteToggleState) => void;
  dispose: () => void;
}

const NS = "http://www.w3.org/2000/svg";

/** A fixed, small control that lives inside the extension shadow UI without taking page clicks. */
export function createPaletteToggle(
  root: ShadowRoot,
  onToggle: () => void,
): PaletteToggle {
  const style = document.createElement("style");
  style.dataset.webInkPaletteToggle = "true";
  style.textContent = `
    .web-ink-palette-toggle { position:fixed; right:18px; bottom:18px; width:40px; height:40px; min-height:40px; padding:0; border:0; border-radius:50%; display:grid; place-items:center; cursor:pointer; pointer-events:auto; color:var(--ink-secondary); background:var(--ink-surface-solid); box-shadow:0 0 0 1px var(--ink-separator), var(--ink-shadow); transition:background-color .16s ease, color .16s ease, transform .16s ease; }
    .web-ink-palette-toggle:not(:disabled):hover { color:var(--ink-text); transform:translateY(-1px); }
    .web-ink-palette-toggle[data-enabled=true] { color:#fff; background:var(--ink-accent); box-shadow:0 0 0 1px transparent, var(--ink-shadow); }
    .web-ink-palette-toggle[data-enabled=true]:not(:disabled):hover { color:#fff; }
    .web-ink-palette-toggle:focus-visible { outline:2px solid var(--ink-accent); outline-offset:3px; }
    .web-ink-palette-toggle:disabled { cursor:not-allowed; opacity:.5; }
    .web-ink-palette-toggle svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
    @media (prefers-reduced-motion: reduce) { .web-ink-palette-toggle { transition:none; } }
  `;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "web-ink-palette-toggle";
  button.dataset.webInkPaletteToggle = "true";
  button.append(highlighterIcon());
  const click = () => {
    if (!button.disabled) onToggle();
  };
  button.addEventListener("click", click);
  root.append(style, button);

  const update = (state: PaletteToggleState) => {
    const blocked = state.blocked === true;
    const busy = state.busy === true;
    const enabled = state.enabled;
    const normal =
      state.language === "zh-CN"
        ? enabled
          ? "关闭本页标注"
          : "开启本页标注"
        : enabled
          ? "Disable annotations on this page"
          : "Enable annotations on this page";
    button.dataset.enabled = String(enabled);
    button.dataset.blocked = String(blocked);
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-busy", String(busy));
    button.disabled = busy || blocked;
    const label = blocked
      ? state.language === "zh-CN"
        ? "此网站已暂停，请从侧栏恢复"
        : "This site is paused. Resume it from the side panel."
      : normal;
    button.title = label;
    button.setAttribute("aria-label", label);
  };
  update({ enabled: false, language: "zh-CN" });
  return {
    button,
    update,
    dispose: () => {
      button.removeEventListener("click", click);
      style.remove();
      button.remove();
    },
  };
}

/** A monochrome highlighter; colour belongs to the page's marks, not the control. */
function highlighterIcon(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICON_PATHS.highlight);
  svg.append(path);
  return svg;
}
