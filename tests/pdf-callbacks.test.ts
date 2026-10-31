import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAnnotations, useAnnotationsState } from "../src/pdf/hooks/useAnnotations";
import { useReaderUIState } from "../src/pdf/hooks/useReaderUI";
import type { Request } from "../src/core/model";
import type { OpenDocument, PdfAnnotation, SelectionTarget } from "../src/core/pdf-types";

let root: Root | undefined;
const hash = "a".repeat(64);
const target: SelectionTarget = { pageNumber: 1, rects: [], exact: "passage", prefix: "", suffix: "" };
const record = (): PdfAnnotation => ({
  id: "note-1", kind: "pdf-text", pageUrl: `urn:web-ink:pdf:${hash}`, pageTitle: "first.pdf",
  note: "saved", tags: ["old"], color: "#facc15", revision: 3,
  createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
  target: { ...target, documentHash: hash, fileName: "first.pdf" },
});

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function fixture() {
  let stored = [record()];
  const messages: Request[] = [];
  vi.stubGlobal("chrome", { runtime: {
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage: async (message: Request) => {
      messages.push(message);
      if (message.type === "annotations.list") return { ok: true, data: stored };
      if (message.type === "annotations.put") {
        if (message.annotation.kind !== "pdf-text" && message.annotation.kind !== "pdf-area") throw Error("Unexpected non-PDF annotation");
        const current = stored.find(item => item.id === message.annotation.id);
        if (current && current.revision !== message.expectedRevision)
          return { ok: false, error: "Changed elsewhere", code: "CONFLICT" };
        const next = { ...message.annotation, revision: message.expectedRevision + 1 };
        stored = [...stored.filter(item => item.id !== next.id), next];
        return { ok: true, data: next };
      }
      return { ok: true, data: true };
    },
  } });
  const opened = { hash, fileName: "first.pdf", document: { numPages: 3 } } as OpenDocument;
  const fixed = {
    documentSessionRef: { current: 1 }, documentSession: 1, opened,
    key: `urn:web-ink:pdf:${hash}`, locked: false, paperDoi: undefined,
    fallbackNotes: true, supportsSidebar: false, setError: vi.fn(), setSelection: vi.fn(),
  };
  const actions = { current: { tell: vi.fn() } };
  let captured!: ReturnType<typeof useAnnotations>;
  let annotationState!: ReturnType<typeof useAnnotationsState>;
  let ui!: ReturnType<typeof useReaderUIState>;
  function Capture({ document = opened, session = 1 }: { document?: OpenDocument; session?: number }) {
    annotationState = useAnnotationsState();
    ui = useReaderUIState();
    captured = useAnnotations({ ...fixed, ...annotationState, ...ui, opened: document, documentSession: session }, actions);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = async (document = opened, session = 1) => {
    await act(async () => root!.render(createElement(Capture, { document, session })));
    return captured;
  };
  return { render, fixed, messages, actions, opened,
    get commands() { return captured; }, get state() { return annotationState; }, get ui() { return ui; },
    replaceStored(next: PdfAnnotation[]) { stored = next; },
  };
}

it("keeps annotation operations and derived deleted drafts stable across unrelated UI renders", async () => {
  const view = fixture();
  const before = await view.render();
  const deleted = view.state.deletedDrafts;
  const translate = view.ui.t;
  await act(async () => view.ui.setMoreOpen(true));
  for (const name of Object.keys(before) as Array<keyof typeof before>) {
    expect(view.commands[name], name).toBe(before[name]);
  }
  expect(view.ui.t).toBe(translate);
  expect(view.state.deletedDrafts).toBe(deleted);
});

it("uses updated document metadata, color and language while preserving revision checks", async () => {
  const view = fixture();
  await view.render();
  await act(async () => {
    view.ui.setColor("#22c55e");
    view.ui.setSettings(settings => ({ ...settings, language: "en" }));
  });
  await view.render({ ...view.opened, fileName: "renamed.pdf" });
  await act(async () => view.commands.mark(target, "pdf-text"));
  const put = view.messages.find(message => message.type === "annotations.put")!;
  if (put.type !== "annotations.put" || put.annotation.kind !== "pdf-text") throw Error("Missing text annotation write");
  expect(put.annotation.pageTitle).toBe("renamed.pdf");
  expect(put.annotation.target.fileName).toBe("renamed.pdf");
  expect(put.annotation.color).toBe("#22c55e");
  expect(put.expectedRevision).toBe(0);
  expect(view.actions.current.tell).toHaveBeenCalledWith("Saved on this device");
  expect(view.ui.t("中文", "English")).toBe("English");

  const revised = { ...record(), revision: 4, note: "remote revision" };
  view.replaceStored([revised]);
  await act(async () => view.commands.refresh());
  const draft = { note: "my draft", tags: "new", color: "#22c55e", base: record(), editing: true };
  await act(async () => { await expect(view.commands.saveNote("note-1", draft)).rejects.toThrow("Changed elsewhere"); });
  expect(view.state.records.find(item => item.id === "note-1")?.note).toBe("remote revision");
  expect(view.state.noteConflicts["note-1"]).toBe(true);
});

it("rejects superseded same-hash annotation callbacks before sending writes or changing drafts", async () => {
  const view = fixture();
  const stale = await view.render();
  view.fixed.documentSessionRef.current = 2;
  await view.render({ ...view.opened, fileName: "replacement.pdf" }, 2);
  const draft = { note: "old draft", tags: "", color: "#facc15", base: record(), editing: true };
  const messagesBefore = view.messages.length;
  await act(async () => {
    stale.mark(target, "pdf-text");
    stale.updateDraft("note-1", draft);
    await expect(stale.save(record())).rejects.toMatchObject({ name: "AbortError" });
    await expect(stale.saveNote("note-1", draft)).rejects.toMatchObject({ name: "AbortError" });
    await stale.remove(record());
    await stale.refresh();
  });
  expect(view.messages).toHaveLength(messagesBefore);
  expect(view.state.noteDrafts).toEqual({});
});
