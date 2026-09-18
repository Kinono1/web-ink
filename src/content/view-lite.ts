import type { Settings } from "../core/model";
import { CONTENT_THEME_CSS } from "../ui/theme";

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
  style.textContent = `${CONTENT_THEME_CSS}:host { all:initial; font:13px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif; color:var(--ink-text) } *{box-sizing:border-box} button,input{font:inherit} button{cursor:pointer} button:focus-visible,input:focus-visible{outline:3px solid var(--ink-accent);outline-offset:2px}.bar{position:fixed;display:flex;align-items:center;gap:6px;padding:8px;background:var(--ink-surface);border:1px solid var(--ink-separator);border-radius:var(--ink-radius);box-shadow:var(--ink-shadow);backdrop-filter:blur(18px);pointer-events:auto}.selection{display:none}.drawing{top:14px;left:50%;transform:translateX(-50%);display:none;flex-wrap:wrap;max-width:calc(100vw - 24px)}button{border:1px solid var(--ink-separator);background:var(--ink-fill);color:var(--ink-text);padding:5px 9px;border-radius:8px;min-height:30px}.swatch{width:26px;height:26px;min-height:26px;padding:0;border-radius:50%;border:2px solid var(--ink-surface-solid);box-shadow:0 0 0 1px var(--ink-separator)}input[type=color]{width:30px;height:30px;padding:0;border:0;background:transparent}.toast{display:none;position:fixed;bottom:22px;left:50%;transform:translateX(-50%);max-width:min(560px,90vw);border:1px solid var(--ink-separator);background:var(--ink-surface);color:var(--ink-text);border-radius:var(--ink-radius);padding:10px 14px;box-shadow:var(--ink-shadow);backdrop-filter:blur(18px);pointer-events:auto}.toast.error{border-color:var(--ink-danger);color:var(--ink-danger)}svg.layer{position:fixed;inset:0;width:100vw;height:100vh;overflow:hidden;pointer-events:none}:host([data-web-ink-reduce-transparency=true]) .bar,:host([data-web-ink-reduce-transparency=true]) .toast{background:var(--ink-surface-solid);backdrop-filter:none}@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}:host([data-web-ink-reduce-motion=true]) *{transition:none!important;animation:none!important}`;
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
export type ContentView = ReturnType<typeof createView>;
export type { Settings };
