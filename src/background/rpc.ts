import { createFloatingActionHandler } from "./floating-actions";
import { createMessageRouter, type RouterDeps } from "./router";

export type { PageState } from "./router";

export function installBackgroundRpc(runtime: Omit<RouterDeps, "handleFloatingAction">): void {
  const route = createMessageRouter({
    ...runtime,
    handleFloatingAction: createFloatingActionHandler(runtime.resolveContentPage),
  });
  chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
    const response = route(raw, sender);
    if (!response) return false;
    void response.then(respond);
    return true;
  });
}
