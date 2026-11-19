import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnnotationController } from "../../../src/content/engine/AnnotationController";
import { createView } from "../../../src/content/view-lite";
import { DEFAULT_SETTINGS, type Request, type TextAnnotation } from "../../../src/core/model";
import { createChromeMock } from "../../helpers/chrome-mock";

type Write = Extract<Request, { type: "annotations.put" }>;
const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
let controller: AnnotationController;
let writes: Write[];

beforeEach(() => {
  writes = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(10, 10, 60, 20)],
  });
});

afterEach(() => {
  controller?.stop();
  getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  if (rangeRects) Object.defineProperty(Range.prototype, "getClientRects", rangeRects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
  vi.unstubAllGlobals();
});

async function openPage(exact = "chosen") {
  document.body.innerHTML = '<article id="paper"><p id="first">First chosen passage.</p><p id="second">Second chosen passage.</p></article>';
  const record: TextAnnotation = {
    id: "saved", kind: "text", pageUrl: location.href, pageTitle: "Original title",
    note: "Keep my note", tags: ["evidence"], color: "#facc15", revision: 4,
    createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z",
    target: { exact, prefix: "Old ", suffix: " context", start: 4, end: 4 + exact.length, rootSelector: "article#paper" },
  };
  const chrome = createChromeMock({ sendMessage: input => {
    const message = input as Request;
    switch (message.type) {
      case "settings.get": return { ok: true, data: { ...DEFAULT_SETTINGS, language: "en" } };
      case "page.mode.get": return { ok: true, data: { enabled: true, selectionToolsEnabled: true } };
      case "annotations.list": return { ok: true, data: [record] };
      case "page.states": return { ok: true, data: true };
      case "annotations.put":
        writes.push(message);
        return { ok: true, data: { ...message.annotation, revision: 5 } };
      default: throw Error(`Unexpected test message: ${message.type}`);
    }
  } });
  vi.stubGlobal("chrome", chrome);
  const view = createView();
  controller = new AnnotationController(view);
  await vi.waitFor(() => expect(controller.data.annotations).toEqual([record]));
  controller.dispatch("rebind", record.id);
  const action = (label: string) => {
    const button = Array.from(view.toast.querySelectorAll<HTMLButtonElement>(".toast-action"))
      .find(control => control.textContent === label);
    expect(button, view.toast.textContent ?? "").toBeDefined();
    button!.click();
  };
  return { record, view, action };
}

it("confirms the selected candidate and retains the saved record's metadata", async () => {
  const { record, view, action } = await openPage();
  expect(view.toast.textContent).toContain("Candidate 1/2");
  action("Next candidate");
  expect(view.toast.textContent).toContain("Candidate 2/2");
  action("Confirm here");
  await vi.waitFor(() => expect(controller.data.annotations[0]?.revision).toBe(5));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    expectedRevision: record.revision,
    annotation: {
      id: record.id, pageTitle: record.pageTitle, createdAt: record.createdAt,
      color: record.color, note: record.note, tags: record.tags,
      target: { exact: "chosen", containerId: "second" },
    },
  });
});

it("rejects confirmation if the previewed text changes", async () => {
  const { view, action } = await openPage();
  document.querySelector("#first")!.textContent = "A different passage.";
  action("Confirm here");
  expect(view.toast.textContent).toContain("The page or annotation changed.");
  expect(controller.ui.rebinding).toBeUndefined();
  expect(writes).toEqual([]);
});

it("lets the user cancel a manual rebind when no candidate is present", async () => {
  const { record, view, action } = await openPage("missing text");
  expect(view.toast.textContent).toContain("No candidate can be previewed.");
  expect(controller.ui.rebinding).toEqual(record);
  action("Cancel rebind");
  expect(controller.ui.rebinding).toBeUndefined();
  expect(view.toast.textContent).toBe("");
  expect(writes).toEqual([]);
});
