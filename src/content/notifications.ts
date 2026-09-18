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
  /** Sticky messages remain until dismissed or explicitly replaced. */
  sticky?: boolean;
  actions?: NotificationAction[];
  dismissLabel?: string;
}

export interface Notifications {
  show: (message: string, options?: NotificationOptions) => void;
  hide: () => void;
  /** Call on a true page/route change so a previously dismissed passive error may appear again. */
  resetScope: () => void;
  dispose: () => void;
}

type Active = { key?: string; passive: boolean; sticky: boolean };
const SUCCESS_MS = 2_500;
const INFO_MS = 4_000;

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
    container.style.display = "none";
  };
  const dismiss = () => {
    if (active?.passive && active.key) dismissedPassive.add(active.key);
    hide();
  };
  const show = (message: string, options: NotificationOptions = {}) => {
    if (disposed) return;
    const kind = options.kind ?? "info";
    const passive = options.passive === true;
    const sticky = options.sticky === true;
    const key = options.key;
    if (passive && key && (dismissedPassive.has(key) || seenPassive.has(key)))
      return;
    // A background refresh must never replace the retry/discard affordance of a failed save.
    if (passive && active?.sticky) return;
    // Repeated status publication should not redraw or extend its own timer.
    if (passive && key && active?.passive && active.key === key) return;

    clearTimer();
    active = { ...(key === undefined ? {} : { key }), passive, sticky };
    container.replaceChildren();
    container.classList.toggle("error", kind === "error");
    container.style.display = "block";
    const text = document.createTextNode(message);
    container.append(text);
    for (const action of options.actions ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", action.run);
      container.append(button);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", options.dismissLabel ?? "Dismiss");
    close.addEventListener("click", dismiss);
    container.append(close);
    // Record only after rendering: a passive event blocked by a sticky save failure
    // must remain eligible to appear once that user-facing failure is resolved.
    if (passive && key) seenPassive.add(key);

    if (!sticky) {
      timeout = setTimeout(hide, kind === "success" ? SUCCESS_MS : INFO_MS);
    }
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
  return { show, hide, resetScope, dispose };
}
