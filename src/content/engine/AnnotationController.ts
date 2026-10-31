import { request } from "../../core/client";
import { DEFAULT_SETTINGS, type Annotation, type PageMode, type Settings } from "../../core/model";
import { pageKey } from "../../core/url";
import type { createView } from "../view-lite";
import { createNotifications } from "../notifications";
import { DataEngine } from "./DataEngine";
import { UIController } from "./UIController";

/** Composes one synchronous, instance-owned content engine: a data half and a UI half that share this controller's mutable page/session state. */
export class AnnotationController {
  settings: Settings = structuredClone(DEFAULT_SETTINGS);
  currentUrl: string = pageKey(location.href);
  pageEnabled: boolean = false;
  modeReady: boolean = false;
  toggleBusy: boolean = false;
  stopped: boolean = false;
  disabled: boolean = false;
  disposed: boolean = false;
  private actionGeneration: number = 0;
  readonly notifications: ReturnType<typeof createNotifications>;
  readonly data: DataEngine;
  readonly ui: UIController;

  // Compatibility accessors for the ContentEngine bridge and its tests.
  get store() { return this.data; }
  get render() { return this.data; }
  get save() { return this.data; }
  get sync() { return this.data; }

  constructor(readonly view: ReturnType<typeof createView>) {
    this.notifications = createNotifications(this.view.toast);
    this.data = new DataEngine(this);
    this.ui = new UIController(this);
    this.ui.start();
    try {
      chrome.runtime.onMessage.addListener(this.onMessage);
    } catch (error) {
      this.stop();
      throw error;
    }
    void this.data.refresh();
  }

  private zh = () => this.settings.language === "zh-CN";

  label = (cn: string, en: string) => (this.zh() ? cn : en);

  toast = (message: string, error = false, retry?: () => void) => {
    this.notifications.show(message, {
      kind: error ? "error" : "info",
      sticky: !!retry,
      dismissLabel: this.label("关闭提示", "Dismiss"),
      actions: retry
        ? [
            { label: this.label("重试保存", "Retry save"), run: retry },
            {
              label: this.label("放弃本次修改", "Discard this change"),
              run: () => {
                this.data.discardDraft();
                this.ui.rebinding = undefined;
                this.notifications.hide();
                this.data.schedulePaint();
              },
            },
          ]
        : [],
    });
  };

  fail = (error: unknown) =>
    this.toast(error instanceof Error ? error.message : String(error), true);

  enabled = () => this.pageEnabled && !this.disabled && !this.stopped && !this.disposed;

  private changePageMode = async (next: boolean): Promise<boolean> => {
    if (this.toggleBusy || this.data.pendingSave || this.disabled || this.stopped || this.disposed) return false;
    if (this.data.unsaved) {
      const record = this.data.unsaved;
      this.toast(
        this.label("请先处理尚未保存的修改。", "Resolve the unsaved change before switching modes."),
        true,
        () => {
          void this.data.commit(record);
        },
      );
      return false;
    }
    this.toggleBusy = true;
    const url = pageKey(location.href);
    try {
      const result = await request<PageMode>({
        type: "page.mode.put",
        pageUrl: url,
        enabled: next,
        ...(next ? { selectionTools: false } : {}),
      });
      if (this.disposed) return false;
      if (pageKey(location.href) !== url) {
        this.data.queueRefresh();
        return false;
      }
      this.pageEnabled = result.enabled;
      this.notifications.hide();
      await this.data.refresh();
      return this.enabled();
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      this.toggleBusy = false;
    }
  };

  private withPageEnabled = async (action: () => void) => {
    const url = pageKey(location.href);
    const actionGeneration = this.actionGeneration;
    const pending = !this.modeReady || this.data.restoreFailed || this.currentUrl !== url ? this.data.refresh(true) : undefined;
    const navigationGeneration = this.data.navigationGeneration;
    if (pending) await pending;
    if (
      this.disposed || this.stopped || this.actionGeneration !== actionGeneration ||
      this.data.navigationGeneration !== navigationGeneration || pageKey(location.href) !== url
    ) return;
    if (!this.modeReady || this.data.restoreFailed) return;
    if (!this.enabled() && !(await this.changePageMode(true))) return;
    if (
      this.disposed || this.stopped || this.actionGeneration !== actionGeneration ||
      this.data.navigationGeneration !== navigationGeneration || pageKey(location.href) !== url
    ) return;
    action();
  };

  dispatch = (action: "focus" | "rebind" | "draw" | "refresh", id?: string) => {
    if (this.disposed) return;
    if (action === "refresh") {
      void this.data.refresh(true);
      return;
    }
    if (action === "focus") {
      void this.withPageEnabled(() => this.data.focusRecord(id));
      return;
    }
    if (action === "draw") {
      // Drawing is unavailable; image selection remains available for rebind only.
      return;
    }
    const record = this.data.annotations.find((item) => item.id === id);
    if (!record || (record.kind !== "text" && record.kind !== "image")) return;
    if (this.data.pendingSave) {
      this.toast(this.label("正在保存，请稍后再重新定位。", "Saving. Wait before rebinding."), true);
      return;
    }
    this.ui.rebinding = record;
    if (record.kind === "image") this.ui.startDrawing();
    else {
      this.ui.exitDrawing();
      this.toast(
        this.label("重新选择原文，再点击高亮颜色以绑定。", "Select the intended text and apply a color to rebind."),
      );
    }
  };

  private onMessage = (
    message: {
      type?: string;
      pageUrl?: string;
      annotation?: Annotation;
      deletedId?: string;
    },
    _sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => {
    if (this.disposed) return false;
    if (message.type === "page.snapshot") {
      respond({ pageUrl: this.currentUrl, states: this.data.states, enabled: this.enabled() });
      return false;
    }
    if (message.type === "permissions.revoked") {
      this.stopped = true;
      this.actionGeneration++;
      this.data.cancelPendingRefresh();
      this.data.clearText();
      this.ui.exitDrawing();
      this.view.svg.replaceChildren();
      this.ui.mutationObserver.disconnect();
      this.data.textSession.invalidate();
      this.notifications.hide();
    }
    if (message.type === "permissions.restored") {
      this.stopped = false;
      void this.data.refresh();
    }
    if (message.type === "annotations.changed") {
      if (!this.data.applyAnnotationDelta( message.annotation, message.deletedId, message.pageUrl))
        void this.data.refresh();
    }
    if (message.type === "settings.changed" || message.type === "page.mode.changed")
      void this.data.refresh();
    return false;
  };

  stop = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.actionGeneration++;
    this.ui.stop();
    this.data.disposeSync();
    this.data.disposeRender();
    this.notifications.dispose();
    this.ui.hideSelection();
    this.view.drawing.style.display = "none";
    try {
      chrome.runtime.onMessage.removeListener(this.onMessage);
    } catch {
      // Extension Reload can invalidate Chrome APIs before DOM cleanup finishes.
    }
  };

  canStop = () => {
    if (!this.data.unsaved && !this.data.pendingSave) return true;
    const record = this.data.unsaved;
    this.toast(
      this.label("请先处理尚未保存的修改。", "Resolve the unsaved change before turning annotations off."),
      true,
      record
        ? () => {
            void this.data.commit(record);
          }
        : undefined,
    );
    return false;
  };
}
