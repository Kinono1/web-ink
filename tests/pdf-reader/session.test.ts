import { HASH, publicSource, baseRecord, reader, deferred, settle, mount, chooseLocalPdf, click, selectPage, puts, runtimeListeners, io } from "../helpers/pdf-reader";
import { describe, expect, it } from "vitest";
import { act } from "react";
import { DEFAULT_SETTINGS, type Request } from "../../src/core/model";

describe("PDF reader workspace", () => {
  it("refreshes the early annotation snapshot after subscribing to the parsed document", async () => {
    const listeners = runtimeListeners();
    const parsing = deferred<unknown>();
    io.parseGate = parsing.promise;
    const initial = baseRecord();
    reader.records = [initial];
    const send = chrome.runtime.sendMessage;
    let reads = 0;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && ++reads === 1
      ? Promise.resolve({ ok: true, data: [initial] }) : send(message)) as typeof send;
    await mount();
    const changed = { ...initial, id: "imported-during-parse", color: "#7cc868" };
    reader.records = [changed];
    await act(async () => {
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: initial.pageUrl });
      parsing.resolve(undefined);
    });
    await settle();
    expect(reader.host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    expect(reader.host.querySelector('[data-pdf-annotation="imported-during-parse"]')?.getAttribute("fill")).toBe("#7cc868");
  });

  it("does not replace live notification updates with a late refresh snapshot", async () => {
    const listeners = runtimeListeners();
    const refreshGate = deferred<unknown>();
    const initial = baseRecord();
    reader.records = [initial];
    const send = chrome.runtime.sendMessage;
    let reads = 0;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && ++reads === 2
      ? refreshGate.promise : send(message)) as typeof send;
    await mount();
    expect(reads).toBe(2);
    const changed = { ...initial, id: "live-replacement", revision: 2 };
    reader.records = [changed];
    await act(async () => {
      for (const listener of listeners) {
        listener({ type: "annotations.changed", pageUrl: initial.pageUrl, deletedId: initial.id });
        listener({ type: "annotations.changed", pageUrl: initial.pageUrl, annotation: changed });
      }
      refreshGate.resolve({ ok: true, data: [initial] });
    });
    await settle();
    expect(reader.host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    expect(reader.host.querySelector('[data-pdf-annotation="live-replacement"]')).toBeTruthy();
    expect(reads).toBe(3);
  });

  it("rechecks the latest snapshot when an obsolete refresh fails", async () => {
    const listeners = runtimeListeners();
    const refreshGate = deferred<unknown>();
    const initial = baseRecord();
    reader.records = [initial];
    const send = chrome.runtime.sendMessage;
    let reads = 0;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && ++reads === 2
      ? refreshGate.promise : send(message)) as typeof send;
    await mount();
    const changed = { ...initial, color: "#7cc868", revision: 2 };
    reader.records = [changed];
    await act(async () => {
      for (const listener of listeners) listener({ type: "annotations.changed", pageUrl: initial.pageUrl, annotation: changed });
      refreshGate.reject(new Error("obsolete snapshot failed"));
    });
    await settle();
    expect(reads).toBe(3);
    expect(reader.host.textContent).not.toContain("obsolete snapshot failed");
    expect(reader.host.querySelector('[data-pdf-annotation="saved-highlight"]')?.getAttribute("fill")).toBe("#7cc868");
  });

  it("does not reread a disposed document after a queued notification and late refresh", async () => {
    const listeners = runtimeListeners();
    const refreshGate = deferred<unknown>();
    const initial = baseRecord();
    reader.records = [initial];
    const send = chrome.runtime.sendMessage;
    let reads = 0;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && ++reads === 2
      ? refreshGate.promise : send(message)) as typeof send;
    await mount();
    const queuedListeners = [...listeners];
    await act(async () => reader.root!.unmount());
    reader.root = undefined;
    await act(async () => {
      for (const listener of queuedListeners) listener({ type: "annotations.changed", pageUrl: initial.pageUrl, annotation: initial });
      refreshGate.resolve({ ok: true, data: [initial] });
    });
    await settle();
    expect(reads).toBe(2);
  });

  it("uses a changed default color for the next annotation without recoloring saved marks", async () => {
    const listeners = runtimeListeners();
    reader.records = [baseRecord()];
    await mount();
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "settings.get"
      ? Promise.resolve({ ok: true, data: { ...DEFAULT_SETTINGS, defaultColor: "#7cc868" } }) : send(message)) as typeof send;
    await act(async () => { for (const listener of listeners) listener({ type: "settings.changed" }); });
    await settle();
    await selectPage();
    await click("添加笔记");
    expect(puts()[0]?.annotation.color).toBe("#7cc868");
    expect(reader.records.find(record => record.id === "saved-highlight")?.color).toBe("#facc15");
  });

  it("loads saved annotations while PDF parsing is pending, and publishes both together", async () => {
    const parsing = deferred<unknown>();
    const annotations = deferred<unknown>();
    io.parseGate = parsing.promise;
    reader.records = [baseRecord()];
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list"
      ? (reader.messages.push(message), annotations.promise) : send(message)) as typeof send;
    await mount();
    expect(reader.messages.some(message => message.type === "annotations.list")).toBe(true);
    expect(reader.host.querySelector(".pdf-page")).toBeNull();
    await act(async () => parsing.resolve(undefined));
    await settle();
    // A document must not become editable before its existing records are known.
    expect(reader.host.querySelector(".pdf-page")).toBeNull();
    await act(async () => annotations.resolve({ ok: true, data: reader.records }));
    await settle();
    expect(reader.host.querySelector('.pdf-page[data-ready="true"]')).toBeTruthy();
    expect(reader.host.querySelector(".pdf-marks rect")).toBeTruthy();
  });

  it("ignores a replaced document's late parse and annotation results", async () => {
    const parsing = deferred<unknown>();
    const annotations = deferred<unknown>();
    io.parseGate = parsing.promise;
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list" && message.pageUrl === `urn:web-ink:pdf:${HASH}`
      ? annotations.promise : send(message)) as typeof send;
    await mount();
    await act(async () => reader.root!.unmount());
    reader.root = undefined;
    io.parseGate = undefined;
    io.hash = "b".repeat(64);
    await mount("", false);
    await chooseLocalPdf(new File(["%PDF-"], "replacement.pdf"));
    await act(async () => {
      parsing.resolve(undefined);
      annotations.resolve({ ok: true, data: [baseRecord()] });
    });
    await settle();
    expect(reader.host.querySelector(".pdf-name")?.textContent).toBe("replacement.pdf");
    expect(reader.host.querySelector(".pdf-marks rect")).toBeNull();
    expect(new URL(location.href).searchParams.get("document")).toBe("b".repeat(64));
  });

  it("keeps a document closed when annotation loading fails before parsing completes", async () => {
    const parsing = deferred<unknown>();
    io.parseGate = parsing.promise;
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "annotations.list"
      ? Promise.resolve({ ok: false, error: "Saved records unavailable" }) : send(message)) as typeof send;
    await mount();
    expect(reader.host.textContent).toContain("Saved records unavailable");
    await act(async () => parsing.resolve(undefined));
    await settle();
    expect(reader.host.querySelector(".pdf-page")).toBeNull();
  });

  it("preserves an explicit local file after delayed initial settings", async () => {
    const settingsGate = deferred<unknown>();
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "settings.get"
      ? settingsGate.promise : send(message)) as typeof send;
    await mount(`?source=${encodeURIComponent(publicSource)}`, false);
    io.hash = "b".repeat(64);
    await chooseLocalPdf(new File(["%PDF-"], "local-b.pdf"));
    expect(reader.host.querySelector(".pdf-name")?.textContent).toBe("local-b.pdf");
    await act(async () => settingsGate.resolve({ ok: true, data: DEFAULT_SETTINGS }));
    await settle();
    expect(reader.host.querySelector(".pdf-name")?.textContent).toBe("local-b.pdf");
    expect(io.remoteReads).toHaveLength(0);
    expect(new URL(location.href).searchParams.get("document")).toBe("b".repeat(64));
    expect(new URL(location.href).searchParams.has("source")).toBe(false);
  });

  it("handles tab lookup invalidation during reader startup without an unhandled promise", async () => {
    Object.defineProperty(chrome, "tabs", { configurable: true, value: {
      getCurrent: async () => { throw new Error("Extension context invalidated."); },
    } });
    await mount("", false);
    expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain("Extension context invalidated");
  });

  it("reports a failed initial settings request instead of leaving an unhandled Reload rejection", async () => {
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: Request) => message.type === "settings.get"
      ? Promise.reject(new Error("Extension context invalidated.")) : send(message)) as typeof send;
    await mount("", false);
    expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain("Extension context invalidated");
  });

  it("releases reader listeners and canvas resources when Reload invalidates listener cleanup", async () => {
    await mount();
    const canvas = reader.host.querySelector("canvas")!;
    chrome.runtime.onMessage.removeListener = () => { throw new Error("Extension context invalidated."); };
    const current = reader.root!;
    reader.root = undefined;
    await expect(act(async () => current.unmount())).resolves.toBeUndefined();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(reader.frames.size).toBe(0);
  });
});
