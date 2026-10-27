import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnnotationController } from "../../../src/content/engine/AnnotationController";
import { createView } from "../../../src/content/view-lite";
import { DEFAULT_SETTINGS } from "../../../src/core/model";

let controller: AnnotationController;
let failure: string | undefined;
let savedEnabled: boolean;
let writes: string[];
let onMessage: (message: { type: string }, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown;

beforeEach(() => {
  window.history.replaceState(null, "", "/initial-recovery");
  savedEnabled = true;
  writes = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: { addListener(listener: typeof onMessage) { onMessage = listener; }, removeListener() {} },
      sendMessage: async (message: { type: string }) => {
        if (message.type === failure) throw Error("read failed");
        if (message.type === "settings.get") return { ok: true, data: DEFAULT_SETTINGS };
        if (message.type === "page.mode.get") return { ok: true, data: { enabled: savedEnabled } };
        if (message.type === "annotations.list") return { ok: true, data: [
          { id: "saved", kind: "text", pageUrl: location.href, revision: 1, target: { exact: "saved text" } },
        ] };
        writes.push(message.type);
        return { ok: true, data: true };
      },
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } },
  });
});

afterEach(() => {
  controller?.stop();
  document.body.replaceChildren();
  failure = undefined;
  vi.unstubAllGlobals();
});

it.each(["settings.get", "page.mode.get"])("reports unknown state after %s fails and retries on user action", async failedRead => {
  failure = failedRead;
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  expect(controller.modeReady).toBe(false);
  controller.dispatch("focus", "missing");
  await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
  expect(writes).not.toContain("page.mode.put");
  expect(savedEnabled).toBe(true);
  failure = undefined;
  controller.dispatch("focus", "missing");
  await vi.waitFor(() => expect(controller.enabled()).toBe(true));
  await vi.waitFor(() => expect(controller.store.annotations.map(record => record.id)).toEqual(["saved"]));
  expect(writes).not.toContain("page.mode.put");
});

it("keeps a confirmed disabled page quiet when settings fail", async () => {
  savedEnabled = false;
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
  expect(view.toast.textContent).toBe("");
  expect(controller.modeReady).toBe(false);
});

it("reports an unknown new mode instead of trusting a previously disabled mode", async () => {
  savedEnabled = false;
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(controller.modeReady).toBe(true));
  expect(controller.enabled()).toBe(false);
  savedEnabled = true;
  failure = "settings.get";
  const send = chrome.runtime.sendMessage;
  let finishOldMode!: (value: unknown) => void;
  let firstMode = true;
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === "page.mode.get" && firstMode) {
      firstMode = false;
      return new Promise<unknown>(resolve => { finishOldMode = resolve; });
    }
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  try {
    onMessage({ type: "page.mode.changed" }, {}, () => {});
    await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
    failure = undefined;
    controller.dispatch("focus", "saved");
    await vi.waitFor(() => expect(controller.store.annotations.map(record => record.id)).toEqual(["saved"]));
    expect(controller.enabled()).toBe(true);
    expect(writes).not.toContain("page.mode.put");
    finishOldMode({ ok: true, data: { enabled: false } });
    await Promise.resolve();
    expect(controller.enabled()).toBe(true);
  } finally {
    controller.stop();
    finishOldMode({ ok: true, data: { enabled: true } });
    await Promise.resolve();
  }
});

it.each([
  ["settings.get", "page.mode.get"],
  ["page.mode.get", "settings.get"],
])("reports %s failure without waiting for a pending %s", async (failedRead, pendingRead) => {
  let finishPending!: (value: unknown) => void;
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === failedRead) return Promise.reject(Error("read failed"));
    if (message.type === pendingRead)
      return new Promise<unknown>(resolve => { finishPending = resolve; });
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  const view = createView();
  controller = new AnnotationController(view);
  try {
    await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
    expect(controller.sync.refreshDepth).toBe(0);
    expect(controller.modeReady).toBe(false);
    expect(writes).not.toContain("page.mode.put");
  } finally {
    controller.stop();
    finishPending({ ok: true, data: pendingRead === "settings.get" ? DEFAULT_SETTINGS : { enabled: false } });
    await Promise.resolve();
  }
});

it("keeps the newer successful refresh when an older mode read resolves late", async () => {
  let finishOldMode!: (value: unknown) => void;
  let firstSettings = true;
  let firstMode = true;
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === "settings.get" && firstSettings) {
      firstSettings = false;
      return Promise.reject(Error("read failed"));
    }
    if (message.type === "page.mode.get" && firstMode) {
      firstMode = false;
      return new Promise<unknown>(resolve => { finishOldMode = resolve; });
    }
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  const view = createView();
  controller = new AnnotationController(view);
  try {
    await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
    await controller.sync.refresh();
    expect(controller.enabled()).toBe(true);
    finishOldMode({ ok: true, data: { enabled: false } });
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.enabled()).toBe(true);
    expect(controller.store.annotations.map(record => record.id)).toEqual(["saved"]);
  } finally {
    controller.stop();
    finishOldMode({ ok: true, data: { enabled: false } });
  }
});

it("does not redisplay a dismissed failure when the error changes", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  view.toast.querySelector<HTMLButtonElement>(".toast-dismiss")!.click();
  chrome.runtime.sendMessage = (async () => ({ ok: false, error: "different failure", code: "OTHER" })) as typeof chrome.runtime.sendMessage;
  await controller.sync.refresh();
  expect(view.toast.textContent).toBe("");
});

it.each(["focus", "refresh"] as const)("reports a repeated failure after an explicit %s", async action => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  view.toast.querySelector<HTMLButtonElement>(".toast-dismiss")!.click();
  controller.dispatch(action, "missing");
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
});

it("retries a failed annotation read on focus even after mode is ready", async () => {
  failure = "annotations.list";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  expect(controller.modeReady).toBe(true);
  view.toast.querySelector<HTMLButtonElement>(".toast-dismiss")!.click();
  controller.dispatch("focus", "missing");
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  failure = undefined;
  controller.dispatch("focus", "saved");
  await vi.waitFor(() => expect(controller.store.annotations.map(record => record.id)).toEqual(["saved"]));
});

it("clears the recovery error after a successful restore", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  failure = undefined;
  await controller.sync.refresh();
  expect(controller.store.annotations.map(record => record.id)).toEqual(["saved"]);
  expect(view.toast.textContent).toBe("");
});

it("reports a new background failure after recovery succeeds", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  view.toast.querySelector<HTMLButtonElement>(".toast-dismiss")!.click();
  failure = undefined;
  await controller.sync.refresh();
  failure = "settings.get";
  await controller.sync.refresh();
  expect(view.toast.textContent).toContain("暂时无法恢复此页标注");
});

it("reports an explicit retry superseded by a failing background refresh", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  view.toast.querySelector<HTMLButtonElement>(".toast-dismiss")!.click();
  const send = chrome.runtime.sendMessage;
  let finishRetry!: (value: unknown) => void;
  const focus = vi.spyOn(controller.render, "focusRecord");
  let pending = true;
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === "settings.get" && pending) {
      pending = false;
      return new Promise<unknown>(resolve => { finishRetry = resolve; });
    }
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  try {
    controller.dispatch("focus", "saved");
    await vi.waitFor(() => expect(pending).toBe(false));
    await controller.sync.refresh();
    expect(view.toast.textContent).toContain("暂时无法恢复此页标注");
    finishRetry({ ok: true, data: DEFAULT_SETTINGS });
    await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
    expect(focus).not.toHaveBeenCalled();
  } finally {
    controller.stop();
    finishRetry({ ok: true, data: DEFAULT_SETTINGS });
    await Promise.resolve();
  }
});

it.each(["navigation", "navigation-return", "revocation", "stop"] as const)("does not replay a superseded focus after %s", async transition => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  failure = undefined;
  const send = chrome.runtime.sendMessage;
  const completions: Array<(value: unknown) => void> = [];
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === "settings.get" && completions.length < 2)
      return new Promise<unknown>(resolve => { completions.push(resolve); });
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  const focus = vi.spyOn(controller.render, "focusRecord");
  try {
    controller.dispatch("focus", "saved");
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    const background = controller.sync.refresh();
    completions[0]!({ ok: true, data: DEFAULT_SETTINGS });
    await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(1));
    if (transition === "navigation") window.history.pushState(null, "", "/next-route");
    if (transition === "navigation-return") {
      window.history.pushState(null, "", "/next-route");
      await controller.sync.refresh();
      window.history.pushState(null, "", "/initial-recovery");
      await controller.sync.refresh();
    }
    if (transition === "revocation") {
      onMessage({ type: "permissions.revoked" }, {}, () => {});
      onMessage({ type: "permissions.restored" }, {}, () => {});
    }
    if (transition === "stop") controller.stop();
    completions[1]!({ ok: true, data: DEFAULT_SETTINGS });
    await background;
    await Promise.resolve();
    expect(focus).not.toHaveBeenCalled();
  } finally {
    controller.stop();
    for (const finish of completions) finish({ ok: true, data: DEFAULT_SETTINGS });
    await Promise.resolve();
  }
});

it("waits for a successful background refresh before executing superseded focus", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  failure = undefined;
  const send = chrome.runtime.sendMessage;
  const completions: Array<(value: unknown) => void> = [];
  chrome.runtime.sendMessage = ((message: { type: string }) => message.type === "settings.get"
    ? new Promise<unknown>(resolve => { completions.push(resolve); })
    : send(message)) as typeof chrome.runtime.sendMessage;
  const focus = vi.spyOn(controller.render, "focusRecord");
  try {
    controller.dispatch("focus", "saved");
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    const background = controller.sync.refresh();
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    completions[0]!({ ok: true, data: DEFAULT_SETTINGS });
    await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(1));
    expect(focus).not.toHaveBeenCalled();
    completions[1]!({ ok: true, data: DEFAULT_SETTINGS });
    await background;
    await vi.waitFor(() => expect(focus).toHaveBeenCalledWith("saved"));
  } finally {
    controller.stop();
    for (const finish of completions) finish({ ok: true, data: DEFAULT_SETTINGS });
    await Promise.resolve();
  }
});

it("executes focus after a newer refresh succeeds while the old read is still pending", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  failure = undefined;
  const send = chrome.runtime.sendMessage;
  let finishOld!: (value: unknown) => void;
  let first = true;
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === "settings.get" && first) {
      first = false;
      return new Promise<unknown>(resolve => { finishOld = resolve; });
    }
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  const focus = vi.spyOn(controller.render, "focusRecord");
  try {
    controller.dispatch("focus", "saved");
    await vi.waitFor(() => expect(first).toBe(false));
    await controller.sync.refresh();
    await vi.waitFor(() => expect(focus).toHaveBeenCalledWith("saved"));
    finishOld({ ok: true, data: DEFAULT_SETTINGS });
    await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
    expect(focus).toHaveBeenCalledOnce();
    expect(controller.store.annotations.map(record => record.id)).toEqual(["saved"]);
  } finally {
    controller.stop();
    finishOld({ ok: true, data: DEFAULT_SETTINGS });
    await Promise.resolve();
  }
});

it("does not replay focus when a new route supersedes a still-pending read", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  failure = undefined;
  const send = chrome.runtime.sendMessage;
  let finishOld!: (value: unknown) => void;
  let first = true;
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === "settings.get" && first) {
      first = false;
      return new Promise<unknown>(resolve => { finishOld = resolve; });
    }
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  const focus = vi.spyOn(controller.render, "focusRecord");
  try {
    controller.dispatch("focus", "saved");
    await vi.waitFor(() => expect(first).toBe(false));
    window.history.pushState(null, "", "/next-route");
    await controller.sync.refresh();
    await Promise.resolve();
    expect(focus).not.toHaveBeenCalled();
    finishOld({ ok: true, data: DEFAULT_SETTINGS });
    await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
    expect(focus).not.toHaveBeenCalled();
  } finally {
    controller.stop();
    finishOld({ ok: true, data: DEFAULT_SETTINGS });
    await Promise.resolve();
  }
});

it.each(["revocation", "stop"] as const)("settles an interactive wait on %s while the read is pending", async transition => {
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(controller.modeReady).toBe(true));
  const send = chrome.runtime.sendMessage;
  const completions: Array<(value: unknown) => void> = [];
  chrome.runtime.sendMessage = ((message: { type: string }) => message.type === "settings.get"
    ? new Promise<unknown>(resolve => { completions.push(resolve); })
    : send(message)) as typeof chrome.runtime.sendMessage;
  let settled = false;
  try {
    const wait = controller.sync.refresh(true).then(() => { settled = true; });
    if (transition === "revocation") {
      onMessage({ type: "permissions.revoked" }, {}, () => {});
      onMessage({ type: "permissions.restored" }, {}, () => {});
    }
    else controller.stop();
    await vi.waitFor(() => expect(settled).toBe(true));
    await wait;
  } finally {
    controller.stop();
    for (const finish of completions) finish({ ok: true, data: DEFAULT_SETTINGS });
    await Promise.resolve();
  }
});

it("refreshes the new route before executing a focus requested there", async () => {
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(controller.enabled()).toBe(true));
  const focus = vi.spyOn(controller.render, "focusRecord");
  window.history.pushState(null, "", "/next-route");
  controller.dispatch("focus", "saved");
  await vi.waitFor(() => expect(focus).toHaveBeenCalledWith("saved"));
  expect(controller.currentUrl).toBe(location.href);
});

it("does not carry a pending explicit retry into the next route", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  const send = chrome.runtime.sendMessage;
  let finishRetry!: (value: unknown) => void;
  let pending = true;
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === "settings.get" && pending) {
      pending = false;
      return new Promise<unknown>(resolve => { finishRetry = resolve; });
    }
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  try {
    controller.dispatch("focus", "saved");
    await vi.waitFor(() => expect(pending).toBe(false));
    window.history.pushState(null, "", "/next-route");
    await controller.sync.refresh();
    expect(view.toast.textContent).toContain("暂时无法恢复此页标注");
    view.toast.querySelector<HTMLButtonElement>(".toast-dismiss")!.click();
    await controller.sync.refresh();
    expect(view.toast.textContent).toBe("");
  } finally {
    controller.stop();
    finishRetry({ ok: true, data: DEFAULT_SETTINGS });
    await Promise.resolve();
  }
});

it("does not carry a pending explicit retry through a stopped engine", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  view.toast.querySelector<HTMLButtonElement>(".toast-dismiss")!.click();
  const send = chrome.runtime.sendMessage;
  let finishRetry!: (value: unknown) => void;
  let pending = true;
  chrome.runtime.sendMessage = ((message: { type: string }) => {
    if (message.type === "settings.get" && pending) {
      pending = false;
      return new Promise<unknown>(resolve => { finishRetry = resolve; });
    }
    return send(message);
  }) as typeof chrome.runtime.sendMessage;
  try {
    controller.dispatch("focus", "saved");
    await vi.waitFor(() => expect(pending).toBe(false));
    onMessage({ type: "permissions.revoked" }, {}, () => {});
    await controller.sync.refresh();
    expect(view.toast.textContent).toBe("");
    onMessage({ type: "permissions.restored" }, {}, () => {});
    await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(1));
    expect(view.toast.textContent).toBe("");
  } finally {
    controller.stop();
    finishRetry({ ok: true, data: DEFAULT_SETTINGS });
    await Promise.resolve();
  }
});

it("preserves a sticky save failure across explicit recovery failure and success", async () => {
  failure = "settings.get";
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(view.toast.textContent).toContain("暂时无法恢复此页标注"));
  controller.toast("save failed", true, () => {});
  controller.dispatch("refresh");
  await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
  expect(view.toast.textContent).toContain("save failed");
  failure = undefined;
  await controller.sync.refresh();
  expect(view.toast.textContent).toContain("save failed");
  expect(view.toast.textContent).toContain("重试保存");
});

it("preserves a sticky save failure when refresh confirms the page is disabled", async () => {
  savedEnabled = false;
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(controller.modeReady).toBe(true));
  controller.toast("save failed", true, () => {});
  await controller.sync.refresh();
  expect(view.toast.textContent).toContain("save failed");
  expect(view.toast.textContent).toContain("重试保存");
});

it("ignores a failed read after disposal", async () => {
  let reject!: (error: Error) => void;
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = ((message: { type: string }) => message.type === "settings.get"
    ? new Promise((_resolve, fail) => { reject = fail; })
    : send(message)) as typeof chrome.runtime.sendMessage;
  const view = createView();
  controller = new AnnotationController(view);
  controller.stop();
  reject(Error("late failure"));
  await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
  expect(view.toast.textContent).toBe("");
});

it("does not report a failure for a route that has already changed", async () => {
  let reject!: (error: Error) => void;
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = ((message: { type: string }) => message.type === "settings.get"
    ? new Promise((_resolve, fail) => { reject = fail; })
    : send(message)) as typeof chrome.runtime.sendMessage;
  const view = createView();
  controller = new AnnotationController(view);
  window.history.pushState(null, "", "/next-route");
  reject(Error("stale route"));
  await vi.waitFor(() => expect(controller.sync.refreshDepth).toBe(0));
  expect(view.toast.textContent).toBe("");
});
