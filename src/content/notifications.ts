import { svgElement } from "./view-lite";
export type NotificationKind = "info" | "success" | "error";
export interface NotificationAction {
  label: string;
  run: () => void;
}
export interface NotificationOptions {
  kind?: NotificationKind;
  /** Stable identity for deduplicating background/passive errors within one route. */
  key?: string;
  /** Passive messages come from refresh/recovery rather than an immediate user action. */
  passive?: boolean;
  /** Allow an explicit retry to report a previously dismissed passive error. */
  repeat?: boolean;
  /** Sticky messages remain until dismissed or explicitly replaced. */
  sticky?: boolean;
  actions?: NotificationAction[];
  dismissLabel?: string;
}
export interface Notifications {
  show: (message: string, options?: NotificationOptions) => void;
  hide: () => void;
  clear: (key: string) => void;
  /** Call on a true page/route change so a previously dismissed passive error may appear again. */
  resetScope: () => void;
  dispose: () => void;
}
type Active = { key?: string; passive: boolean; sticky: boolean };
const SUCCESS_MS = 2_500;
const INFO_MS = 4_000;
const TOAST_PATH: Record<NotificationKind, string> = {
  success: "m5.8 9 2.05 2.1 4.35-4.5",
  error: "M9 5.35v4.25M9 12.55h.01",
  info: "M9 8.1v4.15M9 5.5h.01",
};
function toastIcon(kind: NotificationKind): SVGSVGElement {
  const icon = svgElement("svg", {
    class: "toast-icon", "aria-hidden": "true", viewBox: "0 0 18 18", width: 18, height: 18,
    fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round",
  });
  icon.append(svgElement("circle", { cx: 9, cy: 9, r: 6.5 }), svgElement("path", { d: TOAST_PATH[kind] }));
  return icon;
}
function dismissIcon(): SVGSVGElement {
  const icon = svgElement("svg", {
    "aria-hidden": "true", viewBox: "0 0 12 12", width: 12, height: 12,
    fill: "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linecap": "round",
  });
  icon.append(svgElement("path", { d: "m2 2 8 8m0-8-8 8" }));
  return icon;
}
/**
 * Small DOM-only toast controller. It deliberately has no global state, so each content
 * document owns its dismissal scope and disposal clears every scheduled callback.
 */
export function createNotifications(container: HTMLElement): Notifications {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let active: Active | undefined;
  let disposed = false;
  const dismissedPassive = new Set<string>();
  const seenPassive = new Set<string>();
  const clearTimer = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const hide = () => {
    clearTimer();
    active = undefined;
    container.replaceChildren();
    container.classList.remove("error");
    container.classList.remove("success");
    container.style.display = "none";
  };
  const dismiss = () => {
    if (active?.passive && active.key) dismissedPassive.add(active.key);
    hide();
  };
  const clear = (key: string) => {
    if (active?.key === key) hide();
    dismissedPassive.delete(key);
    seenPassive.delete(key);
  };
  const show = (message: string, options: NotificationOptions = {}) => {
    if (disposed) return;
    const kind = options.kind ?? "info";
    const passive = options.passive === true;
    const sticky = options.sticky === true;
    const key = options.key;
    if (passive && key && !options.repeat && (dismissedPassive.has(key) || seenPassive.has(key))) return;
    // A background refresh must never replace the retry/discard affordance of a failed save.
    if (passive && active?.sticky) return;
    // Repeated status publication should not redraw or extend its own timer.
    if (passive && key && active?.passive && active.key === key) return;
    clearTimer();
    active = { ...(key === undefined ? {} : { key }), passive, sticky };
    container.replaceChildren();
    container.classList.toggle("error", kind === "error");
    container.classList.toggle("success", kind === "success");
    container.style.display = "block";
    const content = document.createElement("div");
    content.className = "toast-content";
    const text = document.createElement("div");
    text.className = "toast-message";
    text.textContent = message;
    content.append(toastIcon(kind), text);
    const actions = options.actions ?? [];
    if (actions.length > 0) {
      const actionGroup = document.createElement("div");
      actionGroup.className = "toast-actions";
      for (const action of actions) {
        const button = document.createElement("button");
        button.className = "toast-action";
        button.type = "button";
        button.textContent = action.label;
        button.addEventListener("click", action.run);
        actionGroup.append(button);
      }
      content.append(actionGroup);
    }
    const close = document.createElement("button");
    close.className = "toast-dismiss";
    close.type = "button";
    close.setAttribute("aria-label", options.dismissLabel ?? "Dismiss");
    close.addEventListener("click", dismiss);
    close.append(dismissIcon());
    content.append(close);
    container.append(content);
    // Record only after rendering: a passive event blocked by a sticky save failure
    // must remain eligible to appear once that user-facing failure is resolved.
    if (passive && key) seenPassive.add(key);
    if (!sticky) { timeout = setTimeout(hide, kind === "success" ? SUCCESS_MS : INFO_MS); }
  };
  const resetScope = () => {
    dismissedPassive.clear();
    seenPassive.clear();
    hide();
  };
  const dispose = () => {
    disposed = true;
    dismissedPassive.clear();
    seenPassive.clear();
    hide();
  };
  hide();
  return { show, hide, clear, resetScope, dispose };
}
