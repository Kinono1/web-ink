import { afterEach, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAnnotationQuery } from "../src/ui/management/useAnnotationQuery";
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
});
let root: Root | undefined;
const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  if (previous) Object.defineProperty(globalThis, "chrome", previous);
  else Reflect.deleteProperty(globalThis, "chrome");
});
it("cancels an active search before the next 180ms debounce and discards its late reply", async () => {
  const sent: any[] = [];
  let replyOld: ((value: any) => void) | undefined;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        sendMessage: vi.fn((message: any) => {
          sent.push(message);
          if (message.type === "annotations.query") {
            if (!message.query.text)
              return new Promise((resolve) => {
                replyOld = resolve;
              });
            return Promise.resolve({ ok: true, data: { items: [] } });
          }
          return Promise.resolve({ ok: true, data: true });
        }),
      },
    },
  });
  function Harness() {
    const [query, setQuery] = useState("");
    const state = useAnnotationQuery(
      { mode: "library", kind: "all", color: "", tag: "", query },
      () => undefined,
      () => undefined,
    );
    return createElement(
      "button",
      { onClick: () => setQuery("needle") },
      `${state.loading}:${state.records.length}`,
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const first = sent.find((m) => m.type === "annotations.query").query
    .requestId;
  await act(async () => {
    host.querySelector("button")!.click();
  });
  expect(sent).toContainEqual({
    type: "annotations.query.cancel",
    requestId: first,
  });
  expect(sent.filter((m) => m.type === "annotations.query")).toHaveLength(1);
  await act(async () => {
    replyOld!({ ok: true, data: { items: [{ id: "stale" }] } });
  });
  expect(host.textContent).toBe("true:0");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(sent.filter((m) => m.type === "annotations.query")).toHaveLength(2);
  expect(host.textContent).toBe("false:0");
});

it("preserves visible records and surfaces database errors instead of an empty result", async () => {
  const errors: string[] = [];
  let calls = 0;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        sendMessage: vi.fn((message: any) => {
          if (message.type !== "annotations.query")
            return Promise.resolve({ ok: true, data: true });
          calls++;
          return Promise.resolve(
            calls === 1
              ? { ok: true, data: { items: [{ id: "saved-record" }] } }
              : {
                  ok: false,
                  error: "Database unavailable",
                  code: "STORAGE_ERROR",
                },
          );
        }),
      },
    },
  });
  function Harness() {
    const state = useAnnotationQuery(
      { mode: "library", kind: "all", color: "", tag: "", query: "" },
      (message) => errors.push(message),
      () => undefined,
    );
    return createElement(
      "button",
      { onClick: () => void state.loadRecords() },
      `${state.loading}:${state.records.map((record) => record.id).join(",")}`,
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(host.textContent).toBe("false:saved-record");
  await act(async () => {
    host.querySelector("button")!.click();
  });
  expect(host.textContent).toBe("false:saved-record");
  expect(errors).toEqual(["Database unavailable"]);
});
