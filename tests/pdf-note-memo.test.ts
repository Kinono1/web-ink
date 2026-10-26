import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PdfNote } from "../src/pdf/PdfNote";

let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("updates callback props and uses the latest saved revision when resolving an editor conflict", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const record: ComponentProps<typeof PdfNote>["record"] = {
    id: "note", kind: "pdf-text", pageUrl: "urn:web-ink:pdf:hash", pageTitle: "first.pdf",
    note: "Saved", tags: ["paper"], color: "#facc15", revision: 3,
    createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
    target: { documentHash: "hash", fileName: "first.pdf", pageNumber: 1, rects: [], exact: "Passage", prefix: "", suffix: "" },
  };
  const props: ComponentProps<typeof PdfNote> = {
    record, language: "en", onJump: vi.fn(), onSave: vi.fn(async () => undefined),
    onRemove: vi.fn(), removing: false, onDraft: vi.fn(), onClearDraft: vi.fn(),
    saving: false, conflict: false, locked: false,
  };
  const paint = async (next = props) => act(async () => root!.render(createElement(PdfNote, next)));
  const click = async (label: string) => act(async () => {
    const button = [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === label)!;
    expect(button).toBeTruthy();
    button.click();
  });
  await paint();
  const jump = vi.fn();
  await paint({ ...props, onJump: jump });
  await click("Passage");
  expect(jump).toHaveBeenCalledOnce();
  expect(props.onJump).not.toHaveBeenCalled();

  const latest = { ...record, revision: 4, note: "Changed remotely" };
  const onDraft = vi.fn();
  const draft = { base: record, note: "My draft", tags: "paper", color: "#22c55e", editing: true };
  await paint({ ...props, record: latest, onDraft, draft, conflict: true });
  expect(host.querySelector("textarea")?.value).toBe("My draft");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Changed elsewhere");
  expect([...host.querySelectorAll("button")].find(node => node.textContent === "Save")?.disabled).toBe(true);
  await click("Load latest");
  expect(onDraft).toHaveBeenCalledWith({ ...draft, base: latest }, true);
  expect(props.onDraft).not.toHaveBeenCalled();

  const save = vi.fn(async () => { throw Error("Write refused"); });
  const clear = vi.fn();
  await paint({ ...props, record: latest, draft: { ...draft, base: latest }, onSave: save, onClearDraft: clear });
  await click("Save");
  expect(save).toHaveBeenCalledWith({ ...draft, base: latest });
  expect(host.querySelector("textarea")?.value).toBe("My draft");
  await click("Cancel");
  expect(clear).toHaveBeenCalledOnce();
  expect(props.onClearDraft).not.toHaveBeenCalled();
});
