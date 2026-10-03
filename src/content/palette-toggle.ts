import { ICON_PATHS } from "../ui/icons";
import {
  clampPalettePoint,
  defaultPalettePoint,
  fromPalettePosition,
  isPaletteDrag,
  readPalettePosition,
  toPalettePosition,
  type PaletteGeometry,
  type PalettePoint,
  type PalettePosition,
} from "./palette-position";

export interface PaletteToggleState {
  enabled: boolean;
  busy?: boolean;
  blocked?: boolean;
  language: "zh-CN" | "en";
}

export interface PaletteToggle {
  button: HTMLButtonElement;
  update: (state: PaletteToggleState) => void;
  setPosition: (position?: PalettePosition) => void;
  dispose: () => void;
}

const NS = "http://www.w3.org/2000/svg";

/** A fixed, small control that lives inside the extension shadow UI without taking page clicks. */
export function createPaletteToggle(
  root: ShadowRoot,
  onToggle: () => void,
  onPositionChange?: (position: PalettePosition) => void,
): PaletteToggle {
  const style = document.createElement("style");
  style.dataset.webInkPaletteToggle = "true";
  style.textContent = `
    .web-ink-palette-toggle { position:fixed; width:40px; height:40px; min-height:40px; padding:0; border:0; border-radius:50%; display:grid; place-items:center; cursor:grab; touch-action:none; user-select:none; pointer-events:auto; color:var(--ink-secondary); background:var(--ink-surface-solid); box-shadow:0 0 0 1px var(--ink-separator), var(--ink-shadow); transition:background-color .16s ease, color .16s ease, transform .16s ease; }
    .web-ink-palette-toggle:not(:disabled):hover { color:var(--ink-text); transform:translateY(-1px); }
    .web-ink-palette-toggle[data-enabled=true] { color:#fff; background:var(--ink-accent); box-shadow:0 0 0 1px transparent, var(--ink-shadow); }
    .web-ink-palette-toggle[data-enabled=true]:not(:disabled):hover { color:#fff; }
    .web-ink-palette-toggle[data-dragging=true] { cursor:grabbing; transform:none!important; transition:none!important; }
    .web-ink-palette-toggle:focus-visible { outline:2px solid var(--ink-accent); outline-offset:3px; }
    .web-ink-palette-toggle:disabled { cursor:not-allowed; opacity:.5; }
    .web-ink-palette-toggle svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
    @media (prefers-reduced-motion: reduce) { .web-ink-palette-toggle { transition:none; } }
  `;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "web-ink-palette-toggle";
  button.dataset.webInkPaletteToggle = "true";
  button.dataset.dragging = "false";
  button.append(highlighterIcon());
  let disposed = false;
  let interacted = false;
  let position: PalettePosition | undefined;
  let frame: number | undefined;
  let suppressClick = false;
  let drag: {
    pointer: number;
    startX: number;
    startY: number;
    origin: PalettePoint;
    point: PalettePoint;
    moved: boolean;
  } | undefined;
  const events = new AbortController();
  const geometry = (): PaletteGeometry => {
    const rect = button.getBoundingClientRect();
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      buttonWidth: rect.width || 40,
      buttonHeight: rect.height || 40,
    };
  };
  const place = (point: PalettePoint) => {
    button.style.left = `${point.left}px`;
    button.style.top = `${point.top}px`;
  };
  const restore = () => {
    const bounds = geometry();
    place(position ? fromPalettePosition(position, bounds) : defaultPalettePoint(bounds));
  };
  const clearFrame = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const release = (pointer: number) => {
    // Clear the gesture first: release can synchronously cause lostpointercapture.
    if (button.hasPointerCapture(pointer)) button.releasePointerCapture(pointer);
  };
  const cancel = () => {
    const active = drag;
    if (!active) return;
    drag = undefined;
    clearFrame();
    suppressClick = true;
    button.dataset.dragging = "false";
    restore();
    release(active.pointer);
  };
  const advance = (event: PointerEvent) => {
    const active = drag;
    if (!active || event.pointerId !== active.pointer) return false;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    active.moved ||= isPaletteDrag(dx, dy);
    if (!active.moved) return false;
    button.dataset.dragging = "true";
    active.point = clampPalettePoint({ left: active.origin.left + dx, top: active.origin.top + dy }, geometry());
    return true;
  };
  const down = (event: PointerEvent) => {
    if (disposed || button.disabled || drag || !event.isPrimary || event.button !== 0) return;
    interacted = true;
    suppressClick = false;
    // Use layout coordinates, excluding the decorative hover transform.
    const origin = { left: Number.parseFloat(button.style.left), top: Number.parseFloat(button.style.top) };
    try { button.setPointerCapture(event.pointerId); } catch { return; }
    drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, origin, point: origin, moved: false };
    event.stopPropagation();
  };
  const move = (event: PointerEvent) => {
    if (!advance(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (frame === undefined) frame = requestAnimationFrame(() => {
      frame = undefined;
      if (drag?.moved) place(drag.point);
    });
  };
  const up = (event: PointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    advance(event);
    const active = drag;
    drag = undefined;
    clearFrame();
    button.dataset.dragging = "false";
    suppressClick = active.moved;
    if (active.moved) {
      position = toPalettePosition(active.point, geometry());
      restore();
      event.preventDefault();
      event.stopPropagation();
    }
    release(active.pointer);
    if (active.moved) onPositionChange?.({ ...position! });
  };
  const interrupted = (event: PointerEvent) => {
    if (event.pointerId === drag?.pointer) cancel();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape" && drag) {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  const click = (event: MouseEvent) => {
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!button.disabled && !disposed) onToggle();
  };
  button.addEventListener("click", click, { signal: events.signal });
  button.addEventListener("pointerdown", down, { signal: events.signal });
  button.addEventListener("pointermove", move, { signal: events.signal });
  button.addEventListener("pointerup", up, { signal: events.signal });
  button.addEventListener("pointercancel", interrupted, { signal: events.signal });
  button.addEventListener("lostpointercapture", interrupted, { signal: events.signal });
  window.addEventListener("keydown", key, { signal: events.signal });
  window.addEventListener("blur", cancel, { signal: events.signal });
  window.addEventListener("resize", () => { cancel(); restore(); }, { signal: events.signal });
  root.append(style, button);
  restore();

  const update = (state: PaletteToggleState) => {
    const blocked = state.blocked === true;
    const busy = state.busy === true;
    const enabled = state.enabled;
    if (busy || blocked) cancel();
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
    setPosition: (next) => {
      if (disposed || interacted) return;
      position = readPalettePosition(next);
      restore();
    },
    dispose: () => {
      if (disposed) return;
      cancel();
      clearFrame();
      disposed = true;
      events.abort();
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
