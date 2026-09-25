import type { Settings } from "../core/model";
import { CONTENT_THEME_CSS } from "../ui/theme";


const TOAST_CSS = `
.toast {
  display:none; position:fixed; bottom:28px; left:50%;
  transform:translateX(-50%); width:max-content;
  max-width:min(560px,calc(100vw - 24px)); padding:8px 10px;
  border:1px solid var(--ink-separator); border-radius:22px;
  background:var(--ink-surface); color:var(--ink-text);
  box-shadow:var(--ink-shadow); backdrop-filter:blur(18px);
  pointer-events:auto; animation:toast-enter 140ms ease-out;
}
.toast-content {
  display:grid; grid-template-columns:18px minmax(0,1fr) 24px;
  align-items:center; column-gap:9px; row-gap:7px; min-height:24px;
}
.toast-content:has(.toast-actions) {
  grid-template-columns:18px minmax(0,1fr) auto 24px;
}
.toast-icon {
  grid-column:1; grid-row:1; width:18px; height:18px;
  align-self:start; margin-top:3px; color:var(--ink-secondary);
}
.toast-message {
  grid-column:2; grid-row:1; min-width:0; font-size:13px;
  font-weight:500; line-height:20px; overflow-wrap:anywhere;
}
.toast-actions {
  grid-column:3; grid-row:1; display:flex; align-items:center;
  gap:4px; flex-wrap:wrap; padding-left:8px; min-width:0;
  border-left:1px solid var(--ink-separator);
}
.toast-action {
  min-height:26px; max-width:100%; border:0; background:transparent;
  color:var(--ink-accent); padding:3px 6px; border-radius:7px;
  font-size:13px; line-height:20px; font-weight:500;
  white-space:normal; overflow-wrap:anywhere;
}
.toast-dismiss {
  grid-column:-2 / -1; grid-row:1; display:grid; place-items:center;
  align-self:start; width:24px; height:24px; min-height:24px;
  border:0; background:transparent; color:var(--ink-secondary);
  padding:0; border-radius:50%;
}
.toast-action:hover,.toast-dismiss:hover { background:var(--ink-fill); }
.toast-dismiss:hover { color:var(--ink-text); }
.toast button:focus-visible { outline:2px solid var(--ink-accent); outline-offset:2px; }
.toast.error { border-color:color-mix(in srgb,var(--ink-danger) 24%,var(--ink-separator)); }
.toast.success .toast-icon { color:var(--ink-success); }
.toast.error .toast-icon { color:var(--ink-danger); }
@media (max-width:480px) {
  .toast { bottom:76px; }
  .toast:has(.toast-actions) { border-radius:16px; }
  .toast-content:has(.toast-actions) { grid-template-columns:18px minmax(0,1fr) 24px; }
  .toast-actions { grid-column:2 / -1; grid-row:2; border-left:0; padding-left:0; }
}
@keyframes toast-enter {
  from { opacity:0; transform:translate(-50%,5px); }
  to { opacity:1; transform:translate(-50%,0); }
}
`;

/*
 * Floating bars: quiet borderless controls, 24 px colour circles, hairline
 * separators between groups. Same scale as the extension pages.
 */
const BAR_CSS = `
:host { all:initial; font-family:var(--ink-font); font-size:var(--ink-size-body); line-height:1.5; color:var(--ink-text); }
* { box-sizing:border-box; }
button, input { font:inherit; }
button { cursor:pointer; }
button:focus-visible, input:focus-visible { outline:2px solid var(--ink-accent); outline-offset:2px; }
.bar {
  position:fixed; display:flex; align-items:center; gap:4px; padding:6px;
  border-radius:var(--ink-radius); background:var(--ink-surface);
  box-shadow:0 0 0 1px var(--ink-separator), var(--ink-shadow);
  backdrop-filter:blur(18px) saturate(1.6); pointer-events:auto;
}
.selection { display:none; }
.drawing { top:14px; left:50%; transform:translateX(-50%); display:none; flex-wrap:wrap; max-width:calc(100vw - 24px); }
button {
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  min-height:28px; padding:4px 8px; border:0; border-radius:var(--ink-radius-control);
  color:var(--ink-text); background:transparent; font-weight:500; line-height:20px;
  transition:background-color .12s ease, transform .12s ease;
}
button:hover { background:var(--ink-fill); }
.bar button svg { display:block; width:18px; height:18px; }
button.icon { width:32px; height:32px; padding:0; }
.drawing button[aria-pressed=true] { color:var(--ink-accent); background:var(--ink-accent-fill); }
button.danger { color:var(--ink-danger); }
button.danger:hover { background:color-mix(in srgb, var(--ink-danger) 12%, transparent); }
.swatch, .more { width:24px; height:24px; min-height:24px; padding:0; border-radius:50%; }
.swatch { margin:0 2px; box-shadow:inset 0 0 0 1px rgb(0 0 0 / 12%); }
.swatch:hover { transform:scale(1.12); }
.more { color:var(--ink-secondary); background:var(--ink-fill); }
.more:hover { color:var(--ink-text); background:var(--ink-fill-hover, var(--ink-fill)); }
.bar .more svg { width:16px; height:16px; }
input[type=color] { width:24px; height:24px; margin:0 4px; padding:0; border:0; border-radius:50%; background:transparent; cursor:pointer; }
input[type=color]::-webkit-color-swatch-wrapper { padding:0; }
input[type=color]::-webkit-color-swatch { border:0; border-radius:50%; box-shadow:inset 0 0 0 1px rgb(0 0 0 / 12%); }
.sep { align-self:stretch; width:1px; margin:4px 2px; background:var(--ink-separator); }
.brand { padding:0 4px 0 6px; color:var(--ink-secondary); font-size:var(--ink-size-meta); font-weight:600; }
.hint { padding:0 6px; color:var(--ink-secondary); }
`;

const NS = "http://www.w3.org/2000/svg";
export function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs))
    element.setAttribute(key, String(value));
  return element;
}
export function createView() {
  const host = document.createElement("web-ink-ui");
  host.dataset.webInk = "true";
  host.dataset.webInkUi = "true";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    pointerEvents: "none",
  });
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `${CONTENT_THEME_CSS}${BAR_CSS}${TOAST_CSS}svg.layer{position:fixed;inset:0;width:100vw;height:100vh;overflow:hidden;pointer-events:none}:host([data-web-ink-reduce-transparency=true]) .bar,:host([data-web-ink-reduce-transparency=true]) .toast{background:var(--ink-surface-solid);backdrop-filter:none}@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}:host([data-web-ink-reduce-motion=true]) *{transition:none!important;animation:none!important}`;
  const svg = svgElement("svg", { class: "layer", "aria-hidden": "true" });
  const selection = document.createElement("div");
  selection.className = "bar selection";
  const drawing = document.createElement("div");
  drawing.className = "bar drawing";
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  root.append(style, svg, selection, drawing, toast);
  document.documentElement.append(host);
  const applyPreferences = (settings: Settings) => {
    host.dataset.webInkTheme = settings.theme ?? "system";
    host.dataset.webInkReduceMotion = String(settings.reduceMotion === true);
    host.dataset.webInkReduceTransparency = String(
      settings.reduceTransparency === true,
    );
  };
  applyPreferences({
    language: "zh-CN",
    defaultColor: "#facc15",
    disabledOrigins: [],
    theme: "system",
    reduceMotion: false,
    reduceTransparency: false,
  });
  return { host, root, svg, selection, drawing, toast, applyPreferences };
}
export function button(
  label: string,
  action: () => void,
  title?: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.setAttribute("aria-label", title ?? label);
  b.title = title ?? label;
  b.addEventListener("click", action);
  return b;
}
/** A hairline between toolbar groups. */
export function separator(): HTMLSpanElement {
  const line = document.createElement("span");
  line.className = "sep";
  line.setAttribute("aria-hidden", "true");
  return line;
}
export type ContentView = ReturnType<typeof createView>;
export type { Settings };
